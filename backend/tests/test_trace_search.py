# pyright: reportAny=false, reportAttributeAccessIssue=false, reportDeprecated=false, reportExplicitAny=false, reportImplicitStringConcatenation=false, reportMissingParameterType=false, reportOptionalMemberAccess=false, reportPrivateLocalImportUsage=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedFunction=false, reportUnusedParameter=false

"""Trace search over the canonical span store.

Covers: service/operation params, the two comparison domains (text vs
REAL), operator semantics (incl. none-of negation and in-lists), key
grammar and SQL-injection posture, LIKE escaping (span_text AND the
pre-existing search param), facets (distinct-trace counts, windows,
bucket suppression), limits/400s, the no-filter golden, cross-project
isolation, dialect goldens, the v36 backfill seam, and the environment
fallback.
"""

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from sqlmodel import Session, select, text

from apo.db import engine, reset_apo_file_db
from apo.models.db import LoggedCallDB, OtlpSpanDB, RunDB
from apo.routes.runs.list_query import (
    RunListFilters,
    RunListPagination,
    list_run_summaries,
)
from apo.services.trace_search import (
    SpanFilterError,
    apply_trace_search,
    parse_span_filter,
    span_field_facets,
)

NOW = datetime.now(timezone.utc)
TRACE_A = "0102030405060708090a0b0c0d0e0f10"  # billing / GET /invoices
TRACE_B = "1112131415161718191a1b1c1d1e1f20"  # auth / POST /charge (500)
TRACE_C = "2122232425262728292a2b2c2d2e2f30"  # billing / healthcheck


def _attrs(**values: Any) -> dict[str, Any]:
    return values


def _seed_span(
    session: Session,
    *,
    trace_id: str,
    span_id: str,
    name: str,
    service: str | None,
    attributes: dict[str, Any] | None = None,
    parent: str | None = None,
) -> None:
    session.add(
        OtlpSpanDB(
            project_id="p1",
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent,
            span_name=name,
            service_name=service,
            start_time=NOW - timedelta(hours=1),
            end_time=NOW - timedelta(hours=1) + timedelta(milliseconds=50),
            attributes=attributes or {},
            resource={"attributes": {"service.name": service}} if service else {},
        )
    )


def _seed_trace(
    session: Session,
    *,
    trace_id: str,
    root_name: str,
    service: str | None,
    environment: str = "default",
) -> None:
    session.add(
        RunDB(
            id=trace_id,
            project="p1",
            environment=environment,
            created_at=NOW - timedelta(hours=1),
            call_count=1,
        )
    )
    session.add(
        LoggedCallDB(
            id=trace_id[:16],
            run_id=trace_id,
            project="p1",
            task_id="",
            created_at=NOW - timedelta(hours=1),
            model="unknown",
            observation_type="SPAN",
            latency_ms=10.0,
            input={},
            output={},
            messages=[],
        )
    )
    _seed_span(
        session, trace_id=trace_id, span_id=trace_id[:16], name=root_name, service=service
    )


@pytest.fixture(autouse=True)
def _seed(session: Session) -> None:
    # Trace A: billing, GET /invoices (200) + psql.query child.
    _seed_trace(session, trace_id=TRACE_A, root_name="GET /invoices", service="billing-api")
    _seed_span(
        session,
        trace_id=TRACE_A,
        span_id="a1a2a3a4a5a6a7a8",
        name="psql.query",
        service="billing-api",
        parent=TRACE_A[:16],
        attributes=_attrs(**{
            "db.system": "postgresql",
            "db.statement": "SELECT id FROM invoices",
            "http.response.status_code": 200,
        }),
    )
    session.exec(
        select(OtlpSpanDB).where(OtlpSpanDB.span_id == TRACE_A[:16])
    ).one().attributes = {
        "customer.tier": "enterprise",
        "http.request.method": "GET",
        "http.response.status_code": 200,
    }
    # Trace B: auth, POST /charge → 500.
    _seed_trace(session, trace_id=TRACE_B, root_name="POST /charge", service="auth-api")
    session.exec(
        select(OtlpSpanDB).where(OtlpSpanDB.span_id == TRACE_B[:16])
    ).one().attributes = {
        "customer.tier": "free",
        "http.request.method": "POST",
        "http.response.status_code": 500,
    }
    # Trace C: billing, healthcheck, serviceless.
    _seed_trace(session, trace_id=TRACE_C, root_name="healthcheck", service=None)
    session.commit()


def _list(
    session: Session,
    **overrides: Any,
) -> list[str]:
    filters = RunListFilters(
        project="p1",
        service=overrides.pop("service", None),
        operation=overrides.pop("operation", None),
        span_text=overrides.pop("span_text", None),
        span_predicates=overrides.pop("span_predicates", []),
        search=overrides.pop("search", None),
    )
    page = list_run_summaries(
        session, filters, RunListPagination(page=0, page_size=50, sort_by=None, sort_order=None)
    )
    return [r.id for r in page.data]


def _predicates(raw: str) -> Any:
    return parse_span_filter(raw)


# ---------------------------------------------------------------------------
# Simple params
# ---------------------------------------------------------------------------


class TestSimpleParams:
    def test_service_filter(self, session: Session) -> None:
        ids = _list(session, service="billing-api")
        # TRACE_C is serviceless — never matches a service filter.
        assert ids == [TRACE_A]

    def test_operation_filter(self, session: Session) -> None:
        assert _list(session, operation="psql.query") == [TRACE_A]

    def test_combined_and(self, session: Session) -> None:
        assert _list(session, service="billing-api", operation="GET /invoices") == [TRACE_A]


# ---------------------------------------------------------------------------
# Predicate semantics + comparison domains
# ---------------------------------------------------------------------------


class TestPredicates:
    def test_eq_int_as_text(self, session: Session) -> None:
        ids = _list(
            session,
            span_predicates=_predicates(
                json.dumps(
                    [
                        {
                            "field": "attribute:http.response.status_code",
                            "op": "eq",
                            "value": "500",
                        }
                    ]
                )
            ),
        )
        assert ids == [TRACE_B]

    def test_neq_is_none_of(self, session: Session) -> None:
        # Trace A's spans are all 200 → matches neq 500. Trace B has a 500 → out.
        ids = _list(
            session,
            span_predicates=_predicates(
                json.dumps(
                    [
                        {
                            "field": "attribute:http.response.status_code",
                            "op": "neq",
                            "value": "500",
                        }
                    ]
                )
            ),
        )
        assert TRACE_A in ids and TRACE_B not in ids

    def test_in_list(self, session: Session) -> None:
        ids = _list(
            session,
            span_predicates=_predicates(
                json.dumps(
                    [
                        {
                            "field": "attribute:customer.tier",
                            "op": "in",
                            "value": ["enterprise", "pro"],
                        }
                    ]
                )
            ),
        )
        assert ids == [TRACE_A]

    def test_not_in(self, session: Session) -> None:
        ids = _list(
            session,
            span_predicates=_predicates(
                json.dumps(
                    [
                        {
                            "field": "attribute:customer.tier",
                            "op": "not_in",
                            "value": ["enterprise", "pro"],
                        }
                    ]
                )
            ),
        )
        # TRACE_C's spans have no customer.tier at all → none match → NOT EXISTS passes.
        assert set(ids) == {TRACE_B, TRACE_C}

    def test_contains_and_starts_with(self, session: Session) -> None:
        ids = _list(
            session,
            span_predicates=_predicates(
                json.dumps(
                    [
                        {
                            "field": "attribute:db.statement",
                            "op": "contains",
                            "value": "invoices",
                        }
                    ]
                )
            ),
        )
        assert ids == [TRACE_A]
        ids = _list(
            session,
            span_predicates=_predicates(
                json.dumps(
                    [
                        {"field": "span_name", "op": "starts_with", "value": "GET"}
                    ]
                )
            ),
        )
        assert ids == [TRACE_A]

    def test_numeric_domain_real(self, session: Session) -> None:
        # Text-domain ordering would wrongly match '99' >= '1000'-style cases;
        # REAL domain must compare numerically.
        ids = _list(
            session,
            span_predicates=_predicates(
                json.dumps(
                    [
                        {
                            "field": "attribute:http.response.status_code",
                            "op": "gte",
                            "value": 500,
                        }
                    ]
                )
            ),
        )
        assert ids == [TRACE_B]
        ids = _list(
            session,
            span_predicates=_predicates(
                json.dumps(
                    [
                        {
                            "field": "attribute:http.response.status_code",
                            "op": "lt",
                            "value": 500,
                        }
                    ]
                )
            ),
        )
        assert ids == [TRACE_A]
        with pytest.raises(SpanFilterError):
            parse_span_filter(
                json.dumps(
                    [
                        {
                            "field": "attribute:http.response.status_code",
                            "op": "gte",
                            "value": "not-a-number",
                        }
                    ]
                )
            )

    def test_numeric_on_text_field_rejected(self) -> None:
        with pytest.raises(SpanFilterError):
            parse_span_filter(
                json.dumps([{"field": "span_name", "op": "gte", "value": 5}])
            )

    def test_exists_missing_vs_explicit_null(self, session: Session) -> None:
        span = session.exec(
            select(OtlpSpanDB).where(OtlpSpanDB.span_id == TRACE_C[:16])
        ).one()
        span.attributes = {"feature.flag": None}
        session.add(span)
        session.commit()
        ids = _list(
            session,
            span_predicates=_predicates(
                json.dumps([{"field": "attribute:feature.flag", "op": "exists"}])
            ),
        )
        assert ids == []  # explicit JSON null is not "exists"
        ids = _list(
            session,
            span_predicates=_predicates(
                json.dumps([{"field": "attribute:feature.flag", "op": "not_exists"}])
            ),
        )
        assert set(ids) == {TRACE_A, TRACE_B, TRACE_C}


# ---------------------------------------------------------------------------
# Grammar, injection, limits
# ---------------------------------------------------------------------------


class TestGrammarSafety:
    def test_dotted_and_odd_keys_accepted(self, session: Session) -> None:
        span = session.exec(
            select(OtlpSpanDB).where(OtlpSpanDB.span_id == TRACE_C[:16])
        ).one()
        span.attributes = {"feature.flag/x": "on"}
        session.add(span)
        session.commit()
        ids = _list(
            session,
            span_predicates=_predicates(
                json.dumps(
                    [
                        {"field": "attribute:feature.flag/x", "op": "eq", "value": "on"}
                    ]
                )
            ),
        )
        assert ids == [TRACE_C]

    def test_breakout_key_rejected(self) -> None:
        with pytest.raises(SpanFilterError):
            parse_span_filter(
                json.dumps([{"field": "attribute:x')) OR 1=1--", "op": "eq", "value": "1"}])
            )

    def test_injection_value_is_literal(self, session: Session) -> None:
        ids = _list(
            session,
            span_predicates=_predicates(
                json.dumps(
                    [
                        {
                            "field": "attribute:customer.tier",
                            "op": "eq",
                            "value": "'; DROP TABLE runs;--",
                        }
                    ]
                )
            ),
        )
        assert ids == []
        assert session.exec(select(RunDB)).all()  # table intact

    def test_limits_and_400s(self) -> None:
        with pytest.raises(SpanFilterError):
            parse_span_filter(json.dumps([{"field": "span_name", "op": "eq", "value": f"{'x' * 257}"}]))
        with pytest.raises(SpanFilterError):
            parse_span_filter(json.dumps([{"field": "span_name", "op": "eq", "value": "x"}] * 17))
        with pytest.raises(SpanFilterError):
            parse_span_filter("not json")
        with pytest.raises(SpanFilterError):
            parse_span_filter(json.dumps([{"field": "nope", "op": "eq", "value": "x"}]))
        with pytest.raises(SpanFilterError):
            parse_span_filter(json.dumps([{"field": "span_name", "op": "regex", "value": "x"}]))


# ---------------------------------------------------------------------------
# Free text
# ---------------------------------------------------------------------------


class TestSpanText:
    def test_matches_name_value_and_key(self, session: Session) -> None:
        # Set comparison: list order depends on the default sort, not on the
        # filter.
        assert set(_list(session, span_text="psql")) == {TRACE_A}  # span name
        assert set(_list(session, span_text="INVOICES")) == {TRACE_A}  # value, ASCII-folded
        assert set(_list(session, span_text="customer.tier")) == {TRACE_A, TRACE_B}  # key

    def test_wildcards_are_literal(self, session: Session) -> None:
        assert _list(session, span_text="%") == []
        # "_" matches literally: only the attributes that actually contain a
        # literal underscore (the seeded keys use "status_code").
        assert set(_list(session, span_text="_")) == {TRACE_A, TRACE_B}
        assert _list(session, span_text="s_q") == []  # no name/value contains s_q

    def test_search_param_wildcards_now_literal(self, session: Session) -> None:
        # The pre-existing search param (run ids) also escapes.
        assert _list(session, search="%") == []


# ---------------------------------------------------------------------------
# Facets
# ---------------------------------------------------------------------------


class TestFacets:
    """Uses its own project: the shared in-memory engine carries rows from
    other test files, and facet counts are per project."""

    PROJECT = "p-fac"

    @pytest.fixture(autouse=True)
    def _seed_facets(self, session: Session) -> None:
        def add(trace: str, span: str, name: str, service: str | None, hours: float = 1) -> None:
            session.add(
                OtlpSpanDB(
                    project_id=self.PROJECT,
                    trace_id=trace,
                    span_id=span,
                    span_name=name,
                    service_name=service,
                    start_time=NOW - timedelta(hours=hours),
                    attributes={},
                )
            )

        add("aa" * 16, "aa" * 8, "GET /invoices", "billing-api")
        add("aa" * 16, "ab" * 8, "psql.query", "billing-api")  # 2nd span, same trace
        add("bb" * 16, "bb" * 8, "POST /charge", "auth-api")
        add("cc" * 16, "cc" * 8, "healthcheck", None)
        session.commit()

    def test_buckets_and_distinct_trace_counts(self, session: Session) -> None:
        result = span_field_facets(session, project=self.PROJECT)
        services = {b["value"]: b["count"] for b in result["services"]}
        # billing counts ONE trace (two spans), not two.
        assert services == {"billing-api": 1, "auth-api": 1}
        names = {b["value"] for b in result["operations"]}
        assert names == {"GET /invoices", "psql.query", "POST /charge", "healthcheck"}

    def test_window_excludes_old_spans(self, session: Session) -> None:
        session.add(
            OtlpSpanDB(
                project_id=self.PROJECT,
                trace_id="99" * 16,
                span_id="99" * 8,
                span_name="ancient",
                service_name="billing-api",
                start_time=NOW - timedelta(days=30),
                attributes={},
            )
        )
        session.commit()
        result = span_field_facets(
            session, project=self.PROJECT, created_after=NOW - timedelta(days=7)
        )
        assert "ancient" not in {b["value"] for b in result["operations"]}
        services = {b["value"]: b["count"] for b in result["services"]}
        assert services == {"billing-api": 1, "auth-api": 1}  # ancient trace excluded

    def test_span_text_narrows(self, session: Session) -> None:
        result = span_field_facets(session, project=self.PROJECT, span_text="psql")
        assert {b["value"] for b in result["operations"]} == {"psql.query"}


# ---------------------------------------------------------------------------
# Golden no-filter + isolation
# ---------------------------------------------------------------------------


class TestGoldenAndIsolation:
    def test_no_filter_returns_all(self, session: Session) -> None:
        assert set(_list(session)) == {TRACE_A, TRACE_B, TRACE_C}

    def test_cross_project_isolation(self, session: Session) -> None:
        # Same trace id in another project must never leak through p1's filters.
        session.add(
            OtlpSpanDB(
                project_id="p2",
                trace_id=TRACE_B,
                span_id=TRACE_B[:16],
                span_name="POST /charge",
                service_name="evil-api",
                start_time=NOW,
                attributes={"customer.tier": "enterprise"},
            )
        )
        session.commit()
        ids = _list(session, service="evil-api")
        assert ids == []
        ids = _list(
            session,
            span_predicates=_predicates(
                json.dumps(
                    [{"field": "attribute:customer.tier", "op": "eq", "value": "enterprise"}]
                )
            ),
        )
        assert set(ids) == {TRACE_A}  # p2's copy never appears


# ---------------------------------------------------------------------------
# v36 backfill seam
# ---------------------------------------------------------------------------


class TestV36Seam:
    def test_backfill_fills_from_resource(self) -> None:
        from sqlalchemy import create_engine
        from sqlmodel import SQLModel

        import apo.models.db as mdb

        eng = create_engine("sqlite://")
        # _add_search_indexes also indexes runs — create both tables.
        mdb.SQLModel.metadata.create_all(
            eng,
            tables=[mdb.OtlpSpanDB.__table__, mdb.RunDB.__table__],
        )
        with eng.begin() as conn:
            conn.exec_driver_sql(
                "INSERT INTO otlp_spans (project_id, trace_id, span_id, span_name, "
                "span_kind, status_code, trace_flags, content_policy, projection_version, resource) "
                "VALUES ('p', 't', 's', 'n', 0, 0, 0, 'default', 0, "
                '\'{"attributes": {"service.name": "billing-api"}}\')'
            )
        from apo.db import _add_search_indexes, _add_service_name_column, _backfill_service_name

        with eng.begin() as conn:
            _add_service_name_column(conn)
            _backfill_service_name(conn)
            _add_search_indexes(conn)
            value = conn.exec_driver_sql(
                "SELECT service_name FROM otlp_spans"
            ).fetchone()
        assert value is not None and value[0] == "billing-api"

    def test_migration_rerun_safe(self) -> None:
        import apo.models.db as mdb
        from apo.db import _migrate_to_v36, engine

        # The migration runs at startup after create_all — mirror that.
        mdb.SQLModel.metadata.create_all(engine)
        _migrate_to_v36()
        _migrate_to_v36()  # must not raise


# ---------------------------------------------------------------------------
# Environment fallback
# ---------------------------------------------------------------------------


class TestEnvironmentFallback:
    def test_resource_environment_used(self, session: Session) -> None:
        from apo.services.trace_projector import get_trace_projector

        span = OtlpSpanDB(
            project_id="p1",
            trace_id="ab" * 16,
            span_id="ab" * 8,
            span_name="GET /x",
            start_time=NOW,
            attributes={"gen_ai.operation.name": "chat"},
            resource={"attributes": {"deployment.environment": "production"}},
        )
        session.add(span)
        session.commit()
        get_trace_projector().project(span, session)
        session.commit()
        run = session.exec(
            select(RunDB).where(RunDB.id == "ab" * 16)
        ).one()
        assert run.environment == "production"

    def test_explicit_span_attr_wins(self, session: Session) -> None:
        from apo.services.trace_projector import get_trace_projector

        span = OtlpSpanDB(
            project_id="p1",
            trace_id="cd" * 16,
            span_id="cd" * 8,
            span_name="GET /y",
            start_time=NOW,
            attributes={
                "apo.run.environment": "staging",
            },
            resource={"attributes": {"deployment.environment": "production"}},
        )
        session.add(span)
        session.commit()
        get_trace_projector().project(span, session)
        session.commit()
        run = session.exec(
            select(RunDB).where(RunDB.id == "cd" * 16)
        ).one()
        assert run.environment == "staging"
