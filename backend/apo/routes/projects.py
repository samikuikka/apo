"""Project management API endpoints.

Includes the project task source model: each project owns an
explicit task source row that drives task inventory, replacing the
previous process-global fallback to ``apps/example-service/e2e``.

Includes the project-scoped agent-task routes: canonical list
and detail endpoints read from persisted inventory instead of doing a
live filesystem scan on every request.
"""

# pyright: reportAny=false, reportCallInDefaultInitializer=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnusedCallResult=false

from collections.abc import Sequence
from typing import cast
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from sqlalchemy import ColumnElement, desc, func
from sqlmodel import Session, select

from ..auth import verify_password
from ..auth.rate_limit import LoginRateLimiter
from ..db import get_session
from ..models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    UserDB,
)
from ..models.schemas import (
    AgentTaskDetail,
    AgentTaskRunStats,
    AgentTaskRunSummary,
    AgentTaskSummary,
    ApiKeyCreateResponse,
    ProjectBootstrapRequest,
    ProjectDetail,
    ProjectSummary,
    RunConfigModelFacet,
    UpdateProjectRequest,
)
from ..auth.client_ip import get_client_ip
from ..routes.api_keys import mint_legacy_key
from ..services.agent_task_stats import (
    RunStatFields,
    compute_run_config_facets,
    compute_run_stats,
    load_run_stat_fields,
)
from ..services.project_deletion import delete_project_data
from ..services.project_memberships import (
    DEMO_PROJECT_ID,
    ProjectRole,
    compute_permissions,
    create_owner_membership,
    enforce_project_read_from_request,
    enforce_project_role_from_request,
    get_project_membership,
    readable_project_ids_for_request,
)
from ..db_helpers import as_column
from ..services.runtime_config import get_runtime_config
from ..services.project_task_inventory import (
    get_inventory_row,
    list_inventory_for_project,
    to_detail,
    to_summary,
)
from ..services.project_task_sources import (
    get_task_source_db,
    serialize as serialize_task_source,
)

router = APIRouter(prefix="/v1/projects", tags=["projects"])

# Separate from the api-keys bootstrap limiter so tests reset them independently
# and one path's traffic doesn't consume the other's budget.
_projects_bootstrap_rate_limiter = LoginRateLimiter(max_attempts=5, window_seconds=60)


def _get_user_id(request: Request) -> str:
    user_id = getattr(request.state, "user_id", None)
    if user_id:
        return str(user_id)
    raise HTTPException(status_code=401, detail="Authentication required")


def create_project_for_owner(
    session: Session,
    *,
    name: str,
    user_id: str,
) -> ProjectDB:
    """Insert a ``ProjectDB`` row with a random 12-hex id and grant the caller
    an ``owner`` membership. Shared by ``POST /v1/projects`` (authenticated
    create) and ``POST /v1/projects/bootstrap`` (first-project create)."""
    project = ProjectDB(
        id=uuid4().hex[:12],
        name=name,
        created_by=user_id,
    )
    session.add(project)
    session.commit()
    session.refresh(project)
    _ = create_owner_membership(session, project.id, user_id)
    from ..services.bundled_executor import (
        bundled_executor_enabled,
        ensure_bundled_pool,
    )

    if bundled_executor_enabled():
        _ = ensure_bundled_pool(session, project_id=project.id)
    return project


def _format_project_summary(
    p: ProjectDB, current_user_role: str | None = None
) -> ProjectSummary:
    from apo.services.retention import effective_evidence_days

    return ProjectSummary(
        id=p.id,
        name=p.name,
        created_by=p.created_by,
        created_at=p.created_at,
        current_user_role=current_user_role,
        evidence_retention_days=p.evidence_retention_days,
        effective_evidence_retention_days=effective_evidence_days(
            p.evidence_retention_days
        ),
    )


def _format_project_detail(
    session: Session,
    p: ProjectDB,
    task_source: ProjectTaskSourceDB | None,
    *,
    current_user_role: str | None = None,
) -> ProjectDetail:
    from apo.services.retention import effective_evidence_days

    return ProjectDetail(
        id=p.id,
        name=p.name,
        created_by=p.created_by,
        created_at=p.created_at,
        current_user_role=current_user_role,
        evidence_retention_days=p.evidence_retention_days,
        effective_evidence_retention_days=effective_evidence_days(
            p.evidence_retention_days
        ),
        permissions=compute_permissions(current_user_role),
        task_source=serialize_task_source(task_source, session=session),
    )


def _load_project_for_request(
    session: Session, project_id: str, request: Request
) -> tuple[ProjectDB, str | None]:
    """Load a project through the canonical credential-aware read guard.

    The caller's Credential Authority is intersected with
    membership — an API key is limited to its bound Project even when its
    creator is a member elsewhere. The demo project stays world-readable
    (read-only semantics are enforced by the mutation endpoints); returns
    the project and the caller's current role (``None`` for demo).
    """
    project = session.get(ProjectDB, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project_id == DEMO_PROJECT_ID:
        return project, "viewer"
    membership = enforce_project_read_from_request(request, session, project_id)
    return project, membership.role


def _load_project_with_role(
    session: Session,
    project_id: str,
    request: Request,
    *,
    minimum_role: str,
) -> tuple[ProjectDB, str]:
    """Load a project and enforce a minimum role via the canonical policy.

    The demo project is rejected with 403 because it has no membership
    management; mutations against it are blocked elsewhere by
    ``_assert_not_demo``.
    """
    project = session.get(ProjectDB, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    membership = enforce_project_role_from_request(
        request, session, project_id, minimum_role=cast(ProjectRole, minimum_role)
    )
    return project, membership.role


@router.get("")
async def list_projects(
    request: Request,
    session: Session = Depends(get_session),
):
    """List the caller's readable projects (memberships, or the key's bound
    Project for API-key callers), plus the demo project."""
    # The readable set is credential-derived — a Project-A key
    # lists exactly A, never every project its creator belongs to.
    # ``None`` (open-dev) behaves as before: nothing but demo.
    readable = readable_project_ids_for_request(request, session)
    member_project_ids: set[str] = set(readable) if readable is not None else set()

    statement = (
        select(ProjectDB)
        .where(ProjectDB.id.in_(member_project_ids) | (ProjectDB.id == DEMO_PROJECT_ID))  # pyright: ignore[reportAttributeAccessIssue]
        .order_by(desc(ProjectDB.created_at))  # pyright: ignore[reportArgumentType]
    )
    projects = session.exec(statement).all()

    # For role display: the acting user (session user or key creator).
    # Anonymous demo visitors carry no user_id by design — their readable
    # set is exactly ["demo"], so the per-membership lookup below never
    # runs for them.
    user_id = (
        _get_user_id(request)
        if getattr(request.state, "user_id", None)
        else None
    )
    summaries: list[ProjectSummary] = []
    for p in projects:
        if p.id == DEMO_PROJECT_ID:
            summaries.append(_format_project_summary(p, current_user_role="viewer"))
            continue
        membership = get_project_membership(session, p.id, user_id) if user_id else None
        role = membership.role if membership else None
        summaries.append(_format_project_summary(p, current_user_role=role))
    return summaries


@router.post("", status_code=201)
async def create_project(
    request: Request,
    body: dict[str, object],
    session: Session = Depends(get_session),
):
    """Create a new project. The creator becomes the initial owner."""
    user_id = _get_user_id(request)
    name = body.get("name")
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(status_code=400, detail="name is required")

    project = create_project_for_owner(
        session,
        name=name.strip(),
        user_id=user_id,
    )
    return _format_project_detail(
        session, project, None, current_user_role="owner"
    )


@router.post("/bootstrap", response_model=ApiKeyCreateResponse, status_code=201)
def bootstrap_project(
    body: ProjectBootstrapRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> ApiKeyCreateResponse:
    """Create the first project on a fresh instance from email + password.

    Solves the chicken-and-egg between ``apo login`` (which needs a project to
    scope a key to) and ``POST /v1/projects`` (which needs an authenticated
    key). This endpoint verifies the password directly, creates the project +
    an owner membership, then mints a legacy ``sk-…`` API key scoped to the
    new project — all in one call.

    A real ``ProjectDB`` row is committed before the key is minted. The
    endpoint is public (no Authorization header) — it authenticates
    via email + password, exactly like ``POST /v1/api-keys/bootstrap``.

    Rate-limited (5/min/IP) independently from the api-keys bootstrap path.
    """
    ip = get_client_ip(request)
    if not _projects_bootstrap_rate_limiter.is_allowed(ip):
        retry_after = _projects_bootstrap_rate_limiter.get_retry_after(ip)
        raise HTTPException(
            status_code=429,
            detail="Too many login attempts",
            headers={"Retry-After": str(retry_after)},
        )
    _projects_bootstrap_rate_limiter.record_attempt(ip)

    user = session.exec(select(UserDB).where(UserDB.email == body.email)).first()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    # The id-based demo guard can't catch this (ids are random 12-hex), so
    # reject the reserved name explicitly, case-insensitively.
    if name.lower() == DEMO_PROJECT_ID:
        raise HTTPException(
            status_code=400,
            detail="'demo' is a reserved project name",
        )

    project = create_project_for_owner(
        session,
        name=name,
        user_id=user.id,
    )

    # A real ProjectDB row now exists, so the key is scoped to a legitimate
    # project — no legacy-project fallback is involved.
    api_key, full_key = mint_legacy_key(
        session,
        name=body.key_name,
        project=project.id,
        user_id=user.id,
        scope=body.scope,
    )

    return ApiKeyCreateResponse(
        id=api_key.id,
        name=api_key.name,
        prefix=api_key.prefix,
        project=api_key.project,
        created_by=api_key.created_by,
        scope=api_key.scope,
        created_at=api_key.created_at.isoformat(),
        last_used_at=api_key.last_used_at.isoformat() if api_key.last_used_at else None,
        expires_at=api_key.expires_at.isoformat() if api_key.expires_at else None,
        key=full_key,
    )


@router.get("/{project_id}")
async def get_project(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> ProjectDetail:
    """Return a single project with its task source nested.

    ``task_source`` is ``null`` for projects that have not yet been
    configured. Project-scoped dashboard pages branch on this to decide
    between setup UI and normal data.
    """
    project, role = _load_project_for_request(session, project_id, request)
    task_source = get_task_source_db(session, project_id)
    return _format_project_detail(
        session, project, task_source, current_user_role=role
    )


@router.patch("/{project_id}")
async def update_project(
    project_id: str,
    body: UpdateProjectRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> ProjectDetail:
    """Update Project settings. Requires an admin or owner membership.

    ``evidence_retention_days`` is tri-state: absent leaves it unchanged,
    ``null`` re-inherits the ``APO_EVIDENCE_RETENTION_DAYS`` default,
    ``0`` keeps this project's evidence forever, and ``N`` (1-3650) expires
    evidence after N days. Verdicts are never deleted automatically.
    """
    _assert_not_demo(project_id)
    project, role = _load_project_with_role(
        session, project_id, request, minimum_role="admin"
    )
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="name cannot be empty")
        project.name = name
    updates = body.model_dump(exclude_unset=True)
    if "evidence_retention_days" in updates:
        days = updates["evidence_retention_days"]
        if days is not None and not (0 <= days <= 3650):
            raise HTTPException(
                status_code=400,
                detail="evidence_retention_days must be null, 0 (forever), or 1-3650 days",
            )
        project.evidence_retention_days = days
    session.add(project)
    session.commit()
    session.refresh(project)
    return _format_project_detail(
        session,
        project,
        get_task_source_db(session, project_id),
        current_user_role=role,
    )


@router.delete("/{project_id}")
async def delete_project(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Delete a project and all of its data. Cannot delete the demo project. Owner-only.

    Cascades to every dependent table — memberships, invitations, task source
    + inventory, github connection, traces, task runs, scores, comments, API
    keys, OTLP spans, etc. — so the delete succeeds under
    ``PRAGMA foreign_keys=ON`` (issue #14) and leaves no orphaned rows.
    """
    if project_id == DEMO_PROJECT_ID:
        raise HTTPException(status_code=400, detail="Cannot delete demo project")

    _project, _role = _load_project_with_role(
        session, project_id, request, minimum_role="owner"
    )
    # remove stored objects BEFORE their rows go, while their keys are still
    # resolvable (objects live outside the relational DB).
    from apo.services.retention import delete_deliverable_objects_for_project
    from apo.services.task_revisions import delete_task_revision_bundles_for_project

    await delete_task_revision_bundles_for_project(session, project_id)
    await delete_deliverable_objects_for_project(session, project_id)
    delete_project_data(
        session,
        project_id,
        keep_project=False,
        keep_api_keys=False,
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Task source
# ---------------------------------------------------------------------------


def _assert_not_demo(project_id: str) -> None:
    """Demo task source is seeded, not user-editable."""
    if project_id == DEMO_PROJECT_ID:
        raise HTTPException(
            status_code=403, detail="Demo workspace task source is read-only"
        )


# ---------------------------------------------------------------------------
# Project-scoped agent tasks
# ---------------------------------------------------------------------------
#
# Canonical task list/detail endpoints, reading from the persisted
# inventory table instead of doing a live filesystem scan on every
# request. Run stats are attached by joining ``AgentTaskRunDB`` rows
# through the project's batch runs.


def _compute_run_stats(runs: Sequence[RunStatFields]) -> AgentTaskRunStats:
    """Aggregate a task's runs into a stats summary.

    Thin delegate to the shared ``agent_task_stats`` service so the
    project-scoped and discovery-scoped endpoints share one implementation.
    """
    return compute_run_stats(runs)


def _load_runs_by_task(
    session: Session,
    project_id: str,
    task_ids: list[str],
) -> dict[str, list[RunStatFields]]:
    """Return the minimal run fields stats needs, grouped by task id.

    Delegates to ``load_run_stat_fields`` which projects only the scalar
    columns + ``checks_json`` aggregation reads — never the multi-MB
    ``transcript_json`` / ``deliverables_json`` blobs that OOM-killed the
    backend when the task list loaded full rows.
    """
    return load_run_stat_fields(session, project_id, task_ids)


@router.get(
    "/{project_id}/agent-tasks",
    response_model=list[AgentTaskSummary],
)
async def list_project_agent_tasks(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
    grep: str | None = Query(default=None),
):
    """List the project's tasks from persisted inventory.

    Replaces the legacy ``GET /v1/agent-tasks?project=...`` path for the
    active UI. Returns ``404`` if the project has no task source
    configured yet — the dashboard should branch on the project payload
    and prompt the user to set up a source before calling this route.
    """
    _project, _role = _load_project_for_request(session, project_id, request)

    source = get_task_source_db(session, project_id)
    if source is None:
        raise HTTPException(
            status_code=404,
            detail="Project has no task source configured.",
        )

    # published catalogs are already in inventory; no lazy refresh.
    rows = list_inventory_for_project(session, project_id, grep=grep)
    summaries = [to_summary(row) for row in rows]
    if not summaries:
        return summaries

    runs_by_task = _load_runs_by_task(
        session, project_id, [summary.id for summary in summaries]
    )
    for summary in summaries:
        task_runs = runs_by_task.get(summary.id, [])
        if task_runs:
            summary.run_stats = _compute_run_stats(task_runs)
    return summaries


@router.get(
    "/{project_id}/agent-task-run-stats",
    response_model=dict[str, AgentTaskRunStats],
)
async def list_project_agent_task_run_stats(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
    model: str | None = Query(default=None),
    effort: str | None = Query(default=None),
    since: str | None = Query(default=None),
) -> dict[str, AgentTaskRunStats]:
    """Per-task run stats scoped to a model/effort/date view.

    No filter = Main (all-history, identical to the ``run_stats`` already
    attached by ``GET .../agent-tasks``). With ``model`` / ``effort`` / ``since``
    the cohort is the Tasks page's active evidence view. Returns one entry per
    task in the project inventory; tasks with no matching runs get all-zero stats.
    """
    _project, _role = _load_project_for_request(session, project_id, request)

    rows = list_inventory_for_project(session, project_id)
    task_ids = [row.task_id for row in rows]
    if not task_ids:
        return {}

    runs_by_task = load_run_stat_fields(
        session, project_id, task_ids, model=model, effort=effort, since=since
    )
    return {
        task_id: compute_run_stats(runs) for task_id, runs in runs_by_task.items()
    }


@router.get(
    "/{project_id}/agent-task-run-config-facets",
    response_model=list[RunConfigModelFacet],
)
async def list_project_agent_task_run_config_facets(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Distinct (model, effort) run configurations in the project.

    Populates the Tasks page filter dropdowns: the Model list, and — once a
    model is picked — that model's actual effort tiers. Legacy runs with no
    ``configured_model`` are excluded.
    """
    _project, _role = _load_project_for_request(session, project_id, request)
    return compute_run_config_facets(session, project_id)


@router.get("/{project_id}/onboarding-status")
async def get_project_onboarding_status(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Bounded first-run projection for the Tasks page.

    Answers "has this Project published Tasks or recorded Runs" with two
    scalar counts and carries the installation's validated public origin so
    the onboarding panel can build an exact ``apo login`` command. The
    runtime-config endpoint is installation-admin-only, so this member-scoped
    projection is where an invited owner reads ``public_url``. Loads no Run,
    Trace, Check, Deliverable, or Task Definition bodies.
    """
    _project, _role = _load_project_for_request(session, project_id, request)

    published = session.exec(
        select(func.count())
        .select_from(ProjectTaskInventoryDB)
        .where(ProjectTaskInventoryDB.project == project_id)
    ).one()
    _batch_run_id_col: ColumnElement[str] = as_column(
        cast(object, AgentTaskRunDB.batch_run_id)
    )
    _batch_id_col: ColumnElement[str] = as_column(cast(object, AgentTaskBatchRunDB.id))
    recorded = session.exec(
        select(func.count())
        .select_from(AgentTaskRunDB)
        .join(AgentTaskBatchRunDB, _batch_run_id_col == _batch_id_col)
        .where(AgentTaskBatchRunDB.project == project_id)
    ).one()
    raw_public_url = (get_runtime_config().public_url or "").strip()
    valid_public_url: str | None = None
    try:
        parsed = urlparse(raw_public_url)
        if parsed.scheme in ("http", "https") and bool(parsed.netloc):
            valid_public_url = f"{parsed.scheme}://{parsed.netloc}"
    except ValueError:
        valid_public_url = None
    # Service-tracing onboarding signals: the OTLP endpoint and
    # whether an ingest-scope key exists (booleans + URL only — never key
    # material). has_traces distinguishes "no traces yet" from "filters
    # matched nothing" for the traces page's connect-a-service CTA.
    from ..models.db import ApiKeyDB, RunDB

    has_ingest_key = (
        session.exec(
            select(func.count())
            .select_from(ApiKeyDB)
            .where(ApiKeyDB.project == project_id, ApiKeyDB.scope == "ingest")
        ).one()
        > 0
    )
    trace_count = session.exec(
        select(func.count()).select_from(RunDB).where(RunDB.project == project_id)
    ).one()
    return {
        "published_task_count": int(published),
        "recorded_run_count": int(recorded),
        "public_url": valid_public_url,
        "otel_endpoint": (
            f"{valid_public_url}/api/public/otel/v1/traces"
            if valid_public_url
            else None
        ),
        "has_ingest_key": bool(has_ingest_key),
        "has_traces": int(trace_count) > 0,
    }


@router.get(
    "/{project_id}/agent-tasks/{task_id:path}",
    response_model=AgentTaskDetail,
)
async def get_project_agent_task(
    project_id: str,
    task_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Return a single task from the project's inventory.

    Enriches the row with the latest run (if any) scoped to the project.
    Use this in place of ``GET /v1/agent-tasks/{task_id}?project=...``
    for the canonical project-scoped path.
    """
    _project, _role = _load_project_for_request(session, project_id, request)

    source = get_task_source_db(session, project_id)
    if source is None:
        raise HTTPException(
            status_code=404,
            detail="Project has no task source configured.",
        )

    row = get_inventory_row(session, project_id, task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Task not found in inventory.")

    detail = to_detail(row)
    runs = _load_runs_by_task(session, project_id, [task_id]).get(task_id, [])
    if runs:
        detail.run_stats = _compute_run_stats(runs)
    return detail


# Re-export ``AgentTaskRunSummary`` so type checkers and documentation
# tools see it as part of this module's public surface alongside the
# detail/summary schemas already imported above.
_ = AgentTaskRunSummary


@router.post("/{project_id}/reset-data")
async def reset_project_data(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Delete ALL observation data for a project (traces, calls, runs, schedules, sessions).

    The project itself and its API keys are kept — useful for debugging when
    you want to clear everything and start fresh without re-issuing
    credentials. Shares the cascade logic with ``delete_project`` (issue #14)
    so the two endpoints can't drift as new tables land.
    """
    if project_id == DEMO_PROJECT_ID:
        raise HTTPException(status_code=400, detail="Cannot reset demo project")

    _project, _role = _load_project_with_role(
        session, project_id, request, minimum_role="owner"
    )
    # remove stored objects BEFORE their rows go.
    from apo.services.retention import delete_deliverable_objects_for_project
    from apo.services.task_revisions import delete_task_revision_bundles_for_project

    await delete_task_revision_bundles_for_project(session, project_id)
    await delete_deliverable_objects_for_project(session, project_id)

    deleted_counts = delete_project_data(
        session,
        project_id,
        keep_project=True,
        keep_api_keys=True,
    )
    return {"ok": True, "deleted": deleted_counts}


# ============================================================================
# Task Catalog
# ============================================================================


@router.get("/{project_id}/task-catalog")
def get_task_catalog(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Return the project's task catalog status, or null if unpublished."""
    from ..services.project_memberships import enforce_project_role_from_request
    from ..services.task_catalog import get_catalog_status

    # Member read — the catalog is Project-owned inventory.
    enforce_project_role_from_request(
        request, session, project_id, minimum_role="viewer"
    )
    return get_catalog_status(session, project_id)


@router.put("/{project_id}/task-catalog")
async def publish_task_catalog(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Replace the project's task catalog with a new publication."""
    from ..services.project_memberships import enforce_project_role_from_request
    from ..services.task_catalog import publish_catalog, validate_catalog_request

    # Publication is an admin operation on Project-owned inventory.
    enforce_project_role_from_request(
        request, session, project_id, minimum_role="admin"
    )

    body = await request.json()
    tasks = body.get("tasks", [])

    try:
        normalized = validate_catalog_request(tasks)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    user_id = getattr(request.state, "user_id", None)
    return publish_catalog(session, project_id, normalized, user_id=user_id)
