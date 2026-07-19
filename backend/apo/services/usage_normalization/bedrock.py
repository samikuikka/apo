# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""Bedrock usage normalization.

Bedrock reports ``input_tokens`` *inclusive* of cache_read (OTel GenAI
semconv). cache_creation is the cache-write bucket. See
``wayfinder/assets/03-normalizer-research.md`` §3.
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

    cache_read = get_int(attrs, "gen_ai.usage.cache_read.input_tokens")
    if cache_read is not None:
        usage["cache_read"] = cache_read

    cache_creation = get_int(attrs, "gen_ai.usage.cache_creation.input_tokens")
    if cache_creation is not None:
        # Bedrock has no TTL split; default to the 5m tier.
        usage["cache_write_5m"] = cache_creation

    # Bedrock input is inclusive of cache_read -> subtract.
    return apply_non_overlap(usage, input_includes_cache=True, output_includes_reasoning=False)
