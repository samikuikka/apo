# pyright: reportAny=false, reportCallIssue=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Run aggregates must not depend on how the projector batches its work.

The projector used to recompute a completed run's aggregates after every
span. That made projection quadratic in trace size, so the queue worker and
reproject now aggregate once per run per pass. This suite pins the contract
that made the change safe: for the same spans in the same order, the derived
state (run rollup columns, aggregate ``run_metrics`` rows, the linked Task
Run's totals) is identical to what the per-span implementation produced.

``fixtures/projection_aggregate_golden.json`` was recorded from the per-span
implementation, before the deferral existed, by running this module with
``APO_RECORD_PROJECTION_GOLDEN=1``. Re-record it only for a deliberate
change to aggregate semantics, never to make a batching change pass.

Several fixture details are order dependent on purpose (a cost tie for
``primary_model``, a latency tie for the slowest call, a run whose
``created_at`` comes from whichever span lands first), so each span order
has its own golden entry and a batching change cannot hide behind a
commutative fixture.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
from sqlmodel import Session, col, select, text

from apo.db import engine, init_db
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    LoggedCallDB,
    RunDB,
    RunMetricDB,
)
from apo.services.otlp_receiver import OtlpReceiver
from apo.services.reproject import reproject_trace
from apo.services.trace_ingestion_queue import QueueWorker

PROJECT = "aggregate-golden"
LINKED_TRACE = "a2240000000000000000000000000001"
UNLINKED_TRACE = "b2240000000000000000000000000002"
TASK_RUN_ID = "golden-task-run"
GOLDEN_PATH = Path(__file__).parent / "fixtures" / "projection_aggregate_golden.json"
RECORD = os.environ.get("APO_RECORD_PROJECTION_GOLDEN") == "1"
# Each name maps to a span order in ``_ORDERS`` and to one golden entry.
ORDER_NAMES = (
    "payload_order",
    "reversed",
    "rotated",
    "shuffled",
    "root_first_three_batches",
    "roots_last_three_batches",
    "single_span_tail",
)

# Fixed wall-clock anchor; every span time is an offset from it, so no
# snapshot depends on when the suite runs.
_BASE_NANOS = 1_791_907_200_000_000_000
_BASE_TIME = datetime.fromtimestamp(_BASE_NANOS // 1_000_000_000, tz=timezone.utc)

Span = dict[str, Any]
Batches = list[list[Span]]


@pytest.fixture(autouse=True)
def clean_projection_tables():
    init_db()
    _clear_tables()
    yield
    _clear_tables()


@pytest.mark.parametrize("order", ORDER_NAMES)
class TestAggregatesMatchPerSpanImplementation:
    def test_queue_worker_pass(self, order: str) -> None:
        """The production path: accept, then project each batch in one pass."""
        _seed_linked_task_run()
        _project_through_queue(_ORDERS[order](fixture_spans()))

        _check_or_record(order, "projected", _snapshot())

    def test_reproject_after_projection(self, order: str) -> None:
        """Replaying canonical spans must land on the same derived state."""
        _seed_linked_task_run()
        _project_through_queue(_ORDERS[order](fixture_spans()))
        for trace_id in (LINKED_TRACE, UNLINKED_TRACE):
            reproject_trace(trace_id, project_id=PROJECT)

        _check_or_record(order, "reprojected", _snapshot())

    def test_immediate_receiver_path(self, order: str) -> None:
        """The per-span path (no deferral) agrees with the batched one."""
        _seed_linked_task_run()
        receiver = OtlpReceiver()
        for spans in _ORDERS[order](fixture_spans()):
            with Session(engine) as session:
                result = receiver.ingest(
                    payload=_payload(spans),
                    content_type="application/json",
                    project_id=PROJECT,
                    session=session,
                    project_immediately=True,
                )
            assert result.rejected == 0, result.errors[:3]

        if not RECORD:
            assert _snapshot() == _golden()[order]["projected"]


def test_every_order_has_a_golden_entry() -> None:
    """An order added without recording it must fail loudly, not skip."""
    assert sorted(_ORDERS) == sorted(ORDER_NAMES)
    if not RECORD:
        assert sorted(_golden()) == sorted(ORDER_NAMES)


# ---------------------------------------------------------------------------
# Fixture: two interleaved traces
# ---------------------------------------------------------------------------


def fixture_spans() -> list[Span]:
    """Two traces in one stream, roots first (the expensive arrival order).

    The linked trace carries the interesting aggregates: a cost tie between
    two models, a latency tie for the slowest generation, an errored
    generation, two reasoning reporters, a costed plain span, and enough tool
    spans to cross the worker's commit chunk inside one batch. The unlinked
    trace has no pre-seeded run row, so its ``created_at`` and duration come
    from the first span that lands.
    """
    linked_root = "a000000000000001"
    unlinked_root = "b000000000000001"
    spans: list[Span] = [
        _span(
            LINKED_TRACE, linked_root, None, "agent run", 0, 60_000,
            {"apo.observation.type": "AGENT", "apo.trace.name": "golden linked"},
        ),
        _span(
            UNLINKED_TRACE, unlinked_root, None, "unlinked agent", 500, 20_500,
            {"apo.observation.type": "AGENT"},
        ),
        _generation(LINKED_TRACE, "a000000000000002", linked_root, 1_000, 3_000,
                    model="golden-model-alpha", cost=0.02, tokens=(1000, 200)),
        # Beta's two calls total the same cost as alpha's one, and three
        # generations share the longest latency (3 s): which model is primary
        # and which call is slowest both depend on call row order.
        _generation(LINKED_TRACE, "a000000000000003", linked_root, 4_000, 7_000,
                    model="golden-model-beta", cost=0.01, tokens=(500, 100)),
        _generation(LINKED_TRACE, "a000000000000004", linked_root, 8_000, 11_000,
                    model="golden-model-beta", cost=0.01, tokens=(800, 150)),
        _generation(LINKED_TRACE, "a000000000000005", linked_root, 12_000, 15_000,
                    model="golden-model-alpha", tokens=(10, 0), error="rate limited"),
        _generation(LINKED_TRACE, "a000000000000006", linked_root, 17_000, 18_500,
                    model="golden-model-gamma", tokens=(300, 120), reasoning=80),
        _generation(LINKED_TRACE, "a000000000000007", linked_root, 19_000, 20_000,
                    model="golden-model-gamma", tokens=(200, 90), reasoning=40),
        _span(
            LINKED_TRACE, "a000000000000008", linked_root, "agent-llm-call",
            21_000, 21_400, {"apo.observation.cost.amount": 0.005},
        ),
        _generation(UNLINKED_TRACE, "b000000000000002", unlinked_root, 1_000, 2_500,
                    model="golden-model-beta", cost=0.004, tokens=(120, 30)),
        _generation(UNLINKED_TRACE, "b000000000000003", unlinked_root, 3_000, 9_000,
                    model="golden-model-alpha", cost=0.03, tokens=(2000, 400)),
        _tool(UNLINKED_TRACE, "b000000000000004", unlinked_root, 9_500, 19_500),
    ]
    # Longer than any generation: a tool must never win "slowest call".
    spans.append(_tool(LINKED_TRACE, "a000000000000009", linked_root, 22_000, 31_000))
    spans += [
        _tool(
            LINKED_TRACE,
            f"a0000000000001{index:02x}",
            linked_root,
            32_000 + index * 100,
            32_000 + index * 100 + 40 + index,
        )
        for index in range(40)
    ]
    return spans


def _generation(
    trace_id: str,
    span_id: str,
    parent: str,
    start_ms: int,
    end_ms: int,
    *,
    model: str,
    tokens: tuple[int, int],
    cost: float | None = None,
    reasoning: int | None = None,
    error: str | None = None,
) -> Span:
    attributes: dict[str, object] = {
        "apo.observation.type": "GENERATION",
        "gen_ai.request.model": model,
        "gen_ai.provider.name": "golden-provider",
        "gen_ai.usage.input_tokens": tokens[0],
        "gen_ai.usage.output_tokens": tokens[1],
    }
    if cost is not None:
        attributes["apo.observation.cost.amount"] = cost
    if reasoning is not None:
        attributes["gen_ai.usage.reasoning.output_tokens"] = reasoning
    return _span(
        trace_id, span_id, parent, f"chat {model}", start_ms, end_ms, attributes, error
    )


def _tool(trace_id: str, span_id: str, parent: str, start_ms: int, end_ms: int) -> Span:
    return _span(
        trace_id, span_id, parent, "execute_tool bash", start_ms, end_ms,
        {"apo.observation.type": "TOOL", "gen_ai.tool.name": "bash"},
    )


def _span(
    trace_id: str,
    span_id: str,
    parent: str | None,
    name: str,
    start_ms: int,
    end_ms: int,
    attributes: dict[str, object],
    error: str | None = None,
) -> Span:
    span: Span = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "kind": 1,
        "startTimeUnixNano": str(_BASE_NANOS + start_ms * 1_000_000),
        "endTimeUnixNano": str(_BASE_NANOS + end_ms * 1_000_000),
        "attributes": [_attribute(key, value) for key, value in attributes.items()],
    }
    if parent is not None:
        span["parentSpanId"] = parent
    if error is not None:
        span["status"] = {"code": 2, "message": error}
    return span


def _attribute(key: str, value: object) -> dict[str, object]:
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    if isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    return {"key": key, "value": {"stringValue": str(value)}}


def _payload(spans: list[Span]) -> bytes:
    return json.dumps(
        {
            "resourceSpans": [
                {
                    "resource": {
                        "attributes": [_attribute("service.name", "golden-svc")]
                    },
                    "scopeSpans": [{"scope": {"name": "golden"}, "spans": spans}],
                }
            ]
        }
    ).encode()


# ---------------------------------------------------------------------------
# Span orders (deterministic: no ``random``)
# ---------------------------------------------------------------------------


def _is_root(span: Span) -> bool:
    return "parentSpanId" not in span


def _shuffled(spans: list[Span]) -> list[Span]:
    """Fisher-Yates over a fixed linear congruential sequence."""
    out = list(spans)
    state = 224
    for index in range(len(out) - 1, 0, -1):
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
        swap = state % (index + 1)
        out[index], out[swap] = out[swap], out[index]
    return out


def _split(spans: list[Span], parts: int) -> Batches:
    size = -(-len(spans) // parts)
    return [spans[start : start + size] for start in range(0, len(spans), size)]


def _roots_last(spans: list[Span]) -> list[Span]:
    shuffled = _shuffled(spans)
    return [s for s in shuffled if not _is_root(s)] + [s for s in shuffled if _is_root(s)]


_ORDERS: dict[str, Callable[[list[Span]], Batches]] = {
    # Roots first in one batch: every later span lands on a completed run.
    "payload_order": lambda spans: [spans],
    "reversed": lambda spans: [spans[::-1]],
    "rotated": lambda spans: [spans[17:] + spans[:17]],
    "shuffled": lambda spans: [_shuffled(spans)],
    # Late spans arriving in later passes, after the run already completed.
    "root_first_three_batches": lambda spans: _split(spans, 3),
    "roots_last_three_batches": lambda spans: _split(_roots_last(spans), 3),
    # A sender that trickles its tail one span per request.
    "single_span_tail": lambda spans: [spans[:-5]] + [[span] for span in spans[-5:]],
}


# ---------------------------------------------------------------------------
# Projection + snapshot
# ---------------------------------------------------------------------------


def _seed_linked_task_run() -> None:
    """A finalized Task Run already linked to the first trace."""
    with Session(engine) as session:
        session.add(
            AgentTaskBatchRunDB(
                id="golden-batch",
                project=PROJECT,
                selection_type="manual",
                status="completed",
            )
        )
        session.add(
            AgentTaskRunDB(
                id=TASK_RUN_ID,
                batch_run_id="golden-batch",
                task_id="t",
                task_path="p",
                status="passed",
                trace_run_id=LINKED_TRACE,
            )
        )
        session.add(
            RunDB(
                id=LINKED_TRACE,
                project=PROJECT,
                environment="default",
                task_run_id=TASK_RUN_ID,
                call_count=0,
                created_at=_BASE_TIME,
            )
        )
        session.commit()


def _project_through_queue(batches: Batches) -> None:
    receiver = OtlpReceiver()
    worker = QueueWorker(receiver=receiver)
    for spans in batches:
        with Session(engine) as session:
            accepted = receiver.ingest(
                payload=_payload(spans),
                content_type="application/json",
                project_id=PROJECT,
                session=session,
                project_immediately=False,
            )
        assert accepted.rejected == 0, accepted.errors[:3]
        outcome = worker._process_batch(accepted.batch_id)
        assert outcome.rejected == 0, outcome.errors[:3]
        assert outcome.projected == len(spans)


def _snapshot() -> dict[str, Any]:
    with Session(engine) as session:
        task_run = session.get(AgentTaskRunDB, TASK_RUN_ID)
        assert task_run is not None
        return {
            "linked": _trace_snapshot(session, LINKED_TRACE),
            "unlinked": _trace_snapshot(session, UNLINKED_TRACE),
            "task_run": {
                "total_cost": task_run.total_cost,
                "total_tokens": task_run.total_tokens,
                "unpriced_call_count": task_run.unpriced_call_count,
                "total_reasoning_tokens": task_run.total_reasoning_tokens,
                "max_call_reasoning_tokens": task_run.max_call_reasoning_tokens,
                "max_call_reasoning_call_id": task_run.max_call_reasoning_call_id,
                "max_call_latency_ms": task_run.max_call_latency_ms,
                "max_call_latency_call_id": task_run.max_call_latency_call_id,
                "total_model_time_ms": task_run.total_model_time_ms,
                "generation_execution_json": task_run.generation_execution_json,
                "generation_usage_json": task_run.generation_usage_json,
                "model_providers_json": task_run.model_providers_json,
            },
        }


def _trace_snapshot(session: Session, trace_id: str) -> dict[str, Any]:
    run = session.exec(
        select(RunDB).where(RunDB.id == trace_id, RunDB.project == PROJECT)
    ).first()
    assert run is not None, f"trace {trace_id} was not projected"
    metrics = session.exec(
        select(RunMetricDB)
        .where(
            col(RunMetricDB.run_id) == trace_id,
            col(RunMetricDB.project) == PROJECT,
        )
        .order_by(col(RunMetricDB.metric_type), col(RunMetricDB.metric_name))
    ).all()
    calls = session.exec(
        select(LoggedCallDB)
        .where(LoggedCallDB.run_id == trace_id, col(LoggedCallDB.project) == PROJECT)
        .order_by(col(LoggedCallDB.id))
    ).all()
    call_facts = [
        [
            call.id, call.model, call.observation_type, call.cost,
            call.cost_provenance, call.prompt_tokens, call.completion_tokens,
            call.total_tokens, call.latency_ms, call.level, call.raw_usage,
        ]
        for call in calls
    ]
    return {
        "run": {
            "call_count": run.call_count,
            "primary_model": run.primary_model,
            "model_providers_json": run.model_providers_json,
            "flow_name": run.flow_name,
            "environment": run.environment,
            "service_name": run.service_name,
            "task_run_id": run.task_run_id,
            "created_at": run.created_at.isoformat() if run.created_at else None,
            "completed_at": run.completed_at.isoformat() if run.completed_at else None,
            "duration_ms": run.duration_ms,
            "input_preview": run.input_preview,
            "output_preview": run.output_preview,
        },
        "metrics": [
            {
                "metric_name": metric.metric_name,
                "metric_type": metric.metric_type,
                "score": metric.score,
                "reasoning": metric.reasoning,
                "meta": metric.meta,
            }
            for metric in metrics
        ],
        "call_rows": len(calls),
        "call_facts_sha256": hashlib.sha256(
            json.dumps(call_facts, sort_keys=True).encode()
        ).hexdigest(),
    }


def _golden() -> dict[str, dict[str, Any]]:
    return json.loads(GOLDEN_PATH.read_text())


def _check_or_record(order: str, stage: str, snapshot: dict[str, Any]) -> None:
    if not RECORD:
        assert snapshot == _golden()[order][stage]
        return
    golden = _golden() if GOLDEN_PATH.exists() else {}
    golden.setdefault(order, {})[stage] = snapshot
    GOLDEN_PATH.write_text(json.dumps(golden, indent=1, sort_keys=True) + "\n")


def _clear_tables() -> None:
    with Session(engine) as session:
        for table in (
            "call_metrics",
            "run_metrics",
            "logged_calls",
            "runs",
            "otlp_spans",
            "otlp_ingest_batches",
            "agent_task_runs",
            "agent_task_batch_runs",
        ):
            session.execute(text(f"DELETE FROM {table}"))
        session.commit()
