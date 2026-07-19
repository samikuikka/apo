"""Demo task inventory must use folder-scoped task ids.

The demo project's inventory is seeded once from the bundled
example-service workspace and never re-synced (the sync endpoint rejects
the demo project). A previous seed produced full-relative-path ids like
``e2e/agent-task-demo/tasks/<agent>/<task>`` instead of the
folder-scoped ``<agent>/<task>`` form that ``discover_agent_tasks``
produces and that ``agent_task_runs.task_id`` stores. Those two schemes
never overlap, so the join that attaches run stats to inventory rows
silently dropped every demo run from the UI.

These tests pin two things:

1. Fresh discovery produces folder-scoped ids (the canonical scheme).
2. ``ensure_demo_task_source`` repairs an existing demo inventory whose
   ids don't match discovery, so already-corrupted deployments self-heal
   on the next startup.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlmodel import Session, select

from apo.models.db import ProjectDB, ProjectTaskInventoryDB, ProjectTaskSourceDB
from apo.services.agent_task_discovery import discover_agent_tasks
from apo.services.paths import demo_task_root
from apo.services.project_task_inventory import list_inventory_for_project
from apo.services.project_task_sources import (
    DEMO_PROJECT_ID,
    ensure_demo_task_source,
)


def _seed_demo_project(session: Session) -> ProjectTaskSourceDB:
    """Create the demo project + a ready demo source row (no inventory)."""
    now = datetime.now(timezone.utc)
    session.add(
        ProjectDB(
            id=DEMO_PROJECT_ID,
            name="Demo workspace",
            created_by=None,
            created_at=now,
            updated_at=now,
        )
    )
    source = ProjectTaskSourceDB(
        id="src-demo",
        project=DEMO_PROJECT_ID,
        source_type="demo",
        display_name="Demo workspace",
        demo_seed_id="example-service",
        status="ready",
        last_synced_at=now,
        created_at=now,
        updated_at=now,
    )
    session.add(source)
    session.commit()
    session.refresh(source)
    return source


def test_discover_agent_tasks_produces_folder_scoped_ids() -> None:
    """Discovery ids must be relative to the tasks root, not the repo root.

    This is the canonical scheme every other table (runs, inventory)
    keys off, so a regression here would desync the whole task UI.
    """
    tasks = discover_agent_tasks(demo_task_root())
    assert tasks, "expected the bundled demo workspace to yield tasks"

    for task in tasks:
        # Folder-scoped ids never include the workspace path prefix…
        assert "e2e/agent-task-demo/tasks/" not in task.id
        # …and the id is the folder path + bare task name.
        if task.folder_path:
            assert task.id == f"{task.folder_path}/{task.display_name}"
        else:
            assert task.id == task.display_name


def test_ensure_demo_task_source_repairs_corrupted_inventory(
    session: Session,
) -> None:
    """A demo inventory seeded with the wrong id scheme gets re-seeded.

    Simulates the corruption: write inventory rows whose task ids carry
    the full relative path, then call ``ensure_demo_task_source``. The
    rows should be replaced with discovery's folder-scoped ids.
    """
    source = _seed_demo_project(session)
    now = datetime.now(timezone.utc)

    discovered = discover_agent_tasks(demo_task_root())
    assert discovered, "test requires the bundled demo workspace"

    # Corrupt form: prefix every id with the workspace-relative path,
    # mirroring the original bug.
    corruption_prefix = "e2e/agent-task-demo/tasks/"
    for task in discovered:
        session.add(
            ProjectTaskInventoryDB(
                project=DEMO_PROJECT_ID,
                task_source_id=source.id,
                task_id=f"{corruption_prefix}{task.id}",
                display_name=task.display_name,
                adapter_name=task.adapter_name,
                folder_path=task.folder_path,
                task_path=task.task_path,
                source_type="demo",
                source_ref=source.demo_seed_id,
                source_commit_sha=None,
                source_subpath=None,
                discovered_at=now,
            )
        )
    session.commit()

    ensure_demo_task_source(session)

    expected_ids = {task.id for task in discovered}
    repaired_ids = {
        row.task_id
        for row in list_inventory_for_project(session, DEMO_PROJECT_ID)
    }
    assert repaired_ids == expected_ids
    # And none of the corrupted form survives.
    assert not any(corruption_prefix in tid for tid in repaired_ids)


def test_ensure_demo_task_source_leaves_clean_inventory_untouched(
    session: Session,
) -> None:
    """A demo inventory that already matches discovery is not rewritten.

    Guards against the repair path doing needless work (or churning the
    ``discovered_at`` timestamps) on every startup once healed.
    """
    _ = _seed_demo_project(session)
    # First call seeds the inventory from discovery.
    ensure_demo_task_source(session)
    ids_after_first = sorted(
        row.task_id
        for row in session.exec(
            select(ProjectTaskInventoryDB).where(
                ProjectTaskInventoryDB.project == DEMO_PROJECT_ID
            )
        ).all()
    )
    discovered_at_after_first = {
        row.task_id: row.discovered_at
        for row in session.exec(
            select(ProjectTaskInventoryDB).where(
                ProjectTaskInventoryDB.project == DEMO_PROJECT_ID
            )
        ).all()
    }

    # Second call should be a no-op on the inventory.
    ensure_demo_task_source(session)
    ids_after_second = sorted(
        row.task_id
        for row in session.exec(
            select(ProjectTaskInventoryDB).where(
                ProjectTaskInventoryDB.project == DEMO_PROJECT_ID
            )
        ).all()
    )
    discovered_at_after_second = {
        row.task_id: row.discovered_at
        for row in session.exec(
            select(ProjectTaskInventoryDB).where(
                ProjectTaskInventoryDB.project == DEMO_PROJECT_ID
            )
        ).all()
    }

    assert ids_after_first == ids_after_second
    assert discovered_at_after_first == discovered_at_after_second
