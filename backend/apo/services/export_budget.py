"""Byte budgets for export renders.

Exports assemble responses in memory inside a memory-capped single-worker
backend (issue #230 G2). These budgets make one export fail with a clear
413 instead of buffering without bound and OOM-killing the container.

Same contract as the request-body limits: there is no disable flag and
``0`` never means unlimited. A present empty, non-integer, zero, or
negative value raises naming the offending variable.

Renderers here serialize section by section and account bytes as they
go, so a budget overrun fails BEFORE the whole document is materialized,
and each section is released once serialized. Peak memory is the
accumulated string plus roughly two copies of the largest section
(artifact bodies inflate 4/3 via base64 inside their section chunk).
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterable, Iterable
from dataclasses import dataclass
from typing import Any


class ExportByteLimitError(RuntimeError):
    """Raised when an export-limit env var has an invalid value."""


class ExportBudgetExceeded(Exception):
    """A render passed its byte budget; carries operator guidance."""

    def __init__(self, limit: int, guidance: str) -> None:
        super().__init__(f"Export exceeds the {limit} byte budget; {guidance}")
        self.limit = limit
        self.guidance = guidance


@dataclass(frozen=True)
class ExportByteLimits:
    """Immutable export render budgets, read per request."""

    run_export_max_bytes: int
    bulk_export_max_bytes: int


# (env var name, attribute name, default)
_LIMIT_SPECS: tuple[tuple[str, str, int], ...] = (
    # Roughly double the bulk cap: one run embeds base64 artifact bytes
    # (per-item writes cap at 100 MiB by default), the full trace calls,
    # and the verdict. A run beyond this exports only on deployments that
    # also raised the backend memory limit.
    ("APO_RUN_EXPORT_MAX_BYTES", "run_export_max_bytes", 268_435_456),
    # Preserves the hardcoded 128 MiB bulk-export budget (issue #230 G2).
    ("APO_BULK_EXPORT_MAX_BYTES", "bulk_export_max_bytes", 134_217_728),
)


def load_export_byte_limits() -> ExportByteLimits:
    """Load and validate export budgets from the environment.

    Reads each variable at call time so tests and request handling see
    current values. Raises :class:`ExportByteLimitError` on the first
    invalid variable, naming only that variable.
    """
    fields: dict[str, int] = {}
    for env_name, attr_name, default in _LIMIT_SPECS:
        raw = os.environ.get(env_name)
        if raw is None:
            fields[attr_name] = default
            continue
        raw = raw.strip()
        if raw == "":
            raise ExportByteLimitError(
                f"{env_name} must be a positive integer (got empty)"
            )
        try:
            value = int(raw)
        except ValueError:
            raise ExportByteLimitError(
                f"{env_name} must be a positive base-10 integer (got {raw!r})"
            ) from None
        if value <= 0:
            raise ExportByteLimitError(
                f"{env_name} must be a positive integer (got {value})"
            )
        fields[attr_name] = value
    return ExportByteLimits(**fields)


def render_json_object(
    sections: Iterable[tuple[str, Any]],
    *,
    limit: int,
    guidance: str,
) -> str:
    """Render ``{key: value, ...}`` from lazy sections under a byte budget.

    Sections are pulled one at a time, serialized, accounted, and
    released, so an oversized document fails partway instead of after a
    full materialize.
    """
    account = _ByteAccount(limit, guidance)
    parts: list[str] = ["{"]
    first = True
    for key, value in sections:
        chunk = f"{json.dumps(key)}:{json.dumps(value, default=str)}"
        if not first:
            chunk = "," + chunk
        first = False
        account.add(chunk)
        parts.append(chunk)
    account.add("}")
    parts.append("}")
    return "".join(parts)


async def render_json_object_async(
    sections: AsyncIterable[tuple[str, Any]],
    *,
    limit: int,
    guidance: str,
) -> str:
    """Async twin of :func:`render_json_object` for async section
    suppliers (the run export builds sections with awaited store reads)."""
    account = _ByteAccount(limit, guidance)
    parts: list[str] = ["{"]
    first = True
    async for key, value in sections:
        chunk = f"{json.dumps(key)}:{json.dumps(value, default=str)}"
        if not first:
            chunk = "," + chunk
        first = False
        account.add(chunk)
        parts.append(chunk)
    account.add("}")
    parts.append("}")
    return "".join(parts)


def render_json_array(
    items: Iterable[dict[str, Any]],
    *,
    limit: int,
    guidance: str,
) -> str:
    """Render ``[{item}, ...]`` (one JSON object per line) under a budget.

    Matches the historical bulk-export format: items joined with ``,\\n``
    and default ``json.dumps`` separators, so responses stay
    byte-identical to the pre-budget render. Items are pulled lazily; a
    supplier that yields one run at a time keeps only one run's rows
    resident regardless of how many runs are requested.
    """
    account = _ByteAccount(limit, guidance)
    parts: list[str] = ["["]
    for i, item in enumerate(items):
        chunk = json.dumps(item, default=str)
        if i > 0:
            chunk = ",\n" + chunk
        account.add(chunk)
        parts.append(chunk)
    account.add("]")
    parts.append("]")
    return "".join(parts)


class _ByteAccount:
    """Accumulate serialized chunk lengths, failing past the budget."""

    def __init__(self, limit: int, guidance: str) -> None:
        self._limit = limit
        self._guidance = guidance
        self.total = 0

    def add(self, chunk: str) -> None:
        self.total += len(chunk)
        if self.total > self._limit:
            raise ExportBudgetExceeded(self._limit, self._guidance)
