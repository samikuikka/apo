"""Aggregation of agent-task runs into stats summaries.

Single source of truth for the per-task / per-project roll-up used by both
the project-scoped and discovery-scoped routes. Previously this computation
was duplicated (and kept in sync by a docstring promise) across
``routes/projects.py`` and ``routes/agent_task_runs.py``; both now delegate
here so the numbers cannot drift.
"""

from __future__ import annotations

from ..models.db import AgentTaskRunDB
from ..models.schemas import AgentTaskRunStats


def compute_run_stats(runs: list[AgentTaskRunDB]) -> AgentTaskRunStats:
    """Aggregate a set of task runs into a stats summary.

    Handles an empty list (returns all-zero / None fields). Callers that
    already guard against empty input get the same result either way.
    """
    total = len(runs)

    completed = [r for r in runs if r.completed_at and r.started_at]
    durations: list[float] = []
    for run in completed:
        assert run.completed_at is not None and run.started_at is not None
        ms = (run.completed_at - run.started_at).total_seconds() * 1000
        if ms >= 0:
            durations.append(ms)

    passed = sum(1 for r in runs if r.status == "passed")
    failed = sum(1 for r in runs if r.status == "failed")
    errored = sum(1 for r in runs if r.status == "error")

    total_checks = 0
    passed_checks = 0
    for r in runs:
        if r.checks_json:
            for check in r.checks_json:
                total_checks += 1
                if check.get("pass"):
                    passed_checks += 1

    costs = [r.total_cost for r in runs if r.total_cost is not None]
    latest = runs[0] if runs else None

    return AgentTaskRunStats(
        total_runs=total,
        passed_runs=passed,
        failed_runs=failed,
        errored_runs=errored,
        pass_rate=round(passed / total, 2) if total > 0 else 0.0,
        avg_duration_ms=round(sum(durations) / len(durations)) if durations else None,
        last_run_at=latest.started_at if latest else None,
        last_run_status=latest.status if latest else None,
        last_run_passed=latest.pass_result if latest else None,
        total_checks=total_checks,
        checks_pass_rate=round(passed_checks / total_checks, 2)
        if total_checks > 0
        else 0.0,
        avg_cost=round(sum(costs) / len(costs), 4) if costs else None,
    )
