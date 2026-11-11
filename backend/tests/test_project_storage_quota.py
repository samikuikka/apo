# pyright: reportAny=false, reportAttributeAccessIssue=false, reportDeprecated=false, reportExplicitAny=false, reportImplicitStringConcatenation=false, reportMissingParameterType=false, reportOptionalMemberAccess=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedFunction=false, reportUnusedParameter=false

"""Project-level storage quota (APO_PROJECT_DAILY_STORAGE_QUOTA).

Covers: artifact intents and JSON deliverables share one per-project
daily byte budget across runs, evidence parts count into the same
budget, user-isolation between projects, default-off behavior, the
idempotent-intent no-double-count rule, the fail-open read when the
rollup table is absent, and the v64 migration seam.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Iterator
from datetime import datetime, timezone

import pytest
from _pytest.monkeypatch import MonkeyPatch
from fastapi import HTTPException
from sqlmodel import Session, text

from apo.db import engine as file_engine
from apo.db import reset_apo_file_db
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDailyUsageDB,
    ProjectDB,
    TaskExecutionAttemptDB,
)
from apo.services.agent_task_deliverables import (
    create_artifact_upload_intent,
    persist_json_deliverable,
)
from apo.services.artifact_stores.local import LocalArtifactStore
from apo.services.result_evidence import create_result_evidence_intent
from apo.services import storage_quota

NOW = datetime.now(timezone.utc)


@pytest.fixture(autouse=True)
def _fresh_storage_cache() -> Iterator[None]:
    storage_quota._today_bytes.clear()
    yield
    storage_quota._today_bytes.clear()


@pytest.fixture(autouse=True)
def _storage_quota_off_by_default(monkeypatch: MonkeyPatch) -> Iterator[None]:
    monkeypatch.delenv("APO_PROJECT_DAILY_STORAGE_QUOTA", raising=False)
    yield


@pytest.fixture(autouse=True)
def setup_database(tmp_path) -> Iterator[None]:
    reset_apo_file_db()
    yield
    with Session(file_engine) as session:
        for table in (
            "project_daily_usage",
            "agent_task_result_evidence",
            "task_execution_attempts",
            "agent_task_deliverables",
            "agent_task_runs",
            "agent_task_batch_runs",
            "projects",
        ):
            session.execute(text(f"DELETE FROM {table}"))
        session.commit()


@pytest.fixture
def store(tmp_path) -> LocalArtifactStore:
    s = LocalArtifactStore(root=tmp_path / "store")
    asyncio.run(s.check_ready())
    return s


def _seed_project(session: Session, project_id: str) -> None:
    # Commit, not flush: record_project_storage owns its own transaction on
    # the same engine, so the project row must be visible to it for the
    # rollup's FK to hold (production projects are long-committed).
    session.add(ProjectDB(id=project_id, name=project_id, created_at=NOW))
    session.commit()


def _seed_run(session: Session, run_id: str, project: str) -> None:
    # Commit, not flush: record_project_storage opens its own write
    # transaction on the same engine, and SQLite allows one writer; an
    # open flushed transaction here would deadlock it (production rows
    # are always committed long before a request starts).
    session.add(
        AgentTaskBatchRunDB(
            id=f"batch-{run_id}", project=project, selection_type="manual", status="completed"
        )
    )
    session.add(
        AgentTaskRunDB(
            id=run_id,
            batch_run_id=f"batch-{run_id}",
            task_id="t",
            task_path="p",
            status="running",
        )
    )
    session.commit()


def _seed_attempt(session: Session, run_id: str, project: str) -> TaskExecutionAttemptDB:
    attempt = TaskExecutionAttemptDB(
        id=f"att-{run_id}",
        project=project,
        batch_run_id=f"batch-{run_id}",
        task_run_id=run_id,
        sequence_index=0,
        target_kind="caller",
        status="running",
        queue_expires_at=NOW,
        queued_at=NOW,
    )
    session.add(attempt)
    session.commit()
    return attempt


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


pytestmark = pytest.mark.asyncio


async def _intent(
    session: Session,
    store: LocalArtifactStore,
    *,
    project: str,
    run_id: str,
    name: str,
    size: int,
) -> object:
    return await create_artifact_upload_intent(
        session,
        store,
        project=project,
        task_run_id=run_id,
        name=name,
        display_filename=f"{name}.bin",
        media_type="application/octet-stream",
        size_bytes=size,
        sha256=_sha(b"x" * 8),
    )


def _assert_storage_exceeded(exc_info: pytest.ExceptionInfo[HTTPException]) -> None:
    assert exc_info.value.status_code == 429
    assert "project" in str(exc_info.value.detail)


class TestArtifactIntents:
    async def test_intents_across_runs_share_project_budget(
        self, store: LocalArtifactStore, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_PROJECT_DAILY_STORAGE_QUOTA", "1000")
        with Session(file_engine) as session:
            _seed_project(session, "p1")
            _seed_run(session, "run-1", "p1")
            _seed_run(session, "run-2", "p1")

            await _intent(session, store, project="p1", run_id="run-1", name="a", size=600)
            # A different run, same project: 600 + 500 > 1000.
            with pytest.raises(HTTPException) as exc_info:
                await _intent(
                    session, store, project="p1", run_id="run-2", name="b", size=500
                )
            _assert_storage_exceeded(exc_info)

            usage = storage_quota.today_project_storage(session, "p1")
            assert usage is not None and usage["bytes"] == 600

    async def test_other_project_unaffected(
        self, store: LocalArtifactStore, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_PROJECT_DAILY_STORAGE_QUOTA", "1000")
        with Session(file_engine) as session:
            _seed_project(session, "p1")
            _seed_project(session, "p2")
            _seed_run(session, "run-1", "p1")
            _seed_run(session, "run-2", "p2")

            await _intent(session, store, project="p1", run_id="run-1", name="a", size=900)
            # p1 is nearly full; p2 has its own budget.
            await _intent(session, store, project="p2", run_id="run-2", name="a", size=900)

    async def test_off_by_default_accepts_everything(self, store: LocalArtifactStore) -> None:
        with Session(file_engine) as session:
            _seed_project(session, "p1")
            _seed_run(session, "run-1", "p1")
            await _intent(session, store, project="p1", run_id="run-1", name="a", size=10_000_000)
            await _intent(session, store, project="p1", run_id="run-1", name="b", size=10_000_000)

    async def test_idempotent_intent_does_not_double_count(
        self, store: LocalArtifactStore, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_PROJECT_DAILY_STORAGE_QUOTA", "1000")
        with Session(file_engine) as session:
            _seed_project(session, "p1")
            _seed_run(session, "run-1", "p1")

            first = await _intent(
                session, store, project="p1", run_id="run-1", name="a", size=600
            )
            second = await _intent(
                session, store, project="p1", run_id="run-1", name="a", size=600
            )
            assert first.id == second.id  # idempotent return, not a new row

            usage = storage_quota.today_project_storage(session, "p1")
            assert usage is not None and usage["bytes"] == 600


class TestJsonDeliverables:
    async def test_json_counts_into_project_budget(
        self, store: LocalArtifactStore, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_PROJECT_DAILY_STORAGE_QUOTA", "100")
        # payload sized so its compact JSON body lands between 60 and 100 bytes
        payload = "x" * 70
        with Session(file_engine) as session:
            _seed_project(session, "p1")
            _seed_run(session, "run-1", "p1")

            row = await persist_json_deliverable(
                session, project="p1", task_run_id="run-1", name="v1", value=payload, store=store
            )
            assert 60 < row.size_bytes <= 100

            _seed_run(session, "run-2", "p1")
            with pytest.raises(HTTPException) as exc_info:
                await persist_json_deliverable(
                    session, project="p1", task_run_id="run-2", name="v2", value=payload, store=store
                )
            _assert_storage_exceeded(exc_info)


class TestEvidenceParts:
    async def test_evidence_counts_into_project_budget(
        self, store: LocalArtifactStore, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_PROJECT_DAILY_STORAGE_QUOTA", "1000")
        with Session(file_engine) as session:
            _seed_project(session, "p1")
            _seed_run(session, "run-1", "p1")
            attempt = _seed_attempt(session, "run-1", "p1")

            await create_result_evidence_intent(
                session,
                store,
                attempt=attempt,
                slot="transcript",
                deliverable_name=None,
                size_bytes=600,
                sha256=_sha(b"y" * 8),
            )
            with pytest.raises(HTTPException) as exc_info:
                await create_result_evidence_intent(
                    session,
                    store,
                    attempt=attempt,
                    slot="checks",
                    deliverable_name=None,
                    size_bytes=600,
                    sha256=_sha(b"z" * 8),
                )
            _assert_storage_exceeded(exc_info)


class TestAccounting:
    async def test_record_survives_missing_table(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("APO_PROJECT_DAILY_STORAGE_QUOTA", "1000")
        with Session(file_engine) as session:
            session.execute(text("DROP TABLE project_daily_usage"))
            session.commit()

            # Fail open: enforcement reads 0 instead of erroring, and the
            # record write is dropped without raising.
            await storage_quota.record_project_storage(session, "p1", size_bytes=10)
            assert (
                storage_quota.enforce_project_storage_quota(
                    session, project_id="p1", pending_bytes=10
                )
                is None
            )

            session.execute(
                text(
                    "CREATE TABLE project_daily_usage (project_id VARCHAR(36), "
                    "day VARCHAR(10), byte_count INTEGER DEFAULT 0, "
                    "request_count INTEGER DEFAULT 0, updated_at DATETIME, "
                    "PRIMARY KEY (project_id, day))"
                )
            )
            session.commit()

    async def test_rollup_row_written(self) -> None:
        with Session(file_engine) as session:
            _seed_project(session, "p1")
            await storage_quota.record_project_storage(session, "p1", size_bytes=100)
            await storage_quota.record_project_storage(session, "p1", size_bytes=50)
            row = session.get(ProjectDailyUsageDB, ("p1", NOW.strftime("%Y-%m-%d")))
            assert row is not None
            assert row.byte_count == 150
            assert row.request_count == 2


class TestV64Seam:
    def test_rerun_safe(self) -> None:
        import apo.models.db as mdb
        from apo.db import _migrate_to_v64, engine

        mdb.SQLModel.metadata.create_all(engine)
        _migrate_to_v64()
        _migrate_to_v64()  # must not raise
