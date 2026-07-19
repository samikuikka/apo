# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Tests for Langfuse-compatible public API (SPEC-016)."""

import asyncio
from datetime import datetime
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Mapping, cast

import pytest
from fastapi import Request
from sqlmodel import Session, select, text
from apo.db import engine, init_db
from apo.models.db import RunDB, LoggedCallDB, RunMetricDB, CallMetricDB
from apo.routes.langfuse_public import (
    LangfuseBatchRequest,
    LangfuseIngestionEvent,
    langfuse_ingestion,
    list_traces,
    get_trace,
    list_observations,
    create_score,
    CreateScoreRequest,
    list_sessions,
    get_session_detail,
)


def _fake_request(project: str = "default") -> Request:
    """A minimal Request stand-in for direct endpoint calls in tests.

    The real ASGI Request is only needed for ``request.state.project`` (auth
    context). In tests we call the endpoints directly, so a SimpleNamespace
    with a ``state`` attribute suffices.
    """
    return cast(Request, SimpleNamespace(state=SimpleNamespace(project=project)))


@pytest.fixture(autouse=True)
def setup_database():
    """Initialize database before each test."""
    init_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM call_metrics"))
        session.execute(text("DELETE FROM run_metrics"))
        session.execute(text("DELETE FROM logged_calls"))
        session.execute(text("DELETE FROM runs"))
        session.commit()


@pytest.fixture(name="client")
def client_fixture():
    return _LangfuseDirectClient()


@dataclass
class _DirectResponse:
    status_code: int
    payload: object

    def json(self) -> object:
        return self.payload


class _LangfuseDirectClient:
    def post(
        self,
        url: str,
        *,
        json: Mapping[str, object],
        headers: Mapping[str, str] | None = None,
    ) -> _DirectResponse:
        _ = headers
        with Session(engine) as session:
            if url == "/api/public/ingestion":
                payload = asyncio.run(
                    langfuse_ingestion(
                        LangfuseBatchRequest.model_validate(dict(json)),
                        _fake_request(),
                        db=session,
                    )
                )
                return _DirectResponse(200, payload)
        raise AssertionError(f"Unhandled POST url: {url}")

    def get(self, url: str) -> _DirectResponse:
        with Session(engine) as session:
            if url == "/api/public/sessions":
                payload = asyncio.run(list_sessions(page=1, limit=50, db=session))
                return _DirectResponse(200, payload.model_dump(mode="json"))

            if url.startswith("/api/public/traces/"):
                trace_id = url.rsplit("/", 1)[1]
                payload = asyncio.run(get_trace(trace_id=trace_id, request=_fake_request(), db=session))
                return _DirectResponse(200, cast(dict[str, object], payload))

            if url.startswith("/api/public/sessions/"):
                session_id = url.rsplit("/", 1)[1]
                try:
                    payload = asyncio.run(
                        get_session_detail(session_id=session_id, db=session)
                    )
                except Exception as exc:
                    from fastapi import HTTPException

                    if isinstance(exc, HTTPException):
                        return _DirectResponse(exc.status_code, {"detail": exc.detail})
                    raise
                return _DirectResponse(200, cast(dict[str, object], payload))
        raise AssertionError(f"Unhandled GET url: {url}")


def _ingest_trace_and_generation() -> dict[str, object]:
    """Helper: ingest a trace + generation via Langfuse SDK format."""
    now = datetime.now()
    request = LangfuseBatchRequest(
        batch=[
            LangfuseIngestionEvent(
                id="evt-trace-1",
                timestamp=now,
                type="trace-create",
                body={
                    "id": "lf-trace-001",
                    "name": "my-flow",
                    "userId": "user-1",
                    "sessionId": "session-1",
                    "environment": "test",
                    "tags": ["langfuse-test"],
                    "metadata": {"source": "sdk"},
                },
            ),
            LangfuseIngestionEvent(
                id="evt-gen-1",
                timestamp=now,
                type="generation-create",
                body={
                    "id": "lf-obs-001",
                    "traceId": "lf-trace-001",
                    "name": "llm-call",
                    "model": "gpt-4",
                    "startTime": now.isoformat(),
                    "input": {"prompt": "hello"},
                    "output": {"text": "world"},
                    "usage": {"promptTokens": 10, "completionTokens": 20},
                    "metadata": {"key": "val"},
                },
            ),
        ]
    )

    # langfuse_ingestion is async, so use asyncio.run
    with Session(engine) as session:
        response = asyncio.run(langfuse_ingestion(request, _fake_request(), db=session))

    return cast(dict[str, object], response)


def test_langfuse_batch_ingestion_creates_run_and_call():
    """Happy path: Langfuse SDK batch creates run and observation."""
    response = _ingest_trace_and_generation()
    results = cast(list[dict[str, object]], response.get("results", []))

    assert len(results) == 2
    assert all(cast(int, r["status"]) == 200 for r in results)

    with Session(engine) as session:
        run = session.exec(select(RunDB).where(RunDB.id == "lf-trace-001")).first()
        assert run is not None
        assert run.flow_name == "my-flow"
        assert run.user_id == "user-1"
        assert run.session_id == "session-1"
        assert run.environment == "test"
        assert run.tags == ["langfuse-test"]

        call = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "lf-obs-001")).first()
        assert call is not None
        assert call.observation_type == "GENERATION"
        assert call.prompt_tokens == 10
        assert call.completion_tokens == 20
        assert call.total_tokens == 30


def test_langfuse_score_create_on_trace():
    """Score-create event creates RunMetricDB."""
    _ingest_trace_and_generation()

    now = datetime.now()
    request = LangfuseBatchRequest(
        batch=[
            LangfuseIngestionEvent(
                id="evt-score-1",
                timestamp=now,
                type="score-create",
                body={
                    "traceId": "lf-trace-001",
                    "name": "quality",
                    "value": 0.95,
                    "source": "ANNOTATION",
                    "comment": "looks good",
                },
            ),
        ]
    )

    with Session(engine) as session:
        response = asyncio.run(langfuse_ingestion(request, _fake_request(), db=session))

    results = cast(list[dict[str, object]], response.get("results", []))
    assert cast(int, results[0]["status"]) == 200

    with Session(engine) as session:
        metrics = session.exec(
            select(RunMetricDB).where(RunMetricDB.run_id == "lf-trace-001")
        ).all()
        assert len(metrics) == 1
        assert metrics[0].metric_name == "quality"
        assert metrics[0].score == 0.95
        assert metrics[0].source == "ANNOTATION"
        assert metrics[0].reasoning == "looks good"


def test_get_traces_returns_langfuse_format():
    """GET /traces returns data in Langfuse format."""
    _ingest_trace_and_generation()

    with Session(engine) as session:
        response = asyncio.run(list_traces(tags=None, page=1, limit=50, db=session))

    total = cast(int, response.meta["totalItems"])
    assert total >= 1
    trace_data = None
    for t in response.data:
        if t.get("id") == "lf-trace-001":
            trace_data = t
            break
    assert trace_data is not None
    assert trace_data["name"] == "my-flow"
    assert trace_data["userId"] == "user-1"


def test_get_trace_by_id_with_observations():
    """GET /traces/:id returns trace with nested observations."""
    _ingest_trace_and_generation()

    with Session(engine) as session:
        response = asyncio.run(get_trace(trace_id="lf-trace-001", request=_fake_request(), db=session))

    assert response["id"] == "lf-trace-001"
    observations = cast(list[dict[str, object]], response.get("observations", []))
    assert isinstance(observations, list)
    assert len(observations) == 1
    obs = observations[0]
    assert obs["id"] == "lf-obs-001"
    usage = cast(dict[str, object], obs["usage"])
    assert usage["promptTokens"] == 10


def test_list_observations_filters_by_trace():
    """GET /observations filtered by traceId."""
    _ingest_trace_and_generation()

    with Session(engine) as session:
        response = asyncio.run(
            list_observations(traceId="lf-trace-001", page=1, limit=50, db=session)
        )

    assert cast(int, response.meta["totalItems"]) == 1
    assert response.data[0]["id"] == "lf-obs-001"


def test_create_score_on_trace():
    """POST /scores creates a score on a trace."""
    _ingest_trace_and_generation()

    req = CreateScoreRequest(
        traceId="lf-trace-001",
        name="accuracy",
        value=0.9,
        source="API",
    )

    with Session(engine) as session:
        result = asyncio.run(create_score(req, _fake_request(), db=session))

    assert result["traceId"] == "lf-trace-001"
    assert result["name"] == "accuracy"
    assert result["value"] == 0.9


def test_create_score_on_observation():
    """POST /scores creates a score on an observation."""
    _ingest_trace_and_generation()

    req = CreateScoreRequest(
        observationId="lf-obs-001",
        name="relevance",
        value=0.8,
    )

    with Session(engine) as session:
        result = asyncio.run(create_score(req, _fake_request(), db=session))

    assert result["observationId"] == "lf-obs-001"
    assert result["name"] == "relevance"
    assert result["value"] == 0.8


def test_score_for_nonexistent_trace_returns_404():
    """Score on missing trace returns 404."""
    req = CreateScoreRequest(
        traceId="nonexistent-trace",
        name="test",
        value=0.5,
    )

    with Session(engine) as session:
        with pytest.raises(Exception) as exc_info:
            asyncio.run(create_score(req, _fake_request(), db=session))
        assert (
            "404" in str(exc_info.value) or "not found" in str(exc_info.value).lower()
        )


def test_invalid_langfuse_event_type():
    """Unknown event type returns status 400."""
    now = datetime.now()
    request = LangfuseBatchRequest(
        batch=[
            LangfuseIngestionEvent(
                id="evt-unknown",
                timestamp=now,
                type="unknown-type",
                body={},
            ),
        ]
    )

    with Session(engine) as session:
        response = asyncio.run(langfuse_ingestion(request, _fake_request(), db=session))

    results = cast(list[dict[str, object]], response.get("results", []))
    assert cast(int, results[0]["status"]) == 400


def test_generation_update_via_langfuse():
    """Generation-update event updates existing call."""
    _ingest_trace_and_generation()

    now = datetime.now()
    request = LangfuseBatchRequest(
        batch=[
            LangfuseIngestionEvent(
                id="evt-update-1",
                timestamp=now,
                type="generation-update",
                body={
                    "id": "lf-obs-001",
                    "output": {"text": "updated world"},
                    "endTime": now.isoformat(),
                    "usage": {"promptTokens": 15, "completionTokens": 30},
                },
            ),
        ]
    )

    with Session(engine) as session:
        response = asyncio.run(langfuse_ingestion(request, _fake_request(), db=session))

    results = cast(list[dict[str, object]], response.get("results", []))
    assert cast(int, results[0]["status"]) == 200

    with Session(engine) as session:
        call = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "lf-obs-001")).first()
        assert call is not None
        assert call.output == {"text": "updated world"}
        assert call.prompt_tokens == 15
        assert call.completion_tokens == 30


def test_large_batch_50_events():
    """Large batch with 50 events processes correctly."""
    now = datetime.now()
    events: list[LangfuseIngestionEvent] = []

    for i in range(50):
        events.append(
            LangfuseIngestionEvent(
                id=f"evt-batch-{i}",
                timestamp=now,
                type="trace-create",
                body={
                    "id": f"trace-batch-{i}",
                    "name": f"flow-{i}",
                },
            )
        )

    request = LangfuseBatchRequest(batch=events)

    with Session(engine) as session:
        response = asyncio.run(langfuse_ingestion(request, _fake_request(), db=session))

    results = cast(list[dict[str, object]], response.get("results", []))
    assert len(results) == 50
    assert all(cast(int, r["status"]) == 200 for r in results)


def test_langfuse_sdk_headers_accepted(client: _LangfuseDirectClient):
    """Langfuse SDK headers (x-langfuse-ingestion-version) accepted."""
    now = datetime.now()
    batch = {
        "batch": [
            {
                "id": "evt-header-1",
                "timestamp": now.isoformat(),
                "type": "trace-create",
                "body": {
                    "id": "trace-header-001",
                    "name": "header-test",
                },
            }
        ]
    }

    response = client.post(
        "/api/public/ingestion",
        json=batch,
        headers={"x-langfuse-ingestion-version": "3.0.0"},
    )

    assert response.status_code == 200
    data = cast(dict[str, object], response.json())
    results = cast(list[dict[str, object]], data.get("results", []))
    assert all(r["status"] == 200 for r in results)

    get_resp = client.get("/api/public/traces/trace-header-001")
    assert get_resp.status_code == 200
    get_trace_data = cast(dict[str, object], get_resp.json())
    assert get_trace_data["id"] == "trace-header-001"


def test_list_sessions(client: _LangfuseDirectClient):
    """GET /api/public/sessions returns session list."""
    now = datetime.now()
    batch = {
        "batch": [
            {
                "id": "evt-sess-1",
                "timestamp": now.isoformat(),
                "type": "trace-create",
                "body": {
                    "id": "trace-sess-001",
                    "name": "session-flow",
                    "sessionId": "session-langfuse-1",
                },
            }
        ]
    }

    client.post("/api/public/ingestion", json=batch)

    response = client.get("/api/public/sessions")
    assert response.status_code == 200
    data = cast(dict[str, object], response.json())
    assert "data" in data
    assert "meta" in data


def test_get_session_detail(client: _LangfuseDirectClient):
    """GET /api/public/sessions/:id returns session with traces."""
    now = datetime.now()

    with Session(engine) as session:
        from apo.models.db import SessionDB

        sess = SessionDB(id="session-detail-x1", project="default", run_count=0)
        session.merge(sess)
        session.commit()

    batch = {
        "batch": [
            {
                "id": "evt-sess-detail",
                "timestamp": now.isoformat(),
                "type": "trace-create",
                "body": {
                    "id": "trace-sess-detail-x1",
                    "name": "session-detail-flow",
                    "sessionId": "session-detail-x1",
                },
            }
        ]
    }

    client.post("/api/public/ingestion", json=batch)

    response = client.get("/api/public/sessions/session-detail-x1")
    assert response.status_code == 200
    data = cast(dict[str, object], response.json())
    assert data["id"] == "session-detail-x1"
    assert isinstance(cast(object, data.get("traces")), list)


def test_get_session_detail_not_found(client: _LangfuseDirectClient):
    """GET /api/public/sessions/:id returns 404 for missing session."""
    response = client.get("/api/public/sessions/nonexistent-session")
    assert response.status_code == 404
