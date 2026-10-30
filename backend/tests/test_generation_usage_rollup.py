"""Issue #309: a Task Run carries its model time and reasoning, not just totals.

An average latency and a folded-in token total hide the one call a change made
slow or verbose. The fixture goes through the real OTLP receiver so the
reasoning usage dimension is normalized exactly as a live trace's would be.
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from apo.models.db import AgentTaskRunDB, LoggedCallDB
from apo.models.schemas import GenerationUsageSummary
from apo.services.agent_task_projection import to_task_run_summary
from apo.services.otlp_receiver import OtlpReceiver
from apo.services.pricing.compute import compute_cost
from apo.services.pricing.loader import load_default_prices
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
        # 20 output + reasoning tokens over 1.0/6.5/2.5 s decode windows.
        "median_output_tok_s": 120.0,
        "output_tok_s_calls": 3,
        "reasoning_tokens": 1_394,
        "reasoning_calls": 3,
        "max_call_reasoning_tokens": 1_054,
        "max_reasoning_call_id": "0000000000000002",
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
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


# Three generations captured from a real Opus 5.5 run, with the usage
# attributes bind's pi runtime stamps: both cache spellings and both reasoning
# spellings. The runtime logged 42, 104 and 0 thinking tokens.
_CLAUDE_CALLS: list[dict[str, int]] = [
    {"input": 4, "output": 365, "cache_read": 0, "cache_write": 33746, "reasoning": 42},
    {"input": 2, "output": 432, "cache_read": 33746, "cache_write": 5314, "reasoning": 104},
    {"input": 2, "output": 254, "cache_read": 39060, "cache_write": 4832, "reasoning": 0},
]


def test_claude_thinking_tokens_roll_up_without_changing_cost(
    session: Session,
) -> None:
    """Claude reasoning used to be dropped by the anthropic normalizer, so the
    run read "unknown". It is split out of output and priced at the output
    rate, so each call costs what it did before the split."""
    _ = load_default_prices(session)
    _ingest(
        session,
        [
            _claude_generation(f"000000000000000{i + 1}", usage)
            for i, usage in enumerate(_CLAUDE_CALLS)
        ],
    )
    calls = {c.id: c for c in session.exec(select(LoggedCallDB)).all()}
    first = calls["0000000000000001"]
    assert first.raw_usage == {
        "input": 4,
        "output": 323,
        "cache_read": 0,
        "cache_write_1h": 0,
        "cache_write_5m": 33746,
        "reasoning": 42,
    }
    assert first.completion_tokens == 365

    for i, usage in enumerate(_CLAUDE_CALLS):
        call = calls[f"000000000000000{i + 1}"]
        assert call.cost is not None and call.cost > 0
        assert call.cost == _cost_before_the_split(session, call, usage)

    usage_json = _aggregate(session).generation_usage_json
    assert usage_json is not None
    assert usage_json["reasoning_tokens"] == 146
    assert usage_json["reasoning_calls"] == 3
    assert usage_json["max_call_reasoning_tokens"] == 104
    assert usage_json["max_reasoning_call_id"] == "0000000000000002"
    assert usage_json["cache_read_tokens"] == 0 + 33746 + 39060
    assert usage_json["cache_write_tokens"] == 33746 + 5314 + 4832


def test_cache_totals_count_both_write_ttls_and_skip_errored_generations(
    session: Session,
) -> None:
    _ingest(
        session,
        [
            _claude_generation(
                "0000000000000001",
                {"input": 4, "output": 365, "cache_read": 0, "cache_write": 33746, "cache_write_1h": 30000, "reasoning": 0},
            ),
            _claude_generation(
                "0000000000000002",
                {"input": 2, "output": 432, "cache_read": 33746, "cache_write": 5314, "reasoning": 0},
            ),
            _claude_generation(
                "0000000000000003",
                {"input": 2, "output": 0, "cache_read": 39060, "cache_write": 4832, "reasoning": 0},
                errored=True,
            ),
        ],
    )
    usage = _aggregate(session).generation_usage_json

    assert usage is not None
    assert usage["cache_read_tokens"] == 33746
    assert usage["cache_write_tokens"] == 33746 + 5314


def test_runs_aggregated_before_cache_totals_read_as_unknown() -> None:
    legacy = {"generations": 2, "model_time_ms": 1_000.0, "slowest_call_ms": 600.0, "slowest_call_id": "a",
              "reasoning_tokens": None, "reasoning_calls": 0, "max_call_reasoning_tokens": None,
              "max_reasoning_call_id": None}

    summary = GenerationUsageSummary.model_validate(legacy)

    assert summary.cache_read_tokens is None
    assert summary.cache_write_tokens is None


def test_ai_sdk_root_span_does_not_price_reasoning_twice(session: Session) -> None:
    """AI SDK 6 stamps the step's usage on both the root ``ai.streamText`` span
    and its ``doStream`` child, the root without an output count the anthropic
    normalizer reads. Only the child is priced, and reasoning is counted once."""
    _ = load_default_prices(session)
    metadata = {"key": "ai.response.providerMetadata", "value": {"stringValue": '{"anthropic": {}}'}}

    def int_attr(key: str, value: int) -> dict[str, object]:
        return {"key": key, "value": {"intValue": str(value)}}

    model = {"key": "ai.model.id", "value": {"stringValue": "claude-opus-5-5"}}
    sdk_usage = [
        int_attr("ai.usage.inputTokens", 1000),
        int_attr("ai.usage.outputTokens", 500),
        int_attr("ai.usage.reasoningTokens", 200),
    ]
    outer: dict[str, object] = {
        "traceId": TRACE_ID,
        "spanId": "0000000000000001",
        "parentSpanId": ROOT_SPAN_ID,
        "name": "ai.streamText",
        "startTimeUnixNano": str(START_NS),
        "endTimeUnixNano": str(START_NS + 2_000 * MS),
        "status": {"code": 1},
        "attributes": [model, metadata, *sdk_usage],
    }
    inner: dict[str, object] = {
        "traceId": TRACE_ID,
        "spanId": "0000000000000002",
        "parentSpanId": "0000000000000001",
        "name": "ai.streamText.doStream",
        "startTimeUnixNano": str(START_NS),
        "endTimeUnixNano": str(START_NS + 2_000 * MS),
        "status": {"code": 1},
        "attributes": [
            model,
            metadata,
            *sdk_usage,
            {"key": "gen_ai.system", "value": {"stringValue": "anthropic"}},
            {"key": "gen_ai.request.model", "value": {"stringValue": "claude-opus-5-5"}},
            int_attr("gen_ai.usage.input_tokens", 1000),
            int_attr("gen_ai.usage.output_tokens", 500),
        ],
    }
    _ingest(session, [outer, inner])
    calls = {c.id: c for c in session.exec(select(LoggedCallDB)).all()}

    assert not (calls["0000000000000001"].raw_usage or {}).get("reasoning")
    assert calls["0000000000000002"].raw_usage == {"input": 1000, "output": 300, "reasoning": 200}
    child_cost = calls["0000000000000002"].cost
    assert child_cost is not None and child_cost > 0
    assert sum(c.cost or 0 for c in calls.values()) == child_cost

    usage_json = _aggregate(session).generation_usage_json
    assert usage_json is not None
    assert usage_json["reasoning_tokens"] == 200


def _cost_before_the_split(session: Session, call: LoggedCallDB, usage: dict[str, int]) -> int:
    """What the call was priced at when the anthropic normalizer ignored
    reasoning: thinking tokens inside a gross output count."""
    assert call.created_at is not None
    result = compute_cost(
        session,
        "claude-opus-5-5",
        {
            "input": usage["input"],
            "output": usage["output"],
            "cache_read": usage["cache_read"],
            "cache_write_1h": 0,
            "cache_write_5m": usage["cache_write"],
        },
        "p1",
        call.created_at,
    )
    assert result is not None
    return result.total


def _claude_generation(
    span_id: str, usage: dict[str, int], *, errored: bool = False
) -> dict[str, object]:
    def int_attr(key: str, value: int) -> dict[str, object]:
        return {"key": key, "value": {"intValue": str(value)}}

    attributes: list[dict[str, object]] = [
        {"key": "gen_ai.operation.name", "value": {"stringValue": "chat"}},
        {"key": "gen_ai.system", "value": {"stringValue": "anthropic"}},
        {"key": "gen_ai.request.model", "value": {"stringValue": "claude-opus-5-5"}},
        int_attr("gen_ai.usage.input_tokens", usage["input"]),
        int_attr("gen_ai.usage.output_tokens", usage["output"]),
        int_attr("gen_ai.usage.cache_read.input_tokens", usage["cache_read"]),
        int_attr("gen_ai.usage.cache_read_input_tokens", usage["cache_read"]),
        int_attr("gen_ai.usage.cache_creation.input_tokens", usage["cache_write"]),
        int_attr("gen_ai.usage.cache_creation_input_tokens", usage["cache_write"]),
        int_attr("gen_ai.usage.cache_creation.ephemeral_1h_input_tokens", usage.get("cache_write_1h", 0)),
        int_attr("gen_ai.usage.reasoning.output_tokens", usage["reasoning"]),
        int_attr("gen_ai.usage.reasoning_tokens", usage["reasoning"]),
    ]
    return {
        "traceId": TRACE_ID,
        "spanId": span_id,
        "parentSpanId": ROOT_SPAN_ID,
        "name": "gen_ai.chat claude-opus-5-5",
        "startTimeUnixNano": str(START_NS),
        "endTimeUnixNano": str(START_NS + 1_000 * MS),
        "status": {"code": 2 if errored else 1},
        "attributes": attributes,
    }


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
