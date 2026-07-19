# pyright: reportAny=false, reportUnusedImport=false

import asyncio
from dataclasses import dataclass
import pytest
from datetime import datetime, timezone
from uuid import uuid4

from sqlmodel import Session

from apo.models.db import RunDB, LoggedCallDB, RunMetricDB
from apo.routes.analytics import (
    MetricsQuery,
    ObservationFilter,
    TraceFilter,
    get_model_metrics,
    get_project_summary,
    query_metrics,
    search_observations,
    search_traces,
)


@dataclass
class _DirectResponse:
    status_code: int
    payload: object

    def json(self) -> object:
        return self.payload


class _AnalyticsClient:
    def __init__(self, session: Session):
        self._session = session

    def post(self, url: str, *, json: dict[str, object]) -> _DirectResponse:
        if url == "/api/v1/traces/search":
            payload = asyncio.run(
                search_traces(TraceFilter.model_validate(json), self._session)
            )
            return _DirectResponse(200, payload.model_dump(mode="json"))

        if url == "/api/v1/observations/search":
            payload = asyncio.run(
                search_observations(
                    ObservationFilter.model_validate(json),
                    self._session,
                )
            )
            return _DirectResponse(200, payload.model_dump(mode="json"))

        if url == "/api/v1/metrics/query":
            payload = asyncio.run(
                query_metrics(MetricsQuery.model_validate(json), self._session)
            )
            return _DirectResponse(
                200,
                [item.model_dump(mode="json") for item in payload],
            )

        raise AssertionError(f"Unhandled POST url: {url}")

    def get(
        self,
        url: str,
        *,
        params: dict[str, object],
    ) -> _DirectResponse:
        project = str(params["project"])
        if url == "/api/v1/metrics/models":
            payload = asyncio.run(
                get_model_metrics(project=project, environment=None, session=self._session)
            )
            return _DirectResponse(
                200,
                [item.model_dump(mode="json") for item in payload],
            )

        if url == "/api/v1/metrics/summary":
            payload = asyncio.run(
                get_project_summary(
                    project=project,
                    environment=None,
                    session=self._session,
                )
            )
            return _DirectResponse(200, payload.model_dump(mode="json"))

        raise AssertionError(f"Unhandled GET url: {url}")


@pytest.fixture(name="client")
def analytics_client(session: Session):
    return _AnalyticsClient(session)


def _create_run(
    session: Session,
    project: str = "test-project",
    flow_name: str | None = "test-flow",
    environment: str = "default",
    tags: list[str] | None = None,
    user_id: str | None = None,
    session_id: str | None = None,
    duration_ms: float | None = None,
) -> RunDB:
    run = RunDB(
        id=str(uuid4()),
        project=project,
        flow_name=flow_name,
        environment=environment,
        tags=tags or [],
        user_id=user_id,
        session_id=session_id,
        duration_ms=duration_ms,
        created_at=datetime.now(timezone.utc),
    )
    session.add(run)
    session.commit()
    session.refresh(run)
    return run


def _create_call(
    session: Session,
    run_id: str,
    project: str = "test-project",
    model: str = "gpt-4o",
    latency_ms: float | None = 100.0,
    cost: float | None = 0.01,
    observation_type: str = "GENERATION",
    level: str = "DEFAULT",
    environment: str = "default",
    tags: list[str] | None = None,
) -> LoggedCallDB:
    call = LoggedCallDB(
        id=str(uuid4()),
        project=project,
        task_id="test-task",
        run_id=run_id,
        model=model,
        latency_ms=latency_ms,
        cost=cost,
        observation_type=observation_type,
        level=level,
        environment=environment,
        tags=tags or [],
        created_at=datetime.now(timezone.utc),
        input={},
        messages=[],
        output={},
    )
    session.add(call)
    session.commit()
    session.refresh(call)
    return call


def _create_run_metric(
    session: Session,
    run_id: str,
    metric_name: str = "quality",
    score: float = 0.85,
) -> RunMetricDB:
    metric = RunMetricDB(
        run_id=run_id,
        metric_name=metric_name,
        metric_type="quality",
        score=score,
        data_type="NUMERIC",
        source="API",
        created_at=datetime.now(timezone.utc),
    )
    session.add(metric)
    session.commit()
    session.refresh(metric)
    return metric


def test_search_traces_by_project(client, session):
    _create_run(session, project="proj-a")
    _create_run(session, project="proj-b")

    response = client.post("/api/v1/traces/search", json={"project": "proj-a"})
    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 1
    assert data["data"][0]["project"] == "proj-a"


def test_search_traces_by_date_range(client, session):
    from datetime import timedelta

    past_ts = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    _create_run(session)
    _create_run(session)

    response = client.post("/api/v1/traces/search", json={
        "project": "test-project",
        "from_timestamp": past_ts,
    })
    assert response.status_code == 200
    assert response.json()["total_count"] == 2


def test_search_traces_by_tags_any(client, session):
    _create_run(session, tags=["production", "v2"])
    _create_run(session, tags=["staging"])
    _create_run(session, tags=["development"])

    response = client.post("/api/v1/traces/search", json={
        "project": "test-project",
        "tags_any": ["production", "staging"],
    })
    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 2


def test_search_traces_by_has_errors(client, session):
    run_ok = _create_run(session)
    _create_call(session, run_ok.id, level="DEFAULT")

    run_err = _create_run(session)
    _create_call(session, run_err.id, level="ERROR")

    response = client.post("/api/v1/traces/search", json={
        "project": "test-project",
        "has_errors": True,
    })
    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 1
    assert data["data"][0]["id"] == run_err.id


def test_search_traces_by_flow_name(client, session):
    _create_run(session, flow_name="flow-a")
    _create_run(session, flow_name="flow-b")

    response = client.post("/api/v1/traces/search", json={
        "project": "test-project",
        "flow_name": "flow-a",
    })
    assert response.status_code == 200
    assert response.json()["total_count"] == 1


def test_search_traces_by_min_score(client, session):
    run_high = _create_run(session)
    _create_run_metric(session, run_high.id, "quality", 0.9)

    run_low = _create_run(session)
    _create_run_metric(session, run_low.id, "quality", 0.3)

    response = client.post("/api/v1/traces/search", json={
        "project": "test-project",
        "min_score": 0.8,
        "score_name": "quality",
    })
    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 1
    assert data["data"][0]["id"] == run_high.id


def test_search_traces_empty_result(client, session):
    response = client.post("/api/v1/traces/search", json={
        "project": "nonexistent",
    })
    assert response.status_code == 200
    assert response.json()["total_count"] == 0
    assert response.json()["data"] == []


def test_search_observations_by_project(client, session):
    run = _create_run(session)
    _create_call(session, run.id, project="test-project")
    _create_call(session, run.id, project="other-project")

    response = client.post("/api/v1/observations/search", json={
        "project": "test-project",
    })
    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 1


def test_search_observations_by_observation_type(client, session):
    run = _create_run(session)
    _create_call(session, run.id, observation_type="GENERATION")
    _create_call(session, run.id, observation_type="TOOL")

    response = client.post("/api/v1/observations/search", json={
        "project": "test-project",
        "observation_type": "GENERATION",
    })
    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 1
    assert data["data"][0]["observation_type"] == "GENERATION"


def test_search_observations_by_has_errors(client, session):
    run = _create_run(session)
    _create_call(session, run.id, level="DEFAULT")
    _create_call(session, run.id, level="ERROR")

    response = client.post("/api/v1/observations/search", json={
        "project": "test-project",
        "has_errors": True,
    })
    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 1


def test_search_observations_by_model(client, session):
    run = _create_run(session)
    _create_call(session, run.id, model="gpt-4o")
    _create_call(session, run.id, model="gpt-3.5-turbo")

    response = client.post("/api/v1/observations/search", json={
        "project": "test-project",
        "model": "gpt-4o",
    })
    assert response.status_code == 200
    assert response.json()["total_count"] == 1


def test_metrics_query_avg_latency(client, session):
    run = _create_run(session)
    _create_call(session, run.id, latency_ms=100.0)
    _create_call(session, run.id, latency_ms=200.0)

    response = client.post("/api/v1/metrics/query", json={
        "project": "test-project",
        "measure": "latency_ms",
        "aggregation": "avg",
    })
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["value"] == 150.0


def test_metrics_query_p95_latency(client, session):
    run = _create_run(session)
    for latency in [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]:
        _create_call(session, run.id, latency_ms=float(latency))

    response = client.post("/api/v1/metrics/query", json={
        "project": "test-project",
        "measure": "latency_ms",
        "aggregation": "p95",
    })
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["value"] is not None
    assert data[0]["value"] >= 90.0


def test_metrics_query_with_dimension(client, session):
    run = _create_run(session)
    _create_call(session, run.id, model="gpt-4o", latency_ms=100.0)
    _create_call(session, run.id, model="gpt-4o", latency_ms=200.0)
    _create_call(session, run.id, model="gpt-3.5-turbo", latency_ms=50.0)

    response = client.post("/api/v1/metrics/query", json={
        "project": "test-project",
        "measure": "latency_ms",
        "aggregation": "avg",
        "dimension": "model",
    })
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2

    gpt35 = next(r for r in data if r["dimension_value"] == "gpt-3.5-turbo")
    gpt4 = next(r for r in data if r["dimension_value"] == "gpt-4o")
    assert gpt35["value"] == 50.0
    assert gpt4["value"] == 150.0


def test_metrics_query_empty_returns_null(client, session):
    response = client.post("/api/v1/metrics/query", json={
        "project": "nonexistent",
        "measure": "latency_ms",
        "aggregation": "avg",
    })
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["value"] is None


def test_metrics_query_sum_cost(client, session):
    run = _create_run(session)
    _create_call(session, run.id, cost=0.01)
    _create_call(session, run.id, cost=0.02)

    response = client.post("/api/v1/metrics/query", json={
        "project": "test-project",
        "measure": "cost",
        "aggregation": "sum",
    })
    assert response.status_code == 200
    data = response.json()
    assert data[0]["value"] == pytest.approx(0.03)


def test_metrics_query_count(client, session):
    run = _create_run(session)
    _create_call(session, run.id, cost=0.01)
    _create_call(session, run.id, cost=0.02)
    _create_call(session, run.id, cost=None)

    response = client.post("/api/v1/metrics/query", json={
        "project": "test-project",
        "measure": "cost",
        "aggregation": "count",
    })
    assert response.status_code == 200
    assert response.json()[0]["value"] == 2.0


def test_metrics_query_total_tokens_by_day(client, session):
    run = _create_run(session)
    call = _create_call(session, run.id)
    call.total_tokens = 100
    session.add(call)
    session.commit()

    response = client.post("/api/v1/metrics/query", json={
        "project": "test-project",
        "measure": "total_tokens",
        "aggregation": "sum",
        "dimension": "date",
    })
    assert response.status_code == 200
    data = response.json()
    assert len(data) >= 1
    assert data[0]["value"] == 100.0


def test_get_model_metrics(client, session):
    run = _create_run(session)
    call1 = _create_call(session, run.id, model="gpt-4o", latency_ms=100.0, cost=0.05)
    call1.total_tokens = 1000
    session.add(call1)
    call2 = _create_call(session, run.id, model="gpt-3.5-turbo", latency_ms=50.0, cost=0.01)
    call2.total_tokens = 500
    session.add(call2)
    session.commit()

    response = client.get("/api/v1/metrics/models", params={"project": "test-project"})
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2

    gpt4 = next(m for m in data if m["model"] == "gpt-4o")
    assert gpt4["count"] == 1
    assert gpt4["avg_latency_ms"] == 100.0
    assert gpt4["total_cost"] == 0.05
    assert gpt4["total_tokens"] == 1000

    gpt35 = next(m for m in data if m["model"] == "gpt-3.5-turbo")
    assert gpt35["avg_latency_ms"] == 50.0


def test_get_project_summary(client, session):
    run = _create_run(session)
    call = _create_call(session, run.id, latency_ms=100.0, cost=0.05)
    call.total_tokens = 1000
    session.add(call)
    session.commit()

    response = client.get("/api/v1/metrics/summary", params={"project": "test-project"})
    assert response.status_code == 200
    data = response.json()
    assert data["total_runs"] == 1
    assert data["total_observations"] == 1
    assert data["total_cost"] == 0.05
    assert data["avg_latency_ms"] == 100.0
    assert data["total_tokens"] == 1000


def test_get_project_summary_empty(client, session):
    response = client.get("/api/v1/metrics/summary", params={"project": "nonexistent"})
    assert response.status_code == 200
    data = response.json()
    assert data["total_runs"] == 0
    assert data["total_observations"] == 0
    assert data["total_cost"] is None
    assert data["avg_latency_ms"] is None


def test_search_traces_pagination(client, session):
    for _ in range(5):
        _create_run(session)

    response = client.post("/api/v1/traces/search", json={
        "project": "test-project",
        "limit": 2,
        "offset": 0,
    })
    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 5
    assert len(data["data"]) == 2
    assert data["limit"] == 2
    assert data["offset"] == 0


def test_search_observations_pagination(client, session):
    run = _create_run(session)
    for _ in range(5):
        _create_call(session, run.id)

    response = client.post("/api/v1/observations/search", json={
        "project": "test-project",
        "limit": 2,
        "offset": 0,
    })
    assert response.status_code == 200
    data = response.json()
    assert data["total_count"] == 5
    assert len(data["data"]) == 2


from sqlmodel import select
