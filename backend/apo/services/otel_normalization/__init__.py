# pyright: reportAny=false, reportExplicitAny=false

"""Versioned normalization registry.

Consumes canonical ``OtlpSpanDB`` rows and produces ``NormalizedSpan`` objects.
Each convention (apo, gen_ai, openinference, vercel_ai) has its own versioned
module. The registry dispatches in priority order and records provenance.

Priority:
  1. apo override (explicit ``apo.observation.type``)
  2. OpenInference (``openinference.span.kind``)
  3. Claude Code (``claude_code.*`` span names)
  4. GenAI standard (``gen_ai.*``)
  5. Vercel AI (``ai.*``)
  6. Generic fallback (always ``SPAN``)
"""

from __future__ import annotations

import logging
from typing import Any

from ...models.db import OtlpSpanDB
from ...models.usage_keys import INPUT_FAMILY, OUTPUT_FAMILY
from ..usage_normalization import normalize_usage
from ._shared import (
    NORMALIZER_VERSION,
    NormalizedSpan,
    extract_error,
    extract_input,
    extract_model,
    extract_output,
    extract_tokens,
)
from . import _apo, _claude, _genai, _openinference, _vercel, _generic

logger = logging.getLogger(__name__)

__all__ = ["NormalizedSpan", "normalize_span", "NORMALIZER_VERSION"]

# Ordered list of (module, mapper_name) pairs. First match wins.
# Claude Code runs before GenAI: claude_code.* spans also carry gen_ai.* attrs,
# but the Claude-specific name-prefix gives more accurate typing (e.g. the
# top-level interaction span becomes AGENT, not GENERATION).
_MAPPERS = [
    (_apo, "apo-override"),
    (_openinference, "openinference"),
    (_claude, "claude-code"),
    (_genai, "gen-ai"),
    (_vercel, "vercel-ai"),
    (_generic, "generic"),
]


def normalize_span(span: OtlpSpanDB) -> NormalizedSpan:
    """Normalize a canonical span into a derived product view."""
    attrs = span.attributes or {}
    span_name = span.span_name or ""

    # Run mappers in priority order to determine observation_type
    observation_type = "SPAN"
    mapping_name = "generic"

    for module, name in _MAPPERS:
        result = module.try_map(attrs, span_name)
        if result is not None:
            observation_type = result
            mapping_name = name
            break

    # Build the normalized span
    normalized = NormalizedSpan(
        trace_id=span.trace_id,
        span_id=span.span_id,
        parent_span_id=span.parent_span_id,
        display_name=span_name,
        observation_type=observation_type,
        mapping_name=mapping_name,
    )

    # A SKILL observation's name is what the loadedSkill assertion matches.
    # `apo.skill.name` lets an OTLP producer declare it explicitly — the span
    # name of a SKILL.md read is usually the tool-call shape (e.g.
    # ``gen_ai.execute_tool read_file``), not the skill (issue #164).
    skill_name = _get_first_str(attrs, "apo.skill.name")
    if observation_type == "SKILL" and skill_name:
        normalized.display_name = skill_name

    # Extract common fields (shared across all conventions)
    normalized.model = extract_model(attrs)
    normalized.token_usage = _token_usage(attrs, normalized.model)
    normalized.error_message = extract_error(span, attrs)
    normalized.input = extract_input(attrs)
    normalized.output = extract_output(attrs)

    # Tool-specific fields. Claude Code spans carry ``tool_name`` (the SDK's
    # own attribute), alongside the standard gen_ai.tool.name convention.
    normalized.tool_name = _get_first_str(
        attrs,
        "gen_ai.tool.name",
        "ai.toolCall.name",
        "tool_name",
    )
    tool_args = _get_first_json(
        attrs,
        "gen_ai.tool.call.arguments",
        "ai.toolCall.args",
    )
    if tool_args is not None:
        normalized.tool_parameters = tool_args
    tool_result = _get_first_json(
        attrs,
        "gen_ai.tool.call.result",
        "ai.toolCall.result",
    )
    if tool_result is not None:
        normalized.tool_result = tool_result

    return normalized


def _token_usage(attrs: dict[str, Any], model: str | None) -> dict[str, int | float]:
    """Provider-aware prompt/completion totals for display and run aggregates.

    ``extract_tokens`` reads ``gen_ai.usage.input_tokens`` verbatim, but what that
    attribute means differs per provider: Anthropic-semantics emitters report it
    *net* of cache, with cache_read / cache_creation as separate buckets. Reading
    it verbatim made a ~40k-token cached prompt display as 3 tokens on every call
    of a cached agent run, while the priced cost on the same span said otherwise.

    So: normalize per provider (the same normalizer the pricing path uses), then
    sum the input-side family (uncached + cache_read + cache_write) into
    ``prompt`` and the output-side family (output + reasoning) into
    ``completion``. Falls back to ``extract_tokens`` when the normalizer finds
    no canonical usage (e.g. exotic emitters it doesn't recognize).
    """
    try:
        usage = normalize_usage(attrs, model_name=model)
    except Exception:
        logger.debug("usage normalization failed; falling back to raw tokens", exc_info=True)
        usage = {}
    result: dict[str, int | float] = {}
    input_side = [usage[k.value] for k in INPUT_FAMILY if k.value in usage]
    output_side = [usage[k.value] for k in OUTPUT_FAMILY if k.value in usage]
    if input_side:
        result["prompt"] = sum(input_side)
    if output_side:
        result["completion"] = sum(output_side)
    if not result:
        return extract_tokens(attrs)
    return result


def _get_json(attrs: dict[str, Any], key: str) -> Any:
    """Local JSON helper to avoid circular import."""
    from ._shared import get_json
    return get_json(attrs, key)


def _get_first_json(attrs: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = _get_json(attrs, key)
        if value is not None:
            return value
    return None


def _get_first_str(attrs: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = attrs.get(key)
        if isinstance(value, str) and value:
            return value
    return None
