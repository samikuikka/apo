# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Tests for Langfuse event mapping (SPEC-016)."""

import pytest

from apo.services.langfuse_mapper import langfuse_event_to_internal


def test_trace_create_maps_to_run_create():
    body: dict[str, object] = {
        "id": "trace-001",
        "name": "my-flow",
        "userId": "user-123",
        "sessionId": "session-456",
        "environment": "production",
        "tags": ["v2", "experiment"],
        "metadata": {"key": "value"},
    }
    result = langfuse_event_to_internal("trace-create", body)
    assert result is not None
    assert result["type"] == "run-create"
    ib = result["body"]
    assert isinstance(ib, dict)
    assert ib["id"] == "trace-001"
    assert ib["flow_name"] == "my-flow"
    assert ib["user_id"] == "user-123"
    assert ib["session_id"] == "session-456"
    assert ib["environment"] == "production"
    assert ib["tags"] == ["v2", "experiment"]


def test_generation_create_maps_to_call_create():
    body: dict[str, object] = {
        "id": "obs-001",
        "traceId": "trace-001",
        "name": "llm-call",
        "type": "GENERATION",
        "startTime": "2026-01-01T00:00:00Z",
        "endTime": "2026-01-01T00:00:05Z",
        "model": "gpt-4",
        "input": {"prompt": "hello"},
        "output": {"text": "world"},
        "usage": {"promptTokens": 10, "completionTokens": 20},
        "metadata": {"meta_key": "meta_val"},
    }
    result = langfuse_event_to_internal("generation-create", body)
    assert result is not None
    assert result["type"] == "call-create"
    ib = result["body"]
    assert isinstance(ib, dict)
    assert ib["id"] == "obs-001"
    assert ib["run_id"] == "trace-001"
    assert ib["observation_type"] == "GENERATION"
    assert ib["prompt_tokens"] == 10
    assert ib["completion_tokens"] == 20
    assert ib["total_tokens"] == 30


def test_span_create_maps_to_span_observation():
    body: dict[str, object] = {
        "id": "span-001",
        "traceId": "trace-001",
        "parentObservationId": "obs-parent",
        "name": "sub-span",
        "startTime": "2026-01-01T00:00:00Z",
    }
    result = langfuse_event_to_internal("span-create", body)
    assert result is not None
    assert result["type"] == "call-create"
    ib = result["body"]
    assert isinstance(ib, dict)
    assert ib["observation_type"] == "SPAN"
    assert ib["parent_call_id"] == "obs-parent"


def test_observation_update_maps_to_call_update():
    body: dict[str, object] = {
        "id": "obs-001",
        "output": {"text": "updated"},
        "endTime": "2026-01-01T00:00:10Z",
        "usage": {"promptTokens": 15, "completionTokens": 25},
    }
    result = langfuse_event_to_internal("generation-update", body)
    assert result is not None
    assert result["type"] == "call-update"
    ib = result["body"]
    assert isinstance(ib, dict)
    assert ib["id"] == "obs-001"
    assert ib["output"] == {"text": "updated"}
    assert ib["prompt_tokens"] == 15
    assert ib["completion_tokens"] == 25


def test_score_create_passes_through():
    body: dict[str, object] = {
        "traceId": "trace-001",
        "name": "quality",
        "value": 0.95,
        "source": "ANNOTATION",
    }
    result = langfuse_event_to_internal("score-create", body)
    assert result is not None
    assert result["type"] == "score-create"
    ib = result["body"]
    assert isinstance(ib, dict)
    assert ib["traceId"] == "trace-001"


def test_unknown_event_returns_none():
    result = langfuse_event_to_internal("unknown-event", {"id": "test"})
    assert result is None


def test_all_observation_types_mapped():
    observation_events = [
        "span-create",
        "generation-create",
        "event-create",
        "tool-create",
        "chain-create",
        "retriever-create",
        "agent-create",
        "evaluator-create",
        "embedding-create",
        "guardrail-create",
    ]
    expected_types = [
        "SPAN",
        "GENERATION",
        "EVENT",
        "TOOL",
        "CHAIN",
        "RETRIEVER",
        "AGENT",
        "EVALUATOR",
        "EMBEDDING",
        "GUARDRAIL",
    ]
    for event, expected in zip(observation_events, expected_types):
        body: dict[str, object] = {
            "id": f"obs-{event}",
            "traceId": "trace-001",
        }
        result = langfuse_event_to_internal(event, body)
        assert result is not None, f"Failed for {event}"
        assert result["type"] == "call-create"
        ib = result["body"]
        assert isinstance(ib, dict)
        assert ib["observation_type"] == expected


def test_trace_create_missing_id_raises():
    with pytest.raises(ValueError, match="Missing or invalid 'id'"):
        langfuse_event_to_internal("trace-create", {})


def test_usage_with_input_output_keys():
    body: dict[str, object] = {
        "id": "obs-002",
        "traceId": "trace-001",
        "usage": {"input": 5, "output": 10},
    }
    result = langfuse_event_to_internal("generation-create", body)
    assert result is not None
    ib = result["body"]
    assert isinstance(ib, dict)
    assert ib["prompt_tokens"] == 5
    assert ib["completion_tokens"] == 10
