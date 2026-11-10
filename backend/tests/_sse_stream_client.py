# pyright: reportAny=false

"""A raw ASGI client for SSE routes that never end on their own.

The TestClient waits for a response to finish, and a live event stream
never does. This drives the app directly: it opens a stream, reports the
response head as soon as it is sent, keeps the connection open, and lets a
test disconnect on demand.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from dataclasses import dataclass, field

from fastapi import FastAPI
from sqlmodel import Session
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from apo.api import app
from apo.db import get_session
from apo.models.db import UserDB
from tests.conftest import engine, seed_project_for_user

# How long a test waits for a response head or for a stream to wind down.
_WAIT_SECONDS = 10


@dataclass
class OpenStream:
    """One in-flight request: its response head, the body so far, and its off switch."""

    status: int
    headers: dict[str, str]
    body: bytearray
    disconnect: asyncio.Event
    task: asyncio.Future[None] = field(repr=False)


def seed_member_project(session: Session, *, user_id: str, project_id: str) -> None:
    """A user who owns one project, so project-scoped stream routes authorize."""
    session.add(
        UserDB(id=user_id, email=f"{user_id}@test", name=user_id, password_hash="x")
    )
    session.commit()
    _ = seed_project_for_user(session, user_id, project_id=project_id)


def authed_asgi_app(user_id: str) -> ASGIApp:
    """The real routes, behind request state that names ``user_id`` as the caller."""
    inner = FastAPI()
    inner.include_router(app.router)

    def test_session() -> Iterator[Session]:
        with Session(engine) as session:
            yield session

    inner.dependency_overrides[get_session] = test_session

    async def authed(scope: Scope, receive: Receive, send: Send) -> None:
        state: dict[str, object] = scope.setdefault("state", {})
        state.update(user_id=user_id, is_admin=False, auth_method="cookie")
        await inner(scope, receive, send)

    return authed


async def open_stream(asgi_app: ASGIApp, path: str, query: str = "") -> OpenStream:
    """Send a GET and return once the response head has arrived.

    The request stays open (the client never disconnects) until
    :func:`close_stream` is called.
    """
    started: asyncio.Future[tuple[int, dict[str, str]]] = (
        asyncio.get_running_loop().create_future()
    )
    disconnect = asyncio.Event()
    body = bytearray()

    async def receive() -> Message:
        _ = await disconnect.wait()
        return {"type": "http.disconnect"}

    async def send(message: Message) -> None:
        if message["type"] == "http.response.start" and not started.done():
            raw_headers: list[tuple[bytes, bytes]] = message.get("headers", [])
            headers = {
                name.decode().lower(): value.decode() for name, value in raw_headers
            }
            started.set_result((message["status"], headers))
        elif message["type"] == "http.response.body":
            chunk: bytes = message.get("body", b"")
            body.extend(chunk)

    scope: Scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": query.encode(),
        "root_path": "",
        "headers": [],
        "client": ("testclient", 50000),
        "server": ("testserver", 80),
    }
    task = asyncio.ensure_future(asgi_app(scope, receive, send))
    status, headers = await asyncio.wait_for(started, timeout=_WAIT_SECONDS)
    return OpenStream(status, headers, body, disconnect, task)


async def close_stream(stream: OpenStream) -> None:
    """Disconnect the client and wait until the server side has wound down."""
    stream.disconnect.set()
    try:
        await asyncio.wait_for(stream.task, timeout=_WAIT_SECONDS)
    except asyncio.TimeoutError:
        # The server never finished: that is the failure a test must see.
        raise
    except Exception:
        # A stream cut by its client may end with a disconnect error; the
        # tests only need the server side to be finished.
        pass
