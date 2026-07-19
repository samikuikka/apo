"""The agentic chat loop — Python mirror of ``service.ts``.

Reads ``OPENROUTER_*`` env vars (same names as the TS example service), runs a
multi-step tool-calling loop capped at 8 steps via the OpenAI Python SDK
pointed at OpenRouter.

Tracing is automatic: ``opentelemetry-instrumentation-openai-v2`` (set up in
``app/otel.py``) emits a GENERATION span for every ``chat.completions.create``
call, including the prompt and completion content (when
``OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only`` is set). Tool
executions get their own TOOL span here via the OTel API, nested under the
parent LLM span by OTel context propagation.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Iterable
from typing import Any, cast

from openai import OpenAI
from openai.types.chat import (
    ChatCompletionMessageParam,
    ChatCompletionToolParam,
)
from opentelemetry import trace

from .tools import OPENAI_TOOLS, dispatch

logger = logging.getLogger("example_service_py.agent")
_tracer = trace.get_tracer(__name__)

SYSTEM_PROMPT = (
    "You are a careful analysis agent with access to tools. "
    "Always use list_files first, then use read_file with the exact file paths shown. "
    "Never answer from assumptions or memory. "
    "For factual answers, only state values you directly verified from tool output. "
    "If evidence is missing or ambiguous, explicitly say that instead of guessing. "
    "After using tools, provide a clear text summary with bullet points listing key "
    "findings grounded in the file contents you inspected."
)

MAX_STEPS = 8

type Message = dict[str, Any]
type ChatRequest = dict[str, Any]
type ChatResponse = dict[str, Any]


def _get_client() -> OpenAI:
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is not set")
    base_url = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    return OpenAI(api_key=api_key, base_url=base_url)


def _get_model() -> str:
    return os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-flash-lite")


def handle_chat(request: ChatRequest) -> ChatResponse:
    """Run one agentic chat turn. Returns the ChatResponse shape from service.ts.

    The whole loop is wrapped in a single root span so every auto-instrumented
    LLM call and manual tool span shares one OTel trace (and thus one apo run).
    Without this, each ``chat.completions.create`` would start its own trace and
    the dashboard would show N separate one-call traces instead of one cohesive
    multi-turn conversation.
    """
    client = _get_client()
    model = _get_model()
    files: dict[str, str] = request.get("files") or {}

    messages = _build_messages(request)
    tool_calls_log: list[dict[str, Any]] = []
    totals = {"prompt": 0, "completion": 0}
    final_text = ""

    # Root span groups all LLM turns + tool calls under one trace → one apo run.
    with _tracer.start_as_current_span("agent-chat") as root:
        root.set_attribute("apo.observation.type", "AGENT")
        root.set_attribute("gen_ai.operation.name", "agent_chat")

        for step_num in range(1, MAX_STEPS + 1):
            assistant_msg = _step(
                client=client,
                model=model,
                messages=messages,
                files=files,
                tool_calls_log=tool_calls_log,
                totals=totals,
                step_num=step_num,
            )
            if not _has_tool_calls(assistant_msg):
                final_text = _extract_text(assistant_msg)
                break
        else:
            final_text = "(reached step limit)"

    usage = None
    if totals["prompt"] or totals["completion"]:
        usage = {
            "input_tokens": totals["prompt"],
            "output_tokens": totals["completion"],
        }

    return {
        "response": final_text,
        "tool_calls": tool_calls_log,
        "usage": usage,
    }


def _build_messages(request: ChatRequest) -> list[Message]:
    messages: list[Message] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in request.get("messages") or []:
        role = m.get("role")
        content = m.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    return messages


def _step(
    *,
    client: OpenAI,
    model: str,
    messages: list[Message],
    files: dict[str, str],
    tool_calls_log: list[dict[str, Any]],
    totals: dict[str, int],
    step_num: int,
) -> Message:
    """One LLM turn + its tool executions. Returns the assistant message.

    We wrap the whole turn in a manual ``turn`` span so the auto-instrumented
    LLM call and the manual TOOL spans share a common parent and form a proper
    sub-tree under the agent-chat root. Without this wrapper, the auto-instrumented
    LLM span closes when ``chat.completions.create`` returns, and the OTel
    context pops back to the root — leaving TOOL spans as flat siblings of the
    GENERATION rather than children of it.
    """
    with _tracer.start_as_current_span(f"turn {step_num}") as turn:
        turn.set_attribute("apo.observation.type", "CHAIN")

        # The instrumentor wraps this call and emits a GENERATION span nested
        # under the turn span (via the active context).
        completion = client.chat.completions.create(
            model=model,
            messages=cast("list[ChatCompletionMessageParam]", messages),
            tools=cast("Iterable[ChatCompletionToolParam]", OPENAI_TOOLS),
        )

        prompt_tokens = getattr(completion.usage, "prompt_tokens", 0) or 0
        completion_tokens = getattr(completion.usage, "completion_tokens", 0) or 0
        totals["prompt"] += prompt_tokens
        totals["completion"] += completion_tokens

        msg = completion.choices[0].message
        assistant_msg: Message = _assistant_message(msg)
        messages.append(assistant_msg)

        if msg.tool_calls:
            for tc in msg.tool_calls:
                function = getattr(tc, "function", None)
                if function is None:
                    continue
                tool_name = function.name
                tool_args = _parse_args(function.arguments)

                # Manual TOOL span — nested under the turn span via the active
                # context, alongside the GENERATION span from this turn.
                with _tracer.start_as_current_span(f"tool {tool_name}") as span:
                    span.set_attribute("gen_ai.tool.name", tool_name)
                    span.set_attribute(
                        "gen_ai.tool.call.arguments", json.dumps(tool_args)
                    )
                    try:
                        result = dispatch(tool_name, tool_args, files)
                    except Exception as exc:  # noqa: BLE001
                        result = {"error": str(exc)}
                    span.set_attribute(
                        "gen_ai.tool.call.result", json.dumps(result)
                    )

                tool_calls_log.append({"tool": tool_name, "args": tool_args, "result": result})
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": json.dumps(result),
                    }
                )

    return assistant_msg


def _assistant_message(msg: Any) -> Message:
    """Convert an OpenAI ChatCompletionMessage into a plain dict for re-submission."""
    result: Message = {"role": "assistant", "content": msg.content or ""}
    if msg.tool_calls:
        calls = []
        for tc in msg.tool_calls:
            function = getattr(tc, "function", None)
            if function is None:
                continue
            calls.append(
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": function.name, "arguments": function.arguments},
                }
            )
        result["tool_calls"] = calls
    return result


def _has_tool_calls(message: Message | None) -> bool:
    return bool(message and message.get("tool_calls"))


def _extract_text(message: Message | None) -> str:
    if not message:
        return ""
    content = message.get("content")
    return content if isinstance(content, str) else ""


def _parse_args(raw: str | None) -> dict[str, Any]:
    """Best-effort JSON parse of a tool-call arguments string."""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {"_raw": raw}
    return parsed if isinstance(parsed, dict) else {"_raw": raw}
