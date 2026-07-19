# pyright: reportExplicitAny=false

"""Claude Code / Claude Agent SDK conventions mapper (priority 3.5).

The Claude Agent SDK subprocess emits spans under the ``claude_code.*`` name
prefix with its own ``span.type`` attribute vocabulary, distinct from both the
standard ``gen_ai.*`` semantic conventions and the Vercel ``ai.*`` attributes.
Without this mapper they fall through to the generic mapper (priority 5) and
get typed as ``SPAN`` — invisible to ``t.calledTool`` / generation assertions.

Span shapes emitted by the subprocess (verified by capturing its OTLP export):

  ``claude_code.interaction``     — the top-level agent turn   → AGENT
  ``claude_code.llm_request``     — one model request          → GENERATION
                                    (carries ``gen_ai.request.model``)
  ``claude_code.tool``            — a tool call                → TOOL
                                    (carries ``tool_name``)
  ``claude_code.tool.execution``  — tool execution detail      → TOOL
                                    (carries ``tool_use_id``)
  ``claude_code.tool.blocked_on_user`` — permission prompt     → SPAN (skip)
"""

from __future__ import annotations

from typing import Any

MAPPER_NAME = "claude-code"
MAPPER_VERSION = 1


def try_map(attrs: dict[str, Any], span_name: str) -> str | None:
    """Return observation_type if this is a ``claude_code.*`` span."""
    if not span_name.startswith("claude_code."):
        return None

    suffix = span_name[len("claude_code."):]

    if suffix == "llm_request":
        return "GENERATION"
    if suffix == "interaction":
        return "AGENT"
    # Both the tool call span and its execution-detail child carry a tool
    # identifier; classify both as TOOL so t.calledTool sees the call.
    if suffix in ("tool", "tool.execution"):
        return "TOOL"
    # Anything else (tool.blocked_on_user, etc.) is housekeeping — let the
    # generic mapper handle it as SPAN.
    return None
