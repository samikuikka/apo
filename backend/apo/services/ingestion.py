"""
Shared ingestion processing service.

Contains the core processing logic for creating/updating runs, calls,
and scores. Used by all ingestion routes (batch, OTel).

``process_call_create`` / ``process_call_update`` are the LEGACY direct
writers: no route funnels through them anymore (routes use
``legacy_adapter``, which persists canonical spans first). They write
span-less ``LoggedCallDB`` rows, which in slim projection mode serve
their stored I/O via the read-path fallback. The Stage-2c column-drop
gate measures whether any fallback usage remains before the fat columns
can go.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnnecessaryComparison=false, reportUnusedCallResult=false, reportUnusedParameter=false

import logging
from datetime import datetime, timezone
from typing import cast

from sqlmodel import Session, select

from ..db_helpers import ensure_utc_datetime
from ..ingestion_helpers import (
    _get_json_map,
    _get_optional_float,
    _get_optional_int,
    _get_optional_json_map,
    _get_optional_str,
    _get_str,
    _get_string_list,
)
from ..models.db import LoggedCallDB, RunDB
from ..models.schemas import MessageList
from ..services.pricing.apply import apply_cost_to_call
from ..services.scoring import (
    create_observation_score,
    create_trace_score,
)
from ..services.trace_broadcaster import get_trace_broadcaster

logger = logging.getLogger(__name__)


def parse_optional_iso(dt: object) -> datetime | None:
    """Parse optional ISO datetime string to datetime object."""
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return ensure_utc_datetime(dt)
    if isinstance(dt, str):
        return ensure_utc_datetime(datetime.fromisoformat(dt.replace("Z", "+00:00")))
    return None


def require_str(value: object, field_name: str) -> str:
    """Require a non-empty string value, raising ValueError if missing."""
    if isinstance(value, str) and value:
        return value
    raise ValueError(f"Missing or invalid '{field_name}'")


def _get_message_list(body: dict[str, object], key: str) -> MessageList:
    value = body.get(key)
    if not isinstance(value, list):
        return []

    messages: MessageList = []
    for item in cast(list[object], value):
        if isinstance(item, dict):
            messages.append(dict(cast(dict[str, object], item)))
    return messages


def _ingestion_usage_attributes(body: dict[str, object]) -> dict[str, object]:
    """Build an OTel-style attribute map from a legacy ingestion body.

    The legacy direct-writer carries flat ``prompt_tokens``/``completion_tokens``
    (and optionally richer usage under ``usage`` / ``raw_usage``). Map these onto
    the canonical OTel gen_ai.usage.* keys the normalizer reads. If the body
    already carries a ``usage``/``raw_usage`` map (current SDK), forward
    canonical keys under their OTel attribute names so the normalizer picks
    them up.
    """
    attrs: dict[str, object] = {}
    prompt = _get_optional_int(body, "prompt_tokens")
    completion = _get_optional_int(body, "completion_tokens")
    if prompt is not None:
        attrs["gen_ai.usage.input_tokens"] = prompt
    if completion is not None:
        attrs["gen_ai.usage.output_tokens"] = completion

    # Forward any richer usage the SDK carried. Canonical usage keys map to the
    # OTel attribute names the normalizer reads; unknown keys pass through.
    canonical_to_attr = {
        "input": "gen_ai.usage.input_tokens",
        "output": "gen_ai.usage.output_tokens",
        "cache_read": "gen_ai.usage.cache_read.input_tokens",
        "reasoning": "gen_ai.usage.reasoning.output_tokens",
        "cache_write_5m": "gen_ai.usage.cache_creation.ephemeral_5m_input_tokens",
        "cache_write_1h": "gen_ai.usage.cache_creation.ephemeral_1h_input_tokens",
    }
    for key in ("usage", "raw_usage"):
        extra = body.get(key)
        if isinstance(extra, dict):
            for k, v in cast(dict[str, object], extra).items():
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    attr_key = canonical_to_attr.get(str(k), str(k))
                    _ = attrs.setdefault(attr_key, int(v))
    return attrs


def _apply_ingestion_cost(
    session: Session,
    call: LoggedCallDB,
    body: dict[str, object],
    at_time: datetime,
    *,
    is_update: bool = False,
) -> None:
    """Normalize usage + freeze cost on a legacy-ingested call.

    Shared seam with the canonical projector: build an attribute map from the
    legacy body, then provided-wins-verbatim-else-compute. The body's
    ``cost``/``provided_cost`` (micro-USD int) are already on ``call``.
    ``is_update`` is forwarded to ``apply_cost_to_call`` so a partial patch (no
    usage) doesn't erase a previously-frozen cost.
    """
    attrs = _ingestion_usage_attributes(body)
    provider = _get_optional_str(body, "provider")
    apply_cost_to_call(
        session,
        call,
        attributes=attrs,
        provider=provider,
        project=call.project,
        at_time=at_time,
        is_update=is_update,
    )


_SERVING_STR_FIELDS = (
    "instrumentation_provider",
    "serving_host",
    "requested_service_tier",
    "service_tier",
    "request_model",
    "response_model",
)


def _apply_legacy_serving(call: LoggedCallDB, body: dict[str, object]) -> None:
    """Populate observed serving identity from an optional ``serving`` body
    object, the legacy-ingestion equivalent of the canonical span attributes.

    Every field passes the same validation as span extraction: malformed
    values become null instead of failing ingestion.
    """
    from .otel_normalization._serving import (
        _clean_identity,
        _clean_provider,
        _extract_offset_ms,
        _extract_scope,
    )
    from ..models.serving import IDENTITY_MAX_BYTES, MODEL_ID_MAX_BYTES

    raw = body.get("serving")
    if not isinstance(raw, dict):
        return
    diagnostics: list[str] = []

    def _field(name: str, max_bytes: int = IDENTITY_MAX_BYTES) -> str | None:
        value = raw.get(name)
        return _clean_identity(
            value if isinstance(value, str) else None,
            max_bytes,
            name,
            diagnostics,
        )

    for name in _SERVING_STR_FIELDS:
        max_bytes = (
            MODEL_ID_MAX_BYTES
            if name in ("request_model", "response_model")
            else IDENTITY_MAX_BYTES
        )
        setattr(call, name, _field(name, max_bytes))
    api_provider_raw = raw.get("api_provider")
    call.api_provider = _clean_provider(
        api_provider_raw if isinstance(api_provider_raw, str) else None,
        diagnostics,
    )
    call.observed_model = call.response_model or (call.model or None)

    route_raw = raw.get("route")
    call.route = _clean_identity(
        route_raw if isinstance(route_raw, str) else None,
        IDENTITY_MAX_BYTES,
        "route",
        diagnostics,
    )

    request_kind = raw.get("request_kind")
    cleaned_kind = (
        request_kind.strip().lower()
        if isinstance(request_kind, str) and request_kind.strip().lower() in ("request", "aggregate")
        else None
    )
    call.request_accounting = cleaned_kind

    scope_attrs = {
        "apo.llm.output_token_scope": raw.get("output_token_scope")
        if isinstance(raw.get("output_token_scope"), str)
        else None,
        "apo.llm.first_content_scope": raw.get("first_content_scope")
        if isinstance(raw.get("first_content_scope"), str)
        else None,
    }
    call.output_token_scope = _extract_scope(scope_attrs, "apo.llm.output_token_scope", diagnostics)
    call.first_content_scope = _extract_scope(scope_attrs, "apo.llm.first_content_scope", diagnostics)

    offset = _extract_offset_ms(
        {"apo.llm.first_content_offset_ms": raw.get("first_content_offset_ms")},
        diagnostics,
    )
    if offset is not None:
        call.time_to_first_token_ms = offset

    if diagnostics:
        logger.warning("Legacy serving payload diagnostics: %s", diagnostics)



async def process_call_create(body: dict[str, object], session: Session) -> None:
    """Process a call-create event."""
    call_id = body.get("id")
    if not call_id:
        raise ValueError("call-create event missing 'id'")

    created_at = parse_optional_iso(body.get("created_at")) or datetime.now(
        timezone.utc
    )
    completion_start_time = parse_optional_iso(body.get("completion_start_time"))
    end_time = parse_optional_iso(body.get("end_time"))

    prompt_tokens = _get_optional_int(body, "prompt_tokens")
    completion_tokens = _get_optional_int(body, "completion_tokens")
    total_tokens = None
    if prompt_tokens is not None and completion_tokens is not None:
        total_tokens = prompt_tokens + completion_tokens

    time_to_first_token_ms = None
    if completion_start_time and created_at:
        delta = ensure_utc_datetime(completion_start_time) - ensure_utc_datetime(
            created_at
        )
        time_to_first_token_ms = delta.total_seconds() * 1000

    model_name = _get_str(body, "model", "unknown")
    raw_latency_ms = _get_optional_float(body, "latency_ms")

    # SDK clients (and especially the
    # agent-task SDK) historically sent ``latency_ms: 0`` for any span
    # that completed within the same millisecond tick. The SDK uses
    # ``Date.now()`` (ms resolution) so sub-ms operations round to 0.
    # When the client also sent ``end_time`` and we have ``created_at``,
    # derive the latency from the timestamps instead — they're captured
    # independently of the latency calculation and are not subject to
    # the same rounding. Falls back to the raw value (which may be 0 or
    # None) when timestamps are unavailable.
    latency_ms = raw_latency_ms
    if raw_latency_ms is None and end_time is not None:
        latency_ms = (
            ensure_utc_datetime(end_time) - ensure_utc_datetime(created_at)
        ).total_seconds() * 1000

    call = LoggedCallDB(
        id=require_str(call_id, "id"),
        project=_get_str(body, "project", "default"),
        task_id=_get_str(body, "task_id", ""),
        run_id=_get_optional_str(body, "run_id"),
        flow_name=_get_optional_str(body, "flow_name"),
        step_name=_get_optional_str(body, "step_name"),
        step_index=_get_optional_int(body, "step_index"),
        version=_get_optional_str(body, "version"),
        created_at=created_at,
        model=model_name,
        latency_ms=latency_ms,
        cost=_get_optional_int(body, "cost"),
        parent_call_id=_get_optional_str(body, "parent_call_id"),
        observation_type=_get_str(body, "observation_type", "GENERATION"),
        level=_get_str(body, "level", "DEFAULT"),
        status_message=_get_optional_str(body, "status_message"),
        completion_start_time=completion_start_time,
        end_time=end_time,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        session_id=_get_optional_str(body, "session_id"),
        environment=_get_str(body, "environment", "default"),
        tags=_get_string_list(body, "tags"),
        total_tokens=total_tokens,
        prompt_id=_get_optional_str(body, "prompt_id"),
        prompt_version=_get_optional_int(body, "prompt_version"),
        provided_cost=_get_optional_int(body, "provided_cost"),
        time_to_first_token_ms=time_to_first_token_ms,
        provided_model_name=_get_optional_str(body, "provided_model_name"),
        tool_name=_get_optional_str(body, "tool_name"),
        tool_parameters=_get_optional_json_map(body, "tool_parameters"),
        tool_result=_get_optional_json_map(body, "tool_result"),
        input=_get_json_map(body, "input"),
        messages=_get_message_list(body, "messages"),
        output=_get_json_map(body, "output"),
        user_id=_get_optional_str(body, "user_id"),
        meta=_get_optional_json_map(body, "metadata"),
    )

    # Observed serving identity, when the legacy body carries the optional
    # ``serving`` object (equivalent evidence to the canonical attributes).
    _apply_legacy_serving(call, body)

    # normalize usage + freeze cost (shared seam with the
    # canonical projector). Provided cost wins verbatim; else compute.
    if call.observation_type == "GENERATION" and model_name and model_name != "unknown":
        _apply_ingestion_cost(session, call, body, created_at)

    _ = session.merge(call)
    session.commit()

    run_id = _get_optional_str(body, "run_id")
    if run_id:
        try:
            broadcaster = await get_trace_broadcaster()
            await broadcaster.broadcast_span_created(call.project, run_id, body)
        except Exception:
            # The span is already committed; this broadcast only feeds live
            # SSE subscribers, so a failure (e.g. a vanished client) must
            # not fail the ingestion request.
            logger.debug(
                "span:created broadcast for run %s failed (best-effort)",
                run_id,
                exc_info=True,
            )


async def process_call_update(body: dict[str, object], session: Session) -> None:
    """Process a call-update event (e.g., add output after LLM completes)."""
    call_id = body.get("id")
    if not call_id:
        raise ValueError("call-update event missing 'id'")

    project = _get_optional_str(body, "project") or "default"
    call = session.exec(
        select(LoggedCallDB).where(
            LoggedCallDB.id == call_id, LoggedCallDB.project == project
        )
    ).first()
    if not call:
        raise ValueError(f"LoggedCall not found: {call_id}")

    if "output" in body:
        call.output = _get_json_map(body, "output")
    if "latency_ms" in body:
        call.latency_ms = _get_optional_float(body, "latency_ms")
    if "end_time" in body:
        call.end_time = parse_optional_iso(body["end_time"])
    # after applying the SDK-supplied
    # ``latency_ms`` and ``end_time`` above, re-derive latency from
    # timestamps when the SDK omitted it. This catches both:
    #   - SDK sent ``latency_ms: null`` with ``end_time``
    #   - SDK sent only ``end_time`` (no ``latency_ms`` key at all)
    # The common case is the agent-task SDK finalising a span with
    # ``call-update`` that carries ``end_time`` but no explicit latency.
    if call.latency_ms is None and call.end_time is not None and call.created_at is not None:
        call.latency_ms = (
            ensure_utc_datetime(call.end_time)
            - ensure_utc_datetime(call.created_at)
        ).total_seconds() * 1000
    if "prompt_tokens" in body:
        call.prompt_tokens = _get_optional_int(body, "prompt_tokens")
    if "completion_tokens" in body:
        call.completion_tokens = _get_optional_int(body, "completion_tokens")
    if "cost" in body:
        call.cost = _get_optional_int(body, "cost")
    if "status_message" in body:
        call.status_message = _get_optional_str(body, "status_message")
    if "level" in body:
        call.level = _get_str(body, "level", call.level)
    if "meta" in body:
        call.meta = _get_optional_json_map(body, "meta")

    if "completion_start_time" in body:
        call.completion_start_time = parse_optional_iso(body["completion_start_time"])
    if "total_tokens" in body:
        call.total_tokens = _get_optional_int(body, "total_tokens")
    elif "prompt_tokens" in body or "completion_tokens" in body:
        if call.prompt_tokens is not None and call.completion_tokens is not None:
            call.total_tokens = call.prompt_tokens + call.completion_tokens
    if "prompt_id" in body:
        call.prompt_id = _get_optional_str(body, "prompt_id")
    if "prompt_version" in body:
        call.prompt_version = _get_optional_int(body, "prompt_version")
    if "provided_cost" in body:
        call.provided_cost = _get_optional_int(body, "provided_cost")
    if "time_to_first_token_ms" in body:
        call.time_to_first_token_ms = _get_optional_float(
            body, "time_to_first_token_ms"
        )
    elif "completion_start_time" in body and call.created_at:
        if call.completion_start_time:
            delta = ensure_utc_datetime(
                call.completion_start_time
            ) - ensure_utc_datetime(call.created_at)
            call.time_to_first_token_ms = delta.total_seconds() * 1000
    if "provided_model_name" in body:
        call.provided_model_name = _get_optional_str(body, "provided_model_name")
    if "tool_name" in body:
        call.tool_name = _get_optional_str(body, "tool_name")
    if "tool_parameters" in body:
        call.tool_parameters = _get_optional_json_map(body, "tool_parameters")
    if "tool_result" in body:
        call.tool_result = _get_optional_json_map(body, "tool_result")
    if "session_id" in body:
        call.session_id = _get_optional_str(body, "session_id")
    if "environment" in body:
        call.environment = _get_str(body, "environment", call.environment)
    if "tags" in body:
        call.tags = _get_string_list(body, "tags")

    # A serving patch refreshes identity the same way the create path does;
    # absence of the object leaves stored identity untouched (sparse patch).
    if "serving" in body:
        _apply_legacy_serving(call, body)

    # re-normalize usage + re-freeze cost on update when
    # the call is a priced GENERATION. Provided cost still wins verbatim. A
    # partial patch (no usage) must not erase a previously-frozen cost, so the
    # update path only recomputes when the patch actually carries usage.
    if call.observation_type == "GENERATION" and call.model and call.model != "unknown":
        _apply_ingestion_cost(
            session, call, body, call.created_at or datetime.now(timezone.utc), is_update=True
        )

    session.commit()

    if call.run_id:
        try:
            broadcaster = await get_trace_broadcaster()
            await broadcaster.broadcast_span_updated(
                call.project, call.run_id, {"id": call_id, **body}
            )
        except Exception:
            # The update is already committed; this broadcast only feeds
            # live SSE subscribers, so a failure (e.g. a vanished client)
            # must not fail the ingestion request.
            logger.debug(
                "span:updated broadcast for run %s failed (best-effort)",
                call.run_id,
                exc_info=True,
            )


async def process_score_create(
    body: dict[str, object], session: Session, project: str
) -> None:
    """Process a score-create event (internal snake_case format).

    ``project`` is the route-authorized Project. The target trace/observation
    must exist inside it, so a caller cannot attach scores to another
    Project's ids.
    """
    trace_id = _get_optional_str(body, "trace_id")
    observation_id = _get_optional_str(body, "observation_id")
    name = _get_optional_str(body, "name")

    if not name:
        raise ValueError("score-create event missing 'name'")

    if observation_id:
        call = session.exec(
            select(LoggedCallDB).where(
                LoggedCallDB.id == observation_id,
                LoggedCallDB.project == project,
            )
        ).first()
        if call is None:
            raise ValueError(f"Observation not found: {observation_id}")
    elif trace_id:
        run = session.exec(
            select(RunDB).where(RunDB.id == trace_id, RunDB.project == project)
        ).first()
        if run is None:
            raise ValueError(f"Trace not found: {trace_id}")
    else:
        raise ValueError("score-create event requires trace_id or observation_id")

    value_raw = body.get("value")
    if value_raw is None:
        raise ValueError("score-create event missing 'value'")

    if isinstance(value_raw, (int, float)):
        value: float | str | bool = float(value_raw)
    elif isinstance(value_raw, bool):
        value = value_raw
    elif isinstance(value_raw, str):
        value = value_raw
    else:
        value = float(str(value_raw))

    data_type = _get_str(body, "data_type", "NUMERIC")
    source = _get_str(body, "source", "API")
    config_id = _get_optional_int(body, "config_id")
    comment = _get_optional_str(body, "comment")

    if observation_id:
        _ = create_observation_score(
            session=session,
            observation_id=observation_id,
            name=name,
            value=value,
            project=project,
            data_type=data_type,
            source=source,
            config_id=config_id,
            comment=comment,
        )
    else:
        assert trace_id is not None  # narrowed by the elif above
        _ = create_trace_score(
            session=session,
            trace_id=trace_id,
            name=name,
            value=value,
            project=project,
            data_type=data_type,
            source=source,
            config_id=config_id,
            comment=comment,
        )
