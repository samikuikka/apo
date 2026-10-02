# pyright: reportAny=false, reportExplicitAny=false, reportArgumentType=false, reportCallInDefaultInitializer=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Batch-run listing: filtering, model facets, pagination, and hydration.

Extracted from ``GET /v1/agent-task-batch-runs`` so the facet
computation, multi-query hydration, and configuration assembly are
exercisable without going through FastAPI/HTTP. The route handler
parses query params and delegates; everything from the base
``select(AgentTaskBatchRunDB)`` onward lives here.
"""

from dataclasses import dataclass, field

from pydantic import BaseModel
from sqlalchemy import and_, desc, func, or_
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
from ..services.agent_task_projection import (
    child_task_ids,
    group_batch_configuration_summaries,
    to_batch_run_summary,
)
from ..services.archived_models import load_archived_models
from ..services.trace_backend import parse_model_providers, provider_labels
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
    statuses: list[str] = field(default_factory=list)
    search: str | None = None
    since: str | None = None
    models: list[str] = field(default_factory=list)
    efforts: list[str] = field(default_factory=list)
    # Observed serving hosts (provider or route; issue #307).
    providers: list[str] = field(default_factory=list)


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
    model_facets = _compute_model_facets(session, base, _single_project(filters))
    provider_facets = _compute_provider_facets(session, base)
    filtered = _apply_config_filters(base, filters.models, filters.efforts)
    filtered = _apply_provider_filter(filtered, filters.providers)

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
    if filters.statuses:
        base = base.where(col(AgentTaskBatchRunDB.status).in_(filters.statuses))
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
    task_ids_by_batch = {
        bid: child_task_ids([tr for tr in all_task_runs if tr.batch_run_id == bid])
        for bid in batch_ids
    }

    return [
        to_batch_run_summary(
            br,
            cost_by_batch.get(br.id),
            tokens_by_batch.get(br.id),
            unpriced_call_count=unpriced_by_batch.get(br.id, 0),
            configuration=configuration_by_batch.get(br.id),
            derived_task_ids=task_ids_by_batch.get(br.id, ()),
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
        )
        for br in batches
    ]
