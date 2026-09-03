"""Shared lifecycle constants for task runs and batch runs.

Imported by services, routes, and retirement without circular-dependency risk.
"""

from __future__ import annotations

# Task Run terminal statuses. A run in one of these states will not transition
# again (barring a manual rerun, which creates a new run).
TASK_RUN_TERMINAL: frozenset[str] = frozenset({"passed", "failed", "error"})

# Batch Run terminal statuses.
BATCH_RUN_TERMINAL: frozenset[str] = frozenset({"completed", "error", "cancelled"})


def is_batch_run_terminal(status: str) -> bool:
    """True when a batch run status is terminal."""
    return status in BATCH_RUN_TERMINAL
