"""Trace Projector — bridges canonical OTel spans to product tables (SPEC-129 Track 3).

Takes ``OtlpSpanDB`` rows, normalizes them via the Track 2 normalizer, and
upserts into the existing ``RunDB`` / ``LoggedCallDB`` tables. This is the
bridge that lets the dashboard query the same tables it always has, while the
canonical data lives in the OTel-native ``OtlpSpanDB`` store.

Properties (SPEC-129 §4):
  - Tolerates children before parents, roots arriving last, multiple batches.
  - Idempotent: projecting the same span twice doesn't duplicate rows.
  - Root data chosen from actual root spans, not first batch.
  - Dashboard APIs, SSE, and assertion layers read from these tables unchanged.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from sqlmodel import Session, col, select

from ..models.db import (
    LoggedCallDB,
    OtlpSpanDB,
    RunDB,
    RunMetricDB,
)
from ..models.trace_ingestion import TraceIngestionContext
from .otel_normalization import NormalizedSpan, normalize_span
from .projection_lookup import (
    select_call,
    select_run,
)

if TYPE_CHECKING:
    from .trace_repository import NativeTraceRepository

logger = logging.getLogger(__name__)


# Module-level singleton — the projector is stateless, so a single instance
# serves all callers (SPEC-133 architecture follow-up: consolidate recorders).
_projector_cache: list[TraceProjector] = []


def get_trace_projector() -> TraceProjector:
    """Return the shared projector instance (stateless, safe to reuse)."""
    if not _projector_cache:
        _projector_cache.append(TraceProjector())
    return _projector_cache[0]


class TraceProjector:
    """Projects canonical OTel spans into ``RunDB`` / ``LoggedCallDB``.

    Each call to :meth:`project` handles one span. The projector is stateless
    between calls — it reads existing rows from the DB to handle idempotency
    and root detection.
    """

    def project(
        self,
        span: OtlpSpanDB,
        session: Session,
        context: TraceIngestionContext | None = None,
    ) -> None:
        """Project one canonical span into the product tables.

        - If the span is a root (no parent), ensures a ``RunDB`` row exists.
        - Upserts a ``LoggedCallDB`` row with normalized fields.
        - Score sentinel spans (``apo.score: true``) route to the metrics
          tables instead of becoming a fake call (SPEC-129 Track 6).
        - Idempotent: re-projecting the same span updates, never duplicates.

        ``context`` gates Task Run claims: only an authenticated service token
        whose subject matches the claimed run may link the trace (SPEC-131 M3).
        """
        attrs = span.attributes or {}

        # Score sentinel spans are product-domain records, not calls. Route
        # them to the scoring service. A score is a product-domain record, not
        # a synthetic telemetry span. The
        # transitional ``apo.score`` convention lives in its own module so the
        # projector stays free of score plumbing (ADR-0001).
        if _is_truthy(attrs.get("apo.score")):
            from .score_router import route_score_span

            route_score_span(session, span)
            session.flush()
            return

        normalized = normalize_span(span)
        is_root = span.parent_span_id is None

        # Route writes through the TraceRepository boundary (SPEC-129 §4).
        from .trace_repository import NativeTraceRepository
        repo = NativeTraceRepository()

        # Detect state transitions BEFORE upsert so we can broadcast the right
        # event type and fire run-completion aggregates.
        existing_call = select_call(session, span.span_id, span.project_id)
        is_new_call = existing_call is None
        run_before = select_run(session, span.trace_id, span.project_id)
        was_complete = run_before is not None and run_before.completed_at is not None
        run_existed = run_before is not None

        # Ensure the run exists
        self._upsert_run(session, span, normalized, is_root, context, repo)

        # Upsert the call (applies cost + tokens inside)
        self._upsert_call(session, span, normalized, repo)

        # When the root span completes the run, compute aggregate metrics.
        if is_root and span.end_time and not was_complete:
            _compute_run_aggregates(session, span.trace_id, span.project_id)

        session.flush()

        # Broadcast SSE events so the dashboard's live trace stream works for
        # canonical OTLP traces the same way it does for legacy ingestion.
        _broadcast_projection(
            session, span, normalized, is_root, is_new_call, run_existed
        )

    def _upsert_run(
        self,
        session: Session,
        span: OtlpSpanDB,
        normalized: NormalizedSpan,
        is_root: bool,
        context: TraceIngestionContext | None = None,
        repo: NativeTraceRepository | None = None,
    ) -> None:
        """Ensure a RunDB row exists for this trace.

        For root spans, update run-level fields (flow_name, task_id, etc.).
        For non-root spans, create the run if it doesn't exist yet (child
        arriving before root).
        """
        run = select_run(session, span.trace_id, span.project_id)

        if run is None:
            # SPEC-133 M4: surrogate PKs allow two projects to project the
            # same OTel trace ID. No cross-project conflict check needed.
            run = RunDB(
                id=span.trace_id,
                project=span.project_id,
                environment="default",
                created_at=span.start_time or datetime.now(timezone.utc),
            )
            session.add(run)
            session.flush()

        # Update run-level fields from the root span
        if is_root:
            attrs = span.attributes or {}
            if attrs.get("apo.run.flow_name"):
                run.flow_name = str(attrs["apo.run.flow_name"])
            if attrs.get("apo.run.task_id"):
                run.task_id = str(attrs["apo.run.task_id"])
            if attrs.get("apo.run.version"):
                run.version = str(attrs["apo.run.version"])
            # SPEC-129 §5: propagate tags and metadata from root span
            if attrs.get("apo.run.tags"):
                try:
                    run.tags = json.loads(str(attrs["apo.run.tags"]))
                except (json.JSONDecodeError, ValueError):
                    pass
            if attrs.get("apo.run.metadata"):
                try:
                    run.run_metadata = json.loads(str(attrs["apo.run.metadata"]))
                except (json.JSONDecodeError, ValueError):
                    pass
            # Run-level scalar fields propagated through canonical attributes
            # (SPEC-129 Track 6 parity — legacy ingestion wrote these directly).
            if attrs.get("apo.run.user_id"):
                run.user_id = str(attrs["apo.run.user_id"])
            if attrs.get("apo.run.session_id"):
                run.session_id = str(attrs["apo.run.session_id"])
            if attrs.get("apo.run.environment"):
                run.environment = str(attrs["apo.run.environment"])
            if attrs.get("apo.run.external_id"):
                run.external_id = str(attrs["apo.run.external_id"])

            # SPEC-131 §Authenticated ingestion context: a Task Run claim is
            # subject- and project-bound. The payload attribute alone is never
            # trusted — it must match the authenticated service-token subject
            # and the claimed run must belong to this project.
            task_run_id = attrs.get("apo.task.run.id")
            if isinstance(task_run_id, str) and task_run_id:
                if _claim_task_run(session, span, task_run_id, context):
                    run.task_run_id = task_run_id

            # If the root span has an endTime, mark the run complete
            if span.end_time and not run.completed_at:
                run.completed_at = span.end_time
                if run.created_at:
                    raw_duration = (
                        span.end_time.replace(tzinfo=None) - run.created_at.replace(tzinfo=None)
                    ).total_seconds() * 1000
                    run.duration_ms = max(0.0, raw_duration)

            # Set primary model from the root span if it has one
            if normalized.model:
                run.primary_model = normalized.model

            session.add(run)

    def _upsert_call(
        self,
        session: Session,
        span: OtlpSpanDB,
        normalized: NormalizedSpan,
        repo: NativeTraceRepository | None = None,
    ) -> None:
        """Upsert a LoggedCallDB row from the normalized span."""
        call = select_call(session, span.span_id, span.project_id)
        # Fall back to raw span attributes for input/output when the normalizer
        # didn't extract them (e.g. legacy adapter writes free-form dicts).
        raw_input = _raw_attr(span, "input")
        raw_output = _raw_attr(span, "output")
        input_value = normalized.input or raw_input or {}
        output_value = normalized.output or raw_output or {}

        if call is None:
            # Create new. The projection row needs a NOT NULL created_at for
            # ordering; fall back to ingestion time only here. The canonical
            # OtlpSpanDB keeps the honest (possibly None) timestamp — the
            # projection is derived and must never influence the source of truth.
            call = LoggedCallDB(
                id=span.span_id,
                run_id=span.trace_id,
                project=span.project_id,
                task_id="",
                created_at=span.start_time or datetime.now(timezone.utc),
                model=normalized.model or "",
                observation_type=normalized.observation_type,
                step_name=normalized.display_name,
                parent_call_id=span.parent_span_id,
                input=input_value,
                output=output_value,
                messages=self._extract_messages(normalized),
            )
            session.add(call)
        else:
            # Update existing (idempotent re-projection)
            call.model = normalized.model or call.model
            call.observation_type = normalized.observation_type
            call.step_name = normalized.display_name
            call.parent_call_id = span.parent_span_id
            if input_value:
                call.input = input_value
            if output_value:
                call.output = output_value
            # Update messages if we have them
            msgs = self._extract_messages(normalized)
            if msgs:
                call.messages = msgs  # type: ignore[assignment]
            session.add(call)

        # Set typed fields from normalization
        # Use explicit None check (not `or None`) so zero-token spans are preserved
        if normalized.token_usage:
            prompt = normalized.token_usage.get("prompt")
            if prompt is not None:
                call.prompt_tokens = int(prompt)
            completion = normalized.token_usage.get("completion")
            if completion is not None:
                call.completion_tokens = int(completion)

        # total_tokens (SPEC-129 Track 6 parity with legacy ingestion.py).
        if call.prompt_tokens is not None or call.completion_tokens is not None:
            call.total_tokens = (call.prompt_tokens or 0) + (call.completion_tokens or 0)

        if normalized.tool_name:
            call.tool_name = normalized.tool_name
        if normalized.tool_parameters:
            call.tool_parameters = normalized.tool_parameters
        if normalized.tool_result:
            call.tool_result = normalized.tool_result

        # Timing
        call.end_time = span.end_time
        if span.start_time and span.end_time:
            call.latency_ms = (
                span.end_time.replace(tzinfo=None) - span.start_time.replace(tzinfo=None)
            ).total_seconds() * 1000

        # Error
        if normalized.error_message:
            call.level = "ERROR"
            call.status_message = normalized.error_message

        # Server-side cost calculation (SPEC-129 Track 6 parity). The legacy
        # ingestion path calls calculate_cost_for_model on every call; the
        # canonical projector must too, or projected rows lose cost data.
        _apply_cost(session, call, span)

        session.add(call)

    def _extract_messages(self, normalized: NormalizedSpan) -> list[dict[str, Any]]:
        """Extract messages from normalized input/output for the ``messages`` column.

        The dashboard's ``detectChatML`` checks ``data.messages`` on both
        ``call.input`` and ``call.output``, but the ``messages`` column is
        also read by some query paths. Populate it from whichever normalized
        field has a messages array.

        Only GENERATION calls get messages — SPAN/AGENT lifecycle calls carry
        adapter metadata (not real conversation turns), and TOOL calls carry
        parameters/results (not messages). Showing fake messages for those
        types clutters the trace with empty/misleading content.
        """
        if normalized.observation_type != "GENERATION":
            return []
        msgs: list[dict[str, Any]] = []
        if normalized.input and isinstance(normalized.input.get("messages"), list):
            msgs.extend(normalized.input["messages"])
        if normalized.output and isinstance(normalized.output.get("messages"), list):
            msgs.extend(normalized.output["messages"])
        return msgs


# ---------------------------------------------------------------------------
# Tenant-safe projection lookups + authenticated claim (SPEC-131 M3/M4)
#
# These are module-level helpers so the receiver/projector boundary stays
# thin and the tenant invariant lives in one place. Every derived-row lookup
# is scoped by (id, project_id) so a deliberately duplicated OTel ID can never
# load or mutate another project's projection.
# ---------------------------------------------------------------------------


def _claim_task_run(
    session: Session,
    span: OtlpSpanDB,
    task_run_id: str,
    context: TraceIngestionContext | None,
) -> bool:
    """Link a trace to its task run, subject- and project-bound (SPEC-131 M3).

    Rules:
      - Only an authenticated service token may claim
        (``context.may_claim_task_run``).
      - The claimed ``task_run_id`` must exactly match the token subject
        (``context.service_task_run_id``).
      - The task run must belong to the authenticated project (via its batch
        run) — verified before the claim.
      - The single canonical atomic claim from
        :mod:`apo.services.trace_ownership` is used; no duplicate logic.
      - Same-token, same-trace retries are idempotent.

    The claim flushes but does NOT commit — the receiver owns the transaction
    boundary. Returns True if linked (newly claimed or already owned), False if
    rejected.
    """
    from .trace_ownership import authorize_and_claim_trace

    return authorize_and_claim_trace(
        session,
        context=context,
        task_run_id=task_run_id,
        trace_id=span.trace_id,
    )


# ---------------------------------------------------------------------------
# Canonical-path feature parity (SPEC-129 Track 6)
#
# Cost calculation, score routing, aggregate metrics, and live SSE
# broadcasting — the capabilities the legacy ingestion path provided that the
# projector must gain before legacy code can be removed.
# ---------------------------------------------------------------------------


def _is_truthy(value: object) -> bool:
    """OTel attributes are stringly-typed; interpret 'true'/True/1 as truthy."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return False


def _raw_attr(span: OtlpSpanDB, key: str) -> dict[str, Any] | None:
    """Read a free-form dict attribute (e.g. legacy ``input``/``output``).

    The normalizer only understands ``gen_ai.*`` convention attributes. Legacy
    adapter spans carry raw ``input``/``output`` dicts that need to pass through
    to the projection when the normalizer has no mapping for them.
    """
    attrs = span.attributes or {}
    value = attrs.get(key)
    if isinstance(value, dict):
        return value
    return None


def _apply_cost(session: Session, call: LoggedCallDB, span: OtlpSpanDB) -> None:
    """Compute and store server-side cost for a projected call.

    Mirrors ``process_call_create`` / ``process_call_update`` in the legacy
    ingestion path (SPEC-129 Track 6 parity). If no model definition matches,
    cost is left unset (the legacy path behaves identically).

    Only GENERATION calls get cost — child spans like ``ai.generateText.doGenerate``
    carry per-step token data but are not separate billable API calls. Computing
    cost for them would double-count against the parent ``ai.generateText`` span.
    """
    if not call.model or call.observation_type != "GENERATION":
        return
    try:
        from .cost_calculation import calculate_cost_for_model

        calculated = calculate_cost_for_model(
            session,
            call.model,
            call.prompt_tokens,
            call.completion_tokens,
            project=span.project_id,
        )
        if calculated is not None:
            call.calculated_cost = calculated
            if call.cost is None:
                call.cost = calculated
    except Exception:
        logger.debug("Cost calculation failed for model %s", call.model, exc_info=True)


def _compute_run_aggregates(session: Session, trace_id: str, project: str) -> None:
    """Compute total_cost / avg_latency / total_tokens for a completed run.

    Mirrors the legacy ``completeRun`` → aggregate-metrics path. Removes any
    prior aggregate rows first so re-projection is idempotent.

    Also backfills ``run.call_count`` and ``run.primary_model`` from the
    projected calls, so the traces list shows real values instead of the
    ``0`` / ``NULL`` defaults.
    """
    from sqlmodel import delete

    # Clear stale aggregate rows (idempotent re-projection).
    session.exec(
        delete(RunMetricDB).where(
            col(RunMetricDB.run_id) == trace_id,
            col(RunMetricDB.project) == project,
            col(RunMetricDB.metric_type) == "aggregate",
        )
    )

    from ..metrics.aggregate import calculate_and_store_aggregate_metrics

    for metric in calculate_and_store_aggregate_metrics(session, trace_id, project):
        session.add(metric)

    # Backfill call_count and primary_model from the projected calls.
    run = select_run(session, trace_id, project)
    if run is not None:
        calls = session.exec(
            select(LoggedCallDB).where(
                col(LoggedCallDB.run_id) == trace_id,
                col(LoggedCallDB.project) == project,
            )
        ).all()
        run.call_count = len(calls)
        if not run.primary_model:
            gen = next((c for c in calls if c.model), None)
            if gen:
                run.primary_model = gen.model
        session.add(run)


def _broadcast_projection(
    session: Session,
    span: OtlpSpanDB,
    normalized: NormalizedSpan,
    is_root: bool,
    is_new_call: bool,
    run_existed: bool,
) -> None:
    """Fire SSE broadcast events for a projected span (best-effort, never raises).

    The projector is sync but runs inside an async caller (the QueueWorker /
    the route's background task). All data needed by the broadcast is captured
    *synchronously* here (before the session closes) so the async task never
    touches detached ORM objects. Schedule the async broadcast on the running
    loop if there is one; otherwise skip — the next SSE reconnect replays from
    the DB. This matches the legacy ingestion path's best-effort broadcast.
    """
    try:
        import asyncio

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return  # No running loop (sync test context) — replay covers it.

        from .trace_broadcaster import get_trace_broadcaster

        # Capture everything synchronously — the ORM objects will be detached
        # by the time the async task runs.
        trace_id = span.trace_id
        has_end_time = span.end_time is not None
        body = _call_sse_body(span, normalized)

        async def _fire() -> None:
            broadcaster = await get_trace_broadcaster()
            if is_root and not run_existed:
                await broadcaster.broadcast_trace_created(trace_id, {"id": trace_id})
            if is_root and has_end_time:
                await broadcaster.broadcast_trace_completed(trace_id, {"id": trace_id})
            if not is_root:
                if is_new_call:
                    await broadcaster.broadcast_span_created(trace_id, body)
                else:
                    await broadcaster.broadcast_span_updated(trace_id, body)

        loop.create_task(_fire())
    except Exception:
        logger.debug("SSE broadcast failed for span %s", span.span_id, exc_info=True)


def _call_sse_body(span: OtlpSpanDB, normalized: NormalizedSpan) -> dict[str, object]:
    """Build the SSE span body matching the dashboard's TraceSSEData schema."""
    body: dict[str, object] = {
        "id": span.span_id,
        "parent_call_id": span.parent_span_id,
        "observation_type": normalized.observation_type,
        "step_name": normalized.display_name,
        "model": normalized.model or "unknown",
    }
    if span.start_time:
        body["created_at"] = span.start_time.isoformat()
    if span.end_time:
        body["end_time"] = span.end_time.isoformat()
    if normalized.token_usage:
        prompt = normalized.token_usage.get("prompt")
        completion = normalized.token_usage.get("completion")
        if prompt is not None:
            body["prompt_tokens"] = int(prompt)
        if completion is not None:
            body["completion_tokens"] = int(completion)
    if normalized.tool_name:
        body["tool_name"] = normalized.tool_name
    if normalized.error_message:
        body["level"] = "ERROR"
        body["status_message"] = normalized.error_message
    return body
