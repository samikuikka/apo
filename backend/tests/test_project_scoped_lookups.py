# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false

"""Cross-tenant isolation tests for project-scoped lookups (SPEC-133 M4).

Two Projects can share the same OTel trace/span id. Every read path must
return only the scoped Project's data — never the other Project's row.
These tests seed the collision and assert each lookup helper and service
function respects the Project boundary.
"""

from datetime import datetime, timezone

from sqlmodel import Session

from apo.models.db import LoggedCallDB, RunDB, RunMetricDB
from apo.metrics.aggregate import calculate_and_store_aggregate_metrics
from apo.routes.runs.navigation import get_adjacent_runs
from apo.routes.public import get_public_trace
from apo.services.projection_lookup import (
    select_call,
    select_run,
    select_run_metric,
)
from apo.services.scoring import get_scores_for_trace, record_score


def _make_run(project: str, trace_id: str = "shared-trace") -> RunDB:
    return RunDB(
        id=trace_id,
        project=project,
        task_id="t",
        flow_name="flow",
        created_at=datetime(2026, 7, 13, tzinfo=timezone.utc),
        call_count=1,
    )


def _make_call(
    project: str,
    span_id: str = "shared-span",
    run_id: str = "shared-trace",
    cost: float = 0.10,
) -> LoggedCallDB:
    return LoggedCallDB(
        id=span_id,
        project=project,
        model="gpt-4",
        task_id="t",
        run_id=run_id,
        flow_name="flow",
        created_at=datetime(2026, 7, 13, tzinfo=timezone.utc),
        observation_type="GENERATION",
        step_index=0,
        cost=cost,
        prompt_tokens=100,
        completion_tokens=50,
    )


def test_select_run_returns_only_the_scoped_project(session: Session) -> None:
    """select_run must not resolve another project's row for the same trace id."""
    session.add(_make_run("alpha"))
    session.add(_make_run("beta"))
    session.commit()

    assert select_run(session, "shared-trace", "alpha").project == "alpha"
    assert select_run(session, "shared-trace", "beta").project == "beta"
    assert select_run(session, "shared-trace", "gamma") is None


def test_select_call_returns_only_the_scoped_project(session: Session) -> None:
    """select_call must not resolve another project's row for the same span id."""
    session.add(_make_call("alpha"))
    session.add(_make_call("beta"))
    session.commit()

    assert select_call(session, "shared-span", "alpha").project == "alpha"
    assert select_call(session, "shared-span", "beta").project == "beta"


def test_aggregate_metrics_isolate_by_project(session: Session) -> None:
    """Aggregate computation sums only the scoped project's calls."""
    session.add(_make_run("alpha"))
    session.add(_make_run("beta"))
    # Alpha's call costs 0.10; beta's costs 5.00.
    session.add(_make_call("alpha", cost=0.10))
    session.add(_make_call("beta", cost=5.00))
    session.commit()

    alpha_metrics = calculate_and_store_aggregate_metrics(session, "shared-trace", "alpha")
    beta_metrics = calculate_and_store_aggregate_metrics(session, "shared-trace", "beta")

    alpha_cost = next(m for m in alpha_metrics if m.metric_name == "total_cost")
    beta_cost = next(m for m in beta_metrics if m.metric_name == "total_cost")
    assert alpha_cost.score == 0.10
    assert beta_cost.score == 5.00


def test_record_score_then_get_isolates_by_project(session: Session) -> None:
    """A score recorded under one project must not be returned for another."""
    session.add(_make_run("alpha"))
    session.commit()

    record_score(
        session,
        target=("trace", "shared-trace"),
        name="quality",
        value=0.9,
        project="alpha",
    )

    # Scoped read for alpha returns the score.
    alpha_scores = get_scores_for_trace(session, "shared-trace", "alpha")
    assert len(alpha_scores) == 1
    assert alpha_scores[0].project == "alpha"

    # Scoped read for beta returns nothing even though the trace id matches.
    beta_scores = get_scores_for_trace(session, "shared-trace", "beta")
    assert beta_scores == []


def test_select_run_metric_respects_project_scope(session: Session) -> None:
    """The idempotency lookup for scores must be project-scoped."""
    session.add(_make_run("alpha"))
    session.commit()

    record_score(
        session,
        target=("trace", "shared-trace"),
        name="faithfulness",
        value=0.8,
        project="alpha",
    )

    found_alpha = select_run_metric(session, "shared-trace", "alpha", "faithfulness", "quality")
    found_beta = select_run_metric(session, "shared-trace", "beta", "faithfulness", "quality")
    assert found_alpha is not None
    assert found_beta is None


def test_public_trace_resolves_only_the_scoped_project(session: Session) -> None:
    """The public share endpoint must return the matching project's trace."""
    run_a = _make_run("alpha")
    run_a.is_public = True
    run_b = _make_run("beta")
    run_b.is_public = True
    session.add(run_a)
    session.add(run_b)
    session.commit()

    result_alpha = get_public_trace("shared-trace", project="alpha", session=session)
    result_beta = get_public_trace("shared-trace", project="beta", session=session)
    assert result_alpha["run"]["project"] == "alpha"
    assert result_beta["run"]["project"] == "beta"


def test_adjacent_runs_stay_within_project(session: Session) -> None:
    """Navigation must not cross project boundaries for shared trace ids."""
    now = datetime(2026, 7, 13, tzinfo=timezone.utc)
    # Alpha has r1 < r2 < r3 by created_at; beta has only r2 with the same id.
    session.add(RunDB(id="r2", project="alpha", created_at=now, call_count=0))
    session.add(RunDB(id="r2", project="beta", created_at=now, call_count=0))
    session.commit()

    # Alpha's r2 should resolve to alpha's row, not beta's.
    result = get_adjacent_runs("r2", project="alpha", session=session)
    # No adjacent runs in alpha (only r2 exists there), so both are None.
    assert result.prev_id is None
    assert result.next_id is None
