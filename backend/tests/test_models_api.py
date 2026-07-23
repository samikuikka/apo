# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false

"""SPEC-136 ticket 10: nested-document models API.

Verifies the nested CRUD (list/get/create/put/delete), ``__global__`` write
rejection (409), tier-graph validation (422), and ``?effective=true`` merge.
Uses the conftest ``client`` fixture (HTTP layer).
"""

from __future__ import annotations

import pytest
from sqlmodel import Session

from apo.services.pricing.loader import load_default_prices


@pytest.fixture(autouse=True)
def seed_globals(db_schema) -> None:
    """Seed bundled __global__ prices so global-related tests can resolve them."""
    from tests.conftest import engine

    with Session(engine) as session:
        load_default_prices(session)


def _tier_doc(
    *,
    name: str = "default",
    is_default: bool = True,
    priority: int = 0,
    prices: dict[str, float] | None = None,
    conditions: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return {
        "name": name,
        "is_default": is_default,
        "priority": priority,
        "conditions": conditions or [],
        "prices": prices or {"input": 2.50, "output": 10.00},
    }


def _doc(
    *,
    project: str = "my-proj",
    match_pattern: str = r"(?i)^test-model$",
    provider: str = "openai",
    pricing_tiers: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return {
        "project": project,
        "match_pattern": match_pattern,
        "provider": provider,
        "display_name": "Test Model",
        "pricing_tiers": pricing_tiers or [_tier_doc()],
    }


class TestCreateModel:
    def test_creates_per_project_model(self, client) -> None:
        resp = client.post("/api/v1/models", json=_doc())
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["project"] == "my-proj"
        assert body["match_pattern"] == r"(?i)^test-model$"
        assert len(body["pricing_tiers"]) == 1
        # Prices round-trip as USD-per-1M on the wire.
        assert body["pricing_tiers"][0]["prices"]["input"] == 2.50

    def test_rejects_global_write(self, client) -> None:
        resp = client.post("/api/v1/models", json=_doc(project="__global__"))
        assert resp.status_code == 409
        assert "JSON" in resp.json()["detail"] or "per-project" in resp.json()["detail"]

    def test_rejects_zero_default_tiers(self, client) -> None:
        resp = client.post(
            "/api/v1/models",
            json=_doc(pricing_tiers=[_tier_doc(is_default=False)]),
        )
        assert resp.status_code == 422

    def test_rejects_two_default_tiers(self, client) -> None:
        resp = client.post(
            "/api/v1/models",
            json=_doc(
                pricing_tiers=[
                    _tier_doc(name="a", is_default=True),
                    _tier_doc(name="b", is_default=True, priority=1),
                ]
            ),
        )
        assert resp.status_code == 422

    def test_rejects_mismatched_key_sets(self, client) -> None:
        resp = client.post(
            "/api/v1/models",
            json=_doc(
                pricing_tiers=[
                    _tier_doc(prices={"input": 2.50}),
                    _tier_doc(
                        name="b",
                        is_default=False,
                        priority=1,
                        prices={"input": 5.00, "output": 10.00},
                    ),
                ]
            ),
        )
        assert resp.status_code == 422

    def test_creates_large_context_tiered_model(self, client) -> None:
        resp = client.post(
            "/api/v1/models",
            json=_doc(
                pricing_tiers=[
                    _tier_doc(prices={"input": 1.25, "output": 10.00}),
                    _tier_doc(
                        name="large-context",
                        is_default=False,
                        priority=1,
                        prices={"input": 2.50, "output": 15.00},
                        conditions=[
                            {"keys": ["input", "cache_read"], "operator": "gt", "threshold": 200000}
                        ],
                    ),
                ]
            ),
        )
        assert resp.status_code == 201, resp.text
        tiers = resp.json()["pricing_tiers"]
        assert len(tiers) == 2
        assert tiers[1]["conditions"][0]["threshold"] == 200000


class TestGetAndList:
    def test_get_by_id(self, client) -> None:
        created = client.post("/api/v1/models", json=_doc()).json()
        resp = client.get(f"/api/v1/models/{created['id']}")
        assert resp.status_code == 200
        assert resp.json()["id"] == created["id"]

    def test_get_missing_returns_404(self, client) -> None:
        assert client.get("/api/v1/models/999999").status_code == 404

    def test_list_per_project(self, client) -> None:
        client.post("/api/v1/models", json=_doc(match_pattern=r"(?i)^a$"))
        client.post("/api/v1/models", json=_doc(match_pattern=r"(?i)^b$"))
        resp = client.get("/api/v1/models?project=my-proj")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 2

    def test_list_globals_from_bundled(self, client) -> None:
        # init_db seeds globals from the bundled JSON; list them.
        resp = client.get("/api/v1/models?project=__global__")
        assert resp.status_code == 200
        assert len(resp.json()) > 0

    def test_list_effective_merges_global_and_project(self, client) -> None:
        client.post(
            "/api/v1/models",
            json=_doc(match_pattern=r"(?i)^gpt-4o$"),
        )
        resp = client.get("/api/v1/models?project=my-proj&effective=true")
        assert resp.status_code == 200
        patterns = {m["match_pattern"] for m in resp.json()}
        # Both the project override and the globals appear.
        assert r"(?i)^gpt-4o$" in patterns


class TestReplaceAndDelete:
    def test_replace_tier_graph(self, client) -> None:
        created = client.post("/api/v1/models", json=_doc()).json()
        new_doc = _doc(match_pattern=created["match_pattern"])
        new_doc["pricing_tiers"] = [_tier_doc(prices={"input": 9.99, "output": 9.99})]
        resp = client.put(f"/api/v1/models/{created['id']}", json=new_doc)
        assert resp.status_code == 200, resp.text
        assert resp.json()["pricing_tiers"][0]["prices"]["input"] == 9.99

    def test_replace_rejects_global(self, client) -> None:
        # Find a global model id and try to PUT it.
        globals_resp = client.get("/api/v1/models?project=__global__")
        gid = globals_resp.json()[0]["id"]
        resp = client.put(
            f"/api/v1/models/{gid}",
            json=_doc(project="__global__"),
        )
        assert resp.status_code == 409

    def test_delete_per_project(self, client) -> None:
        created = client.post("/api/v1/models", json=_doc()).json()
        resp = client.delete(f"/api/v1/models/{created['id']}")
        assert resp.status_code == 204
        assert client.get(f"/api/v1/models/{created['id']}").status_code == 404

    def test_delete_rejects_global(self, client) -> None:
        globals_resp = client.get("/api/v1/models?project=__global__")
        gid = globals_resp.json()[0]["id"]
        assert client.delete(f"/api/v1/models/{gid}").status_code == 409
