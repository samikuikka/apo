# pyright: reportAny=false

"""Routes whose work is blocking SQL must not do it on the event loop.

The backend runs one worker. An ``async def`` route that runs sync SQL holds
the event loop for the whole query, so one slow read (a cold scan of a large
table takes seconds) stalls every other request with it: other users' pages,
live streams, the health probe. FastAPI runs a plain ``def`` route in its
threadpool, and an async route can hand its SQL to a worker thread.

Each case wraps a function the route body calls and records whether an event
loop was running in the calling thread. A worker thread has none.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from datetime import datetime, timezone
from types import ModuleType

from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import (
    AgentTaskBatchRunDB,
    ProjectDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
)
from apo.routes import agent_task_runs, otlp_traces, projects, run_events
from tests._sse_stream_client import (
    authed_asgi_app,
    close_stream,
    open_stream,
    seed_member_project,
)

NOW = datetime.now(timezone.utc)
USER_ID = "user-loop-hygiene"
PROJECT_ID = "loop-hygiene"


def test_batch_detail_runs_off_the_event_loop(
    client: TestClient, session: Session, monkeypatch: MonkeyPatch
) -> None:
    session.add(
        AgentTaskBatchRunDB(
            id="batch-loop",
            project=PROJECT_ID,
            selection_type="task",
            task_root="/tmp/tasks",
            environment="default",
            status="completed",
            total_tasks=0,
            created_at=NOW,
        )
    )
    session.commit()
    on_loop = _spy_on_loop(monkeypatch, agent_task_runs, "authorize_project_request")

    response = client.get("/v1/agent-task-batch-runs/batch-loop")

    assert response.status_code == 200, response.text
    assert response.json()["id"] == "batch-loop"
    assert on_loop == [False]


def test_agent_tasks_list_runs_off_the_event_loop(
    client: TestClient, session: Session, monkeypatch: MonkeyPatch
) -> None:
    session.add(ProjectDB(id=PROJECT_ID, name=PROJECT_ID))
    session.commit()
    source = ProjectTaskSourceDB(
        project=PROJECT_ID, source_type="published", status="ready"
    )
    session.add(source)
    session.commit()
    session.add(
        ProjectTaskInventoryDB(
            project=PROJECT_ID,
            task_source_id=source.id,
            task_id="chat/alpha",
            display_name="alpha",
            folder_path="chat",
            task_path="chat/alpha",
            source_type="published",
        )
    )
    session.commit()
    on_loop = _spy_on_loop(monkeypatch, projects, "_load_project_for_request")

    response = client.get(f"/v1/projects/{PROJECT_ID}/agent-tasks")

    assert response.status_code == 200, response.text
    assert [task["id"] for task in response.json()] == ["chat/alpha"]
    assert on_loop == [False]


async def test_run_events_stream_builds_its_initial_state_off_the_event_loop(
    session: Session, monkeypatch: MonkeyPatch
) -> None:
    seed_member_project(session, user_id=USER_ID, project_id=PROJECT_ID)
    authorized_on_loop = _spy_on_loop(
        monkeypatch, run_events, "enforce_project_role_from_request"
    )
    built_on_loop = _spy_on_loop(monkeypatch, run_events, "_build_initial_events")

    stream = await open_stream(
        authed_asgi_app(USER_ID), "/v1/events", f"project={PROJECT_ID}"
    )
    await close_stream(stream)

    assert stream.status == 200
    assert authorized_on_loop == [False]
    assert built_on_loop == [False]


def test_otlp_usage_accounting_runs_off_the_event_loop(
    make_api_key_client: Callable[..., TestClient],
    session: Session,
    monkeypatch: MonkeyPatch,
) -> None:
    """The usage counter is a write: it queues for SQLite's write lock behind
    running projections, and that wait must not be the event loop's."""
    recorded: list[tuple[bool, str | None, int]] = []

    def record_usage(
        _session: Session, api_key_id: str | None, *, spans: int, bytes_: int
    ) -> None:
        _ = bytes_
        recorded.append((_loop_is_running_here(), api_key_id, spans))

    monkeypatch.setattr(otlp_traces, "record_ingest_usage", record_usage)
    keyed = make_api_key_client("user-loop-otlp", PROJECT_ID, session)

    response = keyed.post(
        "/api/public/otel/v1/traces",
        headers={"Content-Type": "application/json"},
        content=_otlp_payload(spans=2),
    )

    assert response.status_code == 200, response.text
    assert recorded == [(False, "test-key", 2)]


def _spy_on_loop(
    monkeypatch: MonkeyPatch, module: ModuleType, name: str
) -> list[bool]:
    """Wrap ``module.name``; each call records whether it ran on an event loop."""
    original: Callable[..., object] = getattr(module, name)
    calls: list[bool] = []

    def spy(*args: object, **kwargs: object) -> object:
        calls.append(_loop_is_running_here())
        return original(*args, **kwargs)

    monkeypatch.setattr(module, name, spy)
    return calls


def _loop_is_running_here() -> bool:
    try:
        _ = asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


def _otlp_payload(*, spans: int) -> bytes:
    span_list = [
        {
            "traceId": "ab" * 16,
            "spanId": f"{index + 1:016x}",
            "name": f"span.{index}",
            "kind": 1,
            "flags": 1,
            "startTimeUnixNano": "1700000000000000000",
            "status": {"code": 1},
        }
        for index in range(spans)
    ]
    return json.dumps(
        {
            "resourceSpans": [
                {"scopeSpans": [{"scope": {"name": "t"}, "spans": span_list}]}
            ]
        }
    ).encode()
