"""The closed canonical enum of priceable usage dimensions.

Provider SDKs emit many names for the same concept (prompt_tokens,
input_tokens, cached_tokens, reasoning_tokens, …). The normalizer
(:mod:`apo.services.usage_normalization`) maps those aliases onto exactly
these keys. Any key not in this set is store-but-unpriced: kept in
``raw_usage``, never priced.

See SPEC-136 ticket 01 for the design rationale.
"""

from enum import Enum


class UsageKey(str, Enum):
    """The 6 canonical priceable dimensions."""

    INPUT = "input"
    CACHE_READ = "cache_read"
    CACHE_WRITE_5M = "cache_write_5m"
    CACHE_WRITE_1H = "cache_write_1h"
    OUTPUT = "output"
    REASONING = "reasoning"


# The input-side family: tokens that occupy the context window on read.
# Used by the tier engine (ticket 05) to sum input + cache_read for the
# large-context threshold (cached tokens still occupy the context window).
INPUT_FAMILY: frozenset[UsageKey] = frozenset(
    {UsageKey.INPUT, UsageKey.CACHE_READ, UsageKey.CACHE_WRITE_5M, UsageKey.CACHE_WRITE_1H}
)

# The output-side family. Reasoning is billed on the output side but is a
# distinct dimension (OpenAI o-series, Gemini thinking models).
OUTPUT_FAMILY: frozenset[UsageKey] = frozenset({UsageKey.OUTPUT, UsageKey.REASONING})
