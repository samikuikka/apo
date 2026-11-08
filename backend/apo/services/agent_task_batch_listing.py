# pyright: reportAny=false, reportExplicitAny=false, reportArgumentType=false, reportCallInDefaultInitializer=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Batch-run listing: filtering, model facets, pagination, and hydration.

Extracted from ``GET /v1/agent-task-batch-runs`` so the facet
computation, multi-query hydration, and configuration assembly are
exercisable without going through FastAPI/HTTP. The route handler
parses query params and delegates; everything from the base
``select(AgentTaskBatchRunDB)`` onward lives here.
"""

from collections.abc import Sequence
from typing import cast
from dataclasses import dataclass, field
from datetime import datetime

from pydantic import BaseModel
from sqlalchemy import and_, desc, func, or_
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session, col, select
from sqlmodel.sql.expression import SelectOfScalar

from ..models import (
    AgentTaskBatchRunDB,
    AgentTaskBatchRunSummary,
    AgentTaskRunDB,
    LoggedCallDB,
)
from ..models.columns import (
    AGENT_TASK_BATCH_CREATED_AT_COL,
    TASK_RUN_LIGHT,
)
from ..db import is_sqlite
from ..models.serving import ServingFilter, ServingSummary
from ..services.agent_task_projection import (
    child_task_ids,
    group_batch_configuration_summaries,
    to_batch_run_summary,
)
from ..services.archived_models import load_archived_models
from ..services.human_actor import user_labels
from ..services.serving import (
    has_serving_evidence,
    load_call_rows,
    run_matches_filter,
    summarize_calls,
)
from ..services.trace_backend import parse_model_providers, provider_labels
from ..services.run_labels import batch_scope_conditions
from ..services.view_runs import since_cutoff


class EffortFacetOption(BaseModel):
    effort: str
    count: int


class ProviderFacetOption(BaseModel):
    """A serving-host label (route wins over provider; issue #307) and how
    many task runs in the listing's scope used it."""

    label: str
    count: int


class ModelFacetOption(BaseModel):
    model: str
    count: int
    efforts: list[EffortFacetOption] = []
    # Retired from the dropdown by a project member. Archived models are still
    # returned so the client can reveal them to un-archive, and so a model the
    # active filter selects never vanishes from the menu.
    archived: bool = False


class PaginatedBatchRunSummary(BaseModel):
    data: list[AgentTaskBatchRunSummary]
    total_count: int
    page: int
    page_size: int
    total_pages: int
    model_facets: list[ModelFacetOption] = []
    provider_facets: list[ProviderFacetOption] = []


@dataclass
class BatchRunListFilters:
    project: str | None = None
    project_ids: list[str] | None = None  # readable-Project scope
    # Short-id resolution: a prefix match that skips the facets.
    id_prefix: str | None = None
    statuses: list[str] = field(default_factory=list)
    search: str | None = None
    since: str | None = None
    models: list[str] = field(default_factory=list)
    efforts: list[str] = field(default_factory=list)
    # Observed serving hosts (provider or route; issue #307).
    providers: list[str] = field(default_factory=list)
    # Full same-request serving filter (issue #307). When set it replaces
    # the legacy provider/route host filter: provider values are folded
    # into its providers dimension so one coherent predicate applies.
    serving_filter: ServingFilter | None = None
    environments: list[str] = field(default_factory=list)
    # ``run_metadata.labels`` ids per key: OR within a key, AND across keys.
    labels: dict[str, list[str]] = field(default_factory=dict)
    # Rolled-up cost in dollars: sum of the batch's child-run costs.
    cost_min: float | None = None
    cost_max: float | None = None
    # Wall-clock duration in seconds (completed_at - started_at); batches
    # without both timestamps never match a duration filter.
    duration_min_s: float | None = None
    duration_max_s: float | None = None


@dataclass
class BatchRunListPagination:
    page: int
    page_size: int

    @property
    def offset(self) -> int:
        return self.page * self.page_size


def list_batch_run_summaries(
    session: Session,
    filters: BatchRunListFilters,
    pagination: BatchRunListPagination,
) -> PaginatedBatchRunSummary:
    """List batch runs with server-side filtering, model facets, and hydration.

    Configuration filters (model/effort) AND: a batch matches only when
    one child task run satisfies all supplied dimensions. Model facets
    are computed from the text/status/project-filtered set (before
    model/effort filtering) so the dropdown is stable.
    """
    base = _apply_base_filters(select(AgentTaskBatchRunDB), filters)
    if filters.id_prefix:
        model_facets: list[ModelFacetOption] = []
        provider_facets: list[ProviderFacetOption] = []
    else:
        model_facets = _compute_model_facets(session, base, _single_project(filters))
        provider_facets = _compute_provider_facets(session, base)
    filtered = _apply_config_filters(base, filters.models, filters.efforts)
    if filters.serving_filter is not None:
        filtered = _apply_serving_filter(session, filtered, filters.serving_filter)
    else:
        filtered = _apply_provider_filter(filtered, filters.providers)
    filtered = _apply_metric_filters(filtered, filters)

    total_count = session.exec(
        select(func.count()).select_from(filtered.subquery())
    ).one()
    total_pages = (
        (total_count + pagination.page_size - 1) // pagination.page_size
        if total_count > 0
        else 0
    )

    batches = session.exec(
        filtered.order_by(desc(AGENT_TASK_BATCH_CREATED_AT_COL)).offset(
            pagination.offset
        ).limit(pagination.page_size)
    ).all()

    summaries = _hydrate_batch_summaries(session, batches)
    return PaginatedBatchRunSummary(
        data=summaries,
        total_count=total_count,
        page=pagination.page,
        page_size=pagination.page_size,
        total_pages=total_pages,
        model_facets=model_facets,
        provider_facets=provider_facets,
    )


# ---------------------------------------------------------------------------
# Filter building
# ---------------------------------------------------------------------------


def _single_project(filters: BatchRunListFilters) -> str | None:
    """The one project this listing is scoped to, if it is scoped to one.

    Archived-model choices belong to a project, so they only apply when the
    listing shows a single one. The dashboard always scopes; the unscoped
    readable-projects listing gets no archived flags.
    """
    if filters.project:
        return filters.project
    if filters.project_ids is not None and len(filters.project_ids) == 1:
        return filters.project_ids[0]
    return None


def _apply_base_filters(
    base: SelectOfScalar[AgentTaskBatchRunDB], filters: BatchRunListFilters
) -> SelectOfScalar[AgentTaskBatchRunDB]:
    if filters.project_ids is not None:
        base = base.where(col(AgentTaskBatchRunDB.project).in_(filters.project_ids))
    elif filters.project:
        base = base.where(AgentTaskBatchRunDB.project == filters.project)
    if filters.id_prefix:
        base = base.where(
            col(AgentTaskBatchRunDB.id).startswith(filters.id_prefix, autoescape=True)
        )
    if filters.statuses:
        base = base.where(col(AgentTaskBatchRunDB.status).in_(filters.statuses))
    scope = batch_scope_conditions(filters.environments, filters.labels)
    if scope:
        base = base.where(*scope)
    # Same ``Nh``/``Nd`` vocabulary the evidence-view cohort uses, so a date
    # window carried over from the Tasks page filters here instead of being
    # silently dropped (a fixed preset table read "5d" as all-time).
    cutoff = since_cutoff(filters.since)
    if cutoff is not None:
        base = base.where(col(AgentTaskBatchRunDB.created_at) >= cutoff)
    if filters.search:
        pattern = f"%{filters.search}%"
        base = base.where(
            or_(
                col(AgentTaskBatchRunDB.id).ilike(pattern),
                col(AgentTaskBatchRunDB.selection_type).ilike(pattern),
                col(AgentTaskBatchRunDB.environment).ilike(pattern),
                col(AgentTaskBatchRunDB.grep).ilike(pattern),
            )
        )
    return base


def _apply_config_filters(
    base: SelectOfScalar[AgentTaskBatchRunDB],
    models: list[str],
    efforts: list[str],
) -> SelectOfScalar[AgentTaskBatchRunDB]:
    if not models and not efforts:
        return base
    matching = select(AgentTaskRunDB.batch_run_id)
    if models:
        matching = matching.where(col(AgentTaskRunDB.configured_model).in_(models))
    if efforts:
        matching = matching.where(col(AgentTaskRunDB.configured_effort).in_(efforts))
    return base.where(col(AgentTaskBatchRunDB.id).in_(matching))


def _apply_metric_filters(
    base: SelectOfScalar[AgentTaskBatchRunDB],
    filters: BatchRunListFilters,
) -> SelectOfScalar[AgentTaskBatchRunDB]:
    """Range filters over stored run metrics.

    Cost is the batch's child-run sum (the rollup the page shows), so the
    filter subquery aggregates the same way the hydration does. Duration is
    the wall-clock span of the batch itself; a batch that never started or
    never completed has no duration and never matches a duration filter.
    """
    started = col(AgentTaskBatchRunDB.started_at)
    completed = col(AgentTaskBatchRunDB.completed_at)
    # `is not None`, not truthiness: a 0-second or $0 bound is a real filter.
    if filters.duration_min_s is not None or filters.duration_max_s is not None:
        base = base.where(started.is_not(None), completed.is_not(None))
        if filters.duration_min_s is not None:
            base = base.where(_duration_seconds(completed, started) >= filters.duration_min_s)
        if filters.duration_max_s is not None:
            base = base.where(_duration_seconds(completed, started) <= filters.duration_max_s)
    if filters.cost_min is not None or filters.cost_max is not None:
        child_cost = (
            select(
                col(AgentTaskRunDB.batch_run_id).label("batch_run_id"),
                func.sum(func.coalesce(col(AgentTaskRunDB.total_cost), 0.0)).label("cost"),
            )
            .group_by(col(AgentTaskRunDB.batch_run_id))
            .subquery()
        )
        cost_col = col(child_cost.c.cost)
        base = base.where(
            col(AgentTaskBatchRunDB.id) == col(child_cost.c.batch_run_id),
        )
        if filters.cost_min is not None:
            base = base.where(cost_col >= filters.cost_min)
        if filters.cost_max is not None:
            base = base.where(cost_col <= filters.cost_max)
    return base


def _duration_seconds(
    completed: ColumnElement[datetime],
    started: ColumnElement[datetime],
) -> ColumnElement[float]:
    """completed - started in seconds, on either dialect: SQLite stores the
    UTCDateTime column as an ISO string, so julianday() carries the math;
    Postgres subtracts timestamptz into an interval extractable to epoch.
    """
    if is_sqlite():
        return (func.julianday(completed) - func.julianday(started)) * 86400.0
    return cast(
        ColumnElement[float],
        func.extract("epoch", completed - started),
    )


def _apply_serving_filter(
    session: Session,
    base: SelectOfScalar[AgentTaskBatchRunDB],
    serving_filter: ServingFilter,
) -> SelectOfScalar[AgentTaskBatchRunDB]:
    """Keep batches containing at least one child Task Run that satisfies
    the same-request serving filter (issue #307).

    The predicate needs each child's call rows, so it cannot live in SQL:
    candidate batches come from the existing filtered query, then one
    batched call-row query per project narrows them. ``only`` mode applies
    to each child's complete request set, never to the batch's unfiltered
    union of children.
    """
    candidate_ids = base.with_only_columns(col(AgentTaskBatchRunDB.id))
    children = session.exec(
        select(
            col(AgentTaskRunDB.batch_run_id),
            col(AgentTaskRunDB.trace_run_id),
            col(AgentTaskBatchRunDB.project),
        )
        .join(
            AgentTaskBatchRunDB,
            col(AgentTaskBatchRunDB.id) == col(AgentTaskRunDB.batch_run_id),
        )
        .where(
            col(AgentTaskRunDB.batch_run_id).in_(candidate_ids),
            col(AgentTaskRunDB.trace_run_id).isnot(None),
        )
    ).all()

    trace_ids_by_project: dict[str, list[str]] = {}
    for _batch_id, trace_run_id, project in children:
        if trace_run_id is not None:
            trace_ids_by_project.setdefault(project, []).append(trace_run_id)
    calls_by_trace: dict[str, list[LoggedCallDB]] = {}
    for project, trace_ids in trace_ids_by_project.items():
        calls_by_trace.update(load_call_rows(session, project=project, run_ids=trace_ids))

    mode = serving_filter.mode
    matching = {
        batch_id
        for batch_id, trace_run_id, _project in children
        if trace_run_id is not None
        and run_matches_filter(calls_by_trace.get(trace_run_id, []), serving_filter, mode)
    }
    return base.where(col(AgentTaskBatchRunDB.id).in_(matching))


def _apply_provider_filter(
    base: SelectOfScalar[AgentTaskBatchRunDB],
    providers: list[str],
) -> SelectOfScalar[AgentTaskBatchRunDB]:
    """Keep batches with a child task run whose trace was served by a
    matching host (provider or route column, case-insensitive; issue #307).

    The trace lookup is project-correlated — trace ids may collide across
    projects, so another project's copy of a trace must not satisfy this
    batch's filter.
    """
    if not providers:
        return base
    values = [v.lower() for v in providers]
    matching = (
        select(col(AgentTaskRunDB.batch_run_id))
        .join(
            LoggedCallDB,
            and_(
                col(LoggedCallDB.run_id) == col(AgentTaskRunDB.trace_run_id),
                col(LoggedCallDB.project) == col(AgentTaskBatchRunDB.project),
            ),
        )
        .where(
            col(AgentTaskRunDB.trace_run_id).isnot(None),
            or_(
                func.lower(col(LoggedCallDB.provider)).in_(values),
                func.lower(col(LoggedCallDB.route)).in_(values),
            ),
        )
        .correlate(AgentTaskBatchRunDB)
    )
    return base.where(col(AgentTaskBatchRunDB.id).in_(matching))


def _compute_provider_facets(
    session: Session,
    base: SelectOfScalar[AgentTaskBatchRunDB],
) -> list[ProviderFacetOption]:
    """Distinct serving-host labels over the base-filtered batches' task runs.

    The label is route-wins — the same projection the traces list and the
    run rows display — so every facet value is one the user can see and
    click. Counts are task runs, the unit the Runs page compares.
    """
    facet_ids = base.with_only_columns(col(AgentTaskBatchRunDB.id))
    label = func.coalesce(
        func.nullif(col(LoggedCallDB.route), ""),
        func.nullif(col(LoggedCallDB.provider), ""),
    )
    stmt = (
        select(label, func.count(func.distinct(AgentTaskRunDB.id)))
        .select_from(AgentTaskRunDB)
        .join(
            AgentTaskBatchRunDB,
            col(AgentTaskBatchRunDB.id) == col(AgentTaskRunDB.batch_run_id),
        )
        .join(
            LoggedCallDB,
            and_(
                col(LoggedCallDB.run_id) == col(AgentTaskRunDB.trace_run_id),
                col(LoggedCallDB.project) == col(AgentTaskBatchRunDB.project),
            ),
        )
        .where(
            col(AgentTaskRunDB.batch_run_id).in_(facet_ids),
            col(AgentTaskRunDB.trace_run_id).isnot(None),
            label.isnot(None),
        )
        .group_by(label)
    )
    rows = session.exec(stmt).all()
    return [
        ProviderFacetOption(label=str(value), count=int(count))
        for value, count in sorted(rows, key=lambda r: (-int(r[1]), str(r[0])))
    ]


# ---------------------------------------------------------------------------
# Model facets
# ---------------------------------------------------------------------------


def _compute_model_facets(
    session: Session,
    base: SelectOfScalar[AgentTaskBatchRunDB],
    project_id: str | None = None,
) -> list[ModelFacetOption]:
    facet_ids = base.with_only_columns(col(AgentTaskBatchRunDB.id))
    facet_stmt = select(
        AgentTaskRunDB.configured_model,
        AgentTaskRunDB.configured_effort,
        func.count(func.distinct(AgentTaskRunDB.batch_run_id)),
    ).where(
        col(AgentTaskRunDB.batch_run_id).in_(facet_ids),
        col(AgentTaskRunDB.configured_model).isnot(None),
    ).group_by(
        AgentTaskRunDB.configured_model,
        AgentTaskRunDB.configured_effort,
    )
    rows = session.exec(facet_stmt).all()
    # Archiving is per project, so a listing spanning several (or all readable)
    # projects has no single palette to hide anything from.
    archived = load_archived_models(session, project_id) if project_id else set()

    by_model: dict[str, dict[str, int]] = {}
    for model, effort, count in rows:
        if not model:
            continue
        by_model.setdefault(model, {})[effort or ""] = count

    return [
        ModelFacetOption(
            model=model,
            count=sum(efforts.values()),
            efforts=[
                EffortFacetOption(effort=e, count=c)
                for e, c in sorted(efforts.items()) if e
            ],
            archived=model in archived,
        )
        for model, efforts in sorted(by_model.items())
    ]


# ---------------------------------------------------------------------------
# Hydration
# ---------------------------------------------------------------------------


def _hydrate_batch_summaries(
    session: Session, batches: list[AgentTaskBatchRunDB]
) -> list[AgentTaskBatchRunSummary]:
    batch_ids = [br.id for br in batches]
    if not batch_ids:
        return []

    all_task_runs = list(session.exec(
        select(AgentTaskRunDB)
        .options(*TASK_RUN_LIGHT)
        .where(col(AgentTaskRunDB.batch_run_id).in_(batch_ids))
    ).all())

    cost_by_batch: dict[str, float] = {}
    tokens_by_batch: dict[str, int] = {}
    unpriced_by_batch: dict[str, int] = {}
    reasoning_by_batch: dict[str, int] = {}
    model_time_by_batch: dict[str, float] = {}
    # Batches with at least one child that reported the reasoning dimension —
    # a batch where every child is unknown stays unknown (None), not 0.
    reasoning_known_by_batch: set[str] = set()
    timed_known_by_batch: set[str] = set()
    for tr in all_task_runs:
        cost_by_batch[tr.batch_run_id] = cost_by_batch.get(tr.batch_run_id, 0.0) + (
            tr.total_cost or 0.0
        )
        tokens_by_batch[tr.batch_run_id] = tokens_by_batch.get(tr.batch_run_id, 0) + (
            tr.total_tokens or 0
        )
        unpriced_by_batch[tr.batch_run_id] = unpriced_by_batch.get(tr.batch_run_id, 0) + (
            tr.unpriced_call_count or 0
        )
        if tr.total_reasoning_tokens is not None:
            reasoning_known_by_batch.add(tr.batch_run_id)
            reasoning_by_batch[tr.batch_run_id] = (
                reasoning_by_batch.get(tr.batch_run_id, 0)
                + tr.total_reasoning_tokens
            )
        if tr.total_model_time_ms is not None:
            timed_known_by_batch.add(tr.batch_run_id)
            model_time_by_batch[tr.batch_run_id] = (
                model_time_by_batch.get(tr.batch_run_id, 0.0)
                + tr.total_model_time_ms
            )
    configuration_by_batch = group_batch_configuration_summaries(all_task_runs)
    # Serving-host label union per batch, from the same hydration pass that
    # already loaded every child — a collapsed list row shows hosts without a
    # per-batch child fetch. Labels are sorted so the payload is deterministic
    # regardless of child row order.
    providers_by_batch: dict[str, list[str]] = {}
    for tr in all_task_runs:
        labels = provider_labels(parse_model_providers(tr.model_providers_json))
        if not labels:
            continue
        merged = providers_by_batch.setdefault(tr.batch_run_id, [])
        for label in labels:
            if label not in merged:
                merged.append(label)
    for labels in providers_by_batch.values():
        labels.sort()
    requester_labels = user_labels(
        session,
        {br.requested_by_user_id for br in batches if br.requested_by_user_id},
    )
    task_ids_by_batch = {
        bid: child_task_ids([tr for tr in all_task_runs if tr.batch_run_id == bid])
        for bid in batch_ids
    }

    serving_by_batch = _batch_serving_summaries(session, batches, all_task_runs)

    return [
        to_batch_run_summary(
            br,
            cost_by_batch.get(br.id),
            tokens_by_batch.get(br.id),
            unpriced_call_count=unpriced_by_batch.get(br.id, 0),
            configuration=configuration_by_batch.get(br.id),
            derived_task_ids=task_ids_by_batch.get(br.id, ()),
            requested_by_label=(
                requester_labels.get(br.requested_by_user_id)
                if br.requested_by_user_id
                else None
            ),
            total_reasoning_tokens=(
                reasoning_by_batch.get(br.id)
                if br.id in reasoning_known_by_batch
                else None
            ),
            total_model_time_ms=(
                model_time_by_batch.get(br.id)
                if br.id in timed_known_by_batch
                else None
            ),
            providers=providers_by_batch.get(br.id, []),
            serving=serving_by_batch.get(br.id),
        )
        for br in batches
    ]


def _batch_serving_summaries(
    session: Session,
    batches: Sequence[AgentTaskBatchRunDB],
    all_task_runs: Sequence[AgentTaskRunDB],
) -> dict[str, ServingSummary]:
    """One bounded serving summary per batch, derived from the children's
    traces in a single call-row query per project (no per-batch N+1).

    The batch summary describes ALL children, matching filter or not;
    ``task_runs_with_evidence`` carries the coverage distinction.
    """
    project_by_batch = {batch.id: batch.project for batch in batches}
    runs_by_batch: dict[str, list[AgentTaskRunDB]] = {}
    trace_ids_by_project: dict[str, list[str]] = {}
    for task_run in all_task_runs:
        runs_by_batch.setdefault(task_run.batch_run_id, []).append(task_run)
        if task_run.trace_run_id is not None:
            project = project_by_batch.get(task_run.batch_run_id)
            if project is not None:
                trace_ids_by_project.setdefault(project, []).append(
                    task_run.trace_run_id
                )

    calls_by_trace: dict[str, list[LoggedCallDB]] = {}
    for project, trace_ids in trace_ids_by_project.items():
        calls_by_trace.update(load_call_rows(session, project=project, run_ids=trace_ids))

    summaries: dict[str, ServingSummary] = {}
    for batch in batches:
        children = runs_by_batch.get(batch.id, [])
        trace_ids = [
            task_run.trace_run_id
            for task_run in children
            if task_run.trace_run_id is not None
        ]
        all_calls = [
            call for trace_id in trace_ids for call in calls_by_trace.get(trace_id, [])
        ]
        with_evidence = sum(
            1
            for trace_id in trace_ids
            if has_serving_evidence(calls_by_trace.get(trace_id, []))
        )
        summaries[batch.id] = summarize_calls(
            all_calls,
            task_runs_total=len(children),
            task_runs_with_evidence=with_evidence,
        )
    return summaries
