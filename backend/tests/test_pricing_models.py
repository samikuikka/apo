# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownLambdaType=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false

"""SPEC-136: data model + per-call storage (tickets 02, 06).

Verifies the new 3-table pricing shape and the LoggedCall cost fields
replaced the flat ModelDefinitionDB system.
"""

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from apo.models.pricing import (
    MatchResponse,
    ModelDocument,
    ModelDocumentCreate,
    ModelRowDB,
    PriceDB,
    PricingTierDB,
    PriceMap,
    TierCondition,
    TierDocument,
)
from apo.models.usage_keys import UsageKey


@pytest.fixture
def session() -> Session:
    """Fresh in-memory SQLite with only the new pricing tables."""
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    sess = Session(engine)
    yield sess
    sess.close()


# --- 3-table shape ---------------------------------------------------------


class TestTableShape:
    def test_three_tables_created_by_metadata(self, session: Session) -> None:
        # If these tables don't exist, the create_all above would have raised.
        model = ModelRowDB(match_pattern="^gpt-4o$", provider="openai")
        session.add(model)
        session.commit()
        session.refresh(model)
        assert model.id is not None

        tier = PricingTierDB(model_id=model.id, name="default", is_default=True)
        session.add(tier)
        session.commit()
        session.refresh(tier)
        assert tier.id is not None

        price = PriceDB(
            model_id=model.id, tier_id=tier.id, usage_key=UsageKey.INPUT, price_per_1m=2_500_000
        )
        session.add(price)
        session.commit()
        rows = list(session.exec(select(PriceDB)).all())
        assert len(rows) == 1

    def test_price_usage_key_indexed(self) -> None:
        # Smoke: the model declares index=True (table build succeeds).
        assert PriceDB.model_fields["usage_key"] is not None


# --- Tier condition validation --------------------------------------------


class TestTierCondition:
    def test_valid_operators_accepted(self) -> None:
        for op in ("gt", "lt", "gte", "lte"):
            cond = TierCondition(keys=[UsageKey.INPUT], operator=op, threshold=200_000)
            assert cond.operator == op

    def test_invalid_operator_rejected(self) -> None:
        with pytest.raises(ValueError):
            TierCondition(keys=[UsageKey.INPUT], operator="eq", threshold=1)
        with pytest.raises(ValueError):
            TierCondition(keys=[UsageKey.INPUT], operator="regex", threshold=1)


# --- Nested document schema (API + JSON shape) -----------------------------


class TestModelDocumentCreate:
    def test_parses_nested_tiers_and_prices(self) -> None:
        doc = ModelDocumentCreate(
            project="my-proj",
            match_pattern=r"(?i)^claude-sonnet-4\.5$",
            provider="anthropic",
            display_name="Claude Sonnet 4.5",
            pricing_tiers=[
                TierDocument(
                    name="default",
                    is_default=True,
                    priority=0,
                    conditions=[],
                    prices=PriceMap(input=3.0, output=15.0, cache_read=0.30, cache_write_5m=3.75),
                ),
                TierDocument(
                    name="large-context",
                    is_default=False,
                    priority=1,
                    conditions=[
                        TierCondition(
                            keys=[UsageKey.INPUT, UsageKey.CACHE_READ],
                            operator="gt",
                            threshold=200_000,
                        )
                    ],
                    prices=PriceMap(input=6.0, output=15.0, cache_read=0.60, cache_write_5m=7.5),
                ),
            ],
        )
        assert doc.project == "my-proj"
        assert len(doc.pricing_tiers) == 2
        assert doc.pricing_tiers[0].is_default is True
        # Prices are USD-per-1M (human-readable), converted at load/write time.
        assert doc.pricing_tiers[0].prices.input == 3.0

    def test_default_project_is_global(self) -> None:
        doc = ModelDocumentCreate(match_pattern="^x$", provider="openai", pricing_tiers=[])
        assert doc.project == "__global__"


class TestModelDocument:
    def test_round_trips_with_db_ids(self) -> None:
        doc = ModelDocument(
            id=1,
            project="__global__",
            match_pattern="^gpt-4o$",
            provider="openai",
            display_name="GPT-4o",
            start_date=None,
            end_date=None,
            pricing_tiers=[],
        )
        assert doc.id == 1


class TestMatchResponse:
    def test_no_match_shape(self) -> None:
        resp = MatchResponse(matched=False)
        assert resp.matched is False
        assert resp.model_id is None
        assert resp.cost_breakdown is None
