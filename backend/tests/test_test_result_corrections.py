"""Manual test result corrections — service unit tests.

The correction layer overlays human decisions on top of the immutable Check
Report. These tests pin the projection semantics (latest-wins, clear restores
recorded, as-of), evidence preservation, and the Run/Batch scalar updates.
"""

# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownParameterType=false
# pyright: reportUnusedCallResult=false, reportUnusedImport=false, reportAttributeAccessIssue=false
# pyright: reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false
# pyright: reportPrivateUsage=false

from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session

from apo.db import LATEST_SCHEMA_VERSION, _SCHEMA_MIGRATIONS
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    UserDB,
)
from apo.services.check_report_storage import persist_check_report
from apo.services.test_result_corrections import (
    CorrectionActor,
    CorrectionError,
    correct_test_result,
    effective_check_report,
)
from apo.models.db import AgentTaskTestResultCorrectionDB

NOW = datetime.now(timezone.utc)
ACTOR = CorrectionActor(user_id="u1", label="u1@test.com", via="session", api_key_id=None)


class TestMigration:
    def test_v32_registered(self) -> None:
        assert LATEST_SCHEMA_VERSION >= 32
        assert 32 in _SCHEMA_MIGRATIONS


def _correction(
    run_id: str,
    test_id: str,
    action: str,
    at: datetime,
    *,
    reason: str | None = "operator reviewed the evidence",
    seq: int = 0,
) -> AgentTaskTestResultCorrectionDB:
    return AgentTaskTestResultCorrectionDB(
        id=f"cor_{run_id}_{test_id}_{seq}",
        project="p1",
        task_run_id=run_id,
        test_id=test_id,
        action=action,
        reason=reason,
        corrected_by_user_id="u1",
        corrected_via="session",
        created_at=at,
    )


class TestEffectiveCheckReport:
    def test_overlay_preserves_evidence(self) -> None:
        recorded = [
            {
                "id": "memo-complete",
                "pass": False,
                "reasoning": "judge said missing retention table",
                "judge": {"model": "gpt/x", "response": '{"pass": false}'},
                "assertions": [{"id": "a1", "pass": False, "received": "raw value"}],
            },
            {"id": "other", "pass": True, "reasoning": "ok"},
        ]
        frozen = copy.deepcopy(recorded)
        corrections = [_correction("r", "memo-complete", "set_pass", NOW)]

        effective = effective_check_report(recorded, corrections)

        by_id = {c["id"]: c for c in effective}
        memo = by_id["memo-complete"]
        assert memo["pass"] is True
        assert memo["recorded_pass"] is False
        assert memo["correction"]["reason"] == "operator reviewed the evidence"
        assert memo["correction"]["action"] == "set_pass"
        # recorded evidence is untouched
        assert memo["reasoning"] == "judge said missing retention table"
        assert memo["judge"]["response"] == '{"pass": false}'
        assert memo["assertions"][0]["pass"] is False
        # uncorrected checks keep today's shape (no recorded_pass key)
        assert "recorded_pass" not in by_id["other"]
        assert "correction" not in by_id["other"]
        # input not mutated
        assert recorded == frozen

    def test_latest_clear_and_as_of_behavior(self) -> None:
        recorded = [{"id": "t1", "pass": False, "reasoning": "nope"}]
        t0 = NOW
        t1 = NOW + timedelta(minutes=1)
        t2 = NOW + timedelta(minutes=2)
        t3 = NOW + timedelta(minutes=3)
        corrections = [
            _correction("r", "t1", "set_pass", t0, seq=0),
            _correction("r", "t1", "clear", t1, seq=1),
            _correction("r", "t1", "set_fail", t2, seq=2),
        ]

        # as-of before anything: recorded
        eff = effective_check_report(recorded, corrections, as_of=t0 - timedelta(seconds=1))
        assert eff[0]["pass"] is False and "correction" not in eff[0]
        # after set_pass
        eff = effective_check_report(recorded, corrections, as_of=t0)
        assert eff[0]["pass"] is True
        # after clear: recorded again, no active correction
        eff = effective_check_report(recorded, corrections, as_of=t1)
        assert eff[0]["pass"] is False and "correction" not in eff[0]
        # after set_fail (recorded was already fail, but correction is active)
        eff = effective_check_report(recorded, corrections, as_of=t3)
        assert eff[0]["pass"] is False
        assert eff[0]["correction"]["action"] == "set_fail"

    def test_projection_is_stable_and_non_mutating(self) -> None:
        recorded = [{"id": "t1", "pass": True, "reasoning": "ok"}]
        frozen = copy.deepcopy(recorded)
        corrections = [_correction("r", "t1", "set_fail", NOW)]

        once = effective_check_report(recorded, corrections)
        twice = effective_check_report(recorded, corrections)
        assert once == twice
        assert once[0]["correction"] is not twice[0]["correction"]  # fresh copies
        assert recorded == frozen

    def test_unknown_test_id_is_ignored_in_projection(self) -> None:
        recorded = [{"id": "t1", "pass": True, "reasoning": "ok"}]
        corrections = [_correction("r", "totally-other", "set_fail", NOW)]
        eff = effective_check_report(recorded, corrections)
        assert "correction" not in eff[0]


class TestCorrectTestResult:
    @pytest.fixture
    def seeded_run(self, session: Session) -> AgentTaskRunDB:
        """Run with 3 checks: 2 pass, 1 fail → run FAIL."""
        if not session.get(UserDB, "u1"):
            session.add(UserDB(id="u1", email="u1@test.com", name="U1", password_hash="x"))
        if not session.get(ProjectDB, "p1"):
            session.add(ProjectDB(id="p1", name="P1", created_by="u1"))
        session.flush()
        batch = AgentTaskBatchRunDB(
            id="b1", project="p1", selection_type="task", status="completed", created_at=NOW
        )
        session.add(batch)
        session.flush()
        run = AgentTaskRunDB(
            id="r1",
            batch_run_id="b1",
            task_id="demo",
            task_path="/tasks/demo",
            status="failed",
            pass_result=False,
            started_at=NOW,
            completed_at=NOW,
        )
        session.add(run)
        session.flush()
        persist_check_report(
            session,
            run,
            [
                {"id": "keep-1", "pass": True, "reasoning": "ok"},
                {"id": "the-flaw", "pass": False, "reasoning": "judge missed the table"},
                {"id": "keep-2", "pass": True, "reasoning": "ok"},
            ],
        )
        session.commit()
        return run

    def test_pass_correction_flips_run_verdict_and_batch(
        self, session: Session, seeded_run: AgentTaskRunDB
    ) -> None:
        result = correct_test_result(
            session,
            task_run=seeded_run,
            project="p1",
            test_id="the-flaw",
            action="set_pass",
            reason="Retention is present in the KPI table; judge missed it",
            actor=ACTOR,
        )

        assert result.effective_pass is True
        assert result.recorded_pass is False
        assert result.run_status == "passed"
        assert result.run_pass_result is True
        assert result.total_tests == 3
        assert result.passed_tests == 3
        assert result.failed_tests == 0
        assert result.corrected_tests == 1

        session.refresh(seeded_run)
        assert seeded_run.status == "passed"
        assert seeded_run.pass_result is True
        assert seeded_run.passed_checks == 3
        assert seeded_run.failed_checks == 0
        assert seeded_run.corrected_tests == 1

        batch = session.get(AgentTaskBatchRunDB, "b1")
        assert batch is not None
        assert batch.passed_tasks == 1
        assert batch.failed_tasks == 0
        assert batch.passed_checks == 3

        # raw report unchanged
        from apo.services.check_report_storage import load_check_report

        raw = load_check_report(session, "r1")
        assert raw is not None
        flaw = next(c for c in raw if c["id"] == "the-flaw")
        assert flaw["pass"] is False
        assert "correction" not in flaw

    def test_correcting_a_judge_errored_check_recomputes_the_errored_bucket(
        self, session: Session
    ) -> None:
        """Issue #323: a human PASS on a judge-errored check empties the errored
        bucket — the run's failed count must not keep the phantom fail."""
        if not session.get(UserDB, "u1"):
            session.add(UserDB(id="u1", email="u1@test.com", name="U1", password_hash="x"))
        if not session.get(ProjectDB, "p1"):
            session.add(ProjectDB(id="p1", name="P1", created_by="u1"))
        session.flush()
        batch = AgentTaskBatchRunDB(
            id="b-err", project="p1", selection_type="task", status="completed", created_at=NOW
        )
        session.add(batch)
        session.flush()
        run = AgentTaskRunDB(
            id="r-err",
            batch_run_id="b-err",
            task_id="demo",
            task_path="/tasks/demo",
            status="failed",
            pass_result=False,
            started_at=NOW,
            completed_at=NOW,
        )
        session.add(run)
        session.flush()
        persist_check_report(
            session,
            run,
            [
                {"id": "ok", "pass": True, "reasoning": "ok"},
                {
                    "id": "blacked-out",
                    "pass": False,
                    "outcome": "error",
                    "reasoning": "judge failed: gateway timeout",
                    "assertions": [{"id": "judge", "pass": False, "outcome": "error"}],
                },
            ],
        )
        session.commit()
        assert run.errored_checks == 1
        assert run.failed_checks == 0

        result = correct_test_result(
            session,
            task_run=run,
            project="p1",
            test_id="blacked-out",
            action="set_pass",
            reason="Judge outage, not a quality miss — accepted on review",
            actor=ACTOR,
        )

        assert result.run_status == "passed"
        session.refresh(run)
        assert run.status == "passed"
        assert run.passed_checks == 2
        assert run.errored_checks == 0
        assert run.failed_checks == 0

    def test_fail_correction_on_passing_run(
        self, session: Session, seeded_run: AgentTaskRunDB
    ) -> None:
        result = correct_test_result(
            session,
            task_run=seeded_run,
            project="p1",
            test_id="keep-1",
            action="set_fail",
            reason="Trace contains a failed payment call the check missed",
            actor=ACTOR,
        )
        # still FAIL overall (it already was), but counts shift
        assert result.run_status == "failed"
        assert result.passed_tests == 1
        assert result.failed_tests == 2
        assert result.corrected_tests == 1

    def test_clear_restores_recorded(
        self, session: Session, seeded_run: AgentTaskRunDB
    ) -> None:
        correct_test_result(
            session,
            task_run=seeded_run,
            project="p1",
            test_id="the-flaw",
            action="set_pass",
            reason="temporary pass",
            actor=ACTOR,
        )
        result = correct_test_result(
            session,
            task_run=seeded_run,
            project="p1",
            test_id="the-flaw",
            action="clear",
            reason=None,
            actor=ACTOR,
        )
        assert result.effective_pass is False  # recorded was fail
        assert result.correction is None
        assert result.corrected_tests == 0
        assert result.run_status == "failed"

        rows = session.exec(
            __import__("sqlmodel").select(AgentTaskTestResultCorrectionDB)
        ).all()
        assert len(rows) == 2  # append-only history kept

    def test_idempotent_retry_appends_nothing(
        self, session: Session, seeded_run: AgentTaskRunDB
    ) -> None:
        args = dict(
            task_run=seeded_run,
            project="p1",
            test_id="the-flaw",
            action="set_pass",
            reason="  Retention is present; judge missed the table  ",
            actor=ACTOR,
        )
        correct_test_result(session, **args)  # type: ignore[arg-type]
        result = correct_test_result(session, **args)  # type: ignore[arg-type]

        rows = session.exec(
            __import__("sqlmodel").select(AgentTaskTestResultCorrectionDB)
        ).all()
        assert len(rows) == 1
        assert rows[0].reason == "Retention is present; judge missed the table"
        assert result.effective_pass is True

    def test_unknown_test_id_rejected_without_mutation(
        self, session: Session, seeded_run: AgentTaskRunDB
    ) -> None:
        with pytest.raises(CorrectionError) as exc:
            correct_test_result(
                session,
                task_run=seeded_run,
                project="p1",
                test_id="nope",
                action="set_pass",
                reason="a" * 30,
                actor=ACTOR,
            )
        assert exc.value.kind == "test_result_not_found"
        rows = session.exec(
            __import__("sqlmodel").select(AgentTaskTestResultCorrectionDB)
        ).all()
        assert rows == []

    def test_reason_validation(
        self, session: Session, seeded_run: AgentTaskRunDB
    ) -> None:
        for bad in (None, "", "  ", "x" * 2, "y" * 1001):
            with pytest.raises(CorrectionError) as exc:
                correct_test_result(
                    session,
                    task_run=seeded_run,
                    project="p1",
                    test_id="the-flaw",
                    action="set_pass",
                    reason=bad,
                    actor=ACTOR,
                )

    def test_clear_without_active_correction_rejected(
        self, session: Session, seeded_run: AgentTaskRunDB
    ) -> None:
        with pytest.raises(CorrectionError) as exc:
            correct_test_result(
                session,
                task_run=seeded_run,
                project="p1",
                test_id="the-flaw",
                action="clear",
                reason=None,
                actor=ACTOR,
            )
        assert exc.value.kind == "no_active_correction"

    def test_duplicate_test_ids_rejected(
        self, session: Session, seeded_run: AgentTaskRunDB
    ) -> None:
        from apo.services.check_report_storage import persist_check_report

        persist_check_report(
            session,
            seeded_run,
            [
                {"id": "dupe", "pass": True, "reasoning": "one"},
                {"id": "dupe", "pass": True, "reasoning": "two"},
            ],
        )
        session.commit()
        with pytest.raises(CorrectionError) as exc:
            correct_test_result(
                session,
                task_run=seeded_run,
                project="p1",
                test_id="dupe",
                action="set_fail",
                reason="d" * 40,
                actor=ACTOR,
            )
        assert exc.value.kind == "ambiguous_test_id"

    def test_non_terminal_run_rejected(self, session: Session) -> None:
        if not session.get(UserDB, "u1"):
            session.add(UserDB(id="u1", email="u1@test.com", name="U1", password_hash="x"))
        if not session.get(ProjectDB, "p1"):
            session.add(ProjectDB(id="p1", name="P1", created_by="u1"))
        session.flush()
        batch = AgentTaskBatchRunDB(
            id="b2", project="p1", selection_type="task", status="running", created_at=NOW
        )
        session.add(batch)
        session.flush()
        run = AgentTaskRunDB(
            id="r2",
            batch_run_id="b2",
            task_id="demo",
            task_path="/tasks/demo",
            status="running",
            pass_result=None,
            started_at=NOW,
        )
        session.add(run)
        session.commit()

        with pytest.raises(CorrectionError) as exc:
            correct_test_result(
                session,
                task_run=run,
                project="p1",
                test_id="anything",
                action="set_pass",
                reason="r" * 30,
                actor=ACTOR,
            )
        assert exc.value.kind == "run_not_correctable"
