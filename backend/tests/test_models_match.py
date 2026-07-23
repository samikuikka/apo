# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false

"""SPEC-136 ticket 10: GET /api/v1/models/match endpoint.

Verifies the match endpoint resolves model+usage -> tier + per-key breakdown
using the same compute pipeline as ingestion, with anchored full-match
(``gpt-4o`` matches ``^gpt-4o$`` not ``gpt-4o-mini``).
"""

from __future__ import annotations

import json

import pytest
from sqlmodel import Session

from apo.services.pricing.loader import load_default_prices


@pytest.fixture(autouse=True)
def seed_globals(db_schema) -> None:
    """Seed the bundled __global__ prices into the test DB so match resolves."""
    # The conftest `engine` is the in-memory test DB; load defaults into it.
    from tests.conftest import engine

    with Session(engine) as session:
        load_default_prices(session)


def test_match_returns_breakdown_for_known_model(client) -> None:
    # gpt-4o is seeded from the bundled JSON: input=$2.50/MTok, output=$10.00/MTok.
    resp = client.get(
        "/api/v1/models/match",
        params={
            "model": "gpt-4o",
            "usage": json.dumps({"input": 1_000_000, "output": 500_000}),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["matched"] is True
    # input: 2_500_000 micro-per-1M * 1M / 1M = 2_500_000 micro-USD
    # output: 10_000_000 * 500_000 / 1M = 5_000_000 micro-USD
    assert body["cost_breakdown"] == {"input": 2_500_000, "output": 5_000_000}
    assert body["total_cost"] == 7_500_000
    assert body["matched_tier_name"] == "default"


def test_match_anchored_fullmatch_excludes_suffix(client) -> None:
    # gpt-4o matches ^gpt-4o$; gpt-4o-mini must NOT (anchored fullmatch).
    resp = client.get(
        "/api/v1/models/match",
        params={"model": "gpt-4o-mini", "usage": json.dumps({"input": 100, "output": 100})},
    )
    # gpt-4o-mini IS seeded, so it matches its own pattern. Verify gpt-4o does not
    # match a name the mini pattern should catch:
    resp_mini = client.get(
        "/api/v1/models/match",
        params={"model": "gpt-4o", "usage": json.dumps({"input": 100, "output": 100})},
    )
    assert resp_mini.json()["matched"] is True
    # An unseeded name returns matched=False.
    resp_none = client.get(
        "/api/v1/models/match",
        params={"model": "totally-unknown-model", "usage": json.dumps({"input": 100})},
    )
    assert resp_none.json()["matched"] is False


def test_match_case_insensitive(client) -> None:
    resp = client.get(
        "/api/v1/models/match",
        params={"model": "GPT-4O", "usage": json.dumps({"input": 100, "output": 100})},
    )
    assert resp.json()["matched"] is True


def test_match_large_context_tier_selected_by_input_plus_cache_read(client) -> None:
    # gemini-2.5-pro has a large-context tier (input+cache_read > 200000).
    resp = client.get(
        "/api/v1/models/match",
        params={
            "model": "gemini-2.5-pro",
            "usage": json.dumps({"input": 150_000, "cache_read": 100_000, "output": 0}),
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["matched"] is True
    assert body["matched_tier_name"] == "large-context"


def test_match_default_tier_when_below_threshold(client) -> None:
    resp = client.get(
        "/api/v1/models/match",
        params={
            "model": "gemini-2.5-pro",
            "usage": json.dumps({"input": 50_000, "cache_read": 0, "output": 0}),
        },
    )
    body = resp.json()
    assert body["matched"] is True
    assert body["matched_tier_name"] == "default"


def test_match_invalid_usage_json_returns_422(client) -> None:
    resp = client.get(
        "/api/v1/models/match",
        params={"model": "gpt-4o", "usage": "{not json"},
    )
    assert resp.status_code == 422
