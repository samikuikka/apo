# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownLambdaType=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false

"""SPEC-136 ticket 05: tier condition engine (threshold-only)."""

from __future__ import annotations

import pytest
from sqlmodel import Session, SQLModel, create_engine

from apo.models.pricing import (
    ModelRowDB,
    PriceDB,
    PricingTierDB,
    PriceMap,
    TierCondition,
    TierDocument,
)
from apo.models.usage_keys import UsageKey
from apo.services.pricing import json_conditions, match_tier
from apo.services.pricing.validation import validate_model_document


@pytest.fixture
def session() -> Session:
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    sess = Session(eng)
    yield sess
    sess.close()


def _make_gemini_25_pro(session: Session) -> ModelRowDB:
    """Golden large-context-tiered model (Gemini 2.5 Pro shape).

    default tier + a large-context tier whose condition sums the read-side
    family input + cache_read > 200000 (cached tokens occupy the context
    window). See ticket 05.
    """
    model = ModelRowDB(match_pattern=r"(?i)^gemini-2\.5-pro$", provider="google")
    session.add(model)
    session.flush()

    default = PricingTierDB(
        model_id=model.id, name="default", is_default=True, priority=0, conditions_json="[]"
    )
    large = PricingTierDB(
        model_id=model.id,
        name="large-context",
        is_default=False,
        priority=1,
        conditions_json=json_conditions(
            [TierCondition(keys=[UsageKey.INPUT, UsageKey.CACHE_READ], operator="gt", threshold=200_000)]
        ),
    )
    session.add_all([default, large])
    session.flush()
    # Same usage_key set across tiers (validation rule C).
    for tier in (default, large):
        session.add(
            PriceDB(
                model_id=model.id,
                tier_id=tier.id,
                usage_key=UsageKey.INPUT.value,
                price_per_1m=1_250_000 if tier is default else 2_500_000,
            )
        )
        session.add(
            PriceDB(
                model_id=model.id,
                tier_id=tier.id,
                usage_key=UsageKey.OUTPUT.value,
                price_per_1m=10_000_000,
            )
        )
        session.add(
            PriceDB(
                model_id=model.id,
                tier_id=tier.id,
                usage_key=UsageKey.CACHE_READ.value,
                price_per_1m=312_500 if tier is default else 625_000,
            )
        )
    session.commit()
    return model


class TestMatchTier:
    def test_below_threshold_uses_default(self, session: Session) -> None:
        model = _make_gemini_25_pro(session)
        tier = match_tier(session, model, {"input": 150_000, "cache_read": 0, "output": 0})
        assert tier.name == "default"

    def test_input_above_threshold_uses_large_context(self, session: Session) -> None:
        model = _make_gemini_25_pro(session)
        tier = match_tier(session, model, {"input": 250_000, "cache_read": 0, "output": 0})
        assert tier.name == "large-context"

    def test_cache_read_counts_toward_context_sum(self, session: Session) -> None:
        """The read-side family sum (input + cache_read) crosses the threshold.

        150k input + 100k cache_read = 250k context -> large-context tier.
        A single-key input>200k would miss this. See ticket 05.
        """
        model = _make_gemini_25_pro(session)
        tier = match_tier(session, model, {"input": 150_000, "cache_read": 100_000, "output": 0})
        assert tier.name == "large-context"

    def test_default_returned_when_no_conditions_pass(self, session: Session) -> None:
        model = _make_gemini_25_pro(session)
        tier = match_tier(session, model, {"input": 10, "cache_read": 0, "output": 0})
        assert tier.name == "default"


class TestValidateTierGraph:
    def test_rejects_zero_default_tiers(self) -> None:
        doc = _doc([TierDocument(name="a", is_default=False, priority=0)])
        with pytest.raises(ValueError, match="default"):
            validate_model_document(doc)

    def test_rejects_two_default_tiers(self) -> None:
        doc = _doc(
            [
                TierDocument(name="a", is_default=True, priority=0),
                TierDocument(name="b", is_default=True, priority=1),
            ]
        )
        with pytest.raises(ValueError, match="default"):
            validate_model_document(doc)

    def test_rejects_mismatched_key_sets_across_tiers(self) -> None:
        doc = _doc(
            [
                TierDocument(name="a", is_default=True, priority=0, prices=PriceMap(input=3.0)),
                TierDocument(
                    name="b",
                    is_default=False,
                    priority=1,
                    prices=PriceMap(input=3.0, output=15.0),
                ),
            ]
        )
        with pytest.raises(ValueError, match="key"):
            validate_model_document(doc)

    def test_accepts_consistent_graph(self) -> None:
        doc = _doc(
            [
                TierDocument(name="a", is_default=True, priority=0, prices=PriceMap(input=3.0, output=15.0)),
                TierDocument(name="b", is_default=False, priority=1, prices=PriceMap(input=6.0, output=15.0)),
            ]
        )
        validate_model_document(doc)  # no raise


def _doc(tiers: list[TierDocument]) -> object:
    from apo.models.pricing import ModelDocumentCreate

    return ModelDocumentCreate(match_pattern="^x$", provider="openai", pricing_tiers=tiers)
