"""Issue #17: filesystem task sources must self-heal without a manual sync.

Adding/editing a task on disk was invisible until ``apo project source sync``
ran, and ``task run <new>`` failed with an opaque 409. Filesystem discovery is
a cheap server-local walk, so these tests pin the new behaviour: filesystem
sources are lazily re-synced on list/run, git sources are left alone, and the
"no tasks" error is actionable.
"""

from datetime import datetime, timezone

from apo.models.db import (
    ProjectDB,
    ProjectMembershipDB,
    ProjectTaskSourceDB,
    UserDB,
)
from apo.services.agent_task_runner import create_batch_run
from apo.services.project_task_inventory import (
    get_inventory_row,
    list_inventory_for_project,
)
from apo.services.project_task_source_sync import (
    refresh_filesystem_source,
    sync_task_source,
)


def _eval(name: str) -> str:
    """Minimal discoverable ``*.eval.ts`` source — discovery keys on ``task(\"id\")``."""
    return f'task("{name}", {{ adapter: demoAdapter }});\n'


def _write_task(tasks_root: str, folder: str, name: str) -> str:
    """Create ``<tasks_root>/<folder>/<name>.eval.ts`` and return the folder path."""
    import os

    task_dir = os.path.join(tasks_root, *folder.split("/"))
    os.makedirs(task_dir, exist_ok=True)
    with open(os.path.join(task_dir, f"{name}.eval.ts"), "w") as f:
        f.write(_eval(name))
    return task_dir


def _seed_filesystem_project(
    session,
    tasks_root: str,
    *,
    project_id: str = "proj-fs",
    owner_id: str = "owner-fs",
) -> ProjectTaskSourceDB:
    """Insert a user, project, owner membership, and a ready filesystem source."""
    now = datetime.now(timezone.utc)
    session.add(UserDB(id=owner_id, email="fs@test.com", name="FS Owner",
                       password_hash="x", is_active=True))
    session.flush()
    session.add(ProjectDB(id=project_id, name="FS Project",
                          created_by=owner_id, created_at=now, updated_at=now))
    session.flush()
    session.add(ProjectMembershipDB(project_id=project_id, user_id=owner_id,
                                    role="owner", created_at=now, updated_at=now))
    session.flush()
    source = ProjectTaskSourceDB(
        id=f"src-{project_id}",
        project=project_id,
        source_type="filesystem",
        display_name="FS Tasks",
        filesystem_path=tasks_root,
        status="ready",
        last_synced_at=now,
        created_at=now,
        updated_at=now,
    )
    session.add(source)
    session.commit()
    session.refresh(source)
    return source


# ---------------------------------------------------------------------------
# refresh_filesystem_source — the core lazy-sync helper
# ---------------------------------------------------------------------------


def test_refresh_picks_up_newly_added_task(tmp_path, session):
    tasks_root = str(tmp_path)
    _write_task(tasks_root, "alpha", "alpha")
    source = _seed_filesystem_project(session, tasks_root)
    sync_task_source(session, source)  # initial sync: inventory has "alpha"

    assert [r.task_id for r in list_inventory_for_project(session, source.project)] == ["alpha"]

    # Add a brand-new task on disk — no manual sync.
    _write_task(tasks_root, "beta", "beta")
    assert get_inventory_row(session, source.project, "beta") is None  # still stale

    refresh_filesystem_source(session, source)

    ids = sorted(r.task_id for r in list_inventory_for_project(session, source.project))
    assert ids == ["alpha", "beta"]


def test_refresh_is_noop_for_git_sources(tmp_path, session):
    # A git source must never be lazily refreshed — that would clone/fetch.
    now = datetime.now(timezone.utc)
    session.add(UserDB(id="u-git", email="g@test.com", name="G",
                       password_hash="x", is_active=True))
    session.flush()
    session.add(ProjectDB(id="proj-git", name="Git", created_by="u-git",
                          created_at=now, updated_at=now))
    session.flush()
    git_source = ProjectTaskSourceDB(
        id="src-git", project="proj-git", source_type="git", display_name="Git",
        repository_url="https://example.com/repo.git", git_ref="main",
        subpath="tasks", status="ready", last_synced_at=now,
        last_resolved_commit_sha="abc123", created_at=now, updated_at=now,
    )
    session.add(git_source)
    session.commit()
    session.refresh(git_source)

    refresh_filesystem_source(session, git_source)  # must be a no-op

    assert git_source.source_type == "git"
    # No exception, no status churn (still ready), no clone attempted.
    assert git_source.status == "ready"


def test_refresh_is_best_effort_when_path_missing(tmp_path, session):
    source = _seed_filesystem_project(session, str(tmp_path))

    # The configured path vanishes between syncs.
    import os
    import shutil
    shutil.rmtree(str(tmp_path))

    # Must not raise — a list/run never hard-fails because the path is gone.
    refresh_filesystem_source(session, source)


# ---------------------------------------------------------------------------
# create_batch_run — task run auto-syncs filesystem sources
# ---------------------------------------------------------------------------


def test_run_auto_syncs_filesystem_source_so_new_task_runs(tmp_path, session):
    tasks_root = str(tmp_path)
    _write_task(tasks_root, "alpha", "alpha")
    source = _seed_filesystem_project(session, tasks_root)
    sync_task_source(session, source)

    _write_task(tasks_root, "beta", "beta")  # added after the last sync

    # Previously raised ValueError("No tasks found for the given selection").
    batch = create_batch_run(
        session=session,
        project=source.project,
        selection_type="task",
        task_paths=["beta"],
        task_source=source,
    )
    assert batch.total_tasks == 1


def test_run_actionable_error_mentions_sync_for_non_filesystem(tmp_path, session):
    # A git source is NOT auto-refreshed, so a missing task should point the
    # user at `project source sync` rather than the bare "No tasks found".
    import pytest

    now = datetime.now(timezone.utc)
    session.add(UserDB(id="u-git2", email="g2@test.com", name="G2",
                       password_hash="x", is_active=True))
    session.flush()
    session.add(ProjectDB(id="proj-git2", name="Git2", created_by="u-git2",
                          created_at=now, updated_at=now))
    session.flush()
    git_source = ProjectTaskSourceDB(
        id="src-git2", project="proj-git2", source_type="git", display_name="Git",
        repository_url="https://example.com/repo.git", git_ref="main",
        subpath="tasks", status="ready", last_synced_at=now,
        last_resolved_commit_sha="abc123", created_at=now, updated_at=now,
    )
    session.add(git_source)
    session.commit()
    session.refresh(git_source)

    with pytest.raises(ValueError) as exc:
        create_batch_run(
            session=session,
            project=git_source.project,
            selection_type="task",
            task_paths=["does-not-exist"],
            task_source=git_source,
        )
    assert "project source sync" in str(exc.value).lower()


def test_run_error_for_filesystem_says_rescanned(tmp_path, session):
    # A filesystem source IS auto-refreshed, so if the task is still missing it
    # genuinely isn't on disk — the message should say so (not blame the user).
    import pytest

    tasks_root = str(tmp_path)
    _write_task(tasks_root, "alpha", "alpha")
    source = _seed_filesystem_project(session, tasks_root)
    sync_task_source(session, source)

    with pytest.raises(ValueError) as exc:
        create_batch_run(
            session=session,
            project=source.project,
            selection_type="task",
            task_paths=["does-not-exist"],
            task_source=source,
        )
    msg = str(exc.value).lower()
    assert "no tasks found" in msg
    assert "project source sync" not in msg  # already auto-synced — no point suggesting it


# ---------------------------------------------------------------------------
# Route-level self-heal: GET /v1/projects/{id}/agent-tasks
# ---------------------------------------------------------------------------


def test_list_route_auto_syncs_filesystem_source(tmp_path, session, make_authed_client):
    tasks_root = str(tmp_path)
    _write_task(tasks_root, "alpha", "alpha")
    source = _seed_filesystem_project(session, tasks_root)
    sync_task_source(session, source)

    _write_task(tasks_root, "beta", "beta")  # new on disk, not synced

    client = make_authed_client("owner-fs", session)
    resp = client.get(f"/v1/projects/{source.project}/agent-tasks")
    assert resp.status_code == 200
    ids = sorted(t["id"] for t in resp.json())
    assert ids == ["alpha", "beta"]
