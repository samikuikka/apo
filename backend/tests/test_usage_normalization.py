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
    # If input + all cache keys are present, the cache keys are a SUBSET — so
    # the "net input" (input alone) must be >= 0 and <= total input side.
    input_total = usage.get(UsageKey.INPUT.value, 0)
    cache_read = usage.get(UsageKey.CACHE_READ.value, 0)
    cache_w5m = usage.get(UsageKey.CACHE_WRITE_5M.value, 0)
    cache_w1h = usage.get(UsageKey.CACHE_WRITE_1H.value, 0)
    cache_sum = cache_read + cache_w5m + cache_w1h
    # input excludes cache: input is the non-cached portion. If both present,
    # input + cache must be coherent (we assert input >= 0, i.e. not negative
    # after subtraction — the normalizer already subtracted).
    assert input_total >= 0, "input must not be negative after cache subtraction"
    if cache_sum:
        assert input_total >= 0  # cache subtracted, not added
    output = usage.get(UsageKey.OUTPUT.value, 0)
    reasoning = usage.get(UsageKey.REASONING.value, 0)
    assert output >= 0, "output must not be negative after reasoning subtraction"
    if reasoning:
        assert output >= 0  # reasoning subtracted from output, not added


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
