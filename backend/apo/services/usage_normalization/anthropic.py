# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""Anthropic usage normalization.

Anthropic reports ``input_tokens`` *exclusive* of cache (input_tokens is the
non-cached portion; cache_read / cache_creation are reported separately and
are NOT part of input_tokens). So the non-overlap invariant does NOT subtract
cache from input here. Output has no reasoning subset on Anthropic.

The 5m/1h ephemeral TTL split: ``cache_creation.input_tokens`` is the total
cache-write count; ``ephemeral_5m`` + ``ephemeral_1h`` are subsets of it. The
non-TTL remainder (cache_creation - 5m - 1h) is bucketed as cache_write_5m
(the default TTL tier).
"""

from __future__ import annotations

from typing import Any

from ._shared import apply_non_overlap, get_int


def normalize(attrs: dict[str, Any]) -> dict[str, int]:
    usage: dict[str, int] = {}

    inp = get_int(attrs, "gen_ai.usage.input_tokens")
    if inp is None:
        inp = get_int(attrs, "ai.usage.promptTokens")
    if inp is not None:
        usage["input"] = inp

    out = get_int(attrs, "gen_ai.usage.output_tokens")
    if out is None:
        out = get_int(attrs, "ai.usage.completionTokens")
    if out is not None:
        usage["output"] = out

    # Cache read (reported separately, NOT part of input_tokens).
    cache_read = get_int(attrs, "gen_ai.usage.cache_read.input_tokens")
    if cache_read is not None:
        usage["cache_read"] = cache_read

    # Cache creation with 5m/1h TTL split.
    ephemeral_5m = get_int(attrs, "gen_ai.usage.cache_creation.ephemeral_5m_input_tokens")
    ephemeral_1h = get_int(attrs, "gen_ai.usage.cache_creation.ephemeral_1h_input_tokens")
    cache_creation_total = get_int(attrs, "gen_ai.usage.cache_creation.input_tokens")

    if ephemeral_1h is not None:
        usage["cache_write_1h"] = ephemeral_1h
    if ephemeral_5m is not None:
        usage["cache_write_5m"] = ephemeral_5m

    if cache_creation_total is not None:
        # The non-TTL-tagged remainder goes to the default (5m) tier.
        remainder = cache_creation_total - (ephemeral_5m or 0) - (ephemeral_1h or 0)
        if remainder > 0:
            usage["cache_write_5m"] = usage.get("cache_write_5m", 0) + remainder
        elif "cache_write_5m" not in usage and ephemeral_5m is None and ephemeral_1h is None:
            # No TTL breakdown at all -> default to the 5m tier.
            usage["cache_write_5m"] = cache_creation_total

    # Anthropic input_tokens is already net of cache; output has no reasoning.
    return apply_non_overlap(usage, input_includes_cache=False, output_includes_reasoning=False)
