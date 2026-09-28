"""Dev workspace provisioning for agent-facing dashboard access.

When dev sign-in is enabled, ``ensure_dev_workspace`` provisions everything an
AI agent needs to use the dashboard productively:

- the dev user (``dev@apo.local``) with an unusable random password, so it can
  never sign in through the regular password form,
- the ``agent-demo`` project — a real, private, writable project owned by the
  dev user, deliberately distinct from the shared read-only ``demo`` workspace,
- a task source + inventory (the bundled example-service workspace), so the
  tasks page lists real tasks,
- one completed batch run with task runs (PASS/FAIL), check reports, and
  traces, so the runs and traces pages have real content immediately.

Everything is idempotent: repeated provisioning returns the same rows and
seeding runs only while the project has no batch runs.
"""

import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlmodel import Session, select

from ..auth import hash_password
from ..models.db import (
    AgentTaskBatchRunDB,
    AgentTaskCheckReportDB,
    AgentTaskRunDB,
    LoggedCallDB,
    ProjectDB,
    ProjectMembershipDB,
    ProjectTaskSourceDB,
    RunDB,
    UserDB,
)

logger = logging.getLogger(__name__)

DEV_SIGNIN_ENABLED_ENV = "DEV_SIGNIN_ENABLED"
DEV_PROJECT_ID_ENV = "APO_DEV_PROJECT_ID"
DEV_SEED_MODEL_ENV = "APO_DEV_SEED_MODEL"
# Cheap default — this is fixture data, not a real execution, so the label
# should reflect what the deployment actually runs day-to-day.
DEV_SEED_MODEL_DEFAULT = "deepseek/deepseek-v4.1-flash"
DEV_USER_EMAIL = "dev@apo.local"
DEV_USER_NAME = "Dev User"
DEV_PROJECT_DEFAULT_ID = "agent-demo"
DEV_PROJECT_NAME = "Agent demo"

# Fallback task ids when the bundled example-service workspace is absent
# (e.g. unit tests without the repo checkout). Shape mirrors discovery:
# folder-scoped ``<agent>/<task>``.
_FALLBACK_TASK_IDS = [
    "example/data-extraction",
    "example/document-qa",
    "example/api-testing",
    "example/config-generator",
]

_TRUTHY = ("1", "true", "yes", "on")


def is_dev_signin_enabled() -> bool:
    """Whether dev sign-in may provision a workspace on this deployment.

    ``DEV_SIGNIN_ENABLED`` is the explicit operator opt-in and wins when set.
    When unset, dev sign-in defaults on only in the ``development`` profile —
    release profiles (``local``, ``server``) must opt in explicitly.
    """
    raw = os.environ.get(DEV_SIGNIN_ENABLED_ENV, "").strip().lower()
    if raw:
        return raw in _TRUTHY
    profile = os.environ.get("APO_DEPLOYMENT_PROFILE", "").strip().lower()
    return profile in ("", "development")


def dev_project_id() -> str:
    value = os.environ.get(DEV_PROJECT_ID_ENV, "").strip()
    return value or DEV_PROJECT_DEFAULT_ID


def dev_landing_path() -> str:
    return f"/project/{dev_project_id()}/tasks"


def dev_seed_model() -> str:
    return os.environ.get(DEV_SEED_MODEL_ENV, "").strip() or DEV_SEED_MODEL_DEFAULT


def is_dev_project_seeded(session: Session) -> bool:
    statement = select(AgentTaskBatchRunDB).where(
        AgentTaskBatchRunDB.project == dev_project_id()
    )
    return session.exec(statement).first() is not None


def ensure_dev_workspace(session: Session) -> UserDB:
    """Get-or-create the dev user, their project, and the seeded content.

    Commits on success; safe to call concurrently (second caller sees the
    first caller's rows and skips creation).
    """
    now = datetime.now(timezone.utc)

    user = _ensure_dev_user(session, now)
    project = _ensure_dev_project(session, user, now)
    _ensure_owner_membership(session, user.id, project.id)
    _ensure_task_source(session, project.id, now)

    if not is_dev_project_seeded(session):
        _seed_dev_runs(session, user.id, project.id, now)
        logger.info("Seeded dev workspace project %s", project.id)

    session.commit()
    return user


def _ensure_dev_user(session: Session, now: datetime) -> UserDB:
    user = session.exec(
        select(UserDB).where(UserDB.email == DEV_USER_EMAIL)
    ).first()
    if user is not None:
        return user
    user = UserDB(
        email=DEV_USER_EMAIL,
        name=DEV_USER_NAME,
        # Random unusable password: password-form login as the dev user is
        # impossible by construction; only the profile-gated route grants it.
        password_hash=hash_password(secrets.token_urlsafe(32)),
        email_verified_at=now,
        created_at=now,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    logger.info("Provisioned dev user %s", DEV_USER_EMAIL)
    return user


def _ensure_dev_project(session: Session, user: UserDB, now: datetime) -> ProjectDB:
    project = session.get(ProjectDB, dev_project_id())
    if project is not None:
        return project
    project = ProjectDB(
        id=dev_project_id(),
        name=DEV_PROJECT_NAME,
        created_by=user.id,
        created_at=now,
        updated_at=now,
    )
    session.add(project)
    session.commit()
    return project


def _ensure_owner_membership(session: Session, user_id: str, project_id: str) -> None:
    existing = session.exec(
        select(ProjectMembershipDB).where(
            ProjectMembershipDB.project_id == project_id,
            ProjectMembershipDB.user_id == user_id,
        )
    ).first()
    if existing is not None:
        return
    session.add(
        ProjectMembershipDB(
            project_id=project_id,
            user_id=user_id,
            role="owner",
        )
    )
    session.commit()


def _ensure_task_source(session: Session, project_id: str, now: datetime) -> None:
    """Advertise the bundled example-service tasks as this project's source.

    Mirrors the demo workspace's source row so the tasks page lists real
    tasks without any executor or git machinery.
    """
    existing = session.exec(
        select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == project_id)
    ).first()
    if existing is not None:
        _repair_empty_inventory(session, existing)
        return
    source = ProjectTaskSourceDB(
        project=project_id,
        source_type="demo",
        display_name="Agent demo tasks",
        demo_seed_id="example-service",
        status="ready",
        last_synced_at=now,
        created_at=now,
        updated_at=now,
    )
    session.add(source)
    session.commit()
    session.refresh(source)

    from .project_task_inventory import seed_demo_inventory

    try:
        _ = seed_demo_inventory(session, source)
    except Exception:
        # A missing bundled workspace must not break sign-in; the seeded
        # runs still render and the fallback task ids keep rows coherent.
        logger.exception("Dev workspace inventory seed failed; continuing")
        session.rollback()


def _repair_empty_inventory(session: Session, source: ProjectTaskSourceDB) -> None:
    """Seed inventory for an existing source whose discovery came up empty.

    Mirrors the demo workspace's repair: a source created by an older code
    path (e.g. the pre-container-path-fix seeder) may exist with zero
    inventory rows. Re-running the seed is a no-op when the bundled task
    workspace genuinely has nothing to discover.
    """
    from .project_task_inventory import list_inventory_for_project, seed_demo_inventory

    try:
        existing_rows = list_inventory_for_project(session, source.project)
        if existing_rows:
            return
        _ = seed_demo_inventory(session, source)
    except Exception:
        logger.exception(
            "Dev workspace inventory repair failed for %s; continuing", source.project
        )
        session.rollback()


def _discovered_task_ids() -> list[str]:
    """Task ids from the bundled workspace, or the fallback list."""
    try:
        from .agent_task_discovery import discover_agent_tasks
        from .paths import demo_task_root

        return [task.id for task in discover_agent_tasks(demo_task_root())]
    except Exception:
        logger.exception("Dev workspace task discovery failed; using fallback ids")
        return list(_FALLBACK_TASK_IDS)


def _seed_dev_runs(
    session: Session, user_id: str, project_id: str, now: datetime
) -> None:
    """Create one completed batch with realistic task runs and traces.

    Direct-row seeding on purpose: the demo workspace seeds by *executing*
    tasks through an executor, which is exactly the heavy dependency an
    always-available dev landing must not have.
    """
    task_ids = (_discovered_task_ids() or list(_FALLBACK_TASK_IDS))[:4]
    model = dev_seed_model()

    created_at = now - timedelta(hours=3)
    started_at = created_at + timedelta(seconds=30)
    completed_at = started_at + timedelta(minutes=6)

    batch = AgentTaskBatchRunDB(
        id="agent-demo-batch-001",
        project=project_id,
        selection_type="all",
        task_root=None,
        environment="dev",
        requested_by_user_id=user_id,
        run_metadata={
            "trigger": {
                "source": "dev-workspace-seed",
                "actor": "system",
                "entrypoint": "ensure_dev_workspace",
                "initiated_at": created_at.isoformat(),
            }
        },
        status="completed",
        trace_persistence_status="persisted",
        created_at=created_at,
        started_at=started_at,
        completed_at=completed_at,
        task_source_type="demo",
    )
    session.add(batch)
    # Insert-ordering: the report rows below reference agent_task_runs via a
    # bare column FK SQLAlchemy can't topologically sort — flush parents first.
    session.flush()

    batch_total_checks = 0
    batch_passed_checks = 0
    passed_tasks = 0
    failed_tasks = 0

    for index, task_id in enumerate(task_ids):
        run_passes = index != 2  # third task fails: a realistic mixed verdict
        run_started = started_at + timedelta(minutes=index * 90)
        run_completed = run_started + timedelta(seconds=45 + index * 10)
        trace_id = uuid4().hex

        checks = _build_checks(run_passes)
        total_checks = len(checks)
        passed_checks = sum(1 for check in checks if check["pass"] is True)

        task_run = AgentTaskRunDB(
            id=f"agent-demo-run-{index + 1:03d}",
            batch_run_id=batch.id,
            task_id=task_id,
            task_path=f"e2e/agent-task-demo/tasks/{task_id}",
            sequence_index=index,
            adapter_name="example-adapter",
            status="passed" if run_passes else "failed",
            pass_result=run_passes,
            started_at=run_started,
            completed_at=run_completed,
            trace_run_id=trace_id,
            trace_persistence_status="persisted",
            total_checks=total_checks,
            passed_checks=passed_checks,
            failed_checks=total_checks - passed_checks,
            total_cost=1500 + index * 320,
            total_tokens=2_400 + index * 530,
            configured_model=model,
            configured_effort="medium",
        )
        session.add(task_run)
        session.flush()
        session.add(
            AgentTaskCheckReportDB(
                run_id=task_run.id,
                value_json=checks,
                created_at=run_completed,
            )
        )

        _seed_trace(
            session,
            project_id=project_id,
            task_id=task_id,
            task_run_id=task_run.id,
            trace_id=trace_id,
            started_at=run_started,
            duration_seconds=40 + index * 8,
            run_passes=run_passes,
            model=model,
        )

        batch_total_checks += total_checks
        batch_passed_checks += passed_checks
        if run_passes:
            passed_tasks += 1
        else:
            failed_tasks += 1

    batch.total_tasks = len(task_ids)
    batch.passed_tasks = passed_tasks
    batch.failed_tasks = failed_tasks
    batch.total_checks = batch_total_checks
    batch.passed_checks = batch_passed_checks
    session.add(batch)


def _build_checks(run_passes: bool) -> list[dict[str, object]]:
    """Realistic check evidence: a passing deliverable check and a trajectory
    check that fails when the run fails."""
    return [
        {
            "id": "deliverable-matches-contract",
            "name": "deliverable-matches-contract",
            "instruction": "The final deliverable must match the task contract.",
            "pass": True,
            "reasoning": "Deliverable parsed and validated against the contract.",
            "expected": "JSON object with all required keys",
            "received": '{"status": "ok", "items": 3}',
        },
        {
            "id": "used-planning-tool-first",
            "name": "used-planning-tool-first",
            "instruction": "The agent must plan before acting.",
            "pass": run_passes,
            "reasoning": (
                "Trace shows a planning call before the first tool call."
                if run_passes
                else "Trace shows tool calls with no preceding planning step."
            ),
            "expected": "planning span before first tool span",
            "received": "tool span at depth 0" if not run_passes else "plan span at depth 0",
        },
    ]


def _seed_trace(
    session: Session,
    *,
    project_id: str,
    task_id: str,
    task_run_id: str,
    trace_id: str,
    started_at: datetime,
    duration_seconds: int,
    run_passes: bool,
    model: str,
) -> None:
    """Seed a demo/dev trace projection directly (no canonical spans).

    These rows deliberately keep storing their I/O in the fat columns: in
    slim projection mode, span-less calls serve stored columns through the
    read-path fallback (projection_io.hydrate_calls_from_spans). Real
    telemetry must go through the OTLP receiver.
    """
    duration_ms = float(duration_seconds * 1000)

    session.add(
        RunDB(
            id=trace_id,
            project=project_id,
            task_id=task_id,
            environment="dev",
            tags=["agent-demo"],
            input={"task": task_id, "prompt": f"Complete the {task_id} task."},
            output={
                "status": "pass" if run_passes else "fail",
                "answer": "Deliverable produced and validated."
                if run_passes
                else "Deliverable missing the planning step.",
            },
            primary_model=model,
            task_run_id=task_run_id,
            created_at=started_at,
            completed_at=started_at + timedelta(seconds=duration_seconds),
            duration_ms=duration_ms,
            call_count=2,
        )
    )

    session.add(
        LoggedCallDB(
            id=uuid4().hex[:16],
            project=project_id,
            task_id=task_id,
            run_id=trace_id,
            created_at=started_at,
            model=model,
            latency_ms=1_800.0,
            cost=620,
            observation_type="TOOL",
            flow_name="plan",
            step_name="plan",
            tool_name="plan",
            tool_parameters={"goal": f"complete {task_id}"},
            tool_result={"steps": 4},
            prompt_tokens=None,
            completion_tokens=None,
            input={"goal": f"complete {task_id}"},
            messages=[{"role": "user", "content": f"Complete the {task_id} task."}],
            output={"steps": 4},
        )
    )
    session.add(
        LoggedCallDB(
            id=uuid4().hex[:16],
            project=project_id,
            task_id=task_id,
            run_id=trace_id,
            created_at=started_at + timedelta(seconds=2),
            model=model,
            latency_ms=(duration_ms - 2_000.0),
            cost=880,
            observation_type="GENERATION",
            flow_name="generate",
            step_name="generate",
            prompt_tokens=1_200,
            completion_tokens=350,
            total_tokens=1_550,
            completion_start_time=started_at + timedelta(seconds=3),
            end_time=started_at + timedelta(seconds=duration_seconds),
            input={"messages": [{"role": "user", "content": f"Complete the {task_id} task."}]},
            messages=[{"role": "user", "content": f"Complete the {task_id} task."}],
            output={
                "text": "Plan created, tools invoked, deliverable produced."
                if run_passes
                else "Deliverable produced without a planning step."
            },
        )
    )
