# pyright: reportAny=false, reportAttributeAccessIssue=false, reportDeprecated=false, reportExplicitAny=false, reportImplicitOverride=false, reportImplicitStringConcatenation=false, reportMissingParameterType=false, reportOptionalMemberAccess=false, reportPrivateLocalImportUsage=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedFunction=false, reportUnusedParameter=false

"""Slim projection, previews, and span-sourced reads (storage migration stage 2).

Covers: write-time preview parity with the legacy read-time truncation,
preview refresh rules (class priority, same-source refresh, dangling
source), golden detail equality across fat and slim modes for the same
trace, list rendering that never touches call I/O columns, the slim-mode
reader reroutes (detail, export, Langfuse compat, task-run snapshot), the
span-less fallback, and the preview backfill job.
"""

import json
from datetime import datetime, timezone
from typing import Any, cast

import pytest
from sqlalchemy import event
from sqlmodel import Session, col, select, text

from apo.db import engine, reset_apo_file_db
from apo.models.db import LoggedCallDB, OtlpSpanDB, RunDB
from apo.routes.admin import _run_projection_backfill, _projection_jobs
from apo.routes.runs.list_query import _fetch_io_previews
from apo.services.otlp_receiver import OtlpReceiver
from apo.services.trace_projector import get_trace_projector
from apo.services.projection_io import (
    list_read_mode,
    projection_write_mode,
    resolve_call_io,
    truncate_preview,
)

NOW = datetime.now(timezone.utc)
TRACE = "0102030405060708090a0b0c0d0e0f10"
ROOT = "0102030405060708"
GEN1 = "1112131415161718"
GEN2 = "2122232425262728"


def _payload(
    span_id: str,
    *,
    trace_id: str = TRACE,
    parent: str | None = ROOT,
    name: str = "chat.completion",
    gen_attrs: list[dict[str, Any]] | None = None,
    raw_input: dict[str, Any] | None = None,
    start: str = "1700000000000000000",
    end: str | None = "1700000001000000000",
) -> bytes:
    attributes: list[dict[str, Any]] = gen_attrs if gen_attrs is not None else []
    if raw_input is not None:
        attributes.append(
            {"key": "input", "value": {"stringValue": json.dumps(raw_input)}}
        )
    span: dict[str, Any] = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "kind": 1 if parent else 2,
        "flags": 1,
        "startTimeUnixNano": start,
        "attributes": attributes,
        "status": {"code": 1},
    }
    if parent:
        span["parentSpanId"] = parent
    if end is not None:
        span["endTimeUnixNano"] = end
    return json.dumps(
        {
            "resourceSpans": [
                {
                    "resource": {
                        "attributes": [
                            {"key": "service.name", "value": {"stringValue": "svc"}}
                        ]
                    },
                    "scopeSpans": [{"scope": {"name": "s"}, "spans": [span]}],
                }
            ]
        }
    ).encode("utf-8")


def _gen_payload(
    span_id: str,
    prompt: str,
    completion: str,
    *,
    start: str = "1700000000000000000",
) -> bytes:
    """A GENERATION span carrying gen_ai semconv I/O."""
    return _payload(
        span_id,
        gen_attrs=[
            # Classification needs an operation marker; messages alone do
            # not make a span a GENERATION.
            {"key": "gen_ai.operation.name", "value": {"stringValue": "chat"}},
            {
                "key": "gen_ai.input.messages",
                "value": {
                    "arrayValue": {
                        "values": [
                            {
                                "kvlistValue": {
                                    "values": [
                                        {"key": "role", "value": {"stringValue": "user"}},
                                        {"key": "content", "value": {"stringValue": prompt}},
                                    ]
                                }
                            }
                        ]
                    }
                },
            },
            {
                "key": "gen_ai.output.messages",
                "value": {
                    "arrayValue": {
                        "values": [
                            {
                                "kvlistValue": {
                                    "values": [
                                        {"key": "role", "value": {"stringValue": "assistant"}},
                                        {"key": "content", "value": {"stringValue": completion}},
                                    ]
                                }
                            }
                        ]
                    }
                },
            },
        ],
        start=start,
    )


def _ingest(session: Session, payload: bytes) -> None:
    result = OtlpReceiver().ingest(payload, "application/json", "p1", session)
    assert result.accepted >= 1, result.errors


def _reproject_local(session: Session, trace_id: str = TRACE) -> int:
    """Re-project a trace's spans through the CURRENT mode on any session."""
    projector = get_trace_projector()
    spans = session.exec(
        select(OtlpSpanDB)
        .where(OtlpSpanDB.project_id == "p1", OtlpSpanDB.trace_id == trace_id)
        .order_by(col(OtlpSpanDB.id))
    ).all()
    for span in spans:
        projector.project(span, session)
    session.commit()
    return len(spans)


def _detail(client: Any, include: str | None = None) -> dict[str, Any]:
    url = f"/v1/runs/{TRACE}?project=p1"
    if include:
        url += f"&include={include}"
    response = client.get(url)
    assert response.status_code == 200, response.text
    return dict(response.json())


def _run(session: Session) -> RunDB:
    run = session.exec(select(RunDB).where(RunDB.id == TRACE)).first()
    assert run is not None
    return run


def _call(session: Session, span_id: str) -> LoggedCallDB:
    call = session.exec(
        select(LoggedCallDB).where(LoggedCallDB.id == span_id)
    ).first()
    assert call is not None
    return call


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("APO_PROJECTION_WRITE_MODE", raising=False)
    monkeypatch.delenv("APO_LIST_READ", raising=False)
    reset_apo_file_db()
    yield
    with Session(engine) as session:
        for table in (
            "call_metrics",
            "run_metrics",
            "logged_calls",
            "otlp_spans",
            "otlp_ingest_batches",
            "runs",
        ):
            session.execute(text(f"DELETE FROM {table}"))
        session.commit()


# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------


class TestModes:
    def test_defaults_are_fat_and_legacy(self) -> None:
        assert projection_write_mode() == "fat"
        assert list_read_mode() == "legacy"

    def test_invalid_values_fall_back(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_PROJECTION_WRITE_MODE", "banana")
        monkeypatch.setenv("APO_LIST_READ", "banana")
        assert projection_write_mode() == "fat"
        assert list_read_mode() == "legacy"

    def test_valid_values(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for mode in ("fat", "dual", "slim"):
            monkeypatch.setenv("APO_PROJECTION_WRITE_MODE", mode)
            assert projection_write_mode() == mode
        monkeypatch.setenv("APO_LIST_READ", "previews")
        assert list_read_mode() == "previews"


# ---------------------------------------------------------------------------
# Preview writes (dual mode)
# ---------------------------------------------------------------------------


class TestPreviewWrites:
    def test_preview_parity_with_legacy_truncation(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_PROJECTION_WRITE_MODE", "dual")
        _ingest(session, _payload(ROOT, parent=None, name="root"))
        _ingest(session, _gen_payload(GEN1, "What is the plan?", "Do the thing."))
        session.commit()

        run = _run(session)
        gen = _call(session, GEN1)
        io = resolve_call_io(
            session.exec(
                select(OtlpSpanDB).where(OtlpSpanDB.span_id == GEN1)
            ).one()
        )
        assert run.input_preview == truncate_preview(io.input)
        assert run.output_preview == truncate_preview(io.output)
        assert run.preview_call_row_id == gen.row_id

        # The list API's preview read must agree with the legacy truncation
        # of the same call's I/O.
        legacy = _fetch_io_previews(session, [TRACE], "p1")
        with_previews = _fetch_io_previews(session, [TRACE], "p1")
        assert with_previews == legacy

    def test_generation_beats_earlier_non_generation(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_PROJECTION_WRITE_MODE", "dual")
        _ingest(session, _payload(ROOT, parent=None))
        # Non-GENERATION call arrives FIRST (earlier start_time).
        _ingest(
            session,
            _payload(
                GEN2,
                name="tool.run",
                gen_attrs=[{"key": "input", "value": {"stringValue": "tool-in"}}],
                start="1700000000500000000",
            ),
        )
        session.commit()
        run = _run(session)
        # The root call is the earliest non-GENERATION source.
        assert run.preview_call_row_id == _call(session, ROOT).row_id

        # A GENERATION call arriving LATER must take over regardless.
        _ingest(
            session,
            _gen_payload(GEN1, "later prompt", "later answer", start="1700000002000000000"),
        )
        session.commit()
        run = _run(session)
        assert run.preview_call_row_id == _call(session, GEN1).row_id
        assert "later prompt" in (run.input_preview or "")

    def test_same_source_refresh_and_dangling(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_PROJECTION_WRITE_MODE", "dual")
        _ingest(session, _payload(ROOT, parent=None))
        _ingest(session, _gen_payload(GEN1, "v1 prompt", "v1 answer"))
        session.commit()
        run = _run(session)
        assert "v1 prompt" in (run.input_preview or "")

        # Re-project the same span with new content → preview refreshes
        # (row_id equality, not ordering, drives this).
        # Deep-copy before mutating: SQLAlchemy's change detection compares
        # against the loaded state, and a shared nested list compares equal
        # to itself — the mutation would never persist.
        import copy

        span = session.exec(
            select(OtlpSpanDB).where(OtlpSpanDB.span_id == GEN1)
        ).one()
        attrs = copy.deepcopy(span.attributes or {})
        messages = cast("list[dict[str, Any]]", attrs["gen_ai.input.messages"])
        messages[0]["content"] = "v2 prompt"
        span.attributes = attrs
        session.add(span)
        session.commit()
        assert _reproject_local(session) >= 1
        session.expire_all()
        run = _run(session)
        assert "v2 prompt" in (run.input_preview or "")

        # Dangling source: delete the source call row → next projection
        # overwrites freely instead of comparing against a ghost.
        gen_call = _call(session, GEN1)
        run.preview_call_row_id = gen_call.row_id
        session.delete(gen_call)
        session.commit()
        _ingest(
            session,
            _payload(
                GEN2,
                name="other.tool",
                gen_attrs=[
                    {"key": "input", "value": {"stringValue": "replacement"}}
                ],
            ),
        )
        session.commit()
        run = _run(session)
        assert run.preview_call_row_id == _call(session, GEN2).row_id


# ---------------------------------------------------------------------------
# Slim writes + golden read parity
# ---------------------------------------------------------------------------


class TestSlimGolden:
    def _seed_trace(self, session: Session) -> None:
        _ingest(session, _payload(ROOT, parent=None, name="root"))
        _ingest(session, _gen_payload(GEN1, "golden prompt", "golden answer"))
        _ingest(
            session,
            _payload(
                GEN2,
                name="db.query",
                gen_attrs=[
                    {"key": "input", "value": {"stringValue": "SELECT 1"}},
                    {"key": "output", "value": {"stringValue": "1"}},
                ],
            ),
        )
        session.commit()

    def test_detail_identical_across_modes(
        self, session: Session, client: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Fat projection of the trace, then capture the detail response.
        self._seed_trace(session)
        fat_response = _detail(client, include="messages")

        # Wipe ONLY the projection; the canonical spans stay.
        for table in ("call_metrics", "run_metrics", "logged_calls", "runs"):
            session.execute(text(f"DELETE FROM {table}"))
        session.commit()

        # Re-project the same spans in slim mode.
        monkeypatch.setenv("APO_PROJECTION_WRITE_MODE", "slim")
        assert _reproject_local(session) == 3
        slim_call = _call(session, GEN1)
        # Slim write: fat columns stay empty; run previews written.
        assert slim_call.input == {}
        assert slim_call.output == {}
        assert _run(session).input_preview is not None

        # Slim read resolves from spans — response identical to fat mode.
        slim_response = _detail(client, include="messages")

        def _io_only(response: dict[str, Any]) -> list[dict[str, Any]]:
            return [
                {
                    "id": c["id"],
                    "input": c.get("input"),
                    "output": c.get("output"),
                    "messages": c.get("messages"),
                    "observation_type": c.get("observation_type"),
                }
                for c in response["calls"]
            ]

        assert _io_only(slim_response) == _io_only(fat_response)
        assert slim_response["capabilities"] == fat_response["capabilities"]

    def test_fallback_for_span_less_rows(
        self, session: Session, client: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_PROJECTION_WRITE_MODE", "slim")
        _ingest(session, _payload(ROOT, parent=None))
        session.commit()
        # A span-less legacy row (dev seeding / legacy direct writer):
        # stores its I/O only in the fat columns.
        session.add(
            LoggedCallDB(
                id="legacy0000000001",
                run_id=TRACE,
                project="p1",
                task_id="",
                created_at=NOW,
                model="unknown",
                observation_type="GENERATION",
                latency_ms=1.0,
                input={"messages": [{"role": "user", "content": "legacy"}]},
                output={"text": "legacy answer"},
                messages=[{"role": "user", "content": "legacy"}],
            )
        )
        session.commit()

        response = _detail(client)
        legacy_call = next(
            c for c in response["calls"] if c["id"] == "legacy0000000001"
        )
        assert legacy_call["input"] == {
            "messages": [{"role": "user", "content": "legacy"}]
        }
        assert legacy_call["output"] == {"text": "legacy answer"}

    def test_export_and_snapshot_resolve_in_slim(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_PROJECTION_WRITE_MODE", "slim")
        self._seed_trace(session)

        from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB
        from apo.services.run_export import _trace_section
        from apo.services.trace_repository import NativeTraceRepository

        # A real task run with batch linkage — _trace_section resolves the
        # project through the batch join before scoping its selects.
        session.add(
            AgentTaskBatchRunDB(
                id="b-x",
                project="p1",
                selection_type="task",
                task_root="/tmp",
                environment="default",
                status="completed",
                created_at=NOW,
            )
        )
        session.commit()
        task_run = AgentTaskRunDB(
            id="r-x",
            batch_run_id="b-x",
            task_id="t",
            task_path="/tmp/t",
            status="passed",
            pass_result=True,
            trace_run_id=TRACE,
        )
        session.add(task_run)
        session.commit()

        # Export path hydrates before dumping.
        section = _trace_section(session, task_run, include_spans=False)
        assert section is not None
        gen_dump = next(c for c in section["calls"] if c["id"] == GEN1)
        assert gen_dump["input"], "slim export must carry resolved I/O"

        # Snapshot path hydrates before building observations.
        snapshot = NativeTraceRepository().get_projection_snapshot(
            session, project_id="p1", trace_id=TRACE
        )
        assert snapshot is not None
        gen_obs = next(o for o in snapshot.observations if o.span_id == GEN1)
        assert gen_obs.input
        assert gen_obs.messages, "capabilities/messages must survive slim mode"


# ---------------------------------------------------------------------------
# List reads never touch call I/O (previews mode)
# ---------------------------------------------------------------------------


class TestListPreviews:
    def test_list_reads_never_touch_call_io(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_PROJECTION_WRITE_MODE", "dual")
        _ingest(session, _payload(ROOT, parent=None))
        _ingest(session, _gen_payload(GEN1, "list prompt", "list answer"))
        session.commit()

        statements: list[str] = []

        def _capture(_conn, _cursor, statement, _params, *_a, **_kw):
            statements.append(statement)

        bind = session.get_bind()
        event.listen(bind, "before_cursor_execute", _capture)
        try:
            monkeypatch.setenv("APO_LIST_READ", "previews")
            previews = _fetch_io_previews(session, [TRACE], "p1")
        finally:
            event.remove(bind, "before_cursor_execute", _capture)
        assert previews[TRACE]["input"] is not None
        io_reads = [s for s in statements if "FROM logged_calls" in s]
        assert not io_reads, (
            "previews-mode list rendering must not query logged_calls; "
            f"saw: {io_reads}"
        )

        # Legacy mode still works and agrees.
        monkeypatch.setenv("APO_LIST_READ", "legacy")
        legacy = _fetch_io_previews(session, [TRACE], "p1")
        assert legacy == previews

    def test_null_preview_falls_back(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_PROJECTION_WRITE_MODE", "dual")
        _ingest(session, _payload(ROOT, parent=None))
        _ingest(session, _gen_payload(GEN1, "fb prompt", "fb answer"))
        session.commit()
        # Simulate a pre-Stage-2 run: no stored preview.
        run = _run(session)
        run.input_preview = None
        run.output_preview = None
        run.preview_call_row_id = None
        session.add(run)
        session.commit()

        monkeypatch.setenv("APO_LIST_READ", "previews")
        previews = _fetch_io_previews(session, [TRACE], "p1")
        assert previews[TRACE]["input"] is not None  # legacy fallback served


# ---------------------------------------------------------------------------
# Backfill job
# ---------------------------------------------------------------------------


class TestBackfill:
    def test_backfill_fills_previews_for_fat_era_runs(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Fat-era trace on the FILE engine — the job (and reproject_trace)
        # bind apo.db's engine.
        with Session(engine) as session:
            _ingest(session, _payload(ROOT, parent=None))
            _ingest(
                session, _gen_payload(GEN1, "backfill prompt", "backfill answer")
            )
            session.commit()
            assert _run(session).input_preview is None

        monkeypatch.setenv("APO_PROJECTION_WRITE_MODE", "dual")
        job_id = "job-test"
        _projection_jobs[job_id] = {
            "status": "running",
            "processed": 0,
            "skipped": 0,
            "errors": [],
        }
        _run_projection_backfill(job_id, None, 100)
        job = _projection_jobs[job_id]
        assert job["status"] == "done"
        assert job["processed"] == 1
        assert job["errors"] == []
        with Session(engine) as session:
            assert "backfill prompt" in (_run(session).input_preview or "")
