"""Regression coverage for task-detail run-history routing."""

from datetime import datetime, timezone

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.api import app
from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB


def test_task_run_collection_filters_hierarchical_task_id(
    client: TestClient,
    session: Session,
) -> None:
    now = datetime.now(timezone.utc)
    session.add_all(
        [
            _batch("batch-target", "project-1", now),
            _batch("batch-other-task", "project-1", now),
            _batch("batch-other-project", "project-2", now),
        ]
    )
    session.add_all(
        [
            _run(
                "run-target",
                "batch-target",
                "real-agent/documents/data-extraction",
                now,
            ),
            _run("run-other-task", "batch-other-task", "other-task", now),
            _run(
                "run-other-project",
                "batch-other-project",
                "real-agent/documents/data-extraction",
                now,
            ),
        ]
    )
    session.commit()

    response = client.get(
        "/v1/agent-task-runs",
        params={
            "task_id": "real-agent/documents/data-extraction",
            "project": "project-1",
        },
    )

    assert response.status_code == 200
    assert [run["id"] for run in response.json()] == ["run-target"]


def test_task_detail_catch_all_has_no_competing_runs_route() -> None:
    route_paths = {
        route.path for route in app.routes if isinstance(route, APIRoute)
    }

    assert "/v1/agent-tasks/{task_id:path}" in route_paths
    assert "/v1/agent-tasks/{task_id:path}/runs" not in route_paths


def _batch(
    batch_id: str,
    project: str,
    created_at: datetime,
) -> AgentTaskBatchRunDB:
    return AgentTaskBatchRunDB(
        id=batch_id,
        project=project,
        selection_type="task",
        selection_query=None,
        task_root="/tmp/tasks",
        environment="default",
        status="completed",
        total_tasks=1,
        created_at=created_at,
    )


def _run(
    run_id: str,
    batch_id: str,
    task_id: str,
    started_at: datetime,
) -> AgentTaskRunDB:
    return AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch_id,
        task_id=task_id,
        task_path=f"/tmp/tasks/{task_id}",
        status="passed",
        pass_result=True,
        started_at=started_at,
        completed_at=started_at,
    )
