# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false

import pytest
from typing import cast

from sqlmodel import Session, text
from apo.db import engine, init_db
from apo.models.pricing import ModelDefinitionDB
from apo.services.cost_calculation import (
    calculate_cost,
    calculate_cost_for_model,
    find_matching_model,
    seed_default_models,
)


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM model_definitions"))
        session.commit()


def _create_model(session: Session, **kwargs: object) -> ModelDefinitionDB:
    defaults: dict[str, str | float | None] = {
        "project": "__global__",
        "model_name": "gpt-4o",
        "match_pattern": r"gpt-4o.*",
        "provider": "openai",
        "input_price": 2.50,
        "output_price": 10.00,
    }
    for key, value in kwargs.items():
        defaults[key] = cast(str | float | None, value)
    model = ModelDefinitionDB(
        project=cast(str, defaults["project"]),
        model_name=cast(str, defaults["model_name"]),
        match_pattern=cast(str, defaults["match_pattern"]),
        provider=cast(str, defaults["provider"]),
        input_price=cast(float, defaults["input_price"]),
        output_price=cast(float, defaults["output_price"]),
        cached_input_price=cast(float | None, defaults.get("cached_input_price")),
    )
    session.add(model)
    session.commit()
    session.refresh(model)
    return model


class TestCalculateCost:
    def test_known_model_calculates_correct_cost(self):
        model = ModelDefinitionDB(
            model_name="gpt-4o",
            match_pattern=r"gpt-4o.*",
            provider="openai",
            input_price=2.50,
            output_price=10.00,
        )
        cost = calculate_cost(model, prompt_tokens=1000, completion_tokens=500)
        expected = (1000 * 2.50 + 500 * 10.00) / 1_000_000
        assert cost == round(expected, 8)

    def test_returns_none_without_tokens(self):
        model = ModelDefinitionDB(
            model_name="gpt-4o",
            match_pattern=r"gpt-4o.*",
            provider="openai",
            input_price=2.50,
            output_price=10.00,
        )
        assert calculate_cost(model, None, 500) is None
        assert calculate_cost(model, 1000, None) is None

    def test_cached_token_pricing(self):
        model = ModelDefinitionDB(
            model_name="gpt-4o",
            match_pattern=r"gpt-4o.*",
            provider="openai",
            input_price=2.50,
            output_price=10.00,
            cached_input_price=1.25,
        )
        cost = calculate_cost(model, 1000, 500, cached_tokens=400)
        input_cost = 600 * 2.50 + 400 * 1.25
        output_cost = 500 * 10.00
        expected = (input_cost + output_cost) / 1_000_000
        assert cost == round(expected, 8)

    def test_zero_tokens_produces_zero_cost(self):
        model = ModelDefinitionDB(
            model_name="gpt-4o",
            match_pattern=r"gpt-4o.*",
            provider="openai",
            input_price=2.50,
            output_price=10.00,
        )
        assert calculate_cost(model, 0, 0) == 0.0


class TestFindMatchingModel:
    def test_regex_matching_works(self):
        with Session(engine) as session:
            _create_model(session, match_pattern=r"gpt-4o.*")
            match = find_matching_model(session, "gpt-4o-2024-08-06")
            assert match is not None
            assert match.model_name == "gpt-4o"

    def test_exact_match(self):
        with Session(engine) as session:
            _create_model(session)
            match = find_matching_model(session, "gpt-4o")
            assert match is not None

    def test_unknown_model_returns_none(self):
        with Session(engine) as session:
            _create_model(session)
            assert find_matching_model(session, "unknown-model-xyz") is None

    def test_case_insensitive_matching(self):
        with Session(engine) as session:
            _create_model(session, match_pattern=r"gpt-4o.*")
            match = find_matching_model(session, "GPT-4O-MINI")
            assert match is not None


class TestSeedDefaults:
    def test_seed_creates_16_model_definitions(self):
        with Session(engine) as session:
            # init_db() (called by setup_database) already seeds defaults,
            # so verify the count directly rather than re-seeding.
            from sqlmodel import select
            models = session.exec(select(ModelDefinitionDB)).all()
            assert len(models) == 16

    def test_seed_idempotent(self):
        with Session(engine) as session:
            seed_default_models(session)
            created = seed_default_models(session)
            assert created == 0


class TestCalculateCostForModel:
    def test_returns_none_for_unknown_model(self):
        with Session(engine) as session:
            result = calculate_cost_for_model(session, "unknown", 100, 50)
            assert result is None

    def test_returns_cost_for_known_model(self):
        with Session(engine) as session:
            _create_model(session, input_price=2.50, output_price=10.00)
            cost = calculate_cost_for_model(session, "gpt-4o", 1000, 500)
            assert cost is not None
            assert cost > 0
