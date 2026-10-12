"""Typed errors shared across the schedule dispatch path.

Deliberately dependency-free: ``adaptive_scheduler``, ``agent_task_runner``,
and ``execution_queue`` import each other only lazily to avoid import
cycles, so an error type raised in one and caught in another needs a leaf
module both can import at module level.
"""


class SelectionEmptyError(ValueError):
    """Raised when a schedule's selection resolves to no catalog tasks.

    Subclasses :class:`ValueError` so existing handlers (routes mapping it
    to a 4xx, callers surfacing the message) keep catching it. The schedule
    dispatcher pauses a schedule with ``selection_empty`` on this error —
    and on nothing else: a plain ``ValueError`` (unknown timezone,
    stale-inventory race) must not be reported as an empty selection.
    """
