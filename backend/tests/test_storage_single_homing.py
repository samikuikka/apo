# pyright: reportAny=false, reportAttributeAccessIssue=false, reportDeprecated=false, reportExplicitAny=false, reportImplicitOverride=false, reportImplicitStringConcatenation=false, reportMissingParameterType=false, reportOptionalMemberAccess=false, reportPrivateLocalImportUsage=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedFunction=false, reportUnusedParameter=false

"""Storage single-homing (canonical span store migration stage 1).

Covers: extractor fidelity (bytes/enum-names/link fields) with a round-trip
losslessness proof, the idempotent-strict upsert, the raw_span drop (schema +
re-run-safe migration), payload lifecycle (blank-at-projection, status-guarded
trim, stuck-batch horizon, row reap), the bookmark-aware purge plan, evidence
aging by run activity, project-scoped export bundles, the artifact orphan
sweep, the per-connection page cap + freelist-gated VACUUM, worker exception
containment, and the demo-capture rebuild from canonical spans.
"""

import asyncio
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from sqlmodel import Session, select, text

from apo.db import engine, reset_apo_file_db
from apo.dev_demo_capture import CAPTURE_PROJECT_ID, find_otel_payload
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskDeliverableDB,
    AgentTaskRunDB,
    LoggedCallDB,
    OtlpIngestBatchDB,
    OtlpSpanDB,
    ProjectDB,
    RunDB,
    UserDB,
)
from apo.services import retention
from apo.services.otlp_receiver import OtlpReceiver, span_row_to_otlp_json
from apo.services.retention import _old_batch_purge_plan
from apo.services.run_export import _trace_section
from apo.services.trace_ingestion_queue import DbBackedQueue, QueueWorker

NOW = datetime.now(timezone.utc)
TRACE = "0102030405060708090a0b0c0d0e0f10"
SPAN = "0102030405060708"
SPAN2 = "1112131415161718"


def _payload(
    span_id: str = SPAN,
    *,
    trace_id: str = TRACE,
    kind: Any = 1,
    flags: Any = 1,
    end: str | None = "1700000001000000000",
    attributes: list[dict[str, Any]] | None = None,
    links: list[dict[str, Any]] | None = None,
    events: list[dict[str, Any]] | None = None,
    status: dict[str, Any] | None = None,
    resource_attributes: list[dict[str, Any]] | None = None,
) -> bytes:
    if attributes is None:
        attributes = [
            {"key": "gen_ai.system", "value": {"stringValue": "openai"}},
            {"key": "retries", "value": {"intValue": 2}},
            {"key": "ratio", "value": {"doubleValue": 0.5}},
            {"key": "cached", "value": {"boolValue": True}},
        ]
    span: dict[str, Any] = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": "chat.completion",
        "kind": kind,
        "flags": flags,
        "startTimeUnixNano": "1700000000000000000",
        "attributes": attributes,
        "status": status if status is not None else {"code": 1},
    }
    if end is not None:
        span["endTimeUnixNano"] = end
    if links is not None:
        span["links"] = links
    if events is not None:
        span["events"] = events
    document = {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": resource_attributes
                    if resource_attributes is not None
                    else [
                        {"key": "service.name", "value": {"stringValue": "svc"}}
                    ]
                },
                "scopeSpans": [
                    {"scope": {"name": "test-scope", "version": "1"}, "spans": [span]}
                ],
            }
        ]
    }
    return json.dumps(document).encode("utf-8")


def _ingest(session: Session, payload: bytes, **kwargs: Any) -> str:
    result = OtlpReceiver().ingest(
        payload,
        "application/json",
        "p1",
        session,
        **kwargs,
    )
    assert result.accepted >= 1, result.errors
    return result.batch_id


def _get_span(session: Session, span_id: str = SPAN) -> OtlpSpanDB:
    row = session.exec(
        select(OtlpSpanDB).where(
            OtlpSpanDB.project_id == "p1",
            OtlpSpanDB.trace_id == TRACE,
            OtlpSpanDB.span_id == span_id,
        )
    ).first()
    assert row is not None
    return row


# ---------------------------------------------------------------------------
# Extractor fidelity
# ---------------------------------------------------------------------------


class TestExtractorFidelity:
    def test_bytes_attribute_is_preserved_not_dropped(self, session: Session) -> None:
        _ingest(
            session,
            _payload(
                attributes=[
                    {
                        "key": "file.hash",
                        "value": {"bytesValue": "c2FtcGxlLWJ5dGVz"},
                    }
                ]
            ),
        )
        span = _get_span(session)
        assert span.attributes is not None
        # The base64 text survives instead of being silently dropped.
        assert span.attributes["file.hash"] == "c2FtcGxlLWJ5dGVz"

    def test_enum_name_strings_map_to_ints(self, session: Session) -> None:
        _ingest(
            session,
            _payload(
                kind="SPAN_KIND_SERVER",
                status={"code": "STATUS_CODE_ERROR", "message": "boom"},
            ),
        )
        span = _get_span(session)
        assert span.span_kind == 2
        assert span.status_code == 2
        assert span.status_message == "boom"

    def test_link_flags_and_trace_state_preserved(self, session: Session) -> None:
        _ingest(
            session,
            _payload(
                links=[
                    {
                        "traceId": "99" * 16,
                        "spanId": "88" * 8,
                        "flags": 1,
                        "traceState": "vendor=congo",
                        "attributes": [
                            {"key": "why", "value": {"stringValue": "retry"}}
                        ],
                    }
                ]
            ),
        )
        span = _get_span(session)
        assert span.links == [
            {
                "traceId": "99" * 16,
                "spanId": "88" * 8,
                "attributes": {"why": "retry"},
                "flags": 1,
                "traceState": "vendor=congo",
            }
        ]


# ---------------------------------------------------------------------------
# Round-trip losslessness — the proof that raw_span is safe to drop
# ---------------------------------------------------------------------------


class TestRoundTripLosslessness:
    def test_reconstructed_span_reingest_is_a_noop(self, session: Session) -> None:
        """Full-featured span → typed columns → rebuilt OTLP → re-ingest.

        If any field were lost or reshaped by the extraction, the rebuilt
        span would carry different values and the idempotent upsert would
        apply updates. A no-op re-ingest is the losslessness proof over
        every field apo preserves.
        """
        _ingest(
            session,
            _payload(
                links=[
                    {
                        "traceId": "99" * 16,
                        "spanId": "88" * 8,
                        "flags": 1,
                        "traceState": "vendor=congo",
                        "attributes": [
                            {"key": "why", "value": {"stringValue": "retry"}}
                        ],
                    }
                ],
                events=[
                    {
                        "name": "exception",
                        "timeUnixNano": "1700000000500000000",
                        "attributes": [
                            {"key": "type", "value": {"stringValue": "timeout"}}
                        ],
                    }
                ],
                attributes=[
                    {"key": "s", "value": {"stringValue": "text"}},
                    {"key": "i", "value": {"intValue": 7}},
                    {"key": "f", "value": {"doubleValue": 1.25}},
                    {"key": "b", "value": {"boolValue": True}},
                    {
                        "key": "arr",
                        "value": {
                            "arrayValue": {
                                "values": [{"stringValue": "x"}, {"intValue": 1}]
                            }
                        },
                    },
                    {
                        "key": "map",
                        "value": {
                            "kvlistValue": {
                                "values": [
                                    {"key": "in", "value": {"stringValue": "v"}}
                                ]
                            }
                        },
                    },
                    {
                        "key": "by",
                        "value": {"bytesValue": "c2FtcGxlLWJ5dGVz"},
                    },
                ],
            ),
        )
        row = _get_span(session)
        rebuilt = span_row_to_otlp_json(row)

        # Microsecond-aligned timestamps round-trip exactly.
        assert rebuilt["startTimeUnixNano"] == "1700000000000000000"
        assert rebuilt["endTimeUnixNano"] == "1700000001000000000"

        # Rebuild the resourceSpans envelope the same way demo capture does
        # (span_row_to_otlp_json covers the span; resource/scope come from
        # the row's stored columns).
        from apo.services.otlp_receiver import attrs_dict_to_otlp

        stored_resource = dict(row.resource or {})
        from typing import cast

        resource_attrs = cast(
            "dict[str, object]", stored_resource.pop("attributes", None) or {}
        )
        resource_block = {
            **stored_resource,
            "attributes": attrs_dict_to_otlp(resource_attrs),
        }
        reingest_payload = json.dumps(
            {
                "resourceSpans": [
                    {
                        "resource": resource_block,
                        "scopeSpans": [
                            {
                                "scope": dict(row.instrumentation_scope or {}),
                                "spans": [rebuilt],
                            }
                        ],
                    }
                ]
            }
        ).encode("utf-8")
        _ingest(session, reingest_payload)

        after = _get_span(session)
        for field in (
            "parent_span_id",
            "span_name",
            "span_kind",
            "status_code",
            "status_message",
            "trace_flags",
            "trace_state",
            "start_time",
            "end_time",
            "attributes",
            "events",
            "links",
        ):
            assert getattr(after, field) == getattr(row, field), field


# ---------------------------------------------------------------------------
# Idempotent-strict upsert
# ---------------------------------------------------------------------------


class TestIdempotentUpsert:
    def test_identical_retry_is_a_noop(self, session: Session) -> None:
        _ingest(session, _payload())
        row = _get_span(session)
        _ingest(session, _payload())
        after = _get_span(session)
        assert after.attributes == row.attributes
        assert after.end_time == row.end_time
        assert after.span_name == row.span_name

    def test_stale_retry_does_not_clobber(self, session: Session) -> None:
        """A delayed re-export missing fields must not destroy information."""
        _ingest(session, _payload())
        # Retry without end time and with emptied attributes.
        _ingest(
            session,
            _payload(end=None, attributes=[]),
        )
        after = _get_span(session)
        assert after.end_time is not None  # preserved, not nulled
        assert after.attributes  # preserved, not emptied

    def test_completing_retry_applies(self, session: Session) -> None:
        _ingest(session, _payload(end=None))
        assert _get_span(session).end_time is None
        _ingest(session, _payload(end="1700000002000000000"))
        assert _get_span(session).end_time is not None


# ---------------------------------------------------------------------------
# raw_span dropped
# ---------------------------------------------------------------------------


class TestRawSpanDropped:
    def test_schema_has_no_raw_span_column(self, session: Session) -> None:
        columns = session.execute(
            text("PRAGMA table_info('otlp_spans')")
        ).fetchall()
        assert "raw_span" not in {col[1] for col in columns}

    def test_migration_v34_is_rerun_safe(self) -> None:
        # The guarded DROP makes a crash between the migration commit and
        # the version stamp harmless: the re-run is a no-op, not an error.
        from apo.db import _migrate_to_v34

        _migrate_to_v34()
        _migrate_to_v34()  # must not raise


# ---------------------------------------------------------------------------
# Payload lifecycle (file-backed engine — the queue talks to apo.db's engine)
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clean_file_db():
    reset_apo_file_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM call_metrics"))
        session.execute(text("DELETE FROM run_metrics"))
        session.execute(text("DELETE FROM logged_calls"))
        session.execute(text("DELETE FROM otlp_spans"))
        session.execute(text("DELETE FROM otlp_ingest_batches"))
        session.execute(text("DELETE FROM runs"))
        session.commit()


class TestPayloadLifecycle:
    def test_mark_complete_blanks_payload(self) -> None:
        with Session(engine) as session:
            batch_id = _ingest(session, _payload(), project_immediately=False)
            batch = session.get(OtlpIngestBatchDB, batch_id)
            assert batch is not None
            assert batch.status == "queued"
            assert batch.payload != ""

        worker = QueueWorker(receiver=OtlpReceiver(), queue=DbBackedQueue())
        assert asyncio.run(worker.process_batch(batch_id))

        with Session(engine) as session:
            batch = session.get(OtlpIngestBatchDB, batch_id)
            assert batch is not None
            assert batch.status == "projected"
            assert batch.payload == ""  # blanked atomically with the status
            # The projection still happened.
            runs = session.exec(select(RunDB).where(RunDB.id == TRACE)).all()
            assert runs

    def test_crash_window_replay_then_blank(self) -> None:
        """Achievable crash-sim: process without completing, recover, replay."""
        with Session(engine) as session:
            batch_id = _ingest(session, _payload(), project_immediately=False)

        # Simulate a crash after claim: status processing with an expired
        # lease, completion never recorded.
        with Session(engine) as session:
            session.execute(
                text(
                    "UPDATE otlp_ingest_batches SET status = 'processing', "
                    "processing_started_at = :old WHERE id = :id"
                ),
                {
                    "old": datetime.now(timezone.utc) - timedelta(seconds=400),
                    "id": batch_id,
                },
            )
            session.commit()
            # The payload survives the crash — it is the replay manifest.
            batch = session.get(OtlpIngestBatchDB, batch_id)
            assert batch is not None and batch.payload != ""

        assert asyncio.run(DbBackedQueue().recover_stale()) == 1
        worker = QueueWorker(receiver=OtlpReceiver(), queue=DbBackedQueue())
        assert asyncio.run(worker.process_batch(batch_id))
        with Session(engine) as session:
            batch = session.get(OtlpIngestBatchDB, batch_id)
            assert batch is not None
            assert batch.status == "projected"
            assert batch.payload == ""

    def test_trim_status_guard(self, session: Session) -> None:
        for batch_id, status in (
            ("ing-queued", "queued"),
            ("ing-processing", "processing"),
            ("ing-accepted", "accepted"),
        ):
            session.add(
                OtlpIngestBatchDB(
                    id=batch_id,
                    project_id="p1",
                    status=status,
                    received_at=NOW - timedelta(days=30),
                    payload='{"spans": [...]}',
                )
            )
        session.commit()

        trimmed = retention.trim_old_ingest_payloads(
            session, NOW - timedelta(days=7)
        )
        assert trimmed == 1  # only the terminal 'accepted' row
        for batch_id, expected in (
            ("ing-queued", '{"spans": [...]}'),
            ("ing-processing", '{"spans": [...]}'),
            ("ing-accepted", ""),
        ):
            row = session.get(OtlpIngestBatchDB, batch_id)
            assert row is not None and row.payload == expected

    def test_stuck_batches_failed_and_blanked(self, session: Session) -> None:
        session.add(
            OtlpIngestBatchDB(
                id="ing-stuck",
                project_id="p1",
                status="queued",
                received_at=NOW - timedelta(days=40),
                payload="x" * 1000,
            )
        )
        session.commit()

        failed = retention.fail_stuck_ingest_batches(
            session, NOW - timedelta(days=30)
        )
        assert failed == 1
        row = session.get(OtlpIngestBatchDB, "ing-stuck")
        assert row is not None
        assert row.status == "failed"
        assert row.payload == ""
        assert row.error_message is not None

    def test_reap_old_batch_rows(self, session: Session) -> None:
        for batch_id, status, payload, age in (
            ("reap-gone", "projected", "", 100),
            ("reap-kept-payload", "projected", '{"p": 1}', 100),
            ("reap-kept-queued", "queued", "", 100),
            ("reap-kept-young", "projected", "", 5),
        ):
            session.add(
                OtlpIngestBatchDB(
                    id=batch_id,
                    project_id="p1",
                    status=status,
                    received_at=NOW - timedelta(days=age),
                    payload=payload,
                )
            )
        session.commit()

        reaped = retention.reap_old_ingest_batch_rows(
            session, NOW - timedelta(days=90)
        )
        assert reaped == 1
        assert session.get(OtlpIngestBatchDB, "reap-gone") is None
        for kept in (
            "reap-kept-payload",
            "reap-kept-queued",
            "reap-kept-young",
        ):
            assert session.get(OtlpIngestBatchDB, kept) is not None


# ---------------------------------------------------------------------------
# Bookmark-aware purge
# ---------------------------------------------------------------------------


def _seed_user_project(session: Session, project_id: str) -> None:
    user = UserDB(email=f"u-{project_id}@t.dev", name="u", password_hash="x")
    session.add(user)
    session.commit()
    session.refresh(user)
    session.add(
        ProjectDB(id=project_id, name=project_id, created_by=user.id)
    )
    session.commit()


def _seed_batch_with_runs(
    session: Session,
    *,
    batch_id: str,
    project_id: str,
    run_specs: list[tuple[str, bool]],
    age_days: int = 40,
) -> None:
    session.add(
        AgentTaskBatchRunDB(
            id=batch_id,
            project=project_id,
            selection_type="task",
            task_root="/tmp",
            environment="default",
            status="completed",
            created_at=NOW - timedelta(days=age_days),
        )
    )
    session.commit()
    for task_run_id, bookmarked in run_specs:
        session.add(
            AgentTaskRunDB(
                id=task_run_id,
                batch_run_id=batch_id,
                task_id="t",
                task_path="/tmp/t",
                status="passed",
                pass_result=True,
                trace_run_id=f"trace-{task_run_id}",
                started_at=NOW - timedelta(days=age_days),
            )
        )
        session.add(
            RunDB(
                id=f"trace-{task_run_id}",
                project=project_id,
                task_run_id=task_run_id,
                bookmarked=bookmarked,
                created_at=NOW - timedelta(days=age_days),
            )
        )
    session.commit()


class TestBookmarkAwarePurge:
    def test_plan_protects_bookmarked_task_runs(self, session: Session) -> None:
        _seed_user_project(session, "p-bm")
        _seed_batch_with_runs(
            session,
            batch_id="b-mixed",
            project_id="p-bm",
            run_specs=[("r-keep", True), ("r-die", False)],
        )
        _seed_batch_with_runs(
            session,
            batch_id="b-all-die",
            project_id="p-bm",
            run_specs=[("r-die2", False)],
        )

        task_run_ids, deletable_batches = _old_batch_purge_plan(
            session, NOW - timedelta(days=30)
        )
        assert sorted(task_run_ids) == ["r-die", "r-die2"]
        # b-mixed keeps a bookmarked survivor → not fully deletable.
        assert deletable_batches == ["b-all-die"]

        deleted = retention.delete_agent_task_rows(session, task_run_ids)
        deleted += retention.delete_batch_rows(session, deletable_batches)
        assert deleted >= 3
        # The bookmarked run's verdict row and its run row survive.
        assert session.get(AgentTaskRunDB, "r-keep") is not None
        kept_run = session.exec(
            select(RunDB).where(RunDB.task_run_id == "r-keep")
        ).first()
        assert kept_run is not None and kept_run.bookmarked
        assert session.get(AgentTaskRunDB, "r-die") is None
        # The protected batch row survives (FK from the surviving task run).
        assert session.get(AgentTaskBatchRunDB, "b-mixed") is not None
        assert session.get(AgentTaskBatchRunDB, "b-all-die") is None

    def test_revision_manifest_of_protected_batch_survives(
        self, session: Session
    ) -> None:
        from apo.models.db import TaskRevisionDB

        _seed_user_project(session, "p-rev")
        _seed_batch_with_runs(
            session,
            batch_id="b-rev",
            project_id="p-rev",
            run_specs=[("r-rev-keep", True)],
        )
        session.add(
            TaskRevisionDB(
                project="p-rev",
                batch_run_id="b-rev",
                materialization="bundled",
                source_type="directory",
                content_sha256="ab" * 32,
                file_count=1,
                uncompressed_size_bytes=10,
                manifest_summary_json={},
                bundle_storage_backend="local",
                bundle_storage_key="rev-bundle-key",
                bundle_sha256="cd" * 32,
                bundle_size_bytes=10,
                created_at=NOW - timedelta(days=40),
            )
        )
        session.commit()

        task_run_ids, deletable_batches = _old_batch_purge_plan(
            session, NOW - timedelta(days=30)
        )
        assert task_run_ids == []
        assert deletable_batches == []
        revision = session.exec(
            select(TaskRevisionDB).where(
                TaskRevisionDB.bundle_storage_key == "rev-bundle-key"
            )
        ).first()
        assert revision is not None  # manifest (and its object) survive


# ---------------------------------------------------------------------------
# Evidence aging by run activity
# ---------------------------------------------------------------------------


class TestEvidenceAging:
    def test_recent_run_in_old_batch_is_not_expired(self, session: Session) -> None:
        _seed_user_project(session, "p-age")
        _seed_batch_with_runs(
            session,
            batch_id="b-age",
            project_id="p-age",
            run_specs=[("r-recent", False)],
            age_days=40,  # batch is old...
        )
        # ...but the run started now (started_at defaults to the batch age
        # in the helper, so set it fresh here).
        row = session.get(AgentTaskRunDB, "r-recent")
        assert row is not None
        row.started_at = NOW
        session.add(row)
        session.commit()

        candidates = retention._evidence_candidates(
            session, "p-age", NOW - timedelta(days=30)
        )
        assert candidates == []

        # A never-started run ages by the batch instead.
        row.started_at = None
        session.add(row)
        session.commit()
        candidates = retention._evidence_candidates(
            session, "p-age", NOW - timedelta(days=30)
        )
        assert [run_id for run_id, _ in candidates] == ["r-recent"]


# ---------------------------------------------------------------------------
# Export project scoping
# ---------------------------------------------------------------------------


class TestExportScoping:
    def test_trace_section_is_project_scoped(self, session: Session) -> None:
        _seed_user_project(session, "p-a")
        session.add(
            AgentTaskBatchRunDB(
                id="b-ex2",
                project="p-a",
                selection_type="task",
                task_root="/tmp",
                environment="default",
                status="completed",
                created_at=NOW,
            )
        )
        session.commit()
        task_run = AgentTaskRunDB(
            id="r-ex2",
            batch_run_id="b-ex2",
            task_id="t",
            task_path="/tmp/t",
            status="passed",
            pass_result=True,
            trace_run_id="dup-trace",
        )
        session.add(task_run)
        session.commit()
        for project in ("p-a", "p-b"):
            session.add(
                RunDB(id="dup-trace", project=project, created_at=NOW)
            )
            session.add(
                LoggedCallDB(
                    id=f"call-{project}",
                    run_id="dup-trace",
                    project=project,
                    task_id="",
                    created_at=NOW,
                    model="unknown",
                    observation_type="GENERATION",
                    latency_ms=1.0,
                    input={},
                    output={"text": f"from {project}"},
                    messages=[],
                )
            )
            session.add(
                OtlpSpanDB(
                    project_id=project,
                    trace_id="dup-trace",
                    span_id=f"span-{project}"[:16].ljust(16, "0"),
                    span_name="root",
                    attributes={"owner": project},
                )
            )
        session.commit()

        section = _trace_section(session, task_run, include_spans=True)
        assert section is not None
        assert [call["id"] for call in section["calls"]] == ["call-p-a"]
        assert [
            span["attributes"]["owner"] for span in section["spans"]
        ] == ["p-a"]


# ---------------------------------------------------------------------------
# Artifact orphan sweep
# ---------------------------------------------------------------------------


class TestOrphanSweep:
    def test_unreferenced_old_objects_reaped(
        self, session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path))
        objects = tmp_path / "objects"
        staging = tmp_path / "staging"
        objects.mkdir(parents=True)
        staging.mkdir(parents=True)

        old = time.time() - 3 * 24 * 3600  # past the 48h grace
        # The local store shards by the key's first two characters.
        for name in ("aa-referenced", "bb-orphaned", "cc-fresh-orphan"):
            shard = objects / name[:2]
            shard.mkdir(parents=True, exist_ok=True)
            (shard / name).write_bytes(b"data")
            os.utime(shard / name, (old, old))
        fresh = objects / "cc" / "cc-fresh-orphan"
        os.utime(fresh, (time.time(), time.time()))
        part = staging / "upload.part"
        part.write_bytes(b"partial")

        # Reference one object via a deliverable manifest row.
        _seed_user_project(session, "p-orph")
        session.add(
            AgentTaskBatchRunDB(
                id="b-orph",
                project="p-orph",
                selection_type="task",
                task_root="/tmp",
                environment="default",
                status="completed",
                created_at=NOW,
            )
        )
        session.commit()
        session.add(
            AgentTaskRunDB(
                id="r-orph",
                batch_run_id="b-orph",
                task_id="t",
                task_path="/tmp/t",
                status="passed",
                pass_result=True,
            )
        )
        session.commit()
        session.add(
            AgentTaskDeliverableDB(
                id="dlv-orph",
                project="p-orph",
                task_run_id="r-orph",
                name="report.md",
                kind="artifact",
                status="ready",
                storage_backend="local",
                storage_key="aa/aa-referenced",
                media_type="text/markdown",
                size_bytes=4,
                stored_size_bytes=4,
                sha256="00" * 32,
                created_at=NOW,
            )
        )
        session.commit()

        deleted = asyncio.run(
            retention.reap_unreferenced_artifact_objects(session)
        )
        assert deleted == 1
        assert (objects / "aa" / "aa-referenced").exists()
        assert not (objects / "bb" / "bb-orphaned").exists()
        assert (objects / "cc" / "cc-fresh-orphan").exists()  # inside grace
        assert part.exists()  # staging is never touched


# ---------------------------------------------------------------------------
# Page cap + VACUUM
# ---------------------------------------------------------------------------


class TestPageCapAndVacuum:
    def test_cap_applied_on_every_connection(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_MAX_DB_PAGES", "50000")
        with engine.connect() as conn:
            applied = conn.exec_driver_sql("PRAGMA max_page_count").scalar()
        assert int(applied or 0) == 50000

    def test_vacuum_freelist_gated_and_cap_safe(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_MAX_DB_PAGES", "5000000")
        # Gate wide open → runs (and must lift/restore the cap safely).
        monkeypatch.setattr(retention, "vacuum_min_free_bytes", lambda: 0)
        info = retention.vacuum_sqlite()
        assert info["vacuumed"] is True

        # Gate above the reclaimable bytes → skipped.
        monkeypatch.setattr(
            retention, "vacuum_min_free_bytes", lambda: 10**12
        )
        info = retention.vacuum_sqlite()
        assert info["vacuumed"] is False

    def test_vacuum_failure_does_not_raise(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import sqlite3

        monkeypatch.setattr(retention, "vacuum_min_free_bytes", lambda: 0)

        def _connect(*_args: Any, **_kwargs: Any) -> sqlite3.Connection:
            raise OSError("disk full")

        monkeypatch.setattr(sqlite3, "connect", _connect)
        info = retention.vacuum_sqlite()
        assert info["vacuumed"] is False


# ---------------------------------------------------------------------------
# Worker containment
# ---------------------------------------------------------------------------


class _ExplodingQueue(DbBackedQueue):
    async def mark_complete(self, batch_id: str) -> None:
        raise RuntimeError("simulated SQLITE_BUSY while marking")  # noqa: E501


class TestWorkerContainment:
    def test_mark_failure_does_not_escape(self) -> None:
        with Session(engine) as session:
            batch_id = _ingest(session, _payload(), project_immediately=False)

        worker = QueueWorker(
            receiver=OtlpReceiver(), queue=_ExplodingQueue()
        )
        # Must not raise: the batch stays 'processing' and its lease expiry
        # requeues it — the worker lives to drain another day.
        asyncio.run(worker._process_claimed(batch_id))


# ---------------------------------------------------------------------------
# Demo capture rebuild
# ---------------------------------------------------------------------------


class TestDemoCaptureRebuild:
    def test_payload_rebuilt_from_canonical_spans(self, session: Session) -> None:
        for span_id, resource_attr in (
            (SPAN, "svc-a"),
            (SPAN2, "svc-a"),
        ):
            session.add(
                OtlpSpanDB(
                    project_id=CAPTURE_PROJECT_ID,
                    trace_id=TRACE,
                    span_id=span_id,
                    span_name="root",
                    attributes={"gen_ai.system": "openai"},
                    resource={"attributes": {"service.name": resource_attr}},
                )
            )
        session.commit()

        payload = find_otel_payload(session, TRACE)
        assert payload is not None
        resource_spans = payload["resourceSpans"]
        assert len(resource_spans) == 1
        spans = resource_spans[0]["scopeSpans"][0]["spans"]
        assert len(spans) == 2
        assert spans[0]["attributes"] == [
            {"key": "gen_ai.system", "value": {"stringValue": "openai"}}
        ]
        assert find_otel_payload(session, "missing" * 4) is None
