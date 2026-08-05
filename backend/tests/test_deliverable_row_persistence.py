# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false
# pyright: reportAttributeAccessIssue=false, reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

"""SPEC-162 #119: result submit persists deliverable rows, not blobs.

When a source-owned or caller run submits a result with deliverables, the
deliverables must be persisted as AgentTaskDeliverableDB rows (inline ≤64KiB,
gzip-to-store above) — not dumped onto the hot agent_task_runs row.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.middleware.base import BaseHTTPMiddleware
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool

from apo.api import app
from apo.db import engine as prod_engine, get_session
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    TaskExecutionAttemptDB,
    UserDB,
    ProjectMembershipDB,
    AgentTaskDeliverableDB,
)


def _seed_leased_attempt(session, *, attempt_id="att-deliv", run_id="run-deliv"):
    from apo.services.executor_auth import create_attempt_jwt

    now = datetime.now(timezone.utc)
    batch = AgentTaskBatchRunDB(
        id="bch-deliv", project="p1", selection_type="tasks",
        status="queued", execution_target_json={"kind": "source_owned"},
        created_at=now,
    )
    session.add(batch)
    session.flush()
    run = AgentTaskRunDB(
        id=run_id, batch_run_id="bch-deliv", task_id="t", task_path="p",
        sequence_index=0, status="running",
    )
    session.add(run)
    session.flush()
    attempt = TaskExecutionAttemptDB(
        id=attempt_id, project="p1", batch_run_id="bch-deliv", task_run_id=run_id,
        sequence_index=0, target_kind="pool", assignment_kind="source_owned",
        executor_pool_id="pool-1", status="running", phase="running",
        queue_expires_at=now + timedelta(hours=24),
        queued_at=now, claimed_at=now, started_at=now,
        heartbeat_at=now, lease_generation=1,
        lease_expires_at=now + timedelta(minutes=5),
    )
    session.add(attempt)
    session.commit()
    return create_attempt_jwt(attempt=attempt, lease_generation=1, expires_in_seconds=3600)


@pytest.fixture
def isolated(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    import apo.db as db_module
    monkeypatch.setattr(db_module, "engine", engine)
    # The seeded attempt mints a JWT, which intentionally fails closed when
    # AUTH_SECRET is unset.
    monkeypatch.setattr("apo.services.executor_auth.AUTH_SECRET", "test-secret")
    with Session(engine) as s:
        u = UserDB(email="t@t.com", name="T", password_hash="x", is_active=True)
        s.add(u); s.commit(); s.refresh(u)
        s.add(ProjectDB(id="p1", name="P", created_by=u.id)); s.commit()
    return engine


def _client(engine) -> TestClient:
    class Inject(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            request.state.user_id = None
            return await call_next(request)
    na = FastAPI()
    na.include_router(app.router)
    na.add_middleware(Inject)
    na.dependency_overrides[get_session] = lambda: Session(engine)
    return TestClient(na)


class TestResultSubmitPersistsDeliverableRows:
    """#119: deliverables become rows, not blobs."""

    def test_small_deliverable_creates_inline_row(self, isolated, monkeypatch):
        engine = isolated
        with Session(engine) as s:
            jwt = _seed_leased_attempt(s)
        c = _client(engine)
        try:
            resp = c.post(
                "/v1/executor-protocol/v2/attempts/att-deliv/result",
                headers={"Authorization": f"Bearer {jwt}"},
                json={
                    "completion_id": "comp-1",
                    "pass_result": True,
                    "deliverables": {"verdict": {"result": "pass", "score": 42}},
                },
            )
            assert resp.status_code == 200, resp.text

            with Session(engine) as s:
                # Row exists
                rows = s.exec(
                    select(AgentTaskDeliverableDB).where(
                        AgentTaskDeliverableDB.task_run_id == "run-deliv"
                    )
                ).all()
                assert len(rows) == 1
                assert rows[0].name == "verdict"
                assert rows[0].kind == "json"
                assert rows[0].id != f"legacy:verdict"

                # Hot row does NOT carry the blob
                run = s.get(AgentTaskRunDB, "run-deliv")
                assert run.deliverables_json is None
        finally:
            app.dependency_overrides.clear()

    def test_large_deliverable_goes_to_store(self, isolated, monkeypatch):
        from apo.services.artifact_stores.local import LocalArtifactStore
        engine = isolated
        big_value = {"data": "x" * 100_000}  # > 64 KiB
        with Session(engine) as s:
            jwt = _seed_leased_attempt(s)
        c = _client(engine)
        try:
            resp = c.post(
                "/v1/executor-protocol/v2/attempts/att-deliv/result",
                headers={"Authorization": f"Bearer {jwt}"},
                json={
                    "completion_id": "comp-2",
                    "pass_result": True,
                    "deliverables": {"big": big_value},
                },
            )
            assert resp.status_code == 200, resp.text

            with Session(engine) as s:
                rows = s.exec(
                    select(AgentTaskDeliverableDB).where(
                        AgentTaskDeliverableDB.task_run_id == "run-deliv"
                    )
                ).all()
                assert len(rows) == 1
                # Large deliverable: body is null, storage key is set
                assert rows[0].inline_value_json is None
                assert rows[0].storage_key is not None
                assert rows[0].storage_backend is not None
                assert rows[0].size_bytes > 64 * 1024

                run = s.get(AgentTaskRunDB, "run-deliv")
                assert run.deliverables_json is None
        finally:
            app.dependency_overrides.clear()

    def test_no_deliverables_leaves_no_rows(self, isolated, monkeypatch):
        engine = isolated
        with Session(engine) as s:
            jwt = _seed_leased_attempt(s)
        c = _client(engine)
        try:
            resp = c.post(
                "/v1/executor-protocol/v2/attempts/att-deliv/result",
                headers={"Authorization": f"Bearer {jwt}"},
                json={"completion_id": "comp-3", "pass_result": True},
            )
            assert resp.status_code == 200

            with Session(engine) as s:
                rows = s.exec(
                    select(AgentTaskDeliverableDB).where(
                        AgentTaskDeliverableDB.task_run_id == "run-deliv"
                    )
                ).all()
                assert len(rows) == 0
        finally:
            app.dependency_overrides.clear()
