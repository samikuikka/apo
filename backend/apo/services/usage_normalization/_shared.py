# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""Shared helpers for provider usage normalizers.

The non-overlap invariant (OTel GenAI semconv) is enforced here, once, so every
provider resolver applies it uniformly:
  - cache_read / cache_write_* are SUBTRACTED from input (they are a subset of
    input_tokens).
  - reasoning is SUBTRACTED from output (it is included in output_tokens).
"""

from __future__ import annotations

import json
from typing import Any


def get_int(attrs: dict[str, Any], key: str) -> int | None:
    val = attrs.get(key)
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return int(val)
    # OTel intValue arrives as a JSON string in some payloads.
    try:
        return int(str(val))
    except (TypeError, ValueError):
        return None


def get_str(attrs: dict[str, Any], key: str) -> str | None:
    val = attrs.get(key)
    if val is None:
        return None
    s = str(val)
    return s if s else None


def get_json_dict(attrs: dict[str, Any], key: str) -> dict[str, Any] | None:
    """Fetch a JSON-object attribute, parsing if stored as a string."""
    val = attrs.get(key)
    if val is None:
        return None
    if isinstance(val, dict):
        return val
    if isinstance(val, str):
        try:
            parsed = json.loads(val)
        except (json.JSONDecodeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def apply_non_overlap(
    usage: dict[str, int], *, input_includes_cache: bool, output_includes_reasoning: bool
) -> dict[str, int]:
    """Enforce the OTel GenAI non-overlap invariant in place.

    Per OTel GenAI semconv (``gen-ai-spans.md:173-192``), ``cache_read`` is a
    subset of ``input_tokens`` and ``reasoning`` is a subset of
    ``output_tokens``. Only those two subsets are subtracted — cache_write
    buckets are NEVER part of input_tokens (they are prompt-cache *creation*,
    a distinct billed dimension), so they are not subtracted. (This fixes
    langfuse's Bedrock double-counting bug noted in the research asset.)

    Providers differ in whether their reported ``input_tokens`` /
    ``output_tokens`` are inclusive of the subsets:
      - OpenAI, Gemini, Bedrock: inclusive (OTel GenAI semconv) -> subtract.
      - Anthropic: input_tokens is already net of cache -> do NOT subtract.

    Floors at 0 (no negative token counts). Returns the same dict.
    """
    if input_includes_cache:
        cache_read = usage.get("cache_read", 0)
        if cache_read and "input" in usage:
            usage["input"] = max(usage["input"] - cache_read, 0)

    if output_includes_reasoning:
        reasoning = usage.get("reasoning", 0)
        if reasoning and "output" in usage:
            usage["output"] = max(usage["output"] - reasoning, 0)

    return usage
