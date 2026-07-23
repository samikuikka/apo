# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownLambdaType=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false

"""SPEC-136 ticket 12: re-pricing service.

Inline streamed-batch reprice. Reads raw_usage + current tiers, recomputes via
compute_cost, overwrites cost in place when not dry_run. Provided-cost calls
are skipped; pre-migration calls (no raw_usage) are skipped + reported.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from apo.models.db import LoggedCallDB
from apo.models.pricing import ModelRowDB, PriceDB, PricingTierDB
from apo.models.usage_keys import UsageKey
from apo.services.pricing.compute import compute_cost
from apo.services.pricing.loader import load_default_prices
from apo.services.reprice import reprice_calls

NOW = datetime(2026, 7, 23, tzinfo=timezone.utc)


@pytest.fixture
def session() -> Session:
    eng = create_engine("sqlite://")
    SQLModel.metadata.create_all(eng)
    sess = Session(eng)
    # Seed bundled globals so gpt-4o etc. resolve.
    load_default_prices(sess)
    yield sess
    sess.close()


def _make_call(
    session: Session,
    *,
    span_id: str,
    model: str = "gpt-4o",
    raw_usage: dict[str, int] | None = None,
    provenance: str | None = "computed",
    cost: int | None = None,
    provided_cost: int | None = None,
    run_id: str | None = None,
) -> LoggedCallDB:
    call = LoggedCallDB(
        id=span_id,
        project="default",
        task_id="",
        run_id=run_id,
        created_at=NOW,
        model=model,
        observation_type="GENERATION",
        raw_usage=raw_usage,
        cost_provenance=provenance,
        cost=cost,
        provided_cost=provided_cost,
    )
    session.add(call)
    session.commit()
    return call


class TestRepriceScope:
    def test_reprices_computed_calls(self, session: Session) -> None:
        # A computed call with stale cost; gpt-4o input=$2.50, output=$10.00.
        call = _make_call(
            session,
            span_id="c1",
            raw_usage={"input": 1_000_000, "output": 500_000},
            cost=1,  # stale/wrong
            provenance="computed",
        )
        summary = reprice_calls(session)
        session.refresh(call)
        # Recomputed: input 2_500_000 + output 5_000_000 = 7_500_000.
        assert call.cost == 7_500_000
        assert call.cost_breakdown == {"input": 2_500_000, "output": 5_000_000}
        assert summary["repriced"] == 1

    def test_skips_provided_cost_calls(self, session: Session) -> None:
        _make_call(
            session,
            span_id="c2",
            raw_usage={"input": 1_000_000, "output": 500_000},
            cost=999,
            provided_cost=999,
            provenance="provided",
        )
        summary = reprice_calls(session)
        assert summary["repriced"] == 0
        assert summary["skipped_provided"] == 1

    def test_skips_pre_migration_calls_without_raw_usage(self, session: Session) -> None:
        # A pre-migration call: cost carried forward, but no raw_usage to reprice.
        _make_call(
            session,
            span_id="c3",
            raw_usage=None,
            cost=750,  # micro-USD carried from migration
            provenance=None,
        )
        summary = reprice_calls(session)
        assert summary["repriced"] == 0
        assert summary["skipped_no_usage"] == 1

    def test_skips_no_match_calls(self, session: Session) -> None:
        _make_call(
            session,
            span_id="c4",
            model="totally-unknown-model",
            raw_usage={"input": 1000, "output": 1000},
            provenance="computed",
        )
        summary = reprice_calls(session)
        assert summary["repriced"] == 0
        assert summary["skipped_no_match"] == 1

    def test_dry_run_commits_nothing(self, session: Session) -> None:
        call = _make_call(
            session,
            span_id="c5",
            raw_usage={"input": 1_000_000, "output": 500_000},
            cost=1,
            provenance="computed",
        )
        original = call.cost
        summary = reprice_calls(session, dry_run=True)
        session.refresh(call)
        assert summary["repriced"] == 1
        assert call.cost == original  # unchanged

    def test_idempotent(self, session: Session) -> None:
        """Repricing an already-correct call yields the same value."""
        _make_call(
            session,
            span_id="c6",
            raw_usage={"input": 1_000_000, "output": 500_000},
            provenance="computed",
        )
        s1 = reprice_calls(session)
        s2 = reprice_calls(session)
        assert s1["repriced"] == 1
        assert s2["repriced"] == 1  # recomputed to the same value


class TestRepriceFilters:
    def test_filter_by_project(self, session: Session) -> None:
        _make_call(session, span_id="p1", raw_usage={"input": 100, "output": 100}, provenance="computed")
        # Different project.
        call2 = LoggedCallDB(
            id="p2", project="other", task_id="", created_at=NOW, model="gpt-4o",
            observation_type="GENERATION", raw_usage={"input": 100, "output": 100},
            cost_provenance="computed",
        )
        session.add(call2)
        session.commit()
        summary = reprice_calls(session, project="default")
        assert summary["repriced"] == 1  # only the default-project call

    def test_filter_by_since_until(self, session: Session) -> None:
        old = LoggedCallDB(
            id="old", project="default", task_id="",
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc), model="gpt-4o",
            observation_type="GENERATION", raw_usage={"input": 100, "output": 100},
            cost_provenance="computed",
        )
        new = LoggedCallDB(
            id="new", project="default", task_id="",
            created_at=datetime(2026, 6, 1, tzinfo=timezone.utc), model="gpt-4o",
            observation_type="GENERATION", raw_usage={"input": 100, "output": 100},
            cost_provenance="computed",
        )
        session.add_all([old, new])
        session.commit()
        summary = reprice_calls(
            session, since=datetime(2026, 5, 1, tzinfo=timezone.utc)
        )
        assert summary["repriced"] == 1  # only the June call


class TestRepriceNetDelta:
    def test_net_delta_reported(self, session: Session) -> None:
        # Stale cost 100 -> recomputed 7_500_000; net delta = +7_499_900.
        _make_call(
            session,
            span_id="d1",
            raw_usage={"input": 1_000_000, "output": 500_000},
            cost=100,
            provenance="computed",
        )
        summary = reprice_calls(session)
        assert summary["net_delta"] == 7_500_000 - 100
