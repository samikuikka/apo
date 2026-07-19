# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""Generic usage normalization (universal fallback).

Handles OpenAI-compatible providers (Cohere, Qwen, DeepSeek, Moonshot, GLM,
MiMo) and any unrecognized emitter via alias ladders. Unknown keys are passed
through verbatim (store-but-unpriced, ticket 01).

The generic resolver recognizes the canonical ``cache_read.input_tokens``
subset (OTel GenAI semconv) so it can apply the non-overlap invariant; it does
NOT recognize provider-specific cache-write buckets generically.
"""

from __future__ import annotations

from typing import Any

from ...models.usage_keys import UsageKey
from ._shared import apply_non_overlap, get_int

# Alias -> UsageKey for the dimensions the generic resolver recognizes.
_INPUT_ALIASES = ("gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "ai.usage.promptTokens", "llm.token_count.prompt")
_OUTPUT_ALIASES = ("gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "ai.usage.completionTokens", "llm.token_count.completion")
_CACHE_READ_ALIASES = ("gen_ai.usage.cache_read.input_tokens", "ai.usage.cachedInputTokens", "llm.token_count.prompt_details.cache_read")
_REASONING_ALIASES = ("gen_ai.usage.reasoning.output_tokens", "ai.usage.reasoningTokens", "llm.token_count.completion_details.reasoning")


def normalize(attrs: dict[str, Any]) -> dict[str, int]:
    usage: dict[str, int] = {}
    recognized: set[str] = set()

    for alias in _INPUT_ALIASES:
        val = get_int(attrs, alias)
        if val is not None:
            usage[UsageKey.INPUT.value] = val
            recognized.add(alias)
            break
    for alias in _OUTPUT_ALIASES:
        val = get_int(attrs, alias)
        if val is not None:
            usage[UsageKey.OUTPUT.value] = val
            recognized.add(alias)
            break
    for alias in _CACHE_READ_ALIASES:
        val = get_int(attrs, alias)
        if val is not None:
            usage[UsageKey.CACHE_READ.value] = val
            recognized.add(alias)
            break
    for alias in _REASONING_ALIASES:
        val = get_int(attrs, alias)
        if val is not None:
            usage[UsageKey.REASONING.value] = val
            recognized.add(alias)
            break

    # Pass through unknown keys verbatim (store-but-unpriced). Strip the common
    # OTel prefix families so the stored names are short and stable.
    for key, val in attrs.items():
        if key in recognized:
            continue
        if not key.startswith(("gen_ai.usage.", "ai.usage.", "llm.token_count.")):
            continue
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            continue
        stored = key.split(".")[-1]
        # Avoid clobbering a canonical key.
        if stored in {k.value for k in UsageKey}:
            continue
        usage[stored] = int(val)

    # Generic emitters that emit cache_read follow the OTel semconv subset rule
    # (cache_read ⊆ input). Reasoning similarly. Subtract both if present.
    has_cache = "cache_read" in usage
    has_reasoning = "reasoning" in usage
    return apply_non_overlap(
        usage,
        input_includes_cache=has_cache,
        output_includes_reasoning=has_reasoning,
    )
