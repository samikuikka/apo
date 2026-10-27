# pyright: reportAny=false, reportArgumentType=false, reportAttributeAccessIssue=false, reportCallIssue=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUntypedFunctionDecorator=false, reportUnusedParameter=false

"""Run labels (``run_metadata.labels``) and environment scoping.

Covers the write-side validation on every Batch-creating request, the
environment/label filters on both run lists (the Task Run list filtering
through its Batch), and the label facets the dashboard populates its
filters from.
"""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB, ProjectDB
from apo.services import executor_auth

_NOW = datetime.now(timezone.utc)
PROJECT = "proj-labels"


def _label(label_id: str, name: str) -> dict[str, str]:
    return {"id": label_id, "name": name}


def _batch(
    batch_id: str,
    *,
    environment: str = "default",
    labels: dict[str, dict[str, str]] | None = None,
    age_minutes: int = 0,
    project: str = PROJECT,
) -> AgentTaskBatchRunDB:
    metadata: dict[str, object] = {"trigger": {"source": "api"}}
    if labels is not None:
        metadata["labels"] = labels
    return AgentTaskBatchRunDB(
        id=batch_id,
        project=project,
        selection_type="caller-task",
        environment=environment,
        run_metadata=metadata,
        status="completed",
        total_tasks=1,
        created_at=_NOW - timedelta(minutes=age_minutes),
    )


def _run(run_id: str, batch_id: str, age_minutes: int = 0) -> AgentTaskRunDB:
    started = _NOW - timedelta(minutes=age_minutes)
    return AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch_id,
        task_id="team/task",
        task_path="team/task",
        status="passed",
        pass_result=True,
        started_at=started,
        completed_at=started,
    )


@pytest.fixture
def seeded(session: Session) -> Session:
    session.add(ProjectDB(id=PROJECT, name=PROJECT, created_at=_NOW))
    session.add_all(
        [
            _batch(
                "b-prod-a-x",
                environment="prod",
                labels={"customer": _label("c-a", "Acme"), "agent": _label("ag-x", "Support")},
                age_minutes=1,
            ),
            _batch(
                "b-prod-b-x",
                environment="prod",
                labels={"customer": _label("c-b", "Beta"), "agent": _label("ag-x", "Support desk")},
                age_minutes=2,
            ),
            _batch(
                "b-staging-a-y",
                environment="staging",
                labels={"customer": _label("c-a", "Acme Old Name"), "agent": _label("ag-y", "Sales")},
                age_minutes=3,
            ),
            _batch("b-unlabelled", environment="staging", age_minutes=4),
            _batch(
                "b-other-project",
                environment="prod",
                labels={"customer": _label("c-a", "Acme")},
                project="elsewhere",
            ),
        ]
    )
    session.add_all(
        [
            _run("r-prod-a-x", "b-prod-a-x", 1),
            _run("r-prod-b-x", "b-prod-b-x", 2),
            _run("r-staging-a-y", "b-staging-a-y", 3),
            _run("r-unlabelled", "b-unlabelled", 4),
            _run("r-other-project", "b-other-project", 0),
        ]
    )
    session.commit()
    return session


def _batch_ids(client: TestClient, **params: object) -> list[str]:
    response = client.get("/v1/agent-task-batch-runs", params={"project": PROJECT, **params})
    assert response.status_code == 200, response.text
    return [batch["id"] for batch in response.json()["data"]]


def _run_ids(client: TestClient, **params: object) -> list[str]:
    response = client.get("/v1/agent-task-runs", params=params)
    assert response.status_code == 200, response.text
    return [run["id"] for run in response.json()]


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------


def test_batch_list_filters_by_environment_comma_separated(client: TestClient, seeded: Session) -> None:
    assert _batch_ids(client, environment="prod") == ["b-prod-a-x", "b-prod-b-x"]
    assert _batch_ids(client, environment="prod,staging") == [
        "b-prod-a-x",
        "b-prod-b-x",
        "b-staging-a-y",
        "b-unlabelled",
    ], "environments OR"


def test_batch_list_label_filters_or_within_a_key_and_across_keys(
    client: TestClient, seeded: Session
) -> None:
    assert _batch_ids(client, label=["customer:c-a"]) == ["b-prod-a-x", "b-staging-a-y"], (
        "a label matches by id, whatever name each run recorded"
    )
    assert _batch_ids(client, label=["customer:c-a", "customer:c-b"]) == [
        "b-prod-a-x",
        "b-prod-b-x",
        "b-staging-a-y",
    ], "ids OR within one key"
    assert _batch_ids(client, label=["customer:c-a", "agent:ag-x"]) == ["b-prod-a-x"], (
        "keys AND"
    )
    assert _batch_ids(client, label=["customer:c-a"], environment="staging") == [
        "b-staging-a-y"
    ], "labels AND environment"


def test_label_filter_never_matches_the_display_name(client: TestClient, seeded: Session) -> None:
    assert _batch_ids(client, label=["customer:Acme"]) == [], "name is display only"


def test_task_run_list_filters_through_its_batch(client: TestClient, seeded: Session) -> None:
    assert _run_ids(client, project=PROJECT, label="agent:ag-x") == ["r-prod-a-x", "r-prod-b-x"]
    assert _run_ids(client, project=PROJECT, environment="staging") == [
        "r-staging-a-y",
        "r-unlabelled",
    ]
    assert _run_ids(client, project=PROJECT, environment=["prod", "staging"], label="customer:c-a") == [
        "r-prod-a-x",
        "r-staging-a-y",
    ], "repeated environments OR, like the comma form"
    # Without a project the open-dev listing is unscoped; the label filter
    # still has to reach the Batch.
    assert _run_ids(client, label="customer:c-a") == [
        "r-other-project",
        "r-prod-a-x",
        "r-staging-a-y",
    ]


@pytest.mark.parametrize("bad", ["customer", "customer:", ":c-a", "bad key:c-a"])
def test_malformed_label_filter_is_rejected(client: TestClient, seeded: Session, bad: str) -> None:
    for path in ("/v1/agent-task-batch-runs", "/v1/agent-task-runs"):
        response = client.get(path, params={"project": PROJECT, "label": bad})
        assert response.status_code == 422, f"{path} must refuse {bad!r}, not match nothing"


def test_label_id_may_contain_colons(client: TestClient, session: Session) -> None:
    session.add(ProjectDB(id=PROJECT, name=PROJECT, created_at=_NOW))
    session.add(_batch("b-urn", labels={"customer": _label("urn:c:1", "Urn")}))
    session.commit()
    assert _batch_ids(client, label=["customer:urn:c:1"]) == ["b-urn"]


# ---------------------------------------------------------------------------
# Projection
# ---------------------------------------------------------------------------


def test_lists_carry_labels_and_environment(client: TestClient, seeded: Session) -> None:
    batch = client.get(
        "/v1/agent-task-batch-runs", params={"project": PROJECT, "label": "agent:ag-y"}
    ).json()["data"][0]
    assert batch["labels"] == {
        "customer": {"id": "c-a", "name": "Acme Old Name"},
        "agent": {"id": "ag-y", "name": "Sales"},
    }
    run = client.get(
        "/v1/agent-task-runs", params={"project": PROJECT, "label": "agent:ag-y"}
    ).json()[0]
    assert run["environment"] == "staging"
    assert run["labels"]["agent"] == {"id": "ag-y", "name": "Sales"}

    detail = client.get("/v1/agent-task-batch-runs/b-staging-a-y").json()
    assert detail["labels"]["customer"]["id"] == "c-a"
    assert detail["task_runs"][0]["labels"]["agent"]["id"] == "ag-y"

    from apo.services.agent_task_run_details import load_task_run_summaries

    [compared] = load_task_run_summaries(seeded, ["r-staging-a-y"], project_id=PROJECT)
    assert compared.environment == "staging", "every task run summary carries its batch's scope"
    assert compared.labels["agent"].id == "ag-y"


def test_stored_malformed_labels_are_skipped_on_read(client: TestClient, session: Session) -> None:
    session.add(ProjectDB(id=PROJECT, name=PROJECT, created_at=_NOW))
    batch = _batch("b-legacy")
    batch.run_metadata = {"labels": {"ok": _label("1", "One"), "bad": {"id": 7}, "worse": "x"}}
    session.add(batch)
    session.commit()
    data = client.get("/v1/agent-task-batch-runs", params={"project": PROJECT}).json()["data"]
    assert data[0]["labels"] == {"ok": {"id": "1", "name": "One"}}, (
        "a row written before validation must still render"
    )


# ---------------------------------------------------------------------------
# Facets
# ---------------------------------------------------------------------------


def test_label_facets_name_each_id_by_its_newest_batch(client: TestClient, seeded: Session) -> None:
    response = client.get(f"/v1/projects/{PROJECT}/agent-task-run-label-facets")
    assert response.status_code == 200, response.text
    facets = response.json()
    assert facets["environments"] == [
        {"value": "prod", "count": 2},
        {"value": "staging", "count": 2},
    ]
    assert facets["labels"] == [
        {
            "key": "agent",
            "values": [
                {"id": "ag-y", "name": "Sales", "count": 1},
                {"id": "ag-x", "name": "Support", "count": 2},
            ],
        },
        {
            "key": "customer",
            "values": [
                {"id": "c-a", "name": "Acme", "count": 2},
                {"id": "c-b", "name": "Beta", "count": 1},
            ],
        },
    ], "one option per id, named by the most recent batch; other projects excluded"


def test_label_facets_unknown_project_is_404(client: TestClient, session: Session) -> None:
    response = client.get("/v1/projects/nope/agent-task-run-label-facets")
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Write-side validation
# ---------------------------------------------------------------------------


def _caller_body(run_metadata: object) -> dict[str, object]:
    return {
        "project": PROJECT,
        "task": {
            "task_id": "team/task",
            "task_path": "team/task",
            "display_name": "task",
            "has_checks": False,
        },
        "environment": "prod",
        "run_metadata": run_metadata,
        "source_attestation": {
            "dirty": False,
            "content_sha256": "b" * 64,
            "task_root_label": "tasks",
            "file_count": 1,
            "uncompressed_size_bytes": 10,
        },
        "caller_identity": {
            "client": "test",
            "client_version": "0",
            "os": "linux",
            "architecture": "x64",
        },
        "task_definition": {
            "schema_version": 1,
            "files": [{"path": "task.eval.ts", "content": "task('task', {});\n"}],
        },
    }


@pytest.mark.parametrize(
    "labels",
    [
        ["customer"],
        {"customer": "c-a"},
        {"customer": {"id": "c-a"}},
        {"customer": {"id": "", "name": "Acme"}},
        {"customer": {"id": "c-a", "name": "   "}},
        {"customer": {"id": 7, "name": "Acme"}},
        {"customer": {"id": "c-a", "name": "Acme", "extra": True}},
        {"has space": {"id": "c-a", "name": "Acme"}},
        {"a:b": {"id": "c-a", "name": "Acme"}},
    ],
)
def test_caller_create_rejects_malformed_labels(
    client: TestClient, session: Session, labels: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(executor_auth, "AUTH_SECRET", "test-caller-secret")
    session.add(ProjectDB(id=PROJECT, name=PROJECT, created_at=_NOW))
    session.commit()
    response = client.post(
        "/v1/agent-task-batch-runs/caller", json=_caller_body({"labels": labels})
    )
    assert response.status_code == 422, f"labels {labels!r} must be refused"


def test_caller_create_stores_labels_and_leaves_other_metadata_free(
    client: TestClient, session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(executor_auth, "AUTH_SECRET", "test-caller-secret")
    session.add(ProjectDB(id=PROJECT, name=PROJECT, created_at=_NOW))
    session.commit()
    metadata = {
        "labels": {"customer": _label("c-a", "Acme")},
        "anything": {"nested": [1, "two"]},
    }
    response = client.post("/v1/agent-task-batch-runs/caller", json=_caller_body(metadata))
    assert response.status_code == 201, response.text
    assert _batch_ids(client, label=["customer:c-a"], environment="prod") == [
        response.json()["batch_run_id"]
    ]
    stored = client.get(f"/v1/agent-task-batch-runs/{response.json()['batch_run_id']}").json()
    assert stored["run_metadata"]["anything"] == {"nested": [1, "two"]}


def test_every_batch_creating_request_validates_labels() -> None:
    """Dashboard runs and Schedules create Batches too; their labels must hold
    the same shape, or the filters silently miss them."""
    from pydantic import ValidationError

    from apo.models.schemas import (
        CreateAgentTaskBatchRunRequest,
        CreateAgentTaskScheduleRequest,
        UpdateAgentTaskScheduleRequest,
    )

    bad = {"labels": {"customer": {"id": "c-a"}}}
    with pytest.raises(ValidationError):
        _ = CreateAgentTaskBatchRunRequest(project="p", run_metadata=bad)
    with pytest.raises(ValidationError):
        _ = CreateAgentTaskScheduleRequest(project="p", name="n", run_metadata=bad)
    with pytest.raises(ValidationError):
        _ = UpdateAgentTaskScheduleRequest(run_metadata=bad)
