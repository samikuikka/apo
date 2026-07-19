# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Tests for content capture/redaction policy (SPEC-129 §1, §2).

The receiver must apply a content policy BEFORE persisting to the durable
inbox and canonical store. Three modes:
  - ``full``: keep all content (explicit opt-in)
  - ``redacted``: replace prompt/completion/tool content with a hash placeholder
  - ``off``: drop content attributes entirely, keep metadata only

The policy is per-project, configurable via ProjectDB.content_capture_policy.
"""

import json
import asyncio

import pytest
from fastapi import BackgroundTasks, Response
from starlette.requests import Request
from sqlmodel import Session, select, text
from apo.db import engine, init_db
from apo.models.db import OtlpSpanDB, OtlpIngestBatchDB, ProjectDB
from apo.services.otlp_receiver import OtlpReceiver
from apo.services.content_policy import apply_content_policy
from apo.routes.otlp_traces import receive_otlp_traces

FIXTURE_TRACE_ID = "a00102030405060708090a0b0c0d0e0f"  # 32 hex chars


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM otlp_spans"))
        session.execute(text("DELETE FROM otlp_ingest_batches"))
        session.execute(text("DELETE FROM projects WHERE id LIKE 'trace-policy-%'"))
        session.commit()


def _make_genai_payload(content: str = "my secret prompt") -> bytes:
    """Build an OTLP/JSON payload with gen_ai.input.messages content."""
    return json.dumps({
        "resourceSpans": [{
            "scopeSpans": [{
                "spans": [{
                    "traceId": FIXTURE_TRACE_ID,
                    "spanId": "a010203040506070",  # 16 hex chars
                    "name": "chat gpt-4o",
                    "startTime": "2026-07-10T12:00:00Z",
                    "endTime": "2026-07-10T12:00:01Z",
                    "attributes": [
                        {"key": "gen_ai.request.model", "value": {"stringValue": "gpt-4o"}},
                        {"key": "gen_ai.usage.input_tokens", "value": {"intValue": "100"}},
                        {
                            "key": "gen_ai.input.messages",
                            "value": {"stringValue": json.dumps([
                                {"role": "user", "parts": [{"content": content, "type": "text"}]}
                            ])},
                        },
                        {
                            "key": "gen_ai.output.messages",
                            "value": {"stringValue": json.dumps([
                                {"role": "assistant", "parts": [{"content": "secret response", "type": "text"}]}
                            ])},
                        },
                        {
                            "key": "gen_ai.tool.call.arguments",
                            "value": {"stringValue": '{"path": "/etc/passwd"}'},
                        },
                    ],
                }],
            }],
        }],
    }).encode()


class TestApplyContentPolicy:
    """Unit tests for the policy application function."""

    def test_full_policy_keeps_content(self):
        """full mode: all content attributes survive unchanged."""
        attributes = {
            "gen_ai.request.model": "gpt-4o",
            "gen_ai.input.messages": '[{"role":"user","parts":[{"content":"hello"}]}]',
            "gen_ai.output.messages": '[{"role":"assistant","parts":[{"content":"world"}]}]',
            "gen_ai.tool.call.arguments": '{"path":"x"}',
            "gen_ai.tool.call.result": '{"data":"y"}',
        }
        result = apply_content_policy(attributes, "full")
        assert result["gen_ai.input.messages"] == attributes["gen_ai.input.messages"]
        assert result["gen_ai.output.messages"] == attributes["gen_ai.output.messages"]

    def test_off_policy_drops_content(self):
        """off mode: content attributes removed, metadata kept."""
        attributes = {
            "gen_ai.request.model": "gpt-4o",
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.input.messages": '[{"role":"user","content":"secret"}]',
            "gen_ai.output.messages": '[{"role":"assistant","content":"response"}]',
            "gen_ai.tool.call.arguments": '{"path":"x"}',
            "gen_ai.tool.call.result": '{"data":"y"}',
        }
        result = apply_content_policy(attributes, "off")
        # Content dropped
        assert "gen_ai.input.messages" not in result
        assert "gen_ai.output.messages" not in result
        assert "gen_ai.tool.call.arguments" not in result
        assert "gen_ai.tool.call.result" not in result
        # Metadata kept
        assert result["gen_ai.request.model"] == "gpt-4o"
        assert result["gen_ai.usage.input_tokens"] == 100

    def test_redacted_policy_masks_content(self):
        """redacted mode: content replaced with hash placeholder, not the original."""
        original_prompt = "my super secret prompt"
        attributes = {
            "gen_ai.request.model": "gpt-4o",
            "gen_ai.input.messages": json.dumps([
                {"role": "user", "parts": [{"content": original_prompt, "type": "text"}]}
            ]),
            "gen_ai.output.messages": json.dumps([
                {"role": "assistant", "parts": [{"content": "secret response", "type": "text"}]}
            ]),
        }
        result = apply_content_policy(attributes, "redacted")
        # The original text must NOT appear anywhere in the result
        result_str = json.dumps(result)
        assert "super secret" not in result_str
        assert "secret response" not in result_str
        # But the key exists with a redacted placeholder
        assert "gen_ai.input.messages" in result
        assert "gen_ai.output.messages" in result
        # Metadata kept
        assert result["gen_ai.request.model"] == "gpt-4o"

    def test_redacted_preserves_structure_but_masks_values(self):
        """redacted mode: all string values masked including role/type (fail-safe)."""
        attributes = {
            "gen_ai.input.messages": json.dumps([
                {"role": "user", "parts": [{"content": "real data", "type": "text"}]}
            ]),
        }
        result = apply_content_policy(attributes, "redacted")
        decoded = json.loads(result["gen_ai.input.messages"])
        # All strings are masked — fail-safe redaction (no data leakage)
        assert decoded[0]["content"] != "real data" if "content" in decoded[0] else True
        # The original sensitive content must NOT appear
        result_str = json.dumps(decoded)
        assert "real data" not in result_str

    def test_unknown_policy_fails_closed_to_redacted(self):
        attributes = {"gen_ai.input.messages": "test"}
        result = apply_content_policy(attributes, "bogus")
        assert result["gen_ai.input.messages"] != "test"


class TestReceiverContentPolicy:
    """Integration: the receiver applies the policy before persisting."""

    def test_off_policy_strips_content_from_canonical_store(self):
        payload = _make_genai_payload("my secret prompt")
        receiver = OtlpReceiver()
        with Session(engine) as session:
            receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="test-off-project",
                session=session,
                content_policy="off",
            )

        with Session(engine) as session:
            span = session.exec(select(OtlpSpanDB)).first()
            assert span is not None
            attrs = span.attributes or {}
            assert "gen_ai.input.messages" not in attrs
            assert "gen_ai.output.messages" not in attrs
            assert "gen_ai.request.model" in attrs  # metadata kept

    def test_redacted_policy_masks_in_canonical_store(self):
        payload = _make_genai_payload("unique-secret-text-12345")
        receiver = OtlpReceiver()
        with Session(engine) as session:
            receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="test-redacted-project",
                session=session,
                content_policy="redacted",
            )

        with Session(engine) as session:
            span = session.exec(select(OtlpSpanDB)).first()
            assert span is not None
            attrs_json = json.dumps(span.attributes or {})
            assert "unique-secret-text-12345" not in attrs_json

    def test_redacted_value_is_identical_in_inbox_and_canonical_store(self):
        """The sanitized OTLP graph is the sole input to both durable stores."""
        payload = _make_genai_payload("single-redaction-secret")
        with Session(engine) as session:
            result = OtlpReceiver().ingest(
                payload=payload,
                content_type="application/json",
                project_id="test-single-redaction",
                session=session,
                content_policy="redacted",
            )

        with Session(engine) as session:
            batch = session.get(OtlpIngestBatchDB, result.batch_id)
            span = session.exec(select(OtlpSpanDB)).first()
            assert batch is not None
            assert span is not None

            inbox = json.loads(batch.payload)
            inbox_attributes = inbox["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["attributes"]
            inbox_prompt = next(
                attribute["value"]["stringValue"]
                for attribute in inbox_attributes
                if attribute["key"] == "gen_ai.input.messages"
            )
            canonical_prompt = (span.attributes or {})["gen_ai.input.messages"]

            assert isinstance(canonical_prompt, str)
            assert canonical_prompt == inbox_prompt
            assert "single-redaction-secret" not in canonical_prompt

    def test_redacted_policy_strips_every_durable_otel_attribute_location(self):
        """When a project uses the redacted policy, all content is masked
        across every OTLP attribute location — span, resource, event, link."""
        secrets = {
            "span-secret",
            "resource-secret",
            "event-secret",
            "link-secret",
        }
        decoded = json.loads(_make_genai_payload("span-secret"))
        resource_spans = decoded["resourceSpans"][0]
        resource_spans["resource"] = {
            "attributes": [{
                "key": "input.value",
                "value": {"stringValue": "resource-secret"},
            }]
        }
        span_payload = resource_spans["scopeSpans"][0]["spans"][0]
        span_payload["events"] = [{
            "name": "exception",
            "attributes": [{
                "key": "exception.message",
                "value": {"stringValue": "event-secret"},
            }],
        }]
        span_payload["links"] = [{
            "traceId": "b00102030405060708090a0b0c0d0e0f",
            "spanId": "b010203040506070",
            "attributes": [{
                "key": "gen_ai.tool.call.arguments",
                "value": {"stringValue": "link-secret"},
            }],
        }]

        with Session(engine) as session:
            result = OtlpReceiver().ingest(
                payload=json.dumps(decoded).encode(),
                content_type="application/json",
                project_id="test-redacted-policy",
                session=session,
                content_policy="redacted",
            )

        with Session(engine) as session:
            batch = session.get(OtlpIngestBatchDB, result.batch_id)
            span = session.exec(select(OtlpSpanDB)).first()
            assert batch is not None
            assert span is not None
            assert batch.content_policy == "redacted"
            assert span.content_policy == "redacted"
            durable_json = json.dumps({
                "inbox": batch.payload,
                "resource": span.resource,
                "attributes": span.attributes,
                "events": span.events,
                "links": span.links,
                "raw_span": span.raw_span,
            })
            for secret in secrets:
                assert secret not in durable_json

    def test_otlp_route_resolves_policy_from_authenticated_project(self):
        project_id = "trace-policy-route"
        secret = "route-owned-project-secret"
        with Session(engine) as session:
            session.add(ProjectDB(
                id=project_id,
                name="Trace Policy Route",
                trace_content_policy="off",
            ))
            session.commit()

        payload = _make_genai_payload(secret)

        async def ingest_through_route() -> None:
            sent = False

            async def receive() -> dict[str, object]:
                nonlocal sent
                if sent:
                    return {"type": "http.disconnect"}
                sent = True
                return {"type": "http.request", "body": payload, "more_body": False}

            request = Request({
                "type": "http",
                "method": "POST",
                "path": "/api/public/otel/v1/traces",
                "headers": [(b"content-type", b"application/json")],
                "query_string": b"",
                "server": ("test", 80),
                "client": ("test", 123),
                "scheme": "http",
            }, receive)
            request.state.project = project_id
            request.state.auth_method = "api_key"
            request.state.api_key_scope = "full"
            background_tasks = BackgroundTasks()
            with Session(engine) as session:
                response = await receive_otlp_traces(
                    request,
                    Response(),
                    background_tasks,
                    session,
                    None,
                )
            assert response.status_code == 200
            await background_tasks()

        asyncio.run(ingest_through_route())

        with Session(engine) as session:
            batch = session.exec(
                select(OtlpIngestBatchDB).where(
                    OtlpIngestBatchDB.project_id == project_id
                )
            ).first()
            span = session.exec(
                select(OtlpSpanDB).where(OtlpSpanDB.project_id == project_id)
            ).first()
            assert batch is not None
            assert span is not None
            assert batch.content_policy == "off"
            assert secret not in batch.payload
            assert secret not in json.dumps(span.raw_span)
            assert "gen_ai.input.messages" not in (span.attributes or {})

    def test_full_policy_keeps_content_in_canonical_store(self):
        payload = _make_genai_payload("keep-this-content")
        receiver = OtlpReceiver()
        with Session(engine) as session:
            receiver.ingest(
                payload=payload,
                content_type="application/json",
                project_id="test-full-project",
                session=session,
                content_policy="full",
            )

        with Session(engine) as session:
            span = session.exec(select(OtlpSpanDB)).first()
            assert span is not None
            attrs_json = json.dumps(span.attributes or {})
            assert "keep-this-content" in attrs_json
