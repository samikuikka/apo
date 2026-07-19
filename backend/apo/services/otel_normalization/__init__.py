# pyright: reportAny=false, reportExplicitAny=false

"""Versioned normalization registry (SPEC-133 M5).

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

    # Extract common fields (shared across all conventions)
    normalized.model = extract_model(attrs)
    normalized.token_usage = extract_tokens(attrs)
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
