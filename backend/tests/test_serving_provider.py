# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false, reportPrivateUsage=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportDeprecated=false, reportInvalidTypeForm=false, reportReturnType=false, reportUnnecessaryComparison=false, reportExplicitAny=false, reportUnusedParameter=false
# pyright: reportAny=false, reportUnusedCallResult=false, reportUnknownArgumentType=false, reportUnknownMemberType=false

"""Serving provider/route tracking (issue #307).

Covers the full vertical: attribute extraction (``gen_ai.provider.name`` /
``gen_ai.system`` / ``apo.llm.route``), projection onto ``logged_calls``,
the (model, provider) pair rollup, per-call decode throughput, the run-level
median, provider-aware price-era resolution, and the run-list provider
filter.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest
from sqlmodel import Session, SQLModel, create_engine, select, text

from apo.db import engine, init_db
from apo.models.db import LoggedCallDB, OtlpSpanDB, RunDB
from apo.models.pricing import ModelRowDB
from apo.services.otel_normalization import normalize_span
from apo.services.otel_normalization._shared import (
    extract_provider,
    extract_route,
)
from apo.services.pricing.resolution import resolve_model_era
from apo.services.trace_backend import (
    model_providers_summary,
    output_tok_per_s,
    parse_model_providers,
    provider_labels,
)
from apo.services.trace_projector import TraceProjector


def _span(
    *,
    span_id: str = "span-1",
    parent_span_id: str | None = "root",
    attributes: dict[str, object] | None = None,
) -> OtlpSpanDB:
    return OtlpSpanDB(
        project_id="test-project",
        trace_id="trace-1",
        span_id=span_id,
        span_name="chat",
        attributes=attributes or {},
        start_time=datetime(2026, 9, 1, tzinfo=timezone.utc),
        end_time=datetime(2026, 9, 1, 0, 0, 2, tzinfo=timezone.utc),
        resource={},
    )


def _call(**overrides: Any) -> LoggedCallDB:
    """A GENERATION shell for the pure rollup helpers."""
    base: dict[str, Any] = {
        "id": "call-1",
        "run_id": "trace-1",
        "project": "p",
        "task_id": "",
        "created_at": datetime(2026, 9, 1, tzinfo=timezone.utc),
        "model": "deepseek-v4.1-flash",
        "observation_type": "GENERATION",
    }
    base.update(overrides)
    return LoggedCallDB(**base)  # type: ignore[arg-type]


class TestExtraction:
    def test_provider_name_wins_over_system(self) -> None:
        attrs = {
            "gen_ai.provider.name": "fireworks",
            "gen_ai.system": "openrouter",
        }
        assert extract_provider(attrs) == "fireworks"

    def test_gen_ai_system_is_the_fallback(self) -> None:
        assert extract_provider({"gen_ai.system": "openrouter"}) == "openrouter"

    def test_no_provider_attribute_means_none_not_a_guess(self) -> None:
        assert extract_provider({"gen_ai.request.model": "gpt-5.6-luna"}) is None

    def test_route_attribute(self) -> None:
        assert extract_route({"apo.llm.route": "openrouter:nitro->baseten"}) == (
            "openrouter:nitro->baseten"
        )
        assert extract_route({}) is None

    def test_normalize_span_carries_provider_and_route(self) -> None:
        normalized = normalize_span(
            _span(
                attributes={
                    "gen_ai.request.model": "deepseek-v4.1-flash",
                    "gen_ai.usage.input_tokens": 10,
                    "gen_ai.usage.output_tokens": 20,
                    "gen_ai.provider.name": "fireworks",
                    "apo.llm.route": "priority",
                }
            )
        )
        assert normalized.provider == "fireworks"
        assert normalized.route == "priority"


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    yield
    with Session(engine) as session:
        for table in ("run_metrics", "logged_calls", "runs", "otlp_spans"):
            session.execute(text(f"DELETE FROM {table}"))
        session.commit()


class TestProjection:
    def test_provider_and_route_persisted_on_call(self) -> None:
        span = _span(
            attributes={
                "gen_ai.request.model": "deepseek-v4.1-flash",
                "gen_ai.usage.input_tokens": 10,
                "gen_ai.usage.output_tokens": 20,
                "gen_ai.provider.name": "fireworks",
                "apo.llm.route": "priority",
            }
        )
        with Session(engine) as session:
            TraceProjector().project(span, session)
            session.commit()
            call = session.exec(select(LoggedCallDB)).one()
            assert call.provider == "fireworks"
            assert call.route == "priority"

    def test_reprojection_keeps_provider(self) -> None:
        span = _span(
            attributes={
                "gen_ai.request.model": "deepseek-v4.1-flash",
                "gen_ai.provider.name": "fireworks",
            }
        )
        with Session(engine) as session:
            TraceProjector().project(span, session)
            session.commit()
            # A later batch of the same span without the attribute (an
            # emitter that reports provider only on first use) must not
            # erase the known host.
            bare = _span(
                attributes={"gen_ai.request.model": "deepseek-v4.1-flash"}
            )
            TraceProjector().project(bare, session)
            session.commit()
            call = session.exec(select(LoggedCallDB)).one()
            assert call.provider == "fireworks"

    def test_run_rollup_written_on_completion(self) -> None:
        with Session(engine) as session:
            # Root completes the run; then generations land.
            root = _span(span_id="root", parent_span_id=None)
            TraceProjector().project(root, session)
            session.commit()
            TraceProjector().project(
                _span(
                    span_id="gen-a",
                    attributes={
                        "gen_ai.request.model": "deepseek-v4.1-flash",
                        "gen_ai.usage.input_tokens": 100,
                        "gen_ai.usage.output_tokens": 200,
                        "gen_ai.provider.name": "fireworks",
                        "apo.llm.route": "priority",
                    },
                ),
                session,
            )
            TraceProjector().project(
                _span(
                    span_id="gen-b",
                    attributes={
                        "gen_ai.request.model": "deepseek-v4.1-flash",
                        "gen_ai.usage.input_tokens": 100,
                        "gen_ai.usage.output_tokens": 200,
                        "gen_ai.provider.name": "baseten",
                    },
                ),
                session,
            )
            session.commit()
            run = session.exec(select(RunDB)).one()
            pairs = parse_model_providers(run.model_providers_json)
            assert {(p["provider"], p["route"], p["calls"]) for p in pairs} == {
                ("fireworks", "priority", 1),
                ("baseten", None, 1),
            }


class TestRollupHelpers:
    def test_summary_groups_pairs_and_sorts_by_cost(self) -> None:
        summary = model_providers_summary(
            [
                _call(provider="fireworks", cost=100),
                _call(provider="fireworks", cost=50, total_tokens=10),
                _call(provider="baseten", cost=900),
                _call(model="claude-opus-5", provider=None, cost=5),
                # Non-generation and model-less rows carry no serving identity.
                _call(observation_type="TOOL", provider="fireworks"),
                _call(model="", provider="fireworks"),
            ]
        )
        assert summary is not None
        pairs = summary["pairs"]
        assert isinstance(pairs, list)
        assert [p["provider"] for p in pairs] == ["baseten", "fireworks", None]
        fireworks = next(p for p in pairs if p["provider"] == "fireworks")
        assert fireworks["calls"] == 2
        assert fireworks["total_tokens"] == 10
        assert fireworks["cost_micro"] == 150

    def test_summary_none_without_model_generations(self) -> None:
        assert model_providers_summary([_call(observation_type="TOOL")]) is None
        assert model_providers_summary([]) is None

    def test_provider_labels_prefer_route_and_skip_unknown(self) -> None:
        pairs = parse_model_providers(
            model_providers_summary(
                [
                    _call(provider="openrouter", route="openrouter:nitro"),
                    _call(provider="fireworks"),
                    _call(provider=None),
                ]
            )
        )
        assert provider_labels(pairs) == ["fireworks", "openrouter:nitro"]

    def test_parse_model_providers_tolerates_bad_json(self) -> None:
        assert parse_model_providers(None) == []
        assert parse_model_providers({"pairs": "nope"}) == []


class TestThroughput:
    def test_decode_window_uses_latency_minus_ttft(self) -> None:
        # 300 tokens over (10s - 2s) = 37.5 tok/s, not 30.
        call = _call(
            completion_tokens=300, latency_ms=10_000, time_to_first_token_ms=2_000
        )
        assert output_tok_per_s(call) == pytest.approx(37.5)

    def test_falls_back_to_full_duration_without_ttft(self) -> None:
        call = _call(completion_tokens=300, latency_ms=10_000)
        assert output_tok_per_s(call) == pytest.approx(30.0)

    def test_missing_tokens_or_timing_is_none(self) -> None:
        assert output_tok_per_s(_call(completion_tokens=None, latency_ms=1000)) is None
        assert output_tok_per_s(_call(completion_tokens=10, latency_ms=None)) is None
        assert output_tok_per_s(_call(completion_tokens=0, latency_ms=1000)) is None

    def test_median_in_generation_usage(self) -> None:
        from apo.services.trace_backend import _generation_usage

        calls = [
            _call(completion_tokens=100, latency_ms=1_000),
            _call(completion_tokens=300, latency_ms=1_000),
            _call(completion_tokens=500, latency_ms=1_000),
            # Errored generation: excluded from the median.
            _call(id="err", completion_tokens=999_999, latency_ms=1_000),
        ]
        usage = _generation_usage(calls, {"err"})
        assert usage is not None
        assert usage["median_output_tok_s"] == 300.0
        assert usage["output_tok_s_calls"] == 3


class TestProviderQualifiedPricing:
    @pytest.fixture
    def session(self) -> Session:
        eng = create_engine("sqlite://")
        SQLModel.metadata.create_all(eng)
        sess = Session(eng)
        yield sess
        sess.close()

    def _seed(self, session: Session) -> None:
        # The provider-agnostic default era and a cheaper fireworks-qualified
        # era for the same model — "same model, two hosts, each at its rate".
        session.add(
            ModelRowDB(
                project="__global__",
                match_pattern=r"(?i)^deepseek-v4\.1-flash$",
                provider="generic",
            )
        )
        session.add(
            ModelRowDB(
                project="__global__",
                match_pattern=r"(?i)^deepseek-v4\.1-flash$",
                provider="fireworks",
                provider_pattern="fireworks",
            )
        )
        session.commit()

    def test_qualified_era_wins_when_provider_matches(self, session: Session) -> None:
        self._seed(session)
        era = resolve_model_era(
            session,
            "deepseek-v4.1-flash",
            "__global__",
            datetime(2026, 9, 1, tzinfo=timezone.utc),
            provider="fireworks",
        )
        assert era is not None and era.provider_pattern == "fireworks"

    def test_agnostic_era_serves_unknown_provider(self, session: Session) -> None:
        self._seed(session)
        era = resolve_model_era(
            session,
            "deepseek-v4.1-flash",
            "__global__",
            datetime(2026, 9, 1, tzinfo=timezone.utc),
            provider=None,
        )
        assert era is not None and era.provider_pattern is None

    def test_qualified_era_never_matches_other_providers(self, session: Session) -> None:
        self._seed(session)
        era = resolve_model_era(
            session,
            "deepseek-v4.1-flash",
            "__global__",
            datetime(2026, 9, 1, tzinfo=timezone.utc),
            provider="baseten",
        )
        assert era is not None and era.provider_pattern is None

    def test_provider_pattern_supports_wildcards(self, session: Session) -> None:
        session.add(
            ModelRowDB(
                project="__global__",
                match_pattern=r"(?i)^model-x$",
                provider="router",
                provider_pattern=r"(?i)openrouter:.*",
            )
        )
        session.commit()
        era = resolve_model_era(
            session,
            "model-x",
            "__global__",
            datetime(2026, 9, 1, tzinfo=timezone.utc),
            provider="openrouter:nitro",
        )
        assert era is not None and era.provider_pattern is not None


class TestRunListProviderFilter:
    def test_filter_matches_provider_or_route(self) -> None:
        from apo.routes.runs.list_query import (
            RunListFilters,
            RunListPagination,
            list_run_summaries,
        )

        with Session(engine) as session:
            run = RunDB(id="trace-1", project="default", created_at=datetime.now(timezone.utc))
            session.add(run)
            session.flush()
            session.add(
                _call(
                    run_id="trace-1",
                    project="default",
                    provider="fireworks",
                    route="priority",
                )
            )
            session.add(
                _call(
                    id="call-2",
                    run_id="trace-1",
                    project="default",
                    model="claude-opus-5",
                    provider="anthropic",
                )
            )
            session.commit()

            pagination = RunListPagination(page=0, page_size=40, sort_by=None, sort_order=None)

            page = list_run_summaries(
                session,
                RunListFilters(project="default", providers=["fireworks"]),
                pagination,
            )
            assert [s.id for s in page.data] == ["trace-1"]

            page = list_run_summaries(
                session,
                RunListFilters(project="default", providers=["priority"]),
                pagination,
            )
            assert [s.id for s in page.data] == ["trace-1"]

            page = list_run_summaries(
                session,
                RunListFilters(project="default", providers=["groq"]),
                pagination,
            )
            assert page.data == []


class TestProviderFacet:
    def test_facet_groups_by_route_wins_label(self) -> None:
        from apo.routes.runs.facets import _compute_provider_facets
        from sqlmodel import Session, SQLModel, create_engine

        eng = create_engine("sqlite://")
        SQLModel.metadata.create_all(eng)
        with Session(eng) as session:
            # Three runs: route-labeled, provider-labeled, and both-labels
            # (route must win — the facet must not also offer the shadowed
            # provider value), plus a no-host run that contributes nothing.
            for run_id, provider, route in (
                ("r1", "fireworks", "priority"),
                ("r2", "baseten", None),
                ("r3", None, None),
            ):
                session.add(
                    _call(
                        id=f"c-{run_id}",
                        run_id=run_id,
                        project="p",
                        provider=provider,
                        route=route,
                    )
                )
            # A second call on r2 — the count is distinct RUNS, not calls.
            session.add(
                _call(id="c-r2b", run_id="r2", project="p", provider="baseten")
            )
            session.commit()

            buckets = _compute_provider_facets(session, ["r1", "r2", "r3"])
            assert [(b.value, b.count) for b in buckets] == [
                ("baseten", 1),
                ("priority", 1),
            ]


class TestProviderQualifiedPricingFixes:
    """Regressions for the adversarial findings: the qualified-era logic is
    only correct when rows arrive through the real write paths."""

    @pytest.fixture
    def session(self) -> Session:  # pyright: ignore[reportInvalidTypeForm]
        eng = create_engine("sqlite://")
        SQLModel.metadata.create_all(eng)
        sess = Session(eng)
        yield sess
        sess.close()

    def test_api_validation_accepts_qualified_era_next_to_agnostic(
        self, session: Session
    ) -> None:
        """The two-host configuration is the feature's whole point — the
        overlap check must scope per provider slot, not per pattern."""
        from apo.models.pricing import ModelDocumentCreate, TierDocument
        from apo.services.pricing.validation import (
            TierValidationError,
            validate_era_no_overlap,
            validate_model_document,
        )

        def _doc(provider_pattern: str | None) -> ModelDocumentCreate:
            return ModelDocumentCreate(
                project="proj",
                match_pattern=r"(?i)^model-w$",
                provider="generic",
                provider_pattern=provider_pattern,
                pricing_tiers=[TierDocument(name="default", is_default=True)],
            )

        # Agnostic era first, then a fireworks-qualified era for the SAME
        # pattern — must not raise.
        validate_model_document(_doc(None))
        session.add(ModelRowDB(project="proj", match_pattern=r"(?i)^model-w$", provider="generic"))
        session.commit()
        validate_era_no_overlap(
            session,
            project="proj",
            match_pattern=r"(?i)^model-w$",
            start_date=None,
            end_date=None,
            provider_pattern="fireworks",
        )
        # A second qualified era in the SAME provider slot must still raise.
        session.add(
            ModelRowDB(
                project="proj",
                match_pattern=r"(?i)^model-w$",
                provider="fireworks",
                provider_pattern="fireworks",
            )
        )
        session.commit()
        with pytest.raises(TierValidationError):
            validate_era_no_overlap(
                session,
                project="proj",
                match_pattern=r"(?i)^model-w$",
                start_date=None,
                end_date=None,
                provider_pattern="fireworks",
            )

    def test_call_outside_qualified_window_falls_back_to_agnostic(
        self, session: Session
    ) -> None:
        """Repricing history after adding a per-host era must not flip older
        matching calls to unpriced."""
        session.add(
            ModelRowDB(
                project="__global__",
                match_pattern=r"(?i)^model-y$",
                provider="generic",
                start_date=_dt("2020-01-01T00:00:00Z"),
                end_date=_dt("2027-01-01T00:00:00Z"),
            )
        )
        session.add(
            ModelRowDB(
                project="__global__",
                match_pattern=r"(?i)^model-y$",
                provider="fireworks",
                provider_pattern="fireworks",
                start_date=_dt("2026-10-01T00:00:00Z"),
                end_date=None,
            )
        )
        session.commit()
        # Before the qualified window: the agnostic era covers it.
        era = resolve_model_era(
            session,
            "model-y",
            "__global__",
            _dt("2026-09-01T00:00:00Z"),
            provider="fireworks",
        )
        assert era is not None and era.provider_pattern is None
        # Inside the qualified window: the qualified era wins.
        era = resolve_model_era(
            session,
            "model-y",
            "__global__",
            _dt("2026-11-01T00:00:00Z"),
            provider="fireworks",
        )
        assert era is not None and era.provider_pattern == "fireworks"

    def test_project_qualified_era_keeps_global_fallback_visible(
        self, session: Session
    ) -> None:
        """A project adding a per-host rate must not unprice its other
        hosts: shadowing is per (pattern, provider) slot."""
        session.add(
            ModelRowDB(
                project="__global__",
                match_pattern=r"(?i)^model-z$",
                provider="generic",
            )
        )
        session.add(
            ModelRowDB(
                project="proj",
                match_pattern=r"(?i)^model-z$",
                provider="fireworks",
                provider_pattern="fireworks",
            )
        )
        session.commit()
        era = resolve_model_era(
            session, "model-z", "proj", _dt("2026-09-01T00:00:00Z"), provider="fireworks"
        )
        assert era is not None and era.provider_pattern == "fireworks"
        # The project's other host still bills at the global base rate.
        era = resolve_model_era(
            session, "model-z", "proj", _dt("2026-09-01T00:00:00Z"), provider="baseten"
        )
        assert era is not None and era.provider_pattern is None

    def test_tolerant_pair_parsing_skips_corrupt_entries(self) -> None:
        assert parse_model_providers(
            {"pairs": [{"model": "m", "calls": 1}, {"model": "m"}, "junk", 5]}
        ) == [{"model": "m", "calls": 1}]


def _dt(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))
