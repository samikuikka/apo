# pyright: reportAny=false, reportDeprecated=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedFunction=false

"""End-to-end regression for issue #23.

A trace whose free-form JSON columns hold non-dict values (string tool_result,
int output, string run metadata, ...) must be readable on every read path
without an HTTP 500 / validation crash. The DB columns are JSON and accept any
value; the read models and projection builder must tolerate them.
"""

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.db import engine, init_db
from apo.models.db import LoggedCallDB, RunDB
from apo.services.trace_repository import NativeTraceRepository


@pytest.fixture(autouse=True)
def _setup_database():
    init_db()
    yield
    with Session(engine) as session:
        from sqlmodel import text

        session.execute(text("DELETE FROM logged_calls"))
        session.execute(text("DELETE FROM runs"))
        session.commit()


def test_every_read_path_tolerates_nondict_json(client: TestClient, session: Session):
    now = datetime.now(timezone.utc)

    # Run-level non-dict values: int output, string input, list metadata.
    run = RunDB(
        id="run-e2e",
        project="p",
        task_id="t",
        created_at=now,
        call_count=2,
        input="a plain string run input",
        output=42,
        run_metadata=[1, 2, 3],
    )
    # A TOOL call with a string tool_result and string input (issue's example).
    tool_call = LoggedCallDB(
        id="call-tool",
        project="p",
        model="m",
        task_id="t",
        run_id="run-e2e",
        created_at=now,
        observation_type="TOOL",
        tool_name="reminder",
        tool_result="Before using DOCX tools, ...",
        input="plain string input",
        output=7,
        messages=[],
    )
    # A GENERATION call with a non-dict (int) output — the _messages_for hazard.
    gen_call = LoggedCallDB(
        id="call-gen",
        project="p",
        model="m",
        task_id="t",
        run_id="run-e2e",
        created_at=now,
        observation_type="GENERATION",
        step_name="llm",
        output=99,
        messages=[],
        input={},
    )

    session.add(run)
    session.add(tool_call)
    session.add(gen_call)
    session.commit()

    # 1. GET /v1/runs/{id} — the run readback target. Must be 200.
    resp = client.get("/v1/runs/run-e2e?project=p")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    run_data = data["run"]
    # Run-level non-dict values survive the round trip.
    assert run_data["input"] == "a plain string run input"
    assert run_data["output"] == 42
    assert run_data["run_metadata"] == [1, 2, 3] if "run_metadata" in run_data else True
    calls = {c["id"]: c for c in data["calls"]}
    assert calls["call-tool"]["tool_result"] == "Before using DOCX tools, ..."
    assert calls["call-tool"]["output"] == 7
    assert calls["call-gen"]["output"] == 99

    # 2. The trace-projection read path (_messages_for must not crash on int
    #    output). Use a fresh Session(engine) so the data is committed and
    #    visible, mirroring test_trace_repository.py's pattern.
    repo = NativeTraceRepository()
    with Session(engine) as s:
        s.add(
            RunDB(
                id="run-proj",
                project="p",
                flow_name="f",
                created_at=now,
                completed_at=now,
                duration_ms=5.0,
            )
        )
        s.add(
            LoggedCallDB(
                id="gen-proj",
                run_id="run-proj",
                project="p",
                task_id="",
                created_at=now,
                model="m",
                observation_type="GENERATION",
                step_name="llm",
                parent_call_id=None,
                latency_ms=3.0,
                output=99,  # int, not a dict
                messages=[],
                input={},
            )
        )
        s.commit()
        snap = repo.get_projection_snapshot(s, project_id="p", trace_id="run-proj")
    assert snap is not None
    obs = [o for o in snap.observations if o.span_id == "gen-proj"][0]
    assert obs.output == 99
    # Non-dict generation output yields no fabricated message and no crash.
    assert obs.messages == ()
    assert snap.capabilities.messages.value == "unavailable"


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main(["-v", __file__]))
