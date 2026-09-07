# pyright: reportAny=false, reportUnusedCallResult=false

"""Langfuse compatibility is removed: guards against reintroduction.

apo's only supported trace-ingestion path is direct OTLP. The Langfuse
source connector, the Langfuse-shaped public API, and the private
``langfuse.*`` normalization were removed. These tests pin that state:

* every Langfuse-shaped route answers the framework's plain 404;
* the OTLP normalization registry no longer interprets ``langfuse.*``
  attributes (generic fallback only, no vendor payload/model/usage reads).

Removing the ingress paths never deleted stored traces; spans that carry
``langfuse.*`` keys remain durable canonical attributes and stay readable
through the native trace path.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from apo.models.db import OtlpSpanDB
from apo.services.otel_normalization import normalize_span

_REMOVED_ROUTES: tuple[tuple[str, str], ...] = (
    ("POST", "/api/public/ingestion"),
    ("GET", "/api/public/traces"),
    ("GET", "/api/public/traces/t-1"),
    ("GET", "/api/public/observations"),
    ("POST", "/api/public/scores"),
    ("GET", "/api/public/sessions"),
    ("GET", "/api/public/sessions/s-1"),
)


def test_langfuse_shaped_routes_are_gone(client: TestClient) -> None:
    """No Langfuse-shaped route is registered; all answer the plain 404."""
    for method, path in _REMOVED_ROUTES:
        call = getattr(client, method.lower())
        resp = call(path, json={}) if method == "POST" else call(path)
        assert resp.status_code == 404, f"{method} {path}: {resp.status_code}"


def test_normalization_registry_has_no_langfuse_branch() -> None:
    """A span carrying only langfuse.* attributes falls to the generic mapper.

    No langfuse mapping provenance, no payload/model/usage extraction: the
    attributes stay stored but are not vendor-interpreted.
    """
    span = OtlpSpanDB(
        project_id="p",
        trace_id="t1",
        span_id="s1",
        span_name="some observation",
        attributes={
            "langfuse.observation.type": "GENERATION",
            "langfuse.observation.model.name": "gpt-4o",
            "langfuse.observation.input": '{"systemPrompt": "hi"}',
            "langfuse.observation.usage_details": '{"input": 2, "output": 50}',
        },
        resource={},
    )
    result = normalize_span(span)
    assert result.observation_type == "SPAN"
    assert result.mapping_name == "generic"
    assert result.model is None
    assert result.token_usage == {}
    assert result.input is None
    assert result.output is None
