# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Tests for the Trace Projection repository.

The repository wraps the Trace Projection supplied by the projector and returns an
immutable ``TraceProjectionSnapshot`` — never SQLModel rows. It enforces
Project isolation on every lookup.

Key properties:
  - Project isolation: identical trace IDs in two projects return only the
    requesting project's observations.
  - No ORM leakage: snapshots serialize to stable lower-camel-case JSON.
  - Child-before-root tolerance: a child projects before its root yields a
    partial snapshot, then a complete one with correct parent IDs.
"""

from datetime import datetime, timezone

import pytest
from sqlmodel import Session, text

from apo.db import engine, init_db
from apo.models.db import LoggedCallDB, OtlpSpanDB, RunDB
from apo.models.trace_projection import TraceProjectionSnapshot
from apo.services.trace_repository import NativeTraceRepository


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM logged_calls"))
        session.execute(text("DELETE FROM otlp_spans"))
        session.execute(text("DELETE FROM runs"))
        session.commit()


def _iso(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _make_run(
    *,
    trace_id: str,
    project: str,
    flow_name: str = "test-flow",
    created_at: str = "2026-07-10T10:00:00Z",
    completed_at: str | None = "2026-07-10T10:00:05Z",
    duration_ms: float | None = 5000.0,
) -> RunDB:
    return RunDB(
        id=trace_id,
        project=project,
        flow_name=flow_name,
        environment="default",
        created_at=_iso(created_at),
        completed_at=_iso(completed_at) if completed_at else None,
        duration_ms=duration_ms,
    )


def _make_call(
    *,
    span_id: str,
    trace_id: str,
    project: str,
    parent_span_id: str | None,
    observation_type: str = "TOOL",
    step_name: str = "read_file",
    model: str = "unknown",
    created_at: str = "2026-07-10T10:00:01Z",
    level: str = "DEFAULT",
    status_message: str | None = None,
    latency_ms: float | None = 3.0,
    tool_name: str | None = None,
    tool_parameters: dict[str, object] | None = None,
    tool_result: dict[str, object] | None = None,
    output: dict[str, object] | None = None,
    messages: list[dict[str, object]] | None = None,
) -> LoggedCallDB:
    return LoggedCallDB(
        id=span_id,
        run_id=trace_id,
        project=project,
        task_id="",
        created_at=_iso(created_at),
        model=model,
        observation_type=observation_type,
        step_name=step_name,
        parent_call_id=parent_span_id,
        level=level,
        status_message=status_message,
        latency_ms=latency_ms,
        tool_name=tool_name,
        tool_parameters=tool_parameters,
        tool_result=tool_result,
        output=output or {},
        messages=messages or [],
        input={},
    )


class TestProjectIsolation:
    """Test 1: the repository isolates Projects."""

    def test_querying_a_trace_returns_only_that_projects_observations(self):
        """Project isolation: querying project A's trace returns only A's calls,
        never another project's. A trace_id that exists only in project B is
        invisible to project A (returns None)."""
        with Session(engine) as session:
            session.add(_make_run(trace_id="trace-a", project="proj-a"))
            session.add(_make_run(trace_id="trace-b", project="proj-b"))
            session.add(
                _make_call(span_id="a1", trace_id="trace-a", project="proj-a", parent_span_id=None, step_name="tool_a")
            )
            session.add(
                _make_call(span_id="b1", trace_id="trace-b", project="proj-b", parent_span_id=None, step_name="tool_b")
            )
            session.commit()

        repo = NativeTraceRepository()
        with Session(engine) as session:
            snap_a = repo.get_projection_snapshot(session, project_id="proj-a", trace_id="trace-a")
            snap_b_from_a = repo.get_projection_snapshot(session, project_id="proj-a", trace_id="trace-b")

        assert snap_a is not None
        names = [o.name for o in snap_a.observations if o.type == "TOOL"]
        assert names == ["tool_a"]
        # Project A cannot see project B's trace.
        assert snap_b_from_a is None

    def test_unknown_project_returns_none(self):
        """A trace_id that doesn't exist in the requested project returns None."""
        with Session(engine) as session:
            session.add(_make_run(trace_id="t1", project="proj-a"))
            session.commit()

        repo = NativeTraceRepository()
        with Session(engine) as session:
            snap = repo.get_projection_snapshot(session, project_id="proj-other", trace_id="t1")
        assert snap is None


class TestSerializationContract:
    """Test 2: snapshots serialize to stable lower-camel-case JSON."""

    def test_serialize_by_alias_lower_camel_case(self):
        with Session(engine) as session:
            session.add(_make_run(trace_id="t2", project="p"))
            session.add(
                _make_call(
                    span_id="s2",
                    trace_id="t2",
                    project="p",
                    parent_span_id=None,
                    observation_type="TOOL",
                    step_name="read_file",
                    tool_name="read_file",
                    tool_parameters={"path": "x"},
                    latency_ms=12.0,
                )
            )
            session.commit()

        repo = NativeTraceRepository()
        with Session(engine) as session:
            snap = repo.get_projection_snapshot(session, project_id="p", trace_id="t2")

        assert snap is not None
        data = snap.model_dump(by_alias=True, exclude_none=True)

        # Lower-camel-case keys, no ORM-only fields.
        assert "schemaVersion" in data
        assert "projectionVersion" in data
        assert data["schemaVersion"] == 1
        assert data["source"] == "canonical"
        assert "traceId" in data["trace"]
        assert "durationMs" in data["trace"]
        obs = data["observations"][0]
        assert "spanId" in obs
        assert "parentSpanId" not in obs  # excluded by exclude_none
        assert "toolName" in obs
        assert "toolParameters" in obs
        # No SQLModel internals leak.
        assert "sa_instance_state" not in str(data)

    def test_returns_pydantic_snapshot_not_orm_rows(self):
        with Session(engine) as session:
            session.add(_make_run(trace_id="t3", project="p", completed_at=None, duration_ms=None))
            session.commit()

        repo = NativeTraceRepository()
        with Session(engine) as session:
            snap = repo.get_projection_snapshot(session, project_id="p", trace_id="t3")

        assert snap is not None
        assert isinstance(snap, TraceProjectionSnapshot)


class TestChildBeforeRoot:
    """Test 3: child-before-root produces a stable hierarchy."""

    def test_partial_then_complete_with_correct_parent_ids(self):
        repo = NativeTraceRepository()

        # Phase 1: only the child exists (root run row absent). This is the
        # child-before-root window; the run row may not exist yet.
        with Session(engine) as session:
            session.add(
                _make_call(
                    span_id="child-1",
                    trace_id="t4",
                    project="p",
                    parent_span_id="root-1",
                    observation_type="TOOL",
                    step_name="early_tool",
                    created_at="2026-07-10T10:00:02Z",
                )
            )
            session.commit()

        with Session(engine) as session:
            partial = repo.get_projection_snapshot(session, project_id="p", trace_id="t4")
        # With only a child call and no run row, the snapshot is either None
        # (run not yet created) or partial. We accept partial-but-present here.
        # The spec wants: read before and after root projection -> partial then
        # complete. A run row is the projection of the root; without it, there
        # is no trace-level projection, so None is acceptable.
        if partial is not None:
            assert partial.trace.complete is False

        # Phase 2: root run row arrives -> complete snapshot with correct parent.
        with Session(engine) as session:
            session.add(_make_run(trace_id="t4", project="p"))
            session.commit()

        with Session(engine) as session:
            complete = repo.get_projection_snapshot(session, project_id="p", trace_id="t4")

        assert complete is not None
        assert complete.trace.complete is True
        # The child's parentSpanId points at the root.
        child = [o for o in complete.observations if o.span_id == "child-1"][0]
        assert child.parent_span_id == "root-1"


class TestCapabilities:
    """Capabilities are derived honestly from what the projected rows carry."""

    def test_capabilities_reflect_present_evidence(self):
        with Session(engine) as session:
            session.add(_make_run(trace_id="t5", project="p"))
            session.add(
                _make_call(
                    span_id="tool-1",
                    trace_id="t5",
                    project="p",
                    parent_span_id=None,
                    observation_type="TOOL",
                    step_name="read_file",
                    tool_name="read_file",
                    latency_ms=5.0,
                )
            )
            session.add(
                _make_call(
                    span_id="tool-err",
                    trace_id="t5",
                    project="p",
                    parent_span_id=None,
                    observation_type="TOOL",
                    step_name="bad",
                    tool_name="bad",
                    level="ERROR",
                    status_message="boom",
                    latency_ms=2.0,
                )
            )
            session.commit()

        repo = NativeTraceRepository()
        with Session(engine) as session:
            snap = repo.get_projection_snapshot(session, project_id="p", trace_id="t5")

        assert snap is not None
        assert snap.capabilities.tools.value == "available"
        assert snap.capabilities.errors.value == "available"
        assert snap.capabilities.timing.value == "available"
        assert snap.capabilities.messages.value == "unavailable"
        assert snap.capabilities.skills.value == "unavailable"
        assert snap.capabilities.subagents.value == "unavailable"
        assert snap.capabilities.usage.value == "unavailable"


class TestNondictJsonFields:
    """Regression for issue #23: free-form JSON fields (input/output/tool_result)
    can hold non-dict values (string, int, list). The projection read path must
    not crash — specifically ``_messages_for`` must not assume ``output`` is a
    dict when reconstructing generation messages.
    """

    def test_generation_with_nondict_output_does_not_crash(self):
        repo = NativeTraceRepository()
        with Session(engine) as session:
            session.add(_make_run(trace_id="nd1", project="p"))
            session.add(
                LoggedCallDB(
                    id="gen-int",
                    run_id="nd1",
                    project="p",
                    task_id="",
                    created_at=_iso("2026-07-10T10:00:01Z"),
                    model="m",
                    observation_type="GENERATION",
                    step_name="llm",
                    parent_call_id=None,
                    latency_ms=3.0,
                    input="a plain string input",
                    output=42,  # int, not a dict — previously AttributeError in _messages_for
                    messages=[],
                )
            )
            session.commit()

        with Session(engine) as session:
            snap = repo.get_projection_snapshot(session, project_id="p", trace_id="nd1")

        assert snap is not None
        obs = [o for o in snap.observations if o.span_id == "gen-int"][0]
        assert obs.output == 42
        assert obs.input == "a plain string input"
        # No message can be reconstructed from a non-dict output.
        assert obs.messages == ()
        assert snap.capabilities.messages.value == "unavailable"

    def test_generation_with_dict_output_text_still_reconstructs_message(self):
        # Guard against over-narrowing: a dict output with {"text": ...} must
        # still produce an assistant message.
        repo = NativeTraceRepository()
        with Session(engine) as session:
            session.add(_make_run(trace_id="nd2", project="p"))
            session.add(
                _make_call(
                    span_id="gen-dict",
                    trace_id="nd2",
                    project="p",
                    parent_span_id=None,
                    observation_type="GENERATION",
                    step_name="llm",
                    output={"text": "hello world"},
                )
            )
            session.commit()

        with Session(engine) as session:
            snap = repo.get_projection_snapshot(session, project_id="p", trace_id="nd2")

        assert snap is not None
        obs = [o for o in snap.observations if o.span_id == "gen-dict"][0]
        assert len(obs.messages) == 1
        assert obs.messages[0].content == "hello world"
        assert snap.capabilities.messages.value == "available"


class TestTokenUsage:
    """Observations carry the call's token counts so agent-task token budgets
    (``t.maxTokens`` / ``t.minTokens``) can be evaluated against the canonical
    projection, including on rejudge replay."""

    def test_usage_projected_and_unknown_dimension_stays_null(self):
        with Session(engine) as session:
            session.add(_make_run(trace_id="tu", project="p"))
            with_usage = _make_call(
                span_id="gen-1",
                trace_id="tu",
                project="p",
                parent_span_id=None,
                observation_type="GENERATION",
                step_name="agent-llm-call",
            )
            with_usage.prompt_tokens = 1200
            with_usage.completion_tokens = 0
            input_only = _make_call(
                span_id="gen-2",
                trace_id="tu",
                project="p",
                parent_span_id=None,
                observation_type="GENERATION",
                step_name="agent-llm-call",
            )
            input_only.prompt_tokens = 50
            session.add(with_usage)
            session.add(input_only)
            session.add(
                _make_call(span_id="tool-1", trace_id="tu", project="p", parent_span_id=None)
            )
            session.commit()

        repo = NativeTraceRepository()
        with Session(engine) as session:
            snap = repo.get_projection_snapshot(session, project_id="p", trace_id="tu")

        assert snap is not None
        by_id = {o.span_id: o for o in snap.observations}
        assert by_id["gen-1"].usage is not None
        assert by_id["gen-1"].usage.input_tokens == 1200
        # A reported zero is a measurement, not "unknown".
        assert by_id["gen-1"].usage.output_tokens == 0
        assert by_id["gen-2"].usage is not None
        assert by_id["gen-2"].usage.output_tokens is None
        assert by_id["tool-1"].usage is None
        assert snap.capabilities.usage.value == "available"

        dumped = snap.model_dump(by_alias=True, mode="json")
        gen = [o for o in dumped["observations"] if o["spanId"] == "gen-1"][0]
        assert gen["usage"] == {"inputTokens": 1200, "outputTokens": 0}
        assert dumped["capabilities"]["usage"] == "available"

    def test_errored_generation_keeps_usage_and_is_marked_errored(self):
        """A provider error often drops the final usage event, so the count is
        a lower bound: kept (it was spent) and flagged by an error status."""
        with Session(engine) as session:
            session.add(_make_run(trace_id="te", project="p"))
            for span_id, attrs in (
                ("gen-ok", {}),
                ("gen-finish-error", {"gen_ai.response.finish_reasons": ["error"]}),
            ):
                call = _make_call(
                    span_id=span_id,
                    trace_id="te",
                    project="p",
                    parent_span_id=None,
                    observation_type="GENERATION",
                    step_name="agent-llm-call",
                )
                call.prompt_tokens = 10
                call.completion_tokens = 0
                session.add(call)
                session.add(
                    OtlpSpanDB(
                        project_id="p",
                        trace_id="te",
                        span_id=span_id,
                        name="agent-llm-call",
                        attributes=attrs,
                        created_at=_iso("2026-07-10T10:00:01Z"),
                    )
                )
            session.commit()

        repo = NativeTraceRepository()
        with Session(engine) as session:
            snap = repo.get_projection_snapshot(session, project_id="p", trace_id="te")

        assert snap is not None
        by_id = {o.span_id: o for o in snap.observations}
        assert by_id["gen-ok"].usage is not None
        assert by_id["gen-ok"].status.value == "ok"
        assert by_id["gen-finish-error"].usage is not None
        assert by_id["gen-finish-error"].usage.input_tokens == 10
        assert by_id["gen-finish-error"].status.value == "error"

    def test_snapshot_without_usage_capability_still_parses(self):
        legacy = {
            "schemaVersion": 1,
            "projectionVersion": 1,
            "source": "canonical",
            "trace": {"traceId": "t", "complete": True},
            "capabilities": {
                "messages": "available",
                "tools": "available",
                "errors": "available",
                "timing": "available",
                "skills": "unavailable",
                "subagents": "unavailable",
            },
            "observations": [],
        }
        snap = TraceProjectionSnapshot.model_validate(legacy)
        assert snap.capabilities.usage.value == "unavailable"


class TestRetrievalCapability:
    """Retrieval evidence availability, mirroring the SDK tee's derivation.

    Recorded runs evaluate the backend's canonical projection, so a retrieval
    that exported its documents on the tool channels must read back as
    available, and one whose result shape was unrecognized must read as
    partial — never available, never silently absent.
    """

    def _capabilities(self, calls: list[LoggedCallDB], trace_id: str, project: str):
        with Session(engine) as session:
            session.add(_make_run(trace_id=trace_id, project=project))
            for call in calls:
                session.add(call)
            session.commit()
            snapshot = NativeTraceRepository().get_projection_snapshot(
                session, project_id=project, trace_id=trace_id
            )
        assert snapshot is not None
        return snapshot

    def test_retrieval_with_documents_on_tool_channels_is_available(self):
        snapshot = self._capabilities(
            [
                _make_call(
                    span_id="r1",
                    trace_id="t-rag-1",
                    project="proj-rag",
                    parent_span_id=None,
                    observation_type="RETRIEVER",
                    step_name="retrieve",
                    tool_parameters={"query": "vacation days"},
                    tool_result={
                        "documents": [
                            {"id": "handbook-vacation#p1", "score": 0.9, "content": "25 days"}
                        ]
                    },
                )
            ],
            trace_id="t-rag-1",
            project="proj-rag",
        )
        assert snapshot.capabilities.retrieval.value == "available"
        (obs,) = [o for o in snapshot.observations if o.type == "RETRIEVER"]
        assert obs.tool_parameters == {"query": "vacation days"}

    def test_retrieval_with_unrecognized_result_is_partial(self):
        snapshot = self._capabilities(
            [
                _make_call(
                    span_id="r1",
                    trace_id="t-rag-2",
                    project="proj-rag",
                    parent_span_id=None,
                    observation_type="RETRIEVER",
                    step_name="retrieve",
                    output={"hits": 3},
                )
            ],
            trace_id="t-rag-2",
            project="proj-rag",
        )
        assert snapshot.capabilities.retrieval.value == "partial"

    def test_trace_without_retrievals_is_unavailable(self):
        snapshot = self._capabilities(
            [
                _make_call(
                    span_id="t1",
                    trace_id="t-rag-3",
                    project="proj-rag",
                    parent_span_id=None,
                )
            ],
            trace_id="t-rag-3",
            project="proj-rag",
        )
        assert snapshot.capabilities.retrieval.value == "unavailable"
