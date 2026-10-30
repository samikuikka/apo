# pyright: reportAny=false, reportAttributeAccessIssue=false, reportCallIssue=false, reportMissingParameterType=false, reportPrivateUsage=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUntypedFunctionDecorator=false, reportUnusedCallResult=false, reportUnusedImport=false, reportUnusedParameter=false

"""Provider usage normalization.

Parametrized over fixtures/usage/*.json. Each fixture asserts:
  - the normalized map matches the expected canonical keys
  - the non-overlap invariant holds: cache/reasoning subtracted from
    input/output (OTel GenAI semconv).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from apo.models.usage_keys import UsageKey
from apo.services.usage_normalization import detect_provider, normalize_usage

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "usage"


def _all_fixtures() -> list[tuple[str, dict[str, object]]]:
    fixtures = []
    for path in sorted(FIXTURE_DIR.glob("*.json")):
        fixtures.append((path.stem, json.loads(path.read_text())))
    return fixtures


def _assert_non_overlap(usage: dict[str, int]) -> None:
    """Cache and reasoning must be excluded from input/output (OTel semconv)."""
    # input excludes cache keys, so the non-cached remainder must not go
    # negative after the normalizer subtracts them.
    input_total = usage.get(UsageKey.INPUT.value, 0)
    assert input_total >= 0, "input must not be negative after cache subtraction"
    # output excludes reasoning tokens, so the remainder must not go negative.
    output = usage.get(UsageKey.OUTPUT.value, 0)
    assert output >= 0, "output must not be negative after reasoning subtraction"


@pytest.mark.parametrize(
    "name,fixture",
    [(f[0], f[1]) for f in _all_fixtures()],
    ids=[f[0] for f in _all_fixtures()],
)
def test_normalize_fixture_matches_expected(name: str, fixture: dict[str, object]) -> None:
    for field in ("description", "source", "input", "expected"):
        assert field in fixture, f"{name}: missing required field {field!r}"
    attrs = fixture["input"]
    provider = fixture.get("provider")
    expected = fixture["expected"]
    result = normalize_usage(attrs if isinstance(attrs, dict) else {}, provider)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
    assert result == expected, f"{name}: normalized map mismatch"


@pytest.mark.parametrize(
    "name,fixture",
    [(f[0], f[1]) for f in _all_fixtures()],
    ids=[f[0] for f in _all_fixtures()],
)
def test_non_overlap_invariant(name: str, fixture: dict[str, object]) -> None:
    attrs = fixture["input"]
    provider = fixture.get("provider")
    result = normalize_usage(attrs if isinstance(attrs, dict) else {}, provider)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
    _assert_non_overlap(result)


class TestDetectProvider:
    def test_gen_ai_system_attr(self) -> None:
        assert detect_provider({"gen_ai.system": "openai"}, "model-x") == "openai"

    def test_provider_metadata_anthropic(self) -> None:
        attrs = {"ai.response.providerMetadata": '{"anthropic": {}}'}
        assert detect_provider(attrs, "claude-3") == "anthropic"

    def test_current_bedrock_provider_attr(self) -> None:
        assert detect_provider({"gen_ai.provider.name": "aws.bedrock"}, None) == "bedrock"

    def test_explicit_current_bedrock_provider_name(self) -> None:
        result = normalize_usage(
            {
                "gen_ai.usage.output_tokens": 40,
                "gen_ai.usage.reasoning.output_tokens": 12,
            },
            provider="aws.bedrock",
        )
        assert result == {"output": 28, "reasoning": 12}

    def test_model_name_prefix_fallback(self) -> None:
        assert detect_provider({}, "anthropic/claude-3") == "anthropic"

    def test_generic_fallback(self) -> None:
        assert detect_provider({}, "some-unknown-model") == "generic"


class TestBareModelFamilyDetection:
    """Bare provider model names (no vendor/ prefix) must resolve to their
    provider so cache-creation dimensions are priced correctly (issue #125)."""

    def test_claude_bare_name(self) -> None:
        assert detect_provider({}, "claude-opus-5") == "anthropic"

    def test_gpt_bare_name(self) -> None:
        assert detect_provider({}, "gpt-5.6-luna") == "openai"

    def test_o1_bare_name(self) -> None:
        assert detect_provider({}, "o1-preview") == "openai"

    def test_o3_bare_name(self) -> None:
        assert detect_provider({}, "o3-mini") == "openai"

    def test_gemini_bare_name(self) -> None:
        assert detect_provider({}, "gemini-2.0-flash") == "gemini"

    def test_unknown_bare_still_generic(self) -> None:
        assert detect_provider({}, "deepseek-r2") == "generic"

    def test_vendor_prefix_still_works(self) -> None:
        assert detect_provider({}, "anthropic/claude-opus-5") == "anthropic"

    def test_family_does_not_override_higher_signals(self) -> None:
        # gen_ai.system wins over model-name family.
        assert detect_provider({"gen_ai.system": "openai"}, "claude-opus-5") == "openai"


class TestBareModelCacheCreation:
    """The end-to-end fix: a bare-name Anthropic span with cache-creation
    tokens must be normalized by the anthropic normalizer, which recognises
    cache_write_5m. Previously it fell through to generic, zeroing cache
    creation cost (issue #125)."""

    def test_bare_claude_cache_creation_is_priced(self) -> None:
        result = normalize_usage(
            {
                "gen_ai.usage.input_tokens": 500,
                "gen_ai.usage.output_tokens": 95,
                "gen_ai.usage.cache_read.input_tokens": 21773,
                "gen_ai.usage.cache_creation.input_tokens": 24044,
            },
            model_name="claude-opus-5",
        )
        # The anthropic normalizer recognises cache_creation → cache_write_5m.
        assert result.get("cache_write_5m") == 24044
        assert result.get("cache_read") == 21773


class TestClaudeCodeBareUsage:
    """Claude Code's ``claude_code.llm_request`` spans carry usage under bare
    attribute names. Previously no normalizer read them, so claude-agent runs
    showed no tokens and no cost despite the span carrying full usage."""

    def test_bare_keys_normalized(self) -> None:
        result = normalize_usage(
            {
                "span.type": "llm_request",
                "gen_ai.system": "anthropic",
                "gen_ai.request.model": "claude-haiku-4-5-20251001",
                "input_tokens": 9,
                "output_tokens": 220,
                "cache_read_tokens": 0,
                "cache_creation_tokens": 19635,
            },
            None,
            model_name="claude-haiku-4-5-20251001",
        )
        # Input exclusive of cache, no TTL split -> whole creation in 5m tier.
        assert result == {
            "input": 9,
            "output": 220,
            "cache_read": 0,
            "cache_write_5m": 19635,
        }

    def test_canonical_keys_win_over_bare(self) -> None:
        """A span carrying both dialects must use the canonical keys only —
        the bare translation never overrides a standard emitter."""
        result = normalize_usage(
            {
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 50,
                "input_tokens": 999,
                "output_tokens": 999,
            },
            "anthropic",
        )
        assert result == {"input": 100, "output": 50}

    def test_bare_keys_without_usage_stay_empty(self) -> None:
        """A Claude Code span that reported no usage normalizes to {}."""
        result = normalize_usage(
            {"gen_ai.system": "anthropic", "gen_ai.request.model": "claude-haiku-4-5"},
            None,
            model_name="claude-haiku-4-5",
        )
        assert result == {}


class TestPlainUsage:
    def test_genai_semconv_input_output(self) -> None:
        result = normalize_usage(
            {"gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 50},
            None,
        )
        assert result == {"input": 100, "output": 50}

    def test_empty_attributes(self) -> None:
        assert normalize_usage({}, None) == {}


class TestNonOverlapSubtraction:
    def test_cache_subtracted_from_input(self) -> None:
        """OTel semconv: cache_read is a subset of input_tokens."""
        result = normalize_usage(
            {
                "gen_ai.usage.input_tokens": 1000,  # total incl. cache
                "gen_ai.usage.output_tokens": 200,
                "gen_ai.usage.cache_read.input_tokens": 400,
            },
            "openai",
        )
        # input excludes cache_read: 1000 - 400 = 600
        assert result["input"] == 600
        assert result["cache_read"] == 400
        assert result["output"] == 200

    def test_reasoning_subtracted_from_output(self) -> None:
        """OTel semconv: reasoning.output_tokens is included in output_tokens."""
        result = normalize_usage(
            {
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 500,  # total incl. reasoning
                "gen_ai.usage.reasoning.output_tokens": 300,
            },
            "openai",
        )
        assert result["output"] == 200  # 500 - 300
        assert result["reasoning"] == 300


class TestAnthropicReasoning:
    """Claude's extended thinking is part of output_tokens. The anthropic
    normalizer used to drop the reasoning attribute, so every Claude run showed
    unknown reasoning while the span carried the count."""

    def test_bare_claude_name_splits_reasoning_out_of_output(self) -> None:
        result = normalize_usage(
            {
                "gen_ai.system": "anthropic",
                "gen_ai.usage.input_tokens": 2,
                "gen_ai.usage.output_tokens": 432,
                "gen_ai.usage.reasoning.output_tokens": 104,
            },
            model_name="claude-opus-5-5",
        )
        assert result == {"input": 2, "output": 328, "reasoning": 104}

    def test_reported_zero_reasoning_is_known_zero(self) -> None:
        result = normalize_usage(
            {
                "gen_ai.usage.input_tokens": 2,
                "gen_ai.usage.output_tokens": 254,
                "gen_ai.usage.reasoning.output_tokens": 0,
            },
            "anthropic",
        )
        assert result == {"input": 2, "output": 254, "reasoning": 0}

    def test_ai_sdk_reasoning_tokens(self) -> None:
        result = normalize_usage(
            {
                "ai.response.providerMetadata": '{"anthropic": {}}',
                "ai.usage.promptTokens": 50,
                "ai.usage.completionTokens": 400,
                "ai.usage.reasoningTokens": 150,
            },
            model_name="claude-sonnet-5-5",
        )
        assert result == {"input": 50, "output": 250, "reasoning": 150}

    def test_semconv_attribute_wins_over_ai_sdk_alias(self) -> None:
        result = normalize_usage(
            {
                "gen_ai.usage.output_tokens": 100,
                "gen_ai.usage.reasoning.output_tokens": 30,
                "ai.usage.reasoningTokens": 60,
            },
            "anthropic",
        )
        assert result == {"output": 70, "reasoning": 30}

    def test_reasoning_without_an_output_count_is_dropped(self) -> None:
        """The AI SDK 6 root ``ai.streamText`` span: its output sits under
        ``ai.usage.outputTokens``, which no normalizer reads, and its child
        span carries the full usage. Keeping its reasoning would price it on
        top of the child."""
        result = normalize_usage(
            {
                "ai.response.providerMetadata": '{"anthropic": {}}',
                "ai.usage.inputTokens": 1000,
                "ai.usage.outputTokens": 500,
                "ai.usage.reasoningTokens": 200,
            },
            model_name="claude-opus-5-5",
        )
        assert "reasoning" not in result

    def test_reasoning_is_capped_at_output(self) -> None:
        result = normalize_usage(
            {
                "gen_ai.usage.input_tokens": 10,
                "gen_ai.usage.output_tokens": 100,
                "gen_ai.usage.reasoning.output_tokens": 150,
            },
            "anthropic",
        )
        assert result == {"input": 10, "output": 0, "reasoning": 100}

    def test_negative_counts_never_price_extra_tokens(self) -> None:
        assert normalize_usage(
            {"gen_ai.usage.output_tokens": 100, "gen_ai.usage.reasoning.output_tokens": -5},
            "anthropic",
        ) == {"output": 100, "reasoning": 0}
        negative_output = normalize_usage(
            {"gen_ai.usage.output_tokens": -3, "gen_ai.usage.reasoning.output_tokens": 2},
            "anthropic",
        )
        assert negative_output["reasoning"] == 0

    def test_bedrock_reasoning_is_capped_at_output(self) -> None:
        result = normalize_usage(
            {"gen_ai.usage.output_tokens": 40, "gen_ai.usage.reasoning.output_tokens": 90},
            "bedrock",
        )
        assert result == {"output": 0, "reasoning": 40}

    def test_bedrock_semconv_provider_uses_bedrock_normalizer(self) -> None:
        result = normalize_usage(
            {
                "gen_ai.provider.name": "aws.bedrock",
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 40,
                "gen_ai.usage.cache_read.input_tokens": 20,
                "gen_ai.usage.cache_creation.input_tokens": 10,
                "gen_ai.usage.reasoning.output_tokens": 12,
            },
        )
        assert result == {
            "input": 80,
            "output": 28,
            "cache_read": 20,
            "cache_write_5m": 10,
            "reasoning": 12,
        }

    def test_bedrock_reasoning_without_output_is_dropped(self) -> None:
        result = normalize_usage(
            {"gen_ai.usage.input_tokens": 10, "gen_ai.usage.reasoning.output_tokens": 5},
            "bedrock",
        )
        assert result == {"input": 10}

    def test_without_reasoning_attribute_output_is_unchanged(self) -> None:
        result = normalize_usage(
            {"gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 90},
            "anthropic",
        )
        assert result == {"input": 10, "output": 90}


class TestInputIncludesCacheMarker:
    """apo SDK judge spans carry the whole prompt in input_tokens. Without the
    marker, an Anthropic model name picks the anthropic normalizer, which reads
    input as net of cache and prices every cached read at the full input rate."""

    _ATTRS: dict[str, int] = {
        "gen_ai.usage.input_tokens": 56946,
        "gen_ai.usage.output_tokens": 269,
        "gen_ai.usage.cache_read.input_tokens": 56708,
    }

    def test_marker_overrides_the_model_name_guess(self) -> None:
        result = normalize_usage(
            {**self._ATTRS, "apo.usage.input_includes_cache": True},
            model_name="anthropic/claude-haiku-5.5",
        )
        assert result == {"input": 238, "output": 269, "cache_read": 56708}

    def test_without_marker_anthropic_reading_is_unchanged(self) -> None:
        result = normalize_usage(self._ATTRS, model_name="anthropic/claude-haiku-5.5")
        assert result["input"] == 56946
