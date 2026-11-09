"""Range filters over stored run metrics on the batch list.

``cost_min``/``cost_max`` bound the batch's child-run cost sum (the rollup
the page shows), ``duration_min``/``duration_max`` bound its wall-clock
seconds. A batch without both timestamps has no duration and never matches
a duration filter.
"""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB, ProjectDB

PROJECT = "metrics-proj"
NOW = datetime.now(timezone.utc)


def _batch(
    batch_id: str,
    *,
    started_minutes_ago: float | None = None,
    duration_seconds: float | None = None,
) -> AgentTaskBatchRunDB:
    started = (
        NOW - timedelta(minutes=started_minutes_ago) if started_minutes_ago is not None else None
    )
    completed = (
        started + timedelta(seconds=duration_seconds)
        if started is not None and duration_seconds is not None
        else None
    )
    return AgentTaskBatchRunDB(
        id=batch_id,
        project=PROJECT,
        selection_type="caller-task",
        environment="default",
        run_metadata={"trigger": {"source": "api"}},
        status="completed" if completed is not None else "running",
        total_tasks=1,
        started_at=started,
        completed_at=completed,
        created_at=NOW - timedelta(minutes=30),
    )


def _run(run_id: str, batch_id: str, cost: float) -> AgentTaskRunDB:
    return AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch_id,
        task_id="team/task",
        task_path="team/task",
        status="passed",
        pass_result=True,
        total_cost=cost,
        started_at=NOW - timedelta(minutes=29),
        completed_at=NOW - timedelta(minutes=28),
    )


def seeded(session: Session) -> None:
    session.add(ProjectDB(id=PROJECT, name=PROJECT, created_at=NOW))
    session.add_all(
        [
            # 30s wall clock, $0.02
            _batch("b-cheap", started_minutes_ago=10, duration_seconds=30),
            # 3min wall clock, $0.30
            _batch("b-mid", started_minutes_ago=8, duration_seconds=180),
            # 10min wall clock, $0.40 + $0.45 = $0.85
            _batch("b-pricey", started_minutes_ago=6, duration_seconds=600),
            # started, never completed: no duration, $0.10
            _batch("b-unfinished", started_minutes_ago=4),
        ]
    )
    session.add_all(
        [
            _run("r-cheap", "b-cheap", 0.02),
            _run("r-mid", "b-mid", 0.30),
            _run("r-pricey-a", "b-pricey", 0.40),
            _run("r-pricey-b", "b-pricey", 0.45),
            _run("r-unfinished", "b-unfinished", 0.10),
        ]
    )
    session.commit()


def _ids(client: TestClient, **params: object) -> list[str]:
    response = client.get("/v1/agent-task-batch-runs", params={"project": PROJECT, **params})
    assert response.status_code == 200, response.text
    return [batch["id"] for batch in response.json()["data"]]


def test_cost_min_keeps_batches_at_or_above(client: TestClient, session: Session) -> None:
    seeded(session)
    assert _ids(client, cost_min=0.25) == ["b-pricey", "b-mid"]


def test_cost_max_keeps_batches_at_or_below(client: TestClient, session: Session) -> None:
    seeded(session)
    assert _ids(client, cost_max=0.25) == ["b-unfinished", "b-cheap"]


def test_cost_range_bounds_both_sides(client: TestClient, session: Session) -> None:
    seeded(session)
    assert _ids(client, cost_min=0.25, cost_max=0.5) == ["b-mid"]


def test_duration_min_uses_wall_clock_seconds(client: TestClient, session: Session) -> None:
    seeded(session)
    assert _ids(client, duration_min=120) == ["b-pricey", "b-mid"]


def test_duration_max_excludes_batches_without_a_span(client: TestClient, session: Session) -> None:
    seeded(session)
    assert _ids(client, duration_max=120) == ["b-cheap"]


def test_negative_bounds_are_rejected(client: TestClient, session: Session) -> None:
    seeded(session)
    response = client.get(
        "/v1/agent-task-batch-runs", params={"project": PROJECT, "cost_min": -1}
    )
    assert response.status_code == 422


def _quantile_batch(batch_id: str, cost: float, duration_seconds: float) -> tuple[
    AgentTaskBatchRunDB, AgentTaskRunDB
]:
    started = NOW - timedelta(minutes=30)
    batch = AgentTaskBatchRunDB(
        id=batch_id,
        project=PROJECT,
        selection_type="caller-task",
        environment="default",
        run_metadata={"trigger": {"source": "api"}},
        status="completed",
        total_tasks=1,
        started_at=started,
        completed_at=started + timedelta(seconds=duration_seconds),
        created_at=NOW - timedelta(minutes=31),
    )
    run = AgentTaskRunDB(
        id=f"r-{batch_id}",
        batch_run_id=batch_id,
        task_id="team/task",
        task_path="team/task",
        status="passed",
        pass_result=True,
        total_cost=cost,
        started_at=started,
        completed_at=started,
    )
    return batch, run


def test_facets_report_distribution_quantiles(client: TestClient, session: Session) -> None:
    session.add(ProjectDB(id=PROJECT, name=PROJECT, created_at=NOW))
    pairs = [
        _quantile_batch(f"b-{i}", cost=float(i), duration_seconds=float(i * 30))
        for i in range(1, 6)
    ]
    session.add_all([row for pair in pairs for row in pair])
    session.commit()

    response = client.get(f"/v1/projects/{PROJECT}/agent-task-run-label-facets")
    assert response.status_code == 200, response.text
    metrics = response.json()["metrics"]
    # Nearest-rank over [1..5]: p20=1, p50=3, p80=4; durations [30..150].
    assert metrics["cost"] == {"p20": 1.0, "p50": 3.0, "p80": 4.0}
    assert metrics["duration_seconds"] == {"p20": 30.0, "p50": 90.0, "p80": 120.0}


def test_facets_leave_metrics_null_below_five_values(
    client: TestClient, session: Session
) -> None:
    seeded(session)  # four batches: below the quantile minimum
    response = client.get(f"/v1/projects/{PROJECT}/agent-task-run-label-facets")
    assert response.status_code == 200, response.text
    metrics = response.json()["metrics"]
    assert metrics["cost"] is None
    assert metrics["duration_seconds"] is None
