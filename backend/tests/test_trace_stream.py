# pyright: reportAny=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedImport=false, reportUnusedCallResult=false

"""Tests for trace broadcaster and SSE streaming."""

import asyncio
import json

from apo.services.trace_broadcaster import (
    TraceBroadcaster,
    TraceEvent,
    get_trace_broadcaster,
    reset_trace_broadcaster,
)


def test_trace_event_sse_format():
    """Test that TraceEvent produces correct SSE format."""
    event = TraceEvent(
        event_type="span:created",
        trace_id="trace-123",
        data={"span_id": "span-1"},
    )
    sse = event.to_sse_format()

    assert sse.startswith("event: span:created\n")
    assert "data: " in sse
    assert sse.endswith("\n\n")

    payload_lines = sse.split("data: ", 1)
    payload = json.loads(payload_lines[1].strip())
    assert payload["event_type"] == "span:created"
    assert payload["trace_id"] == "trace-123"
    assert payload["data"]["span_id"] == "span-1"
    assert "timestamp" in payload


def test_trace_event_custom_timestamp():
    """Test that custom timestamp is preserved."""
    from datetime import datetime, timezone

    ts = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    event = TraceEvent(
        event_type="trace:created",
        trace_id="t1",
        data={},
        timestamp=ts,
    )
    assert event.timestamp == ts


def test_subscribe_and_publish():
    """Test basic subscribe and publish flow."""
    broadcaster = TraceBroadcaster()
    received = []

    async def run():
        async def collect():
            async for evt in broadcaster.subscribe("trace-1"):
                received.append(evt)
                break

        task = asyncio.create_task(collect())
        await asyncio.sleep(0.01)

        event = TraceEvent(event_type="span:created", trace_id="trace-1", data={"id": "s1"})
        await broadcaster.publish("trace-1", event)
        await asyncio.sleep(0.01)
        await task

    asyncio.run(run())
    assert len(received) == 1
    assert "span:created" in received[0]


def test_events_isolated_by_trace():
    """Events for one trace don't leak to another."""
    broadcaster = TraceBroadcaster()
    received = []

    async def run():
        async def collect():
            async for evt in broadcaster.subscribe("trace-1"):
                received.append(evt)
                break

        task = asyncio.create_task(collect())
        await asyncio.sleep(0.01)

        event2 = TraceEvent(event_type="span:created", trace_id="trace-2", data={})
        await broadcaster.publish("trace-2", event2)
        await asyncio.sleep(0.01)

        event1 = TraceEvent(event_type="span:created", trace_id="trace-1", data={})
        await broadcaster.publish("trace-1", event1)
        await asyncio.sleep(0.01)
        await task

    asyncio.run(run())
    assert len(received) == 1
    assert "trace-1" in received[0]


def test_multiple_subscribers_same_trace():
    """Multiple subscribers all receive the same event."""
    broadcaster = TraceBroadcaster()
    events1 = []
    events2 = []

    async def run():
        async def collect(events_list):
            async for evt in broadcaster.subscribe("trace-1"):
                events_list.append(evt)
                break

        t1 = asyncio.create_task(collect(events1))
        t2 = asyncio.create_task(collect(events2))
        await asyncio.sleep(0.01)

        event = TraceEvent(event_type="trace:created", trace_id="trace-1", data={"project": "p"})
        await broadcaster.publish("trace-1", event)
        await asyncio.sleep(0.01)

        await asyncio.gather(t1, t2)

    asyncio.run(run())
    assert len(events1) == 1
    assert len(events2) == 1
    assert events1[0] == events2[0]


def test_broadcast_convenience_methods():
    """Test convenience broadcast methods."""
    broadcaster = TraceBroadcaster()
    received = []

    async def run():
        async def collect():
            async for evt in broadcaster.subscribe("trace-1"):
                received.append(evt)
                if len(received) >= 4:
                    break

        task = asyncio.create_task(collect())
        await asyncio.sleep(0.01)

        await broadcaster.broadcast_trace_created("trace-1", {"project": "p"})
        await broadcaster.broadcast_span_created("trace-1", {"span_id": "s1"})
        await broadcaster.broadcast_span_updated("trace-1", {"span_id": "s1", "status": "done"})
        await broadcaster.broadcast_trace_completed("trace-1", {"duration_ms": 100})
        await asyncio.sleep(0.01)
        await task

    asyncio.run(run())
    assert len(received) == 4
    assert "trace:created" in received[0]
    assert "span:created" in received[1]
    assert "span:updated" in received[2]
    assert "trace:completed" in received[3]


def test_get_listener_count():
    """Test listener count tracking."""
    broadcaster = TraceBroadcaster()

    async def run():
        count = await broadcaster.get_listener_count("trace-1")
        assert count == 0

        async def dummy():
            async for _ in broadcaster.subscribe("trace-1"):
                await asyncio.sleep(10)

        t1 = asyncio.create_task(dummy())
        await asyncio.sleep(0.01)
        assert await broadcaster.get_listener_count("trace-1") == 1

        t1.cancel()
        try:
            await t1
        except asyncio.CancelledError:
            pass

    asyncio.run(run())


def test_close_all():
    """Test that close_all disconnects all listeners."""
    broadcaster = TraceBroadcaster()

    async def run():
        received = []

        async def collect():
            async for evt in broadcaster.subscribe("trace-1"):
                received.append(evt)

        task = asyncio.create_task(collect())
        await asyncio.sleep(0.01)

        assert await broadcaster.get_listener_count("trace-1") == 1

        await broadcaster.close_all()
        await asyncio.sleep(0.01)

        assert await broadcaster.get_listener_count("trace-1") == 0

        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(run())


def test_singleton():
    """Test that get_trace_broadcaster returns singleton."""
    async def run():
        reset_trace_broadcaster()
        b1 = await get_trace_broadcaster()
        b2 = await get_trace_broadcaster()
        assert b1 is b2
        assert isinstance(b1, TraceBroadcaster)

    asyncio.run(run())


def test_sse_disconnect_cleans_up():
    """Subscriber cleanup on disconnect."""
    broadcaster = TraceBroadcaster()

    async def run():
        async def subscribe_and_cancel():
            async for _ in broadcaster.subscribe("trace-1"):
                await asyncio.sleep(10)

        task = asyncio.create_task(subscribe_and_cancel())
        await asyncio.sleep(0.01)
        assert await broadcaster.get_listener_count("trace-1") == 1

        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await asyncio.sleep(0.01)

        assert await broadcaster.get_listener_count("trace-1") == 0

    asyncio.run(run())
