"""Project Authorization Boundary Closure.

Red-first tests for the canonical Project authorization policy. The policy
intersects request Credential Authority (session / API key / capability token)
with current Project membership and role. Every later route closure builds on
this seam.

Unit tests (1–5) exercise the policy directly through a mock request; HTTP
scene tests (11+) exercise registered routes through TestClient and live in
later commits as each route group is closed.
"""

# pyright: reportAny=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedImport=false, reportUnusedCallResult=false, reportAttributeAccessIssue=false, reportExplicitAny=false, reportUnannotatedClassAttribute=false, reportUnusedParameter=false, reportUnusedVariable=false, reportUnknownLambdaType=false
from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from datetime import datetime, timezone
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskDeliverableDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    ApiKeyDB,
    ProjectDB,
    ProjectMembershipDB,
    UserDB,
)
from apo.services.artifact_stores.local import LocalArtifactStore
from apo.services.project_memberships import (
    authorize_project_request,
    readable_project_ids_for_request,
)

_PROJECT_A = "proj-auth-a"
_PROJECT_B = "proj-auth-b"
_USER_ALICE = "user-alice"  # member of A only
_USER_BOB = "user-bob"  # member of B only
_USER_CAROL = "user-carol"  # admin of A and B (multi-project user)


# ---------------------------------------------------------------------------
# Mock request helpers
# ---------------------------------------------------------------------------


class _MockState:
    """Minimal stand-in for ``request.state`` with arbitrary attributes."""

    def __init__(self, **kwargs: Any) -> None:
        for key, value in kwargs.items():
            setattr(self, key, value)


class _MockRequest:
    """Minimal stand-in for a Starlette ``Request`` — only ``.state`` is read."""

    def __init__(self, **state: Any) -> None:
        self.state = _MockState(**state)


def _session_request(user_id: str) -> _MockRequest:
    """A cookie-session request: ``auth_method`` unset, ``user_id`` set."""
    return _MockRequest(user_id=user_id, auth_method="cookie")


def _api_key_request(user_id: str, project: str, scope: str = "full") -> _MockRequest:
    """An API-key request: bound to ``project`` with the creator's ``user_id``."""
    return _MockRequest(
        user_id=user_id,
        auth_method="api_key",
        project=project,
        api_key_scope=scope,
        api_key_id="test-key",
    )


def _unauthenticated_request() -> _MockRequest:
    """A request with no credential at all (open-dev check)."""
    return _MockRequest()


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------


def _add_membership(
    session: Session, project_id: str, user_id: str, role: str = "member"
) -> None:
    now = datetime.now(timezone.utc)
    session.add(
        ProjectMembershipDB(
            project_id=project_id,
            user_id=user_id,
            role=role,
            created_at=now,
            updated_at=now,
        )
    )
    session.commit()


def _make_user(session: Session, user_id: str, email: str | None = None) -> UserDB:
    user = UserDB(
        id=user_id,
        email=email or f"{user_id}@test",
        name=user_id,
        password_hash="x",
    )
    session.add(user)
    session.commit()
    return user


def _make_project(session: Session, project_id: str, owner_id: str) -> ProjectDB:
    project = ProjectDB(
        id=project_id,
        name=project_id,
        created_by=owner_id,
        created_at=datetime.now(timezone.utc),
    )
    session.add(project)
    session.commit()
    _add_membership(session, project_id, owner_id, role="owner")
    return project


def _mint_api_key(
    session: Session,
    project: str,
    creator_id: str,
    *,
    scope: str = "full",
    key_id: str = "key-test",
) -> ApiKeyDB:
    now = datetime.now(timezone.utc)
    key = ApiKeyDB(
        id=key_id,
        name=key_id,
        project=project,
        created_by=creator_id,
        public_key=f"pub-{key_id}",
        hashed_secret_key=f"hash-{key_id}",
        prefix=f"pub-{key_id}"[:8],
        scope=scope,
        created_at=now,
    )
    session.add(key)
    session.commit()
    return key


@pytest.fixture(name="authed_world")
def authed_world_fixture(session: Session) -> None:
    """Seed two disjoint Projects, three users with distinct memberships, one API key.

    - Alice: owner of A only
    - Bob: owner of B only
    - Carol: admin of both A and B (the multi-project user)
    - An API key bound to A, created by Carol (so the creator has A membership)
    """
    for user_id in (_USER_ALICE, _USER_BOB, _USER_CAROL):
        _make_user(session, user_id)
    _make_project(session, _PROJECT_A, owner_id=_USER_ALICE)
    _make_project(session, _PROJECT_B, owner_id=_USER_BOB)
    _add_membership(session, _PROJECT_A, _USER_CAROL, role="admin")
    _add_membership(session, _PROJECT_B, _USER_CAROL, role="admin")
    _mint_api_key(session, _PROJECT_A, creator_id=_USER_CAROL, key_id="key-a")


# ---------------------------------------------------------------------------
# Unit test 1: Session authority is membership-scoped
# ---------------------------------------------------------------------------


def test_session_authority_is_membership_scoped(authed_world: None, session: Session) -> None:
    """Alice belongs to A, not B. She can authorize A but not B."""
    a_membership = authorize_project_request(
        _session_request(_USER_ALICE), session, _PROJECT_A
    )
    assert a_membership.project_id == _PROJECT_A
    assert a_membership.user_id == _USER_ALICE

    with pytest.raises(HTTPException) as exc_info:
        authorize_project_request(
            _session_request(_USER_ALICE), session, _PROJECT_B
        )
    assert exc_info.value.status_code == 403


# ---------------------------------------------------------------------------
# Unit test 2: API-key authority is the intersection, not creator identity
# ---------------------------------------------------------------------------


def test_api_key_authority_is_intersection_not_creator(authed_world: None, session: Session) -> None:
    """Carol is admin in both A and B; her A-bound key may only touch A.

    The key does not gain B access merely because Carol's session has it.
    """
    # Key bound to A authenticates as Carol (the creator).
    a_request = _api_key_request(_USER_CAROL, project=_PROJECT_A)
    a_membership = authorize_project_request(a_request, session, _PROJECT_A)
    assert a_membership.project_id == _PROJECT_A

    # The same key cannot authorize B — the intersection of (key Project=A,
    # Carol's memberships={A,B}) is A.
    b_request = _api_key_request(_USER_CAROL, project=_PROJECT_A)
    with pytest.raises(HTTPException) as exc_info:
        authorize_project_request(b_request, session, _PROJECT_B)
    assert exc_info.value.status_code == 403


# ---------------------------------------------------------------------------
# Unit test 3: Membership removal revokes user-derived key authority
# ---------------------------------------------------------------------------


def test_membership_removal_revokes_api_key_authority(
    authed_world: None, session: Session
) -> None:
    """Removing Carol from A immediately stops her A-bound key.

    Even if authentication still recognizes the key, the policy rechecks the
    creator's CURRENT membership before authorizing.
    """
    # Sanity: the key works before removal.
    authorize_project_request(
        _api_key_request(_USER_CAROL, project=_PROJECT_A), session, _PROJECT_A
    )

    # Remove Carol's A membership.
    from sqlmodel import select

    carol_a = session.exec(
        select(ProjectMembershipDB).where(
            ProjectMembershipDB.project_id == _PROJECT_A,
            ProjectMembershipDB.user_id == _USER_CAROL,
        )
    ).first()
    assert carol_a is not None
    session.delete(carol_a)
    session.commit()

    # The key is rejected on the next request — creator membership rechecked.
    with pytest.raises(HTTPException) as exc_info:
        authorize_project_request(
            _api_key_request(_USER_CAROL, project=_PROJECT_A), session, _PROJECT_A
        )
    assert exc_info.value.status_code == 403


# ---------------------------------------------------------------------------
# Unit test 4: Release profile rejects synthetic legacy owner
# ---------------------------------------------------------------------------


def test_release_profile_rejects_synthetic_legacy_owner(
    authed_world: None, session: Session, monkeypatch: Any
) -> None:
    """An authenticated release-profile request against a nonexistent Project
    is denied (404). No synthetic owner membership is minted.

    In a release profile the legacy owner fallback that exists for development
    must not fire — every authenticated user would otherwise become the owner
    of any project string they can type.
    """
    monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "server")
    monkeypatch.setenv("AUTH_SECRET", "release-secret-min-32-chars-long")
    nonexistent = "proj-does-not-exist"

    with pytest.raises(HTTPException) as exc_info:
        authorize_project_request(
            _session_request(_USER_ALICE), session, nonexistent
        )
    # Nonexistent cross-Project target returns 404
    # where revealing existence is unnecessary.
    assert exc_info.value.status_code == 404


# ---------------------------------------------------------------------------
# Unit test 5: Development profile preserves open local workflow
# ---------------------------------------------------------------------------


def test_development_profile_preserves_legacy_owner_for_real_project(
    authed_world: None, session: Session, monkeypatch: Any
) -> None:
    """Under development profile, the legacy owner fallback still fires for
    nonexistent project strings — preserving local workflow where SDK
    ingestion may reference projects before they have a ProjectDB row.

    The same setup under a release profile is denied (unit test 4).
    """
    # Development profile + open-dev mode (AUTH_SECRET unset): legacy
    # owner fallback fires for a nonexistent project string.
    monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "development")
    monkeypatch.setenv("AUTH_SECRET", "")
    nonexistent = "proj-adhoc-ingest"

    membership = authorize_project_request(
        _unauthenticated_request(), session, nonexistent
    )
    assert membership.role == "owner"
    assert membership.project_id == nonexistent


# ---------------------------------------------------------------------------
# Unit test 8 (hoisted from scene tests): Readable Project set
# ---------------------------------------------------------------------------


def test_readable_project_set_depends_on_credential_kind(
    authed_world: None, session: Session
) -> None:
    """Carol belongs to A and B; her A-bound API key returns A only.

    Session returns A+B (all memberships); API key returns exactly its bound
    Project (if the creator still has membership there).
    """
    # Session: all memberships.
    session_projects = readable_project_ids_for_request(
        _session_request(_USER_CAROL), session
    )
    assert session_projects is not None
    assert set(session_projects) == {_PROJECT_A, _PROJECT_B}

    # API key: exactly the bound project.
    key_projects = readable_project_ids_for_request(
        _api_key_request(_USER_CAROL, project=_PROJECT_A), session
    )
    assert key_projects == [_PROJECT_A]


# ---------------------------------------------------------------------------
# HTTP scene tests 11-14: cross-Project denial on registered routes
# ---------------------------------------------------------------------------

_BATCH_A = "batch-http-a"
_BATCH_B = "batch-http-b"
_RUN_A = "run-http-a"
_RUN_B = "run-http-b"
_TASK_ID_A = "evals/http-task-a"
_TASK_ID_B = "evals/http-task-b"


def _seed_http_world(session: Session) -> dict[str, str]:
    """Seed two Projects each with a Batch Run + Task Run. Return the IDs."""
    now = datetime.now(timezone.utc)
    for uid in (_USER_ALICE, _USER_BOB):
        _make_user(session, uid)
    _make_project(session, _PROJECT_A, owner_id=_USER_ALICE)
    _make_project(session, _PROJECT_B, owner_id=_USER_BOB)

    for pid, bid, rid, tid in [
        (_PROJECT_A, _BATCH_A, _RUN_A, _TASK_ID_A),
        (_PROJECT_B, _BATCH_B, _RUN_B, _TASK_ID_B),
    ]:
        session.add(
            AgentTaskBatchRunDB(
                id=bid, project=pid, created_at=now, status="completed",
                total_tasks=1, task_root="/t", environment="default",
                selection_type="task",
            )
        )
        session.flush()
        session.add(
            AgentTaskRunDB(
                id=rid, batch_run_id=bid, task_id=tid, task_path=f"/t/{tid}",
                status="passed", pass_result=True, configured_model="test-model",
                configured_effort=None, started_at=now, completed_at=now,
            )
        )
    session.commit()
    return {"run_a": _RUN_A, "run_b": _RUN_B, "batch_a": _BATCH_A, "batch_b": _BATCH_B}


# ---------------------------------------------------------------------------
# Test 11: Task Run list does not cross Projects
# ---------------------------------------------------------------------------


def test_task_run_list_does_not_cross_projects(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """An unscoped Task Run list returns only the caller's Project's runs."""
    _seed_http_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.get("/v1/agent-task-runs")
    assert resp.status_code == 200
    run_ids = {r["id"] for r in resp.json()}
    assert _RUN_B in run_ids
    assert _RUN_A not in run_ids  # Project A's run must not appear


# ---------------------------------------------------------------------------
# Test 12: Task Run detail is opaque cross-Project
# ---------------------------------------------------------------------------


def test_task_run_detail_is_opaque_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """A cross-Project Task Run detail request returns 404, not the data."""
    _seed_http_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.get(f"/v1/agent-task-runs/{_RUN_A}")
    assert resp.status_code == 404
    # No sentinel content from Project A leaks.
    body = resp.json()
    assert "detail" in body
    assert _TASK_ID_A not in str(body)


def test_run_judgments_are_opaque_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """Issue #159: judgment list/detail/definition-source stay Project-scoped.

    A non-member reading another Project's run gets an opaque 404 on every
    judgments surface — list, single judgment, definition source, and the
    create route alike.
    """
    _seed_http_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    assert bob_client.get(f"/v1/agent-task-runs/{_RUN_A}/judgments").status_code == 404
    assert (
        bob_client.get(f"/v1/agent-task-runs/{_RUN_A}/judgments/{_RUN_A}").status_code == 404
    )
    assert (
        bob_client.get(f"/v1/agent-task-runs/{_RUN_A}/definition-source").status_code == 404
    )
    create = bob_client.post(
        f"/v1/agent-task-runs/{_RUN_A}/judgments",
        json={"checks": [{"id": "c", "pass": True, "reasoning": "x"}]},
    )
    assert create.status_code == 404


# ---------------------------------------------------------------------------
# Test 13: Batch Run list/detail do not cross Projects
# ---------------------------------------------------------------------------


def test_batch_run_list_does_not_cross_projects(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed_http_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.get("/v1/agent-task-batch-runs")
    assert resp.status_code == 200
    batch_ids = {b["id"] for b in resp.json()["data"]}
    assert _BATCH_B in batch_ids
    assert _BATCH_A not in batch_ids


def test_batch_run_detail_is_opaque_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed_http_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.get(f"/v1/agent-task-batch-runs/{_BATCH_A}")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Test 14: Deliverable manifest requires Project access
# ---------------------------------------------------------------------------


def test_deliverable_list_requires_project_access(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """A cross-Project Deliverable list returns 404, not the manifest."""
    _seed_http_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.get(f"/v1/agent-task-runs/{_RUN_A}/deliverables")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Phase 3 HTTP scene tests: Schedules, Executor bootstrap, Run-event SSE
# ---------------------------------------------------------------------------

_SCHEDULE_A = "schedule-http-a"
_SCHEDULE_B = "schedule-http-b"


def _seed_schedule_world(session: Session) -> None:
    """Extend the HTTP world with a schedule in each Project."""
    now = datetime.now(timezone.utc)
    _seed_http_world(session)
    for pid, sid in [(_PROJECT_A, _SCHEDULE_A), (_PROJECT_B, _SCHEDULE_B)]:
        session.add(
            AgentTaskScheduleDB(
                id=sid,
                name=sid,
                project=pid,
                selection_type="task",
                cadence_type="fixed",
                enabled=True,
                created_at=now,
                updated_at=now,
                execution_kind="source_owned",
                execution_owner_user_id=_USER_ALICE if pid == _PROJECT_A else _USER_BOB,
            )
        )
    session.commit()


# ---------------------------------------------------------------------------
# Test 17: Schedule reads do not cross Projects
# ---------------------------------------------------------------------------


def test_schedule_list_does_not_cross_projects(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed_schedule_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.get("/v1/agent-task-schedules")
    assert resp.status_code == 200
    schedule_ids = {s["id"] for s in resp.json()}
    assert _SCHEDULE_B in schedule_ids
    assert _SCHEDULE_A not in schedule_ids


def test_schedule_detail_is_opaque_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed_schedule_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.get(f"/v1/agent-task-schedules/{_SCHEDULE_A}")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Test 18: Connected Executor bootstrap requires membership
# ---------------------------------------------------------------------------


def test_connected_executor_bootstrap_requires_membership(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed_http_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.post(
        f"/v1/projects/{_PROJECT_A}/connected-executor-bootstrap",
        json={"name": "bob-executor", "capabilities": {}},
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Test 20: Run-event SSE denies before subscription
# ---------------------------------------------------------------------------


def test_run_event_sse_denies_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """A cross-Project run-event SSE request is denied before streaming."""
    _seed_http_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    # Bob subscribes to Project A's events — should be denied.
    resp = bob_client.get(f"/v1/events?project={_PROJECT_A}")
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# Test 21: Trace SSE is denied cross-Project before streaming
# ---------------------------------------------------------------------------


def test_trace_sse_denies_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """A cross-Project Trace SSE request is denied before streaming."""
    _seed_http_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    # Bob subscribes to a trace in Project A — denied before streaming.
    resp = bob_client.get(f"/v1/traces/some-trace-id/stream?project={_PROJECT_A}")
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# Phase 4: Analytics cross-Project denial
# ---------------------------------------------------------------------------


def test_analytics_search_denies_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed_http_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.post(
        "/api/v1/traces/search",
        json={"project": _PROJECT_A, "limit": 10, "offset": 0},
    )
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# Phase 4: Trace mutation cross-Project denial
# ---------------------------------------------------------------------------


_TRACE_A = "trace-http-a"


def _seed_trace_world(session: Session) -> None:
    """Seed a trace (RunDB) in Project A."""
    from apo.models.db import RunDB

    now = datetime.now(timezone.utc)
    _seed_http_world(session)
    session.add(
        RunDB(
            id=_TRACE_A,
            project=_PROJECT_A,
            task_id="evals/trace-task",
            flow_name="test-flow",
            version="1",
            created_at=now,
        )
    )
    session.commit()


def test_trace_bookmark_denies_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """A cross-Project trace bookmark toggle is denied."""
    _seed_trace_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.patch(f"/v1/runs/{_TRACE_A}/bookmark")
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# Phase 5: Project deletion covers every dependent model
# ---------------------------------------------------------------------------


def test_project_deletion_removes_all_dependent_models(session: Session) -> None:
    """Deletion leaves no Project-owned row behind.

    Seeds one row in each of the five models that were missing from the
    original deletion code, then calls ``delete_project_data`` and asserts
    every table is empty for the project.
    """
    from apo.models.db import (
        AgentTaskCheckReportDB,
        AgentTaskDeliverableDB,
        AgentTaskScheduleOccurrenceDB,
        TaskViewComparisonDB,
        TaskViewDB,
    )
    from apo.services.project_deletion import delete_project_data

    now = datetime.now(timezone.utc)
    _make_user(session, _USER_ALICE)
    _make_project(session, _PROJECT_A, owner_id=_USER_ALICE)

    # Seed a batch + run so check reports and deliverables have a parent.
    session.add(
        AgentTaskBatchRunDB(
            id="batch-del", project=_PROJECT_A, created_at=now, status="completed",
            total_tasks=1, task_root="/t", environment="default", selection_type="task",
        )
    )
    session.flush()
    session.add(
        AgentTaskRunDB(
            id="run-del", batch_run_id="batch-del", task_id="evals/del",
            task_path="/t/evals/del", status="passed", pass_result=True,
            started_at=now, completed_at=now,
        )
    )
    session.flush()

    # 1. AgentTaskCheckReportDB — transitive through runs
    session.add(AgentTaskCheckReportDB(run_id="run-del", value_json=[], created_at=now))
    # 2. AgentTaskDeliverableDB — direct project column
    session.add(
        AgentTaskDeliverableDB(
            id="del-1", task_run_id="run-del", project=_PROJECT_A, name="report",
            kind="json", status="ready", inline_value_json={"answer": 42},
            storage_backend=None, storage_key=None, media_type="application/json",
            size_bytes=2, sha256="a" * 64, created_at=now,
        )
    )
    # 3. AgentTaskScheduleOccurrenceDB — transitive through schedules
    session.add(
        AgentTaskScheduleDB(
            id="sched-del", name="sched-del", project=_PROJECT_A,
            selection_type="task", cadence_type="fixed", enabled=True,
            execution_kind="source_owned", execution_owner_user_id=_USER_ALICE,
            created_at=now, updated_at=now,
        )
    )
    session.flush()
    session.add(
        AgentTaskScheduleOccurrenceDB(
            id="occ-del", schedule_id="sched-del", project=_PROJECT_A,
            schedule_name="sched-del", kind="scheduled",
            scheduled_for=now, status="pending", created_at=now,
        )
    )
    # 4. TaskViewDB — direct project_id
    session.add(
        TaskViewDB(
            id="tv-del", project_id=_PROJECT_A, user_id=_USER_ALICE,
            label="test-view", model="test-model", created_at=now,
        )
    )
    # 5. TaskViewComparisonDB — direct project_id
    session.add(
        TaskViewComparisonDB(
            id="tvc-del", project_id=_PROJECT_A,
            view_a_config={"model": "a"}, view_b_config={"model": "b"},
            task_ids=["evals/del"], resolved=[], coverage={},
            created_at=now,
        )
    )
    session.commit()

    # Delete the project's data (keep_project=False).
    deleted = delete_project_data(
        session, _PROJECT_A, keep_project=False, keep_api_keys=False
    )

    # Assert every seeded model has zero rows for the project.
    assert session.exec(select(AgentTaskCheckReportDB)).first() is None
    assert session.exec(
        select(AgentTaskDeliverableDB).where(AgentTaskDeliverableDB.project == _PROJECT_A)
    ).first() is None
    assert session.exec(
        select(AgentTaskScheduleOccurrenceDB).where(
            AgentTaskScheduleOccurrenceDB.project == _PROJECT_A
        )
    ).first() is None
    assert session.exec(
        select(TaskViewDB).where(TaskViewDB.project_id == _PROJECT_A)
    ).first() is None
    assert session.exec(
        select(TaskViewComparisonDB).where(TaskViewComparisonDB.project_id == _PROJECT_A)
    ).first() is None


# ---------------------------------------------------------------------------
# Unit test 9: Trace channel identity is Project-qualified
# ---------------------------------------------------------------------------


def test_trace_channel_identity_is_project_qualified() -> None:
    """Two Projects sharing one public OTel Trace ID stream only their own.

    Publish/subscribe is keyed by
    ``(project_id, trace_id)`` — an event published to Project A's channel
    must never reach a subscriber of Project B's channel for the same
    trace ID.
    """
    import asyncio

    from apo.services.trace_broadcaster import TraceBroadcaster

    broadcaster = TraceBroadcaster()
    trace_id = "shared-otel-trace-id"
    a_events: list[str] = []
    b_events: list[str] = []

    async def run() -> None:
        async def collect(events: list[str], project: str) -> None:
            async for evt in broadcaster.subscribe(project, trace_id):
                events.append(evt)
                return

        a_task = asyncio.create_task(collect(a_events, _PROJECT_A))
        b_task = asyncio.create_task(collect(b_events, _PROJECT_B))
        await asyncio.sleep(0.01)  # let both subscriptions register

        await broadcaster.broadcast_span_created(
            _PROJECT_A, trace_id, {"id": "span-a", "step_name": "sentinel-a"}
        )
        await asyncio.sleep(0.01)

        await asyncio.wait_for(a_task, timeout=1.0)
        b_task.cancel()
        try:
            await b_task
        except asyncio.CancelledError:
            pass

    asyncio.run(run())

    assert len(a_events) == 1
    assert "sentinel-a" in a_events[0]
    assert b_events == []  # B subscriber never receives A's event


# ---------------------------------------------------------------------------
# Test 15: Task Catalog is role- and credential-scoped
# ---------------------------------------------------------------------------

_USER_DAVE = "user-dave"  # plain member of A

_CATALOG_TASK = {
    "task_id": "catalog-task",
    "display_name": "catalog-task",
    "adapter_name": "generic",
    "task_path": "tasks/catalog-task",
}


def _seed_catalog_world(session: Session) -> None:
    """Alice owns A, Dave is a plain member of A, Bob owns B."""
    _make_user(session, _USER_DAVE)
    _seed_http_world(session)  # users + projects
    _add_membership(session, _PROJECT_A, _USER_DAVE, role="member")


def test_task_catalog_read_requires_membership(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """A B-outsider cannot read A's Task Catalog."""
    _seed_catalog_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.get(f"/v1/projects/{_PROJECT_A}/task-catalog")
    assert resp.status_code in (403, 404)


def test_task_catalog_member_read_and_admin_publish(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """A member can read A's catalog; only admin/owner may publish it."""
    _seed_catalog_world(session)

    alice_client = make_authed_client(_USER_ALICE, session)
    dave_client = make_authed_client(_USER_DAVE, session)

    # Owner publishes the catalog.
    publish = alice_client.put(
        f"/v1/projects/{_PROJECT_A}/task-catalog", json={"tasks": [_CATALOG_TASK]}
    )
    assert publish.status_code == 200, publish.text

    # Member reads it successfully.
    read = dave_client.get(f"/v1/projects/{_PROJECT_A}/task-catalog")
    assert read.status_code == 200
    assert read.json()["catalog_digest"].startswith("sha256:")

    # Plain member may NOT replace the catalog.
    denied = dave_client.put(
        f"/v1/projects/{_PROJECT_A}/task-catalog", json={"tasks": [_CATALOG_TASK]}
    )
    assert denied.status_code == 403


def test_task_catalog_publish_is_opaque_to_outsider(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """A B-outsider cannot replace A's Task Catalog."""
    _seed_catalog_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.put(
        f"/v1/projects/{_PROJECT_A}/task-catalog", json={"tasks": [_CATALOG_TASK]}
    )
    assert resp.status_code in (403, 404)


def test_task_catalog_denies_cross_project_api_key(
    session: Session, make_api_key_client: Callable[..., TestClient]
) -> None:
    """Carol administers A and B, but her B-bound key cannot touch A's catalog."""
    _seed_catalog_world(session)
    _make_user(session, _USER_CAROL)
    _add_membership(session, _PROJECT_A, _USER_CAROL, role="admin")
    _add_membership(session, _PROJECT_B, _USER_CAROL, role="admin")

    b_key_client = make_api_key_client(_USER_CAROL, _PROJECT_B, session)
    read = b_key_client.get(f"/v1/projects/{_PROJECT_A}/task-catalog")
    assert read.status_code in (403, 404)
    publish = b_key_client.put(
        f"/v1/projects/{_PROJECT_A}/task-catalog", json={"tasks": [_CATALOG_TASK]}
    )
    assert publish.status_code in (403, 404)


# ---------------------------------------------------------------------------
# Test 26: Annotation/member/API-key management respects key binding
# ---------------------------------------------------------------------------


def _seed_carol_world(session: Session) -> None:
    """Carol administers A and B; a key is minted for each Project."""
    _make_user(session, _USER_CAROL)
    _seed_http_world(session)  # Alice owns A, Bob owns B
    _add_membership(session, _PROJECT_A, _USER_CAROL, role="admin")
    _add_membership(session, _PROJECT_B, _USER_CAROL, role="admin")
    _mint_api_key(session, _PROJECT_B, creator_id=_USER_BOB, key_id="key-b")


def test_api_key_cannot_manage_other_projects_members(
    session: Session, make_authed_client: Callable[..., TestClient], make_api_key_client: Callable[..., TestClient]
) -> None:
    """Carol's A-bound key cannot list/add/remove B's members even though
    Carol is a B admin — while her browser session retains B behavior."""
    from collections.abc import Callable

    _seed_carol_world(session)

    carol_session = make_authed_client(_USER_CAROL, session)
    a_key_client = make_api_key_client(_USER_CAROL, _PROJECT_A, session)

    # Session positive control: Carol (B admin) can list B's members.
    assert carol_session.get(f"/v1/projects/{_PROJECT_B}/members").status_code == 200

    # The A-bound key is denied on B in every direction.
    assert (
        a_key_client.get(f"/v1/projects/{_PROJECT_B}/members").status_code == 403
    )
    add = a_key_client.post(
        f"/v1/projects/{_PROJECT_B}/members",
        json={"email": "mallory@test", "role": "admin"},
    )
    assert add.status_code == 403
    assert (
        a_key_client.delete(f"/v1/projects/{_PROJECT_B}/members/{_USER_BOB}").status_code
        == 403
    )
    # B's membership table is unchanged.
    from apo.services.project_memberships import list_memberships_for_project

    member_ids = {m.user_id for m in list_memberships_for_project(session, _PROJECT_B)}
    assert "mallory@test" not in member_ids
    assert _USER_BOB in member_ids


def test_api_key_cannot_manage_other_projects_keys(
    session: Session, make_authed_client: Callable[..., TestClient], make_api_key_client: Callable[..., TestClient]
) -> None:
    """Carol's A-bound key cannot list, mint, or revoke B's API keys."""
    from collections.abc import Callable

    _seed_carol_world(session)

    carol_session = make_authed_client(_USER_CAROL, session)
    a_key_client = make_api_key_client(_USER_CAROL, _PROJECT_A, session)

    # Session positive control: Carol (B admin) can list B's keys.
    assert (
        carol_session.get(f"/v1/api-keys?project={_PROJECT_B}").status_code == 200
    )

    # The A-bound key is denied on B's keys in every direction.
    assert a_key_client.get(f"/v1/api-keys?project={_PROJECT_B}").status_code == 403
    mint = a_key_client.post(
        "/v1/api-keys", json={"name": "evil", "project": _PROJECT_B}
    )
    assert mint.status_code == 403
    assert (
        a_key_client.delete(f"/v1/api-keys/key-b").status_code in (403, 404)
    )
    # key-b still exists.
    assert session.get(ApiKeyDB, "key-b") is not None


# ---------------------------------------------------------------------------
# Test 27: Model-pricing overrides cannot be moved across Projects
# ---------------------------------------------------------------------------

_MODEL_DOC_A = {
    "project": _PROJECT_A,
    "match_pattern": r"(?i)^move-test-model$",
    "provider": "openai",
    "display_name": "Move Test Model",
    "pricing_tiers": [
        {"name": "default", "is_default": True, "priority": 0, "conditions": [],
         "prices": {"input": 2.5, "output": 10.0}}
    ],
}


def test_model_replace_cannot_move_row_to_other_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """An A-admin replacing an A model row cannot re-target it at Project B.

    A and B overrides never cross. The PUT body's
    ``project`` is not allowed to move ownership of an existing row.
    """
    from collections.abc import Callable

    from apo.models.pricing import ModelRowDB

    _seed_http_world(session)

    alice_client = make_authed_client(_USER_ALICE, session)
    created = alice_client.post("/api/v1/models", json=_MODEL_DOC_A).json()
    model_id = created["id"]

    hostile = {**_MODEL_DOC_A, "project": _PROJECT_B}
    resp = alice_client.put(f"/api/v1/models/{model_id}", json=hostile)
    assert resp.status_code == 409  # a row's Project cannot be re-targeted

    row = session.get(ModelRowDB, model_id)
    assert row is not None
    assert row.project == _PROJECT_A  # row was not moved into B


# ---------------------------------------------------------------------------
# Test 25: Comments derive Project from their target
# ---------------------------------------------------------------------------


_TRACE_A_SENTINEL = "trace-comment-a"


def _seed_comment_world(session: Session) -> None:
    from apo.models.db import RunDB

    now = datetime.now(timezone.utc)
    _make_user(session, _USER_DAVE)
    _seed_http_world(session)
    _add_membership(session, _PROJECT_A, _USER_DAVE, role="member")
    session.add(
        RunDB(
            id=_TRACE_A_SENTINEL,
            project=_PROJECT_A,
            task_id="evals/comments",
            flow_name="flow-a",
            version="1",
            created_at=now,
        )
    )
    session.commit()


def test_comment_create_cannot_lie_about_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """Bob (B member) comments on A's trace with body ``project_id=B``.

    The target's ownership resolves to A — the body
    value cannot authorize, and the comment must not be created.
    """
    _seed_comment_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.post(
        "/api/v1/comments",
        json={
            "object_id": _TRACE_A_SENTINEL,
            "object_type": "trace",
            "content": "forged comment",
            "project_id": _PROJECT_B,
        },
    )
    assert resp.status_code in (403, 404)

    from apo.models.db import CommentDB

    forged = session.exec(
        select(CommentDB).where(CommentDB.object_id == _TRACE_A_SENTINEL)
    ).first()
    assert forged is None


def test_comment_delete_is_author_or_admin(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """A plain member cannot delete another member's comment; the author
    and project admins can."""
    from collections.abc import Callable

    from apo.models.db import CommentDB

    _seed_comment_world(session)

    alice_client = make_authed_client(_USER_ALICE, session)
    dave_client = make_authed_client(_USER_DAVE, session)

    created = alice_client.post(
        "/api/v1/comments",
        json={
            "object_id": _TRACE_A_SENTINEL,
            "object_type": "trace",
            "content": "alice's comment",
            "project_id": _PROJECT_A,
        },
    )
    assert created.status_code == 201, created.text
    comment_id = created.json()["id"]

    # Dave is a member of A but not the author — denied.
    assert dave_client.delete(f"/api/v1/comments/{comment_id}").status_code == 403
    assert session.get(CommentDB, comment_id) is not None

    # The author succeeds.
    assert alice_client.delete(f"/api/v1/comments/{comment_id}").status_code == 204
    assert session.get(CommentDB, comment_id) is None


# ---------------------------------------------------------------------------
# Test 24: Score configs are Project-scoped on unfiltered lists
# ---------------------------------------------------------------------------


def test_score_config_list_excludes_other_projects(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """An unscoped score-config list never returns another Project's configs."""
    from collections.abc import Callable

    from apo.models.db import ScoreConfigDB

    _seed_http_world(session)

    now = datetime.now(timezone.utc)
    for pid in (_PROJECT_A, _PROJECT_B):
        session.add(
            ScoreConfigDB(
                name=f"config-{pid}",
                project=pid,
                description=None,
                data_type="NUMERIC",
                is_archived=False,
                created_at=now,
                updated_at=now,
            )
        )
    session.commit()

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.get("/api/v1/score-configs")
    assert resp.status_code == 200
    names = {c["name"] for c in resp.json()}
    assert f"config-{_PROJECT_B}" in names
    assert f"config-{_PROJECT_A}" not in names


# ---------------------------------------------------------------------------
# Scene: Project task inventory files and definition source stay isolated
# ---------------------------------------------------------------------------


def test_project_task_files_require_membership(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """A B-outsider cannot list A's project-scoped task files."""
    _seed_http_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.get(f"/v1/projects/{_PROJECT_A}/agent-tasks/some-task/files")
    assert resp.status_code in (403, 404)


def test_task_definition_source_denies_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """A B-outsider cannot read source through A's Task Run."""
    _seed_http_world(session)

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.get(
        "/v1/task-definition-source",
        params={"task_run_id": _RUN_A, "file_path": "task.py"},
    )
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# Test 31: Registered-route audit has no unclassified Project surface
# ---------------------------------------------------------------------------

# Every apo.routes.* module that registers routes on the real FastAPI app,
# classified by authorization category:
#
# - "project":   Project-owned data — requires canonical guard + at least one
#                cross-Project scene test (named here; verified to exist).
# - "capability": exact credential-binding routes (Attempt/Executor/service
#                tokens, OTLP ingestion) — project comes from the credential.
# - "operator":  installation-admin credential, never implicit Project access.
# - "public":    auth/health/demo surfaces with no Project-owned data.
#
# A test failure here means a route module was added, removed, or renamed
# without classifying it — extend this inventory and add the named scene
# test before landing the new surface.
_ROUTE_MODULE_AUDIT: dict[str, tuple[str, list[tuple[str, str]]]] = {
    "admin": ("operator", []),
    "agent_task_deliverables": (
        "project",
        [("tests/test_project_authorization_boundary.py", "test_deliverable_list_requires_project_access")],
    ),
    "agent_task_files": (
        "project",
        [("tests/test_project_authorization_boundary.py", "test_project_task_files_require_membership")],
    ),
    "agent_task_judgments": (
        "project",
        [("tests/test_project_authorization_boundary.py", "test_run_judgments_are_opaque_cross_project")],
    ),
    "agent_task_test_result_corrections": (
        "project",
        [
            (
                "tests/test_test_result_correction_routes.py",
                "test_cross_project_caller_gets_opaque_404",
            ),
            (
                "tests/test_test_result_correction_routes.py",
                "test_ingest_key_rejected",
            ),
            (
                "tests/test_test_result_correction_routes.py",
                "test_service_token_rejected",
            ),
        ],
    ),
    "agent_task_runs": (
        "project",
        [
            ("tests/test_project_authorization_boundary.py", "test_task_run_list_does_not_cross_projects"),
            ("tests/test_project_authorization_boundary.py", "test_task_run_detail_is_opaque_cross_project"),
            (
                "tests/test_boundary_final_gaps.py",
                "test_cross_project_session_report_is_opaque",
            ),
        ],
    ),
    "agent_task_schedules": (
        "project",
        [
            ("tests/test_project_authorization_boundary.py", "test_schedule_list_does_not_cross_projects"),
            ("tests/test_project_authorization_boundary.py", "test_schedule_detail_is_opaque_cross_project"),
        ],
    ),
    "agent_task_trace_projection": ("capability", []),
    "agent_task_views": (
        "project",
        [
            ("tests/test_task_view_comparison.py", "test_comparison_requires_membership"),
            (
                "tests/test_boundary_final_gaps.py",
                "test_key_cannot_read_foreign_project_views",
            ),
        ],
    ),
    "analytics": (
        "project",
        [("tests/test_project_authorization_boundary.py", "test_analytics_search_denies_cross_project")],
    ),
    "api_keys": (
        "project",
        [("tests/test_project_authorization_boundary.py", "test_api_key_cannot_manage_other_projects_keys")],
    ),
    "auth": ("public", []),
    "comments": (
        "project",
        [
            ("tests/test_project_authorization_boundary.py", "test_comment_create_cannot_lie_about_project"),
            ("tests/test_project_authorization_boundary.py", "test_comment_delete_is_author_or_admin"),
        ],
    ),
    # Dev-only sign-in: an authentication surface gated by an
    # explicit opt-in flag enforced in the backend, with its own suite
    # (tests/test_dev_signin.py). Not a Project-owned surface.
    "dev_signin": ("public", []),
    "hosted_access": (
        "project",
        [
            (
                "tests/test_hosted_access_invitations.py",
                "test_project_api_key_cannot_issue_even_from_admin_creator",
            ),
            (
                "tests/test_hosted_access_invitations.py",
                "test_invitee_cannot_read_company_project",
            ),
        ],
    ),
    "executor_pools": (
        "project",
        [
            ("tests/test_project_authorization_boundary.py", "test_connected_executor_bootstrap_requires_membership"),
            ("tests/test_executor_management.py", "test_cross_project_pool_operations_opaque"),
        ],
    ),
    "executor_protocol": ("capability", []),
    "executor_protocol_v2": ("capability", []),
    "health": ("public", []),
    "ingestion": (
        "project",
        [
            (
                "tests/test_ingestion_project_boundary.py",
                "test_api_key_cannot_ingest_into_unbound_project",
            )
        ],
    ),
    "langfuse_public": (
        "project",
        [
            (
                "tests/test_ingestion_project_boundary.py",
                "test_traces_list_is_credential_scoped",
            )
        ],
    ),
    "models": (
        "project",
        [("tests/test_project_authorization_boundary.py", "test_model_replace_cannot_move_row_to_other_project")],
    ),
    "otlp_traces": ("capability", []),
    "project_members": (
        "project",
        [("tests/test_project_authorization_boundary.py", "test_api_key_cannot_manage_other_projects_members")],
    ),
    "project_model_prefs": (
        "project",
        [
            ("tests/test_archived_models.py", "test_non_member_cannot_archive"),
            (
                "tests/test_archived_models.py",
                "test_archiving_does_not_leak_across_projects",
            ),
        ],
    ),
    "projects": (
        "project",
        [
            ("tests/test_project_authorization_boundary.py", "test_task_catalog_read_requires_membership"),
            ("tests/test_project_authorization_boundary.py", "test_task_catalog_member_read_and_admin_publish"),
            (
                "tests/test_boundary_final_gaps.py",
                "test_key_cannot_reset_or_delete_foreign_project",
            ),
        ],
    ),
    "run_events": (
        "project",
        [("tests/test_project_authorization_boundary.py", "test_run_event_sse_denies_cross_project")],
    ),
    "runs": (
        "project",
        [
            ("tests/test_project_authorization_boundary.py", "test_trace_bookmark_denies_cross_project"),
            ("tests/test_project_authorization_boundary.py", "test_run_update_denies_cross_project"),
            ("tests/test_project_authorization_boundary.py", "test_run_bulk_delete_denies_cross_project"),
        ],
    ),
    "scores": (
        "project",
        [("tests/test_project_authorization_boundary.py", "test_score_config_list_excludes_other_projects")],
    ),
    "system_runtime": ("operator", []),
    "task_definition_sources": (
        "project",
        [("tests/test_project_authorization_boundary.py", "test_task_definition_source_denies_cross_project")],
    ),
    "trace_stream": (
        "project",
        [("tests/test_project_authorization_boundary.py", "test_trace_sse_denies_cross_project")],
    ),
    "webhooks": (
        "project",
        [("tests/test_webhooks.py", "test_isolation_between_projects")],
    ),
}


def test_registered_route_modules_are_fully_audited() -> None:
    """Every apo.routes module with registered routes is classified here.

    Fails when a route module is added without a classification, or when
    a classified module no longer registers routes (stale inventory).
    """
    from apo.api import app

    registered: set[str] = set()
    for route in app.routes:
        endpoint = getattr(route, "endpoint", None)
        module = getattr(endpoint, "__module__", "")
        parts = module.split(".")
        if module.startswith("apo.routes") and len(parts) > 2:
            registered.add(parts[2])

    assert registered == set(_ROUTE_MODULE_AUDIT.keys()), (
        "Registered route modules and the route audit inventory differ.\n"
        f"  unclassified (must classify + add scene tests): {sorted(registered - set(_ROUTE_MODULE_AUDIT))}\n"
        f"  stale entries (module no longer registers routes): {sorted(set(_ROUTE_MODULE_AUDIT) - registered)}"
    )


def test_project_owned_modules_have_cross_project_scene_tests() -> None:
    """Every 'project'-classified module references scene tests that exist.

    Each referenced test file must exist and contain the named test —
    renaming or deleting a scene test without updating the inventory fails
    loudly instead of silently losing cross-Project coverage.
    """
    from pathlib import Path

    backend_root = Path(__file__).resolve().parent.parent

    for module, (category, scene_tests) in _ROUTE_MODULE_AUDIT.items():
        if category != "project":
            continue
        assert scene_tests, (
            f"Module apo.routes.{module} is Project-owned but lists no "
            "cross-Project scene test — add one before landing."
        )
        for file_name, test_name in scene_tests:
            test_file = backend_root / file_name
            assert test_file.exists(), f"Scene test file missing: {file_name}"
            source = test_file.read_text()
            assert f"def {test_name}(" in source, (
                f"Scene test {test_name} not found in {file_name} — "
                "update the route audit inventory."
            )


# ---------------------------------------------------------------------------
# Scenes 28-30: Project deletion removes rows AND bytes, is retry-safe on
# ArtifactStore failure, and outsiders cannot trigger it
# ---------------------------------------------------------------------------

_DELIV_KEY = "deliverables/run-del-bytes/report.json"
_BUNDLE_KEY = "task-revisions/rev-del-bytes/bundle.tar"


def _seed_project_with_bytes(
    session: Session, tmp_path: Any
) -> LocalArtifactStore:
    """Seed Project A with a file Deliverable and a Task Revision bundle,
    both backed by a real LocalArtifactStore under ``tmp_path``."""
    from apo.models.db import TaskRevisionDB

    store = LocalArtifactStore(root=tmp_path / "store")
    _seed_http_world(session)  # Alice owns A, Bob owns B (+ one run each)

    session.add(
        AgentTaskBatchRunDB(
            id="batch-bytes", project=_PROJECT_A, created_at=datetime.now(timezone.utc),
            status="completed", total_tasks=1, task_root="/t", environment="default",
            selection_type="task",
        )
    )
    session.flush()
    session.add(
        AgentTaskRunDB(
            id="run-del-bytes", batch_run_id="batch-bytes", task_id="evals/bytes",
            task_path="/t/evals/bytes", status="passed", pass_result=True,
            started_at=datetime.now(timezone.utc), completed_at=datetime.now(timezone.utc),
        )
    )
    session.flush()
    session.add(
        AgentTaskDeliverableDB(
            id="del-bytes", task_run_id="run-del-bytes", project=_PROJECT_A,
            name="report", kind="artifact", status="ready",
            storage_backend="local", storage_key=_DELIV_KEY,
            media_type="application/json", size_bytes=9, sha256="b" * 64,
            created_at=datetime.now(timezone.utc),
        )
    )
    session.add(
        TaskRevisionDB(
            project=_PROJECT_A,
            batch_run_id="batch-bytes",
            materialization="bundled",
            source_type="source",
            content_sha256="c" * 64,
            file_count=1,
            uncompressed_size_bytes=10,
            manifest_summary_json={},
            bundle_storage_backend="local",
            bundle_storage_key=_BUNDLE_KEY,
        )
    )
    session.commit()

    import asyncio
    import hashlib

    async def _put(key: str, data: bytes) -> None:
        async def chunks() -> AsyncIterator[bytes]:
            yield data

        await store.put(
            key,
            chunks(),
            expected_size=len(data),
            expected_sha256=hashlib.sha256(data).hexdigest(),
        )

    asyncio.run(_put(_DELIV_KEY, b"sentinel"))
    asyncio.run(_put(_BUNDLE_KEY, b"bundle-bytes"))
    return store


class _FlakyStore:
    """Wraps a store, failing ``delete`` for the given keys while armed."""

    def __init__(self, inner: LocalArtifactStore, fail_keys: set[str]) -> None:
        self._inner = inner
        self._fail_keys = fail_keys
        self.armed = True

    async def delete(self, key: str) -> None:
        if self.armed and key in self._fail_keys:
            raise RuntimeError(f"simulated store failure for {key}")
        await self._inner.delete(key)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def _patch_stores(
    monkeypatch: pytest.MonkeyPatch, store: Any
) -> None:
    monkeypatch.setattr("apo.services.retention.get_store", lambda backend, **kw: store)
    monkeypatch.setattr("apo.services.task_revisions.get_store", lambda backend, **kw: store)


def test_project_deletion_removes_rows_and_bytes(
    session: Session,
    make_authed_client: Callable[..., TestClient],
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Scene 28: deletion removes the Project's rows AND stored objects;
    Project B and its data remain."""
    from apo.models.db import ProjectDB, TaskRevisionDB

    store = _seed_project_with_bytes(session, tmp_path)
    _patch_stores(monkeypatch, store)

    alice_client = make_authed_client(_USER_ALICE, session)
    resp = alice_client.delete(f"/v1/projects/{_PROJECT_A}")
    assert resp.status_code == 200, resp.text

    # Relational rows are gone for A, kept for B.
    assert session.get(ProjectDB, _PROJECT_A) is None
    assert session.get(AgentTaskDeliverableDB, "del-bytes") is None
    assert (
        session.exec(
            select(TaskRevisionDB).where(TaskRevisionDB.project == _PROJECT_A)
        ).first()
        is None
    )
    assert session.get(ProjectDB, _PROJECT_B) is not None
    assert session.get(AgentTaskRunDB, _RUN_B) is not None

    # The stored objects themselves are gone.
    assert not (tmp_path / "store" / "objects" / _DELIV_KEY).exists()
    assert not (tmp_path / "store" / "objects" / _BUNDLE_KEY).exists()


def test_project_deletion_is_retry_safe_on_deliverable_store_failure(
    session: Session,
    make_authed_client: Callable[..., TestClient],
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Scene 29: a store failure on one object returns a retryable 503 with
    relational ownership retained; after the store recovers, retry succeeds."""
    from apo.models.db import ProjectDB

    store = _seed_project_with_bytes(session, tmp_path)
    flaky = _FlakyStore(store, {_DELIV_KEY})
    _patch_stores(monkeypatch, flaky)

    alice_client = make_authed_client(_USER_ALICE, session)
    resp = alice_client.delete(f"/v1/projects/{_PROJECT_A}")
    assert resp.status_code == 503, resp.text
    # Bounded detail only — no object keys or paths leak.
    assert _DELIV_KEY not in resp.text

    # Relational ownership survives for retry.
    assert session.get(ProjectDB, _PROJECT_A) is not None
    assert session.get(AgentTaskDeliverableDB, "del-bytes") is not None
    assert session.get(AgentTaskRunDB, "run-del-bytes") is not None
    assert (tmp_path / "store" / "objects" / _DELIV_KEY).exists()

    # Store recovers → retry succeeds and removes everything.
    flaky.armed = False
    retry = alice_client.delete(f"/v1/projects/{_PROJECT_A}")
    assert retry.status_code == 200, retry.text
    assert session.get(ProjectDB, _PROJECT_A) is None
    assert not (tmp_path / "store" / "objects" / _DELIV_KEY).exists()
    assert not (tmp_path / "store" / "objects" / _BUNDLE_KEY).exists()


def test_project_deletion_is_retry_safe_on_bundle_store_failure(
    session: Session,
    make_authed_client: Callable[..., TestClient],
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Scene 29 (bundle variant): a failing Task Revision bundle store must
    NOT be swallowed — rows are retained instead of orphaning the bytes."""
    from apo.models.db import ProjectDB, TaskRevisionDB

    store = _seed_project_with_bytes(session, tmp_path)
    flaky = _FlakyStore(store, {_BUNDLE_KEY})
    _patch_stores(monkeypatch, flaky)

    alice_client = make_authed_client(_USER_ALICE, session)
    resp = alice_client.delete(f"/v1/projects/{_PROJECT_A}")
    assert resp.status_code == 503, resp.text

    # Rows retained — the bundle object is not orphaned.
    assert session.get(ProjectDB, _PROJECT_A) is not None
    assert (
        session.exec(
            select(TaskRevisionDB).where(TaskRevisionDB.project == _PROJECT_A)
        ).first()
        is not None
    )
    assert (tmp_path / "store" / "objects" / _BUNDLE_KEY).exists()

    flaky.armed = False
    retry = alice_client.delete(f"/v1/projects/{_PROJECT_A}")
    assert retry.status_code == 200, retry.text
    assert not (tmp_path / "store" / "objects" / _BUNDLE_KEY).exists()


def test_outsider_cannot_delete_or_reset_project(
    session: Session,
    make_authed_client: Callable[..., TestClient],
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Scene 30: a non-member is denied before any object or row cleanup."""
    from apo.models.db import ProjectDB

    store = _seed_project_with_bytes(session, tmp_path)
    _patch_stores(monkeypatch, store)

    bob_client = make_authed_client(_USER_BOB, session)
    delete_resp = bob_client.delete(f"/v1/projects/{_PROJECT_A}")
    reset_resp = bob_client.post(f"/v1/projects/{_PROJECT_A}/reset-data")
    assert delete_resp.status_code in (403, 404)
    assert reset_resp.status_code in (403, 404)

    # Nothing was removed — rows and bytes intact.
    assert session.get(ProjectDB, _PROJECT_A) is not None
    assert session.get(AgentTaskDeliverableDB, "del-bytes") is not None
    assert (tmp_path / "store" / "objects" / _DELIV_KEY).exists()
    assert (tmp_path / "store" / "objects" / _BUNDLE_KEY).exists()


# ---------------------------------------------------------------------------
# Scene 22 (full): every runs/* mutation denies cross-Project access
# ---------------------------------------------------------------------------

_CALL_A = "call-correction-a"


def _seed_runs_mutation_world(session: Session) -> None:
    """A trace + logged call in Project A (on top of the HTTP world)."""
    from apo.models.db import LoggedCallDB

    now = datetime.now(timezone.utc)
    _seed_trace_world(session)  # Alice owns A, Bob owns B, RunDB trace-http-a in A
    session.add(
        LoggedCallDB(
            id=_CALL_A,
            project=_PROJECT_A,
            model="gpt-4",
            task_id="evals/trace-task",
            run_id=_TRACE_A,
            flow_name="test-flow",
            created_at=now,
            input={},
            messages=[],
            output={},
            step_index=0,
        )
    )
    session.commit()


def test_run_update_denies_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    from apo.models.db import RunDB

    _seed_runs_mutation_world(session)
    bob_client = make_authed_client(_USER_BOB, session)

    resp = bob_client.patch(f"/v1/runs/{_TRACE_A}", json={"completed": True})
    assert resp.status_code in (403, 404)

    run = session.exec(select(RunDB).where(RunDB.id == _TRACE_A)).first()
    assert run is not None
    assert run.completed_at is None  # A's trace unchanged


def test_run_custom_metrics_denies_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    from apo.models.db import RunMetricDB

    _seed_runs_mutation_world(session)
    bob_client = make_authed_client(_USER_BOB, session)

    resp = bob_client.post(
        f"/v1/runs/{_TRACE_A}/custom-metrics",
        json={"metrics": [{"name": "forged", "score": 1.0}]},
    )
    assert resp.status_code in (403, 404)

    forged = session.exec(
        select(RunMetricDB).where(RunMetricDB.run_id == _TRACE_A)
    ).first()
    assert forged is None


def test_run_correction_denies_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    from apo.models.db import LoggedCallDB

    _seed_runs_mutation_world(session)
    bob_client = make_authed_client(_USER_BOB, session)

    # Honest project value: membership check denies.
    resp = bob_client.patch(
        f"/v1/runs/{_TRACE_A}/calls/{_CALL_A}/correction",
        params={"project": _PROJECT_A},
        json={"corrected_output": "forged"},
    )
    assert resp.status_code in (403, 404)

    # Lying project value: the run is looked up in the claimed Project and
    # is simply not found.
    lying = bob_client.patch(
        f"/v1/runs/{_TRACE_A}/calls/{_CALL_A}/correction",
        params={"project": _PROJECT_B},
        json={"corrected_output": "forged"},
    )
    assert lying.status_code == 404

    call = session.exec(
        select(LoggedCallDB).where(LoggedCallDB.id == _CALL_A)
    ).first()
    assert call is not None
    assert call.corrected_output is None


def test_run_bulk_delete_denies_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    from apo.models.db import RunDB

    _seed_runs_mutation_world(session)
    bob_client = make_authed_client(_USER_BOB, session)

    resp = bob_client.post(
        "/v1/runs/bulk-delete",
        params={"project": _PROJECT_A},
        json={"run_ids": [_TRACE_A]},
    )
    assert resp.status_code in (403, 404)
    assert (
        session.exec(select(RunDB).where(RunDB.id == _TRACE_A)).first() is not None
    )


def test_run_bulk_export_denies_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed_runs_mutation_world(session)
    bob_client = make_authed_client(_USER_BOB, session)

    resp = bob_client.post(
        "/v1/runs/bulk-export",
        params={"project": _PROJECT_A},
        json={"run_ids": [_TRACE_A], "format": "json"},
    )
    assert resp.status_code in (403, 404)
    assert _TRACE_A not in resp.text  # no sentinel A content exported


def test_run_reproject_denies_cross_project(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed_runs_mutation_world(session)
    bob_client = make_authed_client(_USER_BOB, session)

    resp = bob_client.post(f"/v1/runs/{_TRACE_A}/reproject", params={"project": _PROJECT_A})
    assert resp.status_code in (403, 404)


# ---------------------------------------------------------------------------
# Scene 6: a misleading caller Project value cannot redirect ownership
# ---------------------------------------------------------------------------


def test_task_run_detail_ignores_caller_project_value(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """Bob requests A's run while claiming ``project=B`` — the Project is
    derived through the Batch, so the claim is ignored and access denied."""
    _seed_http_world(session)
    bob_client = make_authed_client(_USER_BOB, session)

    resp = bob_client.get(f"/v1/agent-task-runs/{_RUN_A}", params={"project": _PROJECT_B})
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Scene 20/21 (spy): SSE denial happens BEFORE any broadcaster access
# ---------------------------------------------------------------------------


def test_run_event_sse_denies_before_broadcaster_access(
    session: Session,
    make_authed_client: Callable[..., TestClient],
    monkeypatch: Any,
) -> None:
    """Cross-Project run-event SSE denial must not touch the broadcaster."""
    _seed_http_world(session)
    touched = {"broadcaster": False}

    async def _spy_broadcaster() -> Any:
        touched["broadcaster"] = True
        raise AssertionError("broadcaster must not be accessed on denial")

    monkeypatch.setattr(
        "apo.routes.run_events.get_run_event_broadcaster", _spy_broadcaster
    )

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.get(f"/v1/events?project={_PROJECT_A}")
    assert resp.status_code in (403, 404)
    assert touched["broadcaster"] is False


def test_trace_sse_denies_before_broadcaster_access(
    session: Session,
    make_authed_client: Callable[..., TestClient],
    monkeypatch: Any,
) -> None:
    """Cross-Project trace SSE denial must not touch the broadcaster."""
    _seed_http_world(session)
    touched = {"broadcaster": False}

    async def _spy_broadcaster() -> Any:
        touched["broadcaster"] = True
        raise AssertionError("broadcaster must not be accessed on denial")

    monkeypatch.setattr(
        "apo.routes.trace_stream.get_trace_broadcaster", _spy_broadcaster
    )

    bob_client = make_authed_client(_USER_BOB, session)
    resp = bob_client.get(f"/v1/traces/some-trace/stream?project={_PROJECT_A}")
    assert resp.status_code in (403, 404)
    assert touched["broadcaster"] is False


# ---------------------------------------------------------------------------
# Audit leftovers: source-read API-key scope; session score-create authority
# ---------------------------------------------------------------------------


def _seed_definition_source_world(session: Session) -> str:
    """Project A with a run pinned to a definition revision containing source."""
    from apo.models.db import TaskDefinitionRevisionDB

    _seed_http_world(session)
    revision = TaskDefinitionRevisionDB(
        project=_PROJECT_A,
        task_id=_TASK_ID_A,
        content_sha256="d" * 64,
        source_files_json=[
            {"path": "task.py", "content": "sentinel-source-content"}
        ],
        source_size_bytes=23,
    )
    session.add(revision)
    session.flush()
    run = session.get(AgentTaskRunDB, _RUN_A)
    assert run is not None
    run.task_definition_revision_id = revision.id
    session.commit()
    return revision.id or ""


def test_task_definition_source_denies_ingest_scope_key(
    session: Session, make_api_key_client: Callable[..., TestClient]
) -> None:
    """The source reader is documented as full-scope only: an ingest key
    bound to the right Project with a member creator still may not read
    eval source code."""
    _seed_definition_source_world(session)

    full_key = make_api_key_client(_USER_ALICE, _PROJECT_A, session, scope="full")
    ingest_key = make_api_key_client(_USER_ALICE, _PROJECT_A, session, scope="ingest")

    ok = full_key.get(
        "/v1/task-definition-source",
        params={"task_run_id": _RUN_A, "file_path": "task.py"},
    )
    assert ok.status_code == 200, ok.text
    assert "sentinel-source-content" in ok.text

    denied = ingest_key.get(
        "/v1/task-definition-source",
        params={"task_run_id": _RUN_A, "file_path": "task.py"},
    )
    assert denied.status_code == 403


def test_session_score_create_derives_project_from_target(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """A dashboard session creating a score is authorized against the
    target trace's Project — members succeed, outsiders are denied. The
    credential-less fallback to the literal ``default`` Project is gone."""
    from apo.models.db import RunMetricDB

    _seed_trace_world(session)  # RunDB trace-http-a in Project A

    alice_client = make_authed_client(_USER_ALICE, session)
    bob_client = make_authed_client(_USER_BOB, session)

    created = alice_client.post(
        f"/api/v1/traces/{_TRACE_A}/scores",
        json={"name": "quality", "value": 5, "data_type": "NUMERIC"},
    )
    assert created.status_code == 200, created.text

    denied = bob_client.post(
        f"/api/v1/traces/{_TRACE_A}/scores",
        json={"name": "quality", "value": 1, "data_type": "NUMERIC"},
    )
    assert denied.status_code in (403, 404)

    # The score landed in the trace's Project, not the literal "default".
    rows = session.exec(
        select(RunMetricDB).where(RunMetricDB.run_id == _TRACE_A)
    ).all()
    assert len(rows) == 1
    assert rows[0].project == _PROJECT_A


# ---------------------------------------------------------------------------
# Caller result deliverables persist as rows
# ---------------------------------------------------------------------------


def test_result_submission_persists_inline_json_as_rows(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """The caller-execution result's inline JSON deliverables persist as
    AgentTaskDeliverableDB rows (canonical storage) — not only into the
    legacy ``deliverables_json`` column."""
    from apo.models.db import AgentTaskDeliverableDB

    now = datetime.now(timezone.utc)
    _seed_http_world(session)
    # A non-terminal run in Project A (the seeded runs are terminal).
    session.add(
        AgentTaskRunDB(
            id="run-live-result", batch_run_id=_BATCH_A, task_id="evals/live",
            task_path="/t/evals/live", status="running",
            started_at=now,
        )
    )
    session.commit()

    alice_client = make_authed_client(_USER_ALICE, session)
    resp = alice_client.post(
        "/v1/agent-task-runs/run-live-result/result",
        json={
            "pass_result": True,
            "adapter_name": "real-agent",
            "deliverables": {"report": {"answer": 42}},
        },
    )
    assert resp.status_code == 200, resp.text

    row = session.exec(
        select(AgentTaskDeliverableDB).where(
            AgentTaskDeliverableDB.task_run_id == "run-live-result",
            AgentTaskDeliverableDB.name == "report",
        )
    ).first()
    assert row is not None
    assert row.kind == "json"
    assert row.status == "ready"
    assert row.project == _PROJECT_A
    assert row.inline_value_json == {"value": {"answer": 42}}


def test_result_deliverables_response_derived_from_rows(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """After a caller result, the detail response's
    ``deliverables_json`` field is derived from the persisted rows while
    the legacy column stays NULL; historical rows with the column set
    keep returning the column value."""
    from apo.models.db import AgentTaskDeliverableDB

    now = datetime.now(timezone.utc)
    _seed_http_world(session)
    session.add(
        AgentTaskRunDB(
            id="run-p2", batch_run_id=_BATCH_A, task_id="evals/p2",
            task_path="/t/evals/p2", status="running", started_at=now,
        )
    )
    session.commit()

    alice_client = make_authed_client(_USER_ALICE, session)
    resp = alice_client.post(
        "/v1/agent-task-runs/run-p2/result",
        json={
            "pass_result": True,
            "adapter_name": "real-agent",
            "deliverables": {"report": {"answer": 42}},
        },
    )
    assert resp.status_code == 200, resp.text

    rows = session.exec(
        select(AgentTaskDeliverableDB).where(
            AgentTaskDeliverableDB.task_run_id == "run-p2"
        )
    ).all()
    assert [r.name for r in rows] == ["report"]

    # The response field is derived from the rows.
    detail = alice_client.get("/v1/agent-task-runs/run-p2").json()
    assert detail["deliverables_json"] == {"report": {"answer": 42}}

    # The result response itself also carries the derived field.
    assert resp.json()["deliverables_json"] == {"report": {"answer": 42}}

