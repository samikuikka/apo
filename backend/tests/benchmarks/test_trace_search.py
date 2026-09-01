# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Benchmarks for the trace-search hot path.

The filter corpus is what the dashboard's trace search actually builds:
an attribute equality, a numeric comparison, a LIKE on attribute text,
and a negated op (each requires a span-level EXISTS over the run).
"""

import json

from pytest_codspeed import BenchmarkFixture
from sqlmodel import Session, col, select

from apo.models.db import RunDB
from apo.services.trace_search import (
    apply_trace_search,
    parse_span_filter,
    span_field_facets,
)

from .conftest import BENCH_PROJECT, STORE_TRACE_COUNT

RAW_SPAN_FILTER = json.dumps(
    [
        {"field": "attribute:customer.tier", "op": "eq", "value": "enterprise"},
        {"field": "attribute:http.response.status_code", "op": "gte", "value": 200},
        {"field": "attribute:db.statement", "op": "contains", "value": "SELECT"},
        {"field": "span_name", "op": "not_contains", "value": "healthcheck"},
    ]
)


def test_bench_parse_span_filter(benchmark: BenchmarkFixture) -> None:
    """parse_span_filter on a representative multi-predicate corpus."""
    predicates = benchmark(parse_span_filter, RAW_SPAN_FILTER)
    assert len(predicates) == 4


def test_bench_apply_trace_search(
    benchmark: BenchmarkFixture, bench_session: Session
) -> None:
    """Apply + execute the search the way ``GET /v1/runs`` does.

    The measured callable composes the two public calls — shaping the
    statement and running it — because the compiled query, not the AST
    append alone, is the cost a regression shows up in. Parsing and
    seeding stay outside the measured region.
    """
    predicates = parse_span_filter(RAW_SPAN_FILTER)

    def run_search() -> list[RunDB]:
        statement = apply_trace_search(
            select(RunDB).where(col(RunDB.project) == BENCH_PROJECT),
            service="apo-agent",
            predicates=predicates,
        )
        return list(bench_session.exec(statement).all())

    runs = benchmark(run_search)
    # Even traces are apo-agent with an enterprise-tier LLM span, and every
    # trace carries a tool span with a SELECT statement + status 200 — so
    # exactly half the seeded store matches the AND of the corpus.
    assert len(runs) == STORE_TRACE_COUNT // 2


def test_bench_span_field_facets(
    benchmark: BenchmarkFixture, bench_session: Session
) -> None:
    """span_field_facets: the full-project distinct-trace scan."""
    facets = benchmark(span_field_facets, bench_session, project=BENCH_PROJECT)
    assert len(facets["services"]) == 2
    assert len(facets["operations"]) == 3
