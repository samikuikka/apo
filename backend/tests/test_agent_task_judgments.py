"""Issue #159: re-judge judgments on completed Task Runs.

A Run's verdict is welded to the judge that ran it. These tests cover the
judgment record API: a completed Run gains 1..N judgments — the original
(synthesized from the run row + check report) plus recorded ``rejudge``
judgments replayed against the Run's stored Deliverables. The original
verdict is never overwritten.
"""

# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUnusedImport=false
# pyright: reportAttributeAccessIssue=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.db import LATEST_SCHEMA_VERSION, _SCHEMA_MIGRATIONS
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskJudgmentDB,
    AgentTaskRunDB,
    ProjectDB,
    UserDB,
)
from apo.services.check_report_storage import persist_check_report
from apo.services.task_definition_revisions import (
    ensure_task_definition_revision,
)
from apo.services.project_deletion import delete_project_data
from apo.services.retention import _delete_old_batch_runs

NOW = datetime.now(timezone.utc)


def _doc(content: str, path: str = "demo.eval.ts") -> dict[str, object]:
    return {"schema_version": 1, "files": [{"path": path, "content": content}]}


def _checks(passing: int = 1, failing: int = 0, judge_model: str | None = None) -> list[dict[str, object]]:
    checks: list[dict[str, object]] = []
    for i in range(passing):
        checks.append({"id": f"pass-{i}", "pass": True, "reasoning": "passed"})
    for i in range(failing):
        entry: dict[str, object] = {"id": f"fail-{i}", "pass": False, "reasoning": "nope"}
        if judge_model:
            entry["judge"] = {"model": judge_model}
        checks.append(entry)
    return checks


def _seed_run(
    session: Session,
    *,
    run_id: str = "run-1",
    project: str = "p1",
    task_id: str = "demo",
    status: str = "passed",
    with_revision: bool = True,
    with_report: bool = True,
) -> AgentTaskRunDB:
    """Seed project → batch → run (+ pinned revision, + check report)."""
    if not session.get(UserDB, "u1"):
        session.add(UserDB(id="u1", email="u1@test.com", name="U1", password_hash="x"))
    if not session.get(ProjectDB, project):
        session.add(ProjectDB(id=project, name=f"Project {project}", created_by="u1"))
    session.flush()
    revision_id = None
    if with_revision:
        rev = ensure_task_definition_revision(
            session,
            project_id=project,
            task_id=task_id,
            document=_doc(f"task('{task_id}', {{ adapter: 'a' }});\n"),
        )
        revision_id = rev.id
    batch = AgentTaskBatchRunDB(
        id=f"batch-{run_id}",
        project=project,
        selection_type="task",
        status="completed",
        created_at=NOW,
    )
    session.add(batch)
    session.flush()
    run = AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch.id,
        task_id=task_id,
        task_path=f"/tasks/{task_id}",
        status=status,
        pass_result=True if status == "passed" else (False if status == "failed" else None),
        started_at=NOW,
        completed_at=NOW,
        task_definition_revision_id=revision_id,
    )
    session.add(run)
    session.flush()
    if with_report:
        persist_check_report(session, run, _checks(passing=3, failing=1, judge_model="orig/judge"))
    session.commit()
    return run


class TestMigration:
    def test_v31_registered(self) -> None:
        assert LATEST_SCHEMA_VERSION >= 31
        assert 31 in _SCHEMA_MIGRATIONS


class TestCreateJudgment:
    def test_creates_rejudge_judgment_with_derived_counts(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session)
        revision_id = run.task_definition_revision_id

        response = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={
                "label": "sonnet calibration",
                "judge_model": "anthropic/claude-sonnet-4.5",
                "task_definition_revision_id": revision_id,
                "samples": 3,
                "checks": _checks(passing=2, failing=1),
                "stability": [
                    {"check_id": "fail-0", "passes": 1, "samples": 3}
                ],
            },
        )

        assert response.status_code == 201, response.text
        body = response.json()
        assert body["id"].startswith("jdg_")
        assert body["trigger"] == "rejudge"
        assert body["label"] == "sonnet calibration"
        assert body["judge_model"] == "anthropic/claude-sonnet-4.5"
        assert body["task_definition_revision_id"] == revision_id
        assert body["definition_revision_matches_run"] is True
        assert body["samples"] == 3
        assert body["pass_result"] is False
        assert body["total_checks"] == 3
        assert body["passed_checks"] == 2
        assert body["failed_checks"] == 1
        # The original verdict is untouched.
        session.refresh(run)
        assert run.pass_result is True
        assert run.total_checks == 4

    def test_unknown_run_returns_404(self, client: TestClient, session: Session) -> None:
        _seed_run(session)
        response = client.post(
            "/v1/agent-task-runs/nope/judgments",
            json={"checks": _checks()},
        )
        assert response.status_code == 404

    def test_running_run_rejected(self, client: TestClient, session: Session) -> None:
        run = _seed_run(session, run_id="run-live", status="running", with_report=False)
        response = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": _checks()},
        )
        assert response.status_code == 409

    def test_error_run_rejected(self, client: TestClient, session: Session) -> None:
        run = _seed_run(session, run_id="run-err", status="error", with_report=False)
        response = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": _checks()},
        )
        assert response.status_code == 409

    def test_empty_checks_rejected(self, client: TestClient, session: Session) -> None:
        run = _seed_run(session)
        response = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": []},
        )
        assert response.status_code == 400

    def test_invalid_samples_rejected(self, client: TestClient, session: Session) -> None:
        run = _seed_run(session)
        response = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": _checks(), "samples": 0},
        )
        assert response.status_code == 400

    def test_revision_for_other_task_rejected(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session)
        other = ensure_task_definition_revision(
            session, project_id="p1", task_id="other-task", document=_doc("task('other');")
        )
        session.commit()
        response = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": _checks(), "task_definition_revision_id": other.id},
        )
        assert response.status_code == 404

    def test_defaults_revision_to_run_pin(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session)
        response = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": _checks()},
        )
        assert response.status_code == 201
        assert response.json()["task_definition_revision_id"] == run.task_definition_revision_id


class TestListJudgments:
    def test_original_is_synthesized_and_rejudges_listed_newest_first(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session)
        first = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"label": "first", "checks": _checks(passing=1)},
        ).json()
        second = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"label": "second", "checks": _checks(passing=0, failing=1)},
        ).json()

        response = client.get(f"/v1/agent-task-runs/{run.id}/judgments")

        assert response.status_code == 200
        body = response.json()
        assert body["task_run_id"] == run.id
        judgments = body["judgments"]
        assert [j["id"] for j in judgments] == [run.id, second["id"], first["id"]]
        original = judgments[0]
        assert original["trigger"] == "original"
        assert original["judge_model"] == "orig/judge"
        assert original["total_checks"] == 4
        assert original["passed_checks"] == 3
        assert original["failed_checks"] == 1
        # List responses carry summaries — no full check evidence.
        assert original["checks"] is None

    def test_judgment_detail_returns_full_checks(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session)
        created = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": _checks(passing=1, failing=1)},
        ).json()

        detail = client.get(
            f"/v1/agent-task-runs/{run.id}/judgments/{created['id']}"
        )
        assert detail.status_code == 200
        assert [c["id"] for c in detail.json()["checks"]] == ["pass-0", "fail-0"]

        original = client.get(f"/v1/agent-task-runs/{run.id}/judgments/{run.id}")
        assert original.status_code == 200
        assert original.json()["trigger"] == "original"
        assert len(original.json()["checks"]) == 4

    def test_unknown_judgment_404(self, client: TestClient, session: Session) -> None:
        run = _seed_run(session)
        response = client.get(f"/v1/agent-task-runs/{run.id}/judgments/jdg_missing")
        assert response.status_code == 404


class TestDefinitionSource:
    def test_serves_pinned_revision_content(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session)
        response = client.get(f"/v1/agent-task-runs/{run.id}/definition-source")
        assert response.status_code == 200
        body = response.json()
        assert body["task_definition_revision_id"] == run.task_definition_revision_id
        assert body["task_id"] == "demo"
        assert body["files"][0]["path"] == "demo.eval.ts"
        assert "task('demo'" in body["files"][0]["content"]

    def test_explicit_revision_for_same_task(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session)
        other = ensure_task_definition_revision(
            session,
            project_id="p1",
            task_id="demo",
            document=_doc("task('demo', { adapter: 'a' });\n// v2\n"),
        )
        session.commit()
        response = client.get(
            f"/v1/agent-task-runs/{run.id}/definition-source",
            params={"revision": other.id},
        )
        assert response.status_code == 200
        assert response.json()["task_definition_revision_id"] == other.id
        assert "// v2" in response.json()["files"][0]["content"]

    def test_revision_for_other_task_404(self, client: TestClient, session: Session) -> None:
        run = _seed_run(session)
        other = ensure_task_definition_revision(
            session, project_id="p1", task_id="elsewhere", document=_doc("task('e');")
        )
        session.commit()
        response = client.get(
            f"/v1/agent-task-runs/{run.id}/definition-source",
            params={"revision": other.id},
        )
        assert response.status_code == 404

    def test_run_without_revision_404(self, client: TestClient, session: Session) -> None:
        run = _seed_run(session, run_id="run-norev", with_revision=False)
        response = client.get(f"/v1/agent-task-runs/{run.id}/definition-source")
        assert response.status_code == 404


class TestRunDetailExposure:
    def test_run_detail_reports_judgments_count(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session)
        before = client.get(f"/v1/agent-task-runs/{run.id}").json()
        assert before["judgments_count"] == 0

        client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": _checks()},
        )
        after = client.get(f"/v1/agent-task-runs/{run.id}").json()
        assert after["judgments_count"] == 1


class TestJudgmentLifecycle:
    def test_retention_removes_judgments_before_task_runs(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session, run_id="run-retention")
        run_id = run.id
        created = client.post(
            f"/v1/agent-task-runs/{run_id}/judgments",
            json={"checks": _checks()},
        ).json()

        _delete_old_batch_runs(session, NOW + timedelta(days=1))
        session.expire_all()

        assert session.get(AgentTaskJudgmentDB, created["id"]) is None
        assert session.get(AgentTaskRunDB, run_id) is None

    def test_project_deletion_removes_judgments(
        self, client: TestClient, session: Session
    ) -> None:
        run = _seed_run(session, run_id="run-project-delete")
        created = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": _checks()},
        ).json()

        delete_project_data(
            session,
            "p1",
            keep_project=False,
            keep_api_keys=False,
        )

        assert session.get(AgentTaskJudgmentDB, created["id"]) is None
        assert session.get(AgentTaskRunDB, run.id) is None


class TestProjectionMemberAccess:
    def test_member_can_reach_projection_endpoint(
        self, client: TestClient, session: Session
    ) -> None:
        """A project member (not a service token) passes authorization.

        The run has no claimed trace, so the response is 409 — which proves
        the request got PAST auth (previously non-token callers got 403).
        """
        run = _seed_run(session, run_id="run-proj", with_report=False)
        run.trace_run_id = None
        session.add(run)
        session.commit()

        response = client.get(f"/v1/agent-task-runs/{run.id}/trace-projection")
        assert response.status_code == 409


def _agent_checks(session: dict[str, object], *, evaluator: str = "agent",
                  outcome_mismatch: bool = False) -> list[dict[str, object]]:
    judge = {"model": "z-ai/glm-5.3-flash", "temperature": 0, "session": session}
    assertion: dict[str, object] = {
        "id": "check", "pass": outcome_mismatch is False,
        "reasoning": "ok", "evaluator_type": evaluator, "judge": judge,
    }
    return [{"id": "c", "pass": True, "reasoning": "ok",
             "evaluator_type": evaluator, "assertions": [assertion]}]


def _valid_session(outcome: str = "verdict") -> dict[str, object]:
    return {
        "tools": ["finish_verdict"], "outcome": outcome, "steps": [], "evidence": [],
        "usage": {"steps": 2, "input_tokens": 10, "output_tokens": 5},
    }


class TestCreateJudgmentAgentSessionValidation:
    def test_session_requires_agent_evaluator(self, client: TestClient, session: Session) -> None:
        run = _seed_run(session)
        response = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": _agent_checks(_valid_session(), evaluator="llm"), "samples": 1},
        )
        assert response.status_code == 422
        assert "evaluator_type" in response.text

    def test_session_requires_outcome(self, client: TestClient, session: Session) -> None:
        run = _seed_run(session)
        body_session = {k: v for k, v in _valid_session().items() if k != "outcome"}
        response = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": _agent_checks(body_session), "samples": 1},
        )
        assert response.status_code == 422
        assert "outcome" in response.text

    def test_outcome_verdict_requires_verdict_fields(self, client: TestClient, session: Session) -> None:
        run = _seed_run(session)
        checks = _agent_checks(_valid_session("verdict"))
        checks[0]["assertions"][0]["pass"] = None  # type: ignore[assignment]
        checks[0]["assertions"][0].pop("pass")
        checks[0]["assertions"][0]["reasoning"] = ""
        response = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": checks, "samples": 1},
        )
        assert response.status_code == 422

    def test_valid_agent_judgment_round_trips(self, client: TestClient, session: Session) -> None:
        run = _seed_run(session)
        response = client.post(
            f"/v1/agent-task-runs/{run.id}/judgments",
            json={"checks": _agent_checks(_valid_session()), "samples": 1},
        )
        assert response.status_code == 201, response.text
