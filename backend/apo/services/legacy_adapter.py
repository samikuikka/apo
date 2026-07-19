"""Legacy ingestion adapter — translates legacy events into canonical spans.

The legacy ``/api/v1/ingestion`` route translates each event into a canonical
``OtlpSpanDB`` row and projects it through ``TraceProjector`` (which derives
``RunDB``/``LoggedCallDB``). This makes the legacy route an adapter over the
canonical path (SPEC-129 Track 6) rather than a separate direct writer.

Legacy IDs (arbitrary strings) are preserved as-is in the canonical store —
the canonical ``OtlpSpanDB`` uniqueness is ``(project_id, trace_id, span_id)``
and does not require hex IDs. The OTLP wire-format receiver validates hex IDs
separately; this adapter bypasses the wire layer and writes the canonical
model directly.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, cast

from sqlmodel import Session, select

from ..models.db import OtlpSpanDB

logger = logging.getLogger(__name__)


def ingest_run_create_to_canonical(
    body: dict[str, object],
    session: Session,
) -> OtlpSpanDB | None:
    """Translate a legacy ``run-create`` event into a root canonical span.

    Creates the RunDB directly (a run-create event describes the RUN, not a
    call observation) and persists a root canonical span for the source of
    truth. The root span is NOT projected as a LoggedCallDB — only call-create
    events become calls.
    """
    from ..models.db import RunDB
    from sqlmodel import select as _select

    trace_id = cast(str, body.get("id", ""))
    if not trace_id:
        return None

    project_id = cast(str, body.get("project", "default"))
    span_id = _root_span_id(trace_id)

    # Ensure the RunDB row exists with all legacy fields (directly, since a
    # run-create event is about the run, not a span observation).
    run = session.exec(
        _select(RunDB).where(RunDB.id == trace_id, RunDB.project == project_id)
    ).first()
    if run is None:
        run = RunDB(
            id=trace_id,
            project=project_id,
            environment=cast(str, body.get("environment", "default")),
            created_at=_parse_dt(cast(str, body.get("created_at"))) or datetime.now(timezone.utc),
        )
    if body.get("flow_name"):
        run.flow_name = str(body["flow_name"])
    if body.get("task_id"):
        run.task_id = str(body["task_id"])
    if body.get("version"):
        run.version = str(body["version"])
    if body.get("user_id"):
        run.user_id = str(body["user_id"])
    if body.get("session_id"):
        run.session_id = str(body["session_id"])
    if body.get("external_id"):
        run.external_id = str(body["external_id"])
    if body.get("tags"):
        run_tags = body["tags"]
        if isinstance(run_tags, list):
            run.tags = [str(t) for t in run_tags]
    if body.get("run_metadata"):
        run_meta = body["run_metadata"]
        if isinstance(run_meta, dict):
            run.run_metadata = cast(dict[str, object], run_meta)
    session.add(run)
    session.flush()

    # Persist the root canonical span (source of truth) but do NOT project it
    # as a call — run-create events don't create observations.
    span = _upsert_canonical_span(
        session,
        project_id=project_id,
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=None,
        span_name=cast(str, body.get("flow_name", "")) or "run",
        start_time=_parse_dt(cast(str, body.get("created_at"))) or datetime.now(timezone.utc),
        end_time=None,
        attributes=_run_attributes(body),
        raw_span=body,
    )
    return span


def ingest_call_create_to_canonical(
    body: dict[str, object],
    session: Session,
) -> OtlpSpanDB | None:
    """Translate a legacy ``call-create`` event into a canonical span + project."""
    span_id = cast(str, body.get("id", ""))
    trace_id = cast(str, body.get("run_id", ""))
    if not span_id or not trace_id:
        return None

    project_id = cast(str, body.get("project", "default"))
    attributes = _call_attributes(body)
    created_at = _parse_dt(cast(str, body.get("created_at", "")))
    span = _upsert_canonical_span(
        session,
        project_id=project_id,
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=cast(str | None, body.get("parent_call_id")),
        span_name=cast(str, body.get("step_name", "")) or span_id,
        start_time=created_at or datetime.now(timezone.utc),
        end_time=None,
        attributes=attributes,
        raw_span=body,
    )
    _project(session, span)
    return span


def ingest_call_update_to_canonical(
    body: dict[str, object],
    session: Session,
) -> OtlpSpanDB | None:
    """Merge a legacy ``call-update`` into the existing canonical span + re-project.

    OTLP is a whole-span model, but the legacy protocol sends partial patches.
    Load the existing span, merge the patched fields, and re-project.
    """
    span_id = cast(str, body.get("id", ""))
    if not span_id:
        return None

    project_id = cast(str, body.get("project", "default"))
    existing = _find_span(session, span_id, project_id)
    if existing is None:
        return None

    # Merge update fields into the canonical span.
    if body.get("end_time"):
        existing.end_time = _parse_dt(cast(str, body["end_time"]))
    # Copy into a fresh dict so SQLAlchemy detects the mutation (JSON columns
    # don't track in-place edits).
    attrs = dict(existing.attributes or {})
    if body.get("output"):
        attrs["output"] = body["output"]
    if body.get("prompt_tokens") is not None:
        attrs["gen_ai.usage.input_tokens"] = body["prompt_tokens"]
    if body.get("completion_tokens") is not None:
        attrs["gen_ai.usage.output_tokens"] = body["completion_tokens"]
    if body.get("status_message"):
        attrs["error.message"] = body["status_message"]
    if body.get("level") == "ERROR":
        attrs["error.present"] = True
    existing.attributes = attrs
    session.add(existing)
    session.flush()

    _project(session, existing)
    return existing


# ---------------------------------------------------------------------------
# internals
# ---------------------------------------------------------------------------


def _root_span_id(trace_id: str) -> str:
    """Derive a deterministic root span id from the trace id.

    Legacy run-create events don't carry a span id, so synthesize one from the
    trace id. This keeps re-ingestion idempotent.
    """
    # Use the last 16 chars of the trace id, or pad if shorter.
    candidate = trace_id[-16:].rjust(16, "0")
    return candidate if candidate != "0" * 16 else trace_id[:16].ljust(16, "1")


def _run_attributes(body: dict[str, object]) -> dict[str, Any]:
    """Build span attributes from a run-create body."""
    attrs: dict[str, Any] = {"apo.observation.type": "AGENT"}
    if body.get("flow_name"):
        attrs["apo.run.flow_name"] = body["flow_name"]
    if body.get("task_id"):
        attrs["apo.run.task_id"] = body["task_id"]
    if body.get("version"):
        attrs["apo.run.version"] = body["version"]
    if body.get("user_id"):
        attrs["apo.run.user_id"] = body["user_id"]
    if body.get("session_id"):
        attrs["apo.run.session_id"] = body["session_id"]
    if body.get("environment"):
        attrs["apo.run.environment"] = body["environment"]
    if body.get("external_id"):
        attrs["apo.run.external_id"] = body["external_id"]
    if body.get("tags"):
        attrs["apo.run.tags"] = json.dumps(body["tags"])
    if body.get("run_metadata"):
        attrs["apo.run.metadata"] = json.dumps(body["run_metadata"])
    return attrs


def _call_attributes(body: dict[str, object]) -> dict[str, Any]:
    """Build span attributes from a call-create body."""
    attrs: dict[str, Any] = {}
    if body.get("model"):
        attrs["gen_ai.request.model"] = body["model"]
    if body.get("observation_type"):
        attrs["apo.observation.type"] = body["observation_type"]
    if body.get("prompt_tokens") is not None:
        attrs["gen_ai.usage.input_tokens"] = body["prompt_tokens"]
    if body.get("completion_tokens") is not None:
        attrs["gen_ai.usage.output_tokens"] = body["completion_tokens"]
    if body.get("input"):
        attrs["input"] = body["input"]
    if body.get("output"):
        attrs["output"] = body["output"]
    if body.get("tool_name"):
        attrs["gen_ai.tool.name"] = body["tool_name"]
    if body.get("tool_parameters"):
        attrs["gen_ai.tool.call.arguments"] = body["tool_parameters"]
    if body.get("metadata"):
        attrs["metadata"] = body["metadata"]
    return attrs


def _upsert_canonical_span(
    session: Session,
    *,
    project_id: str,
    trace_id: str,
    span_id: str,
    parent_span_id: str | None,
    span_name: str,
    start_time: datetime,
    end_time: datetime | None,
    attributes: dict[str, Any],
    raw_span: dict[str, object],
) -> OtlpSpanDB:
    """Insert or update a canonical OtlpSpanDB row, idempotent by (project, trace, span)."""
    existing = _find_span(session, span_id, project_id)
    if existing is not None:
        existing.parent_span_id = parent_span_id
        existing.span_name = span_name
        existing.start_time = start_time or existing.start_time
        if end_time is not None:
            existing.end_time = end_time
        existing.attributes = attributes
        existing.raw_span = raw_span
        session.add(existing)
        session.flush()
        return existing

    span = OtlpSpanDB(
        project_id=project_id,
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        start_time=start_time,
        end_time=end_time,
        span_name=span_name,
        attributes=attributes,
        resource={},
        raw_span=raw_span,
        content_policy="legacy",
    )
    session.add(span)
    session.flush()
    return span


def _find_span(session: Session, span_id: str, project_id: str) -> OtlpSpanDB | None:
    """Load a canonical span by (span_id, project_id).

    ``project_id`` is required: the OTel span id is not globally unique once two
    projects can share one, so an unscoped lookup could resolve another project's
    span (SPEC-133 M4).
    """
    return session.exec(
        select(OtlpSpanDB).where(
            OtlpSpanDB.span_id == span_id, OtlpSpanDB.project_id == project_id
        )
    ).first()


def _project(session: Session, span: OtlpSpanDB) -> None:
    """Project a canonical span through the TraceProjector (derives RunDB/LoggedCallDB)."""
    from .trace_projector import get_trace_projector

    get_trace_projector().project(span, session)
    session.flush()


def _parse_dt(value: str) -> datetime | None:
    """Parse an ISO datetime string."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
