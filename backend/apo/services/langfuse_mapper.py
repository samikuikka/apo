"""
Maps Langfuse SDK event types to our internal data model.

Handles conversion between Langfuse's batch ingestion format
(TRACE_CREATE, SPAN_CREATE, GENERATION_CREATE, etc.) and our
run-create, call-create, call-update event types.
"""

from datetime import datetime, timezone
from typing import Literal, cast

from ..ingestion_helpers import (
    _get_json_map,
    _get_optional_int,
    _get_optional_json_map,
    _get_optional_str,
    _get_str,
    _get_string_list,
)
from ..models.db import CallMetricDB, LoggedCallDB, RunDB, RunMetricDB
from .ingestion import require_str

LANGFUSE_EVENT_TYPE = Literal[
    "trace-create",
    "trace-update",
    "span-create",
    "span-update",
    "generation-create",
    "generation-update",
    "event-create",
    "event-update",
    "tool-create",
    "tool-update",
    "chain-create",
    "chain-update",
    "retriever-create",
    "retriever-update",
    "agent-create",
    "agent-update",
    "evaluator-create",
    "evaluator-update",
    "embedding-create",
    "embedding-update",
    "guardrail-create",
    "guardrail-update",
    "score-create",
]

OBSERVATION_TYPE_MAP: dict[str, str] = {
    "span-create": "SPAN",
    "span-update": "SPAN",
    "generation-create": "GENERATION",
    "generation-update": "GENERATION",
    "event-create": "EVENT",
    "event-update": "EVENT",
    "tool-create": "TOOL",
    "tool-update": "TOOL",
    "chain-create": "CHAIN",
    "chain-update": "CHAIN",
    "retriever-create": "RETRIEVER",
    "retriever-update": "RETRIEVER",
    "agent-create": "AGENT",
    "agent-update": "AGENT",
    "evaluator-create": "EVALUATOR",
    "evaluator-update": "EVALUATOR",
    "embedding-create": "EMBEDDING",
    "embedding-update": "EMBEDDING",
    "guardrail-create": "GUARDRAIL",
    "guardrail-update": "GUARDRAIL",
}


def langfuse_event_to_internal(
    event_type: str, body: dict[str, object]
) -> dict[str, object] | None:
    """Convert a Langfuse SDK event to our internal event format.

    Returns a dict with 'type' (run-create, call-create, call-update, score-create)
    and 'body' (our internal format), or None for unknown event types.
    """
    if event_type == "trace-create":
        return _map_trace_create(body)
    if event_type == "trace-update":
        return _map_trace_update(body)
    if event_type == "score-create":
        return {"type": "score-create", "body": body}
    if event_type in OBSERVATION_TYPE_MAP:
        if event_type.endswith("-create"):
            return _map_observation_create(event_type, body)
        if event_type.endswith("-update"):
            return _map_observation_update(event_type, body)
    return None


def _map_trace_create(body: dict[str, object]) -> dict[str, object]:
    """Map Langfuse trace-create to our run-create."""
    return {
        "type": "run-create",
        "body": {
            "id": require_str(body.get("id"), "id"),
            "project": _get_str(body, "project", "default"),
            "flow_name": _get_optional_str(body, "name"),
            "user_id": _get_optional_str(body, "userId"),
            "session_id": _get_optional_str(body, "sessionId"),
            "environment": _get_str(body, "environment", "default"),
            "tags": _get_string_list(body, "tags"),
            "run_metadata": _get_optional_json_map(body, "metadata"),
        },
    }


def _map_trace_update(body: dict[str, object]) -> dict[str, object]:
    """Map Langfuse trace-update to a run-create (merge/upsert)."""
    return {
        "type": "run-create",
        "body": {
            "id": require_str(body.get("id"), "id"),
            "project": _get_str(body, "project", "default"),
            "flow_name": _get_optional_str(body, "name"),
            "user_id": _get_optional_str(body, "userId"),
            "session_id": _get_optional_str(body, "sessionId"),
            "environment": _get_str(body, "environment", "default"),
            "tags": _get_string_list(body, "tags"),
            "run_metadata": _get_optional_json_map(body, "metadata"),
        },
    }


def _map_observation_create(
    event_type: str, body: dict[str, object]
) -> dict[str, object]:
    """Map Langfuse observation-create events to our call-create."""
    observation_type = OBSERVATION_TYPE_MAP.get(event_type, "GENERATION")
    usage = _get_optional_json_map(body, "usage")
    prompt_tokens = _extract_token_count(usage, "promptTokens", "input")
    completion_tokens = _extract_token_count(usage, "completionTokens", "output")
    total_tokens: int | None = None
    if prompt_tokens is not None and completion_tokens is not None:
        total_tokens = prompt_tokens + completion_tokens

    return {
        "type": "call-create",
        "body": {
            "id": require_str(body.get("id"), "id"),
            "project": _get_str(body, "project", "default"),
            "task_id": "",
            "run_id": _get_optional_str(body, "traceId"),
            "flow_name": None,
            "step_name": _get_optional_str(body, "name"),
            "model": _get_str(body, "model", "unknown"),
            "created_at": _get_optional_str(body, "startTime")
            or datetime.now(timezone.utc).isoformat(),
            "parent_call_id": _get_optional_str(body, "parentObservationId"),
            "observation_type": observation_type,
            "level": _get_str(body, "level", "DEFAULT"),
            "status_message": _get_optional_str(body, "statusMessage"),
            "completion_start_time": _get_optional_str(body, "completionStartTime"),
            "end_time": _get_optional_str(body, "endTime"),
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
            "session_id": _get_optional_str(body, "sessionId"),
            "environment": _get_str(body, "environment", "default"),
            "tags": _get_string_list(body, "tags"),
            "prompt_id": _get_optional_str(body, "promptId"),
            "prompt_version": _get_optional_int(body, "promptVersion"),
            "input": _get_json_map(body, "input"),
            "output": _get_json_map(body, "output"),
            "metadata": _get_optional_json_map(body, "metadata"),
        },
    }


def _map_observation_update(
    event_type: str, body: dict[str, object]
) -> dict[str, object]:
    """Map Langfuse observation-update events to our call-update."""
    _ = event_type
    usage = _get_optional_json_map(body, "usage")
    prompt_tokens = _extract_token_count(usage, "promptTokens", "input")
    completion_tokens = _extract_token_count(usage, "completionTokens", "output")

    result: dict[str, object] = {
        "type": "call-update",
        "body": {
            "id": require_str(body.get("id"), "id"),
        },
    }
    update_body = cast(dict[str, object], result["body"])

    if _get_optional_str(body, "name") is not None:
        update_body["step_name"] = _get_optional_str(body, "name")
    if _get_optional_str(body, "endTime") is not None:
        update_body["end_time"] = _get_optional_str(body, "endTime")
    if _get_optional_str(body, "statusMessage") is not None:
        update_body["status_message"] = _get_optional_str(body, "statusMessage")
    if _get_optional_str(body, "level") is not None:
        update_body["level"] = _get_optional_str(body, "level")
    if prompt_tokens is not None:
        update_body["prompt_tokens"] = prompt_tokens
    if completion_tokens is not None:
        update_body["completion_tokens"] = completion_tokens
    if _get_optional_str(body, "completionStartTime") is not None:
        update_body["completion_start_time"] = _get_optional_str(
            body, "completionStartTime"
        )
    if _get_optional_str(body, "model") is not None:
        update_body["model"] = _get_optional_str(body, "model")
    if "output" in body:
        update_body["output"] = _get_json_map(body, "output")
    if "input" in body:
        update_body["input"] = _get_json_map(body, "input")
    if "metadata" in body:
        update_body["meta"] = _get_optional_json_map(body, "metadata")

    return result


def run_to_langfuse_trace(run: RunDB) -> dict[str, object]:
    """Convert our RunDB to Langfuse trace format."""
    return {
        "id": run.id,
        "name": run.flow_name,
        "userId": run.user_id,
        "sessionId": run.session_id,
        "environment": run.environment,
        "tags": run.tags,
        "metadata": run.run_metadata,
        "createdAt": run.created_at.isoformat() if run.created_at else None,
        "updatedAt": (run.completed_at.isoformat() if run.completed_at else None),
    }


def call_to_langfuse_observation(call: LoggedCallDB) -> dict[str, object]:
    """Convert our LoggedCallDB to Langfuse observation format."""
    usage: dict[str, int] = {}
    if call.prompt_tokens is not None or call.completion_tokens is not None:
        usage["promptTokens"] = call.prompt_tokens or 0
        usage["completionTokens"] = call.completion_tokens or 0
        usage["totalTokens"] = (call.prompt_tokens or 0) + (call.completion_tokens or 0)

    return {
        "id": call.id,
        "traceId": call.run_id,
        "parentObservationId": call.parent_call_id,
        "type": call.observation_type.lower()
        if call.observation_type in ("SPAN", "GENERATION", "EVENT")
        else call.observation_type.lower(),
        "name": call.step_name,
        "startTime": call.created_at.isoformat() if call.created_at else None,
        "endTime": call.end_time.isoformat() if call.end_time else None,
        "completionStartTime": (
            call.completion_start_time.isoformat()
            if call.completion_start_time
            else None
        ),
        "model": call.model,
        "input": call.input,
        "output": call.output,
        "metadata": call.meta,
        "level": call.level,
        "statusMessage": call.status_message,
        "version": call.version,
        "usage": usage if usage else None,
        "promptId": call.prompt_id,
        "promptVersion": call.prompt_version,
    }


def metric_to_langfuse_score(metric: RunMetricDB) -> dict[str, object]:
    """Convert our RunMetricDB to Langfuse score format."""
    return {
        "id": metric.id,
        "traceId": metric.run_id,
        "name": metric.metric_name,
        "value": metric.score,
        "dataType": metric.data_type,
        "source": metric.source,
        "comment": metric.reasoning,
        "createdAt": (metric.created_at.isoformat() if metric.created_at else None),
    }


def call_metric_to_langfuse_score(metric: CallMetricDB) -> dict[str, object]:
    """Convert our CallMetricDB to Langfuse score format."""
    return {
        "id": metric.id,
        "observationId": metric.call_id,
        "name": metric.metric_name,
        "value": metric.score,
        "dataType": metric.data_type,
        "source": metric.source,
        "comment": metric.reasoning,
        "createdAt": (metric.created_at.isoformat() if metric.created_at else None),
    }


def _extract_token_count(
    usage: dict[str, object] | None,
    camel_key: str,
    fallback_key: str,
) -> int | None:
    """Extract token count from Langfuse usage dict."""
    if usage is None:
        return None
    value = usage.get(camel_key)
    if value is None:
        value = usage.get(fallback_key)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return None
