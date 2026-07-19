# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Tests for the TraceRepository write boundary (SPEC-129 §4)."""

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select, text
from apo.db import engine, init_db
from apo.models.db import RunDB, LoggedCallDB
from apo.services.trace_repository import NativeTraceRepository


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM call_metrics"))
        session.execute(text("DELETE FROM run_metrics"))
        session.execute(text("DELETE FROM logged_calls"))
        session.execute(text("DELETE FROM runs"))
        session.commit()


def _get_run(session: Session, trace_id: str, project: str = "p1") -> RunDB | None:
    """Scoped lookup — surrogate PK means session.get() needs row_id."""
    return session.exec(
        select(RunDB).where(RunDB.id == trace_id, RunDB.project == project)
    ).first()


def _get_call(session: Session, span_id: str, project: str = "p1") -> LoggedCallDB | None:
    return session.exec(
        select(LoggedCallDB).where(LoggedCallDB.id == span_id, LoggedCallDB.project == project)
    ).first()


class TestRepositoryWrites:
    """The repository handles all write operations through its interface."""

    def test_upsert_trace_creates_run(self):
        repo = NativeTraceRepository()
        with Session(engine) as session:
            repo.upsert_trace(
                session,
                trace_id="repo-w-001",
                project_id="test-proj",
                flow_name="my-flow",
            )
            session.commit()

        with Session(engine) as session:
            run = _get_run(session, "repo-w-001", "test-proj")
            assert run is not None
            assert run.project == "test-proj"
            assert run.flow_name == "my-flow"

    def test_upsert_trace_updates_existing(self):
        repo = NativeTraceRepository()
        with Session(engine) as session:
            repo.upsert_trace(session, trace_id="repo-w-002", project_id="p1")
            repo.upsert_trace(
                session, trace_id="repo-w-002", project_id="p1", flow_name="updated-flow"
            )
            session.commit()

        with Session(engine) as session:
            run = _get_run(session, "repo-w-002", "p1")
            assert run is not None
            assert run.flow_name == "updated-flow"

    def test_upserts_same_otel_ids_independently_by_project(self):
        repo = NativeTraceRepository()
        with Session(engine) as session:
            repo.upsert_trace(
                session,
                trace_id="shared-trace",
                project_id="p1",
                flow_name="project-one",
            )
            repo.upsert_trace(
                session,
                trace_id="shared-trace",
                project_id="p2",
                flow_name="project-two",
            )
            repo.upsert_observation(
                session,
                span_id="shared-span",
                trace_id="shared-trace",
                project_id="p1",
                model="model-one",
            )
            repo.upsert_observation(
                session,
                span_id="shared-span",
                trace_id="shared-trace",
                project_id="p2",
                model="model-two",
            )
            repo.complete_trace(
                session,
                trace_id="shared-trace",
                project_id="p2",
            )
            session.commit()

        with Session(engine) as session:
            run_one = _get_run(session, "shared-trace", "p1")
            run_two = _get_run(session, "shared-trace", "p2")
            call_one = _get_call(session, "shared-span", "p1")
            call_two = _get_call(session, "shared-span", "p2")

            assert run_one is not None and run_one.flow_name == "project-one"
            assert run_one.completed_at is None
            assert run_two is not None and run_two.flow_name == "project-two"
            assert run_two.completed_at is not None
            assert call_one is not None and call_one.model == "model-one"
            assert call_two is not None and call_two.model == "model-two"

    def test_upsert_observation_creates_call(self):
        repo = NativeTraceRepository()
        with Session(engine) as session:
            repo.upsert_trace(session, trace_id="repo-w-003", project_id="p1")
            repo.upsert_observation(
                session,
                span_id="span-w-003",
                trace_id="repo-w-003",
                project_id="p1",
                observation_type="GENERATION",
                model="gpt-4o",
                prompt_tokens=100,
                completion_tokens=50,
            )
            session.commit()

        with Session(engine) as session:
            call = _get_call(session, "span-w-003", "p1")
            assert call is not None
            assert call.model == "gpt-4o"
            assert call.prompt_tokens == 100

    def test_upsert_observation_updates_existing(self):
        repo = NativeTraceRepository()
        with Session(engine) as session:
            repo.upsert_trace(session, trace_id="repo-w-004", project_id="p1")
            repo.upsert_observation(
                session, span_id="span-w-004", trace_id="repo-w-004",
                project_id="p1", observation_type="SPAN", model="",
            )
            repo.upsert_observation(
                session, span_id="span-w-004", trace_id="repo-w-004",
                project_id="p1", observation_type="GENERATION", model="gpt-4o",
            )
            session.commit()

        with Session(engine) as session:
            call = _get_call(session, "span-w-004", "p1")
            assert call is not None
            assert call.observation_type == "GENERATION"
            assert call.model == "gpt-4o"

    def test_complete_trace(self):
        repo = NativeTraceRepository()
        with Session(engine) as session:
            repo.upsert_trace(session, trace_id="repo-w-005", project_id="p1")
            repo.complete_trace(
                session,
                trace_id="repo-w-005",
                project_id="p1",
                duration_ms=5000.0,
            )
            session.commit()

        with Session(engine) as session:
            run = _get_run(session, "repo-w-005", "p1")
            assert run is not None
            assert run.completed_at is not None
            assert run.duration_ms == 5000.0

    def test_complete_trace_idempotent(self):
        """Completing an already-complete trace is a no-op."""
        repo = NativeTraceRepository()
        with Session(engine) as session:
            repo.upsert_trace(session, trace_id="repo-w-006", project_id="p1")
            repo.complete_trace(
                session,
                trace_id="repo-w-006",
                project_id="p1",
                duration_ms=1000.0,
            )
            first = _get_run(session, "repo-w-006", "p1")
            first_completed = first.completed_at if first else None
            repo.complete_trace(
                session,
                trace_id="repo-w-006",
                project_id="p1",
                duration_ms=2000.0,
            )
            session.commit()

        assert first_completed is not None
        with Session(engine) as session:
            second = _get_run(session, "repo-w-006", "p1")
            assert second is not None
            assert second.completed_at == first_completed
