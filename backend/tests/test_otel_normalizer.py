# pyright: reportAny=false, reportDeprecated=false, reportUnknownArgumentType=false, reportUnusedCallResult=false, reportUnusedImport=false

"""Tests for the OTLP span normalizer.

The normalizer consumes canonical ``OtlpSpanDB`` rows and produces
``NormalizedSpan`` objects — the derived view the projector and dashboard use.
Classification is deterministic and ordered: apo override → OpenInference →
gen_ai.* → Vercel ai.* → generic SPAN.
"""

import json

import pytest
from apo.services.otel_normalization import (
    NormalizedSpan,
    normalize_span,
)
from apo.models.db import OtlpSpanDB


def _make_span(
    *,
    span_name: str = "test",
    attributes: dict[str, object] | None = None,
    resource: dict[str, object] | None = None,
) -> OtlpSpanDB:
    """Build a minimal OtlpSpanDB for testing."""
    return OtlpSpanDB(
        project_id="test",
        trace_id="t123",
        span_id="s123",
        span_name=span_name,
        attributes=attributes or {},
        resource=resource or {},
    )


class TestObservationTypeClassification:
    """Classification follows the documented priority order."""

    def test_apo_observation_type_override(self):
        """1. apo.observation.type takes top priority."""
        span = _make_span(attributes={"apo.observation.type": "AGENT"})
        result = normalize_span(span)
        assert result.observation_type == "AGENT"

    def test_openinference_span_kind(self):
        """2. openinference.span.kind is respected."""
        span = _make_span(attributes={"openinference.span.kind": "LLM"})
        result = normalize_span(span)
        assert result.observation_type == "GENERATION"

    def test_openinference_retriever(self):
        span = _make_span(attributes={"openinference.span.kind": "RETRIEVER"})
        result = normalize_span(span)
        assert result.observation_type == "RETRIEVER"

    def test_gen_ai_tool_name(self):
        """3. gen_ai.tool.name presence → TOOL."""
        span = _make_span(attributes={"gen_ai.tool.name": "search"})
        result = normalize_span(span)
        assert result.observation_type == "TOOL"

    def test_gen_ai_operation_chat(self):
        """3. gen_ai.operation.name=chat + model → GENERATION."""
        span = _make_span(
            attributes={"gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-4o"}
        )
        result = normalize_span(span)
        assert result.observation_type == "GENERATION"

    def test_chat_span_name_prefix(self):
        """Span name starting with 'chat ' → GENERATION (OpenAI instrumentation)."""
        span = _make_span(span_name="chat gpt-4o-mini")
        result = normalize_span(span)
        assert result.observation_type == "GENERATION"

    def test_ai_prefix_span_name(self):
        """Span name starting with 'ai.' → GENERATION (Vercel AI SDK)."""
        span = _make_span(span_name="ai.generateText")
        result = normalize_span(span)
        assert result.observation_type == "GENERATION"

    def test_default_fallback_is_span(self):
        """5. Unknown span → SPAN, never dropped."""
        span = _make_span(span_name="unknown-operation")
        result = normalize_span(span)
        assert result.observation_type == "SPAN"

    def test_apo_override_beats_gen_ai(self):
        """apo.observation.type wins over gen_ai detection."""
        span = _make_span(
            attributes={
                "apo.observation.type": "CHAIN",
                "gen_ai.operation.name": "chat",
            }
        )
        result = normalize_span(span)
        assert result.observation_type == "CHAIN"


class TestModelAttribute:
    """Model extraction from different conventions."""

    def test_model_from_gen_ai_request_model(self):
        span = _make_span(attributes={"gen_ai.request.model": "gpt-4o"})
        result = normalize_span(span)
        assert result.model == "gpt-4o"

    def test_model_from_ai_model_id(self):
        span = _make_span(attributes={"ai.model.id": "claude-3.5"})
        result = normalize_span(span)
        assert result.model == "claude-3.5"

    def test_model_from_llm_model_name(self):
        span = _make_span(attributes={"llm.model_name": "gpt-4o"})
        result = normalize_span(span)
        assert result.model == "gpt-4o"

    def test_model_none_when_absent(self):
        span = _make_span()
        result = normalize_span(span)
        assert result.model is None


class TestTokenUsage:
    """Token counts from different conventions."""

    def test_tokens_from_gen_ai_usage(self):
        span = _make_span(
            attributes={
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 50,
            }
        )
        result = normalize_span(span)
        assert result.token_usage["prompt"] == 100
        assert result.token_usage["completion"] == 50

    def test_tokens_from_ai_usage(self):
        span = _make_span(
            attributes={
                "ai.usage.promptTokens": 200,
                "ai.usage.completionTokens": 80,
            }
        )
        result = normalize_span(span)
        assert result.token_usage["prompt"] == 200
        assert result.token_usage["completion"] == 80

    def test_tokens_from_openinference(self):
        span = _make_span(
            attributes={
                "llm.token_count.prompt": 50,
                "llm.token_count.completion": 30,
            }
        )
        result = normalize_span(span)
        assert result.token_usage["prompt"] == 50
        assert result.token_usage["completion"] == 30

    def test_anthropic_cached_prompt_counts_cache_buckets(self):
        """Anthropic semantics: input_tokens is NET of cache, with cache_read /
        cache_creation as separate buckets. Reading input_tokens verbatim made a
        ~40k-token cached prompt display as 3 tokens on every call of a cached
        agent run — prompt must be the full input-side sum."""
        span = _make_span(
            attributes={
                "gen_ai.request.model": "claude-opus-5",
                "gen_ai.system": "anthropic",
                "gen_ai.usage.input_tokens": 3,
                "gen_ai.usage.output_tokens": 416,
                "gen_ai.usage.cache_read.input_tokens": 39_800,
                "gen_ai.usage.cache_creation.input_tokens": 1_000,
            }
        )
        result = normalize_span(span)
        assert result.token_usage["prompt"] == 40_803
        assert result.token_usage["completion"] == 416

    def test_openai_inclusive_input_not_double_counted(self):
        """OpenAI semantics: input_tokens already INCLUDES cache_read (OTel
        semconv subset rule). The prompt total must equal the reported
        input_tokens, not input + cache_read again."""
        span = _make_span(
            attributes={
                "gen_ai.request.model": "gpt-5.6-terra",
                "gen_ai.system": "openai",
                "gen_ai.usage.input_tokens": 39_803,
                "gen_ai.usage.output_tokens": 416,
                "gen_ai.usage.cache_read.input_tokens": 39_800,
            }
        )
        result = normalize_span(span)
        assert result.token_usage["prompt"] == 39_803
        assert result.token_usage["completion"] == 416

    def test_openai_net_input_recovers_cached_prompt(self):
        """A non-compliant OpenAI-semantics emitter that reports the net
        remainder as input_tokens (the bug this guards against): the cache_read
        bucket still dominates the sum, so the prompt reads ~the real size
        instead of ~3."""
        span = _make_span(
            attributes={
                "gen_ai.request.model": "gpt-5.6-terra",
                "gen_ai.system": "openai",
                "gen_ai.usage.input_tokens": 3,
                "gen_ai.usage.output_tokens": 416,
                "gen_ai.usage.cache_read.input_tokens": 39_800,
            }
        )
        result = normalize_span(span)
        assert result.token_usage["prompt"] == 39_800
        assert result.token_usage["completion"] == 416

class TestInputOutputContent:
    """Content extraction and normalization (gen_ai.input.messages etc.)."""

    def test_input_messages_from_gen_ai(self):
        span = _make_span(
            attributes={
                "gen_ai.input.messages": '[{"role":"user","parts":[{"content":"hi","type":"text"}]}]',
            }
        )
        result = normalize_span(span)
        assert result.input is not None
        assert "messages" in result.input
        msgs = result.input["messages"]
        assert isinstance(msgs, list)
        assert msgs[0]["role"] == "user"
        assert msgs[0]["content"] == "hi"

    def test_output_text_extracted_from_assistant(self):
        span = _make_span(
            attributes={
                "gen_ai.output.messages": '[{"role":"assistant","parts":[{"content":"hello","type":"text"}]}]',
            }
        )
        result = normalize_span(span)
        assert result.output is not None
        assert result.output.get("text") == "hello"

    def test_tool_call_round_surfaces_toolcalls_as_output(self):
        """A generation round that produced tool calls (not text) must surface
        ``ai.response.toolCalls`` as its output, not collapse to ``{}``.

        Without this, every tool-call round in an agent loop projects to an
        identical empty output, so the trace shows a wall of indistinguishable
        generations and the actual per-round tool calls vanish from the
        dashboard. The tool history still lives in TOOL observations; the
        generation's own output is what THAT round produced.
        """
        span = _make_span(
            attributes={
                "ai.response.finishReason": "tool-calls",
                "ai.response.toolCalls": json.dumps([
                    {"toolCallId": "c1", "toolName": "list_files", "input": "{}"},
                    {
                        "toolCallId": "c2",
                        "toolName": "read_file",
                        "input": '{"path": "source.py"}',
                    },
                ]),
            }
        )
        result = normalize_span(span)
        assert result.output is not None
        assert result.output.get("finishReason") == "tool-calls"
        tool_calls = result.output.get("toolCalls")
        assert isinstance(tool_calls, list) and len(tool_calls) == 2
        assert tool_calls[0]["toolName"] == "list_files"
        assert tool_calls[1]["toolName"] == "read_file"

    def test_text_wins_over_tool_calls_when_both_present(self):
        span = _make_span(
            attributes={
                "ai.response.text": "Here is the answer.",
                "ai.response.finishReason": "tool-calls",
                "ai.response.toolCalls": json.dumps(
                    [{"toolCallId": "c1", "toolName": "list_files", "input": "{}"}]
                ),
            }
        )
        result = normalize_span(span)
        assert result.output is not None
        assert result.output.get("text") == "Here is the answer."
        assert "toolCalls" not in result.output

    def test_tool_parameters_and_result(self):
        span = _make_span(
            attributes={
                "gen_ai.tool.call.arguments": '{"path": "x"}',
                "gen_ai.tool.call.result": '{"content": "hello"}',
            }
        )
        result = normalize_span(span)
        assert result.tool_parameters == {"path": "x"}
        assert result.tool_result == {"content": "hello"}

    def test_full_prompt_kept_in_generation_input(self):
        """A generation's input is the complete prompt, verbatim — system,
        user, prior assistant tool-calls, and tool results. The accumulated
        history is kept (GenAI/OTel convention); the dashboard
        renders it as a delta by default rather than stripping it here, so the
        full prompt remains available for debugging "what did the model see".
        """
        span = _make_span(
            attributes={
                "gen_ai.input.messages": json.dumps([
                    {"role": "system", "content": "You are an agent."},
                    {"role": "user", "content": "Do the task."},
                    {
                        "role": "assistant",
                        "content": [
                            {"type": "tool-call", "toolCallId": "c1", "toolName": "list_files", "input": {}},
                        ],
                    },
                    {
                        "role": "tool",
                        "content": [
                            {"type": "tool-result", "toolCallId": "c1", "toolName": "list_files",
                             "output": {"type": "text", "value": '["a"]'}},
                        ],
                    },
                ]),
            }
        )
        result = normalize_span(span)
        assert result.input is not None
        roles = [m["role"] for m in result.input["messages"]]
        # Full prompt retained: system + user + assistant tool-call + tool result.
        assert roles == ["system", "user", "assistant", "tool"]

    def test_assistant_with_text_and_tool_call_is_kept(self):
        """An assistant message that carries BOTH text and a tool call is not
        stripped — the text is real prompt content with no home elsewhere.
        """
        span = _make_span(
            attributes={
                "gen_ai.input.messages": json.dumps([
                    {
                        "role": "assistant",
                        "content": [
                            {"type": "text", "text": "Let me look at the files."},
                            {"type": "tool-call", "toolCallId": "c1", "toolName": "list_files", "input": {}},
                        ],
                    },
                ]),
            }
        )
        result = normalize_span(span)
        assert result.input is not None
        msgs = result.input["messages"]
        assert len(msgs) == 1
        assert msgs[0]["role"] == "assistant"
        assert msgs[0]["content"] == "Let me look at the files."
        assert msgs[0]["tool_calls"][0]["function"]["name"] == "list_files"

    def test_normalize_ai_sdk_v6_tool_call_part(self):
        """Direct normalization of an AI SDK v6 tool-call part resolves the
        hyphen type and v6 field names (toolCallId/toolName/input).
        """
        from apo.services.otel_normalization._shared import normalize_genai_message

        msg = normalize_genai_message({
            "role": "assistant",
            "content": [
                {"type": "tool-call", "toolCallId": "c1", "toolName": "list_files", "input": {}},
            ],
        })
        assert msg["tool_calls"] == [
            {"id": "c1", "type": "function", "function": {"name": "list_files", "arguments": "{}"}},
        ]
        assert msg["content"] == ""

    def test_normalize_ai_sdk_v6_tool_result_unwraps_output(self):
        """Direct normalization unwraps AI SDK v6 tool-result output, whether
        the value is text- or json-typed."""
        from apo.services.otel_normalization._shared import normalize_genai_message

        text_msg = normalize_genai_message({
            "role": "tool",
            "content": [{"type": "tool-result", "toolCallId": "c1", "toolName": "list_files",
                         "output": {"type": "text", "value": '["a"]'}}],
        })
        assert text_msg["content"] == '["a"]'

        json_msg = normalize_genai_message({
            "role": "tool",
            "content": [{"type": "tool-result", "toolCallId": "c2", "toolName": "list_files",
                         "output": {"type": "json", "value": {"files": ["a", "b"]}}}],
        })
        assert json.loads(json_msg["content"]) == {"files": ["a", "b"]}

    def test_normalize_legacy_underscore_tool_part(self):
        """The underscore form (older SDK / normalized shape) still resolves."""
        from apo.services.otel_normalization._shared import normalize_genai_message

        msg = normalize_genai_message({
            "role": "assistant",
            "content": [
                {"type": "tool_call", "id": "c1", "name": "read_file", "arguments": '{"p":"x"}'},
            ],
        })
        assert msg["tool_calls"][0]["function"] == {"name": "read_file", "arguments": '{"p":"x"}'}

    def test_normalize_openai_shape_tool_calls_survive(self):
        """An assistant turn whose calls live in a top-level ``tool_calls``
        array keeps them. OpenAI-compatible payloads put them there rather than
        as content parts, and dropping them left the dashboard's conversation
        view with anonymous, argument-less tool rows."""
        from apo.services.otel_normalization._shared import normalize_genai_message

        msg = normalize_genai_message({
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": "c1", "type": "function",
                 "function": {"name": "docxGetTemplatePrimitives",
                              "arguments": '{"templateId":"NAE1Bolh"}'}},
            ],
        })
        assert msg["content"] == ""
        assert msg["tool_calls"] == [
            {"id": "c1", "type": "function",
             "function": {"name": "docxGetTemplatePrimitives",
                          "arguments": '{"templateId":"NAE1Bolh"}'}},
        ]

    def test_normalize_openai_tool_calls_alongside_string_content(self):
        """Prose plus tool calls: the string-content shortcut still carries the
        calls, and dict arguments are serialized."""
        from apo.services.otel_normalization._shared import normalize_genai_message

        msg = normalize_genai_message({
            "role": "assistant",
            "content": "Let me check the template.",
            "tool_calls": [
                {"id": "c1", "function": {"name": "read", "arguments": {"path": "/a.md"}}},
            ],
        })
        assert msg["content"] == "Let me check the template."
        assert msg["tool_calls"][0]["function"] == {
            "name": "read", "arguments": '{"path": "/a.md"}',
        }

    def test_normalize_tool_message_keeps_call_identity(self):
        """A tool result keeps the ids that tie it back to its call."""
        from apo.services.otel_normalization._shared import normalize_genai_message

        msg = normalize_genai_message({
            "role": "tool",
            "tool_call_id": "c1",
            "name": "docxGetTemplatePrimitives",
            "content": '{"rules":[]}',
        })
        assert msg["content"] == '{"rules":[]}'
        assert msg["tool_call_id"] == "c1"
        assert msg["name"] == "docxGetTemplatePrimitives"

    def test_mapping_metadata_recorded(self):
        span = _make_span(attributes={"gen_ai.request.model": "gpt-4o"})
        result = normalize_span(span)
        assert result.mapping_name != ""
        assert result.mapping_version >= 1
