"""Typed, startup-validated request-body limits for write paths.

Byte caps for the non-telemetry write routes the request-size middleware
enforces: task-run results, artifact uploads, and a shared cap covering
executor-protocol result/failure submissions, judgments, comments, run
creation, and custom metrics. Without these, one oversized SDK submission
is an out-of-memory kill on a memory-capped single-worker deployment.

Same contract as the telemetry limits: there is no disable flag — ``0``
never means unlimited. A present empty, non-integer, zero, or negative
value fails startup with a message naming the offending variable.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


class RequestBodyLimitError(RuntimeError):
    """Raised when a request-body limit env var has an invalid value."""


@dataclass(frozen=True)
class RequestBodyLimits:
    """Immutable per-route body caps enforced before buffering."""

    result_max_bytes: int
    artifact_upload_max_bytes: int
    write_max_bytes: int


# (env var name, attribute name, default)
_LIMIT_SPECS: tuple[tuple[str, str, int], ...] = (
    ("APO_RESULT_MAX_BODY_BYTES", "result_max_bytes", 10_485_760),
    ("APO_ARTIFACT_UPLOAD_MAX_BODY_BYTES", "artifact_upload_max_bytes", 104_857_600),
    ("APO_WRITE_MAX_BODY_BYTES", "write_max_bytes", 10_485_760),
)


def _parse_positive_int(name: str, raw: str | None, default: int) -> int:
    """Parse a positive base-10 integer env var.

    Missing → default. Present empty, non-integer, zero, or negative →
    :class:`RequestBodyLimitError` naming only ``name``.
    """
    if raw is None:
        return default
    raw = raw.strip()
    if raw == "":
        raise RequestBodyLimitError(f"{name} must be a positive integer (got empty)")
    try:
        value = int(raw)
    except ValueError:
        raise RequestBodyLimitError(
            f"{name} must be a positive base-10 integer (got {raw!r})"
        ) from None
    if value <= 0:
        raise RequestBodyLimitError(f"{name} must be a positive integer (got {value})")
    return value


def load_request_body_limits() -> RequestBodyLimits:
    """Load and validate request-body limits from the environment.

    Reads each variable at call time (not import time) so tests and app
    construction see current values. Raises :class:`RequestBodyLimitError`
    on the first invalid variable, naming only that variable.
    """
    fields: dict[str, int] = {}
    for env_name, attr_name, default in _LIMIT_SPECS:
        fields[attr_name] = _parse_positive_int(env_name, os.environ.get(env_name), default)
    return RequestBodyLimits(**fields)
