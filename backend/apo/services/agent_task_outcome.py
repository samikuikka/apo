"""
Agent task outcome classification.

Derives a human-actionable failure category for each task run from existing
DB columns (status + error_message + trace_persistence_status) — no migration
required. Also aggregates per-batch failure breakdowns so the UI can surface
*why* runs failed (judge failures vs. timeouts vs. trace persistence vs.
execution errors) instead of a flat "N tasks did not complete cleanly".
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from ..models.db import AgentTaskRunDB
from ..models.schemas import FailureBreakdownItem

# Outcome categories. Order matters for deterministic display + classification
# precedence (first matching category wins inside ``classify_run_outcome``).
JUDGE_FAILURE = "judge_failure"
TIMEOUT = "timeout"
TRACE_PERSISTENCE = "trace_persistence"
EXECUTION = "execution"

CATEGORY_LABELS: dict[str, str] = {
    JUDGE_FAILURE: "Judge failures",
    TIMEOUT: "Timeouts",
    TRACE_PERSISTENCE: "Trace persistence",
    EXECUTION: "Execution errors",
}

# Stable display order (also the fallback for categories not in the count map).
CATEGORY_ORDER: list[str] = [JUDGE_FAILURE, TIMEOUT, TRACE_PERSISTENCE, EXECUTION]

_TIMEOUT_PATTERN = re.compile(r"timeout|timed out|TimeoutExpired", re.IGNORECASE)


def classify_run_outcome(
    status: str,
    error_message: str | None,
    trace_persistence_status: str,
) -> str | None:
    """Return a failure category string, or ``None`` for passing/in-flight runs.

    Precedence for errored runs: timeout > trace persistence > execution. A
    timeout is the most actionable signal (it explains *why* the subprocess
    died), so it wins over a coincidental trace-persistence failure.
    """
    if status == "failed":
        return JUDGE_FAILURE

    if status != "error":
        return None

    if error_message and _TIMEOUT_PATTERN.search(error_message):
        return TIMEOUT

    if trace_persistence_status == "failed":
        return TRACE_PERSISTENCE

    return EXECUTION


def build_failure_breakdown(
    task_runs: Sequence[AgentTaskRunDB],
) -> list[FailureBreakdownItem]:
    """Aggregate failure categories for a batch, sorted by count descending.

    Returns ``FailureBreakdownItem`` instances. Categories with zero count are
    omitted. Ties break by :data:`CATEGORY_ORDER` for determinism.
    """
    counts: dict[str, int] = {category: 0 for category in CATEGORY_ORDER}

    for run in task_runs:
        category = classify_run_outcome(
            run.status,
            run.error_message,
            run.trace_persistence_status,
        )
        if category is not None:
            counts[category] = counts.get(category, 0) + 1

    rank = {category: index for index, category in enumerate(CATEGORY_ORDER)}
    items = [
        (category, count)
        for category, count in counts.items()
        if count > 0
    ]
    items.sort(key=lambda item: (-item[1], rank.get(item[0], len(rank))))

    return [
        FailureBreakdownItem(
            category=category,
            label=CATEGORY_LABELS[category],
            count=count,
        )
        for category, count in items
    ]
