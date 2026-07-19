# pyright: reportAny=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session
from datetime import datetime, timedelta, timezone

from apo.models import LoggedCallDB, RunDB


def test_list_runs(client: TestClient, session: Session):
    now = datetime.now(timezone.utc)

    r1 = RunDB(id="r1", project="p1", task_id="t1", flow_name="flow1", created_at=now - timedelta(minutes=10), call_count=2)
    c1 = LoggedCallDB(
        id="c1",
        project="p1",
        model="gpt-4",
        task_id="t1",
        run_id="r1",
        flow_name="flow1",
        created_at=now - timedelta(minutes=10),
        input={"prompt": "hi"},
        messages=[],
        output={"text": "hello"},
        step_index=0
    )
    c2 = LoggedCallDB(
        id="c2",
        project="p1",
        model="gpt-4",
        task_id="t1",
        run_id="r1",
        flow_name="flow1",
        created_at=now - timedelta(minutes=5),
        input={"prompt": "bye"},
        messages=[],
        output={"text": "goodbye"},
        step_index=1
    )

    r2 = RunDB(id="r2", project="p1", task_id="t2", flow_name=None, created_at=now, call_count=1)
    c3 = LoggedCallDB(
        id="c3",
        project="p1",
        model="gpt-4",
        task_id="t2",
        run_id="r2",
        flow_name=None,
        created_at=now,
        input={"prompt": "solo"},
        messages=[],
        output={"text": "solo"},
    )

    c4 = LoggedCallDB(
        id="c4",
        project="p1",
        model="gpt-4",
        task_id="t3",
        created_at=now,
        input={"prompt": "no run"},
        messages=[],
        output={"text": "no run"},
    )

    session.add(r1)
    session.add(r2)
    session.add(c1)
    session.add(c2)
    session.add(c3)
    session.add(c4)
    session.commit()

    response = client.get("/v1/runs")
    assert response.status_code == 200
    result = response.json()

    data = result["data"]
    assert len(data) == 2

    assert data[0]["id"] == "r2"
    assert data[1]["id"] == "r1"

    r1_data = data[1]
    assert r1_data["call_count"] == 2
    assert r1_data["flow_name"] == "flow1"
    assert r1_data["task_id"] == "t1"

    r2_data = data[0]
    assert r2_data["call_count"] == 1
    assert r2_data["flow_name"] is None

def test_get_run_details(client: TestClient, session: Session):
    now = datetime.now(timezone.utc)

    r1 = RunDB(id="r1", project="p", task_id="t", flow_name="flow1", created_at=now, call_count=3)

    c1 = LoggedCallDB(
        id="c1", project="p", model="m", task_id="t", run_id="r1", flow_name="flow1",
        created_at=now, step_index=1,
        input={"a": "b"}, messages=[], output={"c": "d"}
    )
    c2 = LoggedCallDB(
        id="c2", project="p", model="m", task_id="t", run_id="r1", flow_name="flow1",
        created_at=now - timedelta(seconds=1), step_index=0,
        input={"a": "b"}, messages=[], output={"c": "d"}
    )
    c3 = LoggedCallDB(
        id="c3", project="p", model="m", task_id="t", run_id="r1", flow_name="flow1",
        created_at=now + timedelta(seconds=1), step_index=None,
        input={"long": "x"*400}, messages=[], output={"long": "y"*400}
    )

    session.add(r1)
    session.add(c1)
    session.add(c2)
    session.add(c3)
    session.commit()

    response = client.get("/v1/runs/r1?project=p")
    assert response.status_code == 200
    data = response.json()

    assert data["run"]["id"] == "r1"
    assert len(data["calls"]) == 3

    calls = data["calls"]
    assert calls[0]["id"] == "c2"
    assert calls[1]["id"] == "c1"
    assert calls[2]["id"] == "c3"

    assert calls[2]["input"]["long"] == "x"*400
    assert calls[2]["output"]["long"] == "y"*400

if __name__ == "__main__":
    import sys
    sys.exit(pytest.main(["-v", __file__]))
