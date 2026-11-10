# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

"""A write that waits for SQLite's write lock must not wait on the event loop.

SQLite has one writer. A projection batch holds the write lock from a worker
thread for as long as its chunk takes, and every other write queues in
SQLite's busy handler for up to ``busy_timeout`` (30 s). That handler sleeps
on the calling thread. When the caller is the event loop, the whole service
stops answering for that long: ``/health``, every dashboard request, every
other run's heartbeat.

Each case here holds the write lock from a thread, starts one write the
service makes during a run, and watches the loop while that write waits.
"""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Awaitable, Callable

import httpx
import pytest
from sqlmodel import Session
from starlette.requests import Request
from starlette.responses import Response

import apo.auth.middleware as middleware
from apo.api import app
from apo.db import begin_immediate, engine
from apo.models.db import ProjectDB
from apo.services import execution_leases
from apo.services.executor_auth import generate_enrollment_token
from apo.services.trace_ingestion_queue import DbBackedQueue

HOLD_SECONDS = 0.6
PROJECT = "loop-lock"


def _hold_write_lock(taken: threading.Event) -> None:
    with Session(engine) as session:
        begin_immediate(session)
        taken.set()
        time.sleep(HOLD_SECONDS)
        session.rollback()


async def _longest_loop_stall_during(write: Callable[[], Awaitable[object]]) -> tuple[float, float]:
    """Run ``write`` behind a held write lock.

    Returns the longest time the loop went without running, and how long the
    write took (it has to outlast the lock, or it never waited at all).
    """
    taken = threading.Event()
    holder = threading.Thread(target=_hold_write_lock, args=(taken,))
    holder.start()
    assert await asyncio.to_thread(taken.wait, 5)

    longest = 0.0
    watching = True

    async def watch() -> None:
        nonlocal longest
        last = time.monotonic()
        while watching:
            await asyncio.sleep(0.01)
            now = time.monotonic()
            longest = max(longest, now - last)
            last = now

    watcher = asyncio.create_task(watch())
    await asyncio.sleep(0)
    started = time.monotonic()
    try:
        await write()
    finally:
        took = time.monotonic() - started
        watching = False
        await watcher
        await asyncio.to_thread(holder.join)
    return longest, took


def _assert_waited_off_the_loop(stall: float, took: float) -> None:
    assert took > HOLD_SECONDS / 2, f"the write finished in {took:.2f}s: it never waited for the lock"
    assert stall < HOLD_SECONDS / 2, f"the event loop stopped for {stall:.2f}s behind the write lock"


QUEUE_WRITES: dict[str, Callable[[DbBackedQueue], Awaitable[object]]] = {
    "enqueue": lambda q: q.enqueue("missing"),
    "claim": lambda q: q.claim("missing"),
    "mark_complete": lambda q: q.mark_complete("missing"),
    "requeue": lambda q: q.requeue("missing", "reason"),
    "recover_stale": lambda q: q.recover_stale(),
}


@pytest.mark.parametrize("operation", sorted(QUEUE_WRITES))
async def test_ingestion_queue_write_waits_off_the_loop(operation: str) -> None:
    queue = DbBackedQueue()
    stall, took = await _longest_loop_stall_during(lambda: QUEUE_WRITES[operation](queue))
    _assert_waited_off_the_loop(stall, took)


async def test_lease_sweep_commits_before_returning_to_the_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A sweep that wrote must not carry its write lock back to the loop.

    The lock would then be released only when the loop reaches the commit,
    and a write already waiting on the loop for that lock keeps it from
    getting there until ``busy_timeout`` runs out.
    """
    loop = asyncio.get_running_loop()
    waited: list[float] = []

    def loop_side_write() -> None:
        started = time.monotonic()
        try:
            with Session(engine) as session:
                begin_immediate(session)
                session.rollback()
        finally:
            waited.append(time.monotonic() - started)

    def sweep_that_writes(session: Session, *, now: object) -> None:
        begin_immediate(session)
        loop.call_soon_threadsafe(loop_side_write)

    monkeypatch.setattr(execution_leases, "recover_expired_attempts", sweep_that_writes)
    await execution_leases._sweep_expired_attempts()
    while not waited:
        await asyncio.sleep(0.01)
    assert waited[0] < 1.0, f"a loop-side write waited {waited[0]:.1f}s on the sweep's write lock"


async def test_api_key_usage_write_waits_off_the_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(middleware, "_is_open_dev_bypass_allowed", lambda: False)
    monkeypatch.setattr(
        middleware,
        "_authenticate",
        lambda _request: {"auth_method": "api_key", "api_key_id": f"key-{time.monotonic_ns()}"},
    )

    async def call_next(_request: Request) -> Response:
        return Response("ok")

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/v1/projects",
            "raw_path": b"/v1/projects",
            "query_string": b"",
            "headers": [],
            "scheme": "http",
            "server": ("testserver", 80),
            "client": ("127.0.0.1", 1234),
        }
    )
    auth = middleware.AuthMiddleware(app)
    stall, took = await _longest_loop_stall_during(lambda: auth.dispatch(request, call_next))
    _assert_waited_off_the_loop(stall, took)


async def test_executor_heartbeat_waits_off_the_loop() -> None:
    with Session(engine) as session:
        if session.get(ProjectDB, PROJECT) is None:
            session.add(ProjectDB(id=PROJECT, name=PROJECT))
            session.commit()
        token, _ = generate_enrollment_token(
            session, scope_kind="project", project_id=PROJECT, pool_id=None
        )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        enrolled = await client.post(
            "/v1/executor-protocol/v2/enroll",
            json={
                "token": token,
                "name": "loop-lock",
                "capabilities": {
                    "protocol_version": 2,
                    "executor_version": "0",
                    "driver_kinds": [],
                    "os": "linux",
                    "architecture": "x64",
                    "runtimes": {},
                    "max_concurrency": 1,
                },
            },
        )
        assert enrolled.status_code == 200, enrolled.text
        headers = {"Authorization": f"Bearer {enrolled.json()['credential']}"}

        async def heartbeat() -> None:
            response = await client.post(
                "/v1/executor-protocol/v2/heartbeat",
                json={"catalog_digest": "x", "available_slots": 1},
                headers=headers,
            )
            assert response.status_code == 200, response.text

        stall, took = await _longest_loop_stall_during(heartbeat)
    _assert_waited_off_the_loop(stall, took)
