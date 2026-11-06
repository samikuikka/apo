"""Demo fixture loader.

Exercises the shipped placeholder fixture end-to-end: catalog + definitions,
batch/run/check-report/deliverable/judgment rows, schedules + occurrences,
views, and (the load-bearing part) the OTLP replay through the real
ingestion pipeline (canonical spans, task-run trace claim, projection).
Also pins the digest-gated reconcile semantics and fail-hard behavior.
"""

# pyright: reportPrivateUsage=false, reportUnusedCallResult=false

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Generator
from pathlib import Path

import pytest
from _pytest.monkeypatch import MonkeyPatch
from _pytest.tmpdir import TempPathFactory
from sqlalchemy import create_engine as sa_create_engine
from sqlmodel import Session, SQLModel, col, select

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskDeliverableDB,
    AgentTaskJudgmentDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleOccurrenceDB,
    AgentTaskTestResultCorrectionDB,
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


@pytest.fixture(scope="module")
def golden_demo_db(tmp_path_factory: TempPathFactory) -> Path:
    """One loaded demo DB per process; every test asserts against a copy.

    A full load replays the shipped OTLP dataset through the real ingestion
    pipeline (~8s of CPU). This file used to load once per test, which
    dominated its wall time; one golden load plus per-test sqlite file
    copies keeps every test on its own engine AND its own file, so no
    savepoint or write can bleed between tests.
    """
    # Module scope cannot use the function-scoped monkeypatch, so pin the
    # gate by hand: an ambient APO_DEMO_ENABLED=false would make the golden
    # load silently skip and fail every test in this module at setup.
    saved = os.environ.get("APO_DEMO_ENABLED")
    os.environ["APO_DEMO_ENABLED"] = "true"
    try:
        db_path = tmp_path_factory.mktemp("demo-golden") / "golden.db"
        engine = sa_create_engine(f"sqlite:///{db_path}")
        SQLModel.metadata.create_all(engine)
        assert ensure_demo_project_exists(Session(engine)) is True
        assert load_demo_fixture(Session(engine)) is True
        engine.dispose()
        return db_path
    finally:
        if saved is None:
            os.environ.pop("APO_DEMO_ENABLED", None)
        else:
            os.environ["APO_DEMO_ENABLED"] = saved


@pytest.fixture(name="session")
def scratch_session_fixture(
    tmp_path: Path, monkeypatch: MonkeyPatch, golden_demo_db: Path
) -> Generator[Session, None, None]:
    """A private scratch DB per test, seeded from the golden load.

    The digest gate lives in the DB (ProjectTaskSourceDB.catalog_digest), so
    a copied file behaves exactly like a same-process reload.
    """
    monkeypatch.setenv("APO_DEMO_ENABLED", "true")
    db_path = tmp_path / "demo.db"
    shutil.copyfile(golden_demo_db, db_path)
    engine = sa_create_engine(f"sqlite:///{db_path}")
    session = Session(engine)
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture(name="empty_session")
def empty_session_fixture(
    tmp_path: Path, monkeypatch: MonkeyPatch
) -> Generator[Session, None, None]:
    """Schema and demo project, but no fixture load yet."""
    monkeypatch.setenv("APO_DEMO_ENABLED", "true")
    engine = sa_create_engine(f"sqlite:///{tmp_path}/demo-empty.db")
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
    def test_load_returns_true_first_time(self, empty_session: Session) -> None:
        assert _load(empty_session) is True

    def test_catalog_and_definitions(self, session: Session) -> None:
        inventory = session_exec_ids(session)
        assert "tasks/dabstep/dabstep-merchant-high-fraud-fine-risk" in inventory
        assert "tasks/dabstep/dabstep-issuing-country-most-transactions" in inventory
        # The merged real-agent dataset keeps its own task family.
        assert "real-agent/documents/document-qa" in inventory
        assert "real-agent/security/security-audit" in inventory

        # Tree-backed tasks carry their path under the demo task root so
        # project-scoped file reads resolve inside the task folder; the
        # dabstep family has no tree counterpart and must stay pathless
        # (its source ships as pinned definitions instead).
        doc_qa = session.exec(
            select(ProjectTaskInventoryDB).where(
                ProjectTaskInventoryDB.id == "demo-inv-real-agent/documents/document-qa"
            )
        ).first()
        assert doc_qa is not None
        assert doc_qa.task_path == "real-agent/documents/document-qa"
        dabstep = session.exec(
            select(ProjectTaskInventoryDB).where(
                ProjectTaskInventoryDB.id
                == "demo-inv-tasks/dabstep/dabstep-merchant-high-fraud-fine-risk"
            )
        ).first()
        assert dabstep is not None
        assert dabstep.task_path == ""

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

    def test_error_runs_carry_a_no_verdict_reason(self, session: Session) -> None:
        """Every consumer reads ``no_verdict_reason``, so a demo ``error`` run
        without one would render as neither an executor error nor a no-verdict."""
        runs = session.exec(select(AgentTaskRunDB)).all()
        errored = [r for r in runs if r.status == "error"]
        assert errored
        assert {r.no_verdict_reason for r in errored} == {"executor"}
        assert all(r.no_verdict_reason is None for r in runs if r.status != "error")

    def test_runs_pinned_to_definition_revisions(self, session: Session) -> None:
        """Every catalog task ships a definition and every run is pinned to
        it, so the run page can render check source through the run-bound
        reader (issue: demo checks showed bare pass/fail with no code)."""
        from apo.services.task_definition_revisions import (
            get_definition_for_run,
            read_definition_source,
        )

        # The dabstep family has no counterpart in the bundled demo tree —
        # the pinned revision is the ONLY source path for its runs.
        run = session.get(AgentTaskRunDB, "demo-run-001")
        assert run is not None
        assert run.task_definition_revision_id is not None
        rev = get_definition_for_run(session, run.id)
        assert rev is not None
        path = str(rev.source_files_json[0]["path"])
        source = read_definition_source(session, task_run_id=run.id, file_path=path)
        assert source is not None
        assert "dabstep-merchant-high-fraud-fine-risk.eval.ts" == path
        # The check ids the fixture's check reports reference appear
        # literally in the served source, so the code view can anchor them.
        for check_id in ("computed-via-python", "answer-matches-benchmark"):
            assert f'"{check_id}"' in source["content"]

        # Tree-backed family: pinned as well, not only fallback-readable.
        ra_run = session.get(AgentTaskRunDB, "demo-run-ra-001")
        assert ra_run is not None
        assert ra_run.task_definition_revision_id is not None
        ra_source = read_definition_source(
            session, task_run_id=ra_run.id, file_path="document-qa.eval.ts"
        )
        assert ra_source is not None
        assert '"read-spec-and-searched"' in ra_source["content"]

    def test_batches_runs_and_evidence(self, session: Session) -> None:
        batches = session.exec(
            select(AgentTaskBatchRunDB).where(
                AgentTaskBatchRunDB.project == DEMO_PROJECT_ID
            )
        ).all()
        # DABstep dataset (22 runs) + merged real-agent dataset (30 runs)
        # plus the pinned anchors on both sides.
        assert len(batches) >= 50
        assert {"demo-batch-001", "demo-batch-002"} <= {b.id for b in batches}
        assert {"demo-batch-ra-001", "demo-batch-ra-002"} <= {b.id for b in batches}

        run = session.get(AgentTaskRunDB, "demo-run-001")
        assert run is not None
        assert run.status == "failed"
        assert run.configured_model == "z-ai/glm-5.3-flash"
        assert run.task_id == "tasks/dabstep/dabstep-merchant-high-fraud-fine-risk"

        # The real-agent flagship: document-qa judged against sonnet.
        ra_run = session.get(AgentTaskRunDB, "demo-run-ra-001")
        assert ra_run is not None
        assert ra_run.status == "failed"
        assert ra_run.configured_model == "anthropic/claude-sonnet-4.5"
        assert ra_run.task_id == "real-agent/documents/document-qa"

        deliverable = session.exec(
            select(AgentTaskDeliverableDB).where(
                AgentTaskDeliverableDB.task_run_id == "demo-run-001"
            )
        ).first()
        assert deliverable is not None
        assert deliverable.inline_value_json is not None

        judgment = session.exec(
            select(AgentTaskJudgmentDB).where(
                AgentTaskJudgmentDB.task_run_id == "demo-run-001"
            )
        ).first()
        assert judgment is not None
        assert judgment.samples == 3

    def test_schedule_and_occurrences(self, session: Session) -> None:
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

        # The real-agent side keeps its own schedule under a renamed anchor.
        regression = session.get(AgentTaskScheduleDB, "demo-schedule-regression")
        assert regression is not None
        assert regression.enabled is False
        ra_occurrences = session.exec(
            select(AgentTaskScheduleOccurrenceDB).where(
                AgentTaskScheduleOccurrenceDB.schedule_id == "demo-schedule-regression"
            )
        ).all()
        assert {o.status for o in ra_occurrences} >= {"delivered", "missed"}

    def test_views(self, session: Session) -> None:
        views = session.exec(
            select(TaskViewDB).where(TaskViewDB.project_id == DEMO_PROJECT_ID)
        ).all()
        assert {v.id for v in views} >= {"demo-view-1", "demo-view-2"}
        # Merged real-agent model views.
        assert {"demo-view-mini", "demo-view-sonnet"} <= {v.id for v in views}

    def test_merged_correction_loads(self, session: Session) -> None:
        corrections = session.exec(
            select(AgentTaskTestResultCorrectionDB).where(
                AgentTaskTestResultCorrectionDB.task_run_id == "demo-run-corrected"
            )
        ).all()
        assert corrections
        assert {c.action for c in corrections} == {"set_pass"}

    def test_otel_replay_claims_and_projects(self, session: Session) -> None:
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
        assert "z-ai/glm-5.3-flash" in models


class TestReconcileSemantics:
    def test_second_load_is_a_no_op(self, session: Session) -> None:
        # The scratch copy arrives already loaded, so this call IS the
        # second, digest-gated load.
        before = _count_demo_rows(session)
        assert before > 0
        assert _load(session) is False
        assert _count_demo_rows(session) == before

    def test_digest_change_reloads(self, session: Session, tmp_path: Path) -> None:
        import apo.services.demo_fixture as fixture_mod
        document = json.loads(_read_fixture_bytes(Path(fixture_mod.DEFAULTS_PATH)))
        anchor = next(
            r for b in document["batches"] for r in b["runs"] if r["id"] == "demo-run-001"
        )
        anchor["status"] = "passed"
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
        self, empty_session: Session, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_DEMO_ENABLED", "false")
        assert ensure_demo_project_exists(empty_session) is False
        assert _load(empty_session) is False
        source = empty_session.exec(
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
