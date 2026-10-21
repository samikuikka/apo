"""Task removal: the remove → tombstone → archived → restore loop.

Pins the full remove → tombstone → archived → restore loop:

- Publishing a catalog without a previously-present task writes a
  ``removed`` lifecycle event (last-known metadata + best-effort commit +
  retained-run count) and reports the diff (added ids, removed entries
  with run counts and referencing schedules, possible renames).
- The archived listing serves those tombstones with live run stats.
- The task-detail route synthesizes a ``state: "removed"`` detail from the
  tombstone (or from runs alone, for pre-tombstone removals) instead of
  404ing — the runs the server holds must stay reachable.
- A task that returns to the catalog has its event deleted and is active
  again, with its prior runs attached.
- An emptied selection that pointed at a removed task names the removal
  with its date instead of a generic "no tasks found".
- The filesystem sync chokepoint records the same tombstones.
"""

from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlmodel import Session, SQLModel, create_engine, select
from sqlmodel.pool import StaticPool

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    ProjectMembershipDB,
    ProjectTaskSourceDB,
    TaskLifecycleEventDB,
    UserDB,
)
from apo.services.project_task_source_sync import sync_task_source
from apo.services.scheduling_errors import SelectionEmptyError
from apo.services.agent_task_runner import create_batch_run
from apo.services.task_catalog import publish_catalog, validate_catalog_request

_PROJECT = "proj-lifecycle"
_USER = "lifecycle-user"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _seed(session: Session) -> None:
    now = datetime.now(timezone.utc)
    session.add(UserDB(id=_USER, email=f"{_USER}@test", name=_USER, password_hash="x"))
    session.commit()
    session.add(ProjectDB(id=_PROJECT, name=_PROJECT, created_by=_USER, created_at=now))
    session.commit()
    session.add(
        ProjectMembershipDB(
            project_id=_PROJECT, user_id=_USER, role="owner", created_at=now, updated_at=now
        )
    )
    session.commit()


def _task(task_id: str, *, definition: str | None = None) -> dict[str, Any]:
    folder, _, name = task_id.rpartition("/")
    task: dict[str, Any] = {
        "task_id": task_id,
        "display_name": name,
        "task_path": task_id,
        "folder_path": folder,
        "adapter_name": "cli",
        "has_checks": True,
        "tags": [],
    }
    if definition is not None:
        task["definition"] = {
            "schema_version": 1,
            "files": [{"path": f"{name}.eval.ts", "content": definition}],
        }
    return task


def _publish(
    client: TestClient,
    tasks: list[dict[str, Any]],
    *,
    head_commit_sha: str | None = None,
) -> Any:
    body: dict[str, Any] = {"schema_version": 2, "tasks": tasks}
    if head_commit_sha is not None:
        body["head_commit_sha"] = head_commit_sha
    return client.put(f"/v1/projects/{_PROJECT}/task-catalog", json=body)


def _add_run(session: Session, *, run_id: str, task_id: str, status: str = "passed") -> None:
    batch_id = f"batch-{run_id}"
    session.add(
        AgentTaskBatchRunDB(
            id=batch_id, project=_PROJECT, selection_type="manual", status="completed"
        )
    )
    session.add(
        AgentTaskRunDB(
            id=run_id,
            batch_run_id=batch_id,
            task_id=task_id,
            task_path=task_id,
            status=status,
            started_at=datetime.now(timezone.utc) - timedelta(hours=1),
            completed_at=datetime.now(timezone.utc),
        )
    )
    session.commit()


def _events(session: Session) -> list[TaskLifecycleEventDB]:
    session.expire_all()
    return list(
        session.exec(
            select(TaskLifecycleEventDB).where(TaskLifecycleEventDB.project == _PROJECT)
        ).all()
    )


# ---------------------------------------------------------------------------
# Publish diff + tombstones
# ---------------------------------------------------------------------------


def test_removal_writes_tombstone_and_reports_diff(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)

    first = _publish(
        client,
        [_task("chat/alpha"), _task("chat/beta")],
    ).json()
    assert first["diff"] == {"added": ["chat/alpha", "chat/beta"], "removed": [], "possible_renames": []}

    _add_run(session, run_id="run-b1", task_id="chat/beta")
    _add_run(session, run_id="run-b2", task_id="chat/beta", status="failed")

    second = _publish(
        client, [_task("chat/alpha")], head_commit_sha="2d81b43d"
    ).json()

    # Compat keys unchanged; the diff object carries the consequences.
    assert second["removed_tasks"] == ["chat/beta"]
    assert second["diff"]["added"] == []
    assert len(second["diff"]["removed"]) == 1
    entry = second["diff"]["removed"][0]
    assert entry["task_id"] == "chat/beta"
    assert entry["display_name"] == "beta"
    assert entry["run_count"] == 2
    assert entry["schedules"] == []

    events = _events(session)
    assert len(events) == 1
    event = events[0]
    assert event.task_id == "chat/beta"
    assert event.display_name == "beta"
    assert event.folder_path == "chat"
    assert event.source_commit_sha == "2d81b43d"
    assert event.run_count == 2

    # The runs themselves are untouched by removal.
    runs = session.exec(select(AgentTaskRunDB)).all()
    assert {run.task_id for run in runs} == {"chat/beta"}


def test_removal_diff_names_referencing_schedules(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    from apo.models.db import AgentTaskScheduleDB

    _seed(session)
    client = make_authed_client(_USER, session)
    _ = _publish(client, [_task("ops/nightly-check")]).json()

    now = datetime.now(timezone.utc)
    session.add(
        AgentTaskScheduleDB(
            id="sched-1",
            project=_PROJECT,
            name="nightly",
            selection_type="tasks",
            selection_query={"task_paths": ["ops/nightly-check"]},
            environment="default",
            cadence_type="daily",
            timezone="UTC",
            hour=3,
            minute=0,
            enabled=True,
            executor_pool_id=None,
            next_run_at=now + timedelta(days=1),
            created_at=now,
            updated_at=now,
        )
    )
    session.commit()

    second = _publish(client, []).json()
    entry = second["diff"]["removed"][0]
    assert entry["task_id"] == "ops/nightly-check"
    assert entry["schedules"] == ["nightly"]


def test_idempotent_republish_reports_empty_diff(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)

    _ = _publish(client, [_task("chat/alpha")]).json()
    again = _publish(client, [_task("chat/alpha")]).json()
    assert again["diff"] == {"added": [], "removed": [], "possible_renames": []}
    assert _events(session) == []


def test_rename_detection_via_identical_definition_content(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)
    source = 'import { task } from "@apo-ai/sdk/agent-task";\ntask("moved", {});\n'
    _ = _publish(
        client, [_task("old/moved", definition=source), _task("stay/idle")]
    ).json()

    second = _publish(
        client, [_task("new/moved", definition=source), _task("stay/idle")]
    ).json()

    renames = second["diff"]["possible_renames"]
    assert len(renames) == 1
    assert renames[0]["from"] == "old/moved"
    assert renames[0]["to"] == "new/moved"
    assert renames[0]["definition_sha256"].startswith("sha256:") or len(
        renames[0]["definition_sha256"]
    ) == 64


def test_head_commit_sha_validation(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)
    _ = _publish(client, [_task("chat/alpha")]).json()

    resp = _publish(client, [], head_commit_sha="not-a-sha!")
    assert resp.status_code == 422
    assert "head_commit_sha" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Archived listing + detail fallback
# ---------------------------------------------------------------------------


def test_archived_endpoint_lists_removed_with_stats(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)
    _ = _publish(client, [_task("chat/alpha"), _task("chat/beta")]).json()
    _add_run(session, run_id="run-b1", task_id="chat/beta")
    _add_run(session, run_id="run-b2", task_id="chat/beta", status="failed")
    _ = _publish(client, [_task("chat/alpha")]).json()

    resp = client.get(f"/v1/projects/{_PROJECT}/agent-tasks/archived")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["removed"]) == 1
    entry = body["removed"][0]
    assert entry["task_id"] == "chat/beta"
    assert entry["run_count"] == 2
    assert entry["run_stats"]["total_runs"] == 2
    assert entry["run_stats"]["last_run_status"] is not None


def test_archived_endpoint_is_empty_without_removals(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)
    _ = _publish(client, [_task("chat/alpha")]).json()

    resp = client.get(f"/v1/projects/{_PROJECT}/agent-tasks/archived")
    assert resp.status_code == 200
    assert resp.json() == {"removed": []}


def test_detail_fallback_for_removed_task(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)
    _ = _publish(client, [_task("chat/beta")]).json()
    _add_run(session, run_id="run-b1", task_id="chat/beta")
    _ = _publish(client, [], head_commit_sha="abc1234").json()

    resp = client.get("/v1/projects/{}/agent-tasks/{}".format(_PROJECT, "chat/beta"))
    assert resp.status_code == 200, resp.text
    detail = resp.json()
    assert detail["state"] == "removed"
    assert detail["removed_commit_sha"] == "abc1234"
    assert detail["removed_at"] is not None
    assert detail["run_stats"]["total_runs"] == 1

    unknown = client.get(f"/v1/projects/{_PROJECT}/agent-tasks/never/existed")
    assert unknown.status_code == 404


def test_detail_fallback_from_runs_alone_when_no_tombstone(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """Pre-tombstone removals (or direct API runs) still resolve.

    Without an event the removal date is unknown — ``removed_at`` is None,
    honestly, rather than invented.
    """
    _seed(session)
    client = make_authed_client(_USER, session)
    # A source must exist for the detail route to run; an empty catalog is
    # the honest shape of "everything was removed before tombstones".
    _ = _publish(client, []).json()
    _add_run(session, run_id="run-x", task_id="legacy/task")

    resp = client.get(f"/v1/projects/{_PROJECT}/agent-tasks/legacy/task")
    assert resp.status_code == 200, resp.text
    detail = resp.json()
    assert detail["state"] == "removed"
    assert detail["removed_at"] is None
    assert detail["display_name"] == "task"


def test_readd_clears_tombstone_and_reattaches_runs(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)
    _ = _publish(client, [_task("chat/beta")]).json()
    _add_run(session, run_id="run-b1", task_id="chat/beta")
    _ = _publish(client, []).json()
    assert len(_events(session)) == 1

    back = _publish(client, [_task("chat/beta")]).json()
    assert back["diff"]["added"] == ["chat/beta"]
    assert _events(session) == []

    detail = client.get(f"/v1/projects/{_PROJECT}/agent-tasks/chat/beta").json()
    assert detail["state"] is None
    assert detail["run_stats"]["total_runs"] == 1

    archived = client.get(f"/v1/projects/{_PROJECT}/agent-tasks/archived").json()
    assert archived == {"removed": []}


# ---------------------------------------------------------------------------
# Dated empty-selection message
# ---------------------------------------------------------------------------


def test_empty_selection_names_the_removed_task_with_date(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)
    _ = _publish(client, [_task("chat/beta")]).json()
    _ = _publish(client, []).json()

    source = session.exec(
        select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == _PROJECT)
    ).one()

    try:
        _ = create_batch_run(
            session,
            _PROJECT,
            "tasks",
            task_paths=["chat/beta"],
            task_source=source,
            commit=False,
        )
        raise AssertionError("expected SelectionEmptyError")
    except SelectionEmptyError as exc:
        message = str(exc)
        assert "'chat/beta' was removed from the catalog on" in message
        assert datetime.now(timezone.utc).date().isoformat() in message


def test_empty_selection_without_removal_overlap_keeps_generic_message(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)
    _ = _publish(client, [_task("chat/beta")]).json()
    _ = _publish(client, []).json()

    source = session.exec(
        select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == _PROJECT)
    ).one()

    try:
        _ = create_batch_run(
            session,
            _PROJECT,
            "tasks",
            task_paths=["unrelated/thing"],
            task_source=source,
            commit=False,
        )
        raise AssertionError("expected SelectionEmptyError")
    except SelectionEmptyError as exc:
        assert "was removed" not in str(exc)


# ---------------------------------------------------------------------------
# Filesystem sync chokepoint records the same tombstones
# ---------------------------------------------------------------------------


def test_sync_chokepoint_records_tombstones(tmp_path: Path) -> None:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    try:
        now = datetime.now(timezone.utc)
        for name in ("alpha", "beta"):
            task_dir = tmp_path / "flows" / name
            task_dir.mkdir(parents=True)
            _ = (task_dir / f"{name}.eval.ts").write_text(
                f'import {{ task }} from "@apo-ai/sdk/agent-task";\ntask("{name}", {{ adapter: "a" }});\n'
            )

        with Session(engine) as session:
            project = f"sync-{uuid4().hex[:8]}"
            session.add(ProjectDB(id=project, name=project, created_at=now))
            session.commit()
            source = ProjectTaskSourceDB(
                id=f"source-{project}",
                project=project,
                source_type="filesystem",
                display_name="Sync test",
                filesystem_path=str(tmp_path),
                status="ready",
                last_synced_at=now,
                created_at=now,
                updated_at=now,
            )
            session.add(source)
            session.commit()

            _ = sync_task_source(session, source)
            assert (
                session.exec(
                    select(TaskLifecycleEventDB).where(
                        TaskLifecycleEventDB.project == project
                    )
                ).all()
                == []
            )

            # beta leaves the disk; the next sync must tombstone it.
            _ = (tmp_path / "flows" / "beta" / "beta.eval.ts").unlink()
            _ = (tmp_path / "flows" / "beta").rmdir()
            _ = sync_task_source(session, source)

            events = session.exec(
                select(TaskLifecycleEventDB).where(
                    TaskLifecycleEventDB.project == project
                )
            ).all()
            assert [event.task_id for event in events] == ["flows/beta"]
            assert events[0].display_name == "beta"
            assert events[0].folder_path == "flows"

            # And returning to disk clears it.
            task_dir = tmp_path / "flows" / "beta"
            task_dir.mkdir(parents=True)
            _ = (task_dir / "beta.eval.ts").write_text(
                'import { task } from "@apo-ai/sdk/agent-task";\ntask("beta", { adapter: "a" });\n'
            )
            _ = sync_task_source(session, source)
            assert (
                session.exec(
                    select(TaskLifecycleEventDB).where(
                        TaskLifecycleEventDB.project == project
                    )
                ).all()
                == []
            )
    finally:
        SQLModel.metadata.drop_all(engine)
        engine.dispose()


# ---------------------------------------------------------------------------
# Service-level direct publish (route-independent)
# ---------------------------------------------------------------------------


def test_publish_catalog_service_records_tombstone_without_client() -> None:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    try:
        with Session(engine) as session:
            project = "svc-lifecycle"
            now = datetime.now(timezone.utc)
            session.add(ProjectDB(id=project, name=project, created_at=now))
            session.commit()

            v1 = validate_catalog_request([_task("a/one"), _task("a/two")])
            _ = publish_catalog(session, project, v1)
            v2 = [task for task in v1 if task["task_id"] == "a/one"]
            result = publish_catalog(
                session, project, v2, head_commit_sha="deadbeef"
            )

            assert result["diff"]["removed"][0]["task_id"] == "a/two"
            events = session.exec(
                select(TaskLifecycleEventDB).where(
                    TaskLifecycleEventDB.project == project
                )
            ).all()
            assert len(events) == 1
            assert events[0].source_commit_sha == "deadbeef"
    finally:
        SQLModel.metadata.drop_all(engine)
        engine.dispose()


def test_v61_is_registered_and_latest() -> None:
    """The schema-version guard: v61 is registered and the latest."""
    from apo.db import LATEST_SCHEMA_VERSION, _SCHEMA_MIGRATIONS

    assert LATEST_SCHEMA_VERSION == 62
    assert 61 in _SCHEMA_MIGRATIONS
