#!/usr/bin/env python3
# pyright: reportAny=false

"""Benchmark the serving-calls load step of the task-run list path.

Production evidence (2026-11-18, main docker stack): one
``GET /v1/agent-task-runs?task_id=...&limit=200`` request spent 1.45 s of
its 2.07 s materializing 5,783 ``LoggedCallDB`` SQLModel objects just to
compute per-run serving summaries, and four overlapping copies of that
request stalled the single worker's event loop for up to 2.5 s. This
script reproduces that shape on a synthetic database and compares the two
loading techniques on identical data, alternating within one process so
machine noise hits both sides equally:

- ``orm``    the pre-#636 technique: entity query with ``load_only`` of
  the serving columns.
- ``tuples`` what ships since #636 (``apo.services.serving.load_call_rows``):
  select the same columns as tuples and wrap them in a ``ServingCall``
  NamedTuple, no ORM machinery.

Both sides feed ``summarize_calls``; the outputs must be identical, and
the script fails if they are not. Run from ``backend/``:

    uv run python scripts/bench_serving_calls.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import cast

# Running the file by path puts scripts/ (not backend/) on sys.path, so the
# apo package would not resolve; the sibling scripts use the same bootstrap.
BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

import statistics
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timedelta, timezone

from sqlalchemy import select as sa_select
from sqlalchemy.orm import QueryableAttribute, load_only
from sqlmodel import Session, SQLModel, col, create_engine, select

from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB, LoggedCallDB
from apo.services.serving import (
    SERVING_COLUMNS,
    ServingCall,
    summarize_calls,
    to_serving_call,
)

PROJECT = "bench"
TASK_ID = "template/editing-content"
NUM_RUNS = 69
NUM_TRACED = 61
CALLS_PER_TRACE = 95  # 61 * 95 = 5,795, matching the production shape
RUNS_PER_SIDE = 7

PROVIDERS = ["openrouter", "baseten", "direct"]
ROUTES = ["openrouter/auto", "baseten/llama", None]
MODELS = ["deepseek/deepseek-v4.1-flash", "qwen/qwen3-coder", "gpt-5.2-mini"]

# Same column set load_call_rows selects, typed for the two load techniques.
COLUMNS = cast("tuple[QueryableAttribute[object], ...]", SERVING_COLUMNS)
COLUMN_NAMES = [column.key for column in COLUMNS]



def build_database(path: Path) -> None:
    engine = create_engine(f"sqlite:///{path}")
    # All model tables get created (untyped __table__ access aside, metadata
    # holds them); only the three below ever receive rows.
    SQLModel.metadata.create_all(engine)
    now = datetime.now(timezone.utc)
    batch = AgentTaskBatchRunDB(
        id="bench-batch",
        project=PROJECT,
        selection_type="all",
        status="completed",
        created_at=now,
    )
    with Session(engine) as session:
        session.add(batch)
        traced = 0
        for i in range(NUM_RUNS):
            trace_id = f"trace-{i:04d}" if traced < NUM_TRACED else None
            if trace_id:
                traced += 1
            session.add(
                AgentTaskRunDB(
                    id=f"run-{i:04d}",
                    batch_run_id=batch.id,
                    task_id=TASK_ID,
                    task_path=TASK_ID,
                    status="completed",
                    pass_result=i % 3 != 0,
                    started_at=now - timedelta(hours=NUM_RUNS - i),
                    completed_at=now - timedelta(hours=NUM_RUNS - i, minutes=-2),
                    trace_run_id=trace_id,
                    configured_model=MODELS[i % len(MODELS)],
                )
            )
            if not trace_id:
                continue
            for j in range(CALLS_PER_TRACE):
                is_generation = j % 4 == 0
                session.add(
                LoggedCallDB(
                    id=f"call-{i:04d}-{j:04d}",
                    project=PROJECT,
                    task_id=TASK_ID,
                    run_id=trace_id,
                    input={},
                    messages=[],
                    output={},
                    observation_type="GENERATION" if is_generation else "TOOL",
                        level="DEFAULT",
                        model=MODELS[j % len(MODELS)],
                        observed_model=MODELS[j % len(MODELS)],
                        api_provider=PROVIDERS[j % len(PROVIDERS)],
                        serving_host=PROVIDERS[j % len(PROVIDERS)],
                        route=ROUTES[j % len(ROUTES)],
                        service_tier="default" if j % 2 else None,
                        request_accounting="request" if is_generation else None,
                        created_at=now - timedelta(minutes=j),
                        end_time=now - timedelta(minutes=j, seconds=-1),
                        time_to_first_token_ms=120 + j,
                        completion_tokens=64 + j,
                    output_token_scope="completion" if is_generation else None,
                    cost=j % 17,
                        pricing_quality="reported" if is_generation else None,
                    )
                )
        session.commit()
    engine.dispose()


def load_orm_entities(session: Session, trace_ids: Sequence[str]) -> dict[str, list[LoggedCallDB]]:
    """The pre-#636 technique: ORM entities with load_only."""
    rows = session.exec(
        select(LoggedCallDB)
        .options(load_only(*COLUMNS, raiseload=True))
        .where(
            col(LoggedCallDB.run_id).in_(list(trace_ids)),
            col(LoggedCallDB.project) == PROJECT,
        )
    ).all()
    grouped: dict[str, list[LoggedCallDB]] = {}
    for row in rows:
        if row.run_id is not None:
            grouped.setdefault(row.run_id, []).append(row)
    return grouped


def load_tuples(session: Session, trace_ids: Sequence[str]) -> dict[str, list[ServingCall]]:
    """What load_call_rows ships: plain tuples wrapped in a NamedTuple."""
    rows = session.execute(  # pyright: ignore[reportDeprecated]
        sa_select(*COLUMNS).where(
            col(LoggedCallDB.run_id).in_(list(trace_ids)),
            col(LoggedCallDB.project) == PROJECT,
        )
    ).all()
    grouped: dict[str, list[ServingCall]] = {}
    for row in rows:
        call = ServingCall(**dict(zip(COLUMN_NAMES, row, strict=True)))
        if call.run_id is not None:
            grouped.setdefault(call.run_id, []).append(call)
    return grouped


def median_ms(samples: list[float]) -> float:
    return statistics.median(samples) * 1000.0


def time_side(
    fn: Callable[[], Mapping[str, Sequence[object]]],
    samples: list[float],
    errors: list[str],
) -> None:
    start = time.perf_counter()
    try:
        result = fn()
        if sum(len(v) for v in result.values()) == 0:
            errors.append("empty result")
    except Exception as exc:  # noqa: BLE001 - counted, surfaces in the report
        errors.append(repr(exc))
    samples.append(time.perf_counter() - start)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="apo-bench-") as tmp:
        db_path = Path(tmp) / "bench.db"
        build_database(db_path)
        engine = create_engine(f"sqlite:///{db_path}")
        with Session(engine) as session:
            trace_ids = [
                trace_id
                for trace_id in session.exec(
                    select(AgentTaskRunDB.trace_run_id).where(
                        col(AgentTaskRunDB.task_id) == TASK_ID
                    )
                ).all()
                if trace_id
            ]
            call_count = session.exec(
                select(col(LoggedCallDB.id)).where(col(LoggedCallDB.project) == PROJECT)
            ).all()
            print(f"dataset: {len(trace_ids)} traces, {len(call_count)} call rows")

            errors: list[str] = []
            orm_samples: list[float] = []
            tuple_samples: list[float] = []
            for _ in range(RUNS_PER_SIDE):
                time_side(lambda: load_orm_entities(session, trace_ids), orm_samples, errors)
                time_side(lambda: load_tuples(session, trace_ids), tuple_samples, errors)

            orm_grouped = load_orm_entities(session, trace_ids)
            tuple_grouped = load_tuples(session, trace_ids)
            for trace_id, calls in orm_grouped.items():
                left = summarize_calls([to_serving_call(call) for call in calls])
                right = summarize_calls(tuple_grouped.get(trace_id, []))
                if left != right:
                    errors.append(f"summary mismatch for {trace_id}")

            print(f"errors: {len(errors)}")
            for error in errors[:5]:
                print(f"  {error}")
            print(
                f"orm entities: median {median_ms(orm_samples):.0f} ms, range {min(orm_samples) * 1000:.0f}-{max(orm_samples) * 1000:.0f} ms"
            )
            print(
                f"tuples:       median {median_ms(tuple_samples):.0f} ms, range {min(tuple_samples) * 1000:.0f}-{max(tuple_samples) * 1000:.0f} ms"
            )
        engine.dispose()


if __name__ == "__main__":
    main()
