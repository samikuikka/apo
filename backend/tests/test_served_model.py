# pyright: reportAny=false, reportDeprecated=false, reportExplicitAny=false, reportUnusedImport=false, reportUnusedCallResult=false, reportPrivateUsage=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportInvalidTypeForm=false

"""Served-model tracking: requested vs the model that actually served.

A gateway fallback (LiteLLM router, OpenRouter provider/model fallback) can
serve a different model than the one requested. Covers the vertical:
attribute extraction (``gen_ai.response.model`` / ``ai.response.model`` /
``llm.response.model_name``), projection onto ``logged_calls.served_model``,
pricing off the served model, the pair rollup splitting on it, and the
drift summary the run detail surfaces (judge calls excluded).
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone
from typing import Any

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy.engine import Engine
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, col, create_engine, select, text

import apo.db as apo_db
from apo.db import engine, init_db
from apo.models.db import LoggedCallDB, OtlpSpanDB, RunDB
from apo.services.otel_normalization import normalize_span
from apo.services.otel_normalization._shared import extract_served_model
from apo.services.pricing.apply import apply_cost_to_call
from apo.services.pricing.compute import compute_cost
from apo.services.pricing.loader import load_default_prices
from apo.services.trace_backend import model_drift_summary, model_providers_summary
from apo.services.trace_projector import TraceProjector

NOW = datetime(2026, 10, 1, tzinfo=timezone.utc)


def _span(
    *,
    span_id: str = "span-1",
    project_id: str = "test-project",
    attributes: dict[str, object] | None = None,
) -> OtlpSpanDB:
    return OtlpSpanDB(
        project_id=project_id,
        trace_id="trace-1",
        span_id=span_id,
        span_name="chat",
        attributes=attributes or {},
        start_time=NOW,
        end_time=NOW.replace(second=2),
        resource={},
    )


def _call(**overrides: Any) -> LoggedCallDB:
    """A GENERATION shell for the pure helpers."""
    base: dict[str, Any] = {
        "id": "call-1",
        "run_id": "trace-1",
        "project": "p",
        "task_id": "",
        "created_at": NOW,
        "model": "my-alias",
        "observation_type": "GENERATION",
    }
    base.update(overrides)
    return LoggedCallDB(**base)  # type: ignore[arg-type]


class TestExtraction:
    def test_gen_ai_response_model_wins(self) -> None:
        assert (
            extract_served_model(
                {
                    "gen_ai.request.model": "my-alias",
                    "gen_ai.response.model": "openai/gpt-4o-mini",
                }
            )
            == "openai/gpt-4o-mini"
        )

    def test_ai_response_model_is_the_vercel_fallback(self) -> None:
        assert (
            extract_served_model({"ai.response.model": "deepseek-v4.1-flash"})
            == "deepseek-v4.1-flash"
        )

    def test_openinference_response_model_name(self) -> None:
        assert (
            extract_served_model({"llm.response.model_name": "claude-opus-5"})
            == "claude-opus-5"
        )

    def test_no_response_model_means_none(self) -> None:
        assert extract_served_model({"gen_ai.request.model": "my-alias"}) is None
        assert extract_served_model({}) is None

    def test_normalize_span_carries_served_model(self) -> None:
        normalized = normalize_span(
            _span(
                attributes={
                    "gen_ai.request.model": "my-alias",
                    "gen_ai.response.model": "openai/gpt-4o-mini",
                    "gen_ai.usage.input_tokens": 10,
                    "gen_ai.usage.output_tokens": 20,
                }
            )
        )
        assert normalized.model == "my-alias"
        assert normalized.served_model == "openai/gpt-4o-mini"


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    yield
    with Session(engine) as session:
        for table in ("run_metrics", "logged_calls", "runs", "otlp_spans"):
            session.execute(text(f"DELETE FROM {table}"))
        session.commit()


class TestProjection:
    def test_served_model_persisted_requested_preserved(self) -> None:
        span = _span(
            attributes={
                "gen_ai.request.model": "my-alias",
                "gen_ai.response.model": "openai/gpt-4o-mini",
                "gen_ai.usage.input_tokens": 10,
                "gen_ai.usage.output_tokens": 20,
            }
        )
        with Session(engine) as session:
            TraceProjector().project(span, session)
            session.commit()
            call = session.exec(select(LoggedCallDB)).one()
            assert call.model == "my-alias"
            assert call.served_model == "openai/gpt-4o-mini"

    def test_reprojection_keeps_served_model(self) -> None:
        with Session(engine) as session:
            TraceProjector().project(
                _span(
                    attributes={
                        "gen_ai.request.model": "my-alias",
                        "gen_ai.response.model": "openai/gpt-4o-mini",
                    }
                ),
                session,
            )
            session.commit()
            TraceProjector().project(
                _span(attributes={"gen_ai.request.model": "my-alias"}),
                session,
            )
            session.commit()
            call = session.exec(select(LoggedCallDB)).one()
            assert call.served_model == "openai/gpt-4o-mini"

    def test_rollup_splits_pairs_on_served_model(self) -> None:
        summary = model_providers_summary(
            [
                _call(id="a", served_model=None),
                _call(id="b", served_model="openai/gpt-4o-mini"),
            ]
        )
        assert summary is not None
        pairs = summary["pairs"]
        assert isinstance(pairs, list)
        assert {(p["model"], p["calls"]) for p in pairs} == {  # type: ignore[index]
            ("my-alias", 1),
            ("openai/gpt-4o-mini", 1),
        }


class TestPricing:
    @pytest.fixture
    def session(self) -> Iterator[Session]:
        eng = create_engine("sqlite://")
        SQLModel.metadata.create_all(eng)
        sess = Session(eng)
        load_default_prices(sess)
        yield sess
        sess.close()

    def test_cost_computed_off_served_model_not_alias(self, session: Session) -> None:
        # Request gpt-4o, a gateway falls back to gpt-4o-mini: the billable
        # identity is the model that served, not the alias that was sent.
        call = _call(
            id="fb",
            project="default",
            model="gpt-4o",
            served_model="gpt-4o-mini",
        )
        session.add(call)
        session.commit()
        apply_cost_to_call(
            session,
            call,
            attributes={
                "gen_ai.usage.input_tokens": 1_000_000,
                "gen_ai.usage.output_tokens": 1_000_000,
            },
            project="default",
            at_time=NOW,
        )
        expected = compute_cost(
            session,
            "gpt-4o-mini",
            {"input": 1_000_000, "output": 1_000_000},
            "default",
            NOW,
        )
        alias = compute_cost(
            session,
            "gpt-4o",
            {"input": 1_000_000, "output": 1_000_000},
            "default",
            NOW,
        )
        assert expected is not None and alias is not None
        assert expected.total != alias.total
        assert call.cost == expected.total


class TestDriftSummary:
    def test_none_without_configuration(self) -> None:
        assert model_drift_summary([_call(served_model="other-model")], None) is None
        assert model_drift_summary([_call(served_model="other-model")], "") is None

    def test_none_when_served_matches_configured(self) -> None:
        assert (
            model_drift_summary(
                [
                    _call(id="a", served_model="my-alias"),
                    _call(id="b", served_model=None),
                ],
                "my-alias",
            )
            is None
        )

    def test_judge_generations_excluded(self) -> None:
        # The judge is expected to run on its own model — its generations
        # must not read as the agent drifting.
        summary = model_drift_summary(
            [
                _call(id="agent", step_name="agent.generate", served_model="my-alias"),
                _call(
                    id="judge",
                    step_name="judge:answers-question",
                    model="judge-model",
                    served_model="judge-model",
                ),
            ],
            "my-alias",
        )
        assert summary is None

    def test_agentic_judge_sessions_excluded(self) -> None:
        # Agentic judges run as t.agent:<check> sessions (JUDGE_STEP_PREFIXES
        # carries both shapes) — a cascade judge on its own model is not the
        # agent under test drifting.
        summary = model_drift_summary(
            [
                _call(id="agent", step_name="agent.generate", served_model="my-alias"),
                _call(
                    id="agentic-judge",
                    step_name="t.agent:cascade-verdict",
                    model="judge-model",
                    served_model="judge-model",
                ),
            ],
            "my-alias",
        )
        assert summary is None

    def test_drift_pairs_aggregate_and_count(self) -> None:
        summary = model_drift_summary(
            [
                _call(id="a", served_model="my-alias"),
                _call(id="b", served_model="openai/gpt-4o-mini", cost=100, total_tokens=10),
                _call(id="c", served_model="openai/gpt-4o-mini", cost=50, total_tokens=20),
                _call(
                    id="d",
                    served_model="openai/gpt-4o-mini",
                    provider="litellm",
                    cost=25,
                ),
                # Judge generation: excluded from the agent total too.
                _call(
                    id="j",
                    step_name="judge:tone",
                    model="judge-model",
                    served_model="judge-model",
                ),
            ],
            "my-alias",
        )
        assert summary is not None
        assert summary.configured_model == "my-alias"
        assert summary.total_agent_generations == 4
        # Same served model on two hosts = two pairs, aggregated per host.
        unqualified = next(
            (p for p in summary.pairs if p.provider is None), None
        )
        assert unqualified is not None
        assert unqualified.model == "openai/gpt-4o-mini"
        assert unqualified.calls == 2
        assert unqualified.cost_micro == 150
        assert unqualified.total_tokens == 30
        qualified = next(
            (p for p in summary.pairs if p.provider == "litellm"), None
        )
        assert qualified is not None
        assert qualified.calls == 1
        assert qualified.cost_micro == 25


class TestV57Backfill:
    def _pre_v57_engine(self) -> Engine:
        test_engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        SQLModel.metadata.create_all(test_engine)
        return test_engine

    @staticmethod
    def _drop_served_model(test_engine: Engine) -> None:
        # Recreate a pre-v57 logged_calls: the migration must re-add the
        # column itself, not rely on create_all having shipped it.
        with test_engine.begin() as conn:
            conn.execute(text("ALTER TABLE logged_calls DROP COLUMN served_model"))

    def test_backfills_from_span_attributes(self, monkeypatch: MonkeyPatch) -> None:
        test_engine = self._pre_v57_engine()
        with Session(test_engine) as session:
            session.add(_call(id="span-1", project="p1"))
            session.add(_call(id="span-2", project="p1"))
            session.add(_call(id="elsewhere", project="p2"))
            session.add(
                _span(
                    span_id="span-1",
                    project_id="p1",
                    attributes={
                        "gen_ai.request.model": "alias",
                        "gen_ai.response.model": "openai/gpt-4o-mini",
                    },
                )
            )
            # No response model on the span: the call keeps NULL ("provider
            # did not report"), never a guess.
            session.add(
                _span(
                    span_id="span-2",
                    project_id="p1",
                    attributes={"gen_ai.request.model": "alias"},
                )
            )
            session.commit()
        self._drop_served_model(test_engine)

        monkeypatch.setattr(apo_db, "engine", test_engine)
        apo_db._migrate_to_v57()
        apo_db._migrate_to_v57()  # idempotent

        with Session(test_engine) as session:
            by_id = {call.id: call for call in session.exec(select(LoggedCallDB)).all()}
            assert by_id["span-1"].served_model == "openai/gpt-4o-mini"
            assert by_id["span-2"].served_model is None
            assert by_id["elsewhere"].served_model is None

    def test_backfill_pages_past_the_batch_limit(self, monkeypatch: MonkeyPatch) -> None:
        test_engine = self._pre_v57_engine()
        with Session(test_engine) as session:
            for i in range(600):
                session.add(_call(id=f"s{i}", project="p1"))
                session.add(
                    _span(
                        span_id=f"s{i}",
                        project_id="p1",
                        attributes={"gen_ai.response.model": "m"},
                    )
                )
            session.commit()
        self._drop_served_model(test_engine)

        monkeypatch.setattr(apo_db, "engine", test_engine)
        apo_db._migrate_to_v57()

        with Session(test_engine) as session:
            filled = session.exec(
                select(LoggedCallDB).where(
                    col(LoggedCallDB.served_model) == "m"
                )
            ).all()
            assert len(filled) == 600
