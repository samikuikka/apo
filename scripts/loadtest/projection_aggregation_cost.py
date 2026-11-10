#!/usr/bin/env python3
"""Projection aggregation cost: does per-span work grow with trace size?

Projects one synthetic trace per size through the real queue-worker path
(``OtlpReceiver.ingest`` then ``QueueWorker._process_batch``) and then
through ``reproject_trace``, against a throwaway SQLite file. The root span
(with an end time) arrives FIRST, so every other span lands on a completed
run: the arrival order that used to re-run whole-run aggregation per span.

For each size it prints wall time, time per span, and how often whole-run
aggregation ran. Flat time per span across sizes means projection is linear
in trace size; time per span growing with size means it is quadratic.

No server, no network, no model calls: synthetic spans only.

Usage (the backend's environment provides the imports):

    cd backend && uv run python ../scripts/loadtest/projection_aggregation_cost.py
    cd backend && uv run python ../scripts/loadtest/projection_aggregation_cost.py --sizes 250 1000 4000
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent.parent / "backend"
MAX_SPANS_PER_REQUEST = 2048
BASE_NANOS = 1_791_907_200_000_000_000
PROJECT = "aggregation-cost"


def main() -> None:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--sizes", type=int, nargs="+", default=[200, 400, 800, 1600])
    args = parser.parse_args()

    # The backend package is imported from its source tree, not installed.
    sys.path.insert(0, str(BACKEND))
    with tempfile.TemporaryDirectory(prefix="apo-aggregation-cost-") as tmp:
        # apo.db reads DATABASE_URL at import time, so it is set first.
        os.environ["DATABASE_URL"] = f"sqlite:///{Path(tmp) / 'bench.db'}"
        rows = [_measure(size, index) for index, size in enumerate(args.sizes)]

    header = (
        f"{'spans':>6}  {'project s':>9}  {'ms/span':>8}  {'aggregations':>12}"
        f"  {'reproject s':>11}  {'ms/span':>8}  {'aggregations':>12}"
    )
    print(header)
    for row in rows:
        print(
            f"{row['spans']:>6}  {row['project_s']:>9.2f}  {row['project_ms']:>8.2f}"
            f"  {row['project_aggregations']:>12}  {row['reproject_s']:>11.2f}"
            f"  {row['reproject_ms']:>8.2f}  {row['reproject_aggregations']:>12}"
        )


def _measure(size: int, index: int) -> dict[str, float | int]:
    from sqlmodel import Session

    from apo.db import engine, init_db
    from apo.services import reproject, trace_projector
    from apo.services.otlp_receiver import OtlpReceiver
    from apo.services.trace_ingestion_queue import QueueWorker

    init_db()
    # Time the projection work, not the deliberate pauses between chunks.
    if hasattr(reproject, "REPROJECT_CHUNK_PAUSE_SECONDS"):
        reproject.REPROJECT_CHUNK_PAUSE_SECONDS = 0.0

    aggregations = _count_aggregations(trace_projector)
    trace_id = format(index + 1, "032x")
    spans = _trace(trace_id, size)
    receiver = OtlpReceiver()
    worker = QueueWorker(receiver=receiver)

    batch_ids: list[str] = []
    for start in range(0, len(spans), MAX_SPANS_PER_REQUEST):
        with Session(engine) as session:
            accepted = receiver.ingest(
                payload=_payload(spans[start : start + MAX_SPANS_PER_REQUEST]),
                content_type="application/json",
                project_id=PROJECT,
                session=session,
                project_immediately=False,
            )
        assert accepted.rejected == 0, accepted.errors[:3]
        batch_ids.append(accepted.batch_id)

    aggregations.clear()
    started = time.perf_counter()
    for batch_id in batch_ids:
        outcome = worker._process_batch(batch_id)  # noqa: SLF001 - the measured path
        assert outcome.rejected == 0, outcome.errors[:3]
    project_seconds = time.perf_counter() - started
    project_aggregations = len(aggregations)

    aggregations.clear()
    started = time.perf_counter()
    assert reproject.reproject_trace(trace_id, project_id=PROJECT) == size
    reproject_seconds = time.perf_counter() - started

    return {
        "spans": size,
        "project_s": project_seconds,
        "project_ms": project_seconds * 1000 / size,
        "project_aggregations": project_aggregations,
        "reproject_s": reproject_seconds,
        "reproject_ms": reproject_seconds * 1000 / size,
        "reproject_aggregations": len(aggregations),
    }


def _count_aggregations(trace_projector) -> list[str]:  # noqa: ANN001 - a module
    """Wrap whole-run aggregation so each run of it is recorded."""
    calls: list[str] = []
    original = getattr(trace_projector, "_apo_original_aggregates", None)
    if original is None:
        original = trace_projector._compute_run_aggregates  # noqa: SLF001
        trace_projector._apo_original_aggregates = original  # noqa: SLF001

    def counted(session, trace_id: str, project: str) -> None:  # noqa: ANN001
        calls.append(trace_id)
        original(session, trace_id, project)

    trace_projector._compute_run_aggregates = counted  # noqa: SLF001
    return calls


def _trace(trace_id: str, size: int) -> list[dict[str, object]]:
    """One completed root first, then ``size - 1`` costed generations."""
    root = "a" + format(1, "015x")
    spans: list[dict[str, object]] = [
        _span(trace_id, root, None, "agent run", 0, size * 10 + 1000, {
            "apo.observation.type": "AGENT",
        })
    ]
    for index in range(1, size):
        spans.append(
            _span(trace_id, "c" + format(index, "015x"), root, "chat bench-model",
                  index * 10, index * 10 + 8, {
                      "apo.observation.type": "GENERATION",
                      "gen_ai.request.model": "bench-model",
                      "gen_ai.usage.input_tokens": 100 + index % 7,
                      "gen_ai.usage.output_tokens": 20 + index % 5,
                      "apo.observation.cost.amount": 0.001,
                  })
        )
    return spans


def _span(
    trace_id: str,
    span_id: str,
    parent: str | None,
    name: str,
    start_ms: int,
    end_ms: int,
    attributes: dict[str, object],
) -> dict[str, object]:
    span: dict[str, object] = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "kind": 1,
        "startTimeUnixNano": str(BASE_NANOS + start_ms * 1_000_000),
        "endTimeUnixNano": str(BASE_NANOS + end_ms * 1_000_000),
        "attributes": [_attribute(key, value) for key, value in attributes.items()],
    }
    if parent is not None:
        span["parentSpanId"] = parent
    return span


def _attribute(key: str, value: object) -> dict[str, object]:
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    if isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    return {"key": key, "value": {"stringValue": str(value)}}


def _payload(spans: list[dict[str, object]]) -> bytes:
    return json.dumps(
        {"resourceSpans": [{"scopeSpans": [{"scope": {"name": "bench"}, "spans": spans}]}]}
    ).encode()


if __name__ == "__main__":
    main()
