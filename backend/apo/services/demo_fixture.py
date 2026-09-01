"""Demo workspace fixture loader.

The shipped ``apo/data/demo-workspace-v1.json`` is the sole source of truth
for the demo project's data: catalog, batches, runs, check reports,
deliverables, judgments, corrections, schedules, views, and the raw OTLP
payloads behind every trace. The loader reconciles the database to the file
on every boot — digest-gated, so an unchanged fixture writes nothing — and
replays traces through the real ingestion pipeline so demo traces are
byte-identical to real ones (canonical spans, projection, task-run claim).

Follows the ``default-model-prices.json`` house pattern (services/pricing/
loader.py): fail hard on a malformed file, own the session, full
replace scoped to the demo project.
"""

# pyright: reportAny=false, reportUnusedCallResult=false

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import delete
from sqlmodel import Session, col, select

from ..models.db import (
    AdaptiveTaskStateDB,
    AgentTaskBatchRunDB,
    AgentTaskTestResultCorrectionDB,
    AgentTaskDeliverableDB,
    AgentTaskJudgmentDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    AgentTaskScheduleOccurrenceDB,
    LoggedCallDB,
    OtlpIngestBatchDB,
    OtlpSpanDB,
    ProjectDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    RunDB,
    RunMetricDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
    TaskViewComparisonDB,
    TaskViewDB,
    UserDB,
)
from .project_memberships import DEMO_PROJECT_ID

DEFAULTS_PATH = Path(__file__).resolve().parents[1] / "data" / "demo-workspace-v1.json.gz"

# The inert author behind demo activity rows.
DEMO_USER_ID = "demo-user"

SCHEMA_VERSION = 1


def _read_fixture_bytes(path: Path) -> bytes:
    """Read the fixture, transparently decompressing a gzipped file.

    The shipped fixture is gzip (real captured traces with full message
    logs are ~9 MB plain, ~0.7 MB gzipped); plain JSON is accepted for
    hand-curated working copies.
    """
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b" or path.suffix == ".gz":
        import gzip

        return gzip.decompress(raw)
    return raw


class DemoFixtureError(RuntimeError):
    """The fixture file is malformed. Startup must fail hard, not limp."""


def load_demo_fixture(session: Session, *, path: Path | None = None) -> bool:
    """Reconcile the demo project to the shipped fixture.

    Returns ``True`` when a (re)load happened, ``False`` when the stored
    digest matches the file (no-op boot writes nothing) or the demo is
    disabled entirely (``APO_DEMO_ENABLED=false``).
    """
    from .demo_workspace import is_demo_enabled

    if not is_demo_enabled():
        return False
    fixture_path = path if path is not None else DEFAULTS_PATH
    try:
        payload = _read_fixture_bytes(fixture_path)
    except OSError as exc:
        raise DemoFixtureError(f"demo fixture missing: {fixture_path}") from exc

    digest = hashlib.sha256(payload).hexdigest()
    try:
        document = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise DemoFixtureError(f"demo fixture is not valid JSON: {exc}") from exc
    if not isinstance(document, dict):
        raise DemoFixtureError("demo fixture root must be an object")
    if document.get("schema_version") != SCHEMA_VERSION:
        raise DemoFixtureError(
            f"demo fixture schema_version must be {SCHEMA_VERSION}"
        )

    source = _ensure_task_source(session)
    if source.catalog_digest == digest:
        return False

    _clear_demo_data(session)
    _load_document(session, document)

    source.catalog_digest = digest
    source.task_count = len(document.get("catalog", {}).get("tasks", []))
    source.status = "ready"
    # The fixture IS the demo seed: align the source row's ref with the
    # inventory rows written below (source_ref="fixture-v1") so the derived
    # inventory_stale never trips on rows provisioned by the retired
    # seeding system (source_ref mismatch hides the whole catalog).
    source.demo_seed_id = "fixture-v1"
    source.last_synced_at = datetime.now(timezone.utc)
    session.add(source)
    session.commit()
    return True


# ---------------------------------------------------------------------------
# Loading (FK order per wayfinder asset 07)
# ---------------------------------------------------------------------------


def _ensure_task_source(session: Session) -> ProjectTaskSourceDB:
    source = session.exec(
        select(ProjectTaskSourceDB).where(
            ProjectTaskSourceDB.project == DEMO_PROJECT_ID
        )
    ).first()
    if source is None:
        source = ProjectTaskSourceDB(
            project=DEMO_PROJECT_ID,
            source_type="demo",
            display_name="Demo workspace",
            demo_seed_id="fixture-v1",
            status="pending_sync",
        )
        session.add(source)
        session.flush()
    return source


def _load_document(session: Session, document: dict[str, Any]) -> None:
    demo_user = _load_demo_user(session, document.get("demo_user"))
    _load_catalog(session, document.get("catalog", {}))
    batches = _load_batches(session, document.get("batches", []))
    _load_schedules(session, document.get("schedules", []), batches)
    _load_views(session, document.get("views", {}), demo_user)
    _replay_traces(session, document.get("batches", []), batches)


def _load_demo_user(
    session: Session, spec: dict[str, Any] | None
) -> UserDB | None:
    """The inert author behind demo activity rows (no usable credential)."""
    if not spec:
        return None
    user_id = str(spec["id"])
    user = session.get(UserDB, user_id)
    if user is None:
        user = UserDB(
            id=user_id,
            email=str(spec["email"]),
            name=str(spec.get("name", "")),
            # Never a real credential: unusable hash, disabled account.
            password_hash="!",
            is_active=False,
            is_admin=False,
        )
        session.add(user)
        session.flush()
    return user


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _req_dt(value: str | None) -> datetime:
    """Fixture timestamps on required columns; missing → epoch-stamped now."""
    return _parse_dt(value) or datetime.now(timezone.utc)


def _load_catalog(
    session: Session, catalog: dict[str, Any]
) -> dict[str, str]:
    """Load inventory + content-addressed definitions. Returns task_id → revision id."""
    from .task_definition_revisions import ensure_task_definition_revision

    source = _ensure_task_source(session)
    existing_ids = set(
        session.exec(
            select(ProjectTaskInventoryDB.id).where(
                col(ProjectTaskInventoryDB.project) == DEMO_PROJECT_ID
            )
        ).all()
    )
    revisions: dict[str, str] = {}
    now = datetime.now(timezone.utc)
    for task in catalog.get("tasks", []):
        definition = task.get("definition")
        revision_id: str | None = None
        if definition:
            doc = {
                "schema_version": 1,
                "files": definition["files"],
            }
            revision = ensure_task_definition_revision(
                session,
                project_id=DEMO_PROJECT_ID,
                task_id=str(task["task_id"]),
                document=doc,
            )
            revisions[str(task["task_id"])] = revision.id
            revision_id = revision.id
        row_id = f"demo-inv-{task['task_id']}"
        if row_id in existing_ids:
            continue
        session.add(
            ProjectTaskInventoryDB(
                id=row_id,
                project=DEMO_PROJECT_ID,
                task_source_id=source.id,
                task_id=str(task["task_id"]),
                display_name=str(task.get("display_name", task["task_id"])),
                adapter_name=str(task.get("adapter_name", "real-agent")),
                folder_path=str(task.get("folder_path", "")),
                task_path=str(task.get("task_path", "")),
                has_checks=bool(task.get("has_checks", True)),
                tags_json=task.get("tags", []),
                source_type="demo",
                source_ref="fixture-v1",
                task_definition_revision_id=revision_id,
                discovered_at=now,
            )
        )
    session.flush()
    return revisions


def _load_batches(
    session: Session, batches: list[dict[str, Any]]
) -> dict[str, AgentTaskBatchRunDB]:
    """Load batch runs, their task runs, and run-scoped evidence rows."""
    loaded: dict[str, AgentTaskBatchRunDB] = {}
    for batch_spec in batches:
        batch = AgentTaskBatchRunDB(
            id=str(batch_spec["id"]),
            project=DEMO_PROJECT_ID,
            selection_type=str(batch_spec.get("selection_type", "all")),
            selection_query=batch_spec.get("selection_query"),
            task_root=batch_spec.get("task_root"),
            environment=str(batch_spec.get("environment", "demo")),
            requested_by_user_id=batch_spec.get("requested_by_user_id"),
            run_metadata=batch_spec.get("run_metadata", {}),
            status=str(batch_spec.get("status", "completed")),
            total_tasks=int(batch_spec.get("total_tasks", 0)),
            passed_tasks=int(batch_spec.get("passed_tasks", 0)),
            failed_tasks=int(batch_spec.get("failed_tasks", 0)),
            errored_tasks=int(batch_spec.get("errored_tasks", 0)),
            total_checks=int(batch_spec.get("total_checks", 0)),
            passed_checks=int(batch_spec.get("passed_checks", 0)),
            created_at=_req_dt(batch_spec.get("created_at")),
            started_at=_parse_dt(batch_spec.get("started_at")),
            completed_at=_parse_dt(batch_spec.get("completed_at")),
            trace_persistence_status=str(
                batch_spec.get("trace_persistence_status", "pending")
            ),
            task_source_type="demo",
        )
        session.add(batch)
        session.flush()
        loaded[batch.id] = batch

        for run_spec in batch_spec.get("runs", []):
            run = AgentTaskRunDB(
                id=str(run_spec["id"]),
                batch_run_id=batch.id,
                task_id=str(run_spec["task_id"]),
                task_path=run_spec.get("task_path", ""),
                sequence_index=int(run_spec.get("sequence_index", 0)),
                adapter_name=run_spec.get("adapter_name", "real-agent"),
                status=str(run_spec.get("status", "passed")),
                pass_result=run_spec.get("pass_result"),
                started_at=_parse_dt(run_spec.get("started_at")),
                completed_at=_parse_dt(run_spec.get("completed_at")),
                trace_run_id=run_spec.get("trace_run_id"),
                total_checks=run_spec.get("total_checks"),
                passed_checks=run_spec.get("passed_checks"),
                failed_checks=run_spec.get("failed_checks"),
                transcript_json=run_spec.get("transcript_json"),
                total_cost=run_spec.get("total_cost"),
                total_tokens=run_spec.get("total_tokens"),
                configured_model=run_spec.get("configured_model"),
                configured_effort=run_spec.get("configured_effort"),
            )
            session.add(run)
            # Bare-column FK: the check report row references the run
            # through a column SQLAlchemy cannot topologically sort —
            # flush the run first (dev_workspace precedent).
            session.flush()

            _load_check_report(session, run, run_spec.get("check_report"))
            _load_deliverables(session, run, run_spec.get("deliverables", []))
            _load_judgments(session, run, run_spec.get("judgments", []))

        # Corrections replay AFTER all runs exist: they re-derive verdict
        # scalars through the real service, exactly like a live correction.
        _load_corrections(session, batch_spec.get("runs", []))

        _roll_up_counts(session, batch)
    session.flush()
    return loaded


def _load_check_report(
    session: Session, run: AgentTaskRunDB, checks: list[dict[str, Any]] | None
) -> None:
    if checks is None:
        return
    from .check_report_storage import persist_check_report

    persist_check_report(session, run, checks)


def _load_deliverables(
    session: Session, run: AgentTaskRunDB, deliverables: list[dict[str, Any]]
) -> None:
    for spec in deliverables:
        body = json.dumps(spec.get("value"), sort_keys=True, separators=(",", ":"))
        session.add(
            AgentTaskDeliverableDB(
                id=str(spec["id"]),
                project=DEMO_PROJECT_ID,
                task_run_id=run.id,
                name=str(spec["name"]),
                kind="json",
                status="ready",
                inline_value_json={"value": spec.get("value")},
                media_type="application/json",
                size_bytes=len(body.encode()),
                stored_size_bytes=len(body.encode()),
                sha256=hashlib.sha256(body.encode()).hexdigest(),
                created_at=_req_dt(spec.get("created_at")),
                ready_at=_req_dt(spec.get("created_at")),
            )
        )
    session.flush()


def _load_judgments(
    session: Session, run: AgentTaskRunDB, judgments: list[dict[str, Any]]
) -> None:
    for spec in judgments:
        session.add(
            AgentTaskJudgmentDB(
                id=str(spec["id"]),
                task_run_id=run.id,
                project=DEMO_PROJECT_ID,
                trigger=str(spec.get("trigger", "rejudge")),
                label=spec.get("label"),
                judge_model=str(spec.get("judge_model", "")),
                samples=int(spec.get("samples", 1)),
                pass_result=spec.get("pass_result"),
                total_checks=int(spec.get("total_checks") or 0),
                passed_checks=int(spec.get("passed_checks") or 0),
                failed_checks=int(spec.get("failed_checks") or 0),
                checks_json=spec.get("checks_json"),
                stability_json=spec.get("stability_json"),
                created_at=_req_dt(spec.get("created_at")),
            )
        )
    session.flush()


def _load_corrections(
    session: Session, run_specs: list[dict[str, Any]]
) -> None:
    """Replay corrections through the real correction service so run
    scalars, corrected_tests, and batch rollups re-derive exactly as live."""
    from .test_result_corrections import CorrectionActor, correct_test_result

    for run_spec in run_specs:
        corrections = run_spec.get("corrections") or []
        if not corrections:
            continue
        run = session.get(AgentTaskRunDB, str(run_spec["id"]))
        if run is None:
            continue
        actor = CorrectionActor(
            user_id=DEMO_USER_ID,
            label="Apo Demo",
            via="session",
            api_key_id=None,
        )
        for spec in corrections:
            correct_test_result(
                session,
                task_run=run,
                project=DEMO_PROJECT_ID,
                test_id=str(spec["test_id"]),
                action=str(spec["action"]),
                reason=spec.get("reason"),
                actor=actor,
            )


def _load_schedules(
    session: Session,
    schedules: list[dict[str, Any]],
    batches: dict[str, AgentTaskBatchRunDB],
) -> None:
    for spec in schedules:
        schedule = AgentTaskScheduleDB(
            id=str(spec["id"]),
            project=DEMO_PROJECT_ID,
            name=str(spec["name"]),
            selection_type=str(spec.get("selection_type", "all")),
            environment=str(spec.get("environment", "demo")),
            cadence_type=str(spec.get("cadence_type", "weekly")),
            timezone=str(spec.get("timezone", "UTC")),
            hour=int(spec.get("hour", 9)),
            minute=int(spec.get("minute", 0)),
            day_of_week=spec.get("day_of_week"),
            day_of_month=spec.get("day_of_month"),
            # The demo is read-only: schedules always load disabled so the
            # dispatcher can never fire them, occurrence history is fixture data.
            enabled=False,
            last_triggered_at=_parse_dt(spec.get("last_triggered_at")),
            last_batch_run_id=spec.get("last_batch_run_id"),
            next_run_at=None,
            created_at=_req_dt(spec.get("created_at")),
            updated_at=_req_dt(spec.get("created_at")),
        )
        session.add(schedule)
        session.flush()

        for occ in spec.get("occurrences", []):
            session.add(
                AgentTaskScheduleOccurrenceDB(
                    id=str(occ["id"]),
                    project=DEMO_PROJECT_ID,
                    schedule_id=schedule.id,
                    schedule_name=schedule.name,
                    kind=str(occ.get("kind", "scheduled")),
                    scheduled_for=_req_dt(occ.get("scheduled_for")),
                    status=str(occ.get("status", "delivered")),
                    batch_run_id=occ.get("batch_run_id"),
                    missed_reason=occ.get("missed_reason"),
                    resolved_at=_parse_dt(occ.get("resolved_at")),
                    created_at=_req_dt(occ.get("scheduled_for")),
                )
            )
        for state in spec.get("adaptive_states", []):
            session.add(
                AdaptiveTaskStateDB(
                    id=f"{schedule.id}||{state['task_id']}",
                    schedule_id=schedule.id,
                    task_id=str(state["task_id"]),
                    current_interval_days=float(state.get("interval_days", 7)),
                    last_status=state.get("last_status"),
                    last_run_at=_parse_dt(state.get("last_run_at")),
                    next_run_at=_parse_dt(state.get("next_run_at")),
                )
            )
    session.flush()


def _load_views(
    session: Session,
    views: dict[str, Any],
    demo_user: UserDB | None,
) -> None:
    for spec in views.get("task_views", []):
        session.add(
            TaskViewDB(
                id=str(spec["id"]),
                project_id=DEMO_PROJECT_ID,
                user_id=demo_user.id if demo_user else spec.get("user_id"),
                label=str(spec["label"]),
                model=spec.get("model"),
                effort=spec.get("effort"),
                since=spec.get("since"),
                created_at=_req_dt(spec.get("created_at")),
                updated_at=_req_dt(spec.get("created_at")),
            )
        )
    for spec in views.get("comparisons", []):
        session.add(
            TaskViewComparisonDB(
                id=str(spec["id"]),
                project_id=DEMO_PROJECT_ID,
                view_a_config=spec.get("view_a_config", {}),
                view_b_config=spec.get("view_b_config", {}),
                task_ids=spec.get("task_ids", []),
                resolved=spec.get("resolved", {}),
                coverage=spec.get("coverage", {}),
                created_by=demo_user.id if demo_user else spec.get("created_by"),
                created_at=_req_dt(spec.get("created_at")),
            )
        )
    session.flush()


def _replay_traces(
    session: Session,
    batches: list[dict[str, Any]],
    loaded: dict[str, AgentTaskBatchRunDB],
) -> None:
    """Replay each run's OTLP payload through the real ingestion pipeline.

    Synchronous ingest produces the canonical spans, the atomic task-run
    trace claim, and the projected RunDB/LoggedCallDB rows — identical to a
    live run. The claim requires a service-token context whose subject is
    the task run (tests/test_task_run_claim.py pattern).
    """
    from ..models.trace_ingestion import TraceIngestionContext
    from .otlp_receiver import OtlpReceiver
    from .trace_ownership import roll_up_batch

    receiver = OtlpReceiver()
    for batch_spec in batches:
        runs = list(
            session.exec(
                select(AgentTaskRunDB).where(
                    AgentTaskRunDB.batch_run_id == str(batch_spec["id"])
                )
            ).all()
        )
        for run_spec in batch_spec.get("runs", []):
            payload = run_spec.get("otel_trace")
            if not payload:
                continue
            receiver.ingest(
                payload=json.dumps(payload).encode(),
                content_type="application/json",
                project_id=DEMO_PROJECT_ID,
                session=session,
                context=TraceIngestionContext(
                    project_id=DEMO_PROJECT_ID,
                    auth_method="service_token",
                    service_task_run_id=str(run_spec["id"]),
                ),
                project_immediately=True,
            )
        batch = loaded[str(batch_spec["id"])]
        _roll_up_counts(session, batch)
        for run in runs:
            run.trace_persistence_status = "persisted"
            session.add(run)
        batch.trace_persistence_status = "persisted"
        session.add(batch)
        _ = roll_up_batch(batch, runs)
        session.flush()


def _roll_up_counts(session: Session, batch: AgentTaskBatchRunDB) -> None:
    runs = list(
        session.exec(
            select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch.id)
        ).all()
    )
    batch.total_tasks = len(runs)
    batch.passed_tasks = sum(1 for r in runs if r.status == "passed")
    batch.failed_tasks = sum(1 for r in runs if r.status == "failed")
    batch.errored_tasks = sum(1 for r in runs if r.status == "error")
    batch.total_checks = sum(r.total_checks or 0 for r in runs)
    batch.passed_checks = sum(r.passed_checks or 0 for r in runs)
    session.add(batch)
    session.flush()


# ---------------------------------------------------------------------------
# Clearing (FK-safe order; supersedes the old demo_workspace seeder)
# ---------------------------------------------------------------------------


def _clear_demo_data(session: Session) -> None:
    """Delete every demo-project row so the fixture can reload cleanly."""
    _delete_where(
        session,
        TaskViewDB,
        col(TaskViewDB.project_id) == DEMO_PROJECT_ID,
    )
    _delete_where(
        session,
        TaskViewComparisonDB,
        col(TaskViewComparisonDB.project_id) == DEMO_PROJECT_ID,
    )
    _delete_where(
        session,
        AdaptiveTaskStateDB,
        col(AdaptiveTaskStateDB.schedule_id).startswith("demo-"),
    )
    _delete_where(
        session,
        AgentTaskScheduleOccurrenceDB,
        col(AgentTaskScheduleOccurrenceDB.project) == DEMO_PROJECT_ID,
    )
    _delete_where(
        session,
        AgentTaskScheduleDB,
        col(AgentTaskScheduleDB.project) == DEMO_PROJECT_ID,
    )

    demo_run_ids = list(
        session.exec(
            select(RunDB.id).where(RunDB.project == DEMO_PROJECT_ID)
        ).all()
    )
    if demo_run_ids:
        _ = session.exec(
            delete(RunMetricDB).where(col(RunMetricDB.run_id).in_(demo_run_ids))
        )
        _ = session.exec(
            delete(LoggedCallDB).where(col(LoggedCallDB.run_id).in_(demo_run_ids))
        )
        _ = session.exec(
            delete(RunDB).where(col(RunDB.id).in_(demo_run_ids))
        )

    _ = session.exec(
        delete(OtlpSpanDB).where(col(OtlpSpanDB.project_id) == DEMO_PROJECT_ID)
    )
    _ = session.exec(
        delete(OtlpIngestBatchDB).where(
            col(OtlpIngestBatchDB.project_id) == DEMO_PROJECT_ID
        )
    )

    demo_batches = list(
        session.exec(
            select(AgentTaskBatchRunDB.id).where(
                AgentTaskBatchRunDB.project == DEMO_PROJECT_ID
            )
        ).all()
    )
    if demo_batches:
        demo_task_run_ids = select(AgentTaskRunDB.id).where(
            col(AgentTaskRunDB.batch_run_id).in_(demo_batches)
        )
        # Run-scoped evidence first (each is FK-bound to its task run):
        # corrections, judgments, deliverables, and caller-execution attempts.
        for model in (
            AgentTaskTestResultCorrectionDB,
            AgentTaskJudgmentDB,
            AgentTaskDeliverableDB,
            TaskExecutionAttemptDB,
        ):
            _ = session.exec(
                delete(model).where(col(model.task_run_id).in_(demo_task_run_ids))
            )
        _ = session.exec(
            delete(TaskRevisionDB).where(
                col(TaskRevisionDB.batch_run_id).in_(demo_batches)
            )
        )
        _ = session.exec(
            delete(AgentTaskRunDB).where(
                col(AgentTaskRunDB.batch_run_id).in_(demo_batches)
            )
        )
        _ = session.exec(
            delete(AgentTaskBatchRunDB).where(
                col(AgentTaskBatchRunDB.id).in_(demo_batches)
            )
        )

    _delete_where(
        session,
        ProjectTaskInventoryDB,
        col(ProjectTaskInventoryDB.project) == DEMO_PROJECT_ID,
    )
    session.commit()


def _delete_where(
    session: Session, model: type, condition: Any
) -> None:
    _ = session.exec(delete(model).where(condition))
    session.commit()
