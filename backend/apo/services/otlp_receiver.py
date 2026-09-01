"""OTLP receiver — the canonical trace write path.

Decodes standard OTLP/JSON and OTLP/protobuf payloads, binds the project from
authenticated credentials (never from payload attributes), persists canonical
spans losslessly into ``OtlpSpanDB``, and records a durable inbox batch in
``OtlpIngestBatchDB``.

This replaces the prototype mapper in ``otel_ingestion.py`` with a proper
receiver that follows the OTLP/HTTP spec: accepts JSON and protobuf, handles
gzip, returns standard OTLP responses, and is idempotent by
``(project_id, trace_id, span_id)``.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportUnannotatedClassAttribute=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedParameter=false

from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable, cast

from google.protobuf.json_format import MessageToDict
from sqlmodel import Session

from ..models.db import OtlpIngestBatchDB, OtlpSpanDB
from ..models.trace_ingestion import TraceIngestionContext

if TYPE_CHECKING:
    from .telemetry_limits import TelemetryTransportLimits
    from .trace_projector import TraceProjector

logger = logging.getLogger(__name__)

# Maximum accepted payload size (10 MB — OTLP spec recommends 10MB+)
MAX_PAYLOAD_BYTES = 10 * 1024 * 1024


class OtlpPayloadError(ValueError):
    """Base for request-level OTLP decode/size failures."""


class OtlpDecodeError(OtlpPayloadError):
    """Malformed or unsupported payload — maps to HTTP 400."""


class OtlpSizeLimitError(OtlpPayloadError):
    """Payload exceeds on-wire, decompressed, or span-count cap — maps to 413."""


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
    *,
    limits: TelemetryTransportLimits | None = None,
) -> dict[str, Any]:
    """Decode an OTLP payload into the canonical JSON dict shape.

    Handles:
      - ``application/json``: parse as OTLP/JSON
      - ``application/x-protobuf``: parse as protobuf ``ExportTraceServiceRequest``
      - ``Content-Encoding: gzip``: decompress before decoding

    Returns the OTLP/JSON dict (``resourceSpans`` key). Raises
    :class:`OtlpDecodeError` on unsupported content types or malformed
    payloads, :class:`OtlpSizeLimitError` when the on-wire or decompressed
    size exceeds the configured cap.
    """
    max_raw = limits.max_request_bytes if limits is not None else MAX_PAYLOAD_BYTES
    max_decomp = (
        limits.max_otlp_decompressed_bytes if limits is not None else MAX_PAYLOAD_BYTES
    )

    # On-wire size check (before decompression).
    if len(payload) > max_raw:
        raise OtlpSizeLimitError(f"Payload exceeds maximum size of {max_raw} bytes")

    # Bounded gzip decompression — incremental reads into a bytearray, never
    # repeated immutable-byte concatenation.
    if encoding == "gzip":
        import gzip

        decompressor = gzip.GzipFile(fileobj=io.BytesIO(payload))
        output = bytearray()
        chunk_size = 1024 * 1024
        while True:
            chunk = decompressor.read(chunk_size)
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > max_decomp:
                raise OtlpSizeLimitError(
                    "Decompressed payload exceeds maximum size"
                )
        payload = bytes(output)

    if content_type in ("application/json", "application/json; charset=utf-8"):
        try:
            return json.loads(payload)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise OtlpDecodeError(f"Malformed JSON payload: {exc}") from exc

    if content_type == "application/x-protobuf":
        from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
            ExportTraceServiceRequest,
        )

        request = ExportTraceServiceRequest()
        try:
            request.ParseFromString(payload)
        except Exception as exc:
            raise OtlpDecodeError(f"Malformed protobuf payload: {exc}") from exc
        decoded = MessageToDict(request, preserving_proto_field_name=False)
        _normalize_protobuf_decoded(decoded)
        return decoded

    raise OtlpDecodeError(f"Unsupported content type: {content_type}")


def count_otlp_spans(decoded: dict[str, Any]) -> int:
    """Count decoded Spans across the entire resourceSpans/scopeSpans graph."""
    total = 0
    for rs in decoded.get("resourceSpans", []):
        for ss in rs.get("scopeSpans", []):
            total += len(ss.get("spans", []))
    return total


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
    sub-microsecond precision OTLP carries.
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


# OTLP enum names as rendered by protobuf MessageToDict. The names are
# unique across SpanKind and StatusCode, so one shared map serves both.
_ENUM_NAME_TO_INT: dict[str, int] = {
    "SPAN_KIND_UNSPECIFIED": 0,
    "SPAN_KIND_INTERNAL": 1,
    "SPAN_KIND_SERVER": 2,
    "SPAN_KIND_CLIENT": 3,
    "SPAN_KIND_PRODUCER": 4,
    "SPAN_KIND_CONSUMER": 5,
    "STATUS_CODE_UNSET": 0,
    "STATUS_CODE_OK": 1,
    "STATUS_CODE_ERROR": 2,
}

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _datetime_to_nanos_str(value: datetime) -> str:
    """Inverse of ``_datetime_from_nanos`` — exact integer arithmetic.

    timedelta keeps microsecond precision as integers, so the round trip
    through the typed columns loses nothing above microseconds.
    """
    delta = value.astimezone(timezone.utc) - _EPOCH
    total = (delta.days * 86_400 + delta.seconds) * 1_000_000_000
    total += delta.microseconds * 1000
    return str(total)


def _is_informationless(value: Any) -> bool:
    """True when a value carries no span information.

    Absent (``None``), empty containers, empty strings, false booleans, and
    the enum / bitfield default 0 — a late duplicate export carrying only
    these must never overwrite richer stored data.
    """
    if value is None:
        return True
    if isinstance(value, bool):
        return value is False
    if isinstance(value, (dict, list)):
        return len(value) == 0
    return value == "" or value == 0


def _information_adding_updates(
    existing: OtlpSpanDB, new_values: dict[str, Any]
) -> dict[str, Any] | None:
    """Diff proposed span values against a stored row, information-safe.

    Returns the fields to write, or ``None`` when the export is a no-op.
    A field only updates when it differs AND the incoming value is not
    emptier than the stored one — a stale retry that dropped its end time
    or attributes is skipped instead of destroying them.
    """
    updates: dict[str, Any] = {}
    for key, new in new_values.items():
        old = getattr(existing, key, None)
        if old == new:
            continue
        if _is_informationless(new) and not _is_informationless(old):
            continue
        updates[key] = new
    return updates or None


def dict_to_anyvalue(value: Any) -> dict[str, Any] | None:
    """Inverse of ``OtlpReceiver._extract_value`` — typed dict → AnyValue."""
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int):
        return {"intValue": value}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, list):
        return {
            "arrayValue": {
                "values": [
                    dict_to_anyvalue(item) for item in value if item is not None
                ]
            }
        }
    if isinstance(value, dict):
        return {
            "kvlistValue": {
                "values": [
                    {"key": key, "value": dict_to_anyvalue(item)}
                    for key, item in value.items()
                    if item is not None
                ]
            }
        }
    return None


def attrs_dict_to_otlp(
    attributes: dict[str, object] | None,
) -> list[dict[str, Any]]:
    """Rebuild the OTLP attribute array from the stored dict form."""
    out: list[dict[str, Any]] = []
    for key, value in (attributes or {}).items():
        container = dict_to_anyvalue(value)
        if container is not None:
            out.append({"key": key, "value": container})
    return out


def span_row_to_otlp_json(span: OtlpSpanDB) -> dict[str, Any]:
    """Rebuild an OTLP/JSON span dict from the typed canonical columns.

    The inverse of the receive path, kept next to it so the two cannot
    drift. Used by demo capture (which needs the wire form) and by the
    round-trip losslessness test. Deliberately unpreserved fields are
    absent: dropped counters, ``schemaUrl``, sub-microsecond timestamps.
    """
    out: dict[str, Any] = {
        "traceId": span.trace_id,
        "spanId": span.span_id,
        "name": span.span_name,
        "kind": span.span_kind,
        "flags": span.trace_flags,
        "attributes": attrs_dict_to_otlp(span.attributes),
        "status": {"code": span.status_code},
    }
    if span.parent_span_id:
        out["parentSpanId"] = span.parent_span_id
    if span.trace_state:
        out["traceState"] = span.trace_state
    if span.start_time is not None:
        out["startTimeUnixNano"] = _datetime_to_nanos_str(span.start_time)
    if span.end_time is not None:
        out["endTimeUnixNano"] = _datetime_to_nanos_str(span.end_time)
    if span.status_message:
        out["status"]["message"] = span.status_message
    if span.events:
        out["events"] = [
            {
                "name": event.get("name", ""),
                "time": event.get("time"),
                "attributes": attrs_dict_to_otlp(
                    cast("dict[str, object] | None", event.get("attributes"))
                ),
            }
            for event in span.events
        ]
    if span.links:
        out["links"] = [
            {
                "traceId": link.get("traceId", ""),
                "spanId": link.get("spanId", ""),
                "attributes": attrs_dict_to_otlp(
                    cast("dict[str, object] | None", link.get("attributes"))
                ),
                **({"flags": link["flags"]} if "flags" in link else {}),
                **(
                    {"traceState": link["traceState"]}
                    if link.get("traceState")
                    else {}
                ),
            }
            for link in span.links
        ]
    return out


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
        context: "TraceIngestionContext | None" = None,
        project_immediately: bool = True,
        limits: TelemetryTransportLimits | None = None,
        admission_consume_units: "Callable[[int], object] | None" = None,
        api_key_id: str | None = None,
    ) -> OtlpReceiverResult:
        """Decode, validate, and persist an OTLP batch.

        Returns an :class:`OtlpReceiverResult` with accepted/rejected counts
        and per-span errors. Never raises on bad spans — they're reported as
        partial failures (OTLP partial-success semantics).

        Request-level failures (malformed payload, size/span cap) raise
        :class:`OtlpDecodeError` (400) or :class:`OtlpSizeLimitError` (413)
        and write nothing — no inbox row, no canonical span.

        all received Trace Content is stored in full. There is no
        content-policy redaction or filtering step.

        ``context`` carries the authenticated ingestion identity so Task Run
        claims are subject- and project-bound. When
        omitted, the ingest is treated as unauthenticated and may not claim.
        """
        # 1. Decode the payload (typed errors, no durable write on failure).
        decoded = decode_otlp_payload(payload, content_type, encoding, limits=limits)

        # 2. Count decoded Spans across the whole graph before any persistence.
        max_spans = (
            limits.max_otlp_spans_per_request if limits is not None else 2048
        )
        span_count = count_otlp_spans(decoded)
        if span_count > max_spans:
            raise OtlpSizeLimitError(
                f"Span count {span_count} exceeds maximum of {max_spans}"
            )

        # consume one Telemetry Ingestion Unit per decoded Span
        # before any durable write. The callback raises on rejection.
        if admission_consume_units is not None:
            admission_consume_units(span_count)

        # 3. Persist the durable inbox record with full decoded content.
        batch_id = str(uuid.uuid4())
        payload_str = json.dumps(decoded)
        payload_hash = hashlib.sha256(payload).hexdigest()

        batch = OtlpIngestBatchDB(
            id=batch_id,
            project_id=project_id,
            content_type=content_type,
            payload_sha256=payload_hash,
            payload=payload_str,
            status="processing",
            api_key_id=api_key_id,
            payload_bytes=len(payload),
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
                    # span. The receiver
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

        new_values: dict[str, Any] = {
            "parent_span_id": span.get("parentSpanId"),
            # Materialized hottest search filter. May be None —
            # _is_informationless(None) keeps a late resource-less retry
            # from clobbering a stored service.
            "service_name": resource_attrs.get("service.name"),
            "start_time": start_time,
            "end_time": end_time,
            "span_name": str(span.get("name", "")),
            "span_kind": self._parse_enum_int(span.get("kind", 0)),
            "status_code": (
                self._parse_enum_int(status.get("code", 0))
                if isinstance(status, dict)
                else 0
            ),
            "status_message": (
                status.get("message") if isinstance(status, dict) else None
            ),
            "trace_flags": self._parse_enum_int(span.get("flags", 0)),
            "trace_state": span.get("traceState"),
            "resource": {
                "attributes": resource_attrs,
                **{k: v for k, v in resource.items() if k != "attributes"},
            },
            "instrumentation_scope": scope if scope else None,
            "attributes": attributes,
            "events": events if events else None,
            "links": links if links else None,
        }

        if existing is not None:
            # OTLP delivery is at-least-once, so a duplicate export is normal.
            # A byte-identical retry is a no-op; a retry that carries LESS
            # than stored (e.g. a re-serialized batch missing the end time)
            # must never destroy information. Only updates that strictly add
            # information are applied.
            updates = _information_adding_updates(existing, new_values)
            if updates is None:
                return existing
            for key, value in updates.items():
                setattr(existing, key, value)
            existing.content_policy = "full"
            session.add(existing)
            session.flush()
            return existing

        canonical = OtlpSpanDB(project_id=project_id, trace_id=trace_id, span_id=span_id, **new_values)
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
        The OTLP enums apo stores (SpanKind, StatusCode) have unique names,
        so one shared name→int map resolves them.
        """
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            mapped = _ENUM_NAME_TO_INT.get(value)
            if mapped is not None:
                return mapped
            try:
                return int(value)
            except ValueError:
                return default
        return default

    def _extract_value(self, container: dict[str, Any]) -> Any:
        """Extract a typed value from an OTLP AnyValue container."""
        if "stringValue" in container:
            return container["stringValue"]
        if "bytesValue" in container:
            # OTLP/JSON and MessageToDict both render bytes as base64 text;
            # store that text so the value survives instead of being dropped.
            raw = container["bytesValue"]
            if isinstance(raw, bytes):
                return base64.b64encode(raw).decode("ascii")
            return raw
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
            extracted: dict[str, Any] = {
                "traceId": link.get("traceId", ""),
                "spanId": link.get("spanId", ""),
                "attributes": self._extract_attrs(link.get("attributes", [])),
            }
            if "flags" in link:
                extracted["flags"] = link["flags"]
            if link.get("traceState"):
                extracted["traceState"] = link["traceState"]
            result.append(extracted)
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
    ) -> str:
        """Create a failed batch record for an undecodable payload."""
        batch_id = str(uuid.uuid4())
        batch = OtlpIngestBatchDB(
            id=batch_id,
            project_id=project_id,
            content_type=content_type,
            payload_sha256=hashlib.sha256(payload).hexdigest(),
            payload="",
            status="failed",
            error_message=error[:500],
        )
        session.add(batch)
        session.commit()
        return batch_id
