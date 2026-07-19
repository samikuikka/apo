# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Tests for the versioned normalizer registry (SPEC-133 M5)."""

from datetime import datetime, timezone
from apo.services.otel_normalization import normalize_span, NORMALIZER_VERSION
from apo.services.otel_normalization._apo import try_map as apo_map
from apo.services.otel_normalization._genai import try_map as genai_map
from apo.services.otel_normalization._openinference import try_map as oi_map
from apo.services.otel_normalization._vercel import try_map as vercel_map
from apo.services.otel_normalization._generic import try_map as generic_map
from apo.models.db import OtlpSpanDB


def _span(name="test", attrs=None):
    return OtlpSpanDB(
        project_id="test", trace_id="t1", span_id="s1",
        span_name=name, attributes=attrs or {},
        resource={}, raw_span={},
        start_time=datetime.now(timezone.utc),
    )


class TestApoOverrideMapper:
    def test_valid_override(self):
        assert apo_map({"apo.observation.type": "AGENT"}, "") == "AGENT"

    def test_case_insensitive(self):
        assert apo_map({"apo.observation.type": "generation"}, "") == "GENERATION"

    def test_invalid_type_falls_through(self):
        assert apo_map({"apo.observation.type": "GARBAGE"}, "") is None

    def test_no_override_returns_none(self):
        assert apo_map({}, "") is None


class TestGenAiMapper:
    def test_tool_name_detected(self):
        assert genai_map({"gen_ai.tool.name": "search"}, "") == "TOOL"

    def test_chat_operation(self):
        assert genai_map({"gen_ai.operation.name": "chat"}, "") == "GENERATION"

    def test_model_alone(self):
        assert genai_map({"gen_ai.request.model": "gpt-4o"}, "") == "GENERATION"

    def test_chat_span_prefix(self):
        assert genai_map({}, "chat gpt-4o") == "GENERATION"

    def test_embed_operation(self):
        assert genai_map({"gen_ai.operation.name": "embed"}, "") == "EMBEDDING"

    def test_no_genai_returns_none(self):
        assert genai_map({}, "unknown") is None


class TestOpenInferenceMapper:
    def test_llm_kind(self):
        assert oi_map({"openinference.span.kind": "LLM"}, "") == "GENERATION"

    def test_retriever_kind(self):
        assert oi_map({"openinference.span.kind": "RETRIEVER"}, "") == "RETRIEVER"

    def test_agent_kind(self):
        assert oi_map({"openinference.span.kind": "AGENT"}, "") == "AGENT"

    def test_unknown_kind_returns_none(self):
        assert oi_map({"openinference.span.kind": "UNKNOWN"}, "") is None


class TestVercelMapper:
    def test_ai_model_id(self):
        assert vercel_map({"ai.model.id": "claude-3.5"}, "") == "GENERATION"

    def test_ai_span_prefix(self):
        assert vercel_map({}, "ai.generateText") == "GENERATION"

    def test_no_ai_returns_none(self):
        assert vercel_map({}, "unknown") is None


class TestGenericMapper:
    def test_always_returns_span(self):
        assert generic_map({}, "") == "SPAN"


class TestRegistryDispatch:
    def test_apo_override_beats_genai(self):
        result = normalize_span(_span(attrs={
            "apo.observation.type": "CHAIN", "gen_ai.operation.name": "chat",
        }))
        assert result.observation_type == "CHAIN"
        assert result.mapping_name == "apo-override"

    def test_openinference_beats_genai(self):
        result = normalize_span(_span(attrs={
            "openinference.span.kind": "LLM", "gen_ai.request.model": "gpt-4o",
        }))
        assert result.mapping_name == "openinference"

    def test_genai_beats_vercel(self):
        result = normalize_span(_span(attrs={
            "gen_ai.operation.name": "chat", "ai.model.id": "claude-3.5",
        }))
        assert result.mapping_name == "gen-ai"

    def test_generic_fallback(self):
        result = normalize_span(_span(attrs={}, name="unknown-span"))
        assert result.observation_type == "SPAN"
        assert result.mapping_name == "generic"

    def test_version_is_stamped(self):
        result = normalize_span(_span())
        assert result.mapping_version == NORMALIZER_VERSION

    def test_content_extracted_through_registry(self):
        result = normalize_span(_span(attrs={
            "gen_ai.request.model": "gpt-4o",
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.usage.output_tokens": 50,
            "gen_ai.input.messages": '[{"role":"user","parts":[{"content":"hi","type":"text"}]}]',
        }))
        assert result.model == "gpt-4o"
        assert result.token_usage["prompt"] == 100
        assert result.input["messages"][0]["content"] == "hi"
