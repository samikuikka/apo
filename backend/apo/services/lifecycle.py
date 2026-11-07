"""Shared lifecycle constants for task runs and batch runs.

Imported by services, routes, and retirement without circular-dependency risk.
"""

from __future__ import annotations

# Task Run terminal statuses. A run in one of these states will not transition
# again (barring a manual rerun, which creates a new run).
TASK_RUN_TERMINAL: frozenset[str] = frozenset({"passed", "failed", "error"})

# Batch Run terminal statuses. No production writer ever sets "cancelled" on a
# run or batch (a cancelled run ends "error", a fully cancelled batch ends
# "completed"); the value is tolerated so a row that somehow holds it still
# counts as settled for the destructive guards and repair sweeps.
BATCH_RUN_TERMINAL: frozenset[str] = frozenset({"completed", "error", "cancelled"})


def is_never_started_run(
    status: str, started_at: object | None, no_verdict_reason: str | None
) -> bool:
    """True for a run that ended without its task code ever starting.

    Every execution path stamps ``started_at`` when the task starts, so an
    ``error`` run without one was never claimed (queue TTL expiry), lost or
    cancelled before ``/start``, or failed before it. A judge or generations
    no-verdict means checks ran, so those are excluded.
    """
    return (
        status == "error"
        and started_at is None
        and no_verdict_reason not in ("judge", "generations")
    )


def is_batch_run_terminal(status: str) -> bool:
    """True when a batch run status is terminal."""
    return status in BATCH_RUN_TERMINAL
