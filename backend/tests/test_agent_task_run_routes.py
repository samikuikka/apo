"""Regression coverage for task-detail run-history routing."""

# pyright: reportAny=false

from datetime import datetime, timedelta, timezone

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


def test_legacy_task_discovery_routes_are_unregistered() -> None:
    """The unscoped filesystem discovery routes were removed: task
    listing must go through the project-scoped inventory
    routes, never a client-named ``task_root``."""
    route_paths = {
        route.path for route in app.routes if isinstance(route, APIRoute)
    }

    assert "/v1/agent-tasks/{task_id:path}" not in route_paths
    assert "/v1/agent-tasks" not in route_paths
    assert "/v1/agent-tasks/{task_id:path}/files" not in route_paths
    assert "/v1/agent-tasks/{task_id:path}/files/{file_path:path}" not in route_paths


def test_batch_list_projects_configuration_summary(
    client: TestClient,
    session: Session,
) -> None:
    """Batch list derives uniform/mixed/partial/unknown from children."""
    now = datetime.now(timezone.utc)
    session.add_all(
        [
            _batch("batch-uniform", "p", now),
            _batch("batch-mixed", "p", now),
            _batch("batch-partial", "p", now),
            _batch("batch-unknown", "p", now),
        ]
    )
    session.add_all(
        [
            _configured_run("u1", "batch-uniform", "terra", "high", now),
            _configured_run("u2", "batch-uniform", "terra", "high", now),
            _configured_run("m1", "batch-mixed", "terra", "low", now),
            _configured_run("m2", "batch-mixed", "opus", "high", now),
            _configured_run("p1", "batch-partial", "terra", "high", now),
            _configured_run("p2", "batch-partial", None, None, now),
            _configured_run("k1", "batch-unknown", None, None, now),
        ]
    )
    session.commit()

    response = client.get("/v1/agent-task-batch-runs", params={"project": "p"})
    assert response.status_code == 200
    by_id = {b["id"]: b for b in response.json()["data"]}

    uniform = by_id["batch-uniform"]["configuration"]
    assert uniform["state"] == "uniform"
    assert uniform["reported_task_runs"] == 2
    assert {(c["model"], c["effort"], c["task_runs"]) for c in uniform["configurations"]} == {
        ("terra", "high", 2)
    }

    mixed = by_id["batch-mixed"]["configuration"]
    assert mixed["state"] == "mixed"
    assert {(c["model"], c["effort"], c["task_runs"]) for c in mixed["configurations"]} == {
        ("terra", "low", 1),
        ("opus", "high", 1),
    }

    partial = by_id["batch-partial"]["configuration"]
    assert partial["state"] == "partial"
    assert partial["reported_task_runs"] == 1
    assert partial["total_task_runs"] == 2

    unknown = by_id["batch-unknown"]["configuration"]
    assert unknown["state"] == "unknown"
    assert unknown["configurations"] == []


def test_task_run_list_projects_nested_run_configuration(
    client: TestClient,
    session: Session,
) -> None:
    """Task run list carries nested run_configuration per row."""
    now = datetime.now(timezone.utc)
    session.add_all([_batch("batch-cfg", "p", now)])
    session.add_all(
        [
            _configured_run("cfg-reported", "batch-cfg", "claude-opus-4.1", "high", now),
            _configured_run("cfg-unknown", "batch-cfg", None, None, now),
        ]
    )
    session.commit()

    response = client.get("/v1/agent-task-runs", params={"project": "p"})
    assert response.status_code == 200
    by_id = {r["id"]: r for r in response.json()}

    reported = by_id["cfg-reported"]["run_configuration"]
    assert reported == {"model": "claude-opus-4.1", "effort": "high"}

    assert by_id["cfg-unknown"]["run_configuration"] is None


def _configured_run(
    run_id: str,
    batch_id: str,
    configured_model: str | None,
    configured_effort: str | None,
    started_at: datetime,
) -> AgentTaskRunDB:
    run = _run(run_id, batch_id, "task-1", started_at)
    run.configured_model = configured_model
    run.configured_effort = configured_effort
    return run


# ============================================================================
# model/effort query filters
# ============================================================================


def test_task_run_list_filters_model_with_or_within_dimension(
    client: TestClient,
    session: Session,
) -> None:
    """Repeated ?model= values OR; a run matches if its model is any of them."""
    now = datetime.now(timezone.utc)
    session.add_all([_batch("b", "proj-filter", now)])
    session.add_all(
        [
            _configured_run("r-terra", "b", "gpt-5.6-terra", "high", now),
            _configured_run("r-opus", "b", "claude-opus-4.1", "high", now),
            _configured_run("r-other", "b", "gemini-2.5", "high", now),
        ]
    )
    session.commit()

    resp = client.get(
        "/v1/agent-task-runs",
        params=[("project", "proj-filter"), ("model", "gpt-5.6-terra"), ("model", "claude-opus-4.1")],
    )
    assert resp.status_code == 200
    ids = {r["id"] for r in resp.json()}
    assert ids == {"r-terra", "r-opus"}


def test_task_run_list_filters_model_and_effort_with_and_across_dimensions(
    client: TestClient,
    session: Session,
) -> None:
    """model and effort AND: only runs matching both dimensions return."""
    now = datetime.now(timezone.utc)
    session.add_all([_batch("b", "proj-filter", now)])
    session.add_all(
        [
            _configured_run("r-th", "b", "terra", "high", now),
            _configured_run("r-tl", "b", "terra", "low", now),
            _configured_run("r-oh", "b", "opus", "high", now),
        ]
    )
    session.commit()

    resp = client.get(
        "/v1/agent-task-runs",
        params={"project": "proj-filter", "model": "terra", "effort": "high"},
    )
    assert resp.status_code == 200
    ids = {r["id"] for r in resp.json()}
    assert ids == {"r-th"}


def test_task_run_list_filter_is_exact_but_case_insensitive(
    client: TestClient,
    session: Session,
) -> None:
    """Matching ignores case so a hand-edited URL never silently empties the list."""
    now = datetime.now(timezone.utc)
    session.add_all([_batch("b", "proj-filter", now)])
    session.add_all([_configured_run("r", "b", "Terra", "High", now)])
    session.commit()

    # Different case still matches, for model and effort alike.
    assert {r["id"] for r in client.get("/v1/agent-task-runs", params={"project": "proj-filter", "model": "terra"}).json()} == {"r"}
    assert {r["id"] for r in client.get("/v1/agent-task-runs", params={"project": "proj-filter", "model": "TERRA"}).json()} == {"r"}
    assert {r["id"] for r in client.get("/v1/agent-task-runs", params={"project": "proj-filter", "effort": "high"}).json()} == {"r"}
    # A different value still does not match (exact, not substring).
    assert {r["id"] for r in client.get("/v1/agent-task-runs", params={"project": "proj-filter", "model": "terrax"}).json()} == set()


def test_task_run_list_filters_status_repeated_with_or(
    client: TestClient,
    session: Session,
) -> None:
    """Repeated ?status= values OR; a run matches if its status is any of them."""
    now = datetime.now(timezone.utc)
    session.add_all([_batch("b", "proj-status", now)])
    runs = [
        _run("r-pass", "b", "task-1", now),
        _run("r-fail", "b", "task-1", now),
        _run("r-err", "b", "task-1", now),
    ]
    runs[1].status = "failed"
    runs[1].pass_result = False
    runs[2].status = "error"
    runs[2].pass_result = None
    session.add_all(runs)
    session.commit()

    resp = client.get(
        "/v1/agent-task-runs",
        params=[("project", "proj-status"), ("status", "passed"), ("status", "failed")],
    )
    assert resp.status_code == 200
    assert {r["id"] for r in resp.json()} == {"r-pass", "r-fail"}


def test_task_run_list_single_status_param_still_filters(
    client: TestClient,
    session: Session,
) -> None:
    """A single ?status= value (the legacy URL shape) keeps working."""
    now = datetime.now(timezone.utc)
    session.add_all([_batch("b", "proj-status", now)])
    runs = [_run("r-pass", "b", "task-1", now), _run("r-fail", "b", "task-1", now)]
    runs[1].status = "failed"
    runs[1].pass_result = False
    session.add_all(runs)
    session.commit()

    assert {r["id"] for r in client.get("/v1/agent-task-runs", params={"project": "proj-status", "status": "passed"}).json()} == {"r-pass"}


def test_task_run_list_status_filter_is_case_insensitive_on_input(
    client: TestClient,
    session: Session,
) -> None:
    now = datetime.now(timezone.utc)
    session.add_all([_batch("b", "proj-status", now)])
    session.add_all([_run("r-pass", "b", "task-1", now)])
    session.commit()

    assert {r["id"] for r in client.get("/v1/agent-task-runs", params={"project": "proj-status", "status": "PASSED"}).json()} == {"r-pass"}


def test_task_run_list_null_configuration_never_matches_model_or_effort(
    client: TestClient,
    session: Session,
) -> None:
    """Documented invariant, regression-guarded: unconfigured runs stay invisible to config filters."""
    now = datetime.now(timezone.utc)
    session.add_all([_batch("b", "proj-null", now)])
    session.add_all(
        [
            _run("r-unconfigured", "b", "task-1", now),
            _configured_run("r-configured", "b", "terra", "high", now),
        ]
    )
    session.commit()

    base = {"project": "proj-null"}
    assert {r["id"] for r in client.get("/v1/agent-task-runs", params={**base, "model": "terra"}).json()} == {"r-configured"}
    assert {r["id"] for r in client.get("/v1/agent-task-runs", params={**base, "effort": "high"}).json()} == {"r-configured"}
    # Case-insensitive matching must not turn NULL into a match either.
    assert {r["id"] for r in client.get("/v1/agent-task-runs", params={**base, "model": "TERRA"}).json()} == {"r-configured"}


def test_task_run_list_combines_status_with_model_and_since(
    client: TestClient,
    session: Session,
) -> None:
    """status ANDs with the other dimensions (it does not replace them)."""
    now = datetime.now(timezone.utc)
    session.add_all([_batch("b", "proj-combined", now)])
    fresh_pass = _configured_run("r-fresh-pass", "b", "terra", "high", now - timedelta(hours=2))
    fresh_fail = _configured_run("r-fresh-fail", "b", "terra", "high", now - timedelta(hours=3))
    fresh_fail.status = "failed"
    fresh_fail.pass_result = False
    stale_pass = _configured_run("r-stale-pass", "b", "terra", "high", now - timedelta(days=9))
    session.add_all([fresh_pass, fresh_fail, stale_pass])
    session.commit()

    resp = client.get(
        "/v1/agent-task-runs",
        params={"project": "proj-combined", "model": "terra", "status": "passed", "since": "7d"},
    )
    assert resp.status_code == 200
    assert {r["id"] for r in resp.json()} == {"r-fresh-pass"}


def test_task_run_list_filters_since_window_over_started_at(
    client: TestClient,
    session: Session,
) -> None:
    """?since=Nd keeps only runs newer than the cutoff (the evidence-view vocabulary)."""
    now = datetime.now(timezone.utc)
    session.add_all([_batch("b", "proj-since", now)])
    session.add_all(
        [
            _run("r-fresh", "b", "task-1", now - timedelta(hours=2)),
            _run("r-stale", "b", "task-1", now - timedelta(days=9)),
        ]
    )
    session.commit()

    base = "/v1/agent-task-runs"
    assert {r["id"] for r in client.get(base, params={"project": "proj-since"}).json()} == {"r-fresh", "r-stale"}
    assert {r["id"] for r in client.get(base, params={"project": "proj-since", "since": "7d"}).json()} == {"r-fresh"}
    # Unparseable presets degrade to all-time, matching the view-cohort rule.
    assert {r["id"] for r in client.get(base, params={"project": "proj-since", "since": "nope"}).json()} == {"r-fresh", "r-stale"}


def test_batch_run_list_filter_matches_only_when_one_child_satisfies_all_dimensions(
    client: TestClient,
    session: Session,
) -> None:
    """A batch matches ?model=X&effort=Y only if ONE child has BOTH.

    Never model from one child and effort from another — that would invent a
    configuration that never ran.
    """
    now = datetime.now(timezone.utc)
    session.add_all(
        [
            _batch("b-split", "proj-filter", now),  # terra/low + opus/high
            _batch("b-real", "proj-filter", now),   # terra/high (real pair)
        ]
    )
    session.add_all(
        [
            _configured_run("s1", "b-split", "terra", "low", now),
            _configured_run("s2", "b-split", "opus", "high", now),
            _configured_run("r1", "b-real", "terra", "high", now),
        ]
    )
    session.commit()

    resp = client.get(
        "/v1/agent-task-batch-runs",
        params={"project": "proj-filter", "model": "terra", "effort": "high"},
    )
    assert resp.status_code == 200
    ids = {b["id"] for b in resp.json()["data"]}
    # b-split has terra (s1) and high (s2) but no single child with terra+high.
    assert ids == {"b-real"}


def test_batch_run_list_status_filter_ors_comma_joined_values(
    client: TestClient,
    session: Session,
) -> None:
    """?status=completed,failed ORs the statuses, like model/effort.

    The old single-equality filter made the dashboard's "Passed" option a
    silent no-op (batches are never "passed"), and multi-select needs OR.
    Input is case-insensitive so a hand-typed "Completed" still filters.
    """
    now = datetime.now(timezone.utc)
    session.add_all(
        [
            _batch("b-done", "proj-status-multi", now, status="completed"),
            _batch("b-fail", "proj-status-multi", now, status="failed"),
            _batch("b-live", "proj-status-multi", now, status="running"),
        ]
    )
    session.commit()

    resp = client.get(
        "/v1/agent-task-batch-runs",
        params={"project": "proj-status-multi", "status": "Completed,failed"},
    )
    assert resp.status_code == 200
    assert {b["id"] for b in resp.json()["data"]} == {"b-done", "b-fail"}


def test_batch_list_backfills_task_selection_from_children(
    client: TestClient,
    session: Session,
) -> None:
    """A batch with no stored selection projects one derived from its children.

    Caller (CLI) batches created before the selection snapshot landed have
    ``selection_query = None``, which makes the Runs list fall back to naming
    them by selection type ("caller-task"). Their children still carry the
    canonical task ids, so the read model derives the selection.
    """
    now = datetime.now(timezone.utc)
    session.add_all(
        [
            _batch("b-caller", "proj-backfill", now, selection_type="caller-task"),
            _batch("b-multi", "proj-backfill", now, selection_type="caller-task"),
            _batch(
                "b-stored",
                "proj-backfill",
                now,
                selection_query={"task_paths": ["stored/selection"]},
            ),
            _batch("b-childless", "proj-backfill", now, selection_type="all"),
        ]
    )
    session.add_all(
        [
            _run("c1", "b-caller", "chat/cost-inquiry", now),
            _run("m1", "b-multi", "chat/cost-inquiry", now),
            _run("m2", "b-multi", "template/styling-ultimate", now),
            _run("s1", "b-stored", "chat/other-task", now),
        ]
    )
    session.commit()

    resp = client.get("/v1/agent-task-batch-runs", params={"project": "proj-backfill"})
    assert resp.status_code == 200
    by_id = {b["id"]: b for b in resp.json()["data"]}

    assert by_id["b-caller"]["selection_query"] == {"task_paths": ["chat/cost-inquiry"]}
    assert by_id["b-multi"]["selection_query"] == {
        "task_paths": ["chat/cost-inquiry", "template/styling-ultimate"]
    }
    # A stored selection is the run's resolved identity — never overwritten.
    assert by_id["b-stored"]["selection_query"] == {"task_paths": ["stored/selection"]}
    # Nothing to derive from: stays null so the list keeps its own fallback.
    assert by_id["b-childless"]["selection_query"] is None


def test_batch_detail_backfills_task_selection_from_children(
    client: TestClient,
    session: Session,
) -> None:
    """The detail read model derives the same selection as the list."""
    now = datetime.now(timezone.utc)
    session.add(_batch("b-detail", "proj-detail", now, selection_type="caller-task"))
    session.add(_run("d1", "b-detail", "chat/cost-inquiry", now))
    session.commit()

    resp = client.get("/v1/agent-task-batch-runs/b-detail")
    assert resp.status_code == 200
    assert resp.json()["selection_query"] == {"task_paths": ["chat/cost-inquiry"]}


# ============================================================================
# limit
# ============================================================================


def test_task_run_list_limit_returns_newest_runs(
    client: TestClient,
    session: Session,
) -> None:
    """limit caps the response over started_at-descending order — the
    endpoint answers "the newest N", never an unbounded dump."""
    now = datetime.now(timezone.utc)
    session.add(_batch("batch-limit", "proj-limit", now))
    session.add_all(
        [
            _run(f"run-limit-{i}", "batch-limit", "task-1", now - timedelta(minutes=i))
            for i in range(5)
        ]
    )
    session.commit()

    resp = client.get(
        "/v1/agent-task-runs", params={"project": "proj-limit", "limit": 2}
    )
    assert resp.status_code == 200
    ids = [r["id"] for r in resp.json()]
    assert ids == ["run-limit-0", "run-limit-1"]


def test_task_run_list_rejects_out_of_range_limit(
    client: TestClient,
    session: Session,
) -> None:
    session.add(_batch("batch-limit-2", "proj-limit-2", datetime.now(timezone.utc)))
    session.commit()

    resp = client.get(
        "/v1/agent-task-runs", params={"project": "proj-limit-2", "limit": 99999}
    )
    assert resp.status_code == 422


def _batch(
    batch_id: str,
    project: str,
    created_at: datetime,
    selection_type: str = "task",
    selection_query: dict[str, object] | None = None,
    status: str = "completed",
) -> AgentTaskBatchRunDB:
    return AgentTaskBatchRunDB(
        id=batch_id,
        project=project,
        selection_type=selection_type,
        selection_query=selection_query,
        task_root="/tmp/tasks",
        environment="default",
        status=status,
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
