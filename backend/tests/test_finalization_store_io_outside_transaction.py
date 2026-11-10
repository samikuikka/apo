# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

"""Deliverable placement must not run inside SQLite's write transaction.

A result can carry deliverables of up to 100 MiB each. Each one is
compressed and written to the artifact store, which takes seconds. SQLite
has one write lock for the whole installation, so if a write transaction is
open on the finalizing session while that happens, every other writer
(heartbeats, OTLP accepts, other tenants' results) waits for it.

The transaction used to open by accident: persisting the second deliverable
ran a SELECT, which autoflushed the first deliverable's pending INSERT.
From then on compression and store writes ran under the write lock until
finalization committed. These tests watch the session from inside the store.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlmodel import Session, col, select, text

import apo.services.execution_finalization as fin
from apo.db import engine, reset_apo_file_db
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskDeliverableDB,
    AgentTaskRunDB,
    ProjectDB,
    TaskExecutionAttemptDB,
)
from apo.services.agent_task_deliverables import (
    INLINE_THRESHOLD_BYTES,
    persist_json_deliverable,
)
from apo.services.artifact_store import ArtifactStat, StoredArtifact
from apo.services.execution_finalization import (
    AttemptResultBody,
    finalize_attempt_with_deliverables,
)
from apo.services.execution_leases import CurrentAttemptLease

PROJECT = "store-io"
RUN_ID = "run-store-io"
ATTEMPT_ID = "att-store-io"
LEASE = CurrentAttemptLease(attempt_id=ATTEMPT_ID, lease_generation=1, executor_id="")
# Two values above the inline threshold (so each goes through the store) and
# one below it.
DELIVERABLES: dict[str, object] = {
    "report": "r" * (INLINE_THRESHOLD_BYTES + 4096),
    "transcript": "t" * (INLINE_THRESHOLD_BYTES + 8192),
    "verdict": {"score": 1},
}


@pytest.fixture(autouse=True)
def leased_attempt():
    reset_apo_file_db()
    _seed_leased_attempt()
    yield
    # Children first: the file database enforces foreign keys.
    with Session(engine) as session:
        for statement in (
            "DELETE FROM agent_task_deliverables WHERE task_run_id = :run",
            "DELETE FROM task_execution_attempts WHERE task_run_id = :run",
            "DELETE FROM agent_task_check_reports WHERE run_id = :run",
            "DELETE FROM agent_task_runs WHERE id = :run",
            "DELETE FROM agent_task_batch_runs WHERE project = :project",
            "DELETE FROM project_daily_usage WHERE project_id = :project",
            "DELETE FROM projects WHERE id = :project",
        ):
            session.execute(text(statement), {"run": RUN_ID, "project": PROJECT})
        session.commit()


async def test_result_deliverables_are_stored_before_the_write_transaction(
    monkeypatch: MonkeyPatch,
) -> None:
    with Session(engine) as session:
        store = _use_recording_store(monkeypatch, session)

        attempt = await finalize_attempt_with_deliverables(
            session,
            lease=LEASE,
            body=AttemptResultBody(completion_id="c-1", pass_result=True),
            deliverables=DELIVERABLES,
        )

        assert attempt is not None and attempt.status == "succeeded"

    assert store.transaction_open_at_put == [False, False], (
        "a store write ran inside the finalizing session's write transaction"
    )
    rows = _deliverable_rows()
    assert sorted(rows) == ["report", "transcript", "verdict"]
    assert {rows["report"].storage_key, rows["transcript"].storage_key} == set(
        store.objects
    )
    assert rows["verdict"].inline_value_json == {"value": {"score": 1}}


async def test_interrupted_finalize_loses_nothing_and_the_retry_records_once(
    monkeypatch: MonkeyPatch,
) -> None:
    """Objects first, rows with the terminal state: a failure between the two
    leaves no row behind, and the executor's retry of the same completion
    records every deliverable exactly once."""
    body = AttemptResultBody(completion_id="c-retry", pass_result=True)

    def explode(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("finalization interrupted")

    with Session(engine) as session, monkeypatch.context() as patched:
        _use_recording_store(patched, session)
        patched.setattr(fin, "finalize_task_run_with_result", explode)
        with pytest.raises(RuntimeError, match="finalization interrupted"):
            await finalize_attempt_with_deliverables(
                session, lease=LEASE, body=body, deliverables=DELIVERABLES
            )

    assert _deliverable_rows() == {}
    with Session(engine) as session:
        attempt = session.get(TaskExecutionAttemptDB, ATTEMPT_ID)
        assert attempt is not None and attempt.status == "running"

    with Session(engine) as session:
        store = _use_recording_store(monkeypatch, session)
        attempt = await finalize_attempt_with_deliverables(
            session, lease=LEASE, body=body, deliverables=DELIVERABLES
        )
        assert attempt is not None and attempt.status == "succeeded"

    assert store.transaction_open_at_put == [False, False]
    assert sorted(_deliverable_rows()) == ["report", "transcript", "verdict"]

    # The same completion again is a replay: nothing is stored or recorded.
    with Session(engine) as session:
        replay_store = _use_recording_store(monkeypatch, session)
        replayed = await finalize_attempt_with_deliverables(
            session, lease=LEASE, body=body, deliverables=DELIVERABLES
        )
    assert replayed is None
    assert replay_store.transaction_open_at_put == []
    assert len(_deliverable_rows()) == 3


async def test_persisting_deliverables_never_opens_a_write_transaction() -> None:
    """The shared persist helper is safe for any caller that loops it."""
    with Session(engine) as session:
        store = RecordingStore(session)
        for name in ("report", "transcript"):
            await persist_json_deliverable(
                session,
                project=PROJECT,
                task_run_id=RUN_ID,
                name=name,
                value=DELIVERABLES[name],
                store=store,
            )
        assert store.transaction_open_at_put == [False, False]
        assert not _write_transaction_open(session)
        session.commit()

    assert sorted(_deliverable_rows()) == ["report", "transcript"]


async def test_rows_pending_on_the_session_still_claim_names_and_bytes(
    monkeypatch: MonkeyPatch,
) -> None:
    """Unflushed rows used to be seen through autoflush; the checks that
    relied on it must still see them."""
    first = "a" * 4096
    monkeypatch.setenv("APO_ARTIFACT_MAX_RUN_BYTES", str(len(first) + 2 + 1024))
    with Session(engine) as session:
        store = RecordingStore(session)
        await persist_json_deliverable(
            session, project=PROJECT, task_run_id=RUN_ID, name="one",
            value=first, store=store,
        )
        with pytest.raises(ValueError, match="already exists"):
            await persist_json_deliverable(
                session, project=PROJECT, task_run_id=RUN_ID, name="one",
                value="again", store=store,
            )
        with pytest.raises(ValueError, match="total Deliverable byte limit"):
            await persist_json_deliverable(
                session, project=PROJECT, task_run_id=RUN_ID, name="two",
                value="b" * 2048, store=store,
            )


class RecordingStore:
    """An artifact store that notes, at every write, whether the watched
    session had a transaction open."""

    name: str = "recording"

    def __init__(self, session: Session) -> None:
        self._session: Session = session
        self.transaction_open_at_put: list[bool] = []
        self.objects: dict[str, bytes] = {}

    async def put(
        self,
        key: str,
        chunks: AsyncIterator[bytes],
        *,
        expected_size: int,
        expected_sha256: str,
    ) -> StoredArtifact:
        self.transaction_open_at_put.append(_write_transaction_open(self._session))
        data = b"".join([chunk async for chunk in chunks])
        assert len(data) == expected_size
        self.objects[key] = data
        return StoredArtifact(
            backend=self.name, key=key, size_bytes=len(data), sha256=expected_sha256
        )

    async def open(self, key: str) -> AsyncIterator[bytes]:
        yield self.objects[key]

    async def stat(self, key: str) -> ArtifactStat | None:
        data = self.objects.get(key)
        return None if data is None else ArtifactStat(size_bytes=len(data), sha256=None)

    async def delete(self, key: str) -> None:
        self.objects.pop(key, None)

    async def check_ready(self) -> tuple[bool, str | None]:
        return True, None


def _write_transaction_open(session: Session) -> bool:
    """True when the session's SQLite connection is inside a transaction.

    The driver begins one only for a write or an explicit BEGIN, never for a
    plain SELECT, so an open transaction here means this connection holds
    SQLite's write lock or is about to take it.
    """
    return bool(session.connection().connection.in_transaction)


def _use_recording_store(
    monkeypatch: MonkeyPatch, session: Session
) -> RecordingStore:
    store = RecordingStore(session)
    monkeypatch.setattr(
        "apo.services.artifact_stores.registry.get_store", lambda _name=None: store
    )
    return store


def _deliverable_rows() -> dict[str, AgentTaskDeliverableDB]:
    with Session(engine) as session:
        rows = session.exec(
            select(AgentTaskDeliverableDB).where(
                col(AgentTaskDeliverableDB.task_run_id) == RUN_ID
            )
        ).all()
        return {row.name: row for row in rows}


def _seed_leased_attempt() -> None:
    now = datetime.now(timezone.utc)
    with Session(engine) as session:
        session.add(ProjectDB(id=PROJECT, name=PROJECT, created_at=now))
        session.flush()
        session.add(
            AgentTaskBatchRunDB(
                id="batch-store-io",
                project=PROJECT,
                selection_type="tasks",
                status="queued",
                execution_target_json={"kind": "source_owned"},
                created_at=now,
            )
        )
        session.flush()
        session.add(
            AgentTaskRunDB(
                id=RUN_ID,
                batch_run_id="batch-store-io",
                task_id="t",
                task_path="p",
                sequence_index=0,
                status="running",
            )
        )
        session.flush()
        session.add(
            TaskExecutionAttemptDB(
                id=ATTEMPT_ID,
                project=PROJECT,
                batch_run_id="batch-store-io",
                task_run_id=RUN_ID,
                sequence_index=0,
                target_kind="caller",
                assignment_kind="caller",
                status="running",
                phase="running",
                queue_expires_at=now + timedelta(hours=24),
                queued_at=now,
                claimed_at=now,
                started_at=now,
                heartbeat_at=now,
                lease_generation=1,
                lease_expires_at=now + timedelta(minutes=5),
            )
        )
        session.commit()
