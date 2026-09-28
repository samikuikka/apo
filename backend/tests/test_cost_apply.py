# pyright: reportAny=false, reportAttributeAccessIssue=false, reportCallIssue=false, reportExplicitAny=false, reportMissingParameterType=false, reportPrivateUsage=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedImport=false

"""Regression tests for the cost-application seam.

Covers:
  - provided_cost overwrites cost (not just fills a null)
  - a partial update (no usage) does not erase a frozen cost
  - provided_cost wins over compute even when usage is present
"""

from __future__ import annotations

from typing import Any

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine

from apo.models.db import LoggedCallDB
from apo.services.pricing.apply import apply_cost_to_call
from apo.services.pricing.compute import compute_cost
from apo.services.pricing.loader import load_default_prices

NOW = datetime(2026, 7, 23, tzinfo=timezone.utc)


@pytest.fixture
def session() -> Session:  # pyright: ignore[reportInvalidTypeForm]
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    sess = Session(eng)
    load_default_prices(sess)
    yield sess
    sess.close()


def _make_call(**kwargs: Any) -> LoggedCallDB:
    defaults: dict[str, Any] = {
        "id": "t1", "project": "default", "task_id": "", "model": "gpt-4o",
        "observation_type": "GENERATION", "created_at": NOW,
    }
    defaults.update(kwargs)
    return LoggedCallDB(**defaults)  # type: ignore[arg-type]


class TestProvidedCostWins:
    def test_provided_cost_overwrites_existing_cost(self, session: Session) -> None:
        """Regression: updating provided_cost must overwrite cost, not leave the
        old computed cost while marking provenance 'provided'."""
        call = _make_call(cost=7_500_000, cost_provenance="computed")
        session.add(call)
        session.commit()
        # Now the SDK reports a provided cost of 999.
        call.provided_cost = 999
        apply_cost_to_call(
            session, call, attributes={}, project="default", at_time=NOW,
        )
        assert call.cost == 999  # overwritten, NOT 7_500_000
        assert call.cost_provenance == "provided"

    def test_provided_cost_wins_over_compute(self, session: Session) -> None:
        """Even with full usage present, a provided cost freezes verbatim."""
        call = _make_call(provided_cost=42)
        apply_cost_to_call(
            session, call,
            attributes={"gen_ai.usage.input_tokens": 1_000_000, "gen_ai.usage.output_tokens": 500_000},
            project="default", at_time=NOW,
        )
        assert call.cost == 42
        assert call.cost_provenance == "provided"


class TestUpdateDoesNotEraseCost:
    def test_partial_update_no_usage_keeps_frozen_cost(self, session: Session) -> None:
        """Regression: an output-only update (no usage) must not erase a
        previously-computed cost or raw_usage."""
        call = _make_call(
            cost=7_500_000,
            cost_breakdown={"input": 2_500_000, "output": 5_000_000},
            raw_usage={"input": 1_000_000, "output": 500_000},
            cost_provenance="computed",
        )
        session.add(call)
        session.commit()
        # An update patch with NO usage fields (e.g. just end_time/latency).
        apply_cost_to_call(
            session, call, attributes={}, project="default", at_time=NOW, is_update=True,
        )
        assert call.cost == 7_500_000  # NOT erased to 0
        assert call.raw_usage == {"input": 1_000_000, "output": 500_000}  # NOT nulled
        assert call.cost_provenance == "computed"

    def test_fresh_ingest_with_no_usage_yields_no_cost(self, session: Session) -> None:
        """Fresh ingest (is_update=False) with no usage legitimately means no cost."""
        call = _make_call()
        apply_cost_to_call(
            session, call, attributes={}, project="default", at_time=NOW,
        )
        assert call.cost is None
        assert call.cost_provenance is None


class TestUnpricedModelSurfacing:
    def test_usage_with_unpriced_model_marked_unpriced(self, session: Session) -> None:
        """Issue #57: a model with usage but no pricing era must be marked
        'unpriced' (queryable: WHERE cost_provenance='unpriced'), not silently
        left at null — the only way to notice a missing pricing entry."""
        call = _make_call(model="some-unpriced-model")
        session.add(call)
        session.commit()
        apply_cost_to_call(
            session, call,
            attributes={
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 50,
            },
            project="default",
            at_time=NOW,
        )
        assert call.cost is None
        assert call.cost_provenance == "unpriced"
        # raw_usage is still stored so a later reprice can back-fill the cost.
        assert call.raw_usage == {"input": 100, "output": 50}


class TestGeminiFlashLitePricing:
    def test_google_prefixed_flash_lite_is_priced(self, session: Session) -> None:
        """The example agent's default model used to be google/gemini-2.5-flash-lite
        (OpenRouter). It was unpriced — no flash-lite entry AND the
        'google/' router prefix never matched the prefix-less patterns. The
        flash-lite entry plus the prefix-stripping fallback now price it."""
        result = compute_cost(
            session,
            "google/gemini-2.5-flash-lite",
            {"input": 1_000_000, "output": 500_000},
            project="default",
            at_time=NOW,
        )
        assert result is not None
        # input $0.10/1M * 1M = 100_000 micro-USD; output $0.40/1M * 0.5M = 200_000.
        assert result.breakdown == {"input": 100_000, "output": 200_000}
        assert result.total == 300_000
