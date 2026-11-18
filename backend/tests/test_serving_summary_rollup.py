# pyright: reportAny=false, reportExplicitAny=false, reportUnusedImport=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnknownMemberType=false

"""Persisted per-run serving summaries on agent_task_runs.

The list and detail routes used to recompute each run's ServingSummary
from every logged_calls row on every request (5.8k rows, up to 1.7 s on
production). The rollup is now written at the same sites as
model_providers_json (finalize aggregation and the projector's task-run
recompute) and readers serve the stored value, computing only when the
column is null or unparseable.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone
from typing import Any

import pytest
from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, col, create_engine, delete, select

import apo.db as apo_db
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    LoggedCallDB,
    OtlpSpanDB,
    RunDB,
)
from apo.services.serving import (
    stored_serving_summary,
    summarize_calls,
    to_serving_call,
)
from apo.services.trace_backend import NativeTraceBackend
from apo.services.trace_projector import TraceProjector

_PROJECT = "rollup-proj"
_TASK_ID = "template/serving-rollup"


# ---------------------------------------------------------------------------
# Unit: write-then-read roundtrip
# ---------------------------------------------------------------------------


def _rollup_call(
    span: str,
    *,
    run_id: str,
    observation_type: str = "GENERATION",
    accounting: str | None = "request",
    model: str = "deepseek/deepseek-v4.1-flash",
    api_provider: str | None = "openrouter",
    serving_host: str | None = "baseten",
) -> LoggedCallDB:
    return LoggedCallDB(
        id=span,
        run_id=run_id,
        project=_PROJECT,
        task_id="",
        input={},
        messages=[],
        output={},
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        model=model,
        api_provider=api_provider,
        serving_host=serving_host,
        request_accounting=accounting,
        observation_type=observation_type,
        level="DEFAULT",
        completion_tokens=90,
    )


def test_write_then_read_roundtrip_equality(session: Session) -> None:
    """aggregate_costs stores a summary that parses back equal to a fresh
    compute over the same calls."""
    session.add(
        AgentTaskBatchRunDB(
            id="batch-rt",
            project=_PROJECT,
            selection_type="task",
            status="completed",
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
    )
    task_run = AgentTaskRunDB(
        id="run-rt",
        batch_run_id="batch-rt",
        task_id=_TASK_ID,
        task_path=f"/tmp/tasks/{_TASK_ID}",
        status="passed",
        trace_run_id="trace-rt",
    )
    session.add(task_run)
    calls = [
        _rollup_call("call-rt-1", run_id="trace-rt"),
        _rollup_call(
            "call-rt-2",
            run_id="trace-rt",
            api_provider="fireworks",
            serving_host="fireworks",
        ),
        _rollup_call(
            "call-rt-tool",
            run_id="trace-rt",
            observation_type="TOOL",
            accounting=None,
        ),
        _rollup_call(
            "call-rt-agg",
            run_id="trace-rt",
            accounting="aggregate",
            observation_type="CHAIN",
        ),
    ]
    session.add_all(calls)
    session.commit()

    NativeTraceBackend().aggregate_costs(session, task_run, _PROJECT)
    session.commit()
    session.refresh(task_run)

    stored = stored_serving_summary(task_run)
    fresh = summarize_calls([to_serving_call(call) for call in calls])
    assert stored is not None
    assert stored == fresh
    assert stored.calls == 2
    assert stored.aggregate_observations == 1
    assert {group.identity.api_provider for group in stored.groups} == {
        "openrouter",
        "fireworks",
    }


# ---------------------------------------------------------------------------
# Unit: late spans refresh the stored summary
# ---------------------------------------------------------------------------


_ROOT_ATTRS: dict[str, object] = {"apo.observation.type": "AGENT"}


def _gen_attrs(*, provider: str, host: str) -> dict[str, object]:
    return {
        "ai.model.id": "deepseek/deepseek-v4.1-flash",
        "ai.operation.name": "streamText.doStream",
        "apo.llm.api_provider": provider,
        "apo.llm.serving_host": host,
        "apo.llm.request_kind": "request",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 90,
    }


def _span(
    span_id: str,
    attrs: dict[str, object],
    *,
    trace_id: str,
    parent: str | None,
) -> OtlpSpanDB:
    return OtlpSpanDB(
        project_id=_PROJECT,
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent,
        span_name=span_id,
        attributes=dict(attrs),
        resource={},
        start_time=datetime(2026, 1, 1, tzinfo=timezone.utc),
        end_time=datetime(2026, 1, 1, 0, 0, 2, tzinfo=timezone.utc),
    )


def _seed_linked_run(
    session: Session, *, run_id: str, trace_id: str, batch_id: str
) -> None:
    session.add(
        AgentTaskBatchRunDB(
            id=batch_id,
            project=_PROJECT,
            selection_type="task",
            status="completed",
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
    )
    session.add(
        AgentTaskRunDB(
            id=run_id,
            batch_run_id=batch_id,
            task_id=_TASK_ID,
            task_path=f"/tmp/tasks/{_TASK_ID}",
            status="passed",
            trace_run_id=trace_id,
        )
    )
    session.add(
        RunDB(
            id=trace_id,
            project=_PROJECT,
            environment="default",
            task_run_id=run_id,
            call_count=0,
        )
    )
    session.commit()


def test_late_span_refreshes_stored_summary(session: Session) -> None:
    """A span projected after the first rollup lands its provider in the
    stored summary through the _refresh_task_run_total path."""
    _seed_linked_run(session, run_id="run-late", trace_id="trace-late", batch_id="batch-late")
    projector = TraceProjector()
    projector.project(
        _span("root-late", _ROOT_ATTRS, trace_id="trace-late", parent=None), session
    )
    projector.project(
        _span(
            "call-late-1",
            _gen_attrs(provider="openrouter", host="baseten"),
            trace_id="trace-late",
            parent="root-late",
        ),
        session,
    )
    session.commit()

    task_run = session.get(AgentTaskRunDB, "run-late")
    assert task_run is not None
    first = stored_serving_summary(task_run)
    assert first is not None
    assert {group.identity.api_provider for group in first.groups} == {"openrouter"}

    projector.project(
        _span(
            "call-late-2",
            _gen_attrs(provider="fireworks", host="fireworks"),
            trace_id="trace-late",
            parent="root-late",
        ),
        session,
    )
    session.commit()

    session.refresh(task_run)
    refreshed = stored_serving_summary(task_run)
    assert refreshed is not None
    assert {group.identity.api_provider for group in refreshed.groups} == {
        "openrouter",
        "fireworks",
    }


# ---------------------------------------------------------------------------
# Unit: migration backfill
# ---------------------------------------------------------------------------


@pytest.fixture(name="migration_engine")
def migration_engine_fixture() -> Iterator[Engine]:
    test_engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(test_engine)
    yield test_engine
    test_engine.dispose()


def test_backfill_fills_and_matches(
    migration_engine: Engine, monkeypatch: MonkeyPatch
) -> None:
    """v72 backfills serving_summary_json for every traced run; each stored
    summary equals a fresh compute. Runs without a trace stay null."""
    assert apo_db._SCHEMA_MIGRATIONS[72] is apo_db._migrate_to_v72

    calls_by_trace = {
        "trace-bf-1": [
            _rollup_call("call-bf-1a", run_id="trace-bf-1"),
            _rollup_call(
                "call-bf-1b",
                run_id="trace-bf-1",
                api_provider="fireworks",
                serving_host="fireworks",
            ),
        ],
        "trace-bf-2": [_rollup_call("call-bf-2a", run_id="trace-bf-2")],
    }
    with Session(migration_engine) as session:
        session.add(
            AgentTaskBatchRunDB(
                id="batch-bf",
                project=_PROJECT,
                selection_type="task",
                status="completed",
                created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )
        )
        for run_id, trace_id in (
            ("run-bf-1", "trace-bf-1"),
            ("run-bf-2", "trace-bf-2"),
            ("run-bf-untraced", None),
        ):
            session.add(
                AgentTaskRunDB(
                    id=run_id,
                    batch_run_id="batch-bf",
                    task_id=_TASK_ID,
                    task_path=f"/tmp/tasks/{_TASK_ID}",
                    status="passed",
                    trace_run_id=trace_id,
                )
            )
        for calls in calls_by_trace.values():
            session.add_all(calls)
        session.commit()

    # Production arrives at v72 with tables that lack the column (it is
    # ALTER-added by the migration); an ORM-seeded row would otherwise hold
    # the JSON text 'null' instead of SQL NULL and dodge the backfill.
    with migration_engine.begin() as conn:
        apo_db._drop_column_if_exists(conn, "agent_task_runs", "serving_summary_json")

    monkeypatch.setattr(apo_db, "engine", migration_engine)
    apo_db._migrate_to_v72()
    apo_db._migrate_to_v72()  # idempotent

    with Session(migration_engine) as session:
        for run_id, trace_id in (
            ("run-bf-1", "trace-bf-1"),
            ("run-bf-2", "trace-bf-2"),
        ):
            task_run = session.get(AgentTaskRunDB, run_id)
            assert task_run is not None
            stored = stored_serving_summary(task_run)
            calls = session.exec(
                select(LoggedCallDB).where(LoggedCallDB.run_id == trace_id)
            ).all()
            fresh = summarize_calls([to_serving_call(call) for call in calls])
            assert stored is not None
            assert stored == fresh
        untraced = session.get(AgentTaskRunDB, "run-bf-untraced")
        assert untraced is not None
        assert untraced.serving_summary_json is None


# ---------------------------------------------------------------------------
# Scene: list and detail routes serve the stored summary
# ---------------------------------------------------------------------------


def _ingest_two_provider_trace(session: Session) -> str:
    """Seed a linked run and ingest root + two request calls through the
    projector (the normal ingest path); returns the task run id."""
    _seed_linked_run(session, run_id="run-http", trace_id="trace-http", batch_id="batch-http")
    projector = TraceProjector()
    projector.project(
        _span("root-http", _ROOT_ATTRS, trace_id="trace-http", parent=None), session
    )
    projector.project(
        _span(
            "call-http-or",
            _gen_attrs(provider="openrouter", host="baseten"),
            trace_id="trace-http",
            parent="root-http",
        ),
        session,
    )
    projector.project(
        _span(
            "call-http-fw",
            _gen_attrs(provider="fireworks", host="fireworks"),
            trace_id="trace-http",
            parent="root-http",
        ),
        session,
    )
    session.commit()
    return "run-http"


def _delete_call(session: Session, span_id: str) -> None:
    session.exec(
        delete(LoggedCallDB).where(
            col(LoggedCallDB.id) == span_id, col(LoggedCallDB.project) == _PROJECT
        )
    )
    session.commit()


def _list_serving(client: TestClient) -> Any:
    response = client.get(
        "/v1/agent-task-runs",
        params={"task_id": _TASK_ID, "project": _PROJECT},
    )
    assert response.status_code == 200
    payload = response.json()
    assert [run["id"] for run in payload] == ["run-http"]
    return payload[0]["serving"]


def _detail_serving(client: TestClient) -> Any:
    response = client.get("/v1/agent-task-runs/run-http")
    assert response.status_code == 200
    return response.json()["serving"]


def test_list_route_serves_stored_summary(client: TestClient, session: Session) -> None:
    """After a direct row deletion the list still serves the stored rollup;
    re-projecting the span restores the row and refreshes the store."""
    _ingest_two_provider_trace(session)

    serving = _list_serving(client)
    assert serving is not None
    assert serving["calls"] == 2

    _delete_call(session, "call-http-fw")
    # A recompute from the remaining rows would say 1; the stored rollup
    # still describes the full call set.
    serving = _list_serving(client)
    assert serving["calls"] == 2

    projector = TraceProjector()
    projector.project(
        _span(
            "call-http-fw",
            _gen_attrs(provider="fireworks", host="fireworks"),
            trace_id="trace-http",
            parent="root-http",
        ),
        session,
    )
    projector.project(
        _span(
            "call-http-cb",
            _gen_attrs(provider="cerebras", host="cerebras"),
            trace_id="trace-http",
            parent="root-http",
        ),
        session,
    )
    session.commit()

    serving = _list_serving(client)
    assert serving["calls"] == 3
    assert {group["identity"]["api_provider"] for group in serving["groups"]} == {
        "openrouter",
        "fireworks",
        "cerebras",
    }


def test_detail_route_serves_stored_summary(client: TestClient, session: Session) -> None:
    """The single-run detail serves the same stored rollup as the list."""
    _ingest_two_provider_trace(session)

    serving = _detail_serving(client)
    assert serving is not None
    assert serving["calls"] == 2

    _delete_call(session, "call-http-or")
    serving = _detail_serving(client)
    assert serving["calls"] == 2


def test_list_route_falls_back_when_summary_null(
    client: TestClient, session: Session
) -> None:
    """A null column (never backfilled, trace never linked) computes from
    call rows exactly as before."""
    from sqlmodel import update

    _ingest_two_provider_trace(session)
    session.exec(
        update(AgentTaskRunDB)
        .where(col(AgentTaskRunDB.id) == "run-http")
        .values(serving_summary_json=None)
    )
    session.commit()

    serving = _list_serving(client)
    assert serving is not None
    assert serving["calls"] == 2


def test_corrupt_stored_summary_does_not_500(
    client: TestClient, session: Session
) -> None:
    """Corrupt stored JSON falls back to the compute path instead of
    failing the request."""
    from sqlmodel import update

    _ingest_two_provider_trace(session)
    session.exec(
        update(AgentTaskRunDB)
        .where(col(AgentTaskRunDB.id) == "run-http")
        .values(serving_summary_json={"state": "not-a-real-state"})
    )
    session.commit()

    serving = _list_serving(client)
    assert serving is not None
    assert serving["calls"] == 2
    detail = _detail_serving(client)
    assert detail is not None
    assert detail["calls"] == 2


def test_batch_detail_per_run_summaries_read_stored(
    client: TestClient, session: Session
) -> None:
    """Batch detail builds each child's serving from the stored rollup; the
    batch-level aggregate keeps computing from call rows."""
    _ingest_two_provider_trace(session)

    response = client.get("/v1/agent-task-batch-runs/batch-http")
    assert response.status_code == 200
    body = response.json()
    child = next(run for run in body["task_runs"] if run["id"] == "run-http")
    assert child["serving"] is not None
    assert child["serving"]["calls"] == 2

    _delete_call(session, "call-http-fw")
    response = client.get("/v1/agent-task-batch-runs/batch-http")
    assert response.status_code == 200
    body = response.json()
    child = next(run for run in body["task_runs"] if run["id"] == "run-http")
    assert child["serving"]["calls"] == 2
    # The batch aggregate describes ALL children from live call rows, so it
    # sees the deletion.
    assert body["serving"]["calls"] == 1
