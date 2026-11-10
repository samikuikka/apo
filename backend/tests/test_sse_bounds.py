# pyright: reportAny=false, reportUnusedCallResult=false

"""SSE streams are bounded: what one subscriber may buffer, and how many
streams one caller may hold open.

Before these bounds a subscriber that stopped reading kept every event
published to its channel (the queues had no maximum, so the publisher's
"queue full" branch could never run), and nothing limited how many streams
one caller held. A caller that opened streams and never read them grew the
server's memory without end.
"""

from __future__ import annotations

import asyncio
import gc
import json
import logging
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable, Iterator
from typing import cast

import pytest
from _pytest.logging import LogCaptureFixture
from _pytest.monkeypatch import MonkeyPatch
from fastapi import Request
from sqlmodel import Session

from apo.services.broadcaster import Broadcaster
from apo.services.sse import (
    KEEPALIVE_FRAME,
    StreamCapExceeded,
    sse_streaming_response,
)
from apo.services.sse_limits import (
    SseLimitError,
    SseLimits,
    StreamLimiter,
    load_sse_limits,
    reset_stream_limiter,
)
from apo.services.trace_broadcaster import TraceBroadcaster
from tests._sse_stream_client import (
    authed_asgi_app,
    close_stream,
    open_stream,
    seed_member_project,
)

LIMIT_VARIABLES = (
    "APO_MAX_STREAMS_PER_IDENTITY",
    "APO_SSE_QUEUE_MAX_EVENTS",
    "APO_SSE_QUEUE_MAX_BYTES",
)
USER_ID = "user-sse-bounds"
PROJECT_ID = "sse-bounds"
STREAM_CAP = 2


@pytest.fixture(autouse=True)
def fresh_stream_limiter() -> Iterator[None]:
    """Stream slots are process-wide; no test may inherit or leave any."""
    reset_stream_limiter()
    yield
    reset_stream_limiter()


@pytest.fixture
def stream_cap(monkeypatch: MonkeyPatch) -> int:
    monkeypatch.setenv("APO_MAX_STREAMS_PER_IDENTITY", str(STREAM_CAP))
    reset_stream_limiter()
    return STREAM_CAP


# ---------------------------------------------------------------------------
# Subscriber queues: a slow reader loses its oldest events, nothing grows
# ---------------------------------------------------------------------------


async def test_stalled_subscriber_keeps_only_the_newest_events() -> None:
    broadcaster: Broadcaster[str] = Broadcaster(max_queue_events=3)
    stalled = await _stalled_reader(broadcaster, "channel")

    for index in range(10):
        await broadcaster.publish("channel", f"event-{index}")

    kept = [await anext(stalled) for _ in range(3)]
    assert kept == ["event-7", "event-8", "event-9"]
    # Nothing older was waiting behind them.
    await broadcaster.publish("channel", "after")
    assert await anext(stalled) == "after"
    await stalled.aclose()


async def test_large_events_are_bounded_by_bytes_not_only_by_count() -> None:
    broadcaster: Broadcaster[str] = Broadcaster(max_queue_events=100, max_queue_bytes=10)
    stalled = await _stalled_reader(broadcaster, "channel")

    for event in ("aaaa", "bbbb", "cccc", "dddd"):
        await broadcaster.publish("channel", event)

    # Ten characters hold two four-character events, so the oldest two went.
    assert [await anext(stalled) for _ in range(2)] == ["cccc", "dddd"]
    await broadcaster.publish("channel", "end")
    assert await anext(stalled) == "end"
    await stalled.aclose()


async def test_event_larger_than_the_whole_budget_still_arrives() -> None:
    """A reader that is keeping up must not lose the one event it is owed."""
    broadcaster: Broadcaster[str] = Broadcaster(max_queue_events=100, max_queue_bytes=10)
    stalled = await _stalled_reader(broadcaster, "channel")
    oversized = "x" * 40

    await broadcaster.publish("channel", "small")
    await broadcaster.publish("channel", oversized)

    assert await anext(stalled) == oversized
    await stalled.aclose()


async def test_stalled_subscriber_costs_a_healthy_one_nothing() -> None:
    broadcaster: Broadcaster[str] = Broadcaster(max_queue_events=2)
    stalled = await _stalled_reader(broadcaster, "channel")
    received: list[str] = []

    async def read_everything() -> None:
        async for event in broadcaster.subscribe("channel"):
            received.append(event)

    healthy = asyncio.create_task(read_everything())
    await _wait_for_listeners(lambda: broadcaster.get_listener_count("channel"), 2)

    sent = [f"event-{index}" for index in range(10)]
    for count, event in enumerate(sent, start=1):
        await broadcaster.publish("channel", event)
        await _wait_until(lambda: len(received) == count)

    assert received == sent
    assert [await anext(stalled) for _ in range(2)] == ["event-8", "event-9"]
    healthy.cancel()
    await asyncio.gather(healthy, return_exceptions=True)
    await stalled.aclose()


async def test_close_all_reaches_a_subscriber_whose_queue_is_full() -> None:
    broadcaster: Broadcaster[str] = Broadcaster(max_queue_events=2)
    stalled = await _stalled_reader(broadcaster, "channel")
    for index in range(5):
        await broadcaster.publish("channel", f"event-{index}")

    await broadcaster.close_all()

    async def drain() -> list[str]:
        return [event async for event in stalled]

    # The close signal took the oldest slot; the stream ends instead of hanging.
    assert await asyncio.wait_for(drain(), timeout=5) == ["event-4"]


async def test_dropping_is_logged_once_per_subscriber(
    caplog: LogCaptureFixture,
) -> None:
    broadcaster: Broadcaster[str] = Broadcaster(max_queue_events=2)
    stalled = await _stalled_reader(broadcaster, "channel")

    with caplog.at_level(logging.WARNING, logger="apo.services.broadcaster"):
        for index in range(6):
            await broadcaster.publish("channel", f"event-{index}")

    drops = [r for r in caplog.records if r.name == "apo.services.broadcaster"]
    assert len(drops) == 1, [r.getMessage() for r in drops]
    assert "channel" in drops[0].getMessage()
    await stalled.aclose()


async def test_trace_stream_subscribers_are_bounded_by_the_configured_limit(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setenv("APO_SSE_QUEUE_MAX_EVENTS", "2")
    broadcaster = TraceBroadcaster()
    stream = cast(
        AsyncGenerator[str, None], broadcaster.subscribe("project", "trace-1")
    )
    first = asyncio.ensure_future(anext(stream))
    await _wait_for_listeners(
        lambda: broadcaster.get_listener_count("project", "trace-1"), 1
    )
    await broadcaster.broadcast_trace_created("project", "trace-1", {"id": "trace-1"})
    assert "trace:created" in await first

    for index in range(6):
        await broadcaster.broadcast_span_created(
            "project", "trace-1", {"id": f"span-{index}"}
        )

    kept = [_span_id(await anext(stream)) for _ in range(2)]
    assert kept == ["span-4", "span-5"]
    await stream.aclose()


# ---------------------------------------------------------------------------
# Limits: read from the environment, checked at startup
# ---------------------------------------------------------------------------


def test_limits_default_when_the_environment_is_silent(
    monkeypatch: MonkeyPatch,
) -> None:
    for name in LIMIT_VARIABLES:
        monkeypatch.delenv(name, raising=False)

    assert load_sse_limits() == SseLimits(
        max_streams_per_identity=10,
        queue_max_events=4096,
        queue_max_bytes=2_097_152,
    )


def test_invalid_limit_is_rejected_by_name(monkeypatch: MonkeyPatch) -> None:
    accepted: list[tuple[str, str]] = []
    for name in LIMIT_VARIABLES:
        for raw in ("", "abc", "0", "-1"):
            with monkeypatch.context() as patched:
                patched.setenv(name, raw)
                try:
                    load_sse_limits()
                except SseLimitError as error:
                    assert name in str(error)
                else:
                    accepted.append((name, raw))

    assert accepted == []


def test_invalid_stream_cap_fails_app_construction(
    monkeypatch: MonkeyPatch,
) -> None:
    # Same contract as the other limits: a bad value stops startup instead
    # of surfacing on the first stream a user opens.
    from apo.api import create_app

    monkeypatch.setenv("APO_MAX_STREAMS_PER_IDENTITY", "0")
    with pytest.raises(SseLimitError, match="APO_MAX_STREAMS_PER_IDENTITY"):
        create_app()


# ---------------------------------------------------------------------------
# Stream cap: one caller holds a bounded number of streams
# ---------------------------------------------------------------------------


def test_limiter_grants_slots_up_to_the_cap_per_identity() -> None:
    limiter = StreamLimiter(max_streams_per_identity=2)
    first = limiter.try_acquire("user:alice")
    second = limiter.try_acquire("user:alice")

    assert first is not None and second is not None
    assert limiter.try_acquire("user:alice") is None
    assert limiter.try_acquire("user:bob") is not None

    # Releasing twice frees one slot, not two.
    first.release()
    first.release()
    assert limiter.active_streams("user:alice") == 1
    assert limiter.try_acquire("user:alice") is not None
    assert limiter.try_acquire("user:alice") is None


def test_limiter_forgets_an_identity_with_no_open_streams() -> None:
    limiter = StreamLimiter(max_streams_per_identity=2)
    lease = limiter.try_acquire("user:alice")
    assert lease is not None

    lease.release()

    assert limiter.active_streams("user:alice") == 0
    assert limiter.tracked_identity_count() == 0


async def test_stream_past_the_cap_is_answered_with_429(stream_cap: int) -> None:
    held = [await _streaming(_request()) for _ in range(stream_cap)]

    refusal = _assert_refused(_request())

    assert refusal.status_code == 429
    assert refusal.detail == "Concurrent stream limit exceeded"
    assert refusal.headers == {
        "Retry-After": "25",
        "X-RateLimit-Limit": str(stream_cap),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Resource": "streams",
        "X-RateLimit-Scope": "identity",
    }
    for stream in held:
        await stream.aclose()


async def test_closing_a_stream_frees_its_slot(stream_cap: int) -> None:
    held = [await _streaming(_request()) for _ in range(stream_cap)]
    _assert_refused(_request())

    await held[0].aclose()

    reopened = await _streaming(_request())
    for stream in (*held[1:], reopened):
        await stream.aclose()


async def test_response_that_never_streams_gives_its_slot_back(stream_cap: int) -> None:
    """A client can vanish before the body starts; that stream's cleanup
    never runs, so the slot must come back another way."""
    never_started = [
        sse_streaming_response(_request(), _silent, []) for _ in range(stream_cap)
    ]
    _assert_refused(_request())

    del never_started
    gc.collect()

    reopened = await _streaming(_request())
    await reopened.aclose()


async def test_each_identity_has_its_own_slots(stream_cap: int) -> None:
    def alice() -> Request:
        return _request(auth_method="cookie", user_id="alice")

    held = [await _streaming(alice()) for _ in range(stream_cap)]
    _assert_refused(alice())

    bob = await _streaming(_request(auth_method="cookie", user_id="bob"))
    key = await _streaming(_request(auth_method="api_key", api_key_id="key-1"))

    for stream in (*held, bob, key):
        await stream.aclose()


async def test_anonymous_callers_share_one_set_of_slots(stream_cap: int) -> None:
    """The anonymous demo is one tenant: every visitor draws from the same
    slots, so a caller with no account cannot hold more than the cap."""
    held = [
        await _streaming(_request(auth_method="anonymous")),
        await _streaming(_request()),
    ]
    assert len(held) == stream_cap

    _assert_refused(_request(auth_method="anonymous"))

    for stream in held:
        await stream.aclose()


async def test_stream_routes_answer_429_past_the_cap(
    session: Session, stream_cap: int
) -> None:
    """Both stream endpoints draw from the same slots, through the real routes."""
    seed_member_project(session, user_id=USER_ID, project_id=PROJECT_ID)
    asgi_app = authed_asgi_app(USER_ID)
    query = f"project={PROJECT_ID}"

    run_events = await open_stream(asgi_app, "/v1/events", query)
    trace = await open_stream(asgi_app, "/v1/traces/no-such-trace/stream", query)
    over_cap = await open_stream(asgi_app, "/v1/events", query)
    await close_stream(over_cap)

    assert (run_events.status, trace.status) == (200, 200)
    assert over_cap.status == 429
    assert over_cap.headers["x-ratelimit-resource"] == "streams"
    assert over_cap.headers["x-ratelimit-limit"] == str(stream_cap)
    assert over_cap.headers["retry-after"] == "25"
    assert json.loads(bytes(over_cap.body)) == {
        "detail": "Concurrent stream limit exceeded"
    }

    # A client that goes away gives its slot to the next one.
    await close_stream(run_events)
    reopened = await open_stream(asgi_app, "/v1/events", query)
    assert reopened.status == 200
    await close_stream(reopened)
    await close_stream(trace)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _stalled_reader(
    broadcaster: Broadcaster[str], key: str
) -> AsyncGenerator[str, None]:
    """A subscriber that read one event and then stopped pulling.

    It is parked between events: still subscribed, so its queue fills, but
    nothing drains that queue until the test asks for the next event.
    """
    listening = await broadcaster.get_listener_count(key)
    stream = cast(AsyncGenerator[str, None], broadcaster.subscribe(key))
    first = asyncio.ensure_future(anext(stream))
    await _wait_for_listeners(
        lambda: broadcaster.get_listener_count(key), listening + 1
    )
    await broadcaster.publish(key, "first")
    assert await first == "first"
    return stream


async def _wait_for_listeners(
    count_listeners: Callable[[], Awaitable[int]], expected: int
) -> None:
    """Yield to the event loop until a new subscription has registered."""
    async with asyncio.timeout(5):
        while await count_listeners() != expected:
            await asyncio.sleep(0)


async def _wait_until(condition: Callable[[], bool]) -> None:
    async with asyncio.timeout(5):
        while not condition():
            await asyncio.sleep(0)


def _span_id(frame: str) -> str:
    """The span id carried by one ``span:*`` SSE frame."""
    payload = json.loads(frame.split("data: ", 1)[1])
    return cast(str, payload["data"]["id"])


def _request(**state: object) -> Request:
    """A request whose client never disconnects, carrying ``state`` as its auth."""

    async def receive() -> dict[str, str]:
        await asyncio.sleep(3600)
        return {"type": "http.disconnect"}

    return Request(
        {"type": "http", "method": "GET", "headers": [], "state": dict(state)},
        receive,
    )


async def _silent() -> AsyncIterator[str]:
    await asyncio.sleep(3600)
    yield "never"


async def _streaming(request: Request) -> AsyncGenerator[str, None]:
    """Open a stream and read its first frame, so it is live and holds a slot."""
    response = sse_streaming_response(request, _silent, [], keepalive_interval=0.01)
    stream = cast(AsyncGenerator[str, None], response.body_iterator)
    assert await anext(stream) == KEEPALIVE_FRAME
    return stream


def _assert_refused(request: Request) -> StreamCapExceeded:
    """Ask for one more stream and return the refusal it must get."""
    try:
        sse_streaming_response(request, _silent, [])
    except StreamCapExceeded as refusal:
        return refusal
    raise AssertionError("the stream was opened; expected it to be refused")
