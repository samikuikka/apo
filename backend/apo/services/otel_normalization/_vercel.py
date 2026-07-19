"""Vercel AI SDK mapper (priority 4).

Handles ``ai.*`` attributes from the Vercel AI SDK's OTel telemetry.
"""

from __future__ import annotations

from typing import Any


MAPPER_NAME = "vercel-ai"
MAPPER_VERSION = 2


def try_map(attrs: dict[str, Any], span_name: str) -> str | None:
    """Return observation_type if ai.* attributes or ai.* span name detected."""
    # Skip per-step child spans — the parent span (ai.generateText /
    # ai.streamText) already carries the complete picture. Recording both
    # creates duplicate GENERATION rows for the same LLM call.
    if span_name in ("ai.generateText.doGenerate", "ai.streamText.doStream"):
        return None

    # Tool calls: ai.toolCall.* attributes or span name "ai.toolCall"
    if attrs.get("ai.toolCall.name") or span_name == "ai.toolCall":
        return "TOOL"

    # Generation: ai.model.id present
    if attrs.get("ai.model.id"):
        return "GENERATION"

    # Span name starts with "ai." (but not a toolCall — checked above)
    if span_name.startswith("ai."):
        return "GENERATION"

    return None
