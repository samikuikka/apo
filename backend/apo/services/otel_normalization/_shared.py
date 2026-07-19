# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""Shared types, constants, and helpers for convention mappers."""

from __future__ import annotations

import json
import logging
from typing import Any, final

logger = logging.getLogger(__name__)

VALID_OBSERVATION_TYPES = frozenset({
    "GENERATION", "SPAN", "TOOL", "CHAIN", "RETRIEVER",
    "EVALUATOR", "EMBEDDING", "GUARDRAIL", "AGENT",
})

# Bump when any mapper's logic changes. Reproject uses this to detect stale projections.
NORMALIZER_VERSION = 3


@final
class NormalizedSpan:
    """The derived product view of one canonical OTel span."""

    def __init__(
        self,
        trace_id: str = "",
        span_id: str = "",
        parent_span_id: str | None = None,
        display_name: str = "",
        observation_type: str = "SPAN",
        model: str | None = None,
        input: dict[str, Any] | None = None,
        output: dict[str, Any] | None = None,
        tool_name: str | None = None,
        tool_parameters: dict[str, Any] | None = None,
        tool_result: dict[str, Any] | None = None,
        token_usage: dict[str, int | float] | None = None,
        error_message: str | None = None,
        metadata: dict[str, Any] | None = None,
        mapping_name: str = "generic",
        mapping_version: int = NORMALIZER_VERSION,
    ) -> None:
        self.trace_id = trace_id
        self.span_id = span_id
        self.parent_span_id = parent_span_id
        self.display_name = display_name
        self.observation_type = observation_type
        self.model = model
        self.input = input
        self.output = output
        self.tool_name = tool_name
        self.tool_parameters = tool_parameters
        self.tool_result = tool_result
        self.token_usage = token_usage or {}
        self.error_message = error_message
        self.metadata = metadata or {}
        self.mapping_name = mapping_name
        self.mapping_version = mapping_version


# ── typed value helpers ──────────────────────────────────────────────────


def get_str(attrs: dict[str, Any], key: str) -> str | None:
    value = attrs.get(key)
    if isinstance(value, str) and value:
        return value
    return None


def get_int(attrs: dict[str, Any], key: str) -> int | float | None:
    value = attrs.get(key)
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            try:
                return float(value)
            except ValueError:
                return None
    return None


def get_json(attrs: dict[str, Any], key: str) -> Any:
    """Get a JSON-decoded value from an attribute that may be a JSON string."""
    value = attrs.get(key)
    if value is None:
        return None
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, ValueError):
            return value
    return value


def _is_tool_only_message(message: dict[str, Any]) -> bool:
    """True when a message's payload is entirely tool-call/result data.

    Such messages have a canonical home as their own TOOL observation in the
    trace tree, so they are stripped from a generation's input/output to avoid
    duplicating tool data that already appears as standalone observations.
    Cases:
      - ``role == "tool"``: always a tool result.
      - ``role == "assistant"`` with only tool-call parts (no text): the model
        sent no prose, just the call. An assistant message that also carries
        text is kept — the text is real prompt content.
    Handles both normalized (post ``normalize_genai_message``) shapes, which
    carry a ``tool_calls`` array, and raw SDK shapes, whose ``content`` is a
    list of typed parts.
    """
    role = message.get("role")
    if role == "tool":
        return True
    if role != "assistant":
        return False
    # Normalized shape: assistant with only tool_calls and no text content.
    content = message.get("content")
    tool_calls = message.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        if isinstance(content, str) and content:
            return False
        return True
    # Raw SDK shape: content is a list of parts. Tool-only if no part is text.
    parts = content if isinstance(content, list) else message.get("parts")
    if isinstance(parts, list) and parts:
        text_part_types = {"text"}
        return not any(
            isinstance(p, dict) and p.get("type") in text_part_types
            for p in parts
        )
    return False


# ── message normalization ─────────────────────────────────────────────────


def normalize_genai_message(message: dict[str, Any]) -> dict[str, Any]:
    """Convert OTel GenAI message format to OpenAI shape for the dashboard."""
    result: dict[str, Any] = {"role": message.get("role", "unknown")}

    # Content can be: a string, a "parts" list (GenAI convention), or a
    # "content" list (Vercel AI SDK convention: [{"type":"text","text":"..."}]).
    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    multimodal: list[dict[str, Any]] = []

    raw_content = message.get("content")
    parts = message.get("parts")
    # Normalize: if content is a list, treat it as parts (AI SDK format).
    if isinstance(raw_content, list) and not isinstance(parts, list):
        parts = raw_content

    # Simple string content — no parts to parse.
    if isinstance(raw_content, str) and not isinstance(parts, list):
        result["content"] = raw_content
        return result

    if isinstance(parts, list):
        for part in parts:
            if not isinstance(part, dict):
                continue
            # AI SDK text parts: {"type":"text","text":"..."}
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                text_parts.append(part["text"])
                continue
            content = part.get("content")
            part_type = part.get("type")
            if part_type == "text" and isinstance(content, str):
                text_parts.append(content)
            # Tool call. Two shapes:
            #   - AI SDK v4+ / OpenAI: {type:"tool-call", toolCallId, toolName, input}
            #   - older / normalized:  {type:"tool_call", id, name, arguments}
            elif part_type in ("tool_call", "tool-call"):
                name = part.get("toolName") or part.get("name") or ""
                if isinstance(name, str) and name:
                    raw_args = part.get("input", part.get("arguments", ""))
                    if isinstance(raw_args, str):
                        args_str = raw_args
                    elif isinstance(raw_args, (dict, list)):
                        args_str = json.dumps(raw_args)
                    else:
                        args_str = str(raw_args)
                    tool_calls.append({
                        "id": part.get("toolCallId", part.get("id", "")),
                        "type": "function",
                        "function": {"name": name, "arguments": args_str},
                    })
            # Tool result. Two shapes:
            #   - AI SDK v4+: {type:"tool-result", toolCallId, toolName,
            #                  output: {type:"text", value} | primitive}
            #   - older:      {type:"tool_result", content} or {type:"tool_call_response", response}
            elif part_type in ("tool_result", "tool-result", "tool_call_response"):
                if isinstance(content, str):
                    text_parts.append(content)
                elif part.get("response") is not None:
                    resp = part["response"]
                    text_parts.append(resp if isinstance(resp, str) else json.dumps(resp))
                elif part.get("output") is not None:
                    out = part["output"]
                    # AI SDK v4+ nests the payload as {type:"text"|"json"|..., value}.
                    # Unwrap the inner value regardless of type; otherwise serialize.
                    if isinstance(out, dict) and "value" in out:
                        inner = out["value"]
                        text_parts.append(inner if isinstance(inner, str) else json.dumps(inner))
                    elif isinstance(out, str):
                        text_parts.append(out)
                    else:
                        text_parts.append(json.dumps(out))
            elif part_type in ("image", "audio", "file"):
                multimodal.append({"type": part_type, **{
                    k: v for k, v in part.items() if k != "type" and v is not None
                }})
            elif isinstance(content, str) and not part_type:
                text_parts.append(content)

    # An assistant message that is purely a tool call carries no text — its
    # content is genuinely empty. The structured `tool_calls` array is the
    # payload; the dashboard renders that in a dedicated tool-call box rather
    # than reading `content`. Do NOT synthesize a placeholder string here.
    result["content"] = "\n".join(text_parts) if text_parts else ""
    if tool_calls:
        result["tool_calls"] = tool_calls
    if multimodal:
        result["content_parts"] = multimodal

    return result


def extract_assistant_text(messages: list[dict[str, Any]]) -> str | None:
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, str) and content:
            return content
    return None


def extract_model(attrs: dict[str, Any]) -> str | None:
    for key in ("gen_ai.request.model", "ai.model.id", "llm.model_name"):
        value = get_str(attrs, key)
        if value:
            return value
    return None


def extract_tokens(attrs: dict[str, Any]) -> dict[str, int | float]:
    result: dict[str, int | float] = {}
    prompt = get_int(attrs, "gen_ai.usage.input_tokens")
    completion = get_int(attrs, "gen_ai.usage.output_tokens")
    if prompt is None:
        prompt = get_int(attrs, "gen_ai.usage.prompt_tokens")
    if completion is None:
        completion = get_int(attrs, "gen_ai.usage.completion_tokens")
    if prompt is None:
        prompt = get_int(attrs, "ai.usage.promptTokens")
    if completion is None:
        completion = get_int(attrs, "ai.usage.completionTokens")
    if prompt is None:
        prompt = get_int(attrs, "llm.token_count.prompt")
    if completion is None:
        completion = get_int(attrs, "llm.token_count.completion")
    if prompt is not None:
        result["prompt"] = prompt
    if completion is not None:
        result["completion"] = completion
    return result


def extract_input(attrs: dict[str, Any]) -> dict[str, Any] | None:
    messages_raw = get_json(attrs, "gen_ai.input.messages")
    if messages_raw is None:
        messages_raw = get_json(attrs, "ai.prompt.messages")
    if messages_raw is None:
        # AI SDK parent span stores the full prompt as a single JSON string
        # under ai.prompt: {"system": "...", "messages": [...]}
        prompt = get_json(attrs, "ai.prompt")
        if isinstance(prompt, dict):
            messages_raw = prompt.get("messages")
            system = prompt.get("system")
            # Prepend the system message if present
            if isinstance(system, str) and system:
                msgs = messages_raw if isinstance(messages_raw, list) else []
                messages_raw = [{"role": "system", "content": system}, *msgs]
    if messages_raw is None:
        return None
    if isinstance(messages_raw, list):
        messages = [
            normalize_genai_message(m)
            for m in messages_raw
            if isinstance(m, dict) and not _is_tool_only_message(m)
        ]
        return {"messages": messages}
    return {"messages": messages_raw}


def extract_output(attrs: dict[str, Any]) -> dict[str, Any] | None:
    messages_raw = get_json(attrs, "gen_ai.output.messages")
    if messages_raw is None:
        for key in (
            "gen_ai.completion",
            "gen_ai.response.text",
            "ai.response.text",
            "ai.response.output",
            "ai.generateText.result",
        ):
            text = get_str(attrs, key)
            if text:
                return {"text": text}
        return None
    messages = [
        normalize_genai_message(m)
        for m in messages_raw
        if isinstance(m, dict) and not _is_tool_only_message(m)
    ]
    result: dict[str, Any] = {"messages": messages}
    text = extract_assistant_text(messages)
    if text is not None:
        result["text"] = text
    return result


def extract_error(span: Any, _attrs: dict[str, Any]) -> str | None:
    if span.status_code == 2 and span.status_message:
        return span.status_message
    if span.events:
        for event in span.events:
            if isinstance(event, dict) and event.get("name") == "exception":
                event_attrs = event.get("attributes", {})
                if isinstance(event_attrs, dict):
                    msg = event_attrs.get("exception.message")
                    if isinstance(msg, str):
                        return msg
    return None
