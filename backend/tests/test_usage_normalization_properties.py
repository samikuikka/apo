# pyright: reportAny=false, reportAttributeAccessIssue=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnusedCallResult=false

"""Generated-input laws for provider usage normalization.

The fixture suite (``test_usage_normalization.py``) checks captured payloads;
these laws state the conventions every normalizer must obey for ANY payload,
so a future provider edit that breaks them fails a test instead of shipping a
subtle display bug. The conventions, in one place:

  - Normalized ``input`` is net of cache on every provider, whatever the
    provider's own reporting convention (the #131 lesson).
  - The ``prompt`` column (``_token_usage``) is the input family sum, so it
    recovers the whole prompt on every convention: reported input plus the
    cache parts that sat outside it.
  - ``output`` + ``reasoning`` conserves reported output tokens.
  - Nothing is ever negative, even for payloads the floors have to clamp.
"""

from __future__ import annotations

from typing import Any

from hypothesis import given, settings
from hypothesis.strategies import DrawFn, composite, integers

from apo.services.otel_normalization import _token_usage
from apo.services.usage_normalization import INPUT_INCLUDES_CACHE_ATTR, normalize_usage

# provider name -> does its input_tokens include cache_read (OTel GenAI
# semconv)? Anthropic reports input net of cache; the rest include it.
PROVIDERS: dict[str, bool] = {
    "openai": True,
    "bedrock": True,
    "gemini": True,
    "anthropic": False,
}

COUNTS = integers(min_value=0, max_value=1_000_000)


def attrs_with_provider(provider: str, usage: dict[str, Any]) -> dict[str, Any]:
    return {"gen_ai.provider.name": provider, **usage}


@settings(max_examples=200)
@given(
    input_tokens=COUNTS,
    cache_read=COUNTS,
    output_tokens=COUNTS,
    reasoning=COUNTS,
)
def test_subsets_never_make_counts_negative(
    input_tokens: int, cache_read: int, output_tokens: int, reasoning: int
) -> None:
    # Unconstrained: subsets may exceed totals; the normalizers must clamp
    # rather than let a count wrap negative.
    for provider in PROVIDERS:
        usage = normalize_usage(
            attrs_with_provider(
                provider,
                {
                    "gen_ai.usage.input_tokens": input_tokens,
                    "gen_ai.usage.output_tokens": output_tokens,
                    "gen_ai.usage.cache_read.input_tokens": cache_read,
                    "gen_ai.usage.reasoning.output_tokens": reasoning,
                },
            ),
            provider,
        )
        for key, value in usage.items():
            assert value >= 0, f"{provider}.{key} went negative"


@settings(max_examples=200)
@given(input_tokens=COUNTS, cache_read=COUNTS)
def test_input_is_net_of_cache_on_inclusive_providers(input_tokens: int, cache_read: int) -> None:
    reported = {
        "gen_ai.usage.input_tokens": input_tokens,
        "gen_ai.usage.cache_read.input_tokens": cache_read,
    }
    for provider, inclusive in PROVIDERS.items():
        usage = normalize_usage(attrs_with_provider(provider, reported), provider)
        if inclusive:
            assert usage["input"] == max(input_tokens - cache_read, 0)
        else:
            assert usage["input"] == input_tokens


@settings(max_examples=200)
@given(input_tokens=COUNTS, output_tokens=COUNTS, reasoning=COUNTS)
def test_output_plus_reasoning_conserves_reported_output(
    input_tokens: int, output_tokens: int, reasoning: int
) -> None:
    # Real providers send reasoning inside output; the normalizers cap the
    # reasoning share at output, so the pair conserves the reported total
    # whatever the split.
    reported = {
        "gen_ai.usage.input_tokens": input_tokens,
        "gen_ai.usage.output_tokens": output_tokens,
        "gen_ai.usage.reasoning.output_tokens": min(reasoning, output_tokens),
    }
    for provider in PROVIDERS:
        usage = normalize_usage(attrs_with_provider(provider, reported), provider)
        assert usage["output"] + usage.get("reasoning", 0) == output_tokens


@settings(max_examples=200)
@given(input_tokens=COUNTS, cache_read=COUNTS, cache_write=COUNTS)
def test_prompt_column_is_the_input_family_sum(
    input_tokens: int, cache_read: int, cache_write: int
) -> None:
    # The #131 law, stated free of any reporting convention: the prompt
    # column always equals the normalized input-side parts summed. Even a
    # contradictory payload (reads exceeding input) keeps the two in step,
    # because the input floor and the family sum use the same parts.
    reported = {
        "gen_ai.usage.input_tokens": input_tokens,
        "gen_ai.usage.cache_read.input_tokens": cache_read,
        "gen_ai.usage.cache_creation.input_tokens": cache_write,
    }
    for provider in PROVIDERS:
        attrs = attrs_with_provider(provider, reported)
        parts = normalize_usage(attrs, provider)
        column = _token_usage(attrs, None)
        assert column["prompt"] == (
            parts["input"] + parts.get("cache_read", 0) + parts.get("cache_write_5m", 0)
        )


@composite
def _reads_inside_input(draw: DrawFn) -> tuple[int, int, int]:
    """The shape real providers send: cache_read never exceeds the reported
    input it sits inside."""
    input_tokens = draw(COUNTS)
    return input_tokens, draw(integers(min_value=0, max_value=input_tokens)), draw(COUNTS)


@settings(max_examples=200)
@given(args=_reads_inside_input())
def test_prompt_column_recovers_the_whole_prompt_on_every_convention(args: tuple[int, int, int]) -> None:
    # With reads inside reported input, the column recovers the whole prompt:
    # inclusive reporters already count cache_read inside input; Anthropic
    # reports it on top. Cache writes sit outside input on every provider,
    # so they always land on top of the reported count.
    input_tokens, cache_read, cache_write = args
    reported = {
        "gen_ai.usage.input_tokens": input_tokens,
        "gen_ai.usage.cache_read.input_tokens": cache_read,
        "gen_ai.usage.cache_creation.input_tokens": cache_write,
    }
    for provider, inclusive in PROVIDERS.items():
        attrs = attrs_with_provider(provider, reported)
        column = _token_usage(attrs, None)
        reads_on_top = cache_read if not inclusive else 0
        assert column["prompt"] == input_tokens + reads_on_top + cache_write


@settings(max_examples=200)
@given(total=COUNTS, offset=COUNTS)
def test_anthropic_ttl_split_conserves_the_creation_total(total: int, offset: int) -> None:
    # 5m + 1h are subsets of the creation total; the non-TTL remainder is
    # bucketed as 5m. The three-way split must sum back to the total.
    five_m = min(offset, total)
    one_h = total - five_m
    usage = normalize_usage(
        attrs_with_provider(
            "anthropic",
            {
                "gen_ai.usage.input_tokens": 10,
                "gen_ai.usage.cache_creation.input_tokens": total,
                "gen_ai.usage.cache_creation.ephemeral_5m_input_tokens": five_m,
                "gen_ai.usage.cache_creation.ephemeral_1h_input_tokens": one_h,
            },
        ),
        "anthropic",
    )
    assert usage["cache_write_5m"] + usage["cache_write_1h"] == total


@settings(max_examples=200)
@given(input_tokens=COUNTS, cache_read=COUNTS, cache_write=COUNTS)
def test_sdk_marked_input_conserves_the_whole_prompt(
    input_tokens: int, cache_read: int, cache_write: int
) -> None:
    # The SDK flag: cache_read AND cache_creation both sit inside
    # input_tokens, so after subtracting both, the family sums back to the
    # reported input.
    usage = normalize_usage(
        {
            INPUT_INCLUDES_CACHE_ATTR: True,
            "gen_ai.usage.input_tokens": input_tokens + cache_read + cache_write,
            "gen_ai.usage.cache_read.input_tokens": cache_read,
            "gen_ai.usage.cache_creation.input_tokens": cache_write,
        }
    )
    assert usage["input"] + usage["cache_read"] + usage["cache_write_5m"] == (
        input_tokens + cache_read + cache_write
    )
