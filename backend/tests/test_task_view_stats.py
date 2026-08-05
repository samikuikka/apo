"""Scene tests for the Tasks page evidence-view endpoints (SPEC-174, Phase 1).

Exercises the registered routes end-to-end via the test client: the view-scoped
per-task stats (model/effort filtered) and the run-config facets that populate
the Model / Effort filter dropdowns. Proves the cohort narrows correctly — the
behaviour the Tasks page tabs depend on.
"""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    UserDB,
)
from tests.conftest import seed_project_for_user

_PROJECT = "proj-views"
_OWNER = "owner-views"
_TASK_A = "evals/task-a"
_TASK_B = "evals/task-b"


def _seed_view_project(session: Session) -> None:
    now = datetime.now(timezone.utc)
    # the projects.created_by FK needs the owner row to exist first
    session.add(UserDB(id=_OWNER, email="owner-views@test", name="Owner", password_hash="x"))
    session.flush()
    seed_project_for_user(session, _OWNER, project_id=_PROJECT)
    session.add(
        ProjectTaskSourceDB(
            id="src-views",
            project=_PROJECT,
            source_type="filesystem",
            status="ready",
            last_synced_at=now,
        )
    )
    session.flush()
    for task_id, name in [(_TASK_A, "Task A"), (_TASK_B, "Task B")]:
        session.add(
            ProjectTaskInventoryDB(
                project=_PROJECT,
                task_source_id="src-views",
                task_id=task_id,
                display_name=name,
                folder_path="evals",
                task_path=f"/tasks/{task_id}",
                source_type="filesystem",
            )
        )
    session.add(AgentTaskBatchRunDB(id="batch-views", project=_PROJECT, created_at=now, status="completed", total_tasks=3, task_root="/tasks", environment="default", selection_type="task"))
    # task-a: Opus passed + DeepSeek failed (so the two views disagree)
    # task-b: Opus passed only (missing under DeepSeek)
    session.add(_configured_run("run-a-opus", "batch-views", _TASK_A, "claude-opus-4.1", "high", "passed", True, now))
    session.add(_configured_run("run-a-deep", "batch-views", _TASK_A, "deepseek-v3", None, "failed", False, now))
    session.add(_configured_run("run-b-opus", "batch-views", _TASK_B, "claude-opus-4.1", "medium", "passed", True, now))
    session.commit()


def _configured_run(
    run_id: str,
    batch_id: str,
    task_id: str,
    model: str,
    effort: str | None,
    status: str,
    pass_result: bool,
    started_at: datetime,
) -> AgentTaskRunDB:
    return AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch_id,
        task_id=task_id,
        task_path=f"/tasks/{task_id}",
        status=status,
        pass_result=pass_result,
        configured_model=model,
        configured_effort=effort,
        started_at=started_at,
        completed_at=started_at,
    )


@pytest.fixture(name="view_client")
def view_client_fixture(session: Session, make_authed_client):
    _seed_view_project(session)
    return make_authed_client(_OWNER, session)


def test_run_stats_narrow_to_model_view(view_client: TestClient) -> None:
    """?model= scopes the cohort so pass_rate differs from all-history."""
    all_history = view_client.get(f"/v1/projects/{_PROJECT}/agent-task-run-stats")
    assert all_history.status_code == 200
    by_task_all = all_history.json()
    # task-a: 1 pass + 1 fail across both models -> 0.5
    assert by_task_all[_TASK_A]["total_runs"] == 2
    assert by_task_all[_TASK_A]["pass_rate"] == 0.5

    opus = view_client.get(
        f"/v1/projects/{_PROJECT}/agent-task-run-stats",
        params={"model": "claude-opus-4.1"},
    )
    assert opus.status_code == 200
    by_task_opus = opus.json()
    # task-a under Opus: only the pass -> 1.0
    assert by_task_opus[_TASK_A]["total_runs"] == 1
    assert by_task_opus[_TASK_A]["pass_rate"] == 1.0


def test_run_stats_effort_narrows_within_model(view_client: TestClient) -> None:
    """?effort= further narrows within a model's runs."""
    opus_high = view_client.get(
        f"/v1/projects/{_PROJECT}/agent-task-run-stats",
        params={"model": "claude-opus-4.1", "effort": "high"},
    )
    assert opus_high.status_code == 200
    by_task = opus_high.json()
    # only task-a ran under Opus+high (task-b was Opus+medium) -> task-b absent
    assert _TASK_A in by_task
    assert _TASK_B not in by_task


def test_run_config_facets_populate_filter_palette(view_client: TestClient) -> None:
    """Facets return one entry per model with the per-effort breakdown."""
    resp = view_client.get(f"/v1/projects/{_PROJECT}/agent-task-run-config-facets")
    assert resp.status_code == 200
    facets = {f["model"]: f for f in resp.json()}
    assert set(facets) == {"claude-opus-4.1", "deepseek-v3"}
    opus_efforts = {e["effort"] for e in facets["claude-opus-4.1"]["efforts"]}
    # Opus ran at both high (task-a) and medium (task-b)
    assert opus_efforts == {"high", "medium"}
    # DeepSeek ran with no effort -> no effort facet (null excluded)
    assert facets["deepseek-v3"]["efforts"] == []


def test_run_stats_require_project_membership(session: Session, make_authed_client) -> None:
    """A non-member gets 403, not the stats. Guards the require_project_member wiring."""
    _seed_view_project(session)
    # different user, not a member of _PROJECT
    other = make_authed_client("intruder", session)
    resp = other.get(f"/v1/projects/{_PROJECT}/agent-task-run-stats")
    assert resp.status_code == 403
