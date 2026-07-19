# pyright: reportExplicitAny=false

"""GenAI standard conventions mapper (priority 3).

Handles ``gen_ai.*`` attributes from OpenAI/Anthropic instrumentation.
Maps chat/generate, tool calls, agent invocation, and embeddings explicitly.
"""

from __future__ import annotations

from typing import Any

from ._shared import get_str


MAPPER_NAME = "gen-ai"
MAPPER_VERSION = 2


def try_map(attrs: dict[str, Any], span_name: str) -> str | None:
    """Return observation_type if gen_ai.* attributes are present."""
    # SPEC-134 M2: the Vercel per-request children (doGenerate/doStream) are the
    # observed GENERATION, not duplicates to skip. If they carry gen_ai.* attrs
    # (mixed standard+vendor instrumentation), classify them as GENERATION here
    # rather than falling through. The lifecycle wrappers are handled by the
    # Vercel mapper (priority 4) as transparent.
    if span_name in ("ai.generateText.doGenerate", "ai.streamText.doStream"):
        return "GENERATION"

    # Tool detection
    if attrs.get("gen_ai.tool.name") is not None:
        return "TOOL"

    # Generation detection (chat, completion, generate)
    op = get_str(attrs, "gen_ai.operation.name")
    if op:
        if op in ("chat", "completion", "generate", "generateText", "streamText"):
            return "GENERATION"
        if op == "embed":
            return "EMBEDDING"
        if op in ("execute_tool", "tool"):
            return "TOOL"
        if op == "invoke_agent":
            return "AGENT"

    # Model present without operation — likely a generation
    if attrs.get("gen_ai.request.model") or attrs.get("gen_ai.usage.input_tokens"):
        return "GENERATION"

    # Span name prefix (OpenAI instrumentation: "chat <model>")
    if span_name.startswith("chat "):
        return "GENERATION"

    return None
