"""Scene tests for selection-scoped view comparison (SPEC-174, Phase 2).

Exercises POST (resolve + freeze) and GET (immutable read) through the
registered routes, and the comparable gate across the four cases that matter:
both-comparable, task-definition-revision mismatch, execution-revision
mismatch, and a task with no run on one side.
"""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlmodel import Session

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    TaskDefinitionRevisionDB,
    TaskRevisionDB,
    UserDB,
)
from apo.services.agent_task_run_details import load_task_run_details
from tests.conftest import seed_project_for_user

_PROJECT = "proj-cmp"
_OWNER = "owner-cmp"
_W = "evals/cmp-comparable"  # both sides, same def + same exec (same batch)
_X = "evals/cmp-def-mismatch"  # def revisions differ
_Y = "evals/cmp-exec-mismatch"  # exec (batch) revisions differ
_Z = "evals/cmp-no-deepseek"  # no DeepSeek run


def _seed(session: Session) -> None:
    now = datetime.now(timezone.utc)
    session.add(UserDB(id=_OWNER, email="owner-cmp@test", name="Owner", password_hash="x"))
    session.flush()
    seed_project_for_user(session, _OWNER, project_id=_PROJECT)

    # two batches → two distinct exec (batch) revision shas
    session.add_all(
        [
            AgentTaskBatchRunDB(id="b-opus", project=_PROJECT, created_at=now, status="completed", total_tasks=4, task_root="/t", environment="default", selection_type="task"),
            AgentTaskBatchRunDB(id="b-deep", project=_PROJECT, created_at=now, status="completed", total_tasks=3, task_root="/t", environment="default", selection_type="task"),
        ]
    )
    session.add_all(
        [
            TaskRevisionDB(id="rev-opus", project=_PROJECT, batch_run_id="b-opus", materialization="attested", source_type="git", content_sha256="e" * 64, file_count=1, uncompressed_size_bytes=1, manifest_summary_json={}),
            TaskRevisionDB(id="rev-deep", project=_PROJECT, batch_run_id="b-deep", materialization="attested", source_type="git", content_sha256="f" * 64, file_count=1, uncompressed_size_bytes=1, manifest_summary_json={}),
        ]
    )
    session.flush()
    # two task-definition revisions → def mismatch when sides point at different ones
    session.add_all(
        [
            TaskDefinitionRevisionDB(id="d1", project=_PROJECT, task_id=_W, content_sha256="a" * 64, source_size_bytes=1),
            TaskDefinitionRevisionDB(id="d2", project=_PROJECT, task_id=_X, content_sha256="b" * 64, source_size_bytes=1),
        ]
    )
    session.flush()

    def _run(rid: str, batch: str, task: str, model: str, def_rev: str | None) -> AgentTaskRunDB:
        return AgentTaskRunDB(
            id=rid, batch_run_id=batch, task_id=task, task_path=f"/t/{task}",
            status="passed", pass_result=True, configured_model=model,
            configured_effort=None, task_definition_revision_id=def_rev,
            started_at=now, completed_at=now,
            total_checks=1, passed_checks=1, failed_checks=0,
            checks_json=[{"id": f"check-{rid}", "pass": True, "reasoning": model}],
        )

    # W: opus + deepseek both in b-opus, def d1 -> comparable
    session.add(_run("w-opus", "b-opus", _W, "claude-opus", "d1"))
    session.add(_run("w-deep", "b-opus", _W, "deepseek", "d1"))
    # X: opus (d1) + deepseek (d2) -> def mismatch
    session.add(_run("x-opus", "b-opus", _X, "claude-opus", "d1"))
    session.add(_run("x-deep", "b-deep", _X, "deepseek", "d2"))
    # Y: opus (b-opus, d1) + deepseek (b-deep, d1) -> exec mismatch (def matches)
    session.add(_run("y-opus", "b-opus", _Y, "claude-opus", "d1"))
    session.add(_run("y-deep", "b-deep", _Y, "deepseek", "d1"))
    # Z: opus only -> deepseek side has no run
    session.add(_run("z-opus", "b-opus", _Z, "claude-opus", "d1"))
    session.commit()


@pytest.fixture(name="cmp_client")
def cmp_client_fixture(session: Session, make_authed_client):
    _seed(session)
    return make_authed_client(_OWNER, session)


def _create(cmp_client: TestClient, task_ids: list[str]) -> dict[str, object]:
    resp = cmp_client.post(
        f"/v1/projects/{_PROJECT}/task-view-comparisons",
        json={
            "task_ids": task_ids,
            "view_a": {"model": "claude-opus", "effort": None},
            "view_b": {"model": "deepseek", "effort": None},
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_comparison_resolves_and_marks_comparable_gate(cmp_client: TestClient) -> None:
    snap = _create(cmp_client, [_W, _X, _Y, _Z])
    assert snap["coverage"] == {"both_run": 3, "comparable": 2, "scope": 4}
    by_task = {c["task_id"]: c for c in snap["resolved"]}
    assert by_task[_W]["comparable"] is True
    assert by_task[_X]["comparable"] is False  # def mismatch
    assert by_task[_Y]["comparable"] is True  # same def, different bundle — still comparable
    # Z has no DeepSeek run -> b_run_id None, not counted in both_run
    assert by_task[_Z]["b_run_id"] is None
    assert by_task[_Z]["comparable"] is False


def test_comparison_snapshot_is_immutable_on_read(cmp_client: TestClient) -> None:
    snap = _create(cmp_client, [_W])
    # GET by the opaque id round-trips the frozen resolved set + coverage.
    got = cmp_client.get(f"/v1/projects/{_PROJECT}/task-view-comparisons/{snap['id']}").json()
    assert got["resolved"] == snap["resolved"]
    assert got["coverage"] == snap["coverage"]
    assert got["id"].startswith("tvc_")


def test_comparison_evidence_loads_every_resolved_run_in_one_response(
    cmp_client: TestClient,
) -> None:
    snap = _create(cmp_client, [_W, _X, _Y, _Z])

    response = cmp_client.get(
        f"/v1/projects/{_PROJECT}/task-view-comparisons/{snap['id']}/evidence"
    )

    assert response.status_code == 200, response.text
    evidence = response.json()
    assert evidence["snapshot"] == snap
    assert [run["id"] for run in evidence["runs"]] == [
        "w-opus",
        "w-deep",
        "x-opus",
        "x-deep",
        "y-opus",
        "y-deep",
        "z-opus",
    ]
    assert evidence["runs"][0]["checks_json"] == [
        {"id": "check-w-opus", "pass": True, "reasoning": "claude-opus"}
    ]
    assert evidence["runs"][0]["task_definition"]["id"] == "d1"
    assert evidence["runs"][0]["transcript_json"] is None


def test_bulk_run_evidence_uses_a_fixed_number_of_queries(session: Session) -> None:
    _seed(session)
    statements: list[str] = []

    def _record_statement(_conn, _cursor, statement, _params, _context, _many) -> None:
        statements.append(statement)

    bind = session.get_bind()
    event.listen(bind, "before_cursor_execute", _record_statement)
    try:
        details = load_task_run_details(
            session,
            ["w-opus", "w-deep", "x-opus", "x-deep", "y-opus", "y-deep", "z-opus"],
            project_id=_PROJECT,
        )
    finally:
        event.remove(bind, "before_cursor_execute", _record_statement)

    assert len(details) == 7
    assert len(statements) == 4  # runs + batches/triggers + definitions + checks


def test_comparison_rejects_empty_selection(cmp_client: TestClient) -> None:
    resp = cmp_client.post(
        f"/v1/projects/{_PROJECT}/task-view-comparisons",
        json={"task_ids": [], "view_a": {"model": "claude-opus"}, "view_b": {"model": "deepseek"}},
    )
    assert resp.status_code == 422


def test_comparison_requires_membership(session: Session, make_authed_client) -> None:
    _seed(session)
    other = make_authed_client("intruder-cmp", session)
    resp = other.post(
        f"/v1/projects/{_PROJECT}/task-view-comparisons",
        json={"task_ids": [_W], "view_a": {"model": "claude-opus"}, "view_b": {"model": "deepseek"}},
    )
    assert resp.status_code == 403
