# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""OpenAI usage normalization.

OpenAI reports ``input_tokens`` / ``output_tokens`` *inclusive* of cache and
reasoning subsets (OTel GenAI semconv), so the non-overlap invariant subtracts
both. See ``wayfinder/assets/03-normalizer-research.md`` §3.
"""

from __future__ import annotations

from typing import Any

from ._shared import apply_non_overlap, get_int


def normalize(attrs: dict[str, Any]) -> dict[str, int]:
    usage: dict[str, int] = {}

    # Input side (inclusive of cache).
    inp = get_int(attrs, "gen_ai.usage.input_tokens")
    if inp is None:
        inp = get_int(attrs, "gen_ai.usage.prompt_tokens")
    if inp is None:
        inp = get_int(attrs, "ai.usage.promptTokens")
    if inp is not None:
        usage["input"] = inp

    # Output side (inclusive of reasoning).
    out = get_int(attrs, "gen_ai.usage.output_tokens")
    if out is None:
        out = get_int(attrs, "gen_ai.usage.completion_tokens")
    if out is None:
        out = get_int(attrs, "ai.usage.completionTokens")
    if out is not None:
        usage["output"] = out

    # Cache read (subset of input per OTel semconv).
    cache_read = get_int(attrs, "gen_ai.usage.cache_read.input_tokens")
    if cache_read is None:
        cache_read = get_int(attrs, "ai.usage.cachedInputTokens")
    if cache_read is not None:
        usage["cache_read"] = cache_read

    # Reasoning (subset of output per OTel semconv).
    reasoning = get_int(attrs, "gen_ai.usage.reasoning.output_tokens")
    if reasoning is None:
        reasoning = get_int(attrs, "ai.usage.reasoningTokens")
    if reasoning is not None:
        usage["reasoning"] = reasoning

    # OpenAI input/output are inclusive -> subtract the subsets.
    return apply_non_overlap(usage, input_includes_cache=True, output_includes_reasoning=True)
