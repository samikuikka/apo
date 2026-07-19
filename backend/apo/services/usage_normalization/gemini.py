# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""Gemini (Google AI / Vertex) usage normalization.

Gemini via official OTel genai instrumentation reports ``input_tokens`` /
``output_tokens`` *inclusive* of cache_read / reasoning subsets (OTel GenAI
semconv). This covers Gemini 2.5 thinking models (reasoning is a distinct
billed output dimension). See ``wayfinder/assets/03-normalizer-research.md``
§4.
"""

from __future__ import annotations

from typing import Any

from ._shared import apply_non_overlap, get_int


def normalize(attrs: dict[str, Any]) -> dict[str, int]:
    usage: dict[str, int] = {}

    inp = get_int(attrs, "gen_ai.usage.input_tokens")
    if inp is None:
        inp = get_int(attrs, "llm.token_count.prompt")
    if inp is not None:
        usage["input"] = inp

    out = get_int(attrs, "gen_ai.usage.output_tokens")
    if out is None:
        out = get_int(attrs, "llm.token_count.completion")
    if out is not None:
        usage["output"] = out

    cache_read = get_int(attrs, "gen_ai.usage.cache_read.input_tokens")
    if cache_read is not None:
        usage["cache_read"] = cache_read

    reasoning = get_int(attrs, "gen_ai.usage.reasoning.output_tokens")
    if reasoning is None:
        reasoning = get_int(attrs, "llm.token_count.completion_details.reasoning")
    if reasoning is not None:
        usage["reasoning"] = reasoning

    # Gemini input/output are inclusive -> subtract the subsets.
    return apply_non_overlap(usage, input_includes_cache=True, output_includes_reasoning=True)
