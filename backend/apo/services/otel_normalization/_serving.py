# pyright: reportAny=false, reportExplicitAny=false

"""Serving identity and timing extraction from canonical span attributes.

One entry point, :func:`extract_serving`, reads the explicit ``apo.llm.*``
extension attributes plus the documented GenAI / OpenInference conventions
and produces a :class:`~apo.models.serving.ServingIdentity` with per-field
provenance. Unknown stays null; unknown is never a provider string, and no
value is ever guessed from the model name.

Rules the rest of the system depends on:

- instrumentation provider is evidence about the trace convention, never
  proof of who served the call (``gen_ai.provider.name`` describes the
  instrumentation's API flavor);
- the API provider is never copied into the serving host: gateways and
  managed proxies make that implication unsafe;
- route strings stay opaque (``openrouter:nitro->baseten`` is a label, not
  three facts);
- requested and served tiers are independent fields;
- malformed optional telemetry becomes null plus a diagnostic instead of
  failing trace ingestion.
"""

from __future__ import annotations

import logging
import math
from typing import Any

from ...models.serving import (
    IDENTITY_MAX_BYTES,
    MODEL_ID_MAX_BYTES,
    IdentityEvidence,
    ServingIdentity,
)

logger = logging.getLogger(__name__)

MAPPER_NAME = "serving"
MAPPER_VERSION = 1

# Known provider aliases, applied case-insensitively to the selector
# identity fields only (api_provider, serving_host). Unrecognized ids are
# preserved verbatim after trimming.
_PROVIDER_ALIASES: dict[str, str] = {
    "fireworks": "fireworks",
    "fireworks-ai": "fireworks",
    "fireworks_ai": "fireworks",
    "openrouter": "openrouter",
    "baseten": "baseten",
}

_SCOPE_VALUES = ("text", "all_output")
_REQUEST_KIND_VALUES = ("request", "aggregate")

_VERCEL_REQUEST_CHILD_NAMES = (
    "ai.generateText.doGenerate",
    "ai.streamText.doStream",
)


class NormalizedServing:
    """Extraction result: identity, timing evidence, request accounting."""

    identity: ServingIdentity
    first_content_offset_ms: float | None
    output_token_scope: str | None
    first_content_scope: str | None
    request_kind: str | None
    diagnostics: list[str]

    def __init__(
        self,
        identity: ServingIdentity,
        *,
        first_content_offset_ms: float | None = None,
        output_token_scope: str | None = None,
        first_content_scope: str | None = None,
        request_kind: str | None = None,
        diagnostics: list[str] | None = None,
    ) -> None:
        self.identity = identity
        self.first_content_offset_ms = first_content_offset_ms
        self.output_token_scope = output_token_scope
        self.first_content_scope = first_content_scope
        self.request_kind = request_kind
        self.diagnostics = diagnostics or []


# The AI SDK's telemetry metadata channel: an app that knows who it calls
# declares it once per call site and the AI SDK flattens it onto spans as
# ``ai.telemetry.metadata.apo.llm.<field>``. A documented convention source
# for identity, with convention provenance.
_AI_SDK_METADATA_PREFIX = "ai.telemetry.metadata.apo.llm."


def _metadata_str(
    attrs: dict[str, Any], field: str
) -> str | None:
    value = attrs.get(_AI_SDK_METADATA_PREFIX + field)
    if isinstance(value, str) and value.strip():
        return value
    return None


def extract_serving(
    attrs: dict[str, Any], span_name: str = "", observation_type: str = "GENERATION"
) -> NormalizedServing:
    """Extract serving identity, timing evidence, and request accounting."""
    diagnostics: list[str] = []
    identity = ServingIdentity()

    identity.instrumentation_provider = _clean_identity(
        _first_str(attrs, "gen_ai.provider.name", "gen_ai.system"),
        IDENTITY_MAX_BYTES,
        "instrumentation_provider",
        diagnostics,
    )
    if identity.instrumentation_provider is not None:
        source = (
            "gen_ai.provider.name"
            if _first_str(attrs, "gen_ai.provider.name")
            else "gen_ai.system"
        )
        identity.evidence["instrumentation_provider"] = IdentityEvidence(
            source=source, kind="reported"
        )

    identity.api_provider = _clean_provider(
        _first_str(attrs, "apo.llm.api_provider")
        or _metadata_str(attrs, "api_provider"),
        diagnostics,
    )
    if identity.api_provider is not None:
        explicit_api = _first_str(attrs, "apo.llm.api_provider") is not None
        identity.evidence["api_provider"] = IdentityEvidence(
            source=(
                "apo.llm.api_provider"
                if explicit_api
                else "ai.telemetry.metadata.apo.llm.api_provider"
            ),
            kind="reported" if explicit_api else "convention",
        )

    identity.serving_host = _extract_serving_host(attrs, diagnostics, identity)

    identity.route = _clean_identity(
        _first_str(attrs, "apo.llm.route") or _metadata_str(attrs, "route"),
        IDENTITY_MAX_BYTES,
        "route",
        diagnostics,
    )
    if identity.route is not None:
        explicit_route = _first_str(attrs, "apo.llm.route") is not None
        identity.evidence["route"] = IdentityEvidence(
            source="apo.llm.route" if explicit_route else "ai.telemetry.metadata.apo.llm.route",
            kind="reported" if explicit_route else "convention",
        )

    identity.requested_service_tier = _clean_identity(
        _first_str(attrs, "apo.llm.requested_service_tier"),
        IDENTITY_MAX_BYTES,
        "requested_service_tier",
        diagnostics,
    )
    if identity.requested_service_tier is not None:
        identity.evidence["requested_service_tier"] = IdentityEvidence(
            source="apo.llm.requested_service_tier", kind="reported"
        )

    identity.service_tier = _clean_identity(
        _first_str(attrs, "apo.llm.service_tier")
        or _metadata_str(attrs, "service_tier"),
        IDENTITY_MAX_BYTES,
        "service_tier",
        diagnostics,
    )
    if identity.service_tier is not None:
        explicit_tier = _first_str(attrs, "apo.llm.service_tier") is not None
        identity.evidence["service_tier"] = IdentityEvidence(
            source=(
                "apo.llm.service_tier"
                if explicit_tier
                else "ai.telemetry.metadata.apo.llm.service_tier"
            ),
            kind="reported" if explicit_tier else "convention",
        )

    identity.request_model = _clean_identity(
        _first_str(attrs, "gen_ai.request.model"),
        MODEL_ID_MAX_BYTES,
        "request_model",
        diagnostics,
    )
    if identity.request_model is not None:
        identity.evidence["request_model"] = IdentityEvidence(
            source="gen_ai.request.model", kind="reported"
        )

    identity.response_model = _clean_identity(
        _first_str(attrs, "gen_ai.response.model"),
        MODEL_ID_MAX_BYTES,
        "response_model",
        diagnostics,
    )
    if identity.response_model is not None:
        identity.evidence["response_model"] = IdentityEvidence(
            source="gen_ai.response.model", kind="reported"
        )

    return NormalizedServing(
        identity,
        first_content_offset_ms=_extract_offset_ms(attrs, diagnostics),
        output_token_scope=_extract_scope(attrs, "apo.llm.output_token_scope", diagnostics),
        first_content_scope=_extract_scope(attrs, "apo.llm.first_content_scope", diagnostics),
        request_kind=_request_kind(attrs, span_name, observation_type),
        diagnostics=diagnostics,
    )


def _extract_serving_host(
    attrs: dict[str, Any], diagnostics: list[str], identity: ServingIdentity
) -> str | None:
    """Explicit ``apo.llm.serving_host`` wins; OpenInference ``llm.provider``
    supplies a host through its documented adapter with convention
    provenance. ``llm.system`` describes an API shape and is never a host."""
    explicit = _clean_provider(_first_str(attrs, "apo.llm.serving_host"), diagnostics)
    if explicit is not None:
        identity.evidence["serving_host"] = IdentityEvidence(
            source="apo.llm.serving_host", kind="reported"
        )
        return explicit

    convention = _clean_provider(_first_str(attrs, "llm.provider"), diagnostics)
    if convention is not None:
        identity.evidence["serving_host"] = IdentityEvidence(
            source="llm.provider", kind="convention"
        )
        return convention
    return None


def _request_kind(
    attrs: dict[str, Any], span_name: str, observation_type: str
) -> str | None:
    """Classify the span's role in request accounting.

    An explicit ``apo.llm.request_kind`` wins. Otherwise a Vercel per-step
    child span (``ai.generateText.doGenerate`` / ``ai.streamText.doStream``)
    is one physical request, a Vercel wrapper span is an aggregate of its
    children, and any other GENERATION is a single request. Non-generation
    observations (tools, chains, bookkeeping spans) carry no request role at
    all: None keeps them out of serving rollups entirely. A wrapper with no
    child evidence is unknown, never several invented physical calls.
    """
    explicit = _first_str(attrs, "apo.llm.request_kind")
    if explicit is not None:
        cleaned = explicit.strip().lower()
        if cleaned in _REQUEST_KIND_VALUES:
            return cleaned
        return None

    if observation_type != "GENERATION":
        return None
    if span_name in _VERCEL_REQUEST_CHILD_NAMES:
        return "request"
    if span_name in ("ai.generateText", "ai.streamText"):
        return "aggregate"
    if span_name.startswith("ai."):
        return "unknown"
    return "request"


def _extract_offset_ms(attrs: dict[str, Any], diagnostics: list[str]) -> float | None:
    raw = attrs.get("apo.llm.first_content_offset_ms")
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        diagnostics.append("first_content_offset_ms not a number")
        return None
    if not math.isfinite(value):
        diagnostics.append("first_content_offset_ms not finite")
        return None
    if value < 0:
        diagnostics.append("first_content_offset_ms negative")
        return None
    return value


def _extract_scope(
    attrs: dict[str, Any], key: str, diagnostics: list[str]
) -> str | None:
    raw = _first_str(attrs, key)
    if raw is None:
        return None
    cleaned = raw.strip().lower()
    if cleaned in _SCOPE_VALUES:
        return cleaned
    diagnostics.append(f"{key} not text/all_output")
    return None


def _clean_provider(raw: str | None, diagnostics: list[str]) -> str | None:
    cleaned = _clean_identity(raw, IDENTITY_MAX_BYTES, "provider", diagnostics)
    if cleaned is None:
        return None
    return _PROVIDER_ALIASES.get(cleaned.lower(), cleaned)


def _clean_identity(
    raw: Any, max_bytes: int, field: str, diagnostics: list[str]
) -> str | None:
    if raw is None:
        return None
    if not isinstance(raw, str):
        diagnostics.append(f"{field} not a string")
        return None
    cleaned = raw.strip()
    if not cleaned:
        return None
    if len(cleaned.encode("utf-8")) > max_bytes:
        diagnostics.append(f"{field} exceeds {max_bytes} bytes")
        return None
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in cleaned):
        diagnostics.append(f"{field} contains control characters")
        return None
    return cleaned


def _first_str(attrs: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = attrs.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None
