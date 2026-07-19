# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false

import asyncio
import pytest
from dataclasses import dataclass
from sqlmodel import Session, text
from apo.db import engine, init_db
from apo.models.pricing import ModelDefinitionCreate
from apo.routes.models import create_model, list_models, match_model, seed_defaults


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    # Clear the default models that init_db seeds so tests start clean.
    with Session(engine) as session:
        session.execute(text("DELETE FROM model_definitions"))
        session.commit()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM model_definitions"))
        session.commit()


@dataclass
class _DirectResponse:
    status_code: int
    payload: object

    def json(self) -> object:
        return self.payload


class _ModelsClient:
    def post(self, url: str, *, json: dict[str, object] | None = None) -> _DirectResponse:
        with Session(engine) as session:
            if url == "/api/v1/models":
                payload = asyncio.run(
                    create_model(ModelDefinitionCreate.model_validate(json or {}), session)
                )
                return _DirectResponse(201, payload.model_dump(mode="json"))
            if url == "/api/v1/models/seed-defaults":
                payload = asyncio.run(seed_defaults(project="__global__", session=session))
                return _DirectResponse(200, payload)
        raise AssertionError(f"Unhandled POST url: {url}")

    def get(
        self,
        url: str,
        *,
        params: dict[str, object] | None = None,
    ) -> _DirectResponse:
        with Session(engine) as session:
            query = params or {}
            if url == "/api/v1/models":
                payload = asyncio.run(list_models(project="__global__", session=session))
                return _DirectResponse(
                    200,
                    [item.model_dump(mode="json") for item in payload],
                )
            if url == "/api/v1/models/match":
                payload = asyncio.run(
                    match_model(
                        model=str(query["model"]),
                        prompt_tokens=(
                            int(query["prompt_tokens"])
                            if "prompt_tokens" in query
                            else None
                        ),
                        completion_tokens=(
                            int(query["completion_tokens"])
                            if "completion_tokens" in query
                            else None
                        ),
                        project="__global__",
                        session=session,
                    )
                )
                return _DirectResponse(200, payload.model_dump(mode="json"))
        raise AssertionError(f"Unhandled GET url: {url}")


@pytest.fixture(name="client")
def models_client():
    return _ModelsClient()


def _seed_model_via_api(client: _ModelsClient) -> None:
    client.post(
        "/api/v1/models",
        json={
            "model_name": "gpt-4o",
            "match_pattern": "gpt-4o.*",
            "provider": "openai",
            "input_price": 2.50,
            "output_price": 10.00,
        },
    )


class TestListModels:
    def test_returns_empty_when_no_models(self, client: _ModelsClient):
        response = client.get("/api/v1/models")
        assert response.status_code == 200
        assert response.json() == []

    def test_returns_seeded_models(self, client: _ModelsClient):
        _seed_model_via_api(client)
        response = client.get("/api/v1/models")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["model_name"] == "gpt-4o"


class TestCreateModel:
    def test_create_model_definition(self, client: _ModelsClient):
        payload = {
            "model_name": "claude-3.5-sonnet",
            "match_pattern": "claude-3.5-sonnet.*",
            "provider": "anthropic",
            "input_price": 3.00,
            "output_price": 15.00,
        }
        response = client.post("/api/v1/models", json=payload)
        assert response.status_code == 201
        data = response.json()
        assert data["model_name"] == "claude-3.5-sonnet"
        assert data["provider"] == "anthropic"
        assert data["input_price"] == 3.00

    def test_create_with_cached_price(self, client: _ModelsClient):
        payload = {
            "model_name": "gpt-4o",
            "match_pattern": "gpt-4o.*",
            "provider": "openai",
            "input_price": 2.50,
            "output_price": 10.00,
            "cached_input_price": 1.25,
        }
        response = client.post("/api/v1/models", json=payload)
        assert response.status_code == 201
        assert response.json()["cached_input_price"] == 1.25


class TestSeedDefaults:
    def test_seed_defaults_creates_models(self, client: _ModelsClient):
        response = client.post("/api/v1/models/seed-defaults")
        assert response.status_code == 200
        data = response.json()
        assert data["created"] == 16

    def test_seed_defaults_idempotent(self, client: _ModelsClient):
        client.post("/api/v1/models/seed-defaults")
        response = client.post("/api/v1/models/seed-defaults")
        assert response.json()["created"] == 0


class TestMatchModel:
    def test_match_known_model_with_tokens(self, client: _ModelsClient):
        _seed_model_via_api(client)
        response = client.get(
            "/api/v1/models/match",
            params={"model": "gpt-4o-2024-08-06", "prompt_tokens": 1000, "completion_tokens": 500},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["matched"] is True
        assert data["model_name"] == "gpt-4o"
        assert data["calculated_cost"] is not None
        assert data["calculated_cost"] > 0

    def test_match_unknown_model(self, client: _ModelsClient):
        response = client.get(
            "/api/v1/models/match",
            params={"model": "unknown-xyz"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["matched"] is False
        assert data["calculated_cost"] is None

    def test_match_without_tokens(self, client: _ModelsClient):
        _seed_model_via_api(client)
        response = client.get(
            "/api/v1/models/match",
            params={"model": "gpt-4o"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["matched"] is True
        assert data["calculated_cost"] is None
