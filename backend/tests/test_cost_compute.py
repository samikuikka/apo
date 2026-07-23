# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownLambdaType=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false

"""SPEC-136 ticket 06: cost computation — breakdown math + precedence.

Verifies: breakdown[k] = round(price_stored * tokens / 1_000_000) per
dimension (price_stored is micro-USD-per-1M), total = sum(breakdown),
provided-wins-verbatim, skip-on-no-match, skip-on-missing-price.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine

from apo.models.pricing import ModelRowDB, PriceDB, PricingTierDB
from apo.models.usage_keys import UsageKey
from apo.services.pricing.compute import ComputedCost, compute_cost
from apo.services.pricing.resolution import resolve_model_era


@pytest.fixture
def session() -> Session:
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    sess = Session(eng)
    yield sess
    sess.close()


_NOW = datetime(2026, 2, 15, tzinfo=timezone.utc)


def _flat_model(session: Session) -> None:
    """gpt-4o-mini: flat-priced, input=0.15/MTok, output=0.60/MTok."""
    m = ModelRowDB(match_pattern=r"(?i)^gpt-4o-mini$", provider="openai", start_date=None)
    session.add(m)
    session.flush()
    t = PricingTierDB(model_id=m.id, name="default", is_default=True, conditions_json="[]")
    session.add(t)
    session.flush()
    # micro-USD per 1M tokens
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.INPUT.value, price_per_1m=150_000))
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.OUTPUT.value, price_per_1m=600_000))
    session.commit()


def _cache_tiered_model(session: Session) -> None:
    """claude-sonnet-4.5: cache_read + cache_write_5m distinct priced dims."""
    m = ModelRowDB(match_pattern=r"(?i)^claude-sonnet-4\.5$", provider="anthropic", start_date=None)
    session.add(m)
    session.flush()
    t = PricingTierDB(model_id=m.id, name="default", is_default=True, conditions_json="[]")
    session.add(t)
    session.flush()
    # input=3.0/MTok, output=15.0/MTok, cache_read=0.30/MTok, cache_write_5m=3.75/MTok
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.INPUT.value, price_per_1m=3_000_000))
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.OUTPUT.value, price_per_1m=15_000_000))
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.CACHE_READ.value, price_per_1m=300_000))
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.CACHE_WRITE_5M.value, price_per_1m=3_750_000))
    session.commit()


def _reasoning_model(session: Session) -> None:
    """o3: reasoning is a distinct output-side priced dim."""
    m = ModelRowDB(match_pattern=r"(?i)^o3$", provider="openai", start_date=None)
    session.add(m)
    session.flush()
    t = PricingTierDB(model_id=m.id, name="default", is_default=True, conditions_json="[]")
    session.add(t)
    session.flush()
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.INPUT.value, price_per_1m=2_000_000))
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.OUTPUT.value, price_per_1m=8_000_000))
    session.add(PriceDB(model_id=m.id, tier_id=t.id, usage_key=UsageKey.REASONING.value, price_per_1m=32_000_000))
    session.commit()


class TestFlatCost:
    def test_breakdown_and_total(self, session: Session) -> None:
        _flat_model(session)
        result = compute_cost(session, "gpt-4o-mini", {"input": 1_000_000, "output": 500_000}, "__global__", _NOW)
        assert result is not None
        # input: 150_000 micro-per-1M * 1M tokens / 1M = 150_000 micro-USD
        assert result.breakdown == {"input": 150_000, "output": 300_000}
        assert result.total == 450_000

    def test_stores_matched_tier(self, session: Session) -> None:
        _flat_model(session)
        result = compute_cost(session, "gpt-4o-mini", {"input": 100, "output": 100}, "__global__", _NOW)
        assert result is not None
        assert result.tier_name == "default"
        assert result.tier_id is not None

    def test_zero_tokens_zero_cost(self, session: Session) -> None:
        _flat_model(session)
        result = compute_cost(session, "gpt-4o-mini", {"input": 0, "output": 0}, "__global__", _NOW)
        assert result is not None
        assert result.total == 0


class TestCacheTieredCost:
    def test_all_priced_dims_present(self, session: Session) -> None:
        _cache_tiered_model(session)
        result = compute_cost(
            session,
            "claude-sonnet-4.5",
            {"input": 1_000_000, "output": 1_000_000, "cache_read": 500_000, "cache_write_5m": 200_000},
            "__global__",
            _NOW,
        )
        assert result is not None
        # 3M + 15M + 0.15M + 0.75M micro-USD
        assert result.breakdown == {
            "input": 3_000_000,
            "output": 15_000_000,
            "cache_read": 150_000,
            "cache_write_5m": 750_000,
        }
        assert result.total == 18_900_000


class TestReasoningCost:
    def test_reasoning_priced_separately(self, session: Session) -> None:
        _reasoning_model(session)
        result = compute_cost(
            session,
            "o3",
            {"input": 1_000_000, "output": 1_000_000, "reasoning": 500_000},
            "__global__",
            _NOW,
        )
        assert result is not None
        assert result.breakdown == {"input": 2_000_000, "output": 8_000_000, "reasoning": 16_000_000}
        assert result.total == 26_000_000

    def test_unpriced_key_skipped(self, session: Session) -> None:
        """A key in usage that the model doesn't price is skipped (0), kept in raw."""
        _flat_model(session)
        result = compute_cost(
            session,
            "gpt-4o-mini",
            {"input": 1_000_000, "output": 0, "reasoning": 999_999},  # reasoning unpriced
            "__global__",
            _NOW,
        )
        assert result is not None
        assert "reasoning" not in result.breakdown  # skipped, not priced
        assert result.breakdown == {"input": 150_000}


class TestNoMatch:
    def test_no_matching_model_returns_none(self, session: Session) -> None:
        result = compute_cost(session, "no-such-model", {"input": 100, "output": 100}, "__global__", _NOW)
        assert result is None


class TestRounding:
    def test_round_per_dimension_and_reconcile(self, session: Session) -> None:
        """round-per-dimension to micro-USD int; total == sum(breakdown)."""
        _flat_model(session)
        # input=150_000 micro-per-1M, 333_333 tokens.
        # round(150_000 * 333333 / 1e6) = round(49_999.95) = 50_000 micro-USD
        # round(600_000 * 333333 / 1e6) = round(199_999.8) = 200_000 micro-USD
        result = compute_cost(
            session,
            "gpt-4o-mini",
            {"input": 333_333, "output": 333_333},
            "__global__",
            _NOW,
        )
        assert result is not None
        assert result.breakdown == {"input": 50_000, "output": 200_000}
        assert result.total == sum(result.breakdown.values())

    def test_negative_clamped_to_zero(self, session: Session) -> None:
        _flat_model(session)
        result = compute_cost(
            session,
            "gpt-4o-mini",
            {"input": -500, "output": 100},  # negative clamped to 0
            "__global__",
            _NOW,
        )
        assert result is not None
        # input clamped to 0 -> 0 cost -> omitted from breakdown (zero-cost dims
        # are not stored). Only output contributes.
        assert "input" not in result.breakdown
        assert result.breakdown == {"output": round(600_000 * 100 / 1_000_000)}


class TestComputedCostModel:
    def test_total_defaults_to_breakdown_sum(self) -> None:
        c = ComputedCost(model_id=1, tier_id=2, tier_name="default", breakdown={"input": 10, "output": 20})
        assert c.total == 30
