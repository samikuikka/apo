# pyright: reportAny=false, reportAttributeAccessIssue=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUnusedParameter=false

"""Run export bundles, task-definition-revision GC, and the SQLITE_FULL
degradation path — phase 3 of the data-growth plan (issue #177)."""

import asyncio
import base64
import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskCheckReportDB,
    AgentTaskDeliverableDB,
    AgentTaskJudgmentDB,
    AgentTaskRunDB,
    AgentTaskTestResultCorrectionDB,
    LoggedCallDB,
    OtlpSpanDB,
    ProjectDB,
    RunDB,
    TaskDefinitionRevisionDB,
    TaskExecutionAttemptDB,
    UserDB,
)
from apo.services.retention import reap_unreferenced_task_definition_revisions

NOW = datetime.now(timezone.utc)


def _make_user(session: Session, email: str) -> UserDB:
    user = UserDB(email=email, name=email, password_hash="x", is_active=True)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _seed_export_run(session: Session) -> None:
    owner = _make_user(session, "owner@t.dev")
    session.add(ProjectDB(id="p-ex", name="p-ex", created_by=owner.id))
    session.commit()
    session.add(
        AgentTaskBatchRunDB(
            id="b-ex",
            project="p-ex",
            selection_type="task",
            task_root="/tmp",
            environment="default",
            status="completed",
            created_at=NOW - timedelta(days=1),
        )
    )
    revision = TaskDefinitionRevisionDB(
        project="p-ex",
        task_id="t",
        schema_version=1,
        content_sha256="a" * 64,
        source_files_json=[{"path": "t.eval.ts", "content": "export default {}"}],
        source_size_bytes=20,
        created_at=NOW - timedelta(days=2),
    )
    session.add(revision)
    session.commit()
    session.add(
        AgentTaskRunDB(
            id="r-ex",
            batch_run_id="b-ex",
            task_id="t",
            task_path="/tmp/t",
            status="failed",
            pass_result=False,
            total_checks=1,
            failed_checks=1,
            transcript_json={"turns": ["..."]},
            trace_run_id="trace-ex",
            task_definition_revision_id=revision.id,
            started_at=NOW - timedelta(days=1),
            completed_at=NOW - timedelta(days=1),
        )
    )
    session.commit()
    digest = hashlib.sha256(b"artifact-bytes").hexdigest()
    session.add(AgentTaskCheckReportDB(run_id="r-ex", value_json=[{"check": 1}], created_at=NOW))
    session.add(
        AgentTaskDeliverableDB(
            id="dlv-json",
            project="p-ex",
            task_run_id="r-ex",
            name="summary",
            kind="json",
            status="ready",
            inline_value_json={"value": {"ok": True}},
            media_type="application/json",
            size_bytes=12,
            sha256=hashlib.sha256(b"{}").hexdigest(),
            created_at=NOW,
            ready_at=NOW,
        )
    )
    session.add(
        AgentTaskDeliverableDB(
            id="dlv-art",
            project="p-ex",
            task_run_id="r-ex",
            name="report.md",
            kind="artifact",
            status="ready",
            storage_backend="local",
            storage_key="ex/report",
            media_type="text/markdown",
            size_bytes=14,
            stored_size_bytes=14,
            sha256=digest,
            created_at=NOW,
            ready_at=NOW,
        )
    )
    session.add(
        AgentTaskJudgmentDB(
            task_run_id="r-ex",
            project="p-ex",
            pass_result=False,
            checks_json=[{"check": "replayed"}],
            task_definition_revision_id=revision.id,
            created_at=NOW,
        )
    )
    session.add(
        AgentTaskTestResultCorrectionDB(
            task_run_id="r-ex",
            project="p-ex",
            test_id="report-is-complete",
            action="set_pass",
        )
    )
    session.add(
        TaskExecutionAttemptDB(
            project="p-ex",
            batch_run_id="b-ex",
            task_run_id="r-ex",
            sequence_index=0,
            target_kind="pool",
            queue_expires_at=NOW + timedelta(hours=1),
            status="completed",
            stdout_tail="agent stdout",
        )
    )
    session.add(RunDB(id="trace-ex", project="p-ex", task_run_id="r-ex", created_at=NOW))
    session.add(
        LoggedCallDB(
            id="trace-ex-tool",
            run_id="trace-ex",
            project="p-ex",
            task_id="",
            created_at=NOW,
            model="unknown",
            observation_type="TOOL",
            latency_ms=5.0,
            input={},
            output={},
            messages=[],
        )
    )
    session.add(
        OtlpSpanDB(
            project_id="p-ex",
            trace_id="trace-ex",
            span_id="trace-ex-tool",
            created_at=NOW,
        )
    )
    session.commit()


class TestRunExport:
    def test_bundle_contains_everything(
        self, client: TestClient, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from tests.test_run_deletion import _RecordingStore

        _seed_export_run(session)

        class _ReadableStore(_RecordingStore):
            async def open(self, key: str):
                if key == "ex/report":
                    yield b"artifact-bytes"

        store = _ReadableStore()

        def _get_store(backend: str, **_: object) -> _ReadableStore:
            return store

        monkeypatch.setattr("apo.services.run_export.get_store", _get_store)

        resp = client.get("/v1/agent-task-runs/r-ex/export")

        assert resp.status_code == 200, resp.text
        bundle = resp.json()
        assert bundle["bundle_version"] == 2  # v2: spans carry typed columns only (raw_span dropped)
        assert bundle["run_id"] == "r-ex"
        # Verdict section: the detail projection, verdict intact.
        assert bundle["run"]["status"] == "failed"
        assert bundle["run"]["checks_json"] is not None
        assert bundle["run"]["transcript_json"] is not None
        # Evidence sections.
        assert len(bundle["corrections"]) == 1
        assert len(bundle["judgments"]) == 1
        assert bundle["judgments"][0]["checks_json"] == [{"check": "replayed"}]
        assert bundle["attempt"]["stdout_tail"] == "agent stdout"
        assert bundle["task_definition_source"]["content_sha256"] == "a" * 64
        # Deliverables: manifest + inline value + artifact bytes round-trip.
        assert len(bundle["deliverables"]["manifest"]) == 2
        assert bundle["deliverables"]["values"]["summary"] == {"ok": True}
        artifact = bundle["deliverables"]["artifacts"]["report.md"]
        assert base64.b64decode(artifact["content_base64"]) == b"artifact-bytes"
        assert artifact["sha256"] == hashlib.sha256(b"artifact-bytes").hexdigest()
        # Trace: calls always, spans only on request.
        assert len(bundle["trace"]["calls"]) == 1
        assert bundle["trace"]["spans"] == []

    def test_spans_opt_in(
        self, client: TestClient, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _seed_export_run(session)

        class _ArtifactStore:
            name: str = "local"

            async def open(self, key: str):
                yield b"artifact-bytes"

            async def delete(self, key: str) -> None:
                pass

        def _get_store(backend: str, **_: object) -> _ArtifactStore:
            return _ArtifactStore()

        monkeypatch.setattr("apo.services.run_export.get_store", _get_store)

        resp = client.get("/v1/agent-task-runs/r-ex/export?include=spans")

        assert resp.status_code == 200
        assert len(resp.json()["trace"]["spans"]) == 1

    def test_export_fails_past_byte_budget(
        self, client: TestClient, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A tiny budget must trip on the opening sections, before any
        # artifact or trace read, and answer with operator guidance.
        _seed_export_run(session)
        monkeypatch.setenv("APO_RUN_EXPORT_MAX_BYTES", "64")
        resp = client.get("/v1/agent-task-runs/r-ex/export")
        assert resp.status_code == 413
        assert "APO_RUN_EXPORT_MAX_BYTES" in resp.json()["detail"]

    def test_unknown_run_is_404(self, client: TestClient) -> None:
        assert client.get("/v1/agent-task-runs/nope/export").status_code == 404

    def test_stranger_gets_opaque_404(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        from tests.conftest import seed_project_for_user

        _seed_export_run(session)
        stranger = _make_user(session, "stranger@t.dev")
        seed_project_for_user(session, stranger.id, project_id="other-project")
        authed = make_authed_client(stranger.id, session)

        resp = authed.get("/v1/agent-task-runs/r-ex/export")

        assert resp.status_code == 404

    def test_expired_run_still_exports_verdict(self, client: TestClient, session: Session) -> None:
        _seed_export_run(session)
        # Expire the evidence tier, then export.
        from apo.services.retention import expire_run_evidence

        asyncio.run(expire_run_evidence(session, NOW, windows={"p-ex": 1}))
        session.commit()

        resp = client.get("/v1/agent-task-runs/r-ex/export")

        assert resp.status_code == 200
        bundle = resp.json()
        assert bundle["run"]["status"] == "failed"
        assert bundle["trace"] is None
        assert bundle["deliverables"]["manifest"] == []


class TestRevisionGC:
    def test_only_unreferenced_old_revisions_go(self, session: Session) -> None:
        owner = _make_user(session, "gc@t.dev")
        session.add(ProjectDB(id="p-gc", name="p-gc", created_by=owner.id))
        session.commit()
        session.add(
            AgentTaskBatchRunDB(
                id="b-gc",
                project="p-gc",
                selection_type="task",
                task_root="/tmp",
                environment="default",
                status="completed",
                created_at=NOW - timedelta(days=40),
            )
        )
        session.commit()

        def _rev(rid: str, age_days: int) -> TaskDefinitionRevisionDB:
            return TaskDefinitionRevisionDB(
                id=rid,
                project="p-gc",
                task_id="t",
                schema_version=1,
                content_sha256=rid * 64,
                source_files_json=[],
                source_size_bytes=1,
                created_at=NOW - timedelta(days=age_days),
            )

        rev_run, rev_judgment, rev_inventory, rev_dead, rev_fresh = (
            _rev("revrun", 60),
            _rev("revjudg", 60),
            _rev("revinv", 60),
            _rev("revdead", 60),
            _rev("revfresh", 5),
        )
        session.add(rev_run)
        session.add(rev_judgment)
        session.add(rev_inventory)
        session.add(rev_dead)
        session.add(rev_fresh)
        session.commit()
        session.add(
            AgentTaskRunDB(
                id="r-gc",
                batch_run_id="b-gc",
                task_id="t",
                task_path="/tmp/t",
                status="passed",
                task_definition_revision_id=rev_run.id,
            )
        )
        session.commit()
        session.add(
            AgentTaskJudgmentDB(
                task_run_id="r-gc",
                project="p-gc",
                pass_result=True,
                task_definition_revision_id=rev_judgment.id,
                created_at=NOW,
            )
        )
        from apo.models.db import ProjectTaskInventoryDB, ProjectTaskSourceDB

        source = ProjectTaskSourceDB(
            project="p-gc", source_type="published", status="ready"
        )
        session.add(source)
        session.commit()
        session.add(
            ProjectTaskInventoryDB(
                project="p-gc",
                task_source_id=source.id,
                task_id="t",
                display_name="t",
                folder_path="/t",
                task_path="/t/t",
                source_type="published",
                task_definition_revision_id=rev_inventory.id,
            )
        )
        session.commit()

        deleted = reap_unreferenced_task_definition_revisions(
            session, NOW - timedelta(days=30)
        )

        assert deleted == 1
        assert session.get(TaskDefinitionRevisionDB, "revdead") is None
        for kept in ("revrun", "revjudg", "revinv", "revfresh"):
            assert session.get(TaskDefinitionRevisionDB, kept) is not None


class TestDiskFullHandler:
    def test_sqlite_full_maps_to_actionable_503(self, client: TestClient) -> None:
        from apo.api import app
        from sqlalchemy.exc import OperationalError

        def _raise() -> None:
            raise OperationalError(
                "INSERT", {}, Exception("database or disk is full")
            )

        app.router.get("/_test-dbfull")(_raise)  # type: ignore[operator]
        try:
            resp = client.get("/_test-dbfull")
        finally:
            app.router.routes = [
                r for r in app.router.routes if getattr(r, "path", "") != "/_test-dbfull"
            ]

        assert resp.status_code == 503
        assert "APO_MAX_DB_PAGES" in resp.json()["detail"]
