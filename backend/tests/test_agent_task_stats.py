"""Unit tests for ``compute_run_stats``.

This is the single source of truth for the per-task stats roll-up that
drives the dashboard's pass-rate bar. The ``pass_rate`` contract (a 0–1
fraction where ``0`` means "ran but all failed" and the empty case never
reaches here) was previously untested; these tests lock it in so the
frontend's ``PassBar`` can rely on ``0`` meaning "show 0%", not "hide".
"""

from datetime import datetime, timedelta, timezone

from apo.models.db import AgentTaskRunDB
from apo.services.agent_task_stats import compute_run_stats

_NOW = datetime(2026, 7, 18, 12, 0, 0, tzinfo=timezone.utc)


def _run(
    *,
    id: str,
    status: str,
    pass_result: bool | None = None,
    started_at: datetime | None = _NOW,
    completed_at: datetime | None = _NOW,
    total_cost: float | None = None,
    checks: list[dict[str, object]] | None = None,
) -> AgentTaskRunDB:
    return AgentTaskRunDB(
        id=id,
        batch_run_id="batch-x",
        task_id="some-task",
        task_path="/tmp/some-task",
        status=status,
        pass_result=pass_result,
        started_at=started_at,
        completed_at=completed_at,
        total_cost=total_cost,
        checks_json=checks,
    )


def test_pass_rate_is_zero_fraction_for_all_failing_runs() -> None:
    # The case the dashboard used to hide behind an em-dash: the task ran,
    # every run failed. pass_rate must be 0.0 (not None, not omitted) so the
    # frontend can distinguish "ran but all failed" from "no data".
    runs = [
        _run(id="1", status="failed", pass_result=False),
        _run(id="2", status="failed", pass_result=False),
        _run(id="3", status="error", pass_result=False),
    ]
    stats = compute_run_stats(runs)
    assert stats.total_runs == 3
    assert stats.passed_runs == 0
    assert stats.failed_runs == 2
    assert stats.errored_runs == 1
    assert stats.pass_rate == 0.0


def test_pass_rate_mixed_outcomes_rounded_to_two_decimals() -> None:
    runs = [
        _run(id="1", status="passed", pass_result=True),
        _run(id="2", status="passed", pass_result=True),
        _run(id="3", status="failed", pass_result=False),
        _run(id="4", status="error", pass_result=False),
    ]
    stats = compute_run_stats(runs)
    assert stats.total_runs == 4
    assert stats.passed_runs == 2
    assert stats.failed_runs == 1
    assert stats.errored_runs == 1
    assert stats.pass_rate == 0.5


def test_pass_rate_perfect_when_all_passed() -> None:
    runs = [
        _run(id="1", status="passed", pass_result=True),
        _run(id="2", status="passed", pass_result=True),
    ]
    stats = compute_run_stats(runs)
    assert stats.pass_rate == 1.0
    assert stats.passed_runs == 2
    assert stats.failed_runs == 0
    assert stats.errored_runs == 0


def test_pass_rate_counts_only_status_passed_not_pass_result() -> None:
    # compute_run_stats keys off r.status == "passed", not r.pass_result.
    # A run whose pass_result is True but status is not "passed" must not
    # inflate the rate.
    runs = [
        _run(id="1", status="passed", pass_result=True),
        _run(id="2", status="failed", pass_result=True),
    ]
    stats = compute_run_stats(runs)
    assert stats.pass_rate == 0.5


def test_avg_duration_averages_only_completed_runs_in_ms() -> None:
    runs = [
        _run(
            id="1",
            status="passed",
            started_at=_NOW,
            completed_at=_NOW + timedelta(milliseconds=1_000),
        ),
        _run(
            id="2",
            status="passed",
            started_at=_NOW,
            completed_at=_NOW + timedelta(milliseconds=3_000),
        ),
        # No completed_at — must be excluded from the average.
        _run(id="3", status="error", completed_at=None),
    ]
    stats = compute_run_stats(runs)
    assert stats.avg_duration_ms == 2_000


def test_avg_cost_averages_runs_with_a_cost() -> None:
    runs = [
        _run(id="1", status="passed", total_cost=0.0020),
        _run(id="2", status="passed", total_cost=0.0040),
        _run(id="3", status="failed", total_cost=None),
    ]
    stats = compute_run_stats(runs)
    assert stats.avg_cost == 0.003


def test_checks_pass_rate_aggregates_individual_checks() -> None:
    runs = [
        _run(
            id="1",
            status="passed",
            checks=[{"pass": True}, {"pass": False}],
        ),
        _run(
            id="2",
            status="passed",
            checks=[{"pass": True}],
        ),
    ]
    stats = compute_run_stats(runs)
    assert stats.total_checks == 3
    assert stats.checks_pass_rate == round(2 / 3, 2)


def test_empty_run_list_returns_all_zero_defaults() -> None:
    stats = compute_run_stats([])
    assert stats.total_runs == 0
    assert stats.pass_rate == 0.0
    assert stats.avg_duration_ms is None
    assert stats.avg_cost is None
    assert stats.last_run_status is None


def test_last_run_status_takes_first_run_in_input_order() -> None:
    # compute_run_stats treats runs[0] as the latest; ordering is the
    # caller's responsibility. Document that contract here.
    runs = [
        _run(id="latest", status="failed", pass_result=False),
        _run(id="older", status="passed", pass_result=True),
    ]
    stats = compute_run_stats(runs)
    assert stats.last_run_status == "failed"
    assert stats.last_run_passed is False
