# pyright: reportAny=false, reportExplicitAny=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportUntypedBaseClass=false, reportCallIssue=false, reportPrivateUsage=false, reportUnusedFunction=false, reportDeprecated=false

"""Serving identity projection, preserve-cost replay, and metadata backfill.

The canonical projector must persist the extracted serving identity onto
``LoggedCallDB`` for both ingestion orders (wrapper-first and child-first),
a preserve-cost reprojection must leave stored prices byte-identical while
refreshing identity, and the backfill entry point must page by trace key
and be idempotent.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select, text

from apo.db import engine, init_db
from apo.models.db import LoggedCallDB, OtlpSpanDB
from apo.services.trace_projector import get_trace_projector
from apo.services.reproject import reproject_trace
from apo.services.serving_backfill import backfill_serving_identity

_PROJECT = "serving-proj"
_TRACE = "9999aaaaaaaaaaaa9999aaaaaaaaaaaa"
_WRAPPER = "1234567890abcdef"
_CHILD = "abcdef1234567890"


@pytest.fixture(autouse=True)
def _database():
    init_db()
    yield
    with Session(engine) as session:
        for table in ("logged_calls", "runs", "otlp_spans"):
            session.execute(text(f"DELETE FROM {table}"))
        session.commit()


def _span(
    span_id: str,
    name: str,
    attrs: dict[str, object],
    parent: str | None = None,
    start: str = "2026-01-01T00:00:00Z",
    end: str = "2026-01-01T00:00:02Z",
) -> OtlpSpanDB:
    return OtlpSpanDB(
        project_id=_PROJECT,
        trace_id=_TRACE,
        span_id=span_id,
        parent_span_id=parent,
        span_name=name,
        attributes=dict(attrs),  # type: ignore[arg-type]
        resource={},
        start_time=datetime.fromisoformat(start.replace("Z", "+00:00")),
        end_time=datetime.fromisoformat(end.replace("Z", "+00:00")),
    )


def _wrapper_attrs() -> dict[str, object]:
    return {
        "ai.model.id": "deepseek/deepseek-v4.1-flash",
        "ai.operation.name": "streamText",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 90,
    }


def _child_attrs() -> dict[str, object]:
    return {
        "ai.model.id": "deepseek/deepseek-v4.1-flash",
        "ai.operation.name": "streamText.doStream",
        "apo.llm.api_provider": "openrouter",
        "apo.llm.serving_host": "baseten",
        "apo.llm.request_kind": "request",
        "apo.llm.first_content_offset_ms": 250.0,
        "apo.llm.output_token_scope": "text",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 90,
    }


def _call(session: Session, span_id: str) -> LoggedCallDB:
    call = session.exec(
        select(LoggedCallDB).where(
            LoggedCallDB.id == span_id, LoggedCallDB.project == _PROJECT
        )
    ).first()
    assert call is not None
    return call


class TestProjectionWiring:
    def test_gateway_generation_carries_identity(self) -> None:
        projector = get_trace_projector()
        span = _span(
            "1111111111111111",
            "chat openrouter",
            {
                "gen_ai.operation.name": "chat",
                "gen_ai.request.model": "deepseek/deepseek-v4.1-flash:nitro",
                "gen_ai.response.model": "deepseek/deepseek-v4.1-flash",
                "apo.llm.api_provider": "openrouter",
                "apo.llm.serving_host": "baseten",
                "apo.llm.route": "openrouter:nitro->baseten",
                "apo.llm.first_content_offset_ms": 500.0,
            },
        )
        with Session(engine) as session:
            session.add(span)
            session.commit()
            projector.project(span, session)
            session.commit()
            call = _call(session, "1111111111111111")

        assert call.api_provider == "openrouter"
        assert call.serving_host == "baseten"
        assert call.route == "openrouter:nitro->baseten"
        assert call.request_model == "deepseek/deepseek-v4.1-flash:nitro"
        assert call.response_model == "deepseek/deepseek-v4.1-flash"
        assert call.observed_model == "deepseek/deepseek-v4.1-flash"
        assert call.request_accounting == "request"
        assert call.time_to_first_token_ms == 500.0
        assert call.serving_evidence is not None
        assert call.serving_evidence["api_provider"]["source"] == "apo.llm.api_provider"

    @pytest.mark.parametrize("order", ["wrapper-first", "child-first"])
    def test_vercel_wrapper_and_child_both_kept_one_level_each(self, order: str) -> None:
        projector = get_trace_projector()
        wrapper = _span(_WRAPPER, "ai.streamText", _wrapper_attrs())
        child = _span(
            _CHILD,
            "ai.streamText.doStream",
            _child_attrs(),
            parent=_WRAPPER,
            start="2026-01-01T00:00:00Z",
            end="2026-01-01T00:00:01Z",
        )
        spans = [wrapper, child] if order == "wrapper-first" else [child, wrapper]
        with Session(engine) as session:
            for span in spans:
                session.add(span)
            session.commit()
            for span in spans:
                projector.project(span, session)
            session.commit()

            wrapper_call = _call(session, _WRAPPER)
            child_call = _call(session, _CHILD)

        # The wrapper is the aggregate: navigable, keeps its usage, is not a
        # physical request. The child carries the request evidence.
        assert wrapper_call.request_accounting == "aggregate"
        assert wrapper_call.observation_type == "GENERATION"
        assert child_call.request_accounting == "request"
        assert child_call.api_provider == "openrouter"
        assert child_call.serving_host == "baseten"
        assert child_call.observed_model == "deepseek/deepseek-v4.1-flash"
        assert child_call.time_to_first_token_ms == 250.0
        assert child_call.output_token_scope == "text"

    def test_unknown_identity_stays_null_not_guessed(self) -> None:
        projector = get_trace_projector()
        span = _span(
            "2222222222222222",
            "chat proxy",
            {
                "gen_ai.operation.name": "chat",
                "gen_ai.system": "openai",
                "gen_ai.request.model": "deepseek/deepseek-v4.1-flash",
            },
        )
        with Session(engine) as session:
            session.add(span)
            session.commit()
            projector.project(span, session)
            session.commit()
            call = _call(session, "2222222222222222")

        assert call.instrumentation_provider == "openai"
        assert call.api_provider is None
        assert call.serving_host is None
        assert call.observed_model == "deepseek/deepseek-v4.1-flash"


class TestPreserveCostReplay:
    def _project_with_cost(self, cost_override: float | None = None) -> int:
        projector = get_trace_projector()
        attrs: dict[str, object] = {
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": "deepseek/deepseek-v4.1-flash",
            "apo.llm.api_provider": "openrouter",
        }
        if cost_override is not None:
            attrs["apo.observation.cost.amount"] = cost_override
        span = _span("3333333333333333", "chat openrouter", attrs)
        with Session(engine) as session:
            session.add(span)
            session.commit()
            projector.project(span, session)
            session.commit()
            call = _call(session, "3333333333333333")
            return int(call.cost or 0)

    def test_preserve_mode_keeps_cost_and_refreshes_identity(self) -> None:
        cost_before = self._project_with_cost(cost_override=0.5)
        assert cost_before == 500_000

        with Session(engine) as session:
            span = session.exec(
                select(OtlpSpanDB).where(OtlpSpanDB.span_id == "3333333333333333")
            ).one()
            span.attributes = {
                "gen_ai.operation.name": "chat",
                "gen_ai.request.model": "deepseek/deepseek-v4.1-flash",
                "apo.llm.api_provider": "fireworks",
                "apo.llm.serving_host": "fireworks",
            }
            session.add(span)
            session.commit()

        count = reproject_trace(_TRACE, _PROJECT, cost_mode="preserve")
        assert count == 1

        with Session(engine) as session:
            call = _call(session, "3333333333333333")
            assert call.cost == cost_before
            assert call.provided_cost == cost_before
            assert call.cost_provenance == "provided"
            assert call.api_provider == "fireworks"
            assert call.serving_host == "fireworks"


class TestBackfill:
    def test_pages_by_trace_key_and_is_idempotent(self) -> None:
        projector = get_trace_projector()
        traces = [f"t{i:032x}" for i in range(3)]
        with Session(engine) as session:
            for index, trace_id in enumerate(traces):
                span = OtlpSpanDB(
                    project_id=_PROJECT,
                    trace_id=trace_id,
                    span_id=f"s{index:016x}",
                    span_name="chat openrouter",
                    attributes={
                        "gen_ai.operation.name": "chat",
                        "gen_ai.request.model": "deepseek/deepseek-v4.1-flash",
                        "apo.llm.api_provider": "openrouter",
                    },
                    resource={},
                    start_time=datetime(2026, 1, 1, tzinfo=timezone.utc),
                )
                session.add(span)
            session.commit()
            for index in range(3):
                span = session.exec(
                    select(OtlpSpanDB).where(OtlpSpanDB.span_id == f"s{index:016x}")
                ).one()
                projector.project(span, session)
            session.commit()

        first = backfill_serving_identity(_PROJECT, limit=2)
        assert first["traces_scanned"] == 2
        assert first["next_cursor"] == traces[1]
        assert first["observations_updated"] == 2

        second = backfill_serving_identity(
            _PROJECT, limit=2, after=str(first["next_cursor"])
        )
        assert second["traces_scanned"] == 1
        assert second["next_cursor"] is None

        third = backfill_serving_identity(_PROJECT, limit=10)
        assert third["traces_scanned"] == 3
        assert third["observations_updated"] == 3


class TestMigrationSmoke:
    def test_v65_columns_exist_and_default_null(self) -> None:
        with engine.begin() as conn:
            columns = {
                row[1]
                for row in conn.exec_driver_sql("PRAGMA table_info(logged_calls)")
            }
        for column in (
            "instrumentation_provider",
            "api_provider",
            "serving_host",
            "requested_service_tier",
            "service_tier",
            "request_model",
            "response_model",
            "observed_model",
            "serving_evidence",
            "request_accounting",
            "output_token_scope",
            "first_content_scope",
            "pricing_quality",
            "matched_serving",
        ):
            assert column in columns
