# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportUnusedParameter=false, reportIndexIssue=false

"""Caller create-and-claim protocol + authorization.

Drives POST /agent-task-batch-runs/caller through the real TestClient, then the
executor-protocol /start /heartbeat /result with the returned Attempt JWT, and
asserts Batch + Revision (attested) + caller Attempt + Task Run rollup.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB, TaskExecutionAttemptDB, TaskRevisionDB
from apo.routes.agent_task_runs import CallerCreateRequest
from apo.services import executor_auth
from pydantic import ValidationError
from sqlmodel import Session


def _seed_project(session: Session, project_id: str = "proj-caller") -> None:
    from apo.models.db import ProjectDB

    session.add(ProjectDB(id=project_id, name=project_id, created_at=datetime.now(timezone.utc)))
    session.commit()


def _caller_body(project_id: str = "proj-caller", *, content_sha: str = "a" * 64) -> dict[str, object]:
    return {
        "project": project_id,
        "task": {
            "task_id": "engineering/code-review",
            "task_path": "engineering/code-review",
            "display_name": "code-review",
            "adapter_name": "real-agent",
            "has_checks": True,
        },
        "environment": "default",
        "run_metadata": {"trigger": {"source": "cli"}},
        "source_attestation": {
            "source_type": "caller_worktree",
            "repository_url": "https://github.com/acme/service.git",
            "base_commit_sha": "71cc0e",
            "dirty": True,
            "content_sha256": content_sha,
            "task_root_label": "tasks",
            "file_count": 23,
            "uncompressed_size_bytes": 184202,
        },
        "caller_identity": {
            "client": "apo-cli",
            "client_version": "0.1.0",
            "ci_provider": "github-actions",
            "os": "linux",
            "architecture": "x64",
        },
        "task_definition": {
            "schema_version": 1,
            "files": [
                {
                    "path": "code-review.eval.ts",
                    "content": "task('code-review', { adapter: 'real-agent' });\n",
                }
            ],
        },
    }


@pytest.fixture
def auth_secret(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setattr(executor_auth, "AUTH_SECRET", "test-caller-secret")
    return "test-caller-secret"


def test_caller_create_and_claim_then_run_lifecycle(
    client: object, session: Session, auth_secret: str
) -> None:
    _seed_project(session)
    r = client.post("/v1/agent-task-batch-runs/caller", json=_caller_body())  # type: ignore[attr-defined]
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["lease_generation"] == 1
    attempt_jwt = body["attempt_jwt"]
    attempt_id = body["attempt_id"]
    att_headers = {"Authorization": f"Bearer {attempt_jwt}"}

    r = client.post(  # type: ignore[attr-defined]
        f"/v1/executor-protocol/v1/attempts/{attempt_id}/start",
        json={"driver_kind": "caller", "runtime": {}}, headers=att_headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "running"

    r = client.post(  # type: ignore[attr-defined]
        f"/v1/executor-protocol/v1/attempts/{attempt_id}/heartbeat",
        json={"phase": "running"}, headers=att_headers,
    )
    assert r.status_code == 200, r.text

    r = client.post(  # type: ignore[attr-defined]
        f"/v1/executor-protocol/v1/attempts/{attempt_id}/result",
        json={"completion_id": "comp-1", "pass_result": True, "adapter_name": "real-agent",
              "checks": [{"name": "c1", "pass": True}]},
        headers=att_headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "succeeded"

    att = session.get(TaskExecutionAttemptDB, attempt_id)
    assert att is not None and att.status == "succeeded" and att.target_kind == "caller"
    assert att.executor_id is None and att.executor_pool_id is None
    rev = session.get(TaskRevisionDB, att.task_revision_id)
    assert rev is not None and rev.materialization == "attested" and rev.dirty is True
    assert rev.content_sha256 == "a" * 64
    run = session.get(AgentTaskRunDB, body["task_run_id"])
    assert run is not None and run.status == "passed"
    assert run.task_definition_revision_id is not None
    batch = session.get(AgentTaskBatchRunDB, body["batch_run_id"])
    assert batch is not None and batch.passed_tasks == 1 and batch.total_tasks == 1


def test_caller_batch_snapshots_its_task_selection(
    client: object, session: Session, auth_secret: str
) -> None:
    """A caller Batch records the Task it targets in ``selection_query``.

    The Runs list names a Batch from ``selection_query.task_paths``; without
    the snapshot every CLI Run renders as the raw selection type
    ("caller-task") instead of the Task that ran.
    """
    _seed_project(session)
    r = client.post("/v1/agent-task-batch-runs/caller", json=_caller_body())  # type: ignore[attr-defined]
    assert r.status_code == 201, r.text

    batch = session.get(AgentTaskBatchRunDB, r.json()["batch_run_id"])
    assert batch is not None
    assert batch.selection_query == {"task_paths": ["engineering/code-review"]}

    listed = client.get(  # type: ignore[attr-defined]
        "/v1/agent-task-batch-runs", params={"project": "proj-caller"}
    ).json()["data"]
    assert listed[0]["selection_query"] == {"task_paths": ["engineering/code-review"]}


def test_caller_attempt_token_rejected_on_other_attempt(
    client: object, session: Session, auth_secret: str
) -> None:
    _seed_project(session)
    a = client.post("/v1/agent-task-batch-runs/caller", json=_caller_body(content_sha="b" * 64)).json()  # type: ignore[attr-defined]
    b = client.post("/v1/agent-task-batch-runs/caller", json=_caller_body(content_sha="c" * 64)).json()  # type: ignore[attr-defined]
    jwt_a = a["attempt_jwt"]
    r = client.post(  # type: ignore[attr-defined]
        f"/v1/executor-protocol/v1/attempts/{b['attempt_id']}/start",
        json={"driver_kind": "caller", "runtime": {}},
        headers={"Authorization": f"Bearer {jwt_a}"},
    )
    assert r.status_code == 403


def test_caller_create_rejects_unknown_project(
    client: object, session: Session, auth_secret: str
) -> None:
    r = client.post("/v1/agent-task-batch-runs/caller", json=_caller_body("nope-proj"))  # type: ignore[attr-defined]
    assert r.status_code == 422


def test_caller_create_rejects_missing_task_definition() -> None:
    body = _caller_body()
    del body["task_definition"]

    with pytest.raises(ValidationError):
        CallerCreateRequest.model_validate(body)


def test_caller_create_rejects_oversized_identity(
    client: object, session: Session, auth_secret: str
) -> None:
    _seed_project(session)
    body = _caller_body()
    body["caller_identity"]["client_version"] = "x" * 300
    r = client.post("/v1/agent-task-batch-runs/caller", json=body)  # type: ignore[attr-defined]
    assert r.status_code == 422
