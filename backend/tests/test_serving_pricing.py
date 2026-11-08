# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownLambdaType=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false

"""Serving-qualified pricing: selectors, dominance, ambiguity, quality.

The same model served through different setups (API provider, host, route,
tier) must bill at each setup's configured rate. Selector resolution is
strict-superset dominance; two incomparable maximal selectors are ambiguous
with a null cost and a deterministic explanation; a wildcard rate remains a
labeled model-only estimate.
"""

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine

from apo.models.pricing import ModelRowDB, PriceDB, PricingTierDB
from apo.models.serving import ServingMatch
from apo.models.usage_keys import UsageKey
from apo.services.pricing.compute import compute_cost
from apo.services.pricing.resolution import resolve_model_era_qualified

NOW = datetime(2026, 1, 15, tzinfo=timezone.utc)


@pytest.fixture
def session() -> Session:  # pyright: ignore[reportInvalidTypeForm]
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    sess = Session(engine)
    yield sess
    sess.close()


def _era(
    session: Session,
    *,
    pattern: str = "^m$",
    project: str = "__global__",
    input_price: int,
    match: ServingMatch | None = None,
) -> ModelRowDB:
    row = ModelRowDB(
        project=project,
        match_pattern=pattern,
        provider="any",
        match_api_provider=match.api_provider if match else None,
        match_serving_host=match.serving_host if match else None,
        match_route=match.route if match else None,
        match_service_tier=match.service_tier if match else None,
    )
    session.add(row)
    session.flush()
    assert row.id is not None
    tier = PricingTierDB(model_id=row.id, name="default", is_default=True)
    session.add(tier)
    session.flush()
    assert tier.id is not None
    session.add(
        PriceDB(
            model_id=row.id,
            tier_id=tier.id,
            usage_key=UsageKey.INPUT,
            price_per_1m=input_price,
        )
    )
    session.add(
        PriceDB(
            model_id=row.id,
            tier_id=tier.id,
            usage_key=UsageKey.OUTPUT,
            price_per_1m=input_price * 2,
        )
    )
    session.commit()
    session.refresh(row)
    return row


class TestQualifiedResolution:
    def test_same_model_two_setups_distinct_prices(self, session: Session) -> None:
        _era(session, input_price=1_000_000, match=ServingMatch(api_provider="fireworks"))
        _era(session, input_price=2_000_000, match=ServingMatch(api_provider="openrouter"))

        fireworks = compute_cost(
            session, "m", {"input": 1000, "output": 0}, "p", NOW,
            serving=ServingMatch(api_provider="fireworks"),
        )
        openrouter = compute_cost(
            session, "m", {"input": 1000, "output": 0}, "p", NOW,
            serving=ServingMatch(api_provider="openrouter"),
        )
        assert fireworks is not None and fireworks.total == 1000
        assert openrouter is not None and openrouter.total == 2000
        assert fireworks.pricing_quality == "qualified"
        assert openrouter.matched_serving == ServingMatch(api_provider="openrouter")

    def test_more_specific_selector_dominates(self, session: Session) -> None:
        _era(session, input_price=1_000_000, match=ServingMatch(api_provider="openrouter"))
        _era(
            session,
            input_price=500_000,
            match=ServingMatch(api_provider="openrouter", serving_host="baseten"),
        )

        result = compute_cost(
            session, "m", {"input": 1000, "output": 0}, "p", NOW,
            serving=ServingMatch(api_provider="openrouter", serving_host="baseten"),
        )
        assert result is not None
        assert result.total == 500
        assert result.matched_serving == ServingMatch(
            api_provider="openrouter", serving_host="baseten"
        )

    def test_incomparable_selectors_are_ambiguous(self, session: Session) -> None:
        a = _era(session, input_price=1_000_000, match=ServingMatch(api_provider="openrouter"))
        b = _era(session, input_price=900_000, match=ServingMatch(serving_host="baseten"))

        result = compute_cost(
            session, "m", {"input": 1000, "output": 0}, "p", NOW,
            serving=ServingMatch(api_provider="openrouter", serving_host="baseten"),
        )
        assert result is not None
        assert result.pricing_quality == "ambiguous"
        assert result.total == 0
        assert a.id is not None and b.id is not None
        assert sorted(result.candidate_model_ids) == sorted([a.id, b.id])

    def test_unknown_identity_falls_back_to_wildcard_estimate(self, session: Session) -> None:
        _era(session, input_price=1_000_000)
        _era(session, input_price=400_000, match=ServingMatch(api_provider="fireworks"))

        known = compute_cost(
            session, "m", {"input": 1000, "output": 0}, "p", NOW,
            serving=ServingMatch(api_provider="fireworks"),
        )
        unknown = compute_cost(
            session, "m", {"input": 1000, "output": 0}, "p", NOW,
        )
        assert known is not None and known.total == 400
        assert unknown is not None and unknown.total == 1000
        assert unknown.pricing_quality == "model_only"

    def test_known_host_does_not_justify_gateway_rate(self, session: Session) -> None:
        # A direct-provider rate (api_provider=baseten) must not price traffic
        # that went through a gateway (api_provider=openrouter, host=baseten).
        _era(session, input_price=1_000_000)
        _era(session, input_price=300_000, match=ServingMatch(api_provider="baseten"))

        result = compute_cost(
            session, "m", {"input": 1000, "output": 0}, "p", NOW,
            serving=ServingMatch(api_provider="openrouter", serving_host="baseten"),
        )
        assert result is not None
        assert result.pricing_quality == "model_only"
        assert result.total == 1000

    def test_project_override_shadows_same_slot_only(self, session: Session) -> None:
        _era(session, input_price=1_000_000)  # global wildcard
        _era(
            session,
            input_price=800_000,
            project="p",
            match=ServingMatch(api_provider="fireworks"),
        )

        qualified = compute_cost(
            session, "m", {"input": 1000, "output": 0}, "p", NOW,
            serving=ServingMatch(api_provider="fireworks"),
        )
        other_host = compute_cost(
            session, "m", {"input": 1000, "output": 0}, "p", NOW,
            serving=ServingMatch(api_provider="openrouter"),
        )
        assert qualified is not None and qualified.total == 800
        assert other_host is not None and other_host.total == 1000
        assert other_host.pricing_quality == "model_only"

    def test_service_tier_selector(self, session: Session) -> None:
        _era(session, input_price=1_000_000, match=ServingMatch(service_tier="priority"))
        _era(session, input_price=2_000_000)

        served_priority = compute_cost(
            session, "m", {"input": 1000, "output": 0}, "p", NOW,
            serving=ServingMatch(api_provider="fireworks", service_tier="priority"),
        )
        assert served_priority is not None
        assert served_priority.total == 1000
        assert served_priority.pricing_quality == "qualified"

    def test_legacy_provider_pattern_resolves_as_api_provider_selector(
        self, session: Session
    ) -> None:
        row = _era(session, input_price=1_000_000)
        row.provider_pattern = "fireworks"
        row.match_api_provider = "fireworks"
        session.add(row)
        session.commit()

        resolution = resolve_model_era_qualified(
            session, "m", "p", NOW, serving=ServingMatch(api_provider="fireworks")
        )
        assert resolution.row is not None
        assert resolution.quality == "qualified"


class TestResolutionOutcomes:
    def test_no_rows_in_scope_is_unpriced(self, session: Session) -> None:
        resolution = resolve_model_era_qualified(session, "m", "p", NOW)
        assert resolution.row is None
        assert resolution.quality == "unpriced"

    def test_concrete_selector_never_matches_unknown_observation(
        self, session: Session
    ) -> None:
        _era(session, input_price=1_000_000, match=ServingMatch(serving_host="baseten"))
        resolution = resolve_model_era_qualified(session, "m", "p", NOW)
        assert resolution.row is None
        assert resolution.quality == "unpriced"
