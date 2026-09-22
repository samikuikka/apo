"""Issue #309: a Task Run carries its model time and reasoning, not just totals.

An average latency and a folded-in token total hide the one call a change made
slow or verbose. The fixture goes through the real OTLP receiver so the
reasoning usage dimension is normalized exactly as a live trace's would be.
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from apo.models.db import AgentTaskRunDB
from apo.services.agent_task_projection import to_task_run_summary
from apo.services.otlp_receiver import OtlpReceiver
from apo.services.trace_backend import NativeTraceBackend

TRACE_ID = "30930930930930930930930930930930"
ROOT_SPAN_ID = "3093093093093093"
START_NS = 1787137200000000000
MS = 1_000_000


@pytest.fixture
def session() -> Session:  # pyright: ignore[reportInvalidTypeForm]
    engine = create_engine("sqlite://", poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    value = Session(engine)
    yield value  # pyright: ignore[reportReturnType]
    value.close()


def test_rolls_up_model_time_slowest_call_and_largest_reasoning(
    session: Session,
) -> None:
    _ingest(
        session,
        [
            _generation("0000000000000001", duration_ms=1_000, reasoning=40),
            _generation("0000000000000002", duration_ms=6_500, reasoning=1_054),
            _generation("0000000000000003", duration_ms=2_500, reasoning=300),
            _tool("0000000000000004", duration_ms=90_000),
        ],
    )
    task_run = _aggregate(session)

    assert task_run.generation_usage_json == {
        "generations": 3,
        "model_time_ms": 10_000.0,
        "slowest_call_ms": 6_500.0,
        "slowest_call_id": "0000000000000002",
        "reasoning_tokens": 1_394,
        "reasoning_calls": 3,
        "max_call_reasoning_tokens": 1_054,
        "max_reasoning_call_id": "0000000000000002",
    }
    public = to_task_run_summary(task_run).generation_usage
    assert public is not None
    assert public.model_dump() == task_run.generation_usage_json


def test_errored_generation_counts_as_time_but_not_as_reasoning(
    session: Session,
) -> None:
    _ingest(
        session,
        [
            _generation("0000000000000001", duration_ms=2_000, reasoning=500),
            _generation(
                "0000000000000002", duration_ms=240_000, reasoning=0, errored=True
            ),
        ],
    )
    usage = _aggregate(session).generation_usage_json

    assert usage is not None
    assert usage["model_time_ms"] == 242_000.0
    assert usage["slowest_call_id"] == "0000000000000002"
    assert usage["reasoning_tokens"] == 500
    assert usage["reasoning_calls"] == 1
    assert usage["max_reasoning_call_id"] == "0000000000000001"


def test_unreported_reasoning_is_unknown_not_zero(session: Session) -> None:
    _ingest(
        session,
        [
            _generation("0000000000000001", duration_ms=1_000, reasoning=None),
            _generation("0000000000000002", duration_ms=1_500, reasoning=None),
        ],
    )
    usage = _aggregate(session).generation_usage_json

    assert usage is not None
    assert usage["generations"] == 2
    assert usage["reasoning_tokens"] is None
    assert usage["reasoning_calls"] == 0
    assert usage["max_call_reasoning_tokens"] is None


def test_partially_reported_reasoning_counts_its_calls(session: Session) -> None:
    _ingest(
        session,
        [
            _generation("0000000000000001", duration_ms=1_000, reasoning=200),
            _generation("0000000000000002", duration_ms=1_000, reasoning=None),
        ],
    )
    usage = _aggregate(session).generation_usage_json

    assert usage is not None
    assert usage["reasoning_tokens"] == 200
    assert usage["reasoning_calls"] == 1
    assert usage["generations"] == 2


def test_trace_without_generations_has_no_usage_summary(session: Session) -> None:
    _ingest(session, [_tool("0000000000000001", duration_ms=5_000)])

    assert _aggregate(session).generation_usage_json is None


def _aggregate(session: Session) -> AgentTaskRunDB:
    task_run = AgentTaskRunDB(
        id="run-1",
        batch_run_id="batch-1",
        task_id="task/x",
        task_path="task/x",
        status="running",
        trace_run_id=TRACE_ID,
    )
    session.add(task_run)
    session.commit()
    NativeTraceBackend().aggregate_costs(session, task_run, "p1")
    return task_run


def _ingest(session: Session, children: list[dict[str, object]]) -> None:
    root: dict[str, object] = {
        "traceId": TRACE_ID,
        "spanId": ROOT_SPAN_ID,
        "name": "agent-task",
        "startTimeUnixNano": str(START_NS),
        "endTimeUnixNano": str(START_NS + 300_000 * MS),
        "status": {"code": 1},
        "attributes": [],
    }
    payload: dict[str, object] = {
        "resourceSpans": [
            {
                "resource": {"attributes": []},
                "scopeSpans": [
                    {"scope": {"name": "issue-309"}, "spans": [root, *children]}
                ],
            }
        ]
    }
    result = OtlpReceiver().ingest(
        payload=json.dumps(payload).encode(),
        content_type="application/json",
        project_id="p1",
        session=session,
    )
    assert result.rejected == 0
    assert result.accepted == len(children) + 1


def _generation(
    span_id: str,
    *,
    duration_ms: int,
    reasoning: int | None,
    errored: bool = False,
) -> dict[str, object]:
    attributes: list[dict[str, object]] = [
        {"key": "gen_ai.operation.name", "value": {"stringValue": "chat"}},
        {"key": "gen_ai.system", "value": {"stringValue": "openai"}},
        {"key": "gen_ai.request.model", "value": {"stringValue": "fixture-model"}},
        {
            "key": "gen_ai.response.finish_reasons",
            "value": {
                "arrayValue": {
                    "values": [{"stringValue": "error" if errored else "stop"}]
                }
            },
        },
        {"key": "gen_ai.usage.input_tokens", "value": {"intValue": "100"}},
        {"key": "gen_ai.usage.output_tokens", "value": {"intValue": "20"}},
    ]
    if reasoning is not None:
        attributes.append(
            {
                "key": "gen_ai.usage.reasoning.output_tokens",
                "value": {"intValue": str(reasoning)},
            }
        )
    return {
        "traceId": TRACE_ID,
        "spanId": span_id,
        "parentSpanId": ROOT_SPAN_ID,
        "name": "chat fixture-model",
        "startTimeUnixNano": str(START_NS),
        "endTimeUnixNano": str(START_NS + duration_ms * MS),
        "status": {"code": 2 if errored else 1},
        "attributes": attributes,
    }


def _tool(span_id: str, *, duration_ms: int) -> dict[str, object]:
    return {
        "traceId": TRACE_ID,
        "spanId": span_id,
        "parentSpanId": ROOT_SPAN_ID,
        "name": "execute_tool read",
        "startTimeUnixNano": str(START_NS),
        "endTimeUnixNano": str(START_NS + duration_ms * MS),
        "status": {"code": 1},
        "attributes": [
            {"key": "gen_ai.operation.name", "value": {"stringValue": "execute_tool"}},
            {"key": "gen_ai.tool.name", "value": {"stringValue": "read"}},
        ],
    }


def test_avg_latency_metric_averages_generations_only(session: Session) -> None:
    """The trace-run ``avg_latency`` metric must average model calls, not
    observations: the agent-task root span's latency is the run's whole wall
    clock and a tool's latency is tool time, not model time."""
    from apo.metrics.aggregate import calculate_and_store_aggregate_metrics

    _ingest(
        session,
        [
            _generation("0000000000000011", duration_ms=1_000, reasoning=None),
            _generation("0000000000000012", duration_ms=6_500, reasoning=None),
            _generation("0000000000000013", duration_ms=2_500, reasoning=None),
            _tool("0000000000000014", duration_ms=90_000),
        ],
    )

    rows = calculate_and_store_aggregate_metrics(session, TRACE_ID, "p1")
    avg = next(r for r in rows if r.metric_name == "avg_latency")

    # (1_000 + 6_500 + 2_500) / 3 — the 90s tool and the 300s root span must
    # not drag the average (unfiltered they would raise it to ~80s).
    assert avg.score == pytest.approx(10_000.0 / 3)


def test_batch_detail_sums_generation_usage_and_keeps_unknown() -> None:
    """Batch-level reasoning/model-time sums skip unknown children instead of
    zeroing them, and stay null only when every child is unknown."""
    from datetime import datetime, timezone

    from apo.models.db import AgentTaskBatchRunDB
    from apo.services.agent_task_projection import to_batch_run_detail

    now = datetime.now(timezone.utc)
    batch = AgentTaskBatchRunDB(
        id="batch-309",
        project="p1",
        selection_type="task",
        status="completed",
        total_tasks=3,
        created_at=now,
    )
    runs = [
        AgentTaskRunDB(
            id="run-309-a",
            batch_run_id=batch.id,
            task_id="t",
            task_path="t",
            status="passed",
            generation_usage_json={
                "generations": 2,
                "model_time_ms": 12_000.0,
                "reasoning_tokens": 500,
            },
        ),
        AgentTaskRunDB(
            id="run-309-b",
            batch_run_id=batch.id,
            task_id="t",
            task_path="t",
            status="passed",
            generation_usage_json={
                "generations": 1,
                "model_time_ms": 3_000.0,
                "reasoning_tokens": None,
            },
        ),
        # Legacy run: rolled up before issue #309, no summary at all.
        AgentTaskRunDB(
            id="run-309-c",
            batch_run_id=batch.id,
            task_id="t",
            task_path="t",
            status="passed",
        ),
    ]

    detail = to_batch_run_detail(batch, runs)

    assert detail.total_reasoning_tokens == 500
    assert detail.total_model_time_ms == 15_000.0

    all_unknown = to_batch_run_detail(batch, [runs[2]])
    assert all_unknown.total_reasoning_tokens is None
    assert all_unknown.total_model_time_ms is None
