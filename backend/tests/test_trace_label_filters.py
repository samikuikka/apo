"""Traces filter by run labels: a trace matches through its task run's batch.

The `label=<key>:<id>` filter on the traces list (`GET /v1/runs`) joins
trace -> task run -> batch and applies the same OR-within-key /
AND-across-keys semantics as the run lists.
"""

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    ProjectMembershipDB,
    RunDB,
    UserDB,
)

NOW = datetime.now(timezone.utc)
PROJECT = "trace-labels-proj"


def _label(*pairs: tuple[str, str]) -> dict[str, object]:
    labels: dict[str, dict[str, str]] = {}
    for key, label_id in pairs:
        labels[key] = {"id": label_id, "name": label_id}
    return {"labels": labels}


def _linked(
    batch_id: str,
    run_id: str,
    trace_id: str,
    metadata: dict[str, object] | None,
) -> tuple[AgentTaskBatchRunDB, AgentTaskRunDB, RunDB]:
    batch = AgentTaskBatchRunDB(
        id=batch_id,
        project=PROJECT,
        selection_type="caller-task",
        environment="default",
        run_metadata=metadata or {"trigger": {"source": "api"}},
        status="completed",
        total_tasks=1,
        created_at=NOW,
    )
    task_run = AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch_id,
        task_id="team/task",
        task_path="team/task",
        status="passed",
        pass_result=True,
        trace_run_id=trace_id,
        started_at=NOW,
        completed_at=NOW,
    )
    trace = RunDB(
        id=trace_id,
        project=PROJECT,
        task_id="team/task",
        flow_name="agent-task.team/task",
        created_at=NOW - timedelta(minutes=5),
        call_count=2,
    )
    return batch, task_run, trace


def seeded(session: Session) -> None:
    user = UserDB(
        email="labels-traces@test.local",
        name="Labels Traces",
        password_hash="x",
        email_verified_at=NOW,
        created_at=NOW,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    session.add(ProjectDB(id=PROJECT, name=PROJECT, created_by=user.id, created_at=NOW))
    session.add(ProjectMembershipDB(project_id=PROJECT, user_id=user.id, role="owner"))
    rows: list[object] = []
    for args in [
        ("b-acme", "tr-acme", "trace-acme", _label(("customer", "acme"), ("team", "platforms"))),
        ("b-acme-2", "tr-acme-2", "trace-acme-2", _label(("customer", "acme"))),
        ("b-globex", "tr-globex", "trace-globex", _label(("customer", "globex"))),
        ("b-unlabelled", "tr-unlabelled", "trace-unlabelled", None),
    ]:
        rows.extend(_linked(*args))
    # A labelled batch in ANOTHER project: its trace must never match here.
    other = _linked("b-other", "tr-other", "trace-other", _label(("customer", "acme")))
    other_batch = other[0]
    other_batch.project = "elsewhere"
    other_trace = other[2]
    other_trace.project = "elsewhere"
    rows.extend(other)
    session.add_all(rows)
    session.commit()


def _trace_ids(client: TestClient, **params: object) -> list[str]:
    response = client.get("/v1/runs", params={"project": PROJECT, **params})
    assert response.status_code == 200, response.text
    body = response.json()
    items = body["data"] if isinstance(body, dict) else body
    return sorted(run["id"] for run in items)


def test_traces_filter_by_one_label(client: TestClient, session: Session) -> None:
    seeded(session)
    assert _trace_ids(client, label="customer:acme") == ["trace-acme", "trace-acme-2"]


def test_traces_labels_or_within_a_key(client: TestClient, session: Session) -> None:
    seeded(session)
    assert _trace_ids(client, label=["customer:acme", "customer:globex"]) == [
        "trace-acme",
        "trace-acme-2",
        "trace-globex",
    ]


def test_traces_labels_and_across_keys(client: TestClient, session: Session) -> None:
    seeded(session)
    # Only the acme batch that also carries team=platforms.
    assert _trace_ids(client, label=["customer:acme", "team:platforms"]) == ["trace-acme"]


def test_traces_label_filter_ignores_other_projects(client: TestClient, session: Session) -> None:
    seeded(session)
    assert "trace-other" not in _trace_ids(client, label="customer:acme")


def test_traces_malformed_label_is_422(client: TestClient, session: Session) -> None:
    seeded(session)
    response = client.get("/v1/runs", params={"project": PROJECT, "label": "no-colon"})
    assert response.status_code == 422
