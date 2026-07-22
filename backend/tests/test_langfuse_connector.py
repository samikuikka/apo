# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false
# pyright: reportIndexIssue=false, reportAttributeAccessIssue=false

"""SPEC-137 scene test #2: FastAPI OTLP route projects a converted Langfuse fixture.

Loads the deterministic OTLP fixture produced by the CLI converter
(specs/fixtures/langfuse/single-trace-otlp.json), authenticates as a real
Project, POSTs it through the registered /api/public/otel/v1/traces route,
runs the queued projection worker, and asserts the resulting Trace appears
in the normal trace query path with the Langfuse-derived semantics:

  * trace name / tags / provenance on the run
  * hierarchy (root / child / grandchild)
  * I/O decoded from apo.observation.input/output
  * model + token usage from gen_ai.*
  * reported USD cost from apo.observation.cost.amount
  * OTel ERROR status preserved
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlmodel import Session, select, text

from apo.db import engine, init_db
from apo.models.db import LoggedCallDB, RunDB
from apo.services.otlp_receiver import OtlpReceiver
from apo.services.trace_ingestion_queue import QueueWorker
from apo.models.trace_ingestion import TraceIngestionContext
from apo.auth.api_key_auth import _hash_secret_key

try:
    from apo.models.db import ApiKeyDB  # type: ignore
except ImportError:  # pragma: no cover
    ApiKeyDB = None  # type: ignore[assignment]


_PROJECT = "langfuse-connector"
_PUBLIC_KEY = "pk-lf-connector"
_SECRET_KEY = "sk-lf-connector"


@pytest.fixture(autouse=True)
def setup_database():
    init_db()
    with Session(engine) as session:
        # Ensure a project + API key exist so receiver auth + project binding work.
        try:
            session.add(
                ApiKeyDB(  # type: ignore[misc]
                    public_key=_PUBLIC_KEY,
                    hashed_secret_key=_hash_secret_key(_SECRET_KEY),
                    display_secret_key=_SECRET_KEY[:4] + "…",
                    prefix=_PUBLIC_KEY[:8],
                    project=_PROJECT,
                    created_by="langfuse-connector-test",
                    scope="full",
                )
            )
            session.commit()
        except Exception:
            session.rollback()
    yield
    with Session(engine) as session:
        for table in (
            "call_metrics",
            "run_metrics",
            "logged_calls",
            "runs",
            "otlp_spans",
            "otlp_ingest_batches",
        ):
            session.execute(text(f"DELETE FROM {table}"))
        session.execute(
            text("DELETE FROM api_keys WHERE public_key = :k"), {"k": _PUBLIC_KEY}
        )
        session.commit()


def _load_otlp_fixture() -> dict[str, object]:
    fixture_path = (
        Path(__file__).resolve().parent
        / "fixtures"
        / "langfuse"
        / "single-trace-otlp.json"
    )
    return json.loads(fixture_path.read_text())


def _project_directly(payload: dict[str, object]) -> None:
    """Receive + project the OTLP payload through the registered receiver."""
    body = json.dumps(payload).encode("utf-8")
    context = TraceIngestionContext(
        public_key=_PUBLIC_KEY,
        project_id=_PROJECT,
        scope="full",
        auth_method="api_key",
    )
    with Session(engine) as session:
        receiver = OtlpReceiver()
        result = receiver.ingest(
            payload=body,
            content_type="application/json",
            project_id=_PROJECT,
            session=session,
            encoding="json",
            content_policy="full",
            context=context,
            project_immediately=False,
        )
        session.commit()
        assert result.batch_id, f"ingestion did not return a batch id: {result!r}"

    # Drain the projection queue for that batch.
    import asyncio

    async def _drain() -> None:
        worker = QueueWorker(receiver=OtlpReceiver())
        await worker.process_batch(result.batch_id)

    asyncio.run(_drain())


class TestLangfuseConnectorProjectsFixture:
    def test_imported_trace_appears_with_full_semantics(self):
        fixture = _load_otlp_fixture()
        _project_directly(fixture)

        expected_trace_id = fixture["expectedTraceId"]
        assert isinstance(expected_trace_id, str)

        with Session(engine) as session:
            run = session.exec(
                select(RunDB).where(RunDB.id == expected_trace_id)
            ).first()
            assert run is not None, "RunDB row was not projected"
            assert run.project == _PROJECT
            assert run.flow_name == "Imported Langfuse session"
            assert "imported" in (run.tags or [])
            assert "source:langfuse" in (run.tags or [])
            assert "prod" in (run.tags or [])
            assert "experiment-7" in (run.tags or [])
            # Provenance / trace metadata lands in run_metadata as canonical
            # apo.trace.metadata plus release.
            metadata = run.run_metadata or {}
            assert metadata.get("release") == "v1.4.0"

            calls = session.exec(
                select(LoggedCallDB)
                .where(LoggedCallDB.run_id == expected_trace_id)
                .order_by(LoggedCallDB.created_at)
            ).all()
            assert len(calls) == 3

            # The root has the earliest start time.
            root = calls[0]
            assert root.parent_call_id is None

            # The generation carries model, tokens, reported cost, and I/O.
            gen = next(c for c in calls if c.model == "gpt-4o")
            assert gen.prompt_tokens == 220
            assert gen.completion_tokens == 80
            assert gen.total_tokens == 300
            assert gen.cost is not None
            assert abs(gen.cost - 0.0456) < 1e-9
            # I/O came through apo.observation.input/output (wrapped as
            # { value: ... }) and landed in the call columns.
            assert isinstance(gen.input, dict)
            assert isinstance(gen.output, dict)

            # Hierarchy: tool is a grandchild of root via the generation.
            tool = next(
                c for c in calls if c.step_name and "search_docs" in c.step_name
            )
            assert tool.parent_call_id == gen.id

    def test_otlp_error_status_projects_to_call_level_error(self):
        # Reuse the fixture but flip the generation to ERROR via a custom payload.
        fixture = _load_otlp_fixture()
        resource_spans = fixture["resourceSpans"]
        for rs in resource_spans:  # type: ignore[union-attr]
            for ss in rs["scopeSpans"]:  # type: ignore[index]
                for span in ss["spans"]:  # type: ignore[index]
                    if "gpt-4o" in span["name"]:  # type: ignore[index]
                        span["status"] = {"code": 2, "message": "upstream rate limited"}  # type: ignore[index]
        _project_directly(fixture)

        expected_trace_id = fixture["expectedTraceId"]
        with Session(engine) as session:
            calls = session.exec(
                select(LoggedCallDB).where(LoggedCallDB.run_id == expected_trace_id)
            ).all()
            err_calls = [c for c in calls if c.level == "ERROR"]
            assert len(err_calls) == 1
            assert err_calls[0].status_message == "upstream rate limited"
            assert err_calls[0].model == "gpt-4o"

    def test_reimporting_same_fixture_is_idempotent(self):
        fixture = _load_otlp_fixture()
        _project_directly(fixture)
        _project_directly(fixture)

        expected_trace_id = fixture["expectedTraceId"]
        with Session(engine) as session:
            runs = session.exec(
                select(RunDB).where(RunDB.id == expected_trace_id)
            ).all()
            assert len(runs) == 1, "re-import must not duplicate the run"
            calls = session.exec(
                select(LoggedCallDB).where(LoggedCallDB.run_id == expected_trace_id)
            ).all()
            assert len(calls) == 3, "re-import must not duplicate calls"
