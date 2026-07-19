"""OTLP receiver — the canonical trace write path (SPEC-129 Track 1).

Decodes standard OTLP/JSON and OTLP/protobuf payloads, binds the project from
authenticated credentials (never from payload attributes), persists canonical
spans losslessly into ``OtlpSpanDB``, and records a durable inbox batch in
``OtlpIngestBatchDB``.

This replaces the prototype mapper in ``otel_ingestion.py`` with a proper
receiver that follows the OTLP/HTTP spec: accepts JSON and protobuf, handles
gzip, returns standard OTLP responses, and is idempotent by
``(project_id, trace_id, span_id)``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from google.protobuf.json_format import MessageToDict
from sqlmodel import Session

from ..models.db import OtlpIngestBatchDB, OtlpSpanDB
from ..models.trace_ingestion import TraceIngestionContext
from .content_policy import (
    DEFAULT_TRACE_CONTENT_POLICY,
    normalize_trace_content_policy,
    sanitize_otlp_payload,
)

if TYPE_CHECKING:
    from .trace_projector import TraceProjector

logger = logging.getLogger(__name__)

# Maximum accepted payload size (10 MB — OTLP spec recommends 10MB+)
MAX_PAYLOAD_BYTES = 10 * 1024 * 1024


class OtlpReceiverResult:
    """Result of ingesting an OTLP batch."""

    def __init__(
        self,
        accepted: int = 0,
        rejected: int = 0,
        errors: list[dict[str, str]] | None = None,
        batch_id: str = "",
    ) -> None:
        self.accepted = accepted
        self.rejected = rejected
        self.errors = errors or []
        self.batch_id = batch_id


def decode_otlp_payload(
    payload: bytes,
    content_type: str,
    encoding: str | None = None,
) -> dict[str, Any]:
    """Decode an OTLP payload into the canonical JSON dict shape.

    Handles:
      - ``application/json``: parse as OTLP/JSON
      - ``application/x-protobuf``: parse as protobuf ``ExportTraceServiceRequest``
      - ``Content-Encoding: gzip``: decompress before decoding

    Returns the OTLP/JSON dict (``resourceSpans`` key). Raises ``ValueError``
    on unsupported content types or malformed payloads.
    """
    # Check compressed size BEFORE decompression (gzip bomb protection)
    if len(payload) > MAX_PAYLOAD_BYTES:
        raise ValueError(f"Payload exceeds maximum size of {MAX_PAYLOAD_BYTES} bytes")

    # Decompress if gzip-encoded, with output size limit
    if encoding == "gzip":
        import gzip
        import io

        decompressed = gzip.GzipFile(fileobj=io.BytesIO(payload))
        output = b""
        chunk_size = 1024 * 1024
        while True:
            chunk = decompressed.read(chunk_size)
            if not chunk:
                break
            output += chunk
            if len(output) > MAX_PAYLOAD_BYTES:
                raise ValueError("Decompressed payload exceeds maximum size")
        payload = output

    if content_type in ("application/json", "application/json; charset=utf-8"):
        return json.loads(payload)

    if content_type == "application/x-protobuf":
        from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
            ExportTraceServiceRequest,
        )

        request = ExportTraceServiceRequest()
        request.ParseFromString(payload)
        decoded = MessageToDict(request, preserving_proto_field_name=False)
        # Normalize protobuf artifacts: base64 IDs → hex, nanosecond timestamps → ISO
        _normalize_protobuf_decoded(decoded)
        return decoded

    raise ValueError(f"Unsupported content type: {content_type}")


def _validate_otel_ids(trace_id: Any, span_id: Any) -> None:
    """Validate trace/span IDs against the OTel W3C rules.

    - ``trace_id``: 16 or 32 lowercase hex characters, not all zeros.
    - ``span_id``: 16 lowercase hex characters, not all zeros.

    Raises ``ValueError`` on any violation so the span is reported as a
    partial-batch rejection rather than persisted.
    """
    if not isinstance(trace_id, str) or not isinstance(span_id, str):
        raise ValueError("traceId/spanId must be hex strings")
    if len(trace_id) not in (16, 32):
        raise ValueError(
            f"traceId must be 16 or 32 hex chars, got {len(trace_id)}"
        )
    if len(span_id) != 16:
        raise ValueError(f"spanId must be 16 hex chars, got {len(span_id)}")
    try:
        int(trace_id, 16)
        int(span_id, 16)
    except ValueError as exc:
        raise ValueError("traceId/spanId must be hexadecimal") from exc
    if trace_id == "0" * len(trace_id):
        raise ValueError("traceId must not be all zeros")
    if span_id == "0" * 16:
        raise ValueError("spanId must not be all zeros")


def _datetime_from_nanos(nanos: int) -> datetime | None:
    """Convert an OTLP nanosecond timestamp to UTC via integer arithmetic.

    Never routes through floating-point seconds, which would lose the
    sub-microsecond precision OTLP carries (SPEC-131 Milestone 2.1).
    """
    if nanos < 0:
        return None
    try:
        seconds, remainder = divmod(int(nanos), 1_000_000_000)
        return datetime.fromtimestamp(
            seconds, tz=timezone.utc
        ).replace(microsecond=remainder // 1_000)
    except (ValueError, OSError, OverflowError):
        return None


def _normalize_protobuf_decoded(decoded: dict[str, Any]) -> None:
    """Fix protobuf MessageToDict artifacts so JSON and protobuf paths converge.

    MessageToDict serializes:
      - ``bytes`` fields (traceId, spanId) as base64 → convert to hex
      - nanosecond timestamps stay as ``startTimeUnixNano``/``endTimeUnixNano``
        decimal strings (the OTLP-standard field names). They are NOT converted
        here — :meth:`_parse_timestamp` reads them directly. Converting through
        floating-point seconds loses precision and diverges from the JSON path.
      - enum values as their name string (SPAN_KIND_INTERNAL) → leave as-is,
        :meth:`_parse_enum_int` handles
    """
    for rs in decoded.get("resourceSpans", []):
        for ss in rs.get("scopeSpans", []):
            for span in ss.get("spans", []):
                # Convert base64 traceId/spanId/parentSpanId → hex
                for field in ("traceId", "spanId", "parentSpanId"):
                    value = span.get(field)
                    if isinstance(value, str) and value:
                        try:
                            raw = base64.b64decode(value)
                            span[field] = raw.hex()
                        except Exception:
                            pass  # Already hex or unparseable — leave as-is


class OtlpReceiver:
    """Ingests OTLP traces into the canonical span store.

    The receiver is stateless — each ``ingest`` call is independent. Project
    identity comes exclusively from the ``project_id`` parameter (which the
    route derives from authenticated credentials). Payload attributes like
    ``service.namespace`` are preserved as telemetry data but never used for
    authorization.
    """

    _projector: "TraceProjector | None" = None

    def ingest(
        self,
        payload: bytes,
        content_type: str,
        project_id: str,
        session: Session,
        encoding: str | None = None,
        content_policy: str = DEFAULT_TRACE_CONTENT_POLICY,
        context: "TraceIngestionContext | None" = None,
        project_immediately: bool = True,
    ) -> OtlpReceiverResult:
        """Decode, validate, and persist an OTLP batch.

        Returns an :class:`OtlpReceiverResult` with accepted/rejected counts
        and per-span errors. Never raises on bad spans — they're reported as
        partial failures (OTLP partial-success semantics).

        When ``project_immediately`` is True (default), canonical spans are
        projected into RunDB/LoggedCallDB in the same request. When False,
        spans are persisted to ``OtlpSpanDB`` only and the batch is marked
        for async projection by the ``QueueWorker`` (SPEC-129 §2).

        The ``content_policy`` (``full``, ``redacted``, ``off``) is applied
        to span attributes BEFORE any durable write.

        ``context`` carries the authenticated ingestion identity so Task Run
        claims are subject- and project-bound (SPEC-131 Milestone 3). When
        omitted, the ingest is treated as unauthenticated and may not claim.
        """
        applied_policy = normalize_trace_content_policy(content_policy)

        # 1. Decode the payload
        try:
            decoded = decode_otlp_payload(payload, content_type, encoding)
        except ValueError as exc:
            # Total failure — can't even decode
            batch_id = self._create_failed_batch(
                session,
                project_id,
                content_type,
                payload,
                str(exc),
                applied_policy,
            )
            return OtlpReceiverResult(
                accepted=0, rejected=1, errors=[{"error": str(exc)}], batch_id=batch_id
            )

        # 2. Apply content policy to the decoded payload BEFORE serializing
        # the inbox record (SPEC-129 §1: "apply the Project content-capture
        # and redaction policy before any durable payload write"). This
        # ensures sensitive content never reaches the inbox even in
        # redacted/off mode.
        decoded = sanitize_otlp_payload(decoded, applied_policy)

        # 3. Persist the durable inbox record (before any processing)
        batch_id = str(uuid.uuid4())
        payload_str = json.dumps(decoded)
        payload_hash = hashlib.sha256(payload).hexdigest()

        batch = OtlpIngestBatchDB(
            id=batch_id,
            project_id=project_id,
            content_type=content_type,
            payload_sha256=payload_hash,
            content_policy=applied_policy,
            # Store the complete policy-sanitized payload. The decode step
            # already enforced MAX_PAYLOAD_BYTES, and the column is TEXT
            # (unbounded). Never slice the string — that would produce invalid
            # JSON for replay (SPEC-131 M4.6).
            payload=payload_str,
            status="processing",
        )
        session.add(batch)
        session.flush()

        # 3. Extract and persist canonical spans
        accepted = 0
        rejected = 0
        errors: list[dict[str, str]] = []
        verified_task_run_id: str | None = None

        for rs in decoded.get("resourceSpans", []):
            resource = rs.get("resource", {})
            resource_attrs = self._extract_attrs(resource.get("attributes", []))

            for ss in rs.get("scopeSpans", []):
                scope = ss.get("scope", {})
                for span in ss.get("spans", []):
                    span_id = span.get("spanId", "unknown")
                    # The canonical span and its derived projection are in
                    # SEPARATE savepoints so a projection conflict (which the
                    # legacy schema cannot represent) never loses the canonical
                    # span (SPEC-131 M4.3: keep both canonical spans, fail the
                    # conflicting derived projection explicitly). The receiver
                    # owns the final commit (M4.4).
                    canonical: OtlpSpanDB | None = None
                    persist_error: str | None = None
                    persist_savepoint = session.begin_nested()
                    try:
                        canonical = self._persist_span(
                            session=session,
                            span=span,
                            project_id=project_id,
                            resource=resource,
                            resource_attrs=resource_attrs,
                            scope=scope,
                            content_policy=applied_policy,
                        )
                        claim_id = self._claim_task_run_before_enqueue(
                            canonical, session, context
                        )
                        if claim_id is not None:
                            if (
                                verified_task_run_id is not None
                                and verified_task_run_id != claim_id
                            ):
                                raise ValueError(
                                    "One OTLP batch cannot claim multiple Task Runs"
                                )
                            verified_task_run_id = claim_id
                        persist_savepoint.commit()
                    except Exception as exc:
                        persist_savepoint.rollback()
                        persist_error = str(exc)
                        logger.warning(
                            "Rejected OTLP span %s: %s", span_id, exc, exc_info=True
                        )

                    # Project the canonical span into RunDB/LoggedCallDB. A
                    # projection failure is reported but does not discard the
                    # canonical span — the source of truth survives.
                    projection_error: str | None = None
                    if canonical is not None and project_immediately:
                        proj_savepoint = session.begin_nested()
                        try:
                            self._project(canonical, session, context)
                            proj_savepoint.commit()
                        except Exception as exc:
                            proj_savepoint.rollback()
                            projection_error = str(exc)
                            logger.warning(
                                "Projection failed for span %s (canonical kept): %s",
                                span_id,
                                exc,
                                exc_info=True,
                            )

                    if persist_error or projection_error:
                        rejected += 1
                        errors.append(
                            {
                                "span_id": span_id,
                                "error": projection_error or persist_error or "",
                            }
                        )
                    else:
                        accepted += 1

        # 4. Update the batch record
        batch.accepted_span_count = accepted
        batch.rejected_span_count = rejected
        batch.verified_task_run_id = verified_task_run_id
        if not project_immediately:
            batch.status = "queued"
        else:
            batch.status = "accepted" if rejected == 0 else "partial"
        session.add(batch)
        session.commit()

        return OtlpReceiverResult(
            accepted=accepted, rejected=rejected, errors=errors, batch_id=batch_id
        )

    def _claim_task_run_before_enqueue(
        self,
        canonical: OtlpSpanDB,
        session: Session,
        context: TraceIngestionContext | None,
    ) -> str | None:
        """Authorize and reserve a root Task Run while request auth is present."""
        if canonical.parent_span_id is not None:
            return None
        task_run_id = (canonical.attributes or {}).get("apo.task.run.id")
        if not isinstance(task_run_id, str) or not task_run_id:
            return None

        from .trace_ownership import authorize_and_claim_trace

        claimed = authorize_and_claim_trace(
            session,
            context=context,
            task_run_id=task_run_id,
            trace_id=canonical.trace_id,
        )
        return task_run_id if claimed else None

    def _persist_span(
        self,
        session: Session,
        span: dict[str, Any],
        project_id: str,
        resource: dict[str, Any],
        resource_attrs: dict[str, Any],
        scope: dict[str, Any],
        content_policy: str = DEFAULT_TRACE_CONTENT_POLICY,
    ) -> OtlpSpanDB:
        """Persist one span into ``OtlpSpanDB``, idempotently.

        The caller must pass a span from the policy-sanitized OTLP graph so the
        inbox and canonical store derive from exactly the same content.
        Returns the persisted ``OtlpSpanDB`` object. Validation and database
        failures raise so the caller can roll back the span savepoint.
        """
        trace_id = span.get("traceId", "")
        span_id = span.get("spanId", "")

        _validate_otel_ids(trace_id, span_id)

        # Check for existing (idempotency)
        existing = session.exec(
            self._select_span(session, project_id, trace_id, span_id)
        ).first()

        # Extract typed attributes losslessly
        attributes = self._extract_attrs(span.get("attributes", []))
        events = self._extract_events(span.get("events", []))
        links = self._extract_links(span.get("links", []))
        status = span.get("status", {})

        # Standard OTLP timestamps: startTimeUnixNano/endTimeUnixNano (decimal
        # strings). Fall back to legacy ISO startTime/endTime only for existing
        # fixtures so the migration is gradual, never a silent now() fallback.
        start_time = self._parse_timestamp(
            span.get("startTimeUnixNano") or span.get("startTime")
        )
        end_time = self._parse_timestamp(
            span.get("endTimeUnixNano") or span.get("endTime")
        )

        if existing:
            # Upsert: update the existing row
            existing.parent_span_id = span.get("parentSpanId")
            # Preserve a parsed timestamp; keep the prior value if the payload
            # omits one. Never substitute ingestion time (SPEC-131 M2).
            existing.start_time = start_time or existing.start_time
            existing.end_time = end_time or existing.end_time
            existing.span_name = str(span.get("name", ""))
            existing.span_kind = self._parse_enum_int(span.get("kind", 0))
            existing.status_code = self._parse_enum_int(status.get("code", 0)) if isinstance(status, dict) else 0
            existing.status_message = status.get("message") if isinstance(status, dict) else None
            existing.trace_flags = self._parse_enum_int(span.get("flags", 0))
            existing.trace_state = span.get("traceState")
            existing.resource = {"attributes": resource_attrs, **{k: v for k, v in resource.items() if k != "attributes"}}
            existing.instrumentation_scope = scope if scope else None
            existing.attributes = attributes
            existing.events = events if events else None
            existing.links = links if links else None
            existing.raw_span = span
            existing.content_policy = content_policy
            session.add(existing)
            session.flush()
            canonical = existing
        else:
            canonical = OtlpSpanDB(
                project_id=project_id,
                trace_id=trace_id,
                span_id=span_id,
                parent_span_id=span.get("parentSpanId"),
                start_time=start_time,
                end_time=end_time,
                span_name=str(span.get("name", "")),
                span_kind=self._parse_enum_int(span.get("kind", 0)),
                status_code=self._parse_enum_int(status.get("code", 0)) if isinstance(status, dict) else 0,
                status_message=status.get("message") if isinstance(status, dict) else None,
                trace_flags=self._parse_enum_int(span.get("flags", 0)),
                trace_state=span.get("traceState"),
                resource={"attributes": resource_attrs, **{k: v for k, v in resource.items() if k != "attributes"}},
                instrumentation_scope=scope if scope else None,
                attributes=attributes,
                events=events if events else None,
                links=links if links else None,
                raw_span=span,
                content_policy=content_policy,
            )
            session.add(canonical)
            session.flush()

        return canonical

    def _project(
        self,
        canonical: OtlpSpanDB,
        session: Session,
        context: TraceIngestionContext | None = None,
    ) -> None:
        """Project a canonical span into RunDB/LoggedCallDB for the dashboard."""
        if self._projector is None:
            from .trace_projector import get_trace_projector

            self._projector = get_trace_projector()
        assert self._projector is not None
        self._projector.project(canonical, session, context)

    def _select_span(self, session: Session, project_id: str, trace_id: str, span_id: str):
        """Build a select for an existing canonical span (idempotency check)."""
        from sqlmodel import select as _select

        return _select(OtlpSpanDB).where(
            OtlpSpanDB.project_id == project_id,
            OtlpSpanDB.trace_id == trace_id,
            OtlpSpanDB.span_id == span_id,
        )

    def _extract_attrs(self, raw_attrs: list[Any]) -> dict[str, Any]:
        """Extract OTLP attributes into a lossless dict.

        Each attribute value is one of: stringValue, intValue, doubleValue,
        boolValue, arrayValue. We preserve the typed value, not the container.
        """
        result: dict[str, Any] = {}
        for attr in raw_attrs:
            if not isinstance(attr, dict):
                continue
            key = attr.get("key")
            if not isinstance(key, str):
                continue
            value = self._extract_value(attr.get("value", {}))
            if value is not None:
                result[key] = value
        return result

    def _parse_enum_int(self, value: Any, default: int = 0) -> int:
        """Safely convert a protobuf enum value to int.

        ``MessageToDict`` can render enums as their string name
        (e.g. ``"SPAN_KIND_INTERNAL"``) instead of their numeric value.
        This handles both forms.
        """
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            try:
                return int(value)
            except ValueError:
                # It's an enum name string — we can't reliably map names to
                # numbers without the proto descriptor. Use the default.
                return default
        return default

    def _extract_value(self, container: dict[str, Any]) -> Any:
        """Extract a typed value from an OTLP AnyValue container."""
        if "stringValue" in container:
            return container["stringValue"]
        if "intValue" in container:
            try:
                return int(container["intValue"])
            except (ValueError, TypeError):
                return container["intValue"]
        if "doubleValue" in container:
            try:
                return float(container["doubleValue"])
            except (ValueError, TypeError):
                return container["doubleValue"]
        if "boolValue" in container:
            return bool(container["boolValue"])
        if "arrayValue" in container:
            values = container["arrayValue"].get("values", [])
            return [self._extract_value(v) for v in values if isinstance(v, dict)]
        if "kvlistValue" in container:
            # OTLP KeyValueList — map each {key, value} pair into a dict
            kvs = container["kvlistValue"].get("values", [])
            result: dict[str, Any] = {}
            for kv in kvs:
                if isinstance(kv, dict):
                    k = kv.get("key", "")
                    v = self._extract_value(kv.get("value", {}))
                    if v is not None:
                        result[k] = v
            return result
        return None

    def _extract_events(self, raw_events: list[Any]) -> list[dict[str, Any]]:
        """Extract span events losslessly."""
        result = []
        for event in raw_events:
            if not isinstance(event, dict):
                continue
            result.append(
                {
                    "name": event.get("name", ""),
                    "time": event.get("time") or event.get("timeUnixNano"),
                    "attributes": self._extract_attrs(event.get("attributes", [])),
                }
            )
        return result

    def _extract_links(self, raw_links: list[Any]) -> list[dict[str, Any]]:
        """Extract span links losslessly."""
        result = []
        for link in raw_links:
            if not isinstance(link, dict):
                continue
            result.append(
                {
                    "traceId": link.get("traceId", ""),
                    "spanId": link.get("spanId", ""),
                    "attributes": self._extract_attrs(link.get("attributes", [])),
                }
            )
        return result

    def _parse_timestamp(self, value: Any) -> datetime | None:
        """Parse an OTLP timestamp.

        Accepts the OTLP-standard forms losslessly:
          - ``startTimeUnixNano``/``endTimeUnixNano`` as a decimal **string**
            (the canonical OTLP/JSON and protobuf shape) — parsed with integer
            arithmetic, never floating-point seconds, so microsecond precision
            is preserved.
          - A legacy ISO 8601 string (``startTime``/``endTime``) for existing
            fixtures.
          - A raw nanosecond ``int``.
        """
        if value is None:
            return None
        if isinstance(value, datetime):
            if value.tzinfo is None:
                return value.replace(tzinfo=timezone.utc)
            return value
        if isinstance(value, int):
            return _datetime_from_nanos(value)
        if isinstance(value, str):
            # Standard OTLP nanosecond decimal string (no ':' or '-' separators).
            if value.isdigit():
                return _datetime_from_nanos(int(value))
            # Legacy ISO timestamp.
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                return None
        return None

    def _create_failed_batch(
        self,
        session: Session,
        project_id: str,
        content_type: str,
        payload: bytes,
        error: str,
        content_policy: str,
    ) -> str:
        """Create a failed batch record for an undecodable payload."""
        batch_id = str(uuid.uuid4())
        batch = OtlpIngestBatchDB(
            id=batch_id,
            project_id=project_id,
            content_type=content_type,
            payload_sha256=hashlib.sha256(payload).hexdigest(),
            payload="",
            content_policy=content_policy,
            status="failed",
            error_message=error[:500],
        )
        session.add(batch)
        session.commit()
        return batch_id
