"""Window automation ("monitor") tests: metric math, rising-edge firing, routes."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

import pytest
from sqlmodel import Session, select

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AutomationDB,
    UserDB,
)
from apo.services import automation_window_evaluator as we
from tests.conftest import engine as test_engine, seed_project_for_user

PROJECT = "win-project"


@pytest.fixture(autouse=True)
def db_schema():
    from sqlmodel import SQLModel

    SQLModel.metadata.create_all(test_engine)
    yield
    SQLModel.metadata.drop_all(test_engine)


@pytest.fixture(autouse=True)
def _bind_evaluator_engine():
    # The evaluator opens its own Session(engine); bind it to the test DB.
    original = we.engine
    we.engine = test_engine  # pyright: ignore[reportPrivateUsage]
    yield
    we.engine = original  # pyright: ignore[reportPrivateUsage]


def _seed_batch(
    session: Session,
    *,
    created_at: datetime | None = None,
    status: str = "completed",
    total_tasks: int = 4,
    passed_tasks: int = 3,
    failed_tasks: int = 1,
    errored_tasks: int = 0,
    total_checks: int = 10,
    passed_checks: int = 8,
    environment: str = "default",
    run_metadata: dict[str, object] | None = None,
    task_runs: list[dict[str, Any]] | None = None,
    batch_id: str | None = None,
) -> AgentTaskBatchRunDB:
    batch = AgentTaskBatchRunDB(
        id=batch_id or f"batch-{uuid4().hex[:16]}",
        project=PROJECT,
        selection_type="tasks",
        status=status,
        total_tasks=total_tasks,
        passed_tasks=passed_tasks,
        failed_tasks=failed_tasks,
        errored_tasks=errored_tasks,
        total_checks=total_checks,
        passed_checks=passed_checks,
        environment=environment,
        run_metadata=run_metadata,
        created_at=created_at or datetime.now(timezone.utc),
    )
    session.add(batch)
    session.commit()
    session.refresh(batch)
    for index, overrides in enumerate(task_runs or []):
        defaults: dict[str, Any] = {
            "id": f"tr-{uuid4().hex[:16]}",
            "batch_run_id": batch.id,
            "task_id": f"t-demo-{index}",
            "task_path": f"tasks/{index}",
            "status": "passed",
            "configured_model": "deepseek/deepseek-v4.1-flash",
        }
        defaults.update(overrides)
        session.add(AgentTaskRunDB(**defaults))
    session.commit()
    return batch


def _seed_project(session: Session) -> None:
    owner = "win-owner"
    if session.get(UserDB, owner) is None:
        session.add(
            UserDB(
                id=owner,
                email=f"{owner}@test.invalid",
                password_hash="not-a-real-hash",
                name=owner,
            )
        )
        session.commit()
    seed_project_for_user(session, owner, project_id=PROJECT)


def _window_automation(session: Session, **overrides: Any) -> AutomationDB:
    _seed_project(session)
    defaults: dict[str, Any] = {
        "id": "win-auto-1",
        "project_id": PROJECT,
        "name": "Suite pass-rate floor",
        "event_type": we.WINDOW_EVENT_TYPE,
        "trigger_kind": we.TRIGGER_WINDOW,
        "conditions": [],
        "window_metric": "suite_pass_rate",
        "window_operator": "lt",
        "window_threshold": 0.8,
        "evaluation_window": "24h",
        "action_type": "webhook",
        "action_config": {"url": "https://example.com/hook"},
        "secret": "whsec_test",
    }
    defaults.update(overrides)
    automation = AutomationDB(**defaults)
    session.add(automation)
    session.commit()
    session.refresh(automation)
    return automation


# ── Metric math ─────────────────────────────────────────────────────────────


class TestComputeWindowMetric:
    def test_pass_rate_over_batches(self):
        with Session(test_engine) as session:
            _seed_batch(session, total_tasks=4, passed_tasks=1)
            _seed_batch(session, total_tasks=4, passed_tasks=3, batch_id="b2")
            value = we.compute_window_metric(
                session, PROJECT, "suite_pass_rate", "24h", []
            )
            assert value == pytest.approx(4 / 8)

    def test_failed_and_errored_counts(self):
        with Session(test_engine) as session:
            _seed_batch(session, failed_tasks=2, errored_tasks=1)
            _seed_batch(session, failed_tasks=1, errored_tasks=1, batch_id="b2")
            assert (
                we.compute_window_metric(
                    session, PROJECT, "failed_tasks", "24h", []
                )
                == 3
            )
            assert (
                we.compute_window_metric(
                    session, PROJECT, "errored_tasks", "24h", []
                )
                == 2
            )

    def test_failed_checks_derived_from_check_counts(self):
        with Session(test_engine) as session:
            _seed_batch(session, total_checks=10, passed_checks=7)
            value = we.compute_window_metric(
                session, PROJECT, "failed_checks", "24h", []
            )
            assert value == 3.0

    def test_cost_sums_from_task_runs(self):
        with Session(test_engine) as session:
            _seed_batch(
                session,
                total_tasks=2,
                task_runs=[{"total_cost": 1.5}, {"total_cost": 2.5}],
            )
            _seed_batch(
                session,
                batch_id="b2",
                total_tasks=1,
                task_runs=[{"total_cost": 6.0}],
            )
            assert (
                we.compute_window_metric(
                    session, PROJECT, "total_cost", "24h", []
                )
                == pytest.approx(10.0)
            )
            assert (
                we.compute_window_metric(
                    session, PROJECT, "avg_cost", "24h", []
                )
                == pytest.approx(10.0 / 3)
            )
            assert (
                we.compute_window_metric(
                    session, PROJECT, "peak_cost", "24h", []
                )
                == pytest.approx(6.0)
            )

    def test_duration_metrics(self):
        now = datetime.now(timezone.utc)
        with Session(test_engine) as session:
            _seed_batch(
                session,
                created_at=now - timedelta(minutes=30),
                status="completed",
            )
            # started_at/completed_at are set post-hoc; the seeder does not
            # expose them, so patch the row directly.
            batch = session.exec(select(AgentTaskBatchRunDB)).first()
            batch.started_at = now - timedelta(minutes=10)
            batch.completed_at = now - timedelta(minutes=5)
            session.add(batch)
            session.commit()
            assert (
                we.compute_window_metric(
                    session, PROJECT, "avg_duration_s", "24h", []
                )
                == pytest.approx(300.0)
            )
            assert (
                we.compute_window_metric(
                    session, PROJECT, "peak_duration_s", "24h", []
                )
                == pytest.approx(300.0)
            )

    def test_no_runs_in_window_is_none_not_zero(self):
        with Session(test_engine) as session:
            _seed_batch(
                session, created_at=datetime.now(timezone.utc) - timedelta(days=10)
            )
            assert (
                we.compute_window_metric(
                    session, PROJECT, "suite_pass_rate", "24h", []
                )
                is None
            )

    def test_environment_filter(self):
        with Session(test_engine) as session:
            _seed_batch(session, environment="staging", passed_tasks=0)
            _seed_batch(
                session,
                environment="prod",
                total_tasks=2,
                passed_tasks=2,
                batch_id="b2",
            )
            value = we.compute_window_metric(
                session,
                PROJECT,
                "suite_pass_rate",
                "24h",
                [{"field": "environment", "operator": "=", "value": "staging"}],
            )
            assert value == 0.0

    def test_model_filter_via_task_runs(self):
        with Session(test_engine) as session:
            _seed_batch(
                session,
                total_tasks=1,
                passed_tasks=0,
                task_runs=[
                    {"configured_model": "google/gemini-2.5-flash", "status": "failed"}
                ],
            )
            _seed_batch(
                session,
                batch_id="b2",
                total_tasks=2,
                passed_tasks=2,
                task_runs=[
                    {"configured_model": "deepseek/deepseek-v4.1-flash"}
                ],
            )
            value = we.compute_window_metric(
                session,
                PROJECT,
                "suite_pass_rate",
                "24h",
                [
                    {
                        "field": "model",
                        "operator": "=",
                        "value": "deepseek/deepseek-v4.1-flash",
                    }
                ],
            )
            assert value == 1.0

    def test_task_contains_filter(self):
        with Session(test_engine) as session:
            _seed_batch(
                session,
                total_tasks=1,
                passed_tasks=1,
                task_runs=[{"task_id": "t-agent-demo-checkout"}],
            )
            _seed_batch(
                session,
                batch_id="b2",
                total_tasks=1,
                passed_tasks=0,
                failed_tasks=1,
                task_runs=[{"task_id": "t-other", "status": "failed"}],
            )
            value = we.compute_window_metric(
                session,
                PROJECT,
                "suite_pass_rate",
                "24h",
                [{"field": "task", "operator": "contains", "value": "t-agent-demo"}],
            )
            assert value == 1.0

    def test_trigger_source_filter(self):
        with Session(test_engine) as session:
            _seed_batch(
                session,
                passed_tasks=0,
                run_metadata={"trigger": {"source": "manual"}},
            )
            _seed_batch(
                session,
                batch_id="b2",
                total_tasks=2,
                passed_tasks=2,
                run_metadata={"trigger": {"source": "schedule"}},
            )
            value = we.compute_window_metric(
                session,
                PROJECT,
                "suite_pass_rate",
                "24h",
                [{"field": "trigger.source", "operator": "=", "value": "schedule"}],
            )
            assert value == 1.0


# ── Rising-edge evaluation ──────────────────────────────────────────────────


class TestEvaluationPasses:
    def test_fires_once_on_rising_edge_only(self):
        with Session(test_engine) as session:
            _seed_batch(session, passed_tasks=0)  # 0% — below the 0.8 floor
            automation = _window_automation(session)
            assert we.evaluate_windows_once() == [automation.id]
            session.expire_all()
            refreshed = session.get(AutomationDB, automation.id)
            assert refreshed is not None
            assert refreshed.was_breached is True
            assert refreshed.last_evaluated_value == 0.0
            # Still breached on the next pass — must NOT fire again.
            assert we.evaluate_windows_once() == []

    def test_refires_after_recovery(self):
        with Session(test_engine) as session:
            batch = _seed_batch(session, passed_tasks=0)
            automation = _window_automation(session)
            assert we.evaluate_windows_once() == [automation.id]
            # The suite recovers.
            batch.passed_tasks = batch.total_tasks
            session.add(batch)
            session.commit()
            assert we.evaluate_windows_once() == []
            # And breaks again — fires again.
            batch.passed_tasks = 0
            session.add(batch)
            session.commit()
            assert we.evaluate_windows_once() == [automation.id]

    def test_empty_window_is_armed_and_silent(self):
        with Session(test_engine) as session:
            _window_automation(session)
            assert we.evaluate_windows_once() == []
            session.expire_all()
            refreshed = session.exec(select(AutomationDB)).first()
            assert refreshed is not None
            assert refreshed.was_breached is False
            assert refreshed.last_evaluated_value is None

    def test_disabled_automation_is_skipped(self):
        with Session(test_engine) as session:
            _seed_batch(session, passed_tasks=0)
            _window_automation(session, enabled=False)
            assert we.evaluate_windows_once() == []


# ── Validation ──────────────────────────────────────────────────────────────


class TestValidation:
    def test_rejects_unknown_metric(self):
        with pytest.raises(Exception, match="Unknown window metric"):
            we.validate_window_config(
                metric="vibes", operator="lt", threshold=1, window="24h"
            )

    def test_rejects_unsupported_condition_field(self):
        with pytest.raises(Exception, match="cannot filter on"):
            we.validate_window_conditions(
                [{"field": "provider", "operator": "=", "value": "x"}]
            )

    def test_rejects_bad_operator_for_field(self):
        with pytest.raises(Exception, match="supports"):
            we.validate_window_conditions(
                [{"field": "model", "operator": "contains", "value": "x"}]
            )


# ── Routes ──────────────────────────────────────────────────────────────────

WINDOW_BODY: dict[str, Any] = {
    "project_id": PROJECT,
    "name": "Suite pass-rate floor",
    "trigger_kind": "window",
    "window_metric": "suite_pass_rate",
    "window_operator": "lt",
    "window_threshold": 0.8,
    "evaluation_window": "24h",
    "conditions": [],
    "action_type": "webhook",
    "action_config": {"url": "https://example.com/hook"},
}


class TestWindowAutomationRoutes:
    def test_create_and_list(self, make_authed_client, session: Session):
        _seed_project(session)
        client = make_authed_client("win-owner", session)
        resp = client.post("/v1/automations", json=WINDOW_BODY)
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["trigger_kind"] == "window"
        assert body["window_metric"] == "suite_pass_rate"
        assert body["evaluation_window"] == "24h"
        assert body["was_breached"] is False
        # The synthetic event type is derived, not client-supplied.
        assert body["event_type"] == "window.breached"

        listed = client.get(f"/v1/automations?project_id={PROJECT}").json()
        assert any(a["trigger_kind"] == "window" for a in listed)

    def test_create_rejects_unknown_metric(self, make_authed_client, session: Session):
        _seed_project(session)
        client = make_authed_client("win-owner", session)
        bad = {**WINDOW_BODY, "window_metric": "vibes"}
        resp = client.post("/v1/automations", json=bad)
        assert resp.status_code == 400
        assert "Unknown window metric" in resp.json()["detail"]

    def test_create_rejects_unsupported_condition_field(
        self, make_authed_client, session: Session
    ):
        _seed_project(session)
        client = make_authed_client("win-owner", session)
        bad = {
            **WINDOW_BODY,
            "conditions": [{"field": "provider", "operator": "=", "value": "x"}],
        }
        resp = client.post("/v1/automations", json=bad)
        assert resp.status_code == 400

    def test_evaluation_endpoint_computes_live_value(
        self, make_authed_client, session: Session
    ):
        _seed_project(session)
        _seed_batch(session, total_tasks=2, passed_tasks=1)
        client = make_authed_client("win-owner", session)
        created = client.post("/v1/automations", json=WINDOW_BODY).json()
        resp = client.get(f"/v1/automations/{created['id']}/evaluation")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["value"] == pytest.approx(0.5)
        assert body["breached"] is True

    def test_patch_updates_threshold_and_rearms(
        self, make_authed_client, session: Session
    ):
        _seed_project(session)
        client = make_authed_client("win-owner", session)
        created = client.post("/v1/automations", json=WINDOW_BODY).json()
        # Force a breached state, then edit the trigger definition.
        row = session.get(AutomationDB, created["id"])
        assert row is not None
        row.was_breached = True
        session.add(row)
        session.commit()

        resp = client.patch(
            f"/v1/automations/{created['id']}",
            json={"window_threshold": 0.95},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["window_threshold"] == 0.95
        session.expire_all()
        row = session.get(AutomationDB, created["id"])
        assert row is not None
        assert row.was_breached is False


class TestWindowMigration:
    def test_v51_adds_window_columns(self, tmp_path):
        import sqlalchemy as sa

        import apo.db as apo_db

        url = f"sqlite:///{tmp_path}/v51.db"
        old_engine = apo_db.engine
        apo_db.engine = sa.create_engine(url)
        try:
            apo_db.init_db()
            with apo_db.engine.begin() as conn:
                cols = [
                    c["name"] for c in sa.inspect(conn).get_columns("automations")
                ]
            for column in (
                "trigger_kind",
                "window_metric",
                "window_operator",
                "window_threshold",
                "evaluation_window",
                "was_breached",
                "last_evaluated_at",
                "last_evaluated_value",
            ):
                assert column in cols
        finally:
            apo_db.engine.dispose()
            apo_db.engine = old_engine
