# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""v48 migration backfill: the errored-checks bucket (issue #323).

Runs stored before v48 counted judge-errored checks as fails. The migration
recomputes the bucket from the stored evidence and moves those checks out of
``failed_checks``. Runs and judgments without errors are untouched.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy.engine import Engine
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import apo.db as apo_db
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskCheckReportDB,
    AgentTaskJudgmentDB,
    AgentTaskRunDB,
)


@pytest.fixture(name="engine")
def engine_fixture() -> Iterator[Engine]:
    test_engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    # create_all includes the new columns — the migration's column-add step is
    # an idempotent no-op here, so the test targets the backfill.
    SQLModel.metadata.create_all(test_engine)
    yield test_engine


def _seed_run(
    session: Session,
    *,
    run_id: str,
    status: str = "failed",
    pass_result: bool | None = False,
    total: int = 2,
    passed: int = 1,
    failed: int = 1,
    checks: list[dict[str, object]] | None = None,
) -> None:
    now = datetime.now(timezone.utc)
    session.add(
        AgentTaskRunDB(
            id=run_id,
            batch_run_id="batch-1",
            task_id=run_id,
            task_path="/t",
            status=status,
            pass_result=pass_result,
            started_at=now,
            completed_at=now,
            total_checks=total,
            passed_checks=passed,
            failed_checks=failed,
        )
    )
    if checks is not None:
        session.add(AgentTaskCheckReportDB(run_id=run_id, value_json=checks, created_at=now))


ERRORED_CHECK: dict[str, object] = {
    "id": "blacked-out",
    "pass": False,
    "outcome": "error",
    "reasoning": "judge failed: gateway timeout",
    "assertions": [{"id": "judge", "pass": False, "outcome": "error"}],
}


def test_backfill_moves_errored_checks_out_of_failed(
    engine: StaticPool, monkeypatch: MonkeyPatch
) -> None:
    with Session(engine) as session:
        session.add(
            AgentTaskBatchRunDB(
                id="batch-1",
                project="p1",
                status="completed",
                total_tasks=3,
                selection_type="task",
                created_at=datetime.now(timezone.utc),
            )
        )
        # Pre-v48 shape: the judge-errored check sits inside failed_checks.
        _seed_run(
            session,
            run_id="run-errored",
            checks=[
                {"id": "ok", "pass": True},
                ERRORED_CHECK,
            ],
        )
        # A genuine fail stays a fail; an all-pass run is skipped entirely.
        _seed_run(
            session,
            run_id="run-genuine",
            checks=[{"id": "nope", "pass": False}],
        )
        _seed_run(
            session,
            run_id="run-passed",
            status="passed",
            pass_result=True,
            total=1,
            passed=1,
            failed=0,
            checks=[{"id": "ok", "pass": True}],
        )
        # No report row — nothing to recompute, must not crash.
        _seed_run(session, run_id="run-no-report", checks=None)
        # A judgment with the same pre-v48 miscount.
        session.add(
            AgentTaskJudgmentDB(
                id="jdg_1",
                task_run_id="run-errored",
                project="p1",
                trigger="rejudge",
                samples=1,
                pass_result=False,
                total_checks=2,
                passed_checks=1,
                failed_checks=1,
                checks_json=[{"id": "ok", "pass": True}, ERRORED_CHECK],
            )
        )
        session.commit()

    monkeypatch.setattr(apo_db, "engine", engine)
    apo_db._migrate_to_v48()

    with Session(engine) as session:
        errored = session.get(AgentTaskRunDB, "run-errored")
        assert errored is not None
        assert errored.errored_checks == 1
        assert errored.failed_checks == 0
        assert errored.passed_checks == 1

        genuine = session.get(AgentTaskRunDB, "run-genuine")
        assert genuine is not None
        assert genuine.errored_checks == 0
        assert genuine.failed_checks == 1

        passed = session.get(AgentTaskRunDB, "run-passed")
        assert passed is not None
        assert passed.errored_checks == 0
        assert passed.passed_checks == 1

        no_report = session.get(AgentTaskRunDB, "run-no-report")
        assert no_report is not None
        assert no_report.failed_checks == 1

        judgment = session.get(AgentTaskJudgmentDB, "jdg_1")
        assert judgment is not None
        assert judgment.errored_checks == 1
        assert judgment.failed_checks == 0


def test_backfill_derives_outcome_from_legacy_assertions(
    engine: StaticPool, monkeypatch: MonkeyPatch
) -> None:
    """Reports recorded before the check-level outcome existed still backfill —
    the outcome is derived from the assertion breakdown."""
    with Session(engine) as session:
        session.add(
            AgentTaskBatchRunDB(
                id="batch-1",
                project="p1",
                status="completed",
                total_tasks=1,
                selection_type="task",
                created_at=datetime.now(timezone.utc),
            )
        )
        _seed_run(
            session,
            run_id="run-legacy",
            checks=[
                {
                    "id": "legacy",
                    "pass": False,
                    "assertions": [{"id": "judge", "pass": False, "outcome": "error"}],
                }
            ],
        )
        session.commit()

    monkeypatch.setattr(apo_db, "engine", engine)
    apo_db._migrate_to_v48()

    with Session(engine) as session:
        run = session.get(AgentTaskRunDB, "run-legacy")
        assert run is not None
        assert run.errored_checks == 1
        assert run.failed_checks == 0
