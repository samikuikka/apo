"""apo override mapper — explicit observation type override (priority 1)."""

from __future__ import annotations

from typing import Any

from ._shared import VALID_OBSERVATION_TYPES, get_str, NormalizedSpan


MAPPER_NAME = "apo-override"
MAPPER_VERSION = 1


def try_map(attrs: dict[str, Any], span_name: str) -> str | None:
    """Return observation_type if apo.observation.type is a valid override, else None."""
    apo_type = get_str(attrs, "apo.observation.type")
    if apo_type:
        upper = apo_type.upper()
        if upper in VALID_OBSERVATION_TYPES:
            return upper
    return None
