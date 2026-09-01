"""Demo fixture loader.

Exercises the shipped placeholder fixture end-to-end: catalog + definitions,
batch/run/check-report/deliverable/judgment rows, schedules + occurrences,
views, and — the load-bearing part — the OTLP replay through the real
ingestion pipeline (canonical spans, task-run trace claim, projection).
Also pins the digest-gated reconcile semantics and fail-hard behavior.
"""

# pyright: reportPrivateUsage=false, reportUnusedCallResult=false

from __future__ import annotations

import json
from pathlib import Path

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy import create_engine as sa_create_engine
from sqlmodel import Session, SQLModel, col, select

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskDeliverableDB,
    AgentTaskJudgmentDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleOccurrenceDB,
    LoggedCallDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    RunDB,
    TaskViewDB,
)
from apo.services.demo_fixture import (
    _read_fixture_bytes,
    DemoFixtureError,
    load_demo_fixture,
)
from apo.services.demo_workspace import (
    DEMO_PROJECT_ID,
    ensure_demo_project_exists,
)
from apo.services.task_definition_revisions import ensure_task_definition_revision


@pytest.fixture(name="session")
def scratch_session_fixture(tmp_path: Path, monkeypatch: MonkeyPatch) -> Session:
    """A private scratch DB per test.

    The loader replays OTLP synchronously — per-span SAVEPOINTs nested in
    one long transaction. Sharing the suite-wide engine let savepoint
    state bleed into unrelated tests' teardown; a scratch engine keeps the
    fixture tests hermetic.
    """
    monkeypatch.setenv("APO_DEMO_ENABLED", "true")
    engine = sa_create_engine(f"sqlite:///{tmp_path}/demo.db")
    SQLModel.metadata.create_all(engine)
    assert ensure_demo_project_exists(Session(engine)) is True
    session = Session(engine)
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _load(session: Session, path: Path | None = None) -> bool:
    return load_demo_fixture(session, path=path)


class TestFixtureLoads:
    def test_load_returns_true_first_time(self, session: Session) -> None:
        assert _load(session) is True

    def test_catalog_and_definitions(self, session: Session) -> None:
        assert _load(session)
        inventory = session_exec_ids(session)
        assert "real-agent/documents/document-qa" in inventory
        assert "harbor/terminal-bench/count-dataset-tokens" in inventory
        assert "judge-flip-probe" in inventory

        revision = ensure_task_definition_revision(
            session,
            project_id=DEMO_PROJECT_ID,
            task_id="real-agent/documents/document-qa",
            document={
                "schema_version": 1,
                "files": [
                    {
                        "path": "document-qa.eval.ts",
                        "content": "placeholder",
                    }
                ],
            },
        )
        assert revision.id is not None  # dedupe on content digest returned a row

    def test_batches_runs_and_evidence(self, session: Session) -> None:
        assert _load(session)
        batches = session.exec(
            select(AgentTaskBatchRunDB).where(
                AgentTaskBatchRunDB.project == DEMO_PROJECT_ID
            )
        ).all()
        # The captured dataset (31 batches) plus the two pinned anchors.
        assert len(batches) >= 30
        assert {"demo-batch-001", "demo-batch-002"} <= {b.id for b in batches}

        run = session.get(AgentTaskRunDB, "demo-run-001")
        assert run is not None
        assert run.status == "failed"
        assert run.configured_model == "anthropic/claude-sonnet-4.5"
        assert run.task_id == "real-agent/documents/document-qa"

        deliverable = session.exec(
            select(AgentTaskDeliverableDB).where(
                AgentTaskDeliverableDB.task_run_id == "demo-run-001"
            )
        ).first()
        assert deliverable is not None
        assert deliverable.inline_value_json is not None

        judgment = session.exec(
            select(AgentTaskJudgmentDB).where(
                AgentTaskJudgmentDB.task_run_id == "demo-run-probe"
            )
        ).first()
        assert judgment is not None
        assert judgment.label in ("reasoning-first", "verdict-first")
        assert judgment.samples == 3

    def test_schedule_and_occurrences(self, session: Session) -> None:
        assert _load(session)
        schedule = session.get(AgentTaskScheduleDB, "demo-schedule-weekly")
        assert schedule is not None
        # The demo is read-only: schedules always load disabled.
        assert schedule.enabled is False
        assert schedule.next_run_at is None

        occurrences = session.exec(
            select(AgentTaskScheduleOccurrenceDB).where(
                AgentTaskScheduleOccurrenceDB.schedule_id == "demo-schedule-weekly"
            )
        ).all()
        statuses = {o.status for o in occurrences}
        assert "delivered" in statuses
        assert "missed" in statuses

    def test_views(self, session: Session) -> None:
        assert _load(session)
        views = session.exec(
            select(TaskViewDB).where(TaskViewDB.project_id == DEMO_PROJECT_ID)
        ).all()
        assert {v.id for v in views} >= {
            "demo-view-mini", "demo-view-haiku", "demo-view-sonnet",
        }

    def test_otel_replay_claims_and_projects(self, session: Session) -> None:
        assert _load(session)
        run = session.get(AgentTaskRunDB, "demo-run-001")
        assert run is not None
        # The atomic claim filled the trace link during replay.
        assert run.trace_run_id is not None
        assert run.trace_persistence_status == "persisted"

        # RunDB's PK is the row_id surrogate — resolve the trace by its
        # OTel id column, not session.get().
        trace = session.exec(
            select(RunDB).where(
                RunDB.id == run.trace_run_id,
                RunDB.project == DEMO_PROJECT_ID,
            )
        ).first()
        assert trace is not None
        assert trace.task_run_id == "demo-run-001"

        calls = session.exec(
            select(LoggedCallDB).where(
                LoggedCallDB.run_id == run.trace_run_id,
                LoggedCallDB.project == DEMO_PROJECT_ID,
            )
        ).all()
        # A real multi-turn agent trace: generations + tool calls.
        assert len(calls) >= 5
        models = {c.model for c in calls if c.model}
        assert "anthropic/claude-sonnet-4.5" in models


class TestReconcileSemantics:
    def test_second_load_is_a_no_op(self, session: Session) -> None:
        assert _load(session) is True
        before = _count_demo_rows(session)
        assert _load(session) is False
        assert _count_demo_rows(session) == before

    def test_digest_change_reloads(self, session: Session, tmp_path: Path) -> None:
        assert _load(session)
        document = json.loads(_read_fixture_bytes(Path(
            __import__("apo.services.demo_fixture", fromlist=["DEFAULTS_PATH"]).DEFAULTS_PATH
        )))
        document["batches"][0]["runs"][0]["status"] = "passed"
        variant = tmp_path / "variant.json"
        variant.write_text(json.dumps(document))

        assert _load(session, path=variant) is True
        run = session.get(AgentTaskRunDB, "demo-run-001")
        assert run is not None
        assert run.status == "passed"

        # The original file reloads back just as cleanly (full replace).
        assert _load(session) is True
        run = session.get(AgentTaskRunDB, "demo-run-001")
        assert run is not None
        assert run.status == "failed"

    def test_malformed_fixture_fails_hard(self, session: Session, tmp_path: Path) -> None:
        bad = tmp_path / "bad.json"
        bad.write_text("{not json")
        with pytest.raises(DemoFixtureError):
            _load(session, path=bad)

    def test_wrong_schema_version_fails_hard(
        self, session: Session, tmp_path: Path
    ) -> None:
        bad = tmp_path / "wrong-version.json"
        bad.write_text(json.dumps({"schema_version": 99}))
        with pytest.raises(DemoFixtureError):
            _load(session, path=bad)


class TestKillSwitch:
    def test_disabled_creates_nothing(
        self, session: Session, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_DEMO_ENABLED", "false")
        assert ensure_demo_project_exists(session) is False
        assert _load(session) is False
        source = session.exec(
            select(ProjectTaskSourceDB).where(
                ProjectTaskSourceDB.project == DEMO_PROJECT_ID
            )
        ).first()
        assert source is None


def session_exec_ids(session: Session) -> set[str]:
    return set(
        session.exec(
            select(ProjectTaskInventoryDB.task_id).where(
                ProjectTaskInventoryDB.project == DEMO_PROJECT_ID
            )
        ).all()
    )


def _count_demo_rows(session: Session) -> int:
    runs = len(
        session.exec(
            select(AgentTaskRunDB).where(
                col(AgentTaskRunDB.batch_run_id).in_(
                    select(AgentTaskBatchRunDB.id).where(
                        AgentTaskBatchRunDB.project == DEMO_PROJECT_ID
                    )
                )
            )
        ).all()
    )
    traces = len(
        session.exec(
            select(RunDB).where(RunDB.project == DEMO_PROJECT_ID)
        ).all()
    )
    return runs + traces
