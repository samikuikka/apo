# pyright: reportAny=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

import pytest
from types import SimpleNamespace
from typing import cast
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from sqlmodel import Session
from datetime import datetime, timedelta, timezone

from apo.models import LoggedCallDB, RunDB
from apo.models.db import ProjectDB, ProjectMembershipDB, UserDB
from apo.routes.runs.crud import get_run_details, get_distinct_projects


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
    # Derived status mirrors the run-list rule (no ERROR/WARNING calls here)
    assert data["run"]["status"] == "success"
    assert len(data["calls"]) == 3

    calls = data["calls"]
    assert calls[0]["id"] == "c2"
    assert calls[1]["id"] == "c1"
    assert calls[2]["id"] == "c3"

    assert calls[2]["input"]["long"] == "x"*400
    assert calls[2]["output"]["long"] == "y"*400


def test_get_run_details_omits_messages_unless_included(client: TestClient, session: Session):
    # `messages` duplicates input/output content (the projector copies
    # input.messages + output.messages verbatim), roughly doubling the payload
    # of agentic traces. Default response drops it; ?include=messages restores
    # it for the CLI's verbose view.
    now = datetime.now(timezone.utc)
    msgs: list[dict[str, object]] = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "yo"},
    ]

    session.add(RunDB(id="r-msg", project="p", task_id="t", created_at=now, call_count=1))
    session.add(LoggedCallDB(
        id="c-msg", project="p", model="m", task_id="t", run_id="r-msg",
        created_at=now, input={"messages": msgs}, messages=msgs, output={"c": "d"},
    ))
    session.commit()

    default = client.get("/v1/runs/r-msg?project=p")
    assert default.status_code == 200
    call = default.json()["calls"][0]
    assert "messages" not in call
    assert call["input"]["messages"] == msgs  # nested content untouched

    included = client.get("/v1/runs/r-msg?project=p&include=messages")
    assert included.status_code == 200
    assert included.json()["calls"][0]["messages"] == msgs


def test_get_run_details_slim_ships_metadata_only(client: TestClient, session: Session):
    # Agentic traces repeat the accumulated conversation in every
    # generation's input, so the full detail payload grows quadratically
    # (measured: 281 calls → 18 MB). ?slim=true defers the fat columns and
    # ships call metadata + bounded first/last previews instead.
    now = datetime.now(timezone.utc)

    session.add(RunDB(id="r-slim", project="p", task_id="t", created_at=now, call_count=3))
    session.add(LoggedCallDB(
        id="s0", project="p", model="m", task_id="t", run_id="r-slim",
        created_at=now, step_index=0,
        input={"messages": [{"role": "user", "content": "hello"}]},
        messages=[], output={},
    ))
    session.add(LoggedCallDB(
        id="s1", project="p", model="m", task_id="t", run_id="r-slim",
        created_at=now, step_index=1,
        input={"messages": [{"role": "user", "content": "x" * 20000}]},
        messages=[], output={},
        tool_parameters={"q": 1}, tool_result={"r": 2},
        cost_breakdown={"input": 3}, raw_usage={"in": 5},
    ))
    session.add(LoggedCallDB(
        id="s2", project="p", model="m", task_id="t", run_id="r-slim",
        created_at=now, step_index=2,
        input={}, messages=[],
        output={"text": "final answer"},
    ))
    session.commit()

    response = client.get("/v1/runs/r-slim?project=p&slim=true")
    assert response.status_code == 200
    data = response.json()

    assert data["slim_calls"] is True
    assert "capabilities" not in data  # messages capability needs the fat columns

    calls = data["calls"]
    assert [c["id"] for c in calls] == ["s0", "s1", "s2"]

    # Middle call: heavy keys absent, metadata kept.
    assert "input" not in calls[1]
    assert "output" not in calls[1]
    assert "messages" not in calls[1]
    assert "tool_parameters" not in calls[1]
    assert "tool_result" not in calls[1]
    assert calls[1]["model"] == "m"
    assert calls[1]["cost_breakdown"] == {"input": 3}
    assert calls[1]["raw_usage"] == {"in": 5}

    # First/last calls carry bounded previews for the trace Preview tab.
    assert calls[0]["input"] == '{"messages": [{"role": "user", "content": "hello"}]}'
    assert calls[2]["output"] == '{"text": "final answer"}'

    # Default (non-slim) response keeps the full contract.
    full = client.get("/v1/runs/r-slim?project=p").json()
    assert full["calls"][1]["input"]["messages"][0]["content"] == "x" * 20000
    assert "slim_calls" not in full


def test_get_run_details_slim_preview_is_bounded(client: TestClient, session: Session):
    now = datetime.now(timezone.utc)
    session.add(RunDB(id="r-bound", project="p", task_id="t", created_at=now, call_count=1))
    session.add(LoggedCallDB(
        id="b0", project="p", model="m", task_id="t", run_id="r-bound",
        created_at=now, step_index=0,
        input={"blob": "z" * 50000}, messages=[], output={},
    ))
    session.commit()

    data = client.get("/v1/runs/r-bound?project=p&slim=true").json()
    preview = data["calls"][0]["input"]
    assert isinstance(preview, str)
    assert len(preview) < 9000
    assert preview.endswith("...")


def test_get_run_details_include_messages_beats_slim(client: TestClient, session: Session):
    # ?include=messages needs the fat columns anyway — slim is ignored rather
    # than returning a payload that claims messages but defers them.
    now = datetime.now(timezone.utc)
    msgs: list[dict[str, object]] = [{"role": "user", "content": "hi"}]
    session.add(RunDB(id="r-both", project="p", task_id="t", created_at=now, call_count=1))
    session.add(LoggedCallDB(
        id="both0", project="p", model="m", task_id="t", run_id="r-both",
        created_at=now, input={"messages": msgs}, messages=msgs, output={},
    ))
    session.commit()

    data = client.get("/v1/runs/r-both?project=p&slim=true&include=messages").json()
    assert "slim_calls" not in data
    assert data["calls"][0]["messages"] == msgs
    assert data["calls"][0]["input"]["messages"] == msgs


def test_get_call_details_returns_full_payload(client: TestClient, session: Session):
    now = datetime.now(timezone.utc)
    msgs: list[dict[str, object]] = [{"role": "user", "content": "hi"}]
    session.add(RunDB(id="r-call", project="p", task_id="t", created_at=now, call_count=1))
    session.add(LoggedCallDB(
        id="k0", project="p", model="m", task_id="t", run_id="r-call",
        created_at=now, step_index=0,
        input={"messages": msgs}, messages=msgs, output={"text": "yo"},
        tool_name="search", tool_parameters={"q": 1}, tool_result={"r": 2},
    ))
    # Same call id in another project must stay invisible through ?project=p.
    session.add(RunDB(id="r-call2", project="other", task_id="t", created_at=now, call_count=1))
    session.add(LoggedCallDB(
        id="k0", project="other", model="m", task_id="t", run_id="r-call2",
        created_at=now, step_index=0, input={"nope": True}, messages=[], output={},
    ))
    session.commit()

    detail = client.get("/v1/runs/r-call/calls/k0?project=p")
    assert detail.status_code == 200
    call = detail.json()
    assert call["id"] == "k0"
    assert call["input"]["messages"] == msgs
    assert call["output"] == {"text": "yo"}
    assert call["tool_parameters"] == {"q": 1}
    assert call["tool_result"] == {"r": 2}
    assert "messages" not in call  # opt-in, same as the run-detail contract

    included = client.get("/v1/runs/r-call/calls/k0?project=p&include=messages")
    assert included.json()["messages"] == msgs

    # Unknown call, wrong run, and wrong project all 404.
    assert client.get("/v1/runs/r-call/calls/missing?project=p").status_code == 404
    assert client.get("/v1/runs/r-other/calls/k0?project=p").status_code == 404
    assert client.get("/v1/runs/r-call2/calls/k0?project=p").status_code == 404


def test_get_run_details_reports_projection_capabilities(client: TestClient, session: Session):
    # Issue #164 DX ask: surface which evidence categories the trace's
    # projection carries, so an `unsupported` assertion verdict can be told
    # apart from a misbehaving producer.
    now = datetime.now(timezone.utc)
    session.add(RunDB(id="r-cap", project="p", task_id="t", created_at=now, call_count=1))
    session.add(LoggedCallDB(
        id="c-cap", project="p", model="m", task_id="t", run_id="r-cap",
        created_at=now, observation_type="TOOL", tool_name="read_file",
        latency_ms=10, input={}, output={}, messages=[],
    ))
    session.commit()

    response = client.get("/v1/runs/r-cap?project=p")
    assert response.status_code == 200
    caps = response.json()["capabilities"]
    assert caps["tools"] == "available"
    assert caps["errors"] == "available"
    assert caps["timing"] == "available"
    assert caps["skills"] == "unavailable"  # honest: no SKILL observation


def test_get_run_details_includes_span_attributes(client: TestClient, session: Session):
    # Issue #164 DX ask: `?include=attributes` attaches each call's canonical
    # OtlpSpanDB attributes so a producer can verify whether its OTLP
    # attributes arrived and what they normalized to.
    from apo.models.db import OtlpSpanDB

    now = datetime.now(timezone.utc)
    session.add(RunDB(id="r-attr", project="p", task_id="t", created_at=now, call_count=1))
    session.add(LoggedCallDB(
        id="c-attr", project="p", model="m", task_id="t", run_id="r-attr",
        created_at=now, observation_type="SKILL", input={}, output={}, messages=[],
    ))
    session.add(OtlpSpanDB(
        project_id="p", trace_id="r-attr", span_id="c-attr",
        span_name="gen_ai.execute_tool read_file",
        attributes={"apo.observation.type": "SKILL", "gen_ai.tool.name": "read_file"},
        resource={}, start_time=now,
    ))
    session.commit()

    default = client.get("/v1/runs/r-attr?project=p")
    assert default.status_code == 200
    assert "attributes" not in default.json()["calls"][0]

    included = client.get("/v1/runs/r-attr?project=p&include=attributes")
    assert included.status_code == 200
    call = included.json()["calls"][0]
    assert call["observation_type"] == "SKILL"
    assert call["attributes"]["apo.observation.type"] == "SKILL"


def test_get_run_details_accepts_nondict_json_fields(client: TestClient, session: Session):
    # Regression for issue #23: a trace written via the projection path can hold
    # a non-dict tool_result / input / output (e.g. a plain string, number, or
    # list). The DB column is JSON and accepts it; the read model must not 500.
    now = datetime.now(timezone.utc)

    r1 = RunDB(id="r-nondict", project="p", task_id="t", created_at=now, call_count=1)

    c1 = LoggedCallDB(
        id="c-nondict", project="p", model="m", task_id="t", run_id="r-nondict",
        created_at=now, observation_type="TOOL", tool_name="reminder",
        tool_result="Before using DOCX tools, ...",  # string, not dict
        input="plain string input",                  # string
        output=42,                                   # int
        messages=[],
    )

    session.add(r1)
    session.add(c1)
    session.commit()

    response = client.get("/v1/runs/r-nondict?project=p")
    assert response.status_code == 200, response.text

    calls = response.json()["calls"]
    assert len(calls) == 1
    assert calls[0]["tool_result"] == "Before using DOCX tools, ..."
    assert calls[0]["input"] == "plain string input"
    assert calls[0]["output"] == 42


def _req(
    user_id: str | None,
    *,
    auth_method: str | None = None,
    project: str | None = None,
) -> Request:
    """Fake request for direct route-function calls. ``user_id=None`` takes the
    dev/open-mode permissive path; a value exercises membership enforcement."""
    state = SimpleNamespace()
    if user_id is not None:
        state.user_id = user_id
    if auth_method is not None:
        state.auth_method = auth_method
    if project is not None:
        state.project = project
    return cast(Request, cast(object, SimpleNamespace(state=state)))


def _seed_membership_project(session: Session, project: str, member_id: str) -> None:
    """A real ProjectDB row (so legacy tolerance does not apply) with one member."""
    session.add(UserDB(id=member_id, email=f"{member_id}@t.co", name=member_id, password_hash="x"))
    session.commit()
    session.add(ProjectDB(id=project, name=project, created_by=member_id))
    session.commit()
    session.add(
        ProjectMembershipDB(project_id=project, user_id=member_id, role="owner")
    )
    session.commit()


def test_get_run_details_enforces_project_membership(session: Session):
    now = datetime.now(timezone.utc)
    _seed_membership_project(session, "proj-a", "member-a")
    session.add(RunDB(id="ra", project="proj-a", task_id="t", created_at=now, call_count=1))
    session.add(LoggedCallDB(
        id="ca", project="proj-a", model="m", task_id="t", run_id="ra",
        created_at=now, input={}, messages=[], output={},
    ))
    session.commit()

    # Member reads their own project's trace.
    detail = get_run_details(
        "ra", _req("member-a"), project="proj-a", include=None, session=session
    )
    assert detail["run"]["id"] == "ra"

    # Non-member passing ?project=proj-a is rejected — the pre-fix leak.
    with pytest.raises(HTTPException) as exc:
        _ = get_run_details(
            "ra", _req("outsider"), project="proj-a", include=None, session=session
        )
    error = cast(HTTPException, exc.value)
    assert error.status_code == 403


def test_distinct_projects_scoped_to_caller(session: Session):
    now = datetime.now(timezone.utc)
    _seed_membership_project(session, "iso-a", "iso-member-a")
    _seed_membership_project(session, "iso-b", "iso-member-b")
    session.add(RunDB(id="iso-ra", project="iso-a", created_at=now, call_count=0))
    session.add(RunDB(id="iso-rb", project="iso-b", created_at=now, call_count=0))
    session.commit()

    # A member of iso-a sees iso-a but cannot enumerate iso-b's existence.
    scoped = get_distinct_projects(_req("iso-member-a"), session=session)
    assert "iso-a" in scoped
    assert "iso-b" not in scoped

    # Dev/open mode (no user_id) stays unscoped: sees both.
    unscoped = set(get_distinct_projects(_req(None), session=session))
    assert {"iso-a", "iso-b"} <= unscoped


def test_api_key_reads_only_its_bound_project(session: Session):
    now = datetime.now(timezone.utc)
    _seed_membership_project(session, "key-proj-a", "key-owner")
    session.add(ProjectDB(id="key-proj-b", name="key-proj-b", created_by="key-owner"))
    session.commit()
    session.add(
        ProjectMembershipDB(
            project_id="key-proj-b", user_id="key-owner", role="owner"
        )
    )
    session.add(
        RunDB(
            id="key-run-a",
            project="key-proj-a",
            task_id="t",
            created_at=now,
            call_count=0,
        )
    )
    session.add(
        RunDB(
            id="key-run-b",
            project="key-proj-b",
            task_id="t",
            created_at=now,
            call_count=0,
        )
    )
    session.commit()

    request = _req("key-owner", auth_method="api_key", project="key-proj-a")

    assert get_distinct_projects(request, session=session) == ["key-proj-a"]
    with pytest.raises(HTTPException) as exc:
        _ = get_run_details(
            "key-run-b",
            request,
            project="key-proj-b",
            include=None,
            session=session,
        )
    error = cast(HTTPException, exc.value)
    assert error.status_code == 403
    assert error.detail == "API key is not bound to this project"


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main(["-v", __file__]))
