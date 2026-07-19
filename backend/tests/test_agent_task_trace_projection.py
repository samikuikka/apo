# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Tests for the Task-Run-scoped Trace Projection endpoint (SPEC-130 Track B).

``GET /v1/agent-task-runs/{task_run_id}/trace-projection`` — an internal
execution boundary read. A task-run service token reads only its own Task
Run's projection; the route resolves the Trace through
``AgentTaskRunDB.trace_run_id`` (callers cannot supply an arbitrary Trace ID).

Covers SPEC-130 Test Cases 9-13:
  9.  Service token reads its own projected Trace -> 200.
  10. Projection not ready -> 202 + Retry-After.
  11. Token cannot read another Task Run -> 403 (no trace ID leaked).
  12. Payload Project cannot override token Project -> stays token-scoped.
  13. Task Run completed without a Trace -> 409.
"""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from _pytest.monkeypatch import MonkeyPatch
from sqlmodel import Session

from apo import auth as auth_module
from apo.auth import middleware as auth_middleware
from apo.auth.service_tokens import create_agent_task_trace_token
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    LoggedCallDB,
    RunDB,
)


@pytest.fixture(autouse=True)
def _force_auth_secret(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(auth_module, "AUTH_SECRET", "test-auth-secret")
    monkeypatch.setattr(auth_middleware, "AUTH_SECRET", "test-auth-secret")
    monkeypatch.setattr("apo.auth.service_tokens.AUTH_SECRET", "test-auth-secret")


_PROJECT = "example-service"


def _seed_task_run(
    session: Session,
    *,
    task_run_id: str = "task-run-1",
    project: str = _PROJECT,
    trace_run_id: str | None = None,
) -> None:
    session.add(
        AgentTaskBatchRunDB(
            id=f"batch-{task_run_id}",
            project=project,
            selection_type="task",
            status="running",
            total_tasks=1,
        )
    )
    session.add(
        AgentTaskRunDB(
            id=task_run_id,
            batch_run_id=f"batch-{task_run_id}",
            task_id="meeting-summary",
            task_path="/tmp/tasks/meeting-summary",
            status="running",
            trace_run_id=trace_run_id,
        )
    )
    session.commit()


def _seed_trace(
    session: Session,
    *,
    trace_id: str,
    project: str = _PROJECT,
    completed: bool = True,
) -> None:
    completed_at = datetime.now(timezone.utc) if completed else None
    session.add(
        RunDB(
            id=trace_id,
            project=project,
            flow_name="test-flow",
            environment="default",
            created_at=datetime.now(timezone.utc),
            completed_at=completed_at,
            duration_ms=5000.0 if completed else None,
        )
    )
    session.add(
        LoggedCallDB(
            id=f"{trace_id}-tool",
            run_id=trace_id,
            project=project,
            task_id="",
            created_at=datetime.now(timezone.utc),
            model="unknown",
            observation_type="TOOL",
            step_name="read_file",
            parent_call_id=None,
            latency_ms=5.0,
            tool_name="read_file",
            input={},
            output={},
            messages=[],
        )
    )
    session.commit()


def _token(task_run_id: str, project: str = _PROJECT) -> str:
    return create_agent_task_trace_token(
        task_run_id=task_run_id,
        project=project,
    )


class TestReadOwnProjection:
    """SPEC-130 Test 9: service token reads its own projected Trace."""

    def test_own_complete_trace_returns_200(self, client: TestClient, session: Session):
        _seed_task_run(session, task_run_id="run-a", trace_run_id="trace-a")
        _seed_trace(session, trace_id="trace-a", completed=True)

        resp = client.get(
            "/v1/agent-task-runs/run-a/trace-projection",
            headers={"Authorization": f"Bearer {_token('run-a')}"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["source"] == "canonical"
        assert body["trace"]["traceId"] == "trace-a"
        assert body["trace"]["complete"] is True
        assert any(o["type"] == "TOOL" for o in body["observations"])


class TestProjectionNotReady:
    """SPEC-130 Test 10: projection not ready -> 202 + Retry-After."""

    def test_incomplete_trace_returns_202(self, client: TestClient, session: Session):
        _seed_task_run(session, task_run_id="run-b", trace_run_id="trace-b")
        # Trace exists but root hasn't ended (completed_at is None).
        _seed_trace(session, trace_id="trace-b", completed=False)

        resp = client.get(
            "/v1/agent-task-runs/run-b/trace-projection",
            headers={"Authorization": f"Bearer {_token('run-b')}"},
        )
        assert resp.status_code == 202
        assert resp.json()["status"] == "pending"
        assert "retry-after" in {k.lower() for k in resp.headers.keys()}


class TestCrossRunForbidden:
    """SPEC-130 Test 11: token cannot read another Task Run's projection."""

    def test_token_for_other_run_returns_403(self, client: TestClient, session: Session):
        _seed_task_run(session, task_run_id="run-a", trace_run_id="trace-a")
        _seed_task_run(session, task_run_id="run-b", trace_run_id="trace-b")
        _seed_trace(session, trace_id="trace-a", completed=True)
        _seed_trace(session, trace_id="trace-b", completed=True)

        # Token for run-a, requesting run-b's projection.
        resp = client.get(
            "/v1/agent-task-runs/run-b/trace-projection",
            headers={"Authorization": f"Bearer {_token('run-a')}"},
        )
        assert resp.status_code == 403
        # Must NOT reveal run-b's trace ID.
        assert "trace-b" not in resp.text


class TestPayloadProjectCannotOverride:
    """SPEC-130 Test 12: payload/telemetry Project cannot override token Project.

    The route scopes the repository lookup to the token's verified project,
    never a query parameter or telemetry attribute. A token for project A
    cannot read a trace that lives in project B even if the task run is
    reachable.
    """

    def test_cross_project_trace_does_not_leak(self, client: TestClient, session: Session):
        # Task run in project A, but its trace_run_id points at a trace in
        # project B (a scenario that should not arise under correct claiming,
        # but the read boundary must be defensive).
        _seed_task_run(session, task_run_id="run-x", trace_run_id="trace-x")
        _seed_trace(session, trace_id="trace-x", project="other-project", completed=True)

        resp = client.get(
            "/v1/agent-task-runs/run-x/trace-projection",
            headers={"Authorization": f"Bearer {_token('run-x', project=_PROJECT)}"},
        )
        # The token's project (_PROJECT) doesn't own the trace; the repository
        # returns None. The route must NOT leak the cross-project trace's
        # existence or data — it surfaces a non-ready response instead.
        assert resp.status_code in (202, 404)
        assert "trace-x" not in resp.text
        body = resp.json()
        # No observations from the other project's trace leak through.
        assert body.get("observations") is None or body.get("observations") == []


class TestNoTraceClaimed:
    """SPEC-130 Test 13: Task Run completed without a Trace -> 409."""

    def test_completed_run_without_trace_returns_409(self, client: TestClient, session: Session):
        _seed_task_run(session, task_run_id="run-c", trace_run_id=None)

        resp = client.get(
            "/v1/agent-task-runs/run-c/trace-projection",
            headers={"Authorization": f"Bearer {_token('run-c')}"},
        )
        assert resp.status_code == 409
        assert resp.json()["detail"] == "Task run has no trace"


class TestTaskRunNotFound:
    """A task run that doesn't exist in the token's project -> 404."""

    def test_nonexistent_run_returns_404(self, client: TestClient):
        resp = client.get(
            "/v1/agent-task-runs/does-not-exist/trace-projection",
            headers={"Authorization": f"Bearer {_token('does-not-exist')}"},
        )
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Task run not found"
