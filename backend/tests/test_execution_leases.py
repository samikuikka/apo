# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false

"""Execution_leases — atomic claim, start/heartbeat fencing, reaper.

Covers acceptance tests #1 (race), #2 (scope), #4 (capacity from DB), #5
(sequential Batch), #6 (pre-start requeue), #7 (post-start lost), #8 (stale
generation), #13 (cancellation idempotent), #15 (reaper leaves terminal rows).
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Barrier
from uuid import uuid4

import pytest
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ExecutorDB,
    ExecutorPoolDB,
    ProjectDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
)
from apo.services.execution_leases import (
    CurrentAttemptLease,
    LeaseError,
    claim_next_attempt,
    heartbeat_attempt,
    recover_expired_attempts,
    request_cancellation,
    start_attempt,
)
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlmodel import Session, SQLModel, create_engine


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _seed(
    session: Session,
    *,
    project_id: str = "proj-x",
    pool_id: str = "pool-1",
    executor_id: str | None = "ex-1",
    batch_id: str = "batch-x",
    sequence_indices: list[int] | None = None,
    statuses: list[str] | None = None,
) -> list[TaskExecutionAttemptDB]:
    """Seed project+pool+batch+revision+executor and N attempts (one per run)."""
    session.add(ProjectDB(id=project_id, name=project_id, created_at=_now()))
    session.flush()
    session.add(ExecutorPoolDB(
        id=pool_id, project=project_id, name="P", slug=pool_id, kind="connected",
        enabled=True, required_driver_kind="subprocess", created_at=_now(), updated_at=_now(),
    ))
    session.flush()
    session.add(AgentTaskBatchRunDB(
        id=batch_id, project=project_id, selection_type="single", status="queued",
        created_at=_now(),
    ))
    session.flush()
    session.add(TaskRevisionDB(
        id=f"rev-{batch_id}", project=project_id, batch_run_id=batch_id, materialization="bundled",
        source_type="filesystem", content_sha256="c" * 64, file_count=1,
        uncompressed_size_bytes=1, manifest_summary_json={"fileCount": 1}, created_at=_now(),
    ))
    session.flush()
    if executor_id is not None:
        session.add(ExecutorDB(
            id=executor_id, scope_kind="pool", project=project_id, executor_pool_id=pool_id,
            name="exec", credential_prefix="apo_ex_x", credential_hash="h" + executor_id,
            protocol_version=1, executor_version="v", driver_kinds_json=["subprocess"],
            max_concurrency=1, enrolled_at=_now(), created_at=_now(), updated_at=_now(),
        ))
        session.flush()

    indices = sequence_indices if sequence_indices is not None else [0]
    statuses = statuses if statuses is not None else ["queued"] * len(indices)
    attempts: list[TaskExecutionAttemptDB] = []
    for i, idx in enumerate(indices):
        run_id = f"run-{batch_id}-{idx}"
        session.add(AgentTaskRunDB(
            id=run_id, batch_run_id=batch_id, task_id=f"t{idx}", task_path=f"t{idx}",
            sequence_index=idx, status="pending", created_at=_now(),
        ))
        session.flush()
        att = TaskExecutionAttemptDB(
            id=f"att-{batch_id}-{idx}", project=project_id, batch_run_id=batch_id, task_run_id=run_id,
            task_revision_id=f"rev-{batch_id}", sequence_index=idx, target_kind="pool",
            executor_pool_id=pool_id, status=statuses[i], queue_expires_at=_now() + timedelta(hours=1),
            queued_at=_now(),
        )
        session.add(att)
        attempts.append(att)
    session.commit()
    return attempts


def _executor(session: Session, executor_id: str) -> ExecutorDB:
    return session.get(ExecutorDB, executor_id)  # type: ignore[return-value]


# ── atomic claim ──────────────────────────────────────────────────────────


def test_claim_returns_oldest_queued_attempt_in_scope(session: Session) -> None:
    _seed(session, sequence_indices=[0, 1, 2])
    claimed = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    assert claimed is not None
    assert claimed.attempt.id == "att-batch-x-0"
    assert claimed.attempt.status == "leased"
    assert claimed.lease.lease_generation == 1


def test_two_executors_race_one_attempt_only_one_wins(session: Session) -> None:
    _seed(session, sequence_indices=[0])
    a = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    # second claim (same or another executor) finds nothing left
    none = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    assert a is not None
    assert none is None


def test_sqlite_real_concurrent_claim_race_has_one_winner(tmp_path: Path) -> None:
    engine = _create_sqlite_race_engine(tmp_path)
    try:
        with Session(engine) as setup:
            _seed(setup, sequence_indices=[0])
            setup.add(
                ExecutorDB(
                    id="ex-2",
                    scope_kind="pool",
                    project="proj-x",
                    executor_pool_id="pool-1",
                    name="exec-2",
                    credential_prefix="apo_ex_2",
                    credential_hash="hex-2",
                    protocol_version=1,
                    executor_version="v",
                    driver_kinds_json=["subprocess"],
                    max_concurrency=1,
                    enrolled_at=_now(),
                    created_at=_now(),
                    updated_at=_now(),
                )
            )
            setup.commit()

        winners = _race_claims(engine, ["ex-1", "ex-2"])
        assert sum(winner is not None for winner in winners) == 1
        assert {winner for winner in winners if winner is not None} == {
            "att-batch-x-0"
        }
    finally:
        engine.dispose()


def test_sqlite_concurrent_claims_cannot_exceed_executor_capacity(
    tmp_path: Path,
) -> None:
    engine = _create_sqlite_race_engine(tmp_path)
    try:
        with Session(engine) as setup:
            _seed(setup, sequence_indices=[0])
            _seed_second_batch_attempt(setup)

        winners = _race_claims(engine, ["ex-1", "ex-1"])
        assert sum(winner is not None for winner in winners) == 1
    finally:
        engine.dispose()


@pytest.mark.parametrize("capacity_race", [False, True], ids=["one-attempt", "executor-capacity"])
def test_postgres_concurrent_claim_guarantees(capacity_race: bool) -> None:
    database_url = os.environ.get("APO_TEST_POSTGRES_URL")
    if database_url is None:
        pytest.skip("set APO_TEST_POSTGRES_URL to run the PostgreSQL concurrency gate")

    schema = f"claim_race_{uuid4().hex}"
    admin_engine = create_engine(database_url)
    with admin_engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(
        database_url,
        connect_args={"options": f"-csearch_path={schema}"},
    )
    try:
        SQLModel.metadata.create_all(engine)
        with Session(engine) as setup:
            _seed(setup, sequence_indices=[0])
            if capacity_race:
                _seed_second_batch_attempt(setup)
            else:
                setup.add(
                    ExecutorDB(
                        id="ex-2",
                        scope_kind="pool",
                        project="proj-x",
                        executor_pool_id="pool-1",
                        name="exec-2",
                        credential_prefix="apo_ex_2",
                        credential_hash="hex-2",
                        protocol_version=1,
                        executor_version="v",
                        driver_kinds_json=["subprocess"],
                        max_concurrency=1,
                        enrolled_at=_now(),
                        created_at=_now(),
                        updated_at=_now(),
                    )
                )
                setup.commit()

        executor_ids = ["ex-1", "ex-1"] if capacity_race else ["ex-1", "ex-2"]
        winners = _race_claims(engine, executor_ids)
        assert sum(winner is not None for winner in winners) == 1
        if not capacity_race:
            assert {winner for winner in winners if winner is not None} == {
                "att-batch-x-0"
            }
    finally:
        engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin_engine.dispose()


def test_pool_scoped_executor_cannot_claim_other_pool(session: Session) -> None:
    _seed(session, project_id="proj-a", pool_id="pool-a", executor_id="ex-a", batch_id="batch-a")
    _seed(session, project_id="proj-b", pool_id="pool-b", executor_id="ex-b", batch_id="batch-b")
    claimed = claim_next_attempt(
        session, executor=_executor(session, "ex-a"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    assert claimed is not None
    assert claimed.attempt.executor_pool_id == "pool-a"


def test_installation_executor_claims_bundled_pool(session: Session) -> None:
    _seed(session, executor_id=None)
    pool = session.get(ExecutorPoolDB, "pool-1")
    assert pool is not None
    pool.kind = "bundled"
    session.add(pool)
    session.add(
        ExecutorDB(
            id="install-ex",
            scope_kind="installation",
            project=None,
            executor_pool_id=None,
            name="bundled",
            credential_prefix="apo_ex_install",
            credential_hash="install-hash",
            protocol_version=1,
            executor_version="v",
            driver_kinds_json=["subprocess"],
            max_concurrency=1,
            enrolled_at=_now(),
            created_at=_now(),
            updated_at=_now(),
        )
    )
    session.commit()

    claimed = claim_next_attempt(
        session,
        executor=_executor(session, "install-ex"),
        accepted_driver_kinds=frozenset({"subprocess"}),
    )

    assert claimed is not None
    assert claimed.attempt.executor_pool_id == "pool-1"


def test_installation_executor_cannot_claim_connected_pool(
    session: Session,
) -> None:
    _seed(session, executor_id=None)
    session.add(
        ExecutorDB(
            id="install-ex",
            scope_kind="installation",
            project=None,
            executor_pool_id=None,
            name="bundled",
            credential_prefix="apo_ex_install",
            credential_hash="install-hash",
            protocol_version=1,
            executor_version="v",
            driver_kinds_json=["subprocess"],
            max_concurrency=1,
            enrolled_at=_now(),
            created_at=_now(),
            updated_at=_now(),
        )
    )
    session.commit()

    claimed = claim_next_attempt(
        session,
        executor=_executor(session, "install-ex"),
        accepted_driver_kinds=frozenset({"subprocess"}),
    )

    assert claimed is None


def test_capacity_enforced_from_db_not_request_hint(session: Session) -> None:
    _seed(session, sequence_indices=[0, 1], executor_id="ex-1")
    ex = _executor(session, "ex-1")
    ex.max_concurrency = 1
    session.add(ex)
    session.commit()
    first = claim_next_attempt(session, executor=ex, accepted_driver_kinds=frozenset({"subprocess"}))
    # already at capacity (1 active leased); second must not be claimed
    second = claim_next_attempt(session, executor=ex, accepted_driver_kinds=frozenset({"subprocess"}))
    assert first is not None
    assert second is None


def test_sequential_batch_exposes_only_first_nonterminal(session: Session) -> None:
    _seed(session, sequence_indices=[0, 1])
    claimed = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    assert claimed is not None and claimed.attempt.id == "att-batch-x-0"
    # att-1 must stay unclaimable while att-0 is non-terminal
    again = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    assert again is None
    # make att-0 terminal -> att-1 becomes eligible
    claimed.attempt.status = "succeeded"
    session.add(claimed.attempt)
    session.commit()
    nxt = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    assert nxt is not None and nxt.attempt.id == "att-batch-x-1"


def test_expired_queue_ttl_not_claimed(session: Session) -> None:
    atts = _seed(session, sequence_indices=[0])
    atts[0].queue_expires_at = _now() - timedelta(seconds=1)
    session.add(atts[0])
    session.commit()
    claimed = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    assert claimed is None


def test_incompatible_driver_kind_not_claimed(session: Session) -> None:
    _seed(session, sequence_indices=[0])
    claimed = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"docker"}),
    )
    assert claimed is None


def test_incompatible_protocol_version_not_claimed(session: Session) -> None:
    _seed(session, sequence_indices=[0])
    executor = _executor(session, "ex-1")
    executor.protocol_version = 2
    session.add(executor)
    session.commit()

    claimed = claim_next_attempt(
        session,
        executor=executor,
        accepted_driver_kinds=frozenset({"subprocess"}),
    )

    assert claimed is None


def test_pool_driver_must_be_in_executor_capabilities(session: Session) -> None:
    _seed(session, sequence_indices=[0])
    executor = _executor(session, "ex-1")
    executor.driver_kinds_json = ["docker"]
    session.add(executor)
    session.commit()

    claimed = claim_next_attempt(
        session,
        executor=executor,
        accepted_driver_kinds=frozenset({"docker", "subprocess"}),
    )

    assert claimed is None


# ── start / heartbeat / fencing ───────────────────────────────────────────


def test_start_fences_before_customer_code(session: Session) -> None:
    _seed(session, sequence_indices=[0])
    claimed = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    assert claimed is not None
    started = start_attempt(
        session, lease=claimed.lease, driver_kind="subprocess", runtime={"node": "20"},
    )
    assert started.status == "running"
    assert started.started_at is not None
    assert started.driver_kind == "subprocess"
    task_run = session.get(AgentTaskRunDB, started.task_run_id)
    batch = session.get(AgentTaskBatchRunDB, started.batch_run_id)
    assert task_run is not None and task_run.status == "running"
    assert batch is not None and batch.status == "running"


def test_stale_generation_cannot_start(session: Session) -> None:
    _seed(session, sequence_indices=[0])
    claimed = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    assert claimed is not None
    stale = CurrentAttemptLease(attempt_id=claimed.lease.attempt_id, lease_generation=99, executor_id="ex-1")
    with pytest.raises(LeaseError):
        start_attempt(session, lease=stale, driver_kind="subprocess", runtime={})


def test_heartbeat_renews_lease_and_reports_cancellation(session: Session) -> None:
    _seed(session, sequence_indices=[0])
    claimed = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    assert claimed is not None
    start_attempt(session, lease=claimed.lease, driver_kind="subprocess", runtime={})
    resp = heartbeat_attempt(session, lease=claimed.lease, phase="running")
    assert resp.cancel_requested is False
    # request cancel then heartbeat again
    request_cancellation(session, attempt_id=claimed.lease.attempt_id)
    resp2 = heartbeat_attempt(session, lease=claimed.lease, phase="uploading")
    assert resp2.cancel_requested is True


def test_stale_generation_cannot_heartbeat(session: Session) -> None:
    _seed(session, sequence_indices=[0])
    claimed = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    assert claimed is not None
    stale = CurrentAttemptLease(attempt_id=claimed.lease.attempt_id, lease_generation=99, executor_id="ex-1")
    with pytest.raises(LeaseError):
        heartbeat_attempt(session, lease=stale, phase="running")


# ── recovery reaper ───────────────────────────────────────────────────────


def test_pre_start_lease_expiry_requeues_and_increments_generation(session: Session) -> None:
    atts = _seed(session, sequence_indices=[0])
    atts[0].status = "leased"
    atts[0].lease_generation = 1
    atts[0].lease_expires_at = _now() - timedelta(seconds=1)
    atts[0].started_at = None  # never started
    session.add(atts[0])
    session.commit()
    counts = recover_expired_attempts(session, now=_now())
    assert counts.requeued == 1
    session.refresh(atts[0])
    assert atts[0].status == "queued"
    # next claim increments generation
    claimed = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    assert claimed is not None and claimed.lease.lease_generation == 2


def test_post_start_lease_expiry_becomes_lost_and_never_requeues(session: Session) -> None:
    atts = _seed(session, sequence_indices=[0])
    atts[0].status = "running"
    atts[0].lease_generation = 1
    atts[0].lease_expires_at = _now() - timedelta(seconds=1)
    atts[0].started_at = _now() - timedelta(minutes=5)
    session.add(atts[0])
    session.commit()
    counts = recover_expired_attempts(session, now=_now())
    assert counts.lost == 1
    session.refresh(atts[0])
    assert atts[0].status == "lost"
    task_run = session.get(AgentTaskRunDB, atts[0].task_run_id)
    batch = session.get(AgentTaskBatchRunDB, atts[0].batch_run_id)
    assert task_run is not None and task_run.status == "error"
    assert task_run.no_verdict_reason == "executor"
    assert batch is not None and batch.status == "completed"
    # never requeued: claim finds nothing
    claimed = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    assert claimed is None


def test_expired_queued_becomes_executor_unavailable(session: Session) -> None:
    atts = _seed(session, sequence_indices=[0])
    atts[0].queue_expires_at = _now() - timedelta(seconds=1)
    session.add(atts[0])
    session.commit()
    counts = recover_expired_attempts(session, now=_now())
    assert counts.failed_unavailable == 1
    session.refresh(atts[0])
    assert atts[0].status == "failed"
    assert atts[0].failure_kind == "executor_unavailable"
    task_run = session.get(AgentTaskRunDB, atts[0].task_run_id)
    batch = session.get(AgentTaskBatchRunDB, atts[0].batch_run_id)
    assert task_run is not None and task_run.status == "error"
    assert batch is not None and batch.status == "completed"


def test_reaper_does_not_mutate_terminal_rows(session: Session) -> None:
    _seed(session, sequence_indices=[0], statuses=["succeeded"])
    counts = recover_expired_attempts(session, now=_now())
    assert counts.requeued == 0 and counts.lost == 0 and counts.failed_unavailable == 0


def _expire_running_and_queued(session: Session) -> tuple[TaskExecutionAttemptDB, TaskExecutionAttemptDB]:
    running, queued = _seed(session, sequence_indices=[0, 1])
    running.status = "running"
    running.lease_generation = 1
    running.lease_expires_at = _now() - timedelta(seconds=1)
    running.started_at = _now() - timedelta(minutes=5)
    queued.queue_expires_at = _now() - timedelta(seconds=1)
    session.add(running)
    session.add(queued)
    session.commit()
    return running, queued


def test_reaper_skips_an_unrecoverable_attempt_and_recovers_the_rest(
    session: Session, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from apo.services import execution_leases

    running, queued = _expire_running_and_queued(session)
    running_id, queued_id = running.id, queued.id
    real_finalize = execution_leases._finalize_logical_run

    def finalize(session: Session, attempt: TaskExecutionAttemptDB, **kwargs: object) -> None:
        if attempt.id == running_id:
            raise RuntimeError("poisoned row")
        real_finalize(session, attempt, **kwargs)  # pyright: ignore[reportArgumentType]

    monkeypatch.setattr(execution_leases, "_finalize_logical_run", finalize)
    monkeypatch.setattr(execution_leases, "_unrecoverable_reported", set(), raising=False)

    first = recover_expired_attempts(session, now=_now())
    second = recover_expired_attempts(session, now=_now())

    assert (first.lost, first.failed_unavailable, first.skipped) == (0, 1, 1)
    # The skipped Attempt is rolled back to where it was; the other landed and stays done.
    assert (second.lost, second.failed_unavailable, second.skipped) == (0, 0, 1)
    poisoned = session.get(TaskExecutionAttemptDB, running_id)
    recovered = session.get(TaskExecutionAttemptDB, queued_id)
    assert poisoned is not None and poisoned.status == "running"
    assert recovered is not None and recovered.status == "failed"
    reports = [r for r in caplog.records if "could not recover attempt" in r.getMessage()]
    assert len(reports) == 1


def test_reaper_keeps_earlier_work_when_a_later_attempt_fails(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # att-…-0 is a pre-start requeue (no inner commit); att-…-1 is poisoned and comes after it.
    from apo.services import execution_leases

    requeue, poisoned = _seed(session, sequence_indices=[0, 1])
    for attempt, started in ((requeue, None), (poisoned, _now() - timedelta(minutes=5))):
        attempt.status = "running" if started else "leased"
        attempt.lease_generation = 1
        attempt.lease_expires_at = _now() - timedelta(seconds=1)
        attempt.started_at = started
        session.add(attempt)
    session.commit()
    requeue_id, poisoned_id = requeue.id, poisoned.id

    def finalize(session: Session, attempt: TaskExecutionAttemptDB, **kwargs: object) -> None:
        raise RuntimeError("poisoned row")

    monkeypatch.setattr(execution_leases, "_finalize_logical_run", finalize)
    monkeypatch.setattr(execution_leases, "_unrecoverable_reported", set(), raising=False)

    counts = recover_expired_attempts(session, now=_now())

    assert (counts.requeued, counts.skipped) == (1, 1)
    session.expire_all()
    requeued = session.get(TaskExecutionAttemptDB, requeue_id)
    still_running = session.get(TaskExecutionAttemptDB, poisoned_id)
    assert requeued is not None and requeued.status == "queued"
    assert still_running is not None and still_running.status == "running"


def test_reaper_counts_an_attempt_that_ended_before_a_later_step_failed(
    session: Session, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from apo.services import schedule_occurrences

    running, queued = _expire_running_and_queued(session)
    running_id = running.id

    def resolve(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("occurrence store down")

    monkeypatch.setattr(schedule_occurrences, "resolve_occurrence_if_terminal", resolve)

    counts = recover_expired_attempts(session, now=_now())

    # finalizing committed both Attempts' ends before the occurrence step raised
    assert (counts.lost, counts.failed_unavailable, counts.skipped) == (1, 1, 0)
    session.expire_all()
    ended = session.get(TaskExecutionAttemptDB, running_id)
    assert ended is not None and ended.status == "lost"
    assert any("a step after finalizing its Run failed" in r.getMessage() for r in caplog.records)


def test_reaper_leaves_an_attempt_that_changed_since_its_query(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Three Attempts' queue TTLs expired. While the reaper ends the first, the
    # second is cancelled and the third deleted: it must not overwrite or trip on them.
    from apo.services import execution_leases

    first, cancelled, removed = _seed(session, sequence_indices=[0, 1, 2])
    for attempt in (first, cancelled, removed):
        attempt.queue_expires_at = _now() - timedelta(seconds=1)
        session.add(attempt)
    session.commit()
    first_id, cancelled_id, removed_id = first.id, cancelled.id, removed.id
    real_finalize = execution_leases._finalize_logical_run

    def finalize(session: Session, attempt: TaskExecutionAttemptDB, **kwargs: object) -> None:
        real_finalize(session, attempt, **kwargs)  # pyright: ignore[reportArgumentType]
        if attempt.id == first_id:
            session.commit()
            request_cancellation(session, attempt_id=cancelled_id)
            gone = session.get(TaskExecutionAttemptDB, removed_id)
            assert gone is not None
            session.delete(gone)
            session.commit()

    monkeypatch.setattr(execution_leases, "_finalize_logical_run", finalize)

    counts = recover_expired_attempts(session, now=_now())

    assert (counts.failed_unavailable, counts.skipped) == (1, 0)
    session.expire_all()
    left_alone = session.get(TaskExecutionAttemptDB, cancelled_id)
    assert left_alone is not None and left_alone.status == "cancelled"
    assert session.get(TaskExecutionAttemptDB, removed_id) is None


def test_reaper_reports_a_new_failure_after_the_attempt_recovered(
    session: Session, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from apo.services import execution_leases

    monkeypatch.setattr(execution_leases, "_unrecoverable_reported", {"att-batch-x-0"}, raising=False)
    _seed(session, sequence_indices=[0])[0].queue_expires_at = _now() - timedelta(seconds=1)
    session.commit()

    assert recover_expired_attempts(session, now=_now()).failed_unavailable == 1
    assert "att-batch-x-0" not in execution_leases._unrecoverable_reported


def test_reaper_ends_an_attempt_whose_run_is_gone(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from apo.services import execution_leases

    running, _ = _expire_running_and_queued(session)
    running_id = running.id
    real_finalize = execution_leases._finalize_logical_run

    def finalize(session: Session, attempt: TaskExecutionAttemptDB, **kwargs: object) -> None:
        if attempt.id == running_id:
            raise LeaseError("not_found", "attempt references a missing Task Run or Batch")
        real_finalize(session, attempt, **kwargs)  # pyright: ignore[reportArgumentType]

    monkeypatch.setattr(execution_leases, "_finalize_logical_run", finalize)

    counts = recover_expired_attempts(session, now=_now())

    assert (counts.lost, counts.failed_unavailable, counts.skipped) == (1, 1, 0)
    ended = session.get(TaskExecutionAttemptDB, running_id)
    assert ended is not None and ended.status == "lost"
    assert recover_expired_attempts(session, now=_now()).lost == 0


# ── cancellation ──────────────────────────────────────────────────────────


def test_cancellation_of_queued_is_immediate_and_idempotent(session: Session) -> None:
    atts = _seed(session, sequence_indices=[0])
    request_cancellation(session, attempt_id=atts[0].id)
    session.refresh(atts[0])
    assert atts[0].status == "cancelled"
    task_run = session.get(AgentTaskRunDB, atts[0].task_run_id)
    batch = session.get(AgentTaskBatchRunDB, atts[0].batch_run_id)
    assert task_run is not None and task_run.status == "error"
    assert batch is not None and batch.status == "completed"
    assert batch.cancelled_tasks == 1
    # idempotent
    request_cancellation(session, attempt_id=atts[0].id)
    session.refresh(atts[0])
    assert atts[0].status == "cancelled"


def test_cancellation_of_running_records_request(session: Session) -> None:
    _seed(session, sequence_indices=[0])
    claimed = claim_next_attempt(
        session, executor=_executor(session, "ex-1"), accepted_driver_kinds=frozenset({"subprocess"}),
    )
    assert claimed is not None
    start_attempt(session, lease=claimed.lease, driver_kind="subprocess", runtime={})
    request_cancellation(session, attempt_id=claimed.lease.attempt_id)
    att = session.get(TaskExecutionAttemptDB, claimed.lease.attempt_id)
    assert att is not None
    assert att.status == "running"  # not immediately cancelled; heartbeat asks to stop
    assert att.cancel_requested_at is not None


def _create_sqlite_race_engine(tmp_path: Path) -> Engine:
    engine = create_engine(
        f"sqlite:///{tmp_path / 'claim-race.db'}",
        connect_args={"check_same_thread": False, "timeout": 10},
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _race_claims(engine: Engine, executor_ids: list[str]) -> list[str | None]:
    barrier = Barrier(len(executor_ids))

    def claim(executor_id: str) -> str | None:
        with Session(engine) as worker:
            executor = worker.get(ExecutorDB, executor_id)
            assert executor is not None
            barrier.wait()
            claimed = claim_next_attempt(
                worker,
                executor=executor,
                accepted_driver_kinds=frozenset({"subprocess"}),
            )
            return claimed.attempt.id if claimed is not None else None

    with ThreadPoolExecutor(max_workers=len(executor_ids)) as pool:
        return list(pool.map(claim, executor_ids))


def _seed_second_batch_attempt(session: Session) -> None:
    session.add(
        AgentTaskBatchRunDB(
            id="batch-y",
            project="proj-x",
            selection_type="single",
            status="queued",
            created_at=_now(),
        )
    )
    session.flush()
    session.add(
        TaskRevisionDB(
            id="rev-batch-y",
            project="proj-x",
            batch_run_id="batch-y",
            materialization="bundled",
            source_type="filesystem",
            content_sha256="d" * 64,
            file_count=1,
            uncompressed_size_bytes=1,
            manifest_summary_json={"fileCount": 1},
            created_at=_now(),
        )
    )
    session.add(
        AgentTaskRunDB(
            id="run-batch-y-0",
            batch_run_id="batch-y",
            task_id="ty",
            task_path="ty",
            sequence_index=0,
            status="pending",
            created_at=_now(),
        )
    )
    session.flush()
    session.add(
        TaskExecutionAttemptDB(
            id="att-batch-y-0",
            project="proj-x",
            batch_run_id="batch-y",
            task_run_id="run-batch-y-0",
            task_revision_id="rev-batch-y",
            sequence_index=0,
            target_kind="pool",
            executor_pool_id="pool-1",
            status="queued",
            queue_expires_at=_now() + timedelta(hours=1),
            queued_at=_now(),
        )
    )
    session.commit()
