# pyright: reportAny=false, reportDeprecated=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnusedCallResult=false, reportUnusedImport=false

"""Tests for the Trace Projector.

The projector takes canonical ``OtlpSpanDB`` rows, normalizes them via the
Track 2 normalizer, and upserts into the existing ``RunDB``/``LoggedCallDB``
tables. This bridges the canonical OTel store to the dashboard's existing
query layer without requiring a visual rewrite.

Key properties:
  - Tolerates child-before-root ordering
  - Idempotent: projecting the same span twice doesn't duplicate rows
  - Derives run-level data from the root span, not the first batch
  - Preserves all the fields the dashboard renders (input, output, tokens, etc.)
"""

import json
from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select, text
from apo.db import engine, init_db
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    OtlpSpanDB,
    RunDB,
    LoggedCallDB,
)
from apo.services.trace_projector import TraceProjector


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM run_metrics"))
        session.execute(text("DELETE FROM logged_calls"))
        session.execute(text("DELETE FROM runs"))
        session.execute(text("DELETE FROM otlp_spans"))
        session.execute(text("DELETE FROM otlp_ingest_batches"))
        session.execute(text("DELETE FROM agent_task_runs"))
        session.execute(text("DELETE FROM agent_task_batch_runs"))
        session.commit()


def _make_canonical_span(
    *,
    trace_id: str,
    span_id: str,
    parent_span_id: str | None = None,
    name: str = "test-span",
    attributes: dict[str, object] | None = None,
    start: str = "2026-07-09T12:00:00Z",
    end: str = "2026-07-09T12:00:01Z",
    project_id: str = "test-project",
) -> OtlpSpanDB:
    return OtlpSpanDB(
        project_id=project_id,
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        start_time=datetime.fromisoformat(start.replace("Z", "+00:00")),
        end_time=datetime.fromisoformat(end.replace("Z", "+00:00")),
        span_name=name,
        attributes=attributes or {},
        resource={},
    )


class TestTraceProjectorBasics:
    """Basic projection: canonical spans → RunDB + LoggedCallDB."""

    def test_project_creates_run_from_root_span(self):
        """A root span (no parent) creates a RunDB row."""
        span = _make_canonical_span(
            trace_id="proj-root-001",
            span_id="root-span-01",
            name="agent.run",
            attributes={"apo.observation.type": "AGENT"},
        )

        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(span, session)
            session.commit()

        with Session(engine) as session:
            run = session.exec(select(RunDB).where(RunDB.id == "proj-root-001")).first()
            assert run is not None
            assert run.project == "test-project"

    def test_project_creates_call_from_each_span(self):
        """Each span becomes a LoggedCallDB row."""
        root = _make_canonical_span(
            trace_id="proj-calls-01",
            span_id="root-c-01",
            attributes={"apo.observation.type": "AGENT"},
        )
        child = _make_canonical_span(
            trace_id="proj-calls-01",
            span_id="child-c-01",
            parent_span_id="root-c-01",
            name="chat gpt-4o",
            attributes={
                "gen_ai.request.model": "gpt-4o",
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 50,
            },
        )

        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(root, session)
            projector.project(child, session)
            session.commit()

        with Session(engine) as session:
            calls = list(
                session.exec(
                    select(LoggedCallDB).where(LoggedCallDB.run_id == "proj-calls-01")
                )
            )
            assert len(calls) == 2

    def test_project_preserves_hierarchy(self):
        """Parent-child span relationships are preserved in LoggedCallDB."""
        root = _make_canonical_span(
            trace_id="proj-hier-001",
            span_id="root-h-01",
            attributes={"apo.observation.type": "AGENT"},
        )
        child = _make_canonical_span(
            trace_id="proj-hier-001",
            span_id="child-h-01",
            parent_span_id="root-h-01",
            attributes={"gen_ai.tool.name": "search"},
        )

        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(root, session)
            projector.project(child, session)
            session.commit()

        with Session(engine) as session:
            child_call = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "child-h-01")).first()
            assert child_call is not None
            assert child_call.parent_call_id == "root-h-01"

    def test_project_maps_normalized_fields_to_call(self):
        """The normalizer's output maps to LoggedCallDB columns."""
        span = _make_canonical_span(
            trace_id="proj-fields-01",
            span_id="span-f-01",
            name="chat gpt-4o",
            attributes={
                "gen_ai.request.model": "gpt-4o",
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 50,
                "gen_ai.input.messages": '[{"role":"user","parts":[{"content":"hi","type":"text"}]}]',
                "gen_ai.output.messages": '[{"role":"assistant","parts":[{"content":"hello","type":"text"}]}]',
            },
        )

        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(span, session)
            session.commit()

        with Session(engine) as session:
            call = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "span-f-01")).first()
            assert call is not None
            assert call.model == "gpt-4o"
            assert call.prompt_tokens == 100
            assert call.completion_tokens == 50
            assert call.input is not None
            assert "messages" in call.input  # pyright: ignore[reportOperatorIssue]
            assert call.output is not None
            assert call.output.get("text") == "hello"  # pyright: ignore[reportAttributeAccessIssue]


class TestTraceProjectorFlowName:
    """The run name (flow_name) follows a fallback chain:

    apo.trace.name → apo.run.flow_name → root span name.
    The root span name is always present in OTLP, so a run never
    renders as "Untitled" just because the source omitted a name.
    """

    def test_explicit_trace_name_wins(self):
        span = _make_canonical_span(
            trace_id="flow-name-01",
            span_id="root-fn-01",
            name="span.internal",
            attributes={
                "apo.trace.name": "explicit-trace-name",
                "apo.run.flow_name": "legacy-flow-name",
            },
        )
        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(span, session)
            session.commit()

        with Session(engine) as session:
            run = session.exec(select(RunDB).where(RunDB.id == "flow-name-01")).first()
            assert run is not None
            assert run.flow_name == "explicit-trace-name"

    def test_legacy_flow_name_used_when_no_trace_name(self):
        span = _make_canonical_span(
            trace_id="flow-name-02",
            span_id="root-fn-02",
            name="apo.task.run",
            attributes={"apo.run.flow_name": "agent-task.abc-123"},
        )
        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(span, session)
            session.commit()

        with Session(engine) as session:
            run = session.exec(select(RunDB).where(RunDB.id == "flow-name-02")).first()
            assert run is not None
            assert run.flow_name == "agent-task.abc-123"

    def test_falls_back_to_span_name_when_no_name_attribute(self):
        """Root spans without any name attribute use span_name as flow_name.

        This is the defense-in-depth fix: an imported trace whose source
        had no trace-level name (and whose connector emitted none) still
        gets a run name instead of rendering as "Untitled".
        """
        span = _make_canonical_span(
            trace_id="flow-name-03",
            span_id="root-fn-03",
            name="sandbox-agent-query",
            attributes={"apo.observation.type": "AGENT"},
        )
        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(span, session)
            session.commit()

        with Session(engine) as session:
            run = session.exec(select(RunDB).where(RunDB.id == "flow-name-03")).first()
            assert run is not None
            assert run.flow_name == "sandbox-agent-query"


class TestTraceProjectorTraceAttribution:
    """Trace-level session/user/environment/tags follow convention priority.

    The private ``apo.run.*`` namespace is apo's own; standard senders emit
    GenAI conventions (``gen_ai.conversation.id``), Langfuse-SDK conventions
    (``langfuse.trace.*``), or OTel general conventions (``session.id`` /
    ``user.id`` / resource ``deployment.environment.name``). All must reach
    the run's indexed columns or the sessions view stays empty for every
    non-legacy sender (issue #189).
    """

    def _project_root(
        self,
        trace_id: str,
        attributes: dict[str, object],
        resource: dict[str, object] | None = None,
    ):
        span = _make_canonical_span(
            trace_id=trace_id, span_id=f"root-{trace_id}", attributes=attributes
        )
        if resource is not None:
            span.resource = resource
        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(span, session)
            session.commit()
        with Session(engine) as session:
            run = session.exec(select(RunDB).where(RunDB.id == trace_id)).first()
            assert run is not None
            return run

    def test_session_id_from_langfuse_trace_convention(self):
        run = self._project_root(
            "attr-sess-01", {"langfuse.trace.session_id": "lf-session-7"}
        )
        assert run.session_id == "lf-session-7"

    def test_session_id_from_genai_conversation_id(self):
        run = self._project_root(
            "attr-sess-02", {"gen_ai.conversation.id": "conv-42"}
        )
        assert run.session_id == "conv-42"

    def test_session_id_from_otel_general_convention(self):
        run = self._project_root("attr-sess-03", {"session.id": "otel-sess"})
        assert run.session_id == "otel-sess"

    def test_apo_session_id_wins_over_lower_conventions(self):
        run = self._project_root(
            "attr-sess-04",
            {
                "apo.run.session_id": "apo-first",
                "langfuse.trace.session_id": "lf-second",
                "gen_ai.conversation.id": "genai-third",
            },
        )
        assert run.session_id == "apo-first"

    def test_user_id_from_langfuse_trace_convention(self):
        run = self._project_root(
            "attr-user-01", {"langfuse.trace.user_id": "user-lf-9"}
        )
        assert run.user_id == "user-lf-9"

    def test_user_id_from_otel_general_convention(self):
        run = self._project_root("attr-user-02", {"user.id": "otel-user"})
        assert run.user_id == "otel-user"

    def test_apo_user_id_wins(self):
        run = self._project_root(
            "attr-user-03",
            {"apo.run.user_id": "apo-user", "user.id": "otel-user"},
        )
        assert run.user_id == "apo-user"

    def test_environment_from_langfuse_attribute(self):
        run = self._project_root(
            "attr-env-01",
            {"langfuse.environment": "staging"},
            resource={"attributes": {"deployment.environment.name": "should-lose"}},
        )
        assert run.environment == "staging"

    def test_environment_from_resource_deployment_environment_name(self):
        run = self._project_root(
            "attr-env-02",
            {},
            resource={"attributes": {"deployment.environment.name": "production"}},
        )
        assert run.environment == "production"

    def test_environment_from_legacy_resource_key(self):
        run = self._project_root(
            "attr-env-03",
            {},
            resource={"attributes": {"deployment.environment": "dev"}},
        )
        assert run.environment == "dev"

    def test_apo_environment_wins(self):
        run = self._project_root(
            "attr-env-04",
            {"apo.run.environment": "apo-env"},
            resource={"attributes": {"deployment.environment.name": "res-env"}},
        )
        assert run.environment == "apo-env"

    def test_tags_from_langfuse_trace_tags(self):
        run = self._project_root(
            "attr-tags-01", {"langfuse.trace.tags": ["prod", "eval"]}
        )
        assert run.tags == ["prod", "eval"]


class TestTraceProjectorIdempotency:
    """Projecting the same span twice must not duplicate rows."""

    def test_idempotent_projection(self):
        span = _make_canonical_span(
            trace_id="proj-idem-001",
            span_id="span-i-01",
            attributes={"gen_ai.request.model": "gpt-4o"},
        )

        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(span, session)
            session.commit()

        # Project again (simulating a retry/duplicate export)
        with Session(engine) as session:
            projector.project(span, session)
            session.commit()

        with Session(engine) as session:
            calls = list(
                session.exec(
                    select(LoggedCallDB).where(LoggedCallDB.span_id == "span-i-01")  # pyright: ignore[reportAttributeAccessIssue]
                    if hasattr(LoggedCallDB, "span_id")
                    else select(LoggedCallDB).where(LoggedCallDB.id == "span-i-01")
                )
            )
            assert len(calls) == 1

    def test_reimport_with_different_trace_id_does_not_duplicate(self):
        """Issue #104: a langfuse re-import lands the same observation under a
        different ``trace_id`` (e.g. ``--trace-id`` override, or a different
        source host). The span_id is the deterministic identity, so the
        projector must upsert the existing call — not append a second copy."""
        original = _make_canonical_span(
            trace_id="trace-original",
            span_id="span-reimport-01",
            name="chat gpt-4o",
            attributes={
                "gen_ai.request.model": "gpt-4o",
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 50,
            },
        )
        reimported = _make_canonical_span(
            trace_id="trace-reimport-override",  # different trace_id, same span_id
            span_id="span-reimport-01",
            name="chat gpt-4o",
            attributes={
                "gen_ai.request.model": "gpt-4o",
                "gen_ai.usage.input_tokens": 100,
                "gen_ai.usage.output_tokens": 50,
            },
        )

        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(original, session)
            session.commit()
        with Session(engine) as session:
            projector.project(reimported, session)
            session.commit()

        with Session(engine) as session:
            calls = list(
                session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "span-reimport-01"))
            )
            assert len(calls) == 1, "re-import must upsert, not append"
            # Cost was recomputed on the re-projection (not left stale).
            assert calls[0].cost is not None


class TestTraceProjectorChildBeforeRoot:
    """The projector must tolerate children arriving before roots."""

    def test_child_before_root(self):
        child = _make_canonical_span(
            trace_id="proj-cbr-001",
            span_id="child-cbr-1",
            parent_span_id="root-cbr-01",
            attributes={"gen_ai.request.model": "gpt-4o"},
        )
        root = _make_canonical_span(
            trace_id="proj-cbr-001",
            span_id="root-cbr-01",
            attributes={"apo.observation.type": "AGENT"},
        )

        projector = TraceProjector()
        with Session(engine) as session:
            # Child first
            projector.project(child, session)
            # Root second
            projector.project(root, session)
            session.commit()

        with Session(engine) as session:
            run = session.exec(select(RunDB).where(RunDB.id == "proj-cbr-001")).first()
            assert run is not None
            calls = list(
                session.exec(
                    select(LoggedCallDB).where(LoggedCallDB.run_id == "proj-cbr-001")
                )
            )
            assert len(calls) == 2


class TestTraceProjectorTaskRunCostRefresh:
    """Issue #41: projecting costed spans into a trace linked to a finalized
    Task Run must refresh the run's total_cost/total_tokens.

    The task runner aggregates cost exactly once, at finalize. For imported
    traces (e.g. ``traces import langfuse``), costed spans land AFTER finalize,
    so the projector must re-aggregate when it upserts calls for a trace whose
    ``RunDB.task_run_id`` is set.
    """

    @staticmethod
    def _seed_finalized_task_run(
        *, task_run_id: str, trace_id: str, project: str = "test-project"
    ) -> None:
        """Seed a finalized Task Run linked to a trace, with total_cost=None."""
        with Session(engine) as session:
            batch = AgentTaskBatchRunDB(
                id=f"batch-{task_run_id}",
                project=project,
                selection_type="manual",
                status="completed",
            )
            run = AgentTaskRunDB(
                id=task_run_id,
                batch_run_id=batch.id,
                task_id="t",
                task_path="p",
                status="passed",
                trace_run_id=trace_id,
                total_cost=None,
                total_tokens=None,
            )
            trace = RunDB(
                id=trace_id,
                project=project,
                environment="default",
                task_run_id=task_run_id,
                call_count=0,
            )
            session.add(batch)
            session.add(run)
            session.add(trace)
            session.commit()

    def test_costed_child_span_refreshes_task_run_total(self):
        """A costed child span projected after finalize updates total_cost.

        This is the exact issue #41 scenario: the run was finalized before any
        costed ``agent-llm-call`` observations existed, so the finalize-time
        aggregation wrote None. Projecting the costed call later must refresh.
        """
        self._seed_finalized_task_run(
            task_run_id="run-cost-1", trace_id="trace-cost-1"
        )
        root = _make_canonical_span(
            trace_id="trace-cost-1",
            span_id="root-cost-1",
            attributes={"apo.observation.type": "AGENT"},
        )
        costed_call = _make_canonical_span(
            trace_id="trace-cost-1",
            span_id="call-cost-1",
            parent_span_id="root-cost-1",
            name="agent-llm-call",
            attributes={"apo.observation.cost.amount": 0.2568},
        )

        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(root, session)
            projector.project(costed_call, session)
            session.commit()

        with Session(engine) as session:
            task_run = session.get(AgentTaskRunDB, "run-cost-1")
            assert task_run is not None
            assert task_run.total_cost is not None
            # 0.2568 USD → 256800 micro-USD
            assert task_run.total_cost == 256800.0

    def test_multiple_costed_spans_accumulate(self):
        """Two costed calls projected in sequence accumulate into the total."""
        self._seed_finalized_task_run(
            task_run_id="run-cost-2", trace_id="trace-cost-2"
        )
        root = _make_canonical_span(
            trace_id="trace-cost-2",
            span_id="root-cost-2",
            attributes={"apo.observation.type": "AGENT"},
        )
        call_a = _make_canonical_span(
            trace_id="trace-cost-2",
            span_id="call-2a",
            parent_span_id="root-cost-2",
            attributes={"apo.observation.cost.amount": 0.2000},
        )
        call_b = _make_canonical_span(
            trace_id="trace-cost-2",
            span_id="call-2b",
            parent_span_id="root-cost-2",
            attributes={"apo.observation.cost.amount": 0.0500},
        )

        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(root, session)
            projector.project(call_a, session)
            projector.project(call_b, session)
            session.commit()

        with Session(engine) as session:
            task_run = session.get(AgentTaskRunDB, "run-cost-2")
            assert task_run is not None
            # 0.2000 + 0.0500 = 0.2500 USD → 250000 micro-USD
            assert task_run.total_cost == 250000.0

    def test_unlinked_trace_does_not_crash(self):
        """A trace with no task_run_id must project without raising."""
        span = _make_canonical_span(
            trace_id="trace-unlinked-41",
            span_id="span-unlinked-41",
            attributes={"apo.observation.cost.amount": 0.01},
        )
        projector = TraceProjector()
        with Session(engine) as session:
            projector.project(span, session)
            session.commit()
        # No assertion beyond not raising — unlinked traces are the common case.
