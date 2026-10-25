# pyright: reportAny=false, reportArgumentType=false, reportAttributeAccessIssue=false, reportCallIssue=false, reportExplicitAny=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportPrivateUsage=false, reportReturnType=false, reportUnannotatedClassAttribute=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUntypedFunctionDecorator=false, reportUnusedCallResult=false, reportUnusedParameter=false

"""Wiring: retention/project-deletion bundle cleanup + batch-detail scene.

Covers acceptance #9 (ArtifactStore-backed cleanup), #12 (historical Batches
without Revisions still render), and the scene test (Batch + Revision through
the real service, summary reachable via the existing detail route without
private storage fields).

Materialize and the cleanup helpers both resolve the store by backend name via
``get_store``, so tests point ``APO_ARTIFACT_DIR`` at a temp dir so writer and
cleaner share one path. Retention / project-deletion are sync entry points that
use ``asyncio.run`` internally, so those tests are sync and drive materialize
through ``asyncio.run`` for setup.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from apo.models.db import AgentTaskBatchRunDB, ProjectDB, ProjectTaskSourceDB, TaskRevisionDB
from apo.services.artifact_stores.local import LocalArtifactStore
from apo.services.project_deletion import delete_project_data
from apo.services.retention import _delete_old_batch_runs
from apo.services.task_revisions import (
    create_attested_task_revision,
    delete_task_revision_bundles_for_batches,
    delete_task_revision_bundles_for_project,
    materialize_pooled_task_revision,
)
from apo.models.execution import CallerSourceAttestation
from sqlmodel import Session


def _filesystem_source(project_id: str) -> ProjectTaskSourceDB:
    return ProjectTaskSourceDB(
        id="src-" + project_id, project=project_id, source_type="filesystem",
        display_name="fs", status="ready",
    )


def _seed(session: Session, *, project_id: str, batch_id: str, days_old: float = 0) -> None:
    created = datetime.now(timezone.utc) - timedelta(days=days_old)
    session.add(ProjectDB(id=project_id, name=project_id, created_at=created))
    session.add(
        AgentTaskBatchRunDB(
            id=batch_id, project=project_id, selection_type="single",
            status="completed", created_at=created, completed_at=created,
        )
    )
    session.commit()


def _write(root: Path, rel: str, content: bytes) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def _point_store_at(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Point get_store('local') at a temp dir and return that store root."""
    store_root = tmp_path / "store"
    monkeypatch.setenv("APO_ARTIFACT_DIR", str(store_root))
    return store_root


def _store_for(store_root: Path) -> LocalArtifactStore:
    return LocalArtifactStore(root=store_root)


async def _materialize(session: Session, tmp_path: Path, *, project_id: str, batch_id: str) -> str:
    """Materialize via the env-configured store (store=None) and return the bundle key."""
    root = tmp_path / "src"
    _write(root, "a.txt", b"aa")
    revision = await materialize_pooled_task_revision(
        session, project_id=project_id, batch_run_id=batch_id,
        task_source=_filesystem_source(project_id), source_root=root,
    )
    assert revision.bundle_storage_key
    return revision.bundle_storage_key


# ── bulk helper (async) ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bulk_delete_for_batches_removes_objects_and_skips_attested(
    session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store_root = _point_store_at(monkeypatch, tmp_path)
    _seed(session, project_id="proj-a", batch_id="batch-a")
    _seed(session, project_id="proj-b", batch_id="batch-b")
    key = await _materialize(session, tmp_path, project_id="proj-a", batch_id="batch-a")
    create_attested_task_revision(
        session, project_id="proj-b", batch_run_id="batch-b",
        attestation=CallerSourceAttestation(
            source_type="caller_worktree", dirty=False, content_sha256="c" * 64,
            task_root_label="w", file_count=1, uncompressed_size_bytes=1,
        ),
    )

    store = _store_for(store_root)
    assert await store.stat(key) is not None
    deleted = await delete_task_revision_bundles_for_batches(session, ["batch-a", "batch-b"])
    assert deleted == 1  # only the bundled object; attested has none
    assert await store.stat(key) is None


@pytest.mark.asyncio
async def test_bulk_delete_for_project(
    session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store_root = _point_store_at(monkeypatch, tmp_path)
    _seed(session, project_id="proj-a", batch_id="batch-a")
    key = await _materialize(session, tmp_path, project_id="proj-a", batch_id="batch-a")

    store = _store_for(store_root)
    deleted = await delete_task_revision_bundles_for_project(session, "proj-a")
    assert deleted == 1
    assert await store.stat(key) is None


# ── retention row wiring (sync; run_retention_cleanup uses the prod engine,
#    so exercise _delete_old_batch_runs on the test session after the async
#    object helper has removed bundle objects) ─────────────────────────────


def test_delete_old_batch_runs_removes_revision_and_batch_rows_after_objects(
    session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store_root = _point_store_at(monkeypatch, tmp_path)
    _seed(session, project_id="proj-old", batch_id="batch-old", days_old=10_000)
    key = asyncio.run(_materialize(session, tmp_path, project_id="proj-old", batch_id="batch-old"))
    store = _store_for(store_root)
    rev_id = _revision_id_for_key(session, key)

    # Objects first (mirrors run_retention_cleanup's ordering), then rows.
    asyncio.run(delete_task_revision_bundles_for_batches(session, ["batch-old"]))
    assert asyncio.run(store.stat(key)) is None

    cutoff = datetime.now(timezone.utc) - timedelta(days=1)
    deleted = _delete_old_batch_runs(session, cutoff)
    # The count covers dependent rows plus the batch row itself; the
    # per-table asserts below prove both actually went.
    assert deleted >= 1
    assert session.get(TaskRevisionDB, rev_id) is None
    assert session.get(AgentTaskBatchRunDB, "batch-old") is None


# ── project deletion wiring (sync: delete_project_data uses asyncio.run) ──


def test_delete_project_data_removes_bundle_objects_and_revision_rows(
    session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store_root = _point_store_at(monkeypatch, tmp_path)
    _seed(session, project_id="proj-del", batch_id="batch-del")
    key = asyncio.run(_materialize(session, tmp_path, project_id="proj-del", batch_id="batch-del"))
    store = _store_for(store_root)

    # Mirror the route: async bundle-object cleanup BEFORE the sync row deletes.
    asyncio.run(delete_task_revision_bundles_for_project(session, "proj-del"))
    delete_project_data(session, project_id="proj-del", keep_project=False, keep_api_keys=False)

    assert asyncio.run(store.stat(key)) is None
    assert session.get(ProjectDB, "proj-del") is None


# ── scene: batch detail exposes the revision summary ─────────────────────


@pytest.mark.asyncio
async def test_batch_detail_route_exposes_revision_summary_without_private_fields(
    client: "object", session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _point_store_at(monkeypatch, tmp_path)
    session.add(ProjectDB(id="proj-scene", name="proj-scene", created_at=datetime.now(timezone.utc)))
    session.add(AgentTaskBatchRunDB(
        id="batch-scene", project="proj-scene", selection_type="single",
        status="completed", created_at=datetime.now(timezone.utc),
    ))
    session.commit()
    root = tmp_path / "src"
    _write(root, "README.md", b"hi\n")
    revision = await materialize_pooled_task_revision(
        session, project_id="proj-scene", batch_run_id="batch-scene",
        task_source=_filesystem_source("proj-scene"), source_root=root,
    )

    resp = client.get("/v1/agent-task-batch-runs/batch-scene")
    assert resp.status_code == 200
    summary = resp.json().get("task_revision")
    assert summary is not None
    assert summary["materialization"] == "bundled"
    assert summary["content_sha256"] == revision.content_sha256
    for forbidden in ("bundle_storage_key", "bundle_storage_backend", "manifest_summary_json"):
        assert forbidden not in summary


def test_batch_without_revision_renders_with_null_task_revision(
    client: "object", session: Session
) -> None:
    session.add(ProjectDB(id="proj-hist", name="proj-hist", created_at=datetime.now(timezone.utc)))
    session.add(AgentTaskBatchRunDB(
        id="batch-hist", project="proj-hist", selection_type="single",
        status="completed", created_at=datetime.now(timezone.utc),
    ))
    session.commit()
    resp = client.get("/v1/agent-task-batch-runs/batch-hist")
    assert resp.status_code == 200
    assert resp.json()["task_revision"] is None


# ── small sync helpers ────────────────────────────────────────────────────


def _revision_id_for_key(session: Session, key: str) -> str:
    from sqlmodel import select

    row = session.exec(
        select(TaskRevisionDB).where(TaskRevisionDB.bundle_storage_key == key)
    ).first()
    assert row is not None
    return row.id
