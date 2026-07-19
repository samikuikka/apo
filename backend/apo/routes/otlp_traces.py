"""Standard OTLP/HTTP trace receiver route (SPEC-129 Track 1).

The canonical external trace write endpoint. Accepts OTLP/JSON and
OTLP/protobuf with optional gzip encoding, authenticates via the standard
middleware, binds the project from credentials (never from payload), and
delegates to :class:`~apo.services.otlp_receiver.OtlpReceiver`.

Returns standard OTLP ``ExportTraceServiceResponse`` with partial-success
semantics: individual span failures don't fail the batch. The response
encoding matches the request encoding (protobuf → protobuf, JSON → JSON).
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from sqlmodel import Session

from ..auth.deps import require_api_key_scope
from ..db import get_session
from ..models.db import ProjectDB
from ..services.content_policy import normalize_trace_content_policy
from ..services.otlp_receiver import OtlpReceiver

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

    # Normalize content type (strip charset suffix)
    if ";" in content_type:
        content_type = content_type.split(";")[0].strip()

    # Get project from authenticated credentials (set by middleware).
    # SPEC-129 §1: "derive project_id from the authenticated key or service
    # token." Cookie auth and open-dev mode do NOT set request.state.project,
    # so we reject those (403) rather than silently writing to "default".
    project_id = getattr(request.state, "project", None)
    if not isinstance(project_id, str) or not project_id:
        raise HTTPException(
            status_code=403,
            detail="OTLP ingestion requires API key or service token authentication. "
                   "Cookie-authenticated requests are not accepted on this endpoint.",
        )

    # Build the authenticated ingestion context (SPEC-131 M3). project_id is
    # always auth-derived; the service-token subject gates Task Run claims.
    from ..models.trace_ingestion import TraceIngestionContext

    context = TraceIngestionContext.for_request_state(
        project_id=project_id,
        auth_method=getattr(request.state, "auth_method", None),
        service_task_run_id=getattr(request.state, "service_task_run_id", None),
    )
    project = session.get(ProjectDB, project_id)
    content_policy = normalize_trace_content_policy(
        project.trace_content_policy if project is not None else None
    )

    # Ingest with async projection: persist spans + enqueue batch, then
    # project in a background task so the OTLP response returns immediately.
    # SPEC-129 §2: "The caller gets an OTLP acceptance response after the
    # inbox commit; dashboard visibility is eventually consistent."
    receiver = OtlpReceiver()
    result = receiver.ingest(
        payload=body,
        content_type=content_type,
        project_id=project_id,
        session=session,
        encoding=encoding,
        content_policy=content_policy,
        context=context,
        project_immediately=False,
    )

    partial = _build_partial_success(result.rejected, result.errors)

    # SPEC-129 §2: projection runs asynchronously so the OTLP response returns
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

    # Encode the response to match the request encoding (SPEC-131 Milestone 2.5).
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
