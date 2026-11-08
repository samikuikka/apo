# pyright: reportAny=false, reportExplicitAny=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportCallIssue=false

"""Serving read side through the registered routes: breakdowns, filters, isolation.

Covers the run and batch serving endpoints (bounded summaries on list/detail,
paged breakdowns, same-request query filters with 422 validation), the saved
Task View serving-filter round trip, and comparison snapshots freezing each
side's serving evidence while older snapshots deserialize with null serving.
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    LoggedCallDB,
    TaskDefinitionRevisionDB,
    TaskViewComparisonDB,
    UserDB,
)
from tests.conftest import seed_project_for_user

_NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
_PROJECT = "serving-routes"
_OWNER = "owner-serving-routes"


def _batch(batch_id: str, project: str = _PROJECT) -> AgentTaskBatchRunDB:
    return AgentTaskBatchRunDB(
        id=batch_id,
        project=project,
        selection_type="task",
        task_root="/tmp/tasks",
        environment="default",
        status="completed",
        total_tasks=1,
        created_at=_NOW,
    )


def _run(
    run_id: str,
    batch_id: str,
    *,
    trace_run_id: str | None = None,
    configured_model: str | None = None,
    task_id: str = "task-1",
) -> AgentTaskRunDB:
    return AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch_id,
        task_id=task_id,
        task_path=f"/tmp/tasks/{task_id}",
        status="passed",
        pass_result=True,
        trace_run_id=trace_run_id,
        configured_model=configured_model,
        started_at=_NOW,
        completed_at=_NOW,
    )


def _call(
    span: str,
    trace_run_id: str,
    *,
    project: str = _PROJECT,
    model: str = "example-model",
    api_provider: str | None = None,
    serving_host: str | None = None,
    route: str | None = None,
    accounting: str | None = "request",
    level: str = "DEFAULT",
    completion_tokens: int | None = 100,
) -> LoggedCallDB:
    return LoggedCallDB(
        id=span,
        run_id=trace_run_id,
        project=project,
        task_id="",
        created_at=_NOW,
        end_time=_NOW + timedelta(seconds=2),
        model=model,
        observed_model=model,
        api_provider=api_provider,
        serving_host=serving_host,
        route=route,
        request_accounting=accounting,
        observation_type="GENERATION",
        level=level,
        completion_tokens=completion_tokens,
        input={},
        messages=[],
        output={},
    )


def _seed_openrouter_baseten(session: Session) -> None:
    """One run served uniformly through OpenRouter/Baseten plus a wrapper."""
    session.add(_batch("batch-srv"))
    session.add(_run("run-srv", "batch-srv", trace_run_id="trace-srv"))
    session.add_all(
        [
            _call(
                "call-1",
                "trace-srv",
                api_provider="openrouter",
                serving_host="baseten",
                route="nitro",
            ),
            _call("call-2", "trace-srv", api_provider="openrouter", serving_host="baseten"),
            _call("call-agg", "trace-srv", accounting="aggregate"),
        ]
    )
    session.commit()


# ============================================================================
# Run list / detail summaries
# ============================================================================


def test_run_list_and_detail_carry_serving_summaries(
    client: TestClient, session: Session
) -> None:
    _seed_openrouter_baseten(session)

    items = client.get("/v1/agent-task-runs", params={"project": _PROJECT}).json()
    assert len(items) == 1
    serving = items[0]["serving"]
    assert serving is not None
    # One uniform request tuple plus an aggregate wrapper: partial.
    assert serving["state"] == "partial"
    assert serving["calls"] == 2
    assert serving["aggregate_observations"] == 1
    assert serving["task_runs_with_evidence"] == 1
    assert serving["task_runs_total"] == 1
    assert serving["groups"][0]["identity"]["api_provider"] == "openrouter"

    detail = client.get("/v1/agent-task-runs/run-srv").json()["serving"]
    assert detail == serving


def test_run_without_trace_reports_no_data(client: TestClient, session: Session) -> None:
    session.add(_batch("batch-empty"))
    session.add(_run("run-empty", "batch-empty"))
    session.commit()

    body = client.get("/v1/agent-task-runs/run-empty").json()
    assert body["serving"]["state"] == "no_data"
    assert body["serving"]["calls"] == 0


# ============================================================================
# Breakdown endpoints
# ============================================================================


def _seed_three_groups(session: Session) -> None:
    session.add(_batch("batch-groups"))
    session.add(_run("run-groups", "batch-groups", trace_run_id="trace-groups"))
    session.add_all(
        [
            _call("g1a", "trace-groups", model="m1", api_provider="openrouter", serving_host="baseten"),
            _call("g1b", "trace-groups", model="m1", api_provider="openrouter", serving_host="baseten"),
            _call("g2", "trace-groups", model="m2", api_provider="fireworks", serving_host="fireworks"),
            _call("g3", "trace-groups", model="m3"),
        ]
    )
    session.commit()


def test_run_breakdown_pages_all_groups(client: TestClient, session: Session) -> None:
    _seed_three_groups(session)

    first = client.get("/v1/agent-task-runs/run-groups/serving").json()
    assert first["total_groups"] == 3
    assert first["offset"] == 0
    assert first["limit"] == 50
    # Calls-descending order: the two-call group leads.
    assert [g["identity"]["model"] for g in first["groups"]] == ["m1", "m2", "m3"]

    page = client.get(
        "/v1/agent-task-runs/run-groups/serving", params={"offset": 1, "limit": 1}
    ).json()
    assert page["total_groups"] == 3
    assert [g["identity"]["model"] for g in page["groups"]] == ["m2"]

    tail = client.get(
        "/v1/agent-task-runs/run-groups/serving", params={"offset": 3, "limit": 10}
    ).json()
    assert tail["groups"] == []


def test_breakdown_pagination_is_validated(client: TestClient, session: Session) -> None:
    session.add(_batch("batch-pg"))
    session.add(_run("run-pg", "batch-pg", trace_run_id="trace-pg"))
    session.add(_call("pg-1", "trace-pg"))
    session.commit()

    for params in (
        {"offset": -1},
        {"limit": 0},
        {"limit": 101},
    ):
        resp = client.get("/v1/agent-task-runs/run-pg/serving", params=params)
        assert resp.status_code == 422, params
        resp = client.get("/v1/agent-task-batch-runs/batch-pg/serving", params=params)
        assert resp.status_code == 422, params


def test_batch_breakdown_unions_child_traces(client: TestClient, session: Session) -> None:
    session.add(_batch("batch-union"))
    session.add(_run("run-u1", "batch-union", trace_run_id="trace-u1"))
    session.add(_run("run-u2", "batch-union", trace_run_id="trace-u2"))
    session.add(_run("run-u3", "batch-union"))
    session.add_all(
        [
            _call("u1", "trace-u1", model="m1", api_provider="openrouter", serving_host="baseten"),
            _call("u2", "trace-u2", model="m2", api_provider="fireworks", serving_host="fireworks"),
        ]
    )
    session.commit()

    body = client.get("/v1/agent-task-batch-runs/batch-union/serving").json()
    assert body["total_groups"] == 2

    detail = client.get("/v1/agent-task-batch-runs/batch-union").json()
    # Batch-level coverage: one child has no trace at all.
    assert detail["serving"]["task_runs_total"] == 3
    assert detail["serving"]["task_runs_with_evidence"] == 2
    assert detail["serving"]["state"] == "partial"
    # Each child summary rides along on the batch detail.
    child_servings = {r["id"]: r["serving"] for r in detail["task_runs"]}
    assert child_servings["run-u1"]["state"] == "uniform"
    assert child_servings["run-u3"]["state"] == "no_data"


# ============================================================================
# Run list serving filters
# ============================================================================


def _seed_filter_runs(session: Session) -> None:
    """Three runs: combined OpenRouter/Baseten; split OpenRouter/Fireworks
    plus direct Baseten; uniform Fireworks."""
    session.add(_batch("batch-f"))
    session.add(_run("run-combined", "batch-f", trace_run_id="trace-combined"))
    session.add(_run("run-split", "batch-f", trace_run_id="trace-split"))
    session.add(_run("run-fw", "batch-f", trace_run_id="trace-fw"))
    session.add_all(
        [
            _call("c1", "trace-combined", api_provider="openrouter", serving_host="baseten"),
            _call("s1", "trace-split", api_provider="openrouter", serving_host="fireworks"),
            _call("s2", "trace-split", api_provider=None, serving_host="baseten"),
            _call("f1", "trace-fw", api_provider="fireworks", serving_host="fireworks"),
        ]
    )
    session.commit()


def test_provider_host_filter_ands_on_the_same_call(
    client: TestClient, session: Session
) -> None:
    _seed_filter_runs(session)

    ids = {
        r["id"]
        for r in client.get(
            "/v1/agent-task-runs",
            params=[
                ("project", _PROJECT),
                ("provider", "openrouter"),
                ("host", "baseten"),
            ],
        ).json()
    }
    # The split run has OpenRouter and Baseten, but never on one request.
    assert ids == {"run-combined"}


def test_serving_unknown_matches_null_dimension(client: TestClient, session: Session) -> None:
    _seed_filter_runs(session)

    ids = {
        r["id"]
        for r in client.get(
            "/v1/agent-task-runs",
            params=[("project", _PROJECT), ("serving_unknown", "provider")],
        ).json()
    }
    assert ids == {"run-split"}


def test_serving_mode_only_selects_uniform_complete_runs(
    client: TestClient, session: Session
) -> None:
    _seed_filter_runs(session)

    ids = {
        r["id"]
        for r in client.get(
            "/v1/agent-task-runs",
            params=[("project", _PROJECT), ("serving_mode", "only")],
        ).json()
    }
    assert ids == {"run-fw", "run-combined"}

    ids = {
        r["id"]
        for r in client.get(
            "/v1/agent-task-runs",
            params=[
                ("project", _PROJECT),
                ("provider", "fireworks"),
                ("serving_mode", "only"),
            ],
        ).json()
    }
    assert ids == {"run-fw"}


def test_observed_model_and_route_filters(client: TestClient, session: Session) -> None:
    session.add(_batch("batch-mr"))
    session.add(_run("run-nitro", "batch-mr", trace_run_id="trace-nitro"))
    session.add(_run("run-plain", "batch-mr", trace_run_id="trace-plain"))
    session.add_all(
        [
            _call("n1", "trace-nitro", model="m1", api_provider="openrouter", route="nitro"),
            _call("p1", "trace-plain", model="m2", api_provider="openrouter"),
        ]
    )
    session.commit()

    ids = {
        r["id"]
        for r in client.get(
            "/v1/agent-task-runs",
            params=[("project", _PROJECT), ("route", "nitro")],
        ).json()
    }
    assert ids == {"run-nitro"}

    ids = {
        r["id"]
        for r in client.get(
            "/v1/agent-task-runs",
            params=[("project", _PROJECT), ("observed_model", "m1"), ("observed_model", "m2")],
        ).json()
    }
    assert ids == {"run-nitro", "run-plain"}


def test_invalid_serving_params_are_422(client: TestClient, session: Session) -> None:
    session.add(_batch("batch-422"))
    session.commit()

    resp = client.get(
        "/v1/agent-task-runs",
        params=[("project", _PROJECT), ("serving_unknown", "bogus")],
    )
    assert resp.status_code == 422

    resp = client.get(
        "/v1/agent-task-runs",
        params=[("project", _PROJECT), ("serving_mode", "sometimes")],
    )
    assert resp.status_code == 422

    resp = client.get(
        "/v1/agent-task-batch-runs",
        params=[("project", _PROJECT), ("serving_unknown", "nope")],
    )
    assert resp.status_code == 422


# ============================================================================
# Batch list serving filter
# ============================================================================


def test_batch_list_serving_filter_selects_batches_with_matching_child(
    client: TestClient, session: Session
) -> None:
    session.add_all([_batch("batch-or"), _batch("batch-fw-only")])
    session.add(_run("bor", "batch-or", trace_run_id="trace-or"))
    session.add(_run("bor2", "batch-or", trace_run_id="trace-or2"))
    session.add(_run("bfw", "batch-fw-only", trace_run_id="trace-fw2"))
    session.add_all(
        [
            _call("or1", "trace-or", api_provider="openrouter", serving_host="baseten"),
            _call("or2", "trace-or2", api_provider="fireworks", serving_host="fireworks"),
            _call("fw1", "trace-fw2", api_provider="fireworks", serving_host="fireworks"),
        ]
    )
    session.commit()

    resp = client.get(
        "/v1/agent-task-batch-runs",
        params=[("project", _PROJECT), ("host", "baseten")],
    )
    assert resp.status_code == 200
    assert [b["id"] for b in resp.json()["data"]] == ["batch-or"]

    # List items carry the child-derived summary.
    unfiltered = client.get(
        "/v1/agent-task-batch-runs", params={"project": _PROJECT}
    ).json()["data"]
    by_id = {b["id"]: b for b in unfiltered}
    assert by_id["batch-or"]["serving"]["total_groups"] == 2
    assert by_id["batch-or"]["serving"]["task_runs_total"] == 2
    assert by_id["batch-or"]["serving"]["task_runs_with_evidence"] == 2
    assert by_id["batch-fw-only"]["serving"]["total_groups"] == 1


# ============================================================================
# Project isolation
# ============================================================================


@pytest.fixture(name="serving_project")
def serving_project_fixture(session: Session) -> None:
    session.add(UserDB(id=_OWNER, email="owner@test", name="Owner", password_hash="x"))
    session.flush()
    seed_project_for_user(session, _OWNER, project_id=_PROJECT)


def test_breakdown_denies_foreign_project_runs(
    session: Session, serving_project: None, make_authed_client
) -> None:
    session.add(_batch("batch-iso"))
    session.add(_run("run-iso", "batch-iso", trace_run_id="trace-iso"))
    session.add(_call("iso1", "trace-iso", api_provider="openrouter"))
    session.commit()

    intruder = make_authed_client("intruder-serving", session, is_admin=False)
    resp = intruder.get("/v1/agent-task-runs/run-iso/serving")
    assert resp.status_code == 404
    resp = intruder.get("/v1/agent-task-batch-runs/batch-iso/serving")
    assert resp.status_code == 404
    # A member still reads it: the 404 above is authorization, not absence.
    owner = make_authed_client(_OWNER, session)
    assert owner.get("/v1/agent-task-runs/run-iso/serving").status_code == 200


# ============================================================================
# Saved Task Views round trip
# ============================================================================


@pytest.fixture(name="views_client")
def views_client_fixture(session: Session, make_authed_client) -> TestClient:
    session.add(UserDB(id=_OWNER, email="owner-sr@test", name="Owner", password_hash="x"))
    session.flush()
    seed_project_for_user(session, _OWNER, project_id=_PROJECT)
    return make_authed_client(_OWNER, session)


def test_task_view_serving_filter_round_trip(
    views_client: TestClient,
) -> None:
    created = views_client.post(
        f"/v1/projects/{_PROJECT}/task-views",
        json={
            "label": "OR/Baseten",
            "serving_filter": {
                "providers": ["openrouter"],
                "hosts": ["baseten"],
                "mode": "only",
            },
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["serving_filter"] == {
        "observed_models": [],
        "providers": ["openrouter"],
        "hosts": ["baseten"],
        "routes": [],
        "service_tiers": [],
        "unknown": [],
        "mode": "only",
    }

    updated = views_client.patch(
        f"/v1/projects/{_PROJECT}/task-views/{body['id']}",
        json={"serving_filter": {"providers": ["fireworks"]}},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["serving_filter"]["providers"] == ["fireworks"]
    assert updated.json()["serving_filter"]["mode"] == "contains"

    cleared = views_client.patch(
        f"/v1/projects/{_PROJECT}/task-views/{body['id']}",
        json={"serving_filter": None},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["serving_filter"] is None


# ============================================================================
# Comparison snapshots
# ============================================================================


def _seed_comparison_evidence(session: Session) -> None:
    session.add(UserDB(id=_OWNER, email="owner-cmp@test", name="Owner", password_hash="x"))
    session.flush()
    seed_project_for_user(session, _OWNER, project_id=_PROJECT)
    session.add_all([_batch("batch-cmp-a"), _batch("batch-cmp-b")])
    session.flush()
    session.add(
        TaskDefinitionRevisionDB(
            id="d-cmp",
            project=_PROJECT,
            task_id="task-cmp",
            content_sha256="a" * 64,
            source_size_bytes=1,
        )
    )
    session.add_all(
        [
            _run(
                "cmp-a",
                "batch-cmp-a",
                trace_run_id="trace-cmp-a",
                configured_model="model-a",
                task_id="task-cmp",
            ),
            _run(
                "cmp-b",
                "batch-cmp-b",
                trace_run_id="trace-cmp-b",
                configured_model="model-b",
                task_id="task-cmp",
            ),
        ]
    )
    for run_id in ("cmp-a", "cmp-b"):
        run = session.get(AgentTaskRunDB, run_id)
        assert run is not None
        run.task_definition_revision_id = "d-cmp"
        session.add(run)
    session.add_all(
        [
            _call(
                "cmp-a1",
                "trace-cmp-a",
                model="model-a",
                api_provider="openrouter",
                serving_host="baseten",
            ),
            _call(
                "cmp-b1",
                "trace-cmp-b",
                model="model-b",
                api_provider="fireworks",
                serving_host="fireworks",
            ),
        ]
    )
    session.commit()


@pytest.fixture(name="cmp_client")
def cmp_client_fixture(session: Session, make_authed_client) -> TestClient:
    _seed_comparison_evidence(session)
    return make_authed_client(_OWNER, session)


def test_comparison_freezes_serving_evidence(
    cmp_client: TestClient, session: Session
) -> None:
    created = cmp_client.post(
        f"/v1/projects/{_PROJECT}/task-view-comparisons",
        json={
            "task_ids": ["task-cmp"],
            "view_a": {
                "model": "model-a",
                "serving_filter": {"providers": ["openrouter"], "hosts": ["baseten"]},
            },
            "view_b": {"model": "model-b"},
        },
    )
    assert created.status_code == 201, created.text
    snapshot = created.json()
    cell = snapshot["resolved"][0]
    assert cell["a_run_id"] == "cmp-a"
    assert cell["b_run_id"] == "cmp-b"
    assert cell["a_serving"]["state"] == "uniform"
    assert cell["a_serving"]["groups"][0]["identity"]["api_provider"] == "openrouter"
    assert cell["a_serving"]["cost_coverage"] is not None
    assert cell["b_serving"]["groups"][0]["identity"]["api_provider"] == "fireworks"
    # The per-side serving filter freezes inside the view config.
    assert snapshot["view_a_config"]["serving_filter"]["providers"] == ["openrouter"]

    # Late evidence must not rewrite the frozen snapshot.
    session.add(
        _call(
            "cmp-a-late",
            "trace-cmp-a",
            model="model-a",
            api_provider="fireworks",
            serving_host="fireworks",
        )
    )
    session.commit()
    reread = cmp_client.get(
        f"/v1/projects/{_PROJECT}/task-view-comparisons/{snapshot['id']}"
    ).json()
    assert reread["resolved"][0] == cell


def test_old_snapshot_deserializes_with_null_serving(
    cmp_client: TestClient, session: Session
) -> None:
    # A pre-feature snapshot row: cells carry no serving keys at all.
    session.add(
        TaskViewComparisonDB(
            id="tvc_old000000000",
            project_id=_PROJECT,
            view_a_config={"model": "model-a"},
            view_b_config={"model": "model-b"},
            task_ids=["task-cmp"],
            resolved=[
                {
                    "task_id": "task-cmp",
                    "a_run_id": "cmp-a",
                    "b_run_id": "cmp-b",
                    "a_status": "passed",
                    "b_status": "passed",
                    "state": "aligned",
                }
            ],
            coverage={"both_run": 1, "aligned": 1, "scope": 1},
            created_by=_OWNER,
        )
    )
    session.commit()

    resp = cmp_client.get(f"/v1/projects/{_PROJECT}/task-view-comparisons/tvc_old000000000")
    assert resp.status_code == 200, resp.text
    cell = resp.json()["resolved"][0]
    assert cell["a_serving"] is None
    assert cell["b_serving"] is None
