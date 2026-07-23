# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownLambdaType=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false

"""SPEC-136 regression tests for the cost-application seam (audit P1 #1, #2).

Covers:
  - provided_cost overwrites cost (not just fills a null) — audit P1 #2
  - a partial update (no usage) does not erase a frozen cost — audit P1 #1
  - provided_cost wins over compute even when usage is present
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine

from apo.models.db import LoggedCallDB
from apo.services.pricing.apply import apply_cost_to_call
from apo.services.pricing.loader import load_default_prices

NOW = datetime(2026, 7, 23, tzinfo=timezone.utc)


@pytest.fixture
def session() -> Session:
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    sess = Session(eng)
    load_default_prices(sess)
    yield sess
    sess.close()


def _make_call(**kwargs: object) -> LoggedCallDB:
    defaults: dict[str, object] = {
        "id": "t1", "project": "default", "task_id": "", "model": "gpt-4o",
        "observation_type": "GENERATION", "created_at": NOW,
    }
    defaults.update(kwargs)
    return LoggedCallDB(**defaults)  # type: ignore[arg-type]


class TestProvidedCostWins:
    def test_provided_cost_overwrites_existing_cost(self, session: Session) -> None:
        """Audit P1 #2: updating provided_cost must overwrite cost, not leave the
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
        """Audit P1 #1: an output-only update (no usage) must not erase a
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
