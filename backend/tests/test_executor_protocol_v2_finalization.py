# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUnusedImport=false, reportUnusedParameter=false
# pyright: reportAttributeAccessIssue=false, reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

"""Finalization routes (result / failure) alias the shared path.

Covers the new ``/v1/executor-protocol/v2/attempts/{id}/result`` and
``/failure`` routes that the Connected Executor's ``submitResult`` targets.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.api import app
from apo.db import get_session
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ExecutorDB,
    ProjectDB,
    TaskExecutionAttemptDB,
    UserDB,
)


@pytest.fixture
def isolated_engine(monkeypatch):
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, create_engine

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    import apo.db as db_module

    monkeypatch.setattr(db_module, "engine", engine)
    # create_attempt_jwt fails closed when AUTH_SECRET is unset; the seeded
    # attempt mints a JWT, so set a test secret (mirrors test_executor_auth).
    monkeypatch.setattr("apo.services.executor_auth.AUTH_SECRET", "test-secret")
    return engine


def _seed_leased_attempt(engine, attempt_jwt_sub: str = "att-1") -> tuple[str, str, str]:
    """Seed a leased source-owned Attempt and return (project, attempt_id, jwt)."""
    from apo.services.executor_auth import create_attempt_jwt

    with Session(engine) as s:
        u = UserDB(email="o@t.com", name="O", password_hash="x", is_active=True)
        s.add(u); s.commit(); s.refresh(u)
        s.add(ProjectDB(id="p1", name="P", created_by=u.id)); s.commit()
        batch = AgentTaskBatchRunDB(
            id="bch-1", project="p1", selection_type="tasks", status="queued",
            execution_target_json={"kind": "source_owned"}, created_at=datetime.now(timezone.utc),
        )
        s.add(batch); s.flush()
        run = AgentTaskRunDB(
            id="run-1", batch_run_id="bch-1", task_id="t", task_path="p",
            sequence_index=0, status="pending",
        )
        s.add(run); s.flush()
        attempt = TaskExecutionAttemptDB(
            id="att-1", project="p1", batch_run_id="bch-1", task_run_id="run-1",
            sequence_index=0, target_kind="pool", assignment_kind="source_owned",
            executor_pool_id="pool-1", status="running", phase="running",
            queue_expires_at=datetime.now(timezone.utc) + timedelta(hours=24),
            queued_at=datetime.now(timezone.utc),
            claimed_at=datetime.now(timezone.utc),
            started_at=datetime.now(timezone.utc),
            heartbeat_at=datetime.now(timezone.utc),
            lease_generation=1,
            lease_expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        )
        s.add(attempt); s.commit()
        jwt = create_attempt_jwt(attempt=attempt, lease_generation=1, expires_in_seconds=3600)
        return "p1", "att-1", jwt


def _client(engine) -> TestClient:
    def _sess():
        with Session(engine) as sx:
            yield sx
    app.dependency_overrides[get_session] = _sess
    return TestClient(app)


def test_v2_result_finalizes_attempt(isolated_engine):
    engine = isolated_engine
    _, attempt_id, jwt = _seed_leased_attempt(engine)
    client = _client(engine)
    try:
        resp = client.post(
            f"/v1/executor-protocol/v2/attempts/{attempt_id}/result",
            headers={"Authorization": f"Bearer {jwt}"},
            json={
                "completion_id": "comp-1",
                "pass_result": True,
                "adapter_name": "claude-code",
                "trace_run_id": "tr-1",
            },
        )
        assert resp.status_code == 200, resp.text
        with Session(engine) as s:
            att = s.get(TaskExecutionAttemptDB, attempt_id)
            assert att is not None
            assert att.status == "succeeded"
            assert att.completion_id == "comp-1"
    finally:
        app.dependency_overrides.clear()


def test_v2_result_records_reported_run_configuration(isolated_engine):
    """The executor reports the agent's resolved model/effort with its result.

    Without this the Task Run keeps null configuration columns, so every
    dashboard-triggered Run renders with no Execution label even though the
    adapter reported one.
    """
    engine = isolated_engine
    _, attempt_id, jwt = _seed_leased_attempt(engine)
    client = _client(engine)
    try:
        resp = client.post(
            f"/v1/executor-protocol/v2/attempts/{attempt_id}/result",
            headers={"Authorization": f"Bearer {jwt}"},
            json={
                "completion_id": "comp-1",
                "pass_result": True,
                "adapter_name": "claude-code",
                "trace_run_id": "tr-1",
                "run_configuration": {"model": "claude-opus-5", "effort": "medium"},
            },
        )
        assert resp.status_code == 200, resp.text
        with Session(engine) as s:
            run = s.get(AgentTaskRunDB, "run-1")
            assert run is not None
            assert run.configured_model == "claude-opus-5"
            assert run.configured_effort == "medium"
    finally:
        app.dependency_overrides.clear()


def test_v2_result_without_run_configuration_leaves_it_unset(isolated_engine):
    """Reporting configuration stays optional — adapters may not resolve one."""
    engine = isolated_engine
    _, attempt_id, jwt = _seed_leased_attempt(engine)
    client = _client(engine)
    try:
        resp = client.post(
            f"/v1/executor-protocol/v2/attempts/{attempt_id}/result",
            headers={"Authorization": f"Bearer {jwt}"},
            json={"completion_id": "comp-1", "pass_result": True},
        )
        assert resp.status_code == 200, resp.text
        with Session(engine) as s:
            run = s.get(AgentTaskRunDB, "run-1")
            assert run is not None
            assert run.configured_model is None
            assert run.configured_effort is None
    finally:
        app.dependency_overrides.clear()


def test_v2_failure_finalizes_attempt(isolated_engine):
    engine = isolated_engine
    _, attempt_id, jwt = _seed_leased_attempt(engine)
    client = _client(engine)
    try:
        resp = client.post(
            f"/v1/executor-protocol/v2/attempts/{attempt_id}/failure",
            headers={"Authorization": f"Bearer {jwt}"},
            json={
                "completion_id": "comp-2",
                "failure_kind": "task_runtime",
                "error_message": "boom",
            },
        )
        assert resp.status_code == 200, resp.text
        with Session(engine) as s:
            att = s.get(TaskExecutionAttemptDB, attempt_id)
            assert att is not None
            assert att.status == "failed"
            assert att.failure_kind == "task_runtime"
            # #154: an execution error produced no verdict — the task run
            # must not render as FAIL.
            run = s.get(AgentTaskRunDB, att.task_run_id)
            assert run is not None
            assert run.status == "error"
            assert run.pass_result is None
    finally:
        app.dependency_overrides.clear()


def test_v2_result_invalid_persists_execution_error_not_verdict(isolated_engine):
    """Issue #249: a size-rejected result records as an execution error.

    ``failure_kind="result_invalid"`` with a ``result_too_large:`` message must
    leave the Task Run as ``error`` with no verdict and the diagnostic stored
    verbatim — never a failed capability test, and the run stays inspectable.
    """
    engine = isolated_engine
    _, attempt_id, jwt = _seed_leased_attempt(engine)
    client = _client(engine)
    diagnostic = (
        "result_too_large: total_bytes=11234567 limit_bytes=10485760 "
        "largest_fields=transcript=9000000, checks=2000000, deliverables=100000"
    )
    try:
        resp = client.post(
            f"/v1/executor-protocol/v2/attempts/{attempt_id}/failure",
            headers={"Authorization": f"Bearer {jwt}"},
            json={
                "completion_id": "comp-rl",
                "failure_kind": "result_invalid",
                "error_message": diagnostic,
            },
        )
        assert resp.status_code == 200, resp.text
        with Session(engine) as s:
            att = s.get(TaskExecutionAttemptDB, attempt_id)
            assert att is not None
            assert att.status == "failed"
            assert att.failure_kind == "result_invalid"
            run = s.get(AgentTaskRunDB, att.task_run_id)
            assert run is not None
            assert run.status == "error"
            assert run.pass_result is None
            assert run.error_message == diagnostic
    finally:
        app.dependency_overrides.clear()


def test_v2_result_rejects_wrong_attempt_token(isolated_engine):
    engine = isolated_engine
    _seed_leased_attempt(engine)
    # A token for a *different* attempt id.
    from apo.services.executor_auth import create_attempt_jwt

    with Session(engine) as s:
        other_run = AgentTaskRunDB(
            id="run-2", batch_run_id="bch-1", task_id="t2", task_path="p2",
            sequence_index=1, status="pending",
        )
        s.add(other_run); s.flush()
        other = TaskExecutionAttemptDB(
            id="att-2", project="p1", batch_run_id="bch-1", task_run_id="run-2",
            sequence_index=1, target_kind="pool", assignment_kind="source_owned",
            executor_pool_id="pool-1", status="running",
            queue_expires_at=datetime.now(timezone.utc) + timedelta(hours=24),
            queued_at=datetime.now(timezone.utc), lease_generation=1,
            lease_expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        )
        s.add(other); s.commit()
        bad_jwt = create_attempt_jwt(attempt=other, lease_generation=1, expires_in_seconds=3600)

    client = _client(engine)
    try:
        resp = client.post(
            "/v1/executor-protocol/v2/attempts/att-1/result",
            headers={"Authorization": f"Bearer {bad_jwt}"},
            json={"completion_id": "comp-x", "pass_result": True},
        )
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# shared claim service — capacity, sequential order, isolation
# ---------------------------------------------------------------------------


def _enroll_v2_executor(
    engine,
    *,
    user_id: str,
    pool_id: str,
    name: str,
    online: bool = True,
    max_concurrency: int = 4,
) -> str:
    from apo.models.db import ExecutorDB

    with Session(engine) as s:
        ex = ExecutorDB(
            id="ex_" + name,
            scope_kind="pool",
            project="p1",
            executor_pool_id=pool_id,
            name=name,
            enabled=True,
            credential_prefix="apo_ex_" + name[:8],
            credential_hash="hash-" + name,
            protocol_version=2,
            executor_version="0.1.0",
            enrolled_by_user_id=user_id,
            driver_kinds_json=["source-owned-ts"],
            capabilities_json={"assignment_kinds": ["source_owned"]},
            max_concurrency=max_concurrency,
            last_seen_at=datetime.now(timezone.utc) if online else None,
        )
        s.add(ex); s.commit()
        return ex.id


def _queue_source_owned_attempt(
    engine,
    *,
    attempt_id: str,
    pool_id: str,
    target_user_id: str,
    sequence_index: int = 0,
    run_id: str = "run-1",
) -> None:
    with Session(engine) as s:
        if s.get(AgentTaskRunDB, run_id) is None:
            s.add(AgentTaskRunDB(
                id=run_id, batch_run_id="bch-1", task_id="t", task_path="p",
                sequence_index=sequence_index, status="pending",
            )); s.flush()
        s.add(TaskExecutionAttemptDB(
            id=attempt_id, project="p1", batch_run_id="bch-1", task_run_id=run_id,
            sequence_index=sequence_index, target_kind="pool",
            assignment_kind="source_owned", target_user_id=target_user_id,
            executor_pool_id=pool_id, status="queued",
            queue_expires_at=datetime.now(timezone.utc) + timedelta(hours=24),
            queued_at=datetime.now(timezone.utc),
        )); s.commit()


def _source_pool(engine) -> str:
    from apo.services.source_owned_executor import ensure_source_owned_pool
    with Session(engine) as s:
        return ensure_source_owned_pool(s, "p1").id


def _seed_project_owner(engine) -> str:
    """Ensure project p1 + an owner user exist; return the owner user id."""
    with Session(engine) as s:
        existing = s.exec(select(UserDB)).first()
        if existing is not None:
            return existing.id
        u = UserDB(email="o@t.com", name="O", password_hash="x", is_active=True)
        s.add(u); s.commit(); s.refresh(u)
        if s.get(ProjectDB, "p1") is None:
            s.add(ProjectDB(id="p1", name="P", created_by=u.id)); s.commit()
        return u.id


def test_claim_uses_shared_capacity_authority(isolated_engine):
    """Spec backend claim test 3: persisted max_concurrency is authoritative."""
    from apo.services.execution_leases import claim_next_source_owned_attempt

    engine = isolated_engine
    uid = _seed_project_owner(engine)
    pool_id = _source_pool(engine)
    ex_id = _enroll_v2_executor(engine, user_id=uid, pool_id=pool_id, name="cap", max_concurrency=1)
    _queue_source_owned_attempt(engine, attempt_id="a1", pool_id=pool_id, target_user_id=uid, run_id="r1")
    _queue_source_owned_attempt(engine, attempt_id="a2", pool_id=pool_id, target_user_id=uid, run_id="r2")

    with Session(engine) as s:
        ex = s.get(ExecutorDB, ex_id)
        first = claim_next_source_owned_attempt(s, executor=ex)  # pyright: ignore[reportArgumentType]
        second = claim_next_source_owned_attempt(s, executor=ex)  # pyright: ignore[reportArgumentType]
    assert first is not None  # capacity 1 → first claim leases
    assert second is None     # at capacity → no second claim


def test_claim_cannot_cross_user_or_assignment_kind(isolated_engine):
    """Spec backend claim test 4: only the executor's exact source-owned target."""
    from apo.services.execution_leases import claim_next_source_owned_attempt

    engine = isolated_engine
    owner_id = _seed_project_owner(engine)
    pool_id = _source_pool(engine)
    with Session(engine) as s:
        u2 = UserDB(email="b@t.com", name="B", password_hash="x", is_active=True)
        s.add(u2); s.commit(); s.refresh(u2)
    ex_id = _enroll_v2_executor(engine, user_id=owner_id, pool_id=pool_id, name="own")
    # work targeted to the OTHER user
    _queue_source_owned_attempt(engine, attempt_id="other", pool_id=pool_id, target_user_id=u2.id)

    with Session(engine) as s:
        ex = s.get(ExecutorDB, ex_id)
        result = claim_next_source_owned_attempt(s, executor=ex)  # pyright: ignore[reportArgumentType]
    assert result is None  # never claims another member's work


def test_claim_respects_sequential_batch_order(isolated_engine):
    """Spec backend claim test 3: a later sequence_index is blocked by its predecessor."""
    from apo.services.execution_leases import claim_next_source_owned_attempt

    engine = isolated_engine
    uid = _seed_project_owner(engine)
    pool_id = _source_pool(engine)
    ex_id = _enroll_v2_executor(engine, user_id=uid, pool_id=pool_id, name="seq", max_concurrency=4)
    _queue_source_owned_attempt(engine, attempt_id="seq0", pool_id=pool_id, target_user_id=uid, sequence_index=0, run_id="rs0")
    _queue_source_owned_attempt(engine, attempt_id="seq1", pool_id=pool_id, target_user_id=uid, sequence_index=1, run_id="rs1")

    with Session(engine) as s:
        ex = s.get(ExecutorDB, ex_id)
        first = claim_next_source_owned_attempt(s, executor=ex)  # pyright: ignore[reportArgumentType]
        # While seq0 is merely leased (not terminal), seq1 must not leapfrog.
        second = claim_next_source_owned_attempt(s, executor=ex)  # pyright: ignore[reportArgumentType]
    assert first is not None and first.attempt.id == "seq0"
    assert second is None


# ---------------------------------------------------------------------------
# assignment advertisement — the negotiated result-size contract (issue #249)
# ---------------------------------------------------------------------------


def _seed_credential_executor(engine, pool_id: str, *, raw: str, user_id: str) -> str:
    """Seed an online v2 executor with a known raw credential."""
    from apo.services.executor_auth import hash_credential

    with Session(engine) as s:
        ex = ExecutorDB(
            id="ex_adv",
            scope_kind="pool",
            project="p1",
            executor_pool_id=pool_id,
            name="adv",
            enabled=True,
            credential_prefix=raw[:16],
            credential_hash=hash_credential(raw),
            protocol_version=2,
            executor_version="0.1.0",
            enrolled_by_user_id=user_id,
            driver_kinds_json=["source-owned-ts"],
            capabilities_json={"assignment_kinds": ["source_owned"]},
            max_concurrency=4,
            last_seen_at=datetime.now(timezone.utc),
        )
        s.add(ex); s.commit()
        return ex.id


def _publish_catalog(engine, digest: str) -> None:
    from apo.models.db import ProjectTaskSourceDB

    with Session(engine) as s:
        s.add(ProjectTaskSourceDB(
            project="p1", source_type="published", status="ready",
            source_ref=None, catalog_digest=digest,
        ))
        s.commit()


def test_claims_advertise_configured_result_cap(isolated_engine, monkeypatch):
    """Issue #249: the assignment's result_max_bytes is the configured cap the
    request-size middleware enforces on /result — not a hardcoded literal."""
    engine = isolated_engine
    uid = _seed_project_owner(engine)
    pool_id = _source_pool(engine)
    _seed_credential_executor(engine, pool_id, raw="apo_ex_advertisement_credential", user_id=uid)
    _publish_catalog(engine, "sha256:matched")
    _queue_source_owned_attempt(engine, attempt_id="adv0", pool_id=pool_id, target_user_id=uid, run_id="radv")

    monkeypatch.setenv("APO_RESULT_MAX_BODY_BYTES", "2048")
    client = _client(engine)
    try:
        resp = client.post(
            "/v1/executor-protocol/v2/claims",
            headers={"Authorization": "Bearer apo_ex_advertisement_credential"},
            json={"catalog_digest": "sha256:matched", "available_slots": 1},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["result_max_bytes"] == 2048
    finally:
        app.dependency_overrides.clear()


def test_claims_advertise_default_result_cap(isolated_engine, monkeypatch):
    """Unset env → the shipped 10 MiB default, matching the middleware."""
    engine = isolated_engine
    uid = _seed_project_owner(engine)
    pool_id = _source_pool(engine)
    _seed_credential_executor(engine, pool_id, raw="apo_ex_advertisement_credential", user_id=uid)
    _publish_catalog(engine, "sha256:matched")
    _queue_source_owned_attempt(engine, attempt_id="adv1", pool_id=pool_id, target_user_id=uid, run_id="radv1")

    monkeypatch.delenv("APO_RESULT_MAX_BODY_BYTES", raising=False)
    client = _client(engine)
    try:
        resp = client.post(
            "/v1/executor-protocol/v2/claims",
            headers={"Authorization": "Bearer apo_ex_advertisement_credential"},
            json={"catalog_digest": "sha256:matched", "available_slots": 1},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["result_max_bytes"] == 10_485_760
    finally:
        app.dependency_overrides.clear()
