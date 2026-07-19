# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""Content capture/redaction policy for OTLP ingestion (SPEC-129 §1, §2).

Applies a per-project content policy BEFORE persisting to the durable inbox
and canonical span store. Three modes:

  - ``full``: keep all content (prompt, completion, tool args/results).
  - ``redacted``: preserve message structure (role, type) but replace content
    text with a deterministic hash placeholder so sensitive data never reaches
    durable storage.
  - ``off``: drop all content-bearing attributes entirely. Only metadata
    (model, tokens, latency, span name, observation type) survives.

The Project-owned default is ``full`` — content is visible so traces are
useful on first contact. Switch to ``redacted`` for production deployments
that handle sensitive data. Policy is applied to resource, scope, span, event,
and link attributes before the sanitized payload is written to
``OtlpIngestBatchDB`` or extracted into ``OtlpSpanDB``.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Literal

logger = logging.getLogger(__name__)

type TraceContentPolicy = Literal["off", "redacted", "full"]

DEFAULT_TRACE_CONTENT_POLICY: TraceContentPolicy = "full"

# Attributes that carry prompt/completion/tool content (not metadata).
# These are the keys the normalizer routes into input/output/tool_parameters/tool_result.
_CONTENT_KEYS = frozenset({
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "gen_ai.system_instructions",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
    "gen_ai.tool.definitions",
    "input",
    "output",
    "tool_parameters",
    "tool_result",
    "input.messages",
    "output.messages",
    "input.value",
    "output.value",
    "llm.input_messages",
    "llm.output_messages",
    "exception.message",
    "exception.stacktrace",
    "db.statement",
    "http.request.body",
    "http.response.body",
})

_CONTENT_KEY_SUFFIXES = (
    ".prompt",
    ".prompts",
    ".completion",
    ".completions",
    ".messages",
    ".message",
    ".content",
    ".arguments",
    ".parameters",
    ".result",
    ".results",
    ".request.body",
    ".response.body",
)

# Keys that are metadata (model, tokens, timing, type) — always kept.
# Everything NOT in _CONTENT_KEYS is treated as metadata by default.


def apply_content_policy(
    attributes: dict[str, Any],
    policy: str,
) -> dict[str, Any]:
    """Apply a content capture/redaction policy to span attributes.

    Args:
        attributes: the flat attributes dict extracted from an OTLP span.
        policy: one of ``"full"``, ``"redacted"``, ``"off"``.

    Returns:
        A new attributes dict with the policy applied. The input is not mutated.
    """
    normalized = normalize_trace_content_policy(policy)
    if normalized == "full":
        return dict(attributes)

    if normalized == "off":
        return _strip_content(attributes)

    return _redact_content(attributes)


def normalize_trace_content_policy(policy: object) -> TraceContentPolicy:
    """Return a valid policy, failing closed to redacted for corrupt settings.

    The project default (``full``) is applied by the caller via
    ``DEFAULT_TRACE_CONTENT_POLICY``. This function only kicks in for
    normalization — a missing value gets the default; a *corrupt* value
    (not one of the three valid modes) fails safe to ``redacted`` so
    sensitive data never leaks due to a misconfiguration.
    """
    if policy == "off":
        return "off"
    if policy == "redacted":
        return "redacted"
    if policy == "full":
        return "full"
    if policy is None:
        return DEFAULT_TRACE_CONTENT_POLICY
    logger.warning("Unknown trace content policy %r; using redacted", policy)
    return "redacted"


def is_content_attribute(key: str) -> bool:
    """Whether an OTel attribute is known to carry user or model content."""
    normalized = key.lower()
    return normalized in _CONTENT_KEYS or normalized.endswith(_CONTENT_KEY_SUFFIXES)


def sanitize_otlp_payload(
    decoded: dict[str, Any], policy: str
) -> dict[str, Any]:
    """Sanitize every OTLP attribute-bearing location in a decoded payload.

    The object is the request-local decoded payload, so mutation is deliberate:
    all later persistence and normalization consume the same sanitized graph.
    """
    normalized = normalize_trace_content_policy(policy)
    if normalized == "full":
        return decoded

    for resource_spans in decoded.get("resourceSpans", []):
        resource = resource_spans.get("resource", {})
        _sanitize_attribute_owner(resource, normalized)
        for scope_spans in resource_spans.get("scopeSpans", []):
            _sanitize_attribute_owner(scope_spans.get("scope", {}), normalized)
            for span in scope_spans.get("spans", []):
                _sanitize_attribute_owner(span, normalized)
                for event in span.get("events", []):
                    _sanitize_attribute_owner(event, normalized)
                for link in span.get("links", []):
                    _sanitize_attribute_owner(link, normalized)
    return decoded


def _sanitize_attribute_owner(owner: Any, policy: TraceContentPolicy) -> None:
    if not isinstance(owner, dict):
        return
    attributes = owner.get("attributes")
    if not isinstance(attributes, list):
        return

    sanitized: list[Any] = []
    for attribute in attributes:
        if not isinstance(attribute, dict):
            sanitized.append(attribute)
            continue
        key = attribute.get("key")
        if not isinstance(key, str) or not is_content_attribute(key):
            sanitized.append(attribute)
            continue
        if policy == "off":
            continue
        value = attribute.get("value")
        if isinstance(value, dict):
            _redact_otlp_any_value(value)
        sanitized.append(attribute)
    owner["attributes"] = sanitized


def _redact_otlp_any_value(value: dict[str, Any]) -> None:
    string_value = value.get("stringValue")
    if isinstance(string_value, str):
        value["stringValue"] = _redact_string(string_value)
        return

    if "bytesValue" in value:
        raw_bytes = str(value["bytesValue"])
        value.clear()
        value["stringValue"] = _hash_placeholder(raw_bytes)
        return

    array_value = value.get("arrayValue")
    if isinstance(array_value, dict):
        for item in array_value.get("values", []):
            if isinstance(item, dict):
                _redact_otlp_any_value(item)

    kvlist_value = value.get("kvlistValue")
    if isinstance(kvlist_value, dict):
        for item in kvlist_value.get("values", []):
            if not isinstance(item, dict):
                continue
            nested = item.get("value")
            if isinstance(nested, dict):
                _redact_otlp_any_value(nested)


def _strip_content(attributes: dict[str, Any]) -> dict[str, Any]:
    """Drop all content-bearing attributes, keep metadata only."""
    return {k: v for k, v in attributes.items() if not is_content_attribute(k)}


def _redact_content(attributes: dict[str, Any]) -> dict[str, Any]:
    """Replace content text with hash placeholders while preserving structure.

    For each content attribute:
      - If the value is a JSON string, parse it, walk the structure, and replace
        every ``content`` field with ``[redacted:<hash>]``.
      - If the value is not JSON, replace it entirely with ``[redacted:<hash>]``.
    """
    result = {}
    for key, value in attributes.items():
        if not is_content_attribute(key):
            result[key] = value
            continue

        if isinstance(value, str):
            result[key] = _redact_string(value)
        elif isinstance(value, dict):
            result[key] = _redact_obj(value)
        elif isinstance(value, list):
            result[key] = _redact_obj(value)
        else:
            result[key] = _hash_placeholder(str(value))
    return result


def _redact_string(value: str) -> str:
    try:
        return json.dumps(_redact_obj(json.loads(value)))
    except (json.JSONDecodeError, ValueError):
        return _hash_placeholder(value)


def _redact_obj(obj: Any) -> Any:
    """Recursively redact all string values in a parsed JSON structure.

    Redacts EVERY string value at every depth — not just keys named
    ``content`` or ``arguments``. This ensures PII in any field (query,
    text, headers, url, etc.) is masked. Non-string values (ints, bools,
    role names like "user"/"assistant") pass through unchanged.
    """
    if isinstance(obj, dict):
        result = {}
        for k, v in obj.items():
            if isinstance(v, str) and v:
                # Redact all non-empty strings — this catches content, text,
                # arguments, query, headers, urls, anything sensitive
                result[k] = _hash_placeholder(v)
            else:
                result[k] = _redact_obj(v)
        return result
    if isinstance(obj, list):
        return [_redact_obj(item) for item in obj]
    return obj


def _hash_placeholder(value: str) -> str:
    """Generate a deterministic hash placeholder for redacted content."""
    h = hashlib.sha256(value.encode()).hexdigest()[:12]
    return f"[redacted:{h}]"
