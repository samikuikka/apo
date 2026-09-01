"""Trace Projector — bridges canonical OTel spans to product tables.

Takes ``OtlpSpanDB`` rows, normalizes them via the Track 2 normalizer, and
upserts into the existing ``RunDB`` / ``LoggedCallDB`` tables. This is the
bridge that lets the dashboard query the same tables it always has, while the
canonical data lives in the OTel-native ``OtlpSpanDB`` store.

Properties:
  - Tolerates children before parents, roots arriving last, multiple batches.
  - Idempotent: projecting the same span twice doesn't duplicate rows.
  - Root data chosen from actual root spans, not first batch.
  - Dashboard APIs, SSE, and assertion layers read from these tables unchanged.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnnecessaryComparison=false, reportUnusedCallResult=false, reportUnusedParameter=false

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from collections.abc import Sequence
from typing import TYPE_CHECKING

from sqlmodel import Session, col, select

from ..models.db import (
    AgentTaskRunDB,
    LoggedCallDB,
    OtlpSpanDB,
    RunDB,
    RunMetricDB,
)
from ..models.trace_ingestion import TraceIngestionContext
from .otel_normalization import NormalizedSpan, normalize_span
from .projection_io import (
    ResolvedCallIO,
    maybe_update_run_preview,
    projection_write_mode,
    resolve_call_io,
)
from .projection_lookup import (
    select_call,
    select_run,
)

if TYPE_CHECKING:
    from .trace_repository import NativeTraceRepository

logger = logging.getLogger(__name__)


# Module-level singleton — the projector is stateless, so a single instance
# serves all callers.
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
          tables instead of becoming a fake call.
        - Idempotent: re-projecting the same span updates, never duplicates.

        ``context`` gates Task Run claims: only an authenticated service token
        whose subject matches the claimed run may link the trace.
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
        # Stamp the canonical source only after normalization succeeds. Because
        # this mutation shares the caller's transaction with the derived
        # projection writes, a later projection failure rolls back both and the
        # span remains discoverable as stale for a future replay.
        span.projection_version = normalized.mapping_version
        is_root = span.parent_span_id is None

        # Route writes through the TraceRepository boundary.
        from .trace_repository import NativeTraceRepository

        repo = NativeTraceRepository()

        # Detect state transitions BEFORE upsert so we can broadcast the right
        # event type and fire run-completion aggregates.
        existing_call = select_call(session, span.span_id, span.project_id)
        is_new_call = existing_call is None
        run_before = select_run(session, span.trace_id, span.project_id)
        run_existed = run_before is not None

        # Ensure the run exists
        self._upsert_run(session, span, normalized, is_root, context, repo)

        # Upsert the call (applies cost + tokens inside)
        call, io = self._upsert_call(session, span, normalized, repo)

        # A completed root may arrive before its children, and replay updates
        # calls on a run that was already complete. Refresh after every span
        # projected into a completed run so dashboard-facing aggregates cannot
        # lag behind the authoritative call rows.
        run_after = select_run(session, span.trace_id, span.project_id)
        if run_after is not None:
            # dual/slim: maintain the write-time list previews.
            if projection_write_mode() != "fat":
                maybe_update_run_preview(session, run_after, call, io)
            if run_after.completed_at is not None:
                _compute_run_aggregates(session, span.trace_id, span.project_id)

        # Issue #41: re-aggregate the linked Task Run's cost/tokens whenever a
        # span lands for a trace linked to a Task Run. The task runner's single
        # finalize-time aggregation runs against whatever calls existed then;
        # imported traces (e.g. ``traces import langfuse``) deliver costed spans
        # after finalize, so the totals would otherwise stay null forever.
        _refresh_task_run_total(session, span.trace_id, span.project_id)

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
            # surrogate PKs allow two projects to project the
            # same OTel trace ID. No cross-project conflict check needed.
            run = RunDB(
                id=span.trace_id,
                project=span.project_id,
                environment=_resource_environment(span) or "default",
                created_at=span.start_time or datetime.now(timezone.utc),
            )
            session.add(run)
            session.flush()

        # The trace's service for the list column — first service wins;
        # a later span from a different library in the same service keeps
        # the first value (a trace is one service in practice).
        if span.service_name and not run.service_name:
            run.service_name = span.service_name

        # Update run-level fields from the root span
        if is_root:
            attrs = span.attributes or {}
            # prefer canonical apo.trace.* attributes; fall back to
            # legacy apo.run.* for compatibility with older senders.
            # If neither is present, use the root span's own name — it is
            # always set in OTLP and prevents the run from rendering as
            # "Untitled" when the source had no trace-level name.
            flow_name = (
                attrs.get("apo.trace.name")
                or attrs.get("apo.run.flow_name")
                or span.span_name
            )
            if flow_name:
                run.flow_name = str(flow_name)
            if attrs.get("apo.run.task_id"):
                run.task_id = str(attrs["apo.run.task_id"])
            if attrs.get("apo.run.version"):
                run.version = str(attrs["apo.run.version"])
            tags_value = attrs.get("apo.trace.tags")
            if tags_value is None:
                tags_value = attrs.get("apo.run.tags")
            if tags_value:
                try:
                    if isinstance(tags_value, list):
                        run.tags = [str(t) for t in tags_value]
                    else:
                        run.tags = json.loads(str(tags_value))
                except (json.JSONDecodeError, ValueError, TypeError):
                    pass
            metadata_value = attrs.get("apo.trace.metadata")
            if metadata_value is None:
                metadata_value = attrs.get("apo.run.metadata")
            if metadata_value:
                try:
                    if isinstance(metadata_value, dict):
                        run.run_metadata = metadata_value
                    else:
                        parsed = json.loads(str(metadata_value))
                        if isinstance(parsed, dict):
                            run.run_metadata = parsed
                except (json.JSONDecodeError, ValueError, TypeError):
                    pass
            # provenance on imported traces augments run metadata.
            provenance = attrs.get("apo.trace.provenance")
            if isinstance(provenance, dict) and provenance:
                existing = run.run_metadata if isinstance(run.run_metadata, dict) else {}
                merged = dict(existing)
                merged.setdefault("source", provenance.get("source"))
                run.run_metadata = merged
            # Run-level scalar fields propagated through canonical attributes
            if attrs.get("apo.run.user_id"):
                run.user_id = str(attrs["apo.run.user_id"])
            if attrs.get("apo.run.session_id"):
                run.session_id = str(attrs["apo.run.session_id"])
            if attrs.get("apo.run.environment"):
                run.environment = str(attrs["apo.run.environment"])
            elif run.environment in (None, "", "default"):
                # Vanilla OTel SDKs carry the environment on the resource,
                # not as a span attribute — without this fallback every
                # service trace shows environment=default.
                fallback = _resource_environment(span)
                if fallback:
                    run.environment = fallback
            if attrs.get("apo.run.external_id"):
                run.external_id = str(attrs["apo.run.external_id"])

            # a Task Run claim is
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
                        span.end_time.replace(tzinfo=None)
                        - run.created_at.replace(tzinfo=None)
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
    ) -> tuple[LoggedCallDB, ResolvedCallIO]:
        """Upsert a LoggedCallDB row from the normalized span.

        The I/O values come from ``projection_io.resolve_call_io`` — the ONE
        resolver the slim-mode read path also uses, so what is written in
        fat/dual mode is exactly what would be resolved in slim mode; the
        two cannot drift. In slim mode the fat I/O columns stay empty
        (reads resolve from spans; span-less legacy rows serve their stored
        columns as the fallback).
        """
        call = select_call(session, span.span_id, span.project_id)
        io = resolve_call_io(span)
        write_fat = projection_write_mode() in ("fat", "dual")

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
                input=io.input if write_fat else {},
                output=io.output if write_fat else {},
                messages=io.messages if write_fat else [],
            )
            session.add(call)
        else:
            # Update existing (idempotent re-projection). In fat/dual mode a
            # falsy new value preserves the stored one (a re-ingest that
            # stopped extracting I/O); slim mode writes no I/O at all and
            # reads always resolve fresh from the span.
            call.model = normalized.model or call.model
            call.observation_type = normalized.observation_type
            call.step_name = normalized.display_name
            call.parent_call_id = span.parent_span_id
            if write_fat:
                if io.input:
                    call.input = io.input
                if io.output:
                    call.output = io.output
                if io.messages:
                    call.messages = io.messages  # type: ignore[assignment]
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

        # total_tokens.
        if call.prompt_tokens is not None or call.completion_tokens is not None:
            call.total_tokens = (call.prompt_tokens or 0) + (
                call.completion_tokens or 0
            )

        if normalized.tool_name:
            call.tool_name = normalized.tool_name
        if write_fat and normalized.tool_parameters:
            call.tool_parameters = normalized.tool_parameters
        if write_fat and normalized.tool_result:
            call.tool_result = normalized.tool_result

        # Timing
        call.end_time = span.end_time
        if span.start_time and span.end_time:
            call.latency_ms = (
                span.end_time.replace(tzinfo=None)
                - span.start_time.replace(tzinfo=None)
            ).total_seconds() * 1000

        # Error
        if normalized.error_message:
            call.level = "ERROR"
            call.status_message = normalized.error_message

        # Server-side cost calculation. The legacy
        # ingestion path calls calculate_cost_for_model on every call; the
        # canonical projector must too, or projected rows lose cost data.
        _apply_cost(session, call, span)

        session.add(call)
        return call, io


# ---------------------------------------------------------------------------
# Tenant-safe projection lookups + authenticated claim
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
    """Link a trace to its task run, subject- and project-bound.

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
# Canonical-path feature parity
#
# Cost calculation, score routing, aggregate metrics, and live SSE
# broadcasting — the capabilities the legacy ingestion path provided that the
# projector must gain before legacy code can be removed.
# ---------------------------------------------------------------------------


def _resource_environment(span: OtlpSpanDB) -> str | None:
    """environment from the span's resource attributes, guarded.

    ``resource`` is ``dict | None`` and its ``attributes`` member is an
    untyped JSON value — both must be checked before reading keys.
    """
    resource = span.resource or {}
    if not isinstance(resource, dict):
        return None
    resource_attrs = resource.get("attributes")
    if not isinstance(resource_attrs, dict):
        return None
    for key in ("deployment.environment", "service.environment"):
        value = resource_attrs.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _is_truthy(value: object) -> bool:
    """OTel attributes are stringly-typed; interpret 'true'/True/1 as truthy."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return False


def _apply_cost(session: Session, call: LoggedCallDB, span: OtlpSpanDB) -> None:
    """Normalize usage + freeze cost onto a projected call.

    Shared with the legacy ingestion path via ``pricing.apply.apply_cost_to_call``:
    normalize the span's usage to canonical UsageKeys, then either freeze a
    SDK-provided cost verbatim (provenance "provided") or compute the
    per-dimension breakdown (provenance "computed"). After write, frozen.

    Only GENERATION calls get cost — child spans like ``ai.generateText.doGenerate``
    carry per-step token data but are not separate billable API calls. Computing
    cost for them would double-count against the parent ``ai.generateText`` span.

    a finite, non-negative ``apo.observation.cost.amount`` is the
    authoritative reported cost for imported observations. It populates
    ``provided_cost`` and wins over any server-side model-price calculation.
    Currency is recorded in ``call.metadata`` when supplied.
    """
    attrs = span.attributes or {}
    reported = attrs.get("apo.observation.cost.amount")
    if (
        isinstance(reported, (int, float))
        and reported >= 0
        and not (isinstance(reported, bool))
    ):
        # Reports cost in USD; storage uses micro-USD int.
        micro = round(float(reported) * 1_000_000)
        call.provided_cost = micro
        call.cost = micro
        call.cost_provenance = "provided"
        return

    if not call.model or call.observation_type != "GENERATION":
        return
    try:
        from .pricing.apply import apply_cost_to_call

        apply_cost_to_call(
            session,
            call,
            attributes=span.attributes or {},
            project=span.project_id,
            at_time=span.start_time or call.created_at or datetime.now(timezone.utc),
        )
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

    # recompute call_count on every projection (spans arrive
    # asynchronously, so a snapshot from the first pass goes stale), and
    # pick primary_model by cost contribution (the model under test, not
    # whichever judge call happened to arrive first).
    run = select_run(session, trace_id, project)
    if run is not None:
        calls = session.exec(
            select(LoggedCallDB).where(
                col(LoggedCallDB.run_id) == trace_id,
                col(LoggedCallDB.project) == project,
            )
        ).all()
        run.call_count = len(calls)
        run.primary_model = _primary_model_by_cost(calls)
        session.add(run)


def _refresh_task_run_total(session: Session, trace_id: str, project: str) -> None:
    """Re-aggregate the linked Task Run's cost/tokens after a span is projected.

    The task runner calls :meth:`NativeTraceBackend.aggregate_costs` exactly
    once, at finalize. That relies on the trace already being in the database
    (the native SDK's zero-config contract). Imported traces break that
    assumption: costed spans land *after* finalize, so the single aggregation
    runs against an incomplete call set and writes ``total_cost = None`` — which
    then never recomputes (Issue #41).

    This closes the gap by re-running the aggregation whenever a span is
    projected for a trace whose ``RunDB.task_run_id`` is set. It covers every
    projection path (OTLP receiver, legacy adapter, queue replay) because they
    all funnel through :meth:`TraceProjector.project`. No-op when the trace is
    not linked to a Task Run.
    """
    run = select_run(session, trace_id, project)
    if run is None or not run.task_run_id:
        return
    task_run = session.get(AgentTaskRunDB, run.task_run_id)
    if task_run is None:
        return
    from .trace_backend import get_trace_backend

    get_trace_backend(project).aggregate_costs(session, task_run, project)


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
        project = span.project_id
        trace_id = span.trace_id
        has_end_time = span.end_time is not None
        body = _call_sse_body(span, normalized)

        async def _fire() -> None:
            broadcaster = await get_trace_broadcaster()
            if is_root and not run_existed:
                await broadcaster.broadcast_trace_created(project, trace_id, {"id": trace_id})
            if is_root and has_end_time:
                await broadcaster.broadcast_trace_completed(project, trace_id, {"id": trace_id})
            if not is_root:
                if is_new_call:
                    await broadcaster.broadcast_span_created(project, trace_id, body)
                else:
                    await broadcaster.broadcast_span_updated(project, trace_id, body)

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


def _primary_model_by_cost(calls: Sequence[LoggedCallDB]) -> str | None:
    """Pick the model with the highest total cost contribution.

    The model under test (e.g. claude-opus-5) dominates cost, while judge
    calls are negligible. This naturally selects the agent's model rather
    than whichever harness call arrived first.
    Falls back to the first call with a model when no call has cost data.
    """
    if not calls:
        return None
    totals: dict[str, float] = {}
    for c in calls:
        if c.model and c.cost is not None:
            totals[c.model] = totals.get(c.model, 0.0) + c.cost
    if totals:
        return max(totals, key=lambda k: totals[k])  # type: ignore[return-value]
    first_model = next((c for c in calls if c.model), None)
    return first_model.model if first_model else None
