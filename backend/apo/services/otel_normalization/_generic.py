"""Generic fallback mapper (priority 5).

When no convention-specific mapper matches, classify as SPAN.
"""

from __future__ import annotations

MAPPER_NAME = "generic"
MAPPER_VERSION = 1


def try_map(attrs: dict[str, object], span_name: str) -> str:
    """Always returns SPAN — the catch-all."""
    return "SPAN"
