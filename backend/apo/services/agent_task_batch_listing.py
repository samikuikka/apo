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
from sqlalchemy import desc, func, or_
from sqlmodel import Session, col, select
from sqlmodel.sql.expression import SelectOfScalar

from ..models import (
    AgentTaskBatchRunDB,
    AgentTaskBatchRunSummary,
    AgentTaskRunDB,
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
from ..services.view_runs import since_cutoff


class EffortFacetOption(BaseModel):
    effort: str
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


@dataclass
class BatchRunListFilters:
    project: str | None = None
    project_ids: list[str] | None = None  # readable-Project scope
    statuses: list[str] = field(default_factory=list)
    search: str | None = None
    since: str | None = None
    models: list[str] = field(default_factory=list)
    efforts: list[str] = field(default_factory=list)


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
    filtered = _apply_config_filters(base, filters.models, filters.efforts)

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
        )
        for br in batches
    ]
