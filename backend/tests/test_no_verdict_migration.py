# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false

"""v49/v50 migrations: the run-level no-verdict rule on pre-#323 rows.

v48 moved judge-errored checks into ``errored_checks`` but left the verdict;
v49 turns runs whose only non-passing checks are judge errors into no-verdict
runs exactly as finalization now would, and re-rolls their batches. v50 adds
the structured ``no_verdict_reason``, backfills it, and repairs the corrected
runs v49 wrongly moved to no verdict.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy.engine import Engine
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import apo.db as apo_db
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskCheckReportDB,
    AgentTaskJudgmentDB,
    AgentTaskRunDB,
    AgentTaskTestResultCorrectionDB,
)
from apo.services.check_report_storage import is_judge_no_verdict_run
from apo.services.test_result_corrections import (
    effective_check_report,
    effective_verdict_counts,
    load_corrections,
)
from tests.test_judge_no_verdict import JUDGE_ERROR, RULE_1_OF_3, _finalize, _passing, _seed


@pytest.fixture(name="engine")
def engine_fixture() -> Iterator[Engine]:
    test_engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(test_engine)
    yield test_engine


def _run(
    run_id: str,
    *,
    failed: int,
    errored: int,
    error_message: str | None = None,
    generation_execution: dict[str, object] | None = None,
    status: str = "failed",
) -> AgentTaskRunDB:
    now = datetime.now(timezone.utc)
    return AgentTaskRunDB(
        id=run_id,
        batch_run_id="batch-1",
        task_id=run_id,
        task_path="/t",
        status=status,
        pass_result=False if status == "failed" else None,
        started_at=now,
        completed_at=now,
        total_checks=3,
        passed_checks=3 - failed - errored,
        failed_checks=failed,
        errored_checks=errored,
        error_message=error_message,
        generation_execution_json=generation_execution,
    )


def test_v49_applies_the_no_verdict_rule(engine: Engine, monkeypatch: MonkeyPatch) -> None:
    assert apo_db._SCHEMA_MIGRATIONS[49] is apo_db._migrate_to_v49
    with Session(engine) as session:
        session.add(
            AgentTaskBatchRunDB(
                id="batch-1",
                project="p1",
                status="completed",
                total_tasks=3,
                failed_tasks=3,
                selection_type="task",
                created_at=datetime.now(timezone.utc),
            )
        )
        session.flush()
        session.add(_run("run-outage", failed=0, errored=1, error_message="adapter note"))
        session.add(_run("run-genuine", failed=1, errored=1))
        session.add(
            _run(
                "run-generations",
                failed=0,
                errored=1,
                generation_execution={"total": 4, "errored": 3, "error_finish_reasons": {}},
            )
        )
        session.add(
            AgentTaskJudgmentDB(
                id="jdg_1",
                task_run_id="run-outage",
                project="p1",
                trigger="rejudge",
                samples=1,
                pass_result=False,
                total_checks=3,
                passed_checks=2,
                failed_checks=0,
                errored_checks=1,
            )
        )
        session.commit()

    monkeypatch.setattr(apo_db, "engine", engine)
    apo_db._migrate_to_v49()
    apo_db._migrate_to_v49()  # idempotent

    with Session(engine) as session:
        outage = session.get(AgentTaskRunDB, "run-outage")
        assert outage is not None
        assert outage.status == "error"
        assert outage.pass_result is None
        assert outage.error_message == (
            "No verdict: 1 of 3 checks got no verdict from the judge "
            "(judge error or no judge configured); the other 2 passed.\nadapter note"
        )
        # The structured reason arrives with v50, which makes the run
        # correctable / re-judgeable again (see the v50 tests below).
        assert outage.no_verdict_reason is None

        genuine = session.get(AgentTaskRunDB, "run-genuine")
        assert genuine is not None
        assert (genuine.status, genuine.pass_result) == ("failed", False)

        generations = session.get(AgentTaskRunDB, "run-generations")
        assert generations is not None
        assert generations.status == "failed"

        batch = session.get(AgentTaskBatchRunDB, "batch-1")
        assert batch is not None
        assert (batch.failed_tasks, batch.errored_tasks) == (2, 1)

        judgment = session.get(AgentTaskJudgmentDB, "jdg_1")
        assert judgment is not None
        assert judgment.pass_result is None


def test_v49_never_reads_columns_beyond_its_own_set(
    engine: Engine, monkeypatch: MonkeyPatch
) -> None:
    """The v49 backfill must stay column-limited as the schema grows.

    The model classes declare every column, including ones later migrations
    will add, but a database upgrading through v49 does not have those yet —
    a full-row SELECT inside the migration crashes with "no such column"
    the moment the schema grows past v49 (the upgrade-crash class behind
    issue #307). Dropping a model-declared column the migration never reads
    stands in for that future database.
    """
    with Session(engine) as session:
        session.add(
            AgentTaskBatchRunDB(
                id="batch-1",
                project="p1",
                status="completed",
                total_tasks=1,
                failed_tasks=1,
                selection_type="task",
                created_at=datetime.now(timezone.utc),
            )
        )
        session.flush()
        session.add(_run("run-outage", failed=0, errored=1, error_message="adapter note"))
        session.commit()

    with engine.connect() as conn:
        conn.exec_driver_sql("ALTER TABLE agent_task_runs DROP COLUMN transcript_json")
        conn.commit()

    monkeypatch.setattr(apo_db, "engine", engine)
    apo_db._migrate_to_v49()

    # Assertions by column-limited driver SQL: full-row ORM loads cannot
    # read this database either, which is the point.
    with engine.connect() as conn:
        run_row = conn.exec_driver_sql(
            """
            SELECT status, pass_result, error_message FROM agent_task_runs
            WHERE id = 'run-outage'
            """
        ).one()
        batch_row = conn.exec_driver_sql(
            """
            SELECT failed_tasks, errored_tasks FROM agent_task_batch_runs
            WHERE id = 'batch-1'
            """
        ).one()
    assert run_row.status == "error"
    assert run_row.pass_result is None
    assert run_row.error_message is not None
    assert run_row.error_message.startswith("No verdict: ")
    assert (batch_row.failed_tasks, batch_row.errored_tasks) == (0, 1)


# --- v50: the structured no_verdict_reason ---------------------------------

_DOMINATED: dict[str, object] = {"total": 4, "errored": 3, "error_finish_reasons": {}}


def _batch(session: Session, total: int) -> None:
    session.add(
        AgentTaskBatchRunDB(
            id="batch-1",
            project="p1",
            status="completed",
            total_tasks=total,
            failed_tasks=total,
            selection_type="task",
            created_at=datetime.now(timezone.utc),
        )
    )
    session.flush()


def test_v50_backfills_the_reason(engine: Engine, monkeypatch: MonkeyPatch) -> None:
    assert apo_db.LATEST_SCHEMA_VERSION == 55
    assert apo_db._SCHEMA_MIGRATIONS[50] is apo_db._migrate_to_v50
    with Session(engine) as session:
        _batch(session, 7)
        # Moved to no verdict by v49 (run below first), reason by v50.
        session.add(_run("run-outage", failed=0, errored=1, error_message="adapter note"))
        session.add(_run("run-genuine", failed=1, errored=1))
        session.add(_run("run-generations", failed=0, errored=1, generation_execution=_DOMINATED))
        session.add(
            _run(
                "run-149",
                failed=0,
                errored=1,
                status="error",
                error_message="3 of 4 generations ended in error. No PASS/FAIL verdict.",
                generation_execution=_DOMINATED,
            )
        )
        session.add(
            _run("run-crash", failed=0, errored=1, status="error", error_message="adapter crashed")
        )
        # An executor error beside dominated generations: finalize put the
        # executor first, so it is not a #149 run.
        session.add(
            _run(
                "run-crash-149",
                failed=0,
                errored=1,
                status="error",
                error_message="adapter crashed",
                generation_execution=_DOMINATED,
            )
        )
        # A no-verdict row in older wording: adopted and reworded.
        session.add(
            _run(
                "run-old-wording",
                failed=0,
                errored=1,
                status="error",
                error_message=(
                    "No verdict: 1 of 3 checks got no answer from the judge (judge error); "
                    "the other 2 passed."
                ),
            )
        )
        session.commit()

    monkeypatch.setattr(apo_db, "engine", engine)
    apo_db._migrate_to_v49()
    apo_db._migrate_to_v50()
    apo_db._migrate_to_v50()  # idempotent

    with Session(engine) as session:
        outage = session.get(AgentTaskRunDB, "run-outage")
        assert outage is not None
        assert (outage.status, outage.no_verdict_reason) == ("error", "judge")
        assert outage.error_message == f"{RULE_1_OF_3}\nadapter note"
        assert is_judge_no_verdict_run(outage)

        genuine = session.get(AgentTaskRunDB, "run-genuine")
        assert genuine is not None
        assert (genuine.status, genuine.no_verdict_reason) == ("failed", None)
        generations = session.get(AgentTaskRunDB, "run-generations")
        assert generations is not None
        assert (generations.status, generations.no_verdict_reason) == ("failed", None)

        run_149 = session.get(AgentTaskRunDB, "run-149")
        assert run_149 is not None and run_149.no_verdict_reason == "generations"
        crash = session.get(AgentTaskRunDB, "run-crash")
        assert crash is not None
        assert crash.no_verdict_reason == "executor"
        assert crash.error_message == "adapter crashed"
        assert not is_judge_no_verdict_run(crash)
        crash_149 = session.get(AgentTaskRunDB, "run-crash-149")
        assert crash_149 is not None and crash_149.no_verdict_reason == "executor"
        old = session.get(AgentTaskRunDB, "run-old-wording")
        assert old is not None
        assert old.no_verdict_reason == "judge"
        assert old.error_message == RULE_1_OF_3
        assert is_judge_no_verdict_run(old)

        batch = session.get(AgentTaskBatchRunDB, "batch-1")
        assert batch is not None
        assert (batch.failed_tasks, batch.errored_tasks) == (2, 5)


def test_v50_alone_applies_the_rule(engine: Engine, monkeypatch: MonkeyPatch) -> None:
    """A failed judge-only run v49 never moved still moves to no verdict,
    across more than one chunk."""
    with Session(engine) as session:
        _batch(session, 150)
        for i in range(150):
            session.add(_run(f"run-{i:03d}", failed=0, errored=1))
        session.commit()

    monkeypatch.setattr(apo_db, "engine", engine)
    apo_db._migrate_to_v50()

    with Session(engine) as session:
        runs = session.exec(select(AgentTaskRunDB)).all()
        assert {(r.status, r.pass_result, r.no_verdict_reason) for r in runs} == {
            ("error", None, "judge")
        }
        batch = session.get(AgentTaskBatchRunDB, "batch-1")
        assert batch is not None
        assert (batch.failed_tasks, batch.errored_tasks) == (0, 150)


def _v48_state_with_correction(session: Session, action: str) -> AgentTaskRunDB:
    """A run as v48 left it: a human corrected the judge-errored check, but
    v48 recounted from the recorded report and kept that check errored."""
    batch, run = _seed(session)
    _finalize(session, run, batch, [*_passing(2), JUDGE_ERROR])
    session.add(
        AgentTaskTestResultCorrectionDB(
            task_run_id=run.id,
            project="p1",
            test_id="blacked-out",
            action=action,
            reason="human looked",
            corrected_by_user_id="u1",
            corrected_via="session",
        )
    )
    passed = 3 if action == "set_pass" else 2
    run.status = "passed" if action == "set_pass" else "failed"
    run.pass_result = action == "set_pass"
    run.no_verdict_reason = None
    run.error_message = None
    run.total_checks, run.passed_checks = 3, passed
    run.failed_checks, run.errored_checks = max(3 - passed - 1, 0), 1
    run.corrected_tests = 1
    session.add(run)
    session.commit()
    return run


def test_v50_restores_a_human_set_fail_v49_erased(
    session: Session, monkeypatch: MonkeyPatch
) -> None:
    _assert_set_fail_survives(session, monkeypatch, through_v49=True)


def test_v50_keeps_a_human_set_fail_v49_never_saw(
    session: Session, monkeypatch: MonkeyPatch
) -> None:
    _assert_set_fail_survives(session, monkeypatch, through_v49=False)


def _assert_set_fail_survives(
    session: Session, monkeypatch: MonkeyPatch, *, through_v49: bool
) -> None:
    run = _v48_state_with_correction(session, "set_fail")
    monkeypatch.setattr(apo_db, "engine", session.get_bind())
    if through_v49:
        apo_db._migrate_to_v49()
        session.expire_all()
        flipped = session.get(AgentTaskRunDB, run.id)
        assert flipped is not None
        # The released v49 defect v50 repairs.
        assert (flipped.status, flipped.pass_result) == ("error", None)
    apo_db._migrate_to_v50()
    apo_db._migrate_to_v50()  # idempotent
    session.expire_all()

    migrated = session.get(AgentTaskRunDB, run.id)
    assert migrated is not None
    assert (migrated.status, migrated.pass_result) == ("failed", False)
    assert (migrated.failed_checks, migrated.errored_checks) == (1, 0)
    assert migrated.error_message is None
    assert migrated.no_verdict_reason is None
    assert not is_judge_no_verdict_run(migrated)
    if through_v49:
        # Re-rolled after the repair, as v49 re-rolled after the flip.
        batch = session.get(AgentTaskBatchRunDB, migrated.batch_run_id)
        assert batch is not None
        assert (batch.failed_tasks, batch.errored_tasks) == (1, 0)


def test_v50_recounts_a_human_set_pass(session: Session, monkeypatch: MonkeyPatch) -> None:
    run = _v48_state_with_correction(session, "set_pass")
    monkeypatch.setattr(apo_db, "engine", session.get_bind())
    apo_db._migrate_to_v49()
    apo_db._migrate_to_v50()
    session.expire_all()

    migrated = session.get(AgentTaskRunDB, run.id)
    assert migrated is not None
    assert (migrated.status, migrated.pass_result) == ("passed", True)
    assert (migrated.passed_checks, migrated.failed_checks, migrated.errored_checks) == (3, 0, 0)


def test_v50_never_reads_columns_beyond_its_own_set(
    engine: Engine, monkeypatch: MonkeyPatch
) -> None:
    """Column-limited like v49, and it adds its own column when missing."""
    with Session(engine) as session:
        _batch(session, 2)
        session.add(_run("run-outage", failed=0, errored=1, error_message="adapter note"))
        session.add(
            _run("run-crash", failed=0, errored=1, status="error", error_message="adapter crashed")
        )
        session.commit()

    with engine.connect() as conn:
        conn.exec_driver_sql("ALTER TABLE agent_task_runs DROP COLUMN transcript_json")
        conn.exec_driver_sql("ALTER TABLE agent_task_runs DROP COLUMN no_verdict_reason")
        conn.commit()

    monkeypatch.setattr(apo_db, "engine", engine)
    apo_db._migrate_to_v50()

    with engine.connect() as conn:
        rows = {
            row.id: row.no_verdict_reason
            for row in conn.exec_driver_sql(
                "SELECT id, no_verdict_reason FROM agent_task_runs"
            ).fetchall()
        }
        batch_row = conn.exec_driver_sql(
            "SELECT failed_tasks, errored_tasks FROM agent_task_batch_runs WHERE id = 'batch-1'"
        ).one()
    assert rows == {"run-outage": "judge", "run-crash": "executor"}
    assert (batch_row.failed_tasks, batch_row.errored_tasks) == (0, 2)


# --- review-e mutations, killed: ordered corrections, clears, caller text ---

_T0 = datetime(2026, 8, 1, 10, 0, 0)


def _err(check_id: str) -> dict[str, object]:
    return {**JUDGE_ERROR, "id": check_id}


def _pre_323_run(
    session: Session,
    run_id: str,
    checks: list[dict[str, object]],
    corrections: list[tuple[str, str, str, int]],
    *,
    caller: str | None = "adapter note",
) -> None:
    """A run as the pre-#323 correction service left it: ``corrections`` are
    ``(row id, test id, action, seconds after _T0)``; errored checks counted
    as failed, the verdict from the effective report."""
    batch, run = _seed(session, run_id=run_id, batch_id=f"b-{run_id}")
    _finalize(session, run, batch, checks)
    for row_id, test_id, action, seconds in corrections:
        session.add(
            AgentTaskTestResultCorrectionDB(
                id=row_id,
                task_run_id=run_id,
                project="p1",
                test_id=test_id,
                action=action,
                reason=None if action == "clear" else "human looked",
                corrected_by_user_id="u1",
                corrected_via="session",
                created_at=_T0 + timedelta(seconds=seconds),
            )
        )
    session.flush()
    effective = effective_check_report(checks, load_corrections(session, [run_id])[run_id])
    passed = sum(1 for c in effective if c.get("pass") is True)
    run.status = "passed" if passed == len(checks) else "failed"
    run.pass_result = run.status == "passed"
    run.no_verdict_reason = None
    run.error_message = None if run.pass_result else caller
    run.total_checks, run.passed_checks = len(checks), passed
    run.failed_checks, run.errored_checks = len(checks) - passed, 0
    run.corrected_tests = sum(1 for c in effective if "correction" in c)
    session.add(run)
    session.commit()


def _climb(session: Session, monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(apo_db, "engine", session.get_bind())
    apo_db._migrate_to_v48()
    apo_db._migrate_to_v49()
    apo_db._migrate_to_v50()
    session.expire_all()


def _state(session: Session, run_id: str) -> tuple[object, ...]:
    run = session.get(AgentTaskRunDB, run_id)
    assert run is not None
    return (
        run.status,
        run.pass_result,
        run.no_verdict_reason,
        run.passed_checks,
        run.failed_checks,
        run.errored_checks,
        run.error_message,
    )


def test_v50_recount_reads_the_latest_correction_per_test(
    session: Session, monkeypatch: MonkeyPatch
) -> None:
    """Newest correction per test decides, a ``clear`` leaves the check
    uncorrected, and ties break on id exactly as ``_active_by_test`` does."""
    # x was set_fail then cleared: still judge-errored; y is a corrected PASS.
    _pre_323_run(
        session, "r-clear", [*_passing(1), _err("x"), _err("y")],
        [("c1", "x", "set_fail", 0), ("c2", "x", "clear", 1), ("c3", "y", "set_pass", 2)],
    )
    # set_pass then set_fail: the later FAIL stands.
    _pre_323_run(
        session, "r-latest", [*_passing(2), _err("x")],
        [("c4", "x", "set_pass", 0), ("c5", "x", "set_fail", 1)],
    )
    # Same timestamp: the higher id is the newer row.
    _pre_323_run(
        session, "r-tie", [*_passing(2), _err("x")],
        [("c6-a", "x", "set_pass", 0), ("c6-b", "x", "set_fail", 0)],
    )

    _climb(session, monkeypatch)

    assert _state(session, "r-clear") == (
        "error", None, "judge", 2, 0, 1, f"{RULE_1_OF_3}\nadapter note"
    )
    assert _state(session, "r-latest") == ("failed", False, None, 2, 1, 0, "adapter note")
    assert _state(session, "r-tie") == ("failed", False, None, 2, 1, 0, "adapter note")
    # The same counts the correction service derives.
    for run_id in ("r-clear", "r-latest", "r-tie"):
        run = session.get(AgentTaskRunDB, run_id)
        assert run is not None
        report = session.get(AgentTaskCheckReportDB, run_id)
        assert report is not None and report.value_json is not None
        effective = effective_check_report(
            report.value_json, load_corrections(session, [run_id])[run_id]
        )
        assert effective_verdict_counts(effective) == (
            run.total_checks, run.passed_checks, run.failed_checks, run.errored_checks
        )


def test_v50_alone_keeps_the_caller_message_when_applying_the_rule(
    engine: Engine, monkeypatch: MonkeyPatch
) -> None:
    with Session(engine) as session:
        _batch(session, 1)
        session.add(_run("run-outage", failed=0, errored=1, error_message="adapter note"))
        session.commit()

    monkeypatch.setattr(apo_db, "engine", engine)
    apo_db._migrate_to_v50()

    with Session(engine) as session:
        run = session.get(AgentTaskRunDB, "run-outage")
        assert run is not None
        assert (run.status, run.no_verdict_reason) == ("error", "judge")
        assert run.error_message == f"{RULE_1_OF_3}\nadapter note"


def test_v50_executor_error_mimicking_the_rule_stays_an_executor_error(
    engine: Engine, monkeypatch: MonkeyPatch
) -> None:
    """An uncorrected ``error`` run whose own message starts like the rule,
    beside a genuine fail, is an execution failure — not a v49 flip to undo."""
    with Session(engine) as session:
        _batch(session, 1)
        session.add(
            _run(
                "run-mimic",
                failed=1,
                errored=1,
                status="error",
                error_message=f"{RULE_1_OF_3}\nadapter crashed afterwards",
            )
        )
        session.commit()

    monkeypatch.setattr(apo_db, "engine", engine)
    apo_db._migrate_to_v50()

    with Session(engine) as session:
        run = session.get(AgentTaskRunDB, "run-mimic")
        assert run is not None
        assert (run.status, run.pass_result, run.no_verdict_reason) == ("error", None, "executor")


def test_v50_repairs_a_flipped_run_whose_corrections_pass_every_check(
    session: Session, monkeypatch: MonkeyPatch
) -> None:
    """Stale scalars that still read no verdict while every check carries a
    human PASS restore to ``passed``, keeping the caller's note."""
    batch, run = _seed(session)
    _finalize(session, run, batch, [*_passing(2), JUDGE_ERROR], error_message="adapter note")
    session.add(
        AgentTaskTestResultCorrectionDB(
            task_run_id=run.id,
            project="p1",
            test_id="blacked-out",
            action="set_pass",
            reason="human looked",
            corrected_by_user_id="u1",
            corrected_via="session",
        )
    )
    run.corrected_tests = 1
    session.add(run)
    session.commit()

    monkeypatch.setattr(apo_db, "engine", session.get_bind())
    apo_db._migrate_to_v50()
    session.expire_all()

    assert _state(session, run.id) == ("passed", True, None, 3, 0, 0, "adapter note")
