# pyright: reportAny=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false

import asyncio
import json
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from sqlmodel import Session

from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB, WebhookDB
from apo.services import webhook_delivery as wd_module
from apo.services.run_events import (
    EVENT_BATCH_RUN_COMPLETED,
    EVENT_BATCH_RUN_FAILED,
    EVENT_TASK_RUN_COMPLETED,
    EVENT_TASK_RUN_ERROR,
    RunEvent,
    RunEventBroadcaster,
    _build_task_run_payload,
    _build_batch_run_payload,
)
from apo.services.webhook_delivery import (
    sign_payload,
    verify_signature,
    generate_secret,
    deliver_webhook,
    fire_webhooks_for_event,
)


def _make_task_run(**overrides: object) -> AgentTaskRunDB:
    defaults: dict[str, object] = {
        "id": "tr-001",
        "task_id": "smoke-test",
        "batch_run_id": "batch-001",
        "project": "example-service",
        "status": "passed",
        "pass_result": True,
        "checks_json": [{"name": "format", "pass": True}],
        "total_cost": 0.042,
        "started_at": datetime(2026, 6, 8, 12, 0, 0, tzinfo=timezone.utc),
        "completed_at": datetime(2026, 6, 8, 12, 0, 5, tzinfo=timezone.utc),
    }
    defaults.update(overrides)
    return AgentTaskRunDB(**defaults)


def _make_batch_run(**overrides: object) -> AgentTaskBatchRunDB:
    defaults: dict[str, object] = {
        "id": "batch-001",
        "project": "example-service",
        "status": "completed",
        "total_tasks": 2,
        "passed_tasks": 2,
        "failed_tasks": 0,
        "errored_tasks": 0,
        "started_at": datetime(2026, 6, 8, 12, 0, 0, tzinfo=timezone.utc),
        "completed_at": datetime(2026, 6, 8, 12, 0, 10, tzinfo=timezone.utc),
    }
    defaults.update(overrides)
    return AgentTaskBatchRunDB(**defaults)


# ── RunEvent ──────────────────────────────────────────────────────────────


class TestRunEvent:
    def test_to_sse_format(self):
        event = RunEvent(
            event_type="task_run.completed",
            project="example-service",
            data={"task_run_id": "tr-001", "status": "passed"},
            timestamp=datetime(2026, 6, 8, 12, 0, 5, tzinfo=timezone.utc),
        )
        sse = event.to_sse_format()
        assert sse.startswith("event: task_run.completed\n")
        assert "data: " in sse
        parsed = json.loads(sse.split("data: ", 1)[1])
        assert parsed["event_type"] == "task_run.completed"
        assert parsed["project"] == "example-service"
        assert parsed["data"]["task_run_id"] == "tr-001"
        assert sse.endswith("\n\n")


# ── Broadcaster ───────────────────────────────────────────────────────────


class TestBroadcaster:
    async def test_publish_to_subscriber(self):
        broadcaster = RunEventBroadcaster()
        events: list[str] = []

        async def subscriber():
            async for event in broadcaster.subscribe("example-service"):
                events.append(event)
                if len(events) >= 2:
                    break

        async def publisher():
            await asyncio.sleep(0.01)
            await broadcaster.publish(
                "example-service",
                RunEvent("task_run.completed", "example-service", {"id": "1"}),
            )
            await broadcaster.publish(
                "example-service",
                RunEvent("batch_run.completed", "example-service", {"id": "2"}),
            )

        await asyncio.gather(subscriber(), publisher())
        assert len(events) == 2
        assert "task_run.completed" in events[0]
        assert "batch_run.completed" in events[1]

    async def test_isolation_between_projects(self):
        broadcaster = RunEventBroadcaster()
        project_a_events: list[str] = []

        async def subscriber_a():
            async for event in broadcaster.subscribe("project-a"):
                project_a_events.append(event)
                if len(project_a_events) >= 1:
                    break

        async def publisher():
            await asyncio.sleep(0.01)
            await broadcaster.publish(
                "project-b",
                RunEvent("task_run.completed", "project-b", {"id": "wrong"}),
            )
            await broadcaster.publish(
                "project-a",
                RunEvent("task_run.completed", "project-a", {"id": "right"}),
            )

        await asyncio.gather(subscriber_a(), publisher())
        assert len(project_a_events) == 1
        assert "right" in project_a_events[0]

    async def test_close_all(self):
        broadcaster = RunEventBroadcaster()
        events: list[str] = []

        async def subscriber():
            async for event in broadcaster.subscribe("proj"):
                events.append(event)

        async def closer():
            await asyncio.sleep(0.01)
            await broadcaster.close_all()

        await asyncio.gather(subscriber(), closer())
        assert len(events) == 0


# ── Payload builders ──────────────────────────────────────────────────────


class TestPayloadBuilders:
    def test_task_run_payload(self):
        tr = _make_task_run()
        payload = _build_task_run_payload(tr)
        assert payload["task_run_id"] == "tr-001"
        assert payload["status"] == "passed"
        assert payload["pass_result"] is True
        assert payload["total_checks"] == 1
        assert payload["passed_checks"] == 1
        assert payload["failed_checks"] == 0
        assert payload["duration_ms"] == 5000.0
        assert payload["total_cost"] == 0.042

    def test_task_run_payload_failed(self):
        tr = _make_task_run(
            status="failed",
            pass_result=False,
            checks_json=[{"name": "format", "pass": True}, {"name": "safety", "pass": False}],
        )
        payload = _build_task_run_payload(tr)
        assert payload["total_checks"] == 2
        assert payload["passed_checks"] == 1
        assert payload["failed_checks"] == 1

    def test_batch_run_payload(self):
        batch = _make_batch_run()
        tr1 = _make_task_run(id="tr-1")
        tr2 = _make_task_run(id="tr-2")
        payload = _build_batch_run_payload(batch, [tr1, tr2])
        assert payload["batch_run_id"] == "batch-001"
        assert payload["status"] == "completed"
        assert payload["total_tasks"] == 2
        assert payload["passed_tasks"] == 2
        assert payload["duration_ms"] == 10000.0
        assert payload["task_run_ids"] == ["tr-1", "tr-2"]

    def test_batch_run_payload_with_metadata(self):
        batch = _make_batch_run(
            run_metadata={"trigger": {"source": "schedule", "schedule_id": "sched-1"}},
        )
        payload = _build_batch_run_payload(batch, [])
        assert payload["run_metadata"]["trigger"]["source"] == "schedule"


# ── HMAC signing ──────────────────────────────────────────────────────────


class TestHMACSigning:
    def test_sign_and_verify(self):
        secret = "whsec_abcdef123456"
        payload = b'{"event_type":"test"}'
        signature = sign_payload(payload, secret)
        assert signature.startswith("sha256=")
        assert verify_signature(payload, secret, signature)

    def test_verify_fails_wrong_secret(self):
        signature = sign_payload(b'{"test":1}', "secret-a")
        assert not verify_signature(b'{"test":1}', "secret-b", signature)

    def test_verify_fails_wrong_payload(self):
        signature = sign_payload(b'{"test":1}', "secret")
        assert not verify_signature(b'{"test":2}', "secret", signature)

    def test_generate_secret_format(self):
        secret = generate_secret()
        assert secret.startswith("whsec_")
        assert len(secret) == 6 + 48  # whsec_ + 24 bytes hex


# ── Webhook CRUD via API ──────────────────────────────────────────────────


class TestWebhookCRUD:
    def test_create_webhook(self, client: pytest.fixture):
        resp = client.post(
            "/v1/webhooks",
            json={
                "project": "example-service",
                "url": "https://example.com/webhook",
                "events": ["batch_run.completed"],
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert "id" in data
        assert data["secret"].startswith("whsec_")

    def test_list_webhooks(self, client: pytest.fixture):
        client.post(
            "/v1/webhooks",
            json={"project": "example-service", "url": "https://example.com/hook1"},
        )
        client.post(
            "/v1/webhooks",
            json={"project": "other-project", "url": "https://example.com/hook2"},
        )

        resp = client.get("/v1/webhooks", params={"project": "example-service"})
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["url"] == "https://example.com/hook1"
        assert "secret" not in data[0]

    def test_get_webhook(self, client: pytest.fixture):
        create_resp = client.post(
            "/v1/webhooks",
            json={"project": "example-service", "url": "https://example.com/hook"},
        )
        wh_id = create_resp.json()["id"]

        resp = client.get(f"/v1/webhooks/{wh_id}")
        assert resp.status_code == 200
        assert resp.json()["url"] == "https://example.com/hook"

    def test_update_webhook(self, client: pytest.fixture):
        create_resp = client.post(
            "/v1/webhooks",
            json={"project": "example-service", "url": "https://old.com/hook"},
        )
        wh_id = create_resp.json()["id"]

        resp = client.patch(
            f"/v1/webhooks/{wh_id}",
            json={"url": "https://new.com/hook", "enabled": False},
        )
        assert resp.status_code == 200
        assert resp.json()["url"] == "https://new.com/hook"
        assert resp.json()["enabled"] is False

    def test_delete_webhook(self, client: pytest.fixture):
        create_resp = client.post(
            "/v1/webhooks",
            json={"project": "example-service", "url": "https://example.com/hook"},
        )
        wh_id = create_resp.json()["id"]

        resp = client.delete(f"/v1/webhooks/{wh_id}")
        assert resp.status_code == 204

        resp = client.get(f"/v1/webhooks/{wh_id}")
        assert resp.status_code == 404

    def test_rotate_secret(self, client: pytest.fixture):
        create_resp = client.post(
            "/v1/webhooks",
            json={"project": "example-service", "url": "https://example.com/hook"},
        )
        old_secret = create_resp.json()["secret"]
        wh_id = create_resp.json()["id"]

        resp = client.post(f"/v1/webhooks/{wh_id}/rotate-secret")
        assert resp.status_code == 200
        new_secret = resp.json()["secret"]
        assert new_secret != old_secret
        assert new_secret.startswith("whsec_")

    def test_create_webhook_invalid_events(self, client: pytest.fixture):
        resp = client.post(
            "/v1/webhooks",
            json={
                "project": "example-service",
                "url": "https://example.com/hook",
                "events": ["invalid.event", "batch_run.completed"],
            },
        )
        assert resp.status_code == 400
        assert "invalid.event" in resp.json()["detail"]

    def test_webhook_404(self, client: pytest.fixture):
        resp = client.get("/v1/webhooks/9999")
        assert resp.status_code == 404


# ── Webhook delivery ──────────────────────────────────────────────────────


class TestWebhookDelivery:
    async def test_deliver_success(self, session: Session):
        secret = generate_secret()
        wh = WebhookDB(
            project="example-service",
            url="https://httpbin.org/post",
            secret=secret,
            events=["batch_run.completed"],
        )
        session.add(wh)
        session.commit()
        session.refresh(wh)
        assert wh.id is not None

        delivered_payloads: list[bytes] = []

        import httpx

        original_post = httpx.AsyncClient.post

        async def mock_post(self_client: httpx.AsyncClient, url: str, **kwargs: object):
            content = kwargs.get("content", b"")
            if isinstance(content, bytes):
                delivered_payloads.append(content)
            resp = httpx.Response(200, request=httpx.Request("POST", url))
            return resp

        httpx.AsyncClient.post = mock_post  # type: ignore[assignment]
        try:
            event_data = {
                "event_type": "batch_run.completed",
                "project": "example-service",
                "data": {"batch_run_id": "batch-001", "status": "completed"},
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            result = await deliver_webhook(wh, event_data)
            assert result is True
            assert len(delivered_payloads) == 1

            payload = delivered_payloads[0]
            assert verify_signature(payload, secret, sign_payload(payload, secret))
        finally:
            httpx.AsyncClient.post = original_post  # type: ignore[assignment]

    async def test_deliver_retry_then_fail(self, session: Session):
        secret = generate_secret()
        wh = WebhookDB(
            project="example-service",
            url="https://example.com/fail",
            secret=secret,
            events=["batch_run.completed"],
        )
        session.add(wh)
        session.commit()
        session.refresh(wh)
        assert wh.id is not None

        import httpx

        original_post = httpx.AsyncClient.post

        async def mock_post_fail(self_client: httpx.AsyncClient, url: str, **kwargs: object):
            resp = httpx.Response(500, request=httpx.Request("POST", url))
            return resp

        httpx.AsyncClient.post = mock_post_fail  # type: ignore[assignment]
        try:
            event_data = {
                "event_type": "batch_run.completed",
                "project": "example-service",
                "data": {"batch_run_id": "batch-001"},
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            result = await deliver_webhook(wh, event_data)
            assert result is False
        finally:
            httpx.AsyncClient.post = original_post  # type: ignore[assignment]

    async def test_fire_webhooks_for_event_filters_by_events(self, session: Session):
        from tests.conftest import engine as test_engine

        secret1 = generate_secret()
        wh_batch_only = WebhookDB(
            project="example-service",
            url="https://example.com/batch-hook",
            secret=secret1,
            events=["batch_run.completed"],
        )
        secret2 = generate_secret()
        wh_all = WebhookDB(
            project="example-service",
            url="https://example.com/all-hook",
            secret=secret2,
            events=[],
        )
        session.add(wh_batch_only)
        session.add(wh_all)
        session.commit()

        delivered_urls: list[str] = []

        import httpx

        original_post = httpx.AsyncClient.post
        original_engine = wd_module.engine

        async def mock_post(self_client: httpx.AsyncClient, url: str, **kwargs: object):
            delivered_urls.append(url)
            return httpx.Response(200, request=httpx.Request("POST", url))

        httpx.AsyncClient.post = mock_post  # type: ignore[assignment]
        wd_module.engine = test_engine
        try:
            event = RunEvent(
                event_type=EVENT_TASK_RUN_COMPLETED,
                project="example-service",
                data={"task_run_id": "tr-001"},
            )
            await fire_webhooks_for_event("example-service", event)

            assert "https://example.com/all-hook" in delivered_urls
            assert "https://example.com/batch-hook" not in delivered_urls
        finally:
            httpx.AsyncClient.post = original_post  # type: ignore[assignment]
            wd_module.engine = original_engine

    async def test_fire_webhooks_skips_disabled(self, session: Session):
        from tests.conftest import engine as test_engine

        secret = generate_secret()
        wh = WebhookDB(
            project="example-service",
            url="https://example.com/disabled-hook",
            secret=secret,
            events=["batch_run.completed"],
            enabled=False,
        )
        session.add(wh)
        session.commit()

        delivered_urls: list[str] = []

        import httpx

        original_post = httpx.AsyncClient.post
        original_engine = wd_module.engine

        async def mock_post(self_client: httpx.AsyncClient, url: str, **kwargs: object):
            delivered_urls.append(url)
            return httpx.Response(200, request=httpx.Request("POST", url))

        httpx.AsyncClient.post = mock_post  # type: ignore[assignment]
        wd_module.engine = test_engine
        try:
            event = RunEvent(
                event_type=EVENT_BATCH_RUN_COMPLETED,
                project="example-service",
                data={"batch_run_id": "batch-001"},
            )
            await fire_webhooks_for_event("example-service", event)
            assert len(delivered_urls) == 0
        finally:
            httpx.AsyncClient.post = original_post  # type: ignore[assignment]
            wd_module.engine = original_engine


# ── SSE endpoint ──────────────────────────────────────────────────────────


# SSE endpoint is an infinite stream — tested manually or with dedicated async client

