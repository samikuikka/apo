# pyright: reportAny=false, reportExplicitAny=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportUntypedBaseClass=false, reportCallIssue=false

"""Serving identity extraction and request accounting (pure rules).

The fixtures under ``tests/fixtures/serving/`` are sanitized synthetic
contract fixtures: each one pins one serving setup exactly as an emitter
would export it, and the parametrized case at the bottom walks every
fixture through :func:`extract_serving` end to end.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from apo.services.otel_normalization._serving import extract_serving

_FIXTURES = Path(__file__).parent / "fixtures" / "serving"


def _attrs(**values: Any) -> dict[str, Any]:
    return dict(values)


def _otlp_attrs_to_dict(span: dict[str, Any]) -> dict[str, Any]:
    attrs: dict[str, Any] = {}
    for entry in span.get("attributes", []):
        value = entry.get("value", {})
        for key in ("stringValue", "intValue", "doubleValue", "boolValue"):
            if key in value:
                attrs[entry["key"]] = value[key]
                break
    return attrs


def _fixture_attrs(name: str) -> dict[str, Any]:
    data = json.loads((_FIXTURES / f"{name}.json").read_text())
    span = data["input"]["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    return _otlp_attrs_to_dict(span)


def _fixture_span(name: str, span_name: str | None = None) -> dict[str, Any]:
    data = json.loads((_FIXTURES / f"{name}.json").read_text())
    spans = data["input"]["resourceSpans"][0]["scopeSpans"][0]["spans"]
    if span_name is not None:
        return next(s for s in spans if s.get("name") == span_name)
    return spans[0]


class TestInstrumentationProvider:
    def test_provider_name_beats_gen_ai_system(self) -> None:
        result = extract_serving(
            _attrs(**{"gen_ai.provider.name": "vercel", "gen_ai.system": "openai"})
        )
        assert result.identity.instrumentation_provider == "vercel"
        assert (
            result.identity.evidence["instrumentation_provider"].source
            == "gen_ai.provider.name"
        )

    def test_gen_ai_system_is_the_fallback_source(self) -> None:
        result = extract_serving(_attrs(**{"gen_ai.system": "openai"}))
        assert result.identity.instrumentation_provider == "openai"
        assert (
            result.identity.evidence["instrumentation_provider"].source
            == "gen_ai.system"
        )

    def test_no_provider_evidence_leaves_null(self) -> None:
        result = extract_serving(_attrs(**{"gen_ai.request.model": "m"}))
        assert result.identity.instrumentation_provider is None
        assert "instrumentation_provider" not in result.identity.evidence


class TestProviderIdentity:
    def test_openai_compatible_flavor_is_not_serving_identity(self) -> None:
        result = extract_serving(_attrs(**{"gen_ai.system": "openai"}))
        assert result.identity.instrumentation_provider == "openai"
        assert result.identity.api_provider is None
        assert result.identity.serving_host is None

    def test_api_provider_is_never_copied_into_host(self) -> None:
        result = extract_serving(_attrs(**{"apo.llm.api_provider": "fireworks"}))
        assert result.identity.api_provider == "fireworks"
        assert result.identity.serving_host is None

    def test_known_aliases_canonicalize_case_insensitively(self) -> None:
        result = extract_serving(
            _attrs(
                **{
                    "apo.llm.api_provider": "Fireworks-AI",
                    "apo.llm.serving_host": "fireworks_ai",
                }
            )
        )
        assert result.identity.api_provider == "fireworks"
        assert result.identity.serving_host == "fireworks"

    def test_unrecognized_ids_preserved_verbatim(self) -> None:
        result = extract_serving(
            _attrs(**{"apo.llm.api_provider": "custom-provider"})
        )
        assert result.identity.api_provider == "custom-provider"

    def test_openinference_llm_provider_is_a_convention_host(self) -> None:
        result = extract_serving(_attrs(**{"llm.provider": "Fireworks"}))
        assert result.identity.serving_host == "fireworks"
        assert result.identity.evidence["serving_host"].kind == "convention"
        assert result.identity.evidence["serving_host"].source == "llm.provider"

    def test_openinference_llm_system_is_never_a_host(self) -> None:
        result = extract_serving(_attrs(**{"llm.system": "openai"}))
        assert result.identity.serving_host is None

    def test_explicit_host_wins_over_convention(self) -> None:
        result = extract_serving(
            _attrs(
                **{
                    "apo.llm.serving_host": "baseten",
                    "llm.provider": "fireworks",
                }
            )
        )
        assert result.identity.serving_host == "baseten"
        assert result.identity.evidence["serving_host"].kind == "reported"

    def test_blank_values_become_null(self) -> None:
        result = extract_serving(
            _attrs(
                **{
                    "apo.llm.api_provider": "   ",
                    "apo.llm.route": "",
                }
            )
        )
        assert result.identity.api_provider is None
        assert result.identity.route is None


class TestRouteAndTiers:
    def test_route_stays_opaque(self) -> None:
        result = extract_serving(
            _attrs(**{"apo.llm.route": "openrouter:nitro->baseten"})
        )
        assert result.identity.route == "openrouter:nitro->baseten"
        assert result.identity.api_provider is None
        assert result.identity.serving_host is None

    def test_requested_and_served_tiers_are_independent(self) -> None:
        result = extract_serving(
            _attrs(
                **{
                    "apo.llm.requested_service_tier": "priority",
                    "apo.llm.service_tier": "standard",
                }
            )
        )
        assert result.identity.requested_service_tier == "priority"
        assert result.identity.service_tier == "standard"

    def test_requested_tier_alone_infers_nothing(self) -> None:
        result = extract_serving(_attrs(**{"apo.llm.requested_service_tier": "p"}))
        assert result.identity.service_tier is None


class TestScalarValidation:
    def test_control_characters_rejected_with_diagnostic(self) -> None:
        result = extract_serving(_attrs(**{"apo.llm.serving_host": "bad\x07host"}))
        assert result.identity.serving_host is None
        assert any("control characters" in d for d in result.diagnostics)

    def test_oversized_model_rejected_with_diagnostic(self) -> None:
        result = extract_serving(
            _attrs(**{"gen_ai.response.model": "m" * 300})
        )
        assert result.identity.response_model is None
        assert any("exceeds" in d for d in result.diagnostics)

    def test_oversized_other_identity_rejected(self) -> None:
        result = extract_serving(_attrs(**{"apo.llm.route": "r" * 200}))
        assert result.identity.route is None

    def test_model_ids_may_reach_255_bytes(self) -> None:
        result = extract_serving(_attrs(**{"gen_ai.response.model": "m" * 255}))
        assert result.identity.response_model == "m" * 255


class TestTimingEvidence:
    def test_valid_offset_and_scopes(self) -> None:
        attrs = _fixture_attrs("direct-fireworks-priority-request")
        result = extract_serving(attrs)
        assert result.first_content_offset_ms == 500.0
        assert result.output_token_scope == "all_output"
        assert result.first_content_scope == "all_output"

    def test_negative_offset_rejected_with_diagnostic(self) -> None:
        attrs = _fixture_attrs("invalid-telemetry-rejected")
        result = extract_serving(attrs)
        assert result.first_content_offset_ms is None
        assert any("negative" in d for d in result.diagnostics)

    @pytest.mark.parametrize("bad", [float("nan"), float("inf"), "soon"])
    def test_non_finite_or_non_numeric_offset_rejected(self, bad: Any) -> None:
        result = extract_serving(
            _attrs(**{"apo.llm.first_content_offset_ms": bad})
        )
        assert result.first_content_offset_ms is None
        assert any("first_content_offset_ms" in d for d in result.diagnostics)

    def test_unknown_scope_rejected_with_diagnostic(self) -> None:
        result = extract_serving(
            _attrs(**{"apo.llm.output_token_scope": "sometimes"})
        )
        assert result.output_token_scope is None
        assert any("output_token_scope" in d for d in result.diagnostics)

    def test_zero_offset_is_valid(self) -> None:
        result = extract_serving(
            _attrs(**{"apo.llm.first_content_offset_ms": 0})
        )
        assert result.first_content_offset_ms == 0.0


class TestRequestAccounting:
    def test_explicit_request_kind_wins(self) -> None:
        result = extract_serving(
            _attrs(**{"apo.llm.request_kind": "aggregate"}), "chat anything"
        )
        assert result.request_kind == "aggregate"

    def test_invalid_explicit_kind_is_none(self) -> None:
        attrs = _fixture_attrs("invalid-telemetry-rejected")
        result = extract_serving(attrs)
        assert result.request_kind is None

    def test_vercel_step_child_is_a_request(self) -> None:
        result = extract_serving(_attrs(), "ai.streamText.doStream")
        assert result.request_kind == "request"

    def test_vercel_wrapper_is_an_aggregate(self) -> None:
        result = extract_serving(_attrs(), "ai.streamText")
        assert result.request_kind == "aggregate"
        result = extract_serving(_attrs(), "ai.generateText")
        assert result.request_kind == "aggregate"

    def test_other_ai_spans_are_unknown(self) -> None:
        result = extract_serving(_attrs(), "ai.somethingElse")
        assert result.request_kind == "unknown"

    def test_recognized_generation_convention_defaults_to_request(self) -> None:
        result = extract_serving(
            _attrs(**{"gen_ai.operation.name": "chat"}), "chat openrouter"
        )
        assert result.request_kind == "request"


_FIXTURE_EXPECTATIONS: dict[str, dict[str, Any]] = {
    "direct-fireworks-priority-request": {
        "api_provider": "fireworks",
        "serving_host": "fireworks",
        "route": None,
        "requested_service_tier": "priority",
        "service_tier": "priority",
        "request_model": "accounts/fireworks/models/deepseek-v4-1-flash",
        "response_model": "accounts/fireworks/models/deepseek-v4-1-flash",
    },
    "openrouter-nitro-baseten": {
        "api_provider": "openrouter",
        "serving_host": "baseten",
        "route": "openrouter:nitro->baseten",
        "requested_service_tier": None,
        "service_tier": None,
        "request_model": "deepseek/deepseek-v4.1-flash:nitro",
        "response_model": "deepseek/deepseek-v4.1-flash",
    },
    "openai-compatible-unknown-provider": {
        "instrumentation_provider": "openai",
        "api_provider": None,
        "serving_host": None,
    },
    "vercel-wrapper-with-request-children": {
        "_span_name": "ai.streamText.doStream",
        "api_provider": "openrouter",
        "first_content_offset_ms": 250.0,
        "output_token_scope": "text",
        "request_kind": "request",
    },
    "error-call-gateway": {
        "api_provider": "openrouter",
        "route": "nitro",
        "serving_host": None,
    },
    "invalid-telemetry-rejected": {
        "api_provider": "custom-provider",
        "serving_host": None,
        "route": "x",
        "output_token_scope": None,
        "request_kind": None,
    },
}


class TestFixtureContracts:
    @pytest.mark.parametrize(
        "name", sorted(p.stem for p in _FIXTURES.glob("*.json"))
    )
    def test_fixture_normalizes_to_its_contract(self, name: str) -> None:
        expected = dict(_FIXTURE_EXPECTATIONS[name])
        span = _fixture_span(name, expected.pop("_span_name", None))
        result = extract_serving(_otlp_attrs_to_dict(span), span.get("name", ""))
        identity = result.identity
        for field, value in expected.items():
            if field in ("first_content_offset_ms", "output_token_scope", "request_kind"):
                assert getattr(result, field) == value, f"{name}: {field}"
            else:
                assert getattr(identity, field) == value, f"{name}: {field}"

