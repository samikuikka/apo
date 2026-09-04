# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Benchmark for the projection read path.

``get_projection_snapshot`` is the public entry the dashboard's trace view
hits; it covers the per-call projection mapping (``_build_observation``),
call hydration, and capability derivation in one measured call.
"""

from pytest_codspeed import BenchmarkFixture
from sqlmodel import Session

from apo.services.trace_repository import NativeTraceRepository

from .conftest import BENCH_PROJECT, SPANS_PER_TRACE, bench_trace_id


def test_bench_get_slim_projection_snapshot(
    benchmark: BenchmarkFixture, bench_session: Session
) -> None:
    """One slim trace snapshot: canonical hydration + projection mapping.

    The benchmark identity starts with the slim-default architecture. The old
    default left hydration as a no-op and measured a materially different read
    path, so its historical timings are not a valid baseline for this work.
    """
    repo = NativeTraceRepository()
    snapshot = benchmark(
        repo.get_projection_snapshot,
        bench_session,
        project_id=BENCH_PROJECT,
        trace_id=bench_trace_id(0),
    )
    assert snapshot is not None
    assert len(snapshot.observations) == SPANS_PER_TRACE
