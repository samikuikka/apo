# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""Shared semantic contract for SDK and backend OTel projections."""

import json
from datetime import datetime, timezone
from pathlib import Path

from apo.models.db import OtlpSpanDB
from apo.services.otel_normalization import normalize_span


_FIXTURE_PATH = Path(__file__).parents[2] / "test-fixtures/otel-classification.json"


def test_backend_matches_shared_otel_classification_contract() -> None:
    cases = json.loads(_FIXTURE_PATH.read_text())

    for case in cases:
        normalized = normalize_span(OtlpSpanDB(
            project_id="contract",
            trace_id="0123456789abcdef0123456789abcdef",
            span_id="0123456789abcdef",
            span_name=case["spanName"],
            attributes=case["attributes"],
            resource={},
            raw_span={},
            start_time=datetime.now(timezone.utc),
        ))
        expected = case["expected"]

        assert normalized.observation_type == expected["observationType"], case["name"]
        if "model" in expected:
            assert normalized.model == expected["model"], case["name"]
        if "promptTokens" in expected:
            assert normalized.token_usage.get("prompt") == expected["promptTokens"], case["name"]
        if "completionTokens" in expected:
            assert normalized.token_usage.get("completion") == expected["completionTokens"], case["name"]
        if "text" in expected:
            assert normalized.output is not None
            assert normalized.output.get("text") == expected["text"], case["name"]
        if "toolName" in expected:
            assert normalized.tool_name == expected["toolName"], case["name"]
            assert normalized.tool_parameters == expected["toolParameters"], case["name"]
            assert normalized.tool_result == expected["toolResult"], case["name"]
