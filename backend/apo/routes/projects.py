"""Project management API endpoints.

Includes the SPEC-118 project task source model: each project owns an
explicit task source row that drives task inventory, replacing the
previous process-global fallback to ``apps/example-service/e2e``.

Includes the SPEC-119 project-scoped agent-task routes: canonical list
and detail endpoints read from persisted inventory instead of doing a
live filesystem scan on every request.
"""

from collections.abc import Sequence
from typing import cast
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from sqlalchemy import desc
from sqlmodel import Session, select

from ..auth import verify_password
from ..auth.rate_limit import LoginRateLimiter
from ..db import get_session
from ..models.db import (
    ProjectDB,
    ProjectTaskSourceDB,
    RunDB,
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
    ProjectTaskSource,
    UpdateProjectRequest,
    UpdateProjectTaskSourceRequest,
)
from ..routes.api_keys import _get_client_ip, mint_legacy_key
from ..services.agent_task_stats import (
    RunStatFields,
    compute_run_stats,
    load_run_stat_fields,
)
from ..services.content_policy import normalize_trace_content_policy
from ..services.project_deletion import delete_project_data
from ..services.project_memberships import (
    DEMO_PROJECT_ID,
    compute_permissions,
    create_owner_membership,
    get_project_membership,
    list_projects_for_user,
    require_project_member,
    require_project_role,
)
from ..services.project_task_inventory import (
    get_inventory_row,
    list_inventory_for_project,
    to_detail,
    to_summary,
)
from ..services.project_task_sources import (
    get_task_source_db,
    serialize as serialize_task_source,
    upsert_task_source,
)
from ..services.project_task_source_sync import (
    GitError,
    SyncError,
    refresh_filesystem_source,
    sync_task_source,
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
    trace_content_policy: str,
    user_id: str,
) -> ProjectDB:
    """Insert a ``ProjectDB`` row with a random 12-hex id and grant the caller
    an ``owner`` membership. Shared by ``POST /v1/projects`` (authenticated
    create) and ``POST /v1/projects/bootstrap`` (first-project create)."""
    project = ProjectDB(
        id=uuid4().hex[:12],
        name=name,
        trace_content_policy=trace_content_policy,
        created_by=user_id,
    )
    session.add(project)
    session.commit()
    session.refresh(project)
    _ = create_owner_membership(session, project.id, user_id)
    return project


def _format_project_summary(
    p: ProjectDB, current_user_role: str | None = None
) -> ProjectSummary:
    return ProjectSummary(
        id=p.id,
        name=p.name,
        trace_content_policy=normalize_trace_content_policy(p.trace_content_policy),
        created_by=p.created_by,
        created_at=p.created_at,
        current_user_role=current_user_role,
    )


def _format_project_detail(
    session: Session,
    p: ProjectDB,
    task_source: ProjectTaskSourceDB | None,
    *,
    current_user_role: str | None = None,
) -> ProjectDetail:
    return ProjectDetail(
        id=p.id,
        name=p.name,
        trace_content_policy=normalize_trace_content_policy(p.trace_content_policy),
        created_by=p.created_by,
        created_at=p.created_at,
        current_user_role=current_user_role,
        permissions=compute_permissions(current_user_role),
        task_source=serialize_task_source(task_source, session=session),
    )


def _load_project_for_user(
    session: Session, project_id: str, user_id: str
) -> tuple[ProjectDB, str | None]:
    """Load a project, applying membership-aware 404/403 semantics.

    The demo project is world-readable (read-only semantics are enforced
    by the mutation endpoints), so it bypasses the membership check.
    Returns the project and the current user's role (``None`` for demo
    or for non-members — though non-members raise 403 before that).
    """
    project = session.get(ProjectDB, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project_id == DEMO_PROJECT_ID:
        return project, None
    membership = get_project_membership(session, project_id, user_id)
    if membership is None:
        raise HTTPException(
            status_code=403, detail="You are not a member of this project"
        )
    return project, membership.role


def _load_project_with_role(
    session: Session,
    project_id: str,
    user_id: str,
    *,
    minimum_role: str,
) -> tuple[ProjectDB, str]:
    """Load a project and enforce a minimum role.

    The demo project is rejected with 403 because it has no membership
    management; mutations against it are blocked elsewhere by
    ``_assert_not_demo``.
    """
    project = session.get(ProjectDB, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    membership = require_project_role(
        session, project_id, user_id, minimum_role=minimum_role
    )
    return project, membership.role


@router.get("")
async def list_projects(
    request: Request,
    session: Session = Depends(get_session),
):
    """List all projects the current user is a member of, plus the demo project."""
    user_id = _get_user_id(request)
    member_project_ids = set(list_projects_for_user(session, user_id))

    statement = (
        select(ProjectDB)
        .where(ProjectDB.id.in_(member_project_ids) | (ProjectDB.id == DEMO_PROJECT_ID))  # pyright: ignore[reportAttributeAccessIssue]
        .order_by(desc(ProjectDB.created_at))  # pyright: ignore[reportArgumentType]
    )
    projects = session.exec(statement).all()

    summaries: list[ProjectSummary] = []
    for p in projects:
        if p.id == DEMO_PROJECT_ID:
            summaries.append(_format_project_summary(p, current_user_role=None))
            continue
        membership = get_project_membership(session, p.id, user_id)
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

    content_policy = body.get("trace_content_policy", "redacted")
    if content_policy not in {"off", "redacted", "full"}:
        raise HTTPException(
            status_code=400,
            detail="trace_content_policy must be off, redacted, or full",
        )

    project = create_project_for_owner(
        session,
        name=name.strip(),
        trace_content_policy=cast(str, content_policy),
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

    Because a real ``ProjectDB`` row is committed before the key is minted, the
    legacy-project tolerance in ``require_project_role_or_legacy`` is never
    reached. The endpoint is public (no Authorization header) — it authenticates
    via email + password, exactly like ``POST /v1/api-keys/bootstrap``.

    Rate-limited (5/min/IP) independently from the api-keys bootstrap path.
    """
    ip = _get_client_ip(request)
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
        trace_content_policy=body.trace_content_policy,
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
    user_id = _get_user_id(request)
    project, role = _load_project_for_user(session, project_id, user_id)
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
    """Update Project settings. Requires an admin or owner membership."""
    _assert_not_demo(project_id)
    user_id = _get_user_id(request)
    project, role = _load_project_with_role(
        session, project_id, user_id, minimum_role="admin"
    )
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="name cannot be empty")
        project.name = name
    if body.trace_content_policy is not None:
        project.trace_content_policy = body.trace_content_policy
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

    user_id = _get_user_id(request)
    _project, _role = _load_project_with_role(
        session, project_id, user_id, minimum_role="owner"
    )
    delete_project_data(
        session,
        project_id,
        keep_project=False,
        keep_api_keys=False,
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Task source (SPEC-118)
# ---------------------------------------------------------------------------


def _assert_not_demo(project_id: str) -> None:
    """Demo task source is seeded, not user-editable."""
    if project_id == DEMO_PROJECT_ID:
        raise HTTPException(
            status_code=403, detail="Demo workspace task source is read-only"
        )


@router.get("/{project_id}/task-source")
async def get_project_task_source(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> ProjectTaskSource | None:
    """Return the project's task source, or ``null`` if unconfigured."""
    user_id = _get_user_id(request)
    _project, _role = _load_project_for_user(session, project_id, user_id)
    return serialize_task_source(get_task_source_db(session, project_id), session=session)


@router.patch("/{project_id}/task-source")
async def update_project_task_source(
    project_id: str,
    body: UpdateProjectTaskSourceRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> ProjectTaskSource:
    """Create or replace the project's task source configuration.

    Switching source type clears fields that do not apply to the new
    mode. On success, the source enters ``pending_sync``; trigger
    ``POST /v1/projects/{id}/task-source/sync`` to advance it to
    ``ready`` (full Git sync lands in SPEC-119).
    """
    user_id = _get_user_id(request)
    _load_project_with_role(
        session, project_id, user_id, minimum_role="admin"
    )
    _assert_not_demo(project_id)
    row = upsert_task_source(session, project_id, body)
    return serialize_task_source(row, session=session)  # pyright: ignore[reportReturnType]


@router.post("/{project_id}/task-source/sync")
def sync_project_task_source(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> ProjectTaskSource:
    """Trigger a sync of the project's task source.

    Defined as plain ``def`` (not ``async def``) so FastAPI runs it in
    a threadpool — git subprocess calls are blocking I/O and would
    freeze the event loop if marked async.

    Delegates to :mod:`apo.services.project_task_source_sync`,
    which:

    - clones/fetches Git sources with sparse checkout + partial clone
      and records the resolved commit SHA;
    - scans filesystem sources directly;
    - re-seeds demo sources from the bundled example-service workspace.

    Inventory rows are replaced atomically on success. On failure the
    source row is moved to ``status="error"`` with a human-readable
    ``last_error`` message.
    """
    user_id = _get_user_id(request)
    _load_project_with_role(
        session, project_id, user_id, minimum_role="admin"
    )
    _assert_not_demo(project_id)

    row = get_task_source_db(session, project_id)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail="Project has no task source configured yet.",
        )

    try:
        _ = sync_task_source(session, row)
    except GitError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Task source sync failed: {exc}",
        ) from exc
    except SyncError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Task source sync failed unexpectedly: {exc}",
        ) from exc

    # ``sync_task_source`` already advanced the row in-place; re-read so
    # we serialize the freshest state back to the client.
    refreshed = get_task_source_db(session, project_id)
    if refreshed is None:
        raise HTTPException(status_code=404, detail="Project task source vanished.")
    return serialize_task_source(refreshed, session=session)  # pyright: ignore[reportReturnType]


# ---------------------------------------------------------------------------
# Project-scoped agent tasks (SPEC-119)
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
    user_id = _get_user_id(request)
    _project, _role = _load_project_for_user(session, project_id, user_id)

    source = get_task_source_db(session, project_id)
    if source is None:
        raise HTTPException(
            status_code=404,
            detail="Project has no task source configured.",
        )

    # Filesystem sources are cheap to re-scan (no clone), so lazily refresh on
    # list — newly added/edited tasks show up without a manual sync (issue #17).
    refresh_filesystem_source(session, source)
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
    user_id = _get_user_id(request)
    _project, _role = _load_project_for_user(session, project_id, user_id)

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

    user_id = _get_user_id(request)
    _project, _role = _load_project_with_role(
        session, project_id, user_id, minimum_role="owner"
    )

    deleted_counts = delete_project_data(
        session,
        project_id,
        keep_project=True,
        keep_api_keys=True,
    )
    return {"ok": True, "deleted": deleted_counts}
