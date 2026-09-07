# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""Provider usage normalization.

The backend is the single normalizer. ``normalize_usage`` maps a provider's
raw usage attributes onto the canonical ``UsageKey`` set, enforcing the OTel
GenAI non-overlap invariant (cache/reasoning subtracted from input/output).

Provider detection is a multi-signal hierarchy (most-authoritative first):
   1. ``ai.response.providerMetadata`` key-membership (carries Anthropic 5m/1h)
   2. ``gen_ai.system`` attribute
   3. model-name prefix heuristic (``anthropic/``, ``openai/``, …)
   4. bare model-family heuristic (``claude-*``, ``gpt-*``, ``o1/o3-*``, ``gemini-*``)
   5. generic fallback

Replaces ``extract_tokens``. Callable from BOTH the projector and the legacy
direct-writer.
"""

from __future__ import annotations

from typing import Any

from . import anthropic, bedrock, generic, gemini, openai
from ._shared import get_json_dict, get_str

# model-name prefix -> provider (OpenRouter-style "anthropic/...", "openai/...").
_PREFIX_PROVIDERS: dict[str, str] = {
    "anthropic/": "anthropic",
    "openai/": "openai",
    "meta.llama": "bedrock",  # Bedrock model IDs: meta.llama3-...
    "amazon.": "bedrock",  # amazon.nova, amazon.titan
    "cohere.": "bedrock",
    "ai21.": "bedrock",
    "gemini/": "gemini",
    "google/": "gemini",
    "vertex_ai/": "gemini",
}

# Bare model-family prefix -> provider. Catches plain provider model names
# that carry no vendor/ prefix (e.g. "claude-opus-5", "gpt-5.6-luna",
# "o3-mini", "gemini-2.0-flash"). Without this, cache-creation tokens on
# Anthropic spans fall through to the generic normalizer, which prices no
# cache-write dimension — silently zeroing the dominant cost component
# (issue #125).
_MODEL_FAMILY_PROVIDERS: dict[str, str] = {
    "claude": "anthropic",
    "gpt": "openai",
    "o1": "openai",
    "o3": "openai",
    "o4": "openai",
    "gemini": "gemini",
}

# providerMetadata JSON key-membership -> provider.
_METADATA_KEYS: dict[str, str] = {
    "anthropic": "anthropic",
    "openai": "openai",
    "bedrock": "bedrock",
    "google": "gemini",
    "gemini": "gemini",
}

# gen_ai.system value -> provider.
_SYSTEM_PROVIDERS: dict[str, str] = {
    "openai": "openai",
    "anthropic": "anthropic",
    "bedrock": "bedrock",
    "gemini": "gemini",
    "google": "gemini",
    "vertex_ai": "gemini",
}


def detect_provider(attrs: dict[str, Any], model_name: str | None) -> str:
    """Multi-signal provider detection hierarchy (ticket 03 §detection)."""
    # 1. providerMetadata key-membership.
    metadata = get_json_dict(attrs, "ai.response.providerMetadata")
    if metadata:
        for key, provider in _METADATA_KEYS.items():
            if key in metadata:
                return provider

    # 2. gen_ai.system attribute.
    system = get_str(attrs, "gen_ai.system")
    if system and system.lower() in _SYSTEM_PROVIDERS:
        return _SYSTEM_PROVIDERS[system.lower()]

    # 3. model-name prefix heuristic.
    if model_name:
        lowered = model_name.lower()
        for prefix, provider in _PREFIX_PROVIDERS.items():
            if lowered.startswith(prefix):
                return provider

        # 4. bare model-family heuristic (strip any vendor/ prefix first).
        bare = lowered.split("/", 1)[-1]
        for family, provider in _MODEL_FAMILY_PROVIDERS.items():
            if bare.startswith(family):
                return provider

    # 5. generic fallback.
    return "generic"


def normalize_usage(
    attrs: dict[str, Any],
    provider: str | None = None,
    model_name: str | None = None,
) -> dict[str, int]:
    """Map a provider's raw usage attributes onto canonical UsageKeys.

    Enforces the non-overlap invariant: cache/reasoning subtracted from
    input/output so the families don't double-count. Unknown keys are kept
    verbatim (store-but-unpriced). Returns ``{}`` when no usage is present.
    """
    detected = provider or detect_provider(attrs, model_name)
    if detected == "openai":
        return openai.normalize(attrs)
    if detected == "anthropic":
        return anthropic.normalize(attrs)
    if detected == "bedrock":
        return bedrock.normalize(attrs)
    if detected == "gemini":
        return gemini.normalize(attrs)
    return generic.normalize(attrs)


__all__ = ["detect_provider", "normalize_usage"]
