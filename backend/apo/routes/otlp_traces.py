"""Standard OTLP/HTTP trace receiver route.

The canonical external trace write endpoint. Accepts OTLP/JSON and
OTLP/protobuf with optional gzip encoding, authenticates via the standard
middleware, binds the project from credentials (never from payload), and
delegates to :class:`~apo.services.otlp_receiver.OtlpReceiver`.

Returns standard OTLP ``ExportTraceServiceResponse`` with partial-success
semantics: individual span failures don't fail the batch. The response
encoding matches the request encoding (protobuf → protobuf, JSON → JSON).
"""

# pyright: reportAny=false, reportCallInDefaultInitializer=false, reportImplicitStringConcatenation=false, reportPrivateUsage=false, reportUnannotatedClassAttribute=false, reportUnusedVariable=false

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from sqlmodel import Session

from ..auth.deps import require_api_key_scope
from ..db import get_session
from ..middleware.telemetry_admission import rate_limit_response
from ..services.ingest_quota import enforce_ingest_guardrails, record_ingest_usage
from ..services.otlp_receiver import (
    OtlpDecodeError,
    OtlpReceiver,
    OtlpSizeLimitError,
)
from ..services.telemetry_admission import AdmissionRejection
from ..services.telemetry_limits import load_telemetry_transport_limits

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/public/otel", tags=["otel"])


def _build_partial_success(
    rejected: int, errors: list[dict[str, str]]
) -> dict[str, object] | None:
    """Build the OTLP partialSuccess object, or None when nothing was rejected."""
    if rejected == 0:
        return None
    return {
        "rejectedSpans": int(rejected),
        "errorMessage": "; ".join(e.get("error", "") for e in errors[:5]),
    }


@router.post("/v1/traces")
async def receive_otlp_traces(
    request: Request,
    response: Response,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full", "ingest")),
) -> Response:
    """Receive and persist an OTLP trace batch.

    Accepts:
      - ``Content-Type: application/json`` — OTLP/JSON
      - ``Content-Type: application/x-protobuf`` — OTLP/protobuf
      - ``Content-Encoding: gzip`` — gzip-compressed payload

    The project is derived from authenticated credentials via
    ``request.state.project`` — never from payload attributes.

    Returns a standard OTLP ``ExportTraceServiceResponse`` whose encoding
    matches the request encoding.
    """
    # Read the raw body
    body = await request.body()
    content_type = request.headers.get("content-type", "application/json")
    encoding = request.headers.get("content-encoding")

    # consume bytes from the admission controller's byte budget.
    # The hard cap already bounded the body; this charges it to
    # the sustained per-identity + global byte rate buckets. No refund on
    # later failure.
    identity = getattr(request.state, "telemetry_identity", None)
    try:
        controller = getattr(request.app.state, "admission_controller", None)
    except (KeyError, AttributeError):
        controller = None
    if identity is not None and controller is not None:
        byte_rejection = controller.consume_bytes(identity, len(body))
        if byte_rejection is not None:
            return rate_limit_response(byte_rejection)

    # Normalize content type (strip charset suffix)
    if ";" in content_type:
        content_type = content_type.split(";")[0].strip()

    # Get project from authenticated credentials (set by middleware).
    project_id = getattr(request.state, "project", None)
    if not isinstance(project_id, str) or not project_id:
        raise HTTPException(
            status_code=403,
            detail="OTLP ingestion requires API key or service token authentication. "
                   "Cookie-authenticated requests are not accepted on this endpoint.",
        )

    # Load transport limits. The on-wire cap and deadline were
    # already enforced by the middleware while streaming; the receiver uses
    # the decompressed/span caps for post-decode admission.
    limits = load_telemetry_transport_limits()

    # Build the authenticated ingestion context.
    from ..models.trace_ingestion import TraceIngestionContext

    context = TraceIngestionContext.for_request_state(
        project_id=project_id,
        auth_method=getattr(request.state, "auth_method", None),
        service_task_run_id=getattr(request.state, "service_task_run_id", None),
    )

    # Ingest with transport limits. Request-level failures raise
    # typed errors and write nothing — the route maps them to OTLP responses.
    receiver = OtlpReceiver()

    # consume one unit per decoded Span, before any persistence.
    # The same hook enforces the per-key daily quota / pause —
    # post-decode, pre-durable-write, with the decoded span count.
    def _consume_units(count: int) -> None:
        enforce_ingest_guardrails(request, session, pending_spans=count)
        if identity is not None and controller is not None:
            unit_rejection = controller.consume_units(identity, count)
            if unit_rejection is not None:
                raise _AdmissionUnitError(unit_rejection)

    try:
        # Issue #177: ingest decodes the (up to 10 MB) payload and persists
        # every span with blocking SQL — run it off the event loop the same
        # way #174 moved result finalization, so one busy exporter cannot
        # freeze /heartbeat and the lease reaper's sweep. The request
        # session is safe to hand over: SQLite opens with
        # check_same_thread=False and each call is fully awaited before the
        # session is touched again. The admission callback only touches the
        # lock-protected in-memory controller, so it is thread-safe.
        result = await asyncio.to_thread(
            receiver.ingest,
            payload=body,
            content_type=content_type,
            project_id=project_id,
            session=session,
            encoding=encoding,
            context=context,
            project_immediately=False,
            limits=limits,
            admission_consume_units=_consume_units,
            api_key_id=getattr(request.state, "api_key_id", None),
        )
    except OtlpDecodeError as exc:
        return _otlp_error_response(content_type, 400, str(exc))
    except OtlpSizeLimitError as exc:
        return _otlp_error_response(content_type, 413, str(exc))
    except _AdmissionUnitError as exc:
        return rate_limit_response(exc.rejection)

    partial = _build_partial_success(result.rejected, result.errors)

    # Usage accounting — AFTER the inbox commit, non-fatal by
    # design: a failed counter must never turn an accepted batch into a
    # 500 (the SDK would retry and re-send).
    record_ingest_usage(
        session,
        getattr(request.state, "api_key_id", None),
        spans=result.accepted,
        bytes_=len(body),
    )

    # projection runs asynchronously so the OTLP response returns
    # immediately after the inbox commit. We process just the batch we accepted
    # (not any arbitrary queued batch) via a background task.
    async def _project_batch():
        try:
            from ..services.trace_ingestion_queue import QueueWorker
            worker = QueueWorker(receiver=OtlpReceiver())
            _ = await worker.process_batch(result.batch_id)
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "Background projection failed for batch %s", result.batch_id,
                exc_info=True,
            )

    # Schedule the projection as a background task — the response returns
    # immediately after the inbox commit, and the worker projects async.
    background_tasks.add_task(_project_batch)

    # Add headers for observability
    response.headers["X-Otlp-Accepted"] = str(result.accepted)
    response.headers["X-Otlp-Rejected"] = str(result.rejected)
    response.headers["X-Otlp-Batch-Id"] = result.batch_id
    response.headers["X-Otlp-Mode"] = "async"

    # Encode the response to match the request encoding.
    if content_type == "application/x-protobuf":
        from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
            ExportTraceServiceResponse,
        )

        proto_response = ExportTraceServiceResponse()
        if partial is not None:
            proto_response.partial_success.rejected_spans = result.rejected
            proto_response.partial_success.error_message = "; ".join(
                e.get("error", "") for e in result.errors[:5]
            )
        return Response(
            content=proto_response.SerializeToString(),
            media_type="application/x-protobuf",
            headers=response.headers,
        )

    # Default: OTLP/JSON response.
    otlp_response: dict[str, object] = {}
    if partial is not None:
        otlp_response["partialSuccess"] = partial
    return Response(
        content=json.dumps(otlp_response),
        media_type="application/json",
        headers=response.headers,
    )


def _otlp_error_response(content_type: str, status_code: int, message: str) -> Response:
    """Encode a ``google.rpc.Status`` error in the request's response encoding.

    FastAPI OTLP failures use the matching OTLP response encoding
    (protobuf → serialized Status, JSON → protobuf JSON representation).
    The message is a short developer-facing string with no payload or
    credential detail.
    """
    if content_type == "application/x-protobuf":
        from google.rpc.status_pb2 import Status as RpcStatus

        rpc_status = RpcStatus(code=0, message=message)
        return Response(
            content=rpc_status.SerializeToString(),
            status_code=status_code,
            media_type="application/x-protobuf",
        )

    return Response(
        content=json.dumps({"code": 0, "message": message}),
        status_code=status_code,
        media_type="application/json",
    )


class _AdmissionUnitError(Exception):
    """Carries an AdmissionRejection out of the receiver's unit-consumption callback."""

    def __init__(self, rejection: AdmissionRejection) -> None:
        self.rejection = rejection
        super().__init__(str(rejection))
