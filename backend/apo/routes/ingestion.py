# pyright: reportCallInDefaultInitializer=false

"""
Legacy batch ingestion API (deprecated — SPEC-129).

This route accepts apo's custom event protocol (``run-create``, ``call-create``,
``call-update``, ``score-create``) at ``POST /api/v1/ingestion``. It is
superseded by the canonical OTLP receiver at ``POST /api/public/otel/v1/traces``
which accepts standard OpenTelemetry spans from any language SDK.

This route remains functional as a compatibility adapter for existing
``TraceTracker`` consumers. New integrations should use OTLP instead.

Accepts arrays of events in a single request for improved throughput.
"""

from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session

from ..auth.deps import require_api_key_scope
from ..db import get_session
from ..models.db import AgentTaskRunDB
from ..models.schemas import (
    BatchIngestionRequest,
    IngestionResponse,
    IngestionError,
)
from ..services.ingestion import (
    process_score_create,
)
from ..services.legacy_adapter import (
    ingest_run_create_to_canonical,
    ingest_call_create_to_canonical,
    ingest_call_update_to_canonical,
)
from ..services.run_events import emit_task_run_trace_claimed
from ..services.trace_ownership import claim_trace

router = APIRouter()


@router.post("/api/v1/ingestion", response_model=IngestionResponse)
async def batch_ingestion(
    request: Request,
    payload: BatchIngestionRequest,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full", "ingest")),
):
    """
    Langfuse-style batch ingestion endpoint.

    Processes multiple events efficiently in a single request:
    - run-create: Create or update a run
    - call-create: Create a new logged call (observation/span)
    - call-update: Update an existing logged call (e.g., with output/timing)

    Returns success count and error details for any failed events.
    One failed event doesn't fail the entire batch.
    """
    _validate_service_token_batch(request, payload)

    processed = 0
    errors: list[IngestionError] = []

    for event in payload.batch:
        try:
            if event.type == "run-create":
                _claim_task_run_trace(request, session, event.body)
                ingest_run_create_to_canonical(event.body, session)
                processed += 1
            elif event.type == "call-create":
                ingest_call_create_to_canonical(event.body, session)
                processed += 1
            elif event.type == "call-update":
                ingest_call_update_to_canonical(event.body, session)
                processed += 1
            elif event.type == "score-create":
                await process_score_create(event.body, session)
                processed += 1
            else:
                errors.append(
                    IngestionError(
                        event_id=event.id, error=f"Unknown event type: {event.type}"
                    )
                )
        except Exception as e:
            errors.append(IngestionError(event_id=event.id, error=str(e)))

    session.commit()

    return IngestionResponse(processed=processed, errors=errors)


def _validate_service_token_batch(
    request: Request,
    payload: BatchIngestionRequest,
) -> None:
    if getattr(request.state, "auth_method", None) != "service_token":
        return

    project = getattr(request.state, "project", None)
    service_task_run_id = getattr(request.state, "service_task_run_id", None)
    if not isinstance(project, str) or not isinstance(service_task_run_id, str):
        raise HTTPException(status_code=403, detail="Invalid service token context")

    for event in payload.batch:
        if event.type in {"run-create", "call-create"}:
            event_project = event.body.get("project")
            if not isinstance(event_project, str) or event_project != project:
                raise HTTPException(
                    status_code=403,
                    detail="Service token project mismatch",
                )

        if event.type == "run-create":
            run_metadata = event.body.get("run_metadata")
            typed_run_metadata = (
                cast(dict[str, object], run_metadata)
                if isinstance(run_metadata, dict)
                else {}
            )
            if typed_run_metadata.get(
                "agent_task_run_id"
            ) != service_task_run_id:
                raise HTTPException(
                    status_code=403,
                    detail="Service token task run mismatch",
                )


def _claim_task_run_trace(
    request: Request,
    session: Session,
    body: dict[str, object],
) -> None:
    """Atomically reserve the task run's single trace ID before ingestion.

    Extracts the service-token task-run context from the request and the
    trace id from the run-create body, then delegates the atomic claim and
    invariant check to :func:`trace_ownership.claim_trace`. Publishes a
    ``task_run.trace_claimed`` run event so the dashboard can open the live
    trace stream while the task is still executing.
    """
    task_run_id = getattr(request.state, "service_task_run_id", None)
    if not isinstance(task_run_id, str):
        return

    trace_id = body.get("id")
    if not isinstance(trace_id, str):
        raise ValueError("Task trace run-create event is missing an ID")

    # Capture state before the claim: claim_trace() calls session.expire_all(),
    # which would force a lazy reload on later access. We also use this to
    # skip the event on the no-op idempotent re-claim (same trace id) so we
    # only notify subscribers the first time a run is linked to its trace.
    existing = session.get(AgentTaskRunDB, task_run_id)
    batch_run_id = existing.batch_run_id if existing is not None else None
    already_claimed = existing is not None and existing.trace_run_id == trace_id

    claim_trace(session, task_run_id, trace_id)

    if already_claimed:
        return

    project = getattr(request.state, "project", None)
    if isinstance(project, str):
        emit_task_run_trace_claimed(
            project=project,
            task_run_id=task_run_id,
            trace_run_id=trace_id,
            batch_run_id=batch_run_id,
        )
