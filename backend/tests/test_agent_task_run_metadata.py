# pyright: reportPrivateUsage=false

from datetime import datetime, timezone
import asyncio
import json
import os
import tempfile
from typing import cast

from _pytest.monkeypatch import MonkeyPatch
from sqlmodel import Session

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    UserDB,
)
from apo.routes.agent_task_runs import (
    list_agent_tasks,
    get_agent_task_batch_run,
    get_agent_task_run,
)
from apo.services.agent_task_projection import parse_trigger
from apo.services.agent_task_runner import (
    _build_task_subprocess_env,
    create_batch_run,
    _normalize_run_metadata,
)
from apo.services.project_task_sources import serialize as serialize_task_source


def _json_object(value: object) -> dict[str, object]:
    return cast(dict[str, object], value)


def test_normalize_run_metadata_defaults_source_to_api():
    metadata = _normalize_run_metadata(None)

    assert metadata == {"trigger": {"source": "api"}}


def test_normalize_run_metadata_preserves_existing_trigger_fields():
    metadata = _normalize_run_metadata(
        {
            "trigger": {
                "source": "cli",
                "actor": "sami",
                "entrypoint": "apo task run",
            }
        }
    )

    assert metadata == {
        "trigger": {
            "source": "cli",
            "actor": "sami",
            "entrypoint": "apo task run",
        }
    }


def _fake_service_token(*, task_run_id: str, project: str) -> str:
    return f"svc::{task_run_id}::{project}"


def test_build_task_subprocess_env_includes_service_auth_and_task_run_metadata(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "apo.services.agent_task_runner.create_agent_task_trace_token",
        _fake_service_token,
    )
    monkeypatch.setenv("APO_BACKEND_URL", "http://localhost:8123")

    env = _build_task_subprocess_env(
        task_run_id="task-run-123",
        task_dir="/tmp/tasks/meeting-summary",
        project="example-service",
        environment="staging",
        run_metadata={"trigger": {"source": "dashboard"}},
    )

    assert env["AGENT_TASK_DIR"] == "/tmp/tasks/meeting-summary"
    assert env["AGENT_TASK_PROJECT"] == "example-service"
    assert env["AGENT_TASK_ENVIRONMENT"] == "staging"
    assert env["AGENT_TASK_TRACE_ENDPOINT"] == "http://localhost:8123"
    assert env["AGENT_TASK_RUN_ID"] == "task-run-123"
    assert env["AGENT_TASK_TRACE_REQUIRED"] == "true"
    assert env["APO_AUTH_TOKEN"] == "svc::task-run-123::example-service"

    metadata = _json_object(cast(object, json.loads(env["AGENT_TASK_RUN_METADATA"])))
    assert metadata["agent_task_run_id"] == "task-run-123"
    trigger = _json_object(metadata["trigger"])
    assert trigger["source"] == "dashboard"


def test_parse_trigger_reads_source_and_actor():
    trigger = parse_trigger(
        {
            "trigger": {
                "source": "dashboard",
                "actor": "qa-user",
                "hostname": "host-1",
                "entrypoint": "/agent-tasks",
                "initiated_at": "2026-06-04T06:30:00Z",
            }
        }
    )

    assert trigger is not None
    assert trigger.source == "dashboard"
    assert trigger.actor == "qa-user"
    assert trigger.hostname == "host-1"
    assert trigger.entrypoint == "/agent-tasks"
    assert trigger.initiated_at is not None


def test_batch_run_detail_exposes_trigger_metadata(
    session: Session,
):
    batch = AgentTaskBatchRunDB(
        id="batch-1",
        project="example-service",
        selection_type="task",
        selection_query=None,
        task_root="/tmp/tasks",
        grep=None,
        environment="default",
        run_metadata={
            "trigger": {
                "source": "dashboard",
                "actor": "qa-user",
                "entrypoint": "/agent-tasks",
                "initiated_at": "2026-06-04T06:30:00Z",
            }
        },
        status="completed",
        total_tasks=1,
        passed_tasks=1,
        failed_tasks=0,
        errored_tasks=0,
        created_at=datetime.now(timezone.utc),
    )
    task_run = AgentTaskRunDB(
        id="run-1",
        batch_run_id="batch-1",
        task_id="meeting-summary",
        task_path="/tmp/tasks/meeting-summary",
        adapter_name="demoAdapter",
        status="passed",
        pass_result=True,
        started_at=datetime.now(timezone.utc),
        completed_at=datetime.now(timezone.utc),
    )
    session.add(batch)
    session.add(task_run)
    session.commit()

    response = asyncio.run(get_agent_task_batch_run("batch-1", session))
    payload = _json_object(response.model_dump(mode="json"))
    trigger = _json_object(payload["trigger"])
    task_runs = cast(list[object], payload["task_runs"])
    task_run = _json_object(task_runs[0])
    task_trigger = _json_object(task_run["trigger"])
    assert trigger["source"] == "dashboard"
    assert trigger["actor"] == "qa-user"
    assert task_trigger["source"] == "dashboard"


def test_task_run_detail_exposes_trigger_metadata(
    session: Session,
):
    batch = AgentTaskBatchRunDB(
        id="batch-2",
        project="example-service",
        selection_type="task",
        selection_query=None,
        task_root="/tmp/tasks",
        grep=None,
        environment="default",
        run_metadata={
            "trigger": {
                "source": "cli",
                "actor": "sami",
                "hostname": "devbox",
                "entrypoint": "apo task run",
            }
        },
        status="completed",
        total_tasks=1,
        passed_tasks=1,
        failed_tasks=0,
        errored_tasks=0,
        created_at=datetime.now(timezone.utc),
    )
    task_run = AgentTaskRunDB(
        id="run-2",
        batch_run_id="batch-2",
        task_id="meeting-summary",
        task_path="/tmp/tasks/meeting-summary",
        adapter_name="demoAdapter",
        status="passed",
        pass_result=True,
        started_at=datetime.now(timezone.utc),
        completed_at=datetime.now(timezone.utc),
    )
    session.add(batch)
    session.add(task_run)
    session.commit()

    response = asyncio.run(get_agent_task_run("run-2", session))
    payload = _json_object(response.model_dump(mode="json"))
    trigger = _json_object(payload["trigger"])
    assert trigger["source"] == "cli"
    assert trigger["actor"] == "sami"
    assert trigger["hostname"] == "devbox"


def test_task_stats_are_filtered_by_project(session: Session):
    now = datetime.now(timezone.utc)
    passing_batch = AgentTaskBatchRunDB(
        id="batch-pass",
        project="example-service",
        selection_type="task",
        selection_query=None,
        task_root="/tmp/tasks",
        grep=None,
        environment="default",
        run_metadata={"trigger": {"source": "dashboard"}},
        status="completed",
        total_tasks=1,
        passed_tasks=1,
        failed_tasks=0,
        errored_tasks=0,
        created_at=now,
    )
    failing_batch = AgentTaskBatchRunDB(
        id="batch-fail",
        project="default",
        selection_type="task",
        selection_query=None,
        task_root="/tmp/tasks",
        grep=None,
        environment="default",
        run_metadata={"trigger": {"source": "cli"}},
        status="completed",
        total_tasks=1,
        passed_tasks=0,
        failed_tasks=0,
        errored_tasks=1,
        created_at=now,
    )
    session.add(passing_batch)
    session.add(failing_batch)
    session.add(
        AgentTaskRunDB(
            id="run-pass",
            batch_run_id="batch-pass",
            task_id="meeting-summary",
            task_path="/tmp/discovered/meeting-summary",
            adapter_name="demoAdapter",
            status="passed",
            pass_result=True,
            started_at=now,
            completed_at=now,
        )
    )
    session.add(
        AgentTaskRunDB(
            id="run-fail",
            batch_run_id="batch-fail",
            task_id="meeting-summary",
            task_path="/tmp/discovered/meeting-summary",
            adapter_name="demoAdapter",
            status="error",
            pass_result=False,
            started_at=now,
            completed_at=now,
            error_message="wrong project",
        )
    )
    session.commit()

    with tempfile.TemporaryDirectory() as tmp:
        task_dir = os.path.join(tmp, "meeting-summary")
        os.makedirs(task_dir, exist_ok=True)
        with open(os.path.join(task_dir, "meeting-summary.eval.ts"), "w") as f:
            _ = f.write('import { task } from "@apo/sdk/agent-task";\ntask("meeting-summary", { adapter: "a" });\n')

        tasks = asyncio.run(
            list_agent_tasks(
                task_root=tmp,
                grep=None,
                project="example-service",
                session=session,
            )
        )
    assert len(tasks) == 1
    stats = tasks[0].run_stats
    assert stats is not None
    assert stats.total_runs == 1
    assert stats.passed_runs == 1
    assert stats.errored_runs == 0
    assert stats.last_run_status == "passed"


def test_project_detail_marks_inventory_stale(
    session: Session,
):
    now = datetime.now(timezone.utc)
    # The project's created_by FKs users.id — seed the user so the project
    # insert satisfies PRAGMA foreign_keys=ON (now enabled in the test engine).
    session.add(
        UserDB(
            id="user-stale-project",
            email="stale@test.com",
            name="Stale Owner",
            password_hash="x",
            is_active=True,
        )
    )
    session.flush()
    project = ProjectDB(
        id="proj-stale",
        name="Stale Project",
        created_by="user-stale-project",
        created_at=now,
        updated_at=now,
    )
    source = ProjectTaskSourceDB(
        id="src-stale",
        project=project.id,
        source_type="git",
        display_name="Tasks",
        repository_url="https://github.com/example/repo.git",
        git_ref="main",
        subpath="tasks/new-root",
        status="pending_sync",
        last_synced_at=now,
        created_at=now,
        updated_at=now,
    )
    inventory = ProjectTaskInventoryDB(
        id="inv-stale",
        project=project.id,
        task_source_id=source.id,
        task_id="api-testing",
        display_name="api-testing",
        adapter_name="demoAdapter",
        folder_path="",
        task_path="api-testing",
        source_type="git",
        source_ref="main",
        source_commit_sha="abc123",
        source_subpath="tasks/old-root",
        discovered_at=now,
    )
    # Insert in FK-safe order with a flush between each layer so each child
    # row sees its parent (PRAGMA foreign_keys=ON is now enforced in tests).
    session.add(project)
    session.flush()
    session.add(source)
    session.flush()
    session.add(inventory)
    session.commit()

    serialized = serialize_task_source(source, session=session)

    assert serialized is not None
    assert serialized.inventory_stale is True


def test_create_batch_run_returns_conflict_for_stale_task_source(
    session: Session,
):
    now = datetime.now(timezone.utc)
    session.add(
        UserDB(
            id="user-stale-batch",
            email="batch-stale@test.com",
            name="Batch Stale Owner",
            password_hash="x",
            is_active=True,
        )
    )
    session.flush()
    project = ProjectDB(
        id="proj-batch-stale",
        name="Batch Stale",
        created_by="user-stale-batch",
        created_at=now,
        updated_at=now,
    )
    source = ProjectTaskSourceDB(
        id="src-batch-stale",
        project=project.id,
        source_type="git",
        display_name="Tasks",
        repository_url="https://github.com/example/repo.git",
        git_ref="main",
        subpath="tasks/new-root",
        status="pending_sync",
        last_synced_at=now,
        created_at=now,
        updated_at=now,
    )
    inventory = ProjectTaskInventoryDB(
        id="inv-batch-stale",
        project=project.id,
        task_source_id=source.id,
        task_id="api-testing",
        display_name="api-testing",
        adapter_name="demoAdapter",
        folder_path="",
        task_path="api-testing",
        source_type="git",
        source_ref="main",
        source_commit_sha="abc123",
        source_subpath="tasks/old-root",
        discovered_at=now,
    )
    # FK-safe insert order with flushes between layers (see test above).
    session.add(project)
    session.flush()
    session.add(source)
    session.flush()
    session.add(inventory)
    session.commit()

    try:
        _ = create_batch_run(
            session=session,
            project=project.id,
            selection_type="task",
            task_paths=["api-testing"],
            task_root=None,
            grep=None,
            environment="default",
            run_metadata=None,
            task_source=source,
        )
    except ValueError as exc:
        assert "Sync tasks before running" in str(exc)
    else:
        raise AssertionError("Expected stale inventory to block batch run creation")
