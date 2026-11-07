# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false

"""Connected Executor management — Pool CRUD, enrollment, revoke, health."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ExecutorDB,
    ExecutorEnrollmentTokenDB,
    ExecutorPoolDB,
    ProjectDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
)
from apo.services.lifecycle import BATCH_RUN_TERMINAL
from sqlmodel import Session


def _seed_project(session: Session, project_id: str = "proj-m") -> None:
    session.add(ProjectDB(id=project_id, name=project_id, created_at=datetime.now(timezone.utc)))
    session.commit()


def _seed_pool(session: Session, project_id: str, pool_id: str, **kw) -> ExecutorPoolDB:
    pool = ExecutorPoolDB(
        id=pool_id, project=project_id, name=kw.get("name", pool_id), slug=kw.get("slug", pool_id),
        kind=kw.get("kind", "connected"), enabled=kw.get("enabled", True),
        archived_at=kw.get("archived_at"), queue_ttl_seconds=kw.get("queue_ttl_seconds", 86400),
        required_driver_kind=kw.get("required_driver_kind", "subprocess"),
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )
    session.add(pool)
    session.commit()
    return pool


def _seed_executor(
    session: Session,
    pool_id: str,
    project_id: str,
    eid: str,
    *,
    online: bool = True,
    revoked: bool = False,
    protocol_version: int = 1,
    driver_kinds: list[str] | None = None,
) -> ExecutorDB:
    ex = ExecutorDB(
        id=eid, scope_kind="pool", project=project_id, executor_pool_id=pool_id, name=eid,
        enabled=not revoked, credential_prefix="apo_ex_x", credential_hash="h" + eid,
        protocol_version=protocol_version,
        executor_version="v1",
        driver_kinds_json=driver_kinds or ["subprocess"],
        max_concurrency=2, last_seen_at=datetime.now(timezone.utc) if online else datetime.now(timezone.utc) - timedelta(hours=1),
        enrolled_at=datetime.now(timezone.utc), revoked_at=datetime.now(timezone.utc) if revoked else None,
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    )
    session.add(ex)
    session.commit()
    return ex


def _seed_attempt(session: Session, *, pool_id: str, executor_id: str, status: str, project_id: str = "proj-m") -> TaskExecutionAttemptDB:
    session.add(AgentTaskBatchRunDB(id=f"b-{executor_id}", project=project_id, selection_type="single", status="running", created_at=datetime.now(timezone.utc)))
    session.flush()
    session.add(AgentTaskRunDB(id=f"r-{executor_id}", batch_run_id=f"b-{executor_id}", task_id="t", task_path="t", sequence_index=0, status="running"))
    session.flush()
    session.add(TaskRevisionDB(id=f"rev-{executor_id}", project=project_id, batch_run_id=f"b-{executor_id}", materialization="bundled", source_type="filesystem", content_sha256="c"*64, file_count=1, uncompressed_size_bytes=1, manifest_summary_json={"fileCount": 1}, created_at=datetime.now(timezone.utc)))
    session.flush()
    started = datetime.now(timezone.utc) if status == "running" else None
    att = TaskExecutionAttemptDB(
        id=f"a-{executor_id}", project=project_id, batch_run_id=f"b-{executor_id}", task_run_id=f"r-{executor_id}",
        task_revision_id=f"rev-{executor_id}", sequence_index=0, target_kind="pool",
        executor_pool_id=pool_id, executor_id=executor_id, status=status, lease_generation=1,
        lease_expires_at=datetime.now(timezone.utc) + timedelta(hours=1), started_at=started,
        queue_expires_at=datetime.now(timezone.utc) + timedelta(hours=1), queued_at=datetime.now(timezone.utc),
    )
    session.add(att)
    session.commit()
    return att


# ── create Connected Pool ─────────────────────────────────────────────────


def test_create_connected_pool(client: object, session: Session) -> None:
    _seed_project(session)
    r = client.post("/v1/projects/proj-m/executor-pools", json={  # type: ignore[attr-defined]
        "name": "Private VPC", "slug": "private-vpc", "queue_ttl_seconds": 3600,
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["kind"] == "connected"
    assert body["slug"] == "private-vpc"
    assert body["health"] in ("offline", "online")


def test_create_rejects_user_bundled_kind(client: object, session: Session) -> None:
    _seed_project(session)
    r = client.post("/v1/projects/proj-m/executor-pools", json={  # type: ignore[attr-defined]
        "name": "B", "slug": "b", "kind": "bundled",
    })
    assert r.status_code == 422


def test_create_rejects_bad_slug(client: object, session: Session) -> None:
    _seed_project(session)
    r = client.post("/v1/projects/proj-m/executor-pools", json={  # type: ignore[attr-defined]
        "name": "X", "slug": "Bad Slug!",
    })
    assert r.status_code == 422


def test_create_rejects_duplicate_slug(client: object, session: Session) -> None:
    _seed_project(session)
    _seed_pool(session, "proj-m", "p1", slug="dup")
    r = client.post("/v1/projects/proj-m/executor-pools", json={"name": "D", "slug": "dup"})  # type: ignore[attr-defined]
    assert r.status_code in (409, 422)


# ── PATCH / DELETE ────────────────────────────────────────────────────────


def test_patch_pool_name_and_enabled(client: object, session: Session) -> None:
    _seed_project(session)
    _seed_pool(session, "proj-m", "p1")
    r = client.patch("/v1/projects/proj-m/executor-pools/p1", json={"name": "Renamed", "enabled": False})  # type: ignore[attr-defined]
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Renamed"
    assert r.json()["enabled"] is False


def test_patch_rejects_archived_pool(client: object, session: Session) -> None:
    _seed_project(session)
    _seed_pool(
        session,
        "proj-m",
        "p1",
        enabled=False,
        archived_at=datetime.now(timezone.utc),
    )
    response = client.patch(  # type: ignore[attr-defined]
        "/v1/projects/proj-m/executor-pools/p1",
        json={"enabled": True},
    )
    assert response.status_code == 409


def test_pool_validates_queue_ttl_and_driver(
    client: object,
    session: Session,
) -> None:
    _seed_project(session)
    for body in (
        {"name": "Unsafe TTL", "slug": "unsafe-ttl", "queue_ttl_seconds": 1},
        {
            "name": "Unknown Driver",
            "slug": "unknown-driver",
            "required_driver_kind": "docker",
        },
    ):
        response = client.post(  # type: ignore[attr-defined]
            "/v1/projects/proj-m/executor-pools",
            json=body,
        )
        assert response.status_code == 422


def test_delete_archives_pool(client: object, session: Session) -> None:
    _seed_project(session)
    _seed_pool(session, "proj-m", "p1")
    r = client.delete("/v1/projects/proj-m/executor-pools/p1")  # type: ignore[attr-defined]
    assert r.status_code == 200, r.text
    pool = session.get(ExecutorPoolDB, "p1")
    assert pool is not None and pool.archived_at is not None and pool.enabled is False


def test_delete_rejects_pool_with_active_attempt(client: object, session: Session) -> None:
    _seed_project(session)
    pool = _seed_pool(session, "proj-m", "p1")
    _seed_executor(session, pool.id, "proj-m", "ex1")
    _seed_attempt(session, pool_id=pool.id, executor_id="ex1", status="running")
    r = client.delete("/v1/projects/proj-m/executor-pools/p1")  # type: ignore[attr-defined]
    assert r.status_code == 409


# ── enrollment tokens ─────────────────────────────────────────────────────


def test_create_enrollment_token_returns_raw_once(client: object, session: Session) -> None:
    _seed_project(session)
    _seed_pool(session, "proj-m", "p1")
    r = client.post("/v1/projects/proj-m/executor-pools/p1/enrollment-tokens", json={})  # type: ignore[attr-defined]
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["id"]
    assert body["pool_id"] == "p1"
    assert body["token"].startswith("apo_enroll_")
    assert "container" in body
    assert body["container"]["environment"]["APO_EXECUTOR_ENROLLMENT_TOKEN"] == body["token"]
    # raw token NOT persisted
    tokens = session.exec(select_tokens()).all()
    assert all(not t.token_hash.startswith("apo_enroll_") for t in tokens)


def test_revoke_unused_enrollment_token(
    client: object,
    session: Session,
) -> None:
    _seed_project(session)
    _seed_pool(session, "proj-m", "p1")
    _seed_pool(session, "proj-m", "p2")
    created = client.post(  # type: ignore[attr-defined]
        "/v1/projects/proj-m/executor-pools/p1/enrollment-tokens",
        json={},
    )
    assert created.status_code == 201
    token_id = created.json()["id"]

    wrong_pool = client.delete(  # type: ignore[attr-defined]
        (
            "/v1/projects/proj-m/executor-pools/p2"
            f"/enrollment-tokens/{token_id}"
        )
    )
    assert wrong_pool.status_code == 404

    revoked = client.delete(  # type: ignore[attr-defined]
        (
            "/v1/projects/proj-m/executor-pools/p1"
            f"/enrollment-tokens/{token_id}"
        )
    )
    assert revoked.status_code == 200
    row = session.get(ExecutorEnrollmentTokenDB, token_id)
    assert row is not None and row.revoked_at is not None
    revoked_again = client.delete(  # type: ignore[attr-defined]
        (
            "/v1/projects/proj-m/executor-pools/p1"
            f"/enrollment-tokens/{token_id}"
        )
    )
    assert revoked_again.status_code == 200


def test_revoke_consumed_enrollment_token_is_rejected(
    client: object,
    session: Session,
) -> None:
    _seed_project(session)
    _seed_pool(session, "proj-m", "p1")
    created = client.post(  # type: ignore[attr-defined]
        "/v1/projects/proj-m/executor-pools/p1/enrollment-tokens",
        json={},
    )
    token_id = created.json()["id"]
    row = session.get(ExecutorEnrollmentTokenDB, token_id)
    assert row is not None
    row.used_at = datetime.now(timezone.utc)
    session.add(row)
    session.commit()

    response = client.delete(  # type: ignore[attr-defined]
        (
            "/v1/projects/proj-m/executor-pools/p1"
            f"/enrollment-tokens/{token_id}"
        )
    )
    assert response.status_code == 409
    assert response.json()["detail"]["kind"] == "token_used"


def test_five_live_token_limit(client: object, session: Session) -> None:
    _seed_project(session)
    _seed_pool(session, "proj-m", "p1")
    for _ in range(5):
        r = client.post("/v1/projects/proj-m/executor-pools/p1/enrollment-tokens", json={})  # type: ignore[attr-defined]
        assert r.status_code == 201
    r = client.post("/v1/projects/proj-m/executor-pools/p1/enrollment-tokens", json={})  # type: ignore[attr-defined]
    assert r.status_code == 409


# ── executor list + health ────────────────────────────────────────────────


def test_list_executors_with_derived_health(client: object, session: Session) -> None:
    _seed_project(session)
    pool = _seed_pool(session, "proj-m", "p1")
    _seed_executor(session, pool.id, "proj-m", "ex-online", online=True)
    _seed_executor(session, pool.id, "proj-m", "ex-offline", online=False)
    r = client.get("/v1/projects/proj-m/executors")  # type: ignore[attr-defined]
    assert r.status_code == 200, r.text
    executors = {e["id"]: e for e in r.json()["executors"]}
    assert executors["ex-online"]["status"] == "online"
    assert executors["ex-offline"]["status"] == "offline"


def test_list_marks_protocol_mismatch_incompatible(
    client: object,
    session: Session,
) -> None:
    _seed_project(session)
    pool = _seed_pool(session, "proj-m", "p1")
    _seed_executor(
        session,
        pool.id,
        "proj-m",
        "ex-incompatible",
        protocol_version=99,
    )
    response = client.get("/v1/projects/proj-m/executors")  # type: ignore[attr-defined]
    assert response.status_code == 200
    assert response.json()["executors"][0]["status"] == "incompatible"


# ── revoke ────────────────────────────────────────────────────────────────


def test_revoke_fences_running_and_requeues_pre_start(client: object, session: Session) -> None:
    _seed_project(session)
    pool = _seed_pool(session, "proj-m", "p1")
    _seed_executor(session, pool.id, "proj-m", "ex1")
    _seed_executor(session, pool.id, "proj-m", "ex1-2")
    running = _seed_attempt(session, pool_id=pool.id, executor_id="ex1", status="running")
    leased = _seed_attempt(session, pool_id=pool.id, executor_id="ex1-2", status="leased")

    r = client.post("/v1/projects/proj-m/executors/ex1/revoke", json={})  # type: ignore[attr-defined]
    assert r.status_code == 200, r.text

    running_att = session.get(TaskExecutionAttemptDB, running.id)
    assert running_att is not None and running_att.status == "lost"
    leased_att = session.get(TaskExecutionAttemptDB, leased.id)
    # ex1-2 is NOT revoked; its leased attempt is untouched
    assert leased_att is not None and leased_att.status == "leased"


def test_rename_executor(client: object, session: Session) -> None:
    _seed_project(session)
    pool = _seed_pool(session, "proj-m", "p1")
    _seed_executor(session, pool.id, "proj-m", "ex1")
    r = client.post("/v1/projects/proj-m/executors/ex1/rename", json={"name": "renamed-ex"})  # type: ignore[attr-defined]
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "renamed-ex"


# ── cross-Project ─────────────────────────────────────────────────────────


def test_cross_project_pool_operations_opaque(client: object, session: Session) -> None:
    _seed_project(session, "proj-a")
    _seed_project(session, "proj-b")
    _seed_pool(session, "proj-a", "pool-a")
    # patch pool-a from proj-b context -> 404 (opaque, not "wrong project")
    r = client.patch("/v1/projects/proj-b/executor-pools/pool-a", json={"name": "x"})  # type: ignore[attr-defined]
    assert r.status_code == 404


# helper
def select_tokens():
    from sqlmodel import select as _s
    return _s(ExecutorEnrollmentTokenDB)


# ── executor revoke ───────────────────────────────────────────────────────


def test_revoke_ends_the_run_of_a_fenced_running_attempt(client: object, session: Session) -> None:
    """Revoking mid-run must not leave the Task Run stuck in running.

    The attempt is fenced lost, and the run ends as an executor no-verdict
    error with its batch rolled up to a terminal state.
    """
    _seed_project(session)
    pool = _seed_pool(session, "proj-m", "p1")
    _seed_executor(session, pool.id, "proj-m", "ex1")
    att = _seed_attempt(session, pool_id=pool.id, executor_id="ex1", status="running")
    r = client.post("/v1/projects/proj-m/executors/ex1/revoke")  # type: ignore[attr-defined]
    assert r.status_code == 200, r.text
    fenced = session.get(TaskExecutionAttemptDB, att.id)
    task_run = session.get(AgentTaskRunDB, att.task_run_id)
    batch = session.get(AgentTaskBatchRunDB, att.batch_run_id)
    assert fenced is not None and fenced.status == "lost"
    assert fenced.failure_kind == "executor_revoked"
    assert task_run is not None and task_run.status == "error"
    assert task_run.no_verdict_reason == "executor"
    assert task_run.completed_at is not None
    assert batch is not None and batch.status in BATCH_RUN_TERMINAL
