"""Data retention / size control for the SQLite-backed store.

Three mechanisms keep the database from growing without bound:

1. **Daily maintenance** (always on): trims raw OTLP ingest payloads past
   their replay window, fails artifact uploads abandoned past their TTL,
   reaps expired credential tokens, and — when retention is configured —
   purges old data. Runs once at startup then every 24 h.

2. **Time-based retention** (``APO_RETENTION_DAYS``, default 0 = off):
   deletes old traces, runs, and agent-task outputs older than the
   configured window, then ``VACUUM``s to reclaim file space. Driven by
   parent age so that child rows (metrics, call spans) are removed before
   their parents and FK constraints stay satisfied. Bookmarked runs are
   always kept.

3. **Hard size cap** (``APO_MAX_DB_PAGES``): sets SQLite's
   ``PRAGMA max_page_count``. Once the DB file reaches the cap, further
   writes fail with ``SQLITE_FULL`` rather than growing the file. This is a
   blunt safety valve — retention is the graceful path, the cap is the
   last line of defence.

Retention defaults to off (0) so existing deployments are unaffected until
an operator opts in; the maintenance tasks are pure hygiene (inbox
payloads, abandoned uploads, dead credentials) and always run. Non-SQLite
backends ignore the size cap (it is a SQLite pragma) and simply skip the
SQLite-specific optimisations.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any, cast

# pyright: reportDeprecated=false, reportExplicitAny=false, reportImplicitStringConcatenation=false, reportPrivateLocalImportUsage=false, reportPrivateUsage=false

from sqlalchemy import bindparam, text
from sqlalchemy.engine import CursorResult
from sqlmodel import Session, select

from fastapi import HTTPException

from ..db import DATA_DIR, SQLITE_FILE_NAME, engine, is_sqlite
from ..db_helpers import as_column, table_exists
from ..models.db import AgentTaskDeliverableDB, MaintenanceStateDB
from .artifact_stores.registry import artifact_limits, get_store

logger = logging.getLogger(__name__)

# Age-based retention. 0 = disabled (no automatic deletion).
RETENTION_DAYS = int(os.environ.get("APO_RETENTION_DAYS", "0"))

# Hard ceiling on the DB file size, expressed in SQLite pages (4 KiB each
# by default). 0 = unlimited. e.g. 65536 pages ~= 256 MiB. SQLite-only.
MAX_DB_PAGES = int(os.environ.get("APO_MAX_DB_PAGES", "0"))

# How long raw OTLP ingest payloads (``otlp_ingest_batches.payload``, up to
# 10 MiB per request) stay replayable. The payload is a replay inbox for
# convention changes — after the window it is blanked (the audit row with
# its accepted/rejected counts stays). Read fresh each run so operators can
# change it without a restart, unlike the module-level knobs above.
INGEST_PAYLOAD_RETENTION_DAYS_ENV = "APO_INGEST_RETENTION_DAYS"
DEFAULT_INGEST_PAYLOAD_RETENTION_DAYS = 7


def ingest_payload_retention_days() -> int:
    value = os.environ.get(INGEST_PAYLOAD_RETENTION_DAYS_ENV, "")
    try:
        days = int(value)
    except ValueError:
        days = DEFAULT_INGEST_PAYLOAD_RETENTION_DAYS
    return max(days, 0)


def trim_old_ingest_payloads(session: Session, cutoff: datetime) -> int:
    """Blank raw OTLP ingest payloads older than ``cutoff``.

    The payload is a crash-window buffer, not a permanent archive: the
    canonical span store is the source of truth, and a successfully
    projected batch's payload is already blanked by ``mark_complete``.
    This TTL is the backstop for batches that never completed (failed,
    partial, or ``project_immediately`` batches whose status is terminal).
    Queued or leased batches are never blanked — the replay path must stay
    durable. Past the window the payload is blanked in place; the row keeps
    its received/accepted/rejected audit counts until the row reap removes
    it. 0-day window disables trimming (nothing is ever blanked).
    """
    if not table_exists(session, "otlp_ingest_batches"):
        return 0
    result = cast(
        CursorResult[Any],
        session.execute(
            text(
                "UPDATE otlp_ingest_batches SET payload = '' "
                "WHERE received_at < :c AND payload != '' "
                "AND status NOT IN ('queued', 'processing')"
            ),
            {"c": cutoff},
        ),
    )
    return result.rowcount or 0


INGEST_STUCK_BATCH_DAYS_ENV = "APO_INGEST_STUCK_BATCH_DAYS"
DEFAULT_INGEST_STUCK_BATCH_DAYS = 30


def ingest_stuck_batch_days() -> int:
    value = os.environ.get(INGEST_STUCK_BATCH_DAYS_ENV, "")
    try:
        days = int(value)
    except ValueError:
        days = DEFAULT_INGEST_STUCK_BATCH_DAYS
    return max(days, 0)


def fail_stuck_ingest_batches(session: Session, cutoff: datetime) -> int:
    """Terminal-fail non-terminal batches older than ``cutoff``.

    A dead worker (or a batch looping on projection failure) would
    otherwise keep its full up-to-10 MiB payload forever: the trim skips
    queued/processing batches by design, and the row reap requires a
    terminal status. Past the horizon the payload is discarded and the
    batch is marked failed with the reason — visible in the admin
    retention report's queue depth.
    """
    if not table_exists(session, "otlp_ingest_batches"):
        return 0
    result = cast(
        CursorResult[Any],
        session.execute(
            text(
                "UPDATE otlp_ingest_batches SET payload = '', status = 'failed', "
                "error_message = 'stuck non-terminal batch past the ingest "
                "horizon; payload discarded', processing_started_at = NULL "
                "WHERE received_at < :c AND status IN ('queued', 'processing')"
            ),
            {"c": cutoff},
        ),
    )
    return result.rowcount or 0


INGEST_BATCH_ROW_RETENTION_DAYS_ENV = "APO_INGEST_BATCH_ROW_RETENTION_DAYS"
DEFAULT_INGEST_BATCH_ROW_RETENTION_DAYS = 90


def ingest_batch_row_retention_days() -> int:
    value = os.environ.get(INGEST_BATCH_ROW_RETENTION_DAYS_ENV, "")
    try:
        days = int(value)
    except ValueError:
        days = DEFAULT_INGEST_BATCH_ROW_RETENTION_DAYS
    return max(days, 0)


def reap_old_ingest_batch_rows(session: Session, cutoff: datetime) -> int:
    """Delete terminal, payload-blanked inbox rows older than ``cutoff``.

    Nothing references ``otlp_ingest_batches`` (``verified_task_run_id``
    points outward and is nulled when its target goes), so deletion is
    unconditionally safe once the payload is gone and the status is
    terminal. Keeps the audit trail (counts, sha, status) for the window,
    then stops accumulating rows forever.
    """
    if not table_exists(session, "otlp_ingest_batches"):
        return 0
    result = cast(
        CursorResult[Any],
        session.execute(
            text(
                "DELETE FROM otlp_ingest_batches WHERE received_at < :c "
                "AND payload = '' AND status NOT IN ('queued', 'processing')"
            ),
            {"c": cutoff},
        ),
    )
    return result.rowcount or 0


def delete_orphaned_spans(session: Session, cutoff: datetime) -> int:
    """Delete OTLP spans older than ``cutoff`` whose trace is gone.

    Spans belong to the canonical store (``otlp_spans``); the trace
    projection (``runs``) is what retention expires. This sweep runs after
    the projection delete and removes spans that no surviving ``runs`` row
    claims in the same project — so spans of purged traces die with them,
    while spans of bookmarked (surviving) traces stay. It also clears
    orphans left by older deletions that predate span cleanup.
    """
    if not table_exists(session, "otlp_spans"):
        return 0
    result = cast(
        CursorResult[Any],
        session.execute(
            text(
                "DELETE FROM otlp_spans WHERE created_at < :c AND NOT EXISTS ("
                "SELECT 1 FROM runs WHERE runs.project = otlp_spans.project_id "
                "AND runs.id = otlp_spans.trace_id)"
            ),
            {"c": cutoff},
        ),
    )
    return result.rowcount or 0


def delete_trace_projection(
    session: Session, project: str, run_ids: list[str], trace_ids: list[str]
) -> dict[str, int]:
    """Delete the trace a Task Run owns: ``runs`` and all its children.

    Shared by manual run deletion (``run_deletion``) and evidence-tier
    expiry. Scoped by project so a shared OTel trace id cannot delete
    another project's metrics or calls (mirrors the
    ``/v1/runs/bulk-delete`` guard). The run link (``runs.task_run_id``)
    and the run row's own backlink (``agent_task_runs.trace_run_id``) are
    both followed — either may be missing on legacy rows.
    """
    if not run_ids and not trace_ids:
        return {"deleted_traces": 0, "deleted_calls": 0}

    # Resolve the full trace-id set from both links before any row goes.
    resolved = set(trace_ids)
    if run_ids:
        rows = session.execute(
            text(
                "SELECT id FROM runs WHERE project = :p AND task_run_id IN :ids"
            ).bindparams(bindparam("ids", expanding=True)),
            {"p": project, "ids": run_ids},
        ).all()
        resolved.update(row[0] for row in rows)
    if not resolved:
        # No trace id anywhere: still drop the soft ingest reference and any
        # projection row linked only by task_run_id.
        traces = _exec_in(
            session,
            "DELETE FROM runs WHERE project = :p AND task_run_id IN :ids",
            {"p": project, "ids": run_ids},
        )
        _ = _exec_in(
            session,
            "UPDATE otlp_ingest_batches SET verified_task_run_id = NULL "
            "WHERE verified_task_run_id IN :ids",
            {"ids": run_ids},
        )
        return {"deleted_traces": traces, "deleted_calls": 0}

    trace_id_list = sorted(resolved)
    calls = 0
    if table_exists(session, "call_metrics"):
        calls += _exec_in(
            session,
            "DELETE FROM call_metrics WHERE project = :p AND call_id IN "
            "(SELECT id FROM logged_calls WHERE project = :p AND run_id IN :ids)",
            {"p": project, "ids": trace_id_list},
        )
    if table_exists(session, "logged_calls"):
        calls += _exec_in(
            session,
            "DELETE FROM logged_calls WHERE project = :p AND run_id IN :ids",
            {"p": project, "ids": trace_id_list},
        )
    if table_exists(session, "run_metrics"):
        _ = _exec_in(
            session,
            "DELETE FROM run_metrics WHERE project = :p AND run_id IN :ids",
            {"p": project, "ids": trace_id_list},
        )
    if table_exists(session, "otlp_spans"):
        _ = _exec_in(
            session,
            "DELETE FROM otlp_spans WHERE project_id = :p AND trace_id IN :ids",
            {"p": project, "ids": trace_id_list},
        )
    traces = _exec_in(
        session,
        "DELETE FROM runs WHERE project = :p AND id IN :ids",
        {"p": project, "ids": trace_id_list},
    )
    if run_ids:
        traces += _exec_in(
            session,
            "DELETE FROM runs WHERE project = :p AND task_run_id IN :ids",
            {"p": project, "ids": run_ids},
        )
        _ = _exec_in(
            session,
            "UPDATE otlp_ingest_batches SET verified_task_run_id = NULL "
            "WHERE verified_task_run_id IN :ids",
            {"ids": run_ids},
        )
    return {"deleted_traces": traces, "deleted_calls": calls}


def reap_expired_credentials(session: Session) -> int:
    """Delete credential tokens past their expiry.

    Verification/reset/enrollment tokens are unusable after ``expires_at``
    whether or not they were consumed; the rows are pure dead weight.
    Invitations are deliberately NOT reaped — they carry invite history.
    """
    deleted = 0
    now = datetime.now(timezone.utc)
    for table in (
        "email_verification_tokens",
        "password_reset_tokens",
        "executor_enrollment_tokens",
    ):
        if not table_exists(session, table):
            continue
        result = cast(
            CursorResult[Any],
            session.execute(
                text(f"DELETE FROM {table} WHERE expires_at < :n"),  # noqa: S608
                {"n": now},
            ),
        )
        deleted += result.rowcount or 0
    return deleted


USAGE_RETENTION_DAYS_ENV = "APO_USAGE_RETENTION_DAYS"
DEFAULT_USAGE_RETENTION_DAYS = 400


def usage_retention_days() -> int:
    value = os.environ.get(USAGE_RETENTION_DAYS_ENV, "")
    try:
        days = int(value)
    except ValueError:
        days = DEFAULT_USAGE_RETENTION_DAYS
    return max(days, 0)


def reap_old_usage_rows(session: Session, cutoff_day: str) -> int:
    """Delete per-key usage rollup rows older than the retention window.

    Rows are tiny; 0 = keep forever (matching apo's other retention-knob
    semantics). Days are compared as YYYY-MM-DD strings — lexicographic
    order equals chronological order for zero-padded ISO dates.
    """
    if not table_exists(session, "api_key_daily_usage"):
        return 0
    result = cast(
        CursorResult[Any],
        session.execute(
            text("DELETE FROM api_key_daily_usage WHERE day < :c"),
            {"c": cutoff_day},
        ),
    )
    return result.rowcount or 0


# Grace window before an unreferenced Task Definition Revision is reaped.
# Revisions are content-addressed and shared; one still referenced by any
# run (verdict provenance), judgment (judgment provenance), or the task
# inventory (currently published) never goes. Unreferenced ones are
# superseded content — a republish recreates them on demand.
UNREFERENCED_REVISION_GRACE_DAYS = 30


def reap_unreferenced_task_definition_revisions(
    session: Session, cutoff: datetime
) -> int:
    """Delete eval revisions nothing points at, older than ``cutoff``."""
    if not table_exists(session, "task_definition_revisions"):
        return 0
    result = cast(
        CursorResult[Any],
        session.execute(
            text(
                "DELETE FROM task_definition_revisions WHERE created_at < :c "
                "AND NOT EXISTS (SELECT 1 FROM agent_task_runs a "
                "  WHERE a.task_definition_revision_id = task_definition_revisions.id) "
                "AND NOT EXISTS (SELECT 1 FROM agent_task_judgments j "
                "  WHERE j.task_definition_revision_id = task_definition_revisions.id) "
                "AND NOT EXISTS (SELECT 1 FROM project_task_inventory i "
                "  WHERE i.task_definition_revision_id = task_definition_revisions.id)"
            ),
            {"c": cutoff},
        ),
    )
    return result.rowcount or 0


# How long run EVIDENCE stays inspectable after the batch completed:
# transcripts, traces (calls/metrics/spans), check-report documents,
# rejudge check evidence, deliverables (rows and stored objects), and
# attempt diagnostics. Verdict rows (status, pass_result, check counts,
# costs, corrections) stay forever — the regression timeline is tiny and
# is the product's long-lived value. 0 = keep evidence forever. Read fresh
# each run so operators can change it without a restart.
EVIDENCE_RETENTION_DAYS_ENV = "APO_EVIDENCE_RETENTION_DAYS"
DEFAULT_EVIDENCE_RETENTION_DAYS = 0


def evidence_retention_days() -> int:
    value = os.environ.get(EVIDENCE_RETENTION_DAYS_ENV, "")
    try:
        days = int(value)
    except ValueError:
        days = DEFAULT_EVIDENCE_RETENTION_DAYS
    return max(days, 0)


def effective_evidence_days(project_override: int | None) -> int:
    """Resolve one project's evidence window: its override, else the env default.

    ``None`` inherits ``APO_EVIDENCE_RETENTION_DAYS``; ``0`` explicitly
    keeps the project's evidence forever even under a shorter default;
    ``N`` expires after N days. Re-resolved on every maintenance pass so a
    changed setting applies on the next run — no stale cutoffs.
    """
    if project_override is None:
        return evidence_retention_days()
    return max(project_override, 0)


def project_evidence_windows(session: Session) -> dict[str, int]:
    """Effective evidence window per project, projects with a window > 0 only.

    The read-only demo project is never included — its showcase content is
    managed by ``demo_workspace`` reseeding.
    """
    if not table_exists(session, "projects"):
        return {}
    raw = cast(
        "list[tuple[object, ...]]",
        cast(
            object,
            session.execute(
                text("SELECT id, evidence_retention_days FROM projects")
            ).all(),
        ),
    )
    demo = _demo_project_id()
    windows: dict[str, int] = {}
    for row in raw:
        project_id = str(row[0])
        override = cast("int | None", row[1])
        days = effective_evidence_days(override)
        if days > 0 and project_id != demo:
            windows[project_id] = days
    return windows


_EVIDENCE_CANDIDATES_SQL = text(
    "SELECT atr.id, atr.trace_run_id "
    "FROM agent_task_runs atr "
    "JOIN agent_task_batch_runs b ON atr.batch_run_id = b.id "
    "WHERE COALESCE(atr.started_at, b.created_at) < :c "
    "AND b.project = :p "
    "AND ("
    "  atr.transcript_json IS NOT NULL"
    "  OR atr.trace_run_id IS NOT NULL"
    "  OR EXISTS (SELECT 1 FROM agent_task_check_reports cr"
    "             WHERE cr.run_id = atr.id)"
    "  OR EXISTS (SELECT 1 FROM agent_task_deliverables d"
    "             WHERE d.task_run_id = atr.id)"
    "  OR EXISTS (SELECT 1 FROM agent_task_judgments j"
    "             WHERE j.task_run_id = atr.id AND j.checks_json IS NOT NULL)"
    ") "
    "AND NOT EXISTS ("
    "  SELECT 1 FROM runs r WHERE r.task_run_id = atr.id AND r.bookmarked = 1"
    ")"
)


def _evidence_candidates(
    session: Session, project: str, cutoff: datetime
) -> list[tuple[str, str | None]]:
    """Runs in ``project`` older than ``cutoff`` whose evidence would expire:
    still holding evidence, not bookmark-protected."""
    raw = cast(
        "list[tuple[object, ...]]",
        cast(object, session.execute(_EVIDENCE_CANDIDATES_SQL, {"c": cutoff, "p": project}).all()),
    )
    return [
        (str(row[0]), str(row[1]) if row[1] is not None else None) for row in raw
    ]


def preview_run_evidence_expiry(session: Session, now: datetime) -> list[dict[str, object]]:
    """Dry run of evidence expiry: what the NEXT maintenance pass would expire.

    The safety check to run before enabling or tightening a window: per
    project, how many runs would lose evidence right now and which ones
    (first 10 ids). Deletes nothing.
    """
    preview: list[dict[str, object]] = []
    demo = _demo_project_id()
    for project, days in project_evidence_windows(session).items():
        if project == demo:
            continue
        candidates = _evidence_candidates(session, project, now - timedelta(days=days))
        preview.append(
            {
                "project": project,
                "window_days": days,
                "runs_eligible": len(candidates),
                "sample_run_ids": [run_id for run_id, _ in candidates[:10]],
            }
        )
    return preview


async def expire_run_evidence(
    session: Session,
    now: datetime,
    *,
    windows: dict[str, int] | None = None,
) -> dict[str, int]:
    """Drop the evidence tier of old runs, per project's effective window.

    Two-tier retention: verdicts live forever, evidence expires. For each
    project with a window (per-project override, else the env default;
    see ``project_evidence_windows``), every non-bookmarked run older than
    the window (aged by the run's ``started_at``, falling back to the
    batch's creation for never-started runs) and still holding evidence
    loses: deliverable
    objects then rows, check reports, trace projections (calls, metrics,
    spans — project-scoped), rejudge ``checks_json`` (the judgment row
    keeps its verdict scalars), attempt diagnostics, and the inline
    transcript, and its trace link is cleared. A store failure during
    object cleanup raises before any row changes — the next pass retries.
    Bookmarking a trace is the escape hatch: a bookmarked run keeps all of
    its evidence forever. The read-only demo project is never touched.
    """
    if windows is None:
        windows = project_evidence_windows(session)
    if not windows:
        return {"runs_affected": 0, "deleted_traces": 0, "deleted_calls": 0}

    summary: dict[str, int] = {"runs_affected": 0, "deleted_traces": 0, "deleted_calls": 0}
    demo = _demo_project_id()
    for project, days in windows.items():
        # Defense in depth: the demo project is never expired, even if a
        # caller-supplied window map includes it.
        if project == demo:
            continue
        cutoff = now - timedelta(days=days)
        candidates = _evidence_candidates(session, project, cutoff)
        if not candidates:
            continue
        summary["runs_affected"] += len(candidates)
        run_ids = [run_id for run_id, _ in candidates]
        trace_ids = [t for _, t in candidates if t]

        # Stored objects go first, while their manifest rows are readable.
        await delete_deliverable_objects_for_runs(session, run_ids)

        if table_exists(session, "agent_task_deliverables"):
            summary["deleted_deliverables"] = summary.get("deleted_deliverables", 0) + _exec_in(
                session,
                "DELETE FROM agent_task_deliverables WHERE task_run_id IN :ids",
                {"ids": run_ids},
            )
        if table_exists(session, "agent_task_check_reports"):
            summary["deleted_check_reports"] = summary.get("deleted_check_reports", 0) + _exec_in(
                session,
                "DELETE FROM agent_task_check_reports WHERE run_id IN :ids",
                {"ids": run_ids},
            )
        # Judgment rows keep their verdict scalars (pass_result, check
        # counts, model); only the replayed check evidence goes.
        if table_exists(session, "agent_task_judgments"):
            summary["blanked_judgments"] = summary.get("blanked_judgments", 0) + _exec_in(
                session,
                "UPDATE agent_task_judgments SET checks_json = NULL "
                "WHERE task_run_id IN :ids AND checks_json IS NOT NULL",
                {"ids": run_ids},
            )
        if table_exists(session, "task_execution_attempts"):
            _ = _exec_in(
                session,
                "UPDATE task_execution_attempts SET stdout_tail = NULL, "
                "stderr_tail = NULL, executor_snapshot_json = NULL "
                "WHERE task_run_id IN :ids "
                "AND (stdout_tail IS NOT NULL OR stderr_tail IS NOT NULL "
                "OR executor_snapshot_json IS NOT NULL)",
                {"ids": run_ids},
            )
        # The inline transcript goes; the run row and its verdict stay.
        _ = _exec_in(
            session,
            "UPDATE agent_task_runs SET transcript_json = NULL, "
            "trace_run_id = NULL WHERE id IN :ids",
            {"ids": run_ids},
        )
        counts = delete_trace_projection(session, project, run_ids, trace_ids)
        summary["deleted_traces"] += counts["deleted_traces"]
        summary["deleted_calls"] += counts["deleted_calls"]

    return summary


def _demo_project_id() -> str:
    """The read-only demo project id (lazy — demo_workspace is a heavy import)."""
    from .demo_workspace import DEMO_PROJECT_ID

    return DEMO_PROJECT_ID


def _delete_old_runs(session: Session, cutoff: datetime) -> int:
    """Delete non-bookmarked runs (and their children) older than ``cutoff``.

    Driven by parent age so children (run_metrics, logged_calls, and the
    call_metrics under those calls) are removed before the parents, keeping
    FK constraints (run_metrics.run_id, call_metrics.call_id) satisfied.
    The demo project is never purged — its content is managed by
    ``demo_workspace`` reseeding, not retention.
    """
    # Collect the IDs of runs to expire first — children reference these.
    old_run_ids = [
        row[0]
        for row in session.execute(
            text(
                "SELECT id FROM runs WHERE created_at < :c AND bookmarked = 0 "
                "AND project != :demo"
            ),
            {"c": cutoff, "demo": _demo_project_id()},
        ).all()
    ]
    if not old_run_ids:
        return 0

    def _exec_in(sql: str, ids: list[str]) -> int:
        # expanding bindparam turns ``IN :ids`` into one bind per value.
        stmt = text(sql).bindparams(bindparam("ids", expanding=True))
        result = cast(CursorResult[Any], session.execute(stmt, {"ids": ids}))
        return result.rowcount or 0

    deleted = 0
    if table_exists(session, "call_metrics"):
        deleted += _exec_in(
            "DELETE FROM call_metrics WHERE call_id IN "
            "(SELECT id FROM logged_calls WHERE run_id IN :ids)",
            old_run_ids,
        )
    if table_exists(session, "logged_calls"):
        deleted += _exec_in(
            "DELETE FROM logged_calls WHERE run_id IN :ids", old_run_ids
        )
    if table_exists(session, "run_metrics"):
        deleted += _exec_in(
            "DELETE FROM run_metrics WHERE run_id IN :ids", old_run_ids
        )
    deleted += _exec_in("DELETE FROM runs WHERE id IN :ids", old_run_ids)
    return deleted


def _old_batch_ids(session: Session, cutoff: datetime) -> list[str]:
    # The demo project's batches are showcase content managed by
    # demo_workspace reseeding — retention never touches them.
    return [
        row[0]
        for row in session.execute(
            text(
                "SELECT id FROM agent_task_batch_runs "
                "WHERE created_at < :c AND project != :demo"
            ),
            {"c": cutoff, "demo": _demo_project_id()},
        ).all()
    ]


def _exec_in(session: Session, sql: str, params: dict[str, Any]) -> int:
    """Run one ``IN :ids`` statement (expanding bindparam) and return rowcount."""
    stmt = text(sql).bindparams(bindparam("ids", expanding=True))
    result = cast(CursorResult[Any], session.execute(stmt, params))
    return result.rowcount or 0


def delete_agent_task_rows(session: Session, run_ids: list[str]) -> int:
    """Delete agent-task rows for the given Task Run ids, children first.

    The shared cascade behind both retention's purge and manual run deletion
    (``run_deletion``), so the two can never drift apart. The trace
    projection (``runs`` and its children) is NOT touched — retention
    expires traces by their own age (keeping bookmarked ones) and manual
    deletion handles traces explicitly.

    Row deletes are explicit and pragma-independent: SQLite only fires
    ``ON DELETE CASCADE`` when ``PRAGMA foreign_keys=ON`` (true in
    production, not in every test engine), so the child-first ordering here
    is the contract, not a duplication of the FK metadata.
    """
    if not run_ids:
        return 0

    deleted = 0
    # Result-evidence staging rows FK both attempts and task_runs — they go
    # before the attempts they reference (transient rows; objects via the
    # reaper).
    if table_exists(session, "agent_task_result_evidence"):
        deleted += _exec_in(
            session,
            "DELETE FROM agent_task_result_evidence WHERE task_run_id IN :ids",
            {"ids": run_ids},
        )
    # attempts FK task_runs; remove them first.
    if table_exists(session, "task_execution_attempts"):
        deleted += _exec_in(
            session,
            "DELETE FROM task_execution_attempts WHERE task_run_id IN :ids",
            {"ids": run_ids},
        )
    # Check reports FK task_runs (ON DELETE CASCADE — see the note above).
    if table_exists(session, "agent_task_check_reports"):
        deleted += _exec_in(
            session,
            "DELETE FROM agent_task_check_reports WHERE run_id IN :ids",
            {"ids": run_ids},
        )
    # Rejudge judgments and corrected tests FK task_runs the same way.
    if table_exists(session, "agent_task_judgments"):
        deleted += _exec_in(
            session,
            "DELETE FROM agent_task_judgments WHERE task_run_id IN :ids",
            {"ids": run_ids},
        )
    if table_exists(session, "agent_task_test_result_corrections"):
        deleted += _exec_in(
            session,
            "DELETE FROM agent_task_test_result_corrections WHERE task_run_id IN :ids",
            {"ids": run_ids},
        )
    # Deliverable manifest rows (their stored objects went earlier).
    if table_exists(session, "agent_task_deliverables"):
        deleted += _exec_in(
            session,
            "DELETE FROM agent_task_deliverables WHERE task_run_id IN :ids",
            {"ids": run_ids},
        )
    deleted += _exec_in(
        session, "DELETE FROM agent_task_runs WHERE id IN :ids", {"ids": run_ids}
    )
    return deleted


def detach_batch_references(session: Session, batch_ids: list[str]) -> None:
    """Null the soft references Schedules keep to a Batch before it goes.

    ``agent_task_schedules.active_batch_run_id`` is a real FK — deleting a
    batch it still points at fails the purge under ``PRAGMA
    foreign_keys=ON``. Occurrences keep batch_run_id as history, so theirs
    is nulled rather than deleted.
    """
    if not batch_ids:
        return
    params = {"ids": batch_ids}
    _ = _exec_in(
        session,
        "UPDATE agent_task_schedules SET active_batch_run_id = NULL "
        "WHERE active_batch_run_id IN :ids",
        params,
    )
    _ = _exec_in(
        session,
        "UPDATE agent_task_schedules SET last_batch_run_id = NULL "
        "WHERE last_batch_run_id IN :ids",
        params,
    )
    _ = _exec_in(
        session,
        "UPDATE agent_task_schedule_occurrences SET batch_run_id = NULL "
        "WHERE batch_run_id IN :ids",
        params,
    )


def delete_batch_rows(session: Session, batch_ids: list[str]) -> int:
    """Delete Batch rows and their task_revisions; returns batches deleted.

    Any Schedule references are detached first (see
    ``detach_batch_references``) so the delete cannot FK-fail on a batch a
    schedule still points at. task_revisions rows go next — their bundle
    objects were removed by the caller before this runs. The count covers
    Batch rows only; revision rows are dependents, not batches.
    """
    if not batch_ids:
        return 0
    detach_batch_references(session, batch_ids)
    # Guarded so pre-v12 databases don't break.
    if table_exists(session, "task_revisions"):
        _ = _exec_in(
            session,
            "DELETE FROM task_revisions WHERE batch_run_id IN :ids",
            {"ids": batch_ids},
        )
    return _exec_in(
        session,
        "DELETE FROM agent_task_batch_runs WHERE id IN :ids",
        {"ids": batch_ids},
    )


def _old_batch_purge_plan(
    session: Session, cutoff: datetime
) -> tuple[list[str], list[str]]:
    """Bookmark-aware purge plan for old batches: (task_run_ids, batch_ids).

    A task run whose trace run is bookmarked survives WITH its verdict,
    corrections, and deliverables — matching what the trace-side purge
    (``_delete_old_runs``) already guarantees. Because a surviving task run
    keeps its ``batch_run_id`` FK, its batch row (and that batch's revision
    bundles) must survive too; only batches with no bookmark-protected task
    run are fully deletable. Callers must apply the same plan to BOTH
    object pre-passes — deleting bundle objects for a batch whose manifest
    rows survive leaves dangling references.
    """
    old_batch_ids = _old_batch_ids(session, cutoff)
    if not old_batch_ids:
        return [], []

    task_run_ids = [
        row[0]
        for row in session.execute(
            text(
                "SELECT id FROM agent_task_runs WHERE batch_run_id IN :ids "
                "AND NOT EXISTS (SELECT 1 FROM runs r "
                "WHERE r.task_run_id = agent_task_runs.id AND r.bookmarked = 1)"
            ).bindparams(bindparam("ids", expanding=True)),
            {"ids": old_batch_ids},
        ).all()
    ]
    protected_batches = {
        row[0]
        for row in session.execute(
            text(
                "SELECT DISTINCT batch_run_id FROM agent_task_runs "
                "WHERE batch_run_id IN :ids "
                "AND EXISTS (SELECT 1 FROM runs r "
                "WHERE r.task_run_id = agent_task_runs.id AND r.bookmarked = 1)"
            ).bindparams(bindparam("ids", expanding=True)),
            {"ids": old_batch_ids},
        ).all()
    }
    deletable_batches = [b for b in old_batch_ids if b not in protected_batches]
    return task_run_ids, deletable_batches


def _delete_old_batch_runs(
    session: Session,
    cutoff: datetime,
    plan: tuple[list[str], list[str]] | None = None,
) -> int:
    """Delete old batch runs and their task runs — bookmark-aware.

    Uses ``_old_batch_purge_plan`` (or a caller-computed plan, so the
    object pre-passes and the row deletes share one bookmark-aware
    decision): bookmark-protected task runs (and their batches, revision
    bundles, deliverable objects) survive. The trace projection is
    intentionally untouched here — traces expire by their own age via
    ``_delete_old_runs`` (which keeps bookmarked runs).
    """
    if plan is None:
        plan = _old_batch_purge_plan(session, cutoff)
    task_run_ids, deletable_batch_ids = plan
    if not task_run_ids and not deletable_batch_ids:
        return 0
    deleted = delete_agent_task_rows(session, task_run_ids)
    deleted += delete_batch_rows(session, deletable_batch_ids)
    return deleted

async def delete_deliverable_objects_for_runs(
    session: Session,
    run_ids: list[str],
) -> None:
    """Delete external Deliverable objects for the given runs BEFORE their rows.

    Objects are removed idempotently first;
    only after success may the database rows go. A store failure raises so the
    caller retains the rows and retries on the next cleanup — objects are never
    orphaned by deleting the manifest first. Inline JSON rows need no object
    deletion and delete transactionally with the task run.
    """
    if not run_ids:
        return
    rows = session.exec(
        select(AgentTaskDeliverableDB).where(
            as_column(AgentTaskDeliverableDB.task_run_id).in_(run_ids),
            as_column(AgentTaskDeliverableDB.storage_key).is_not(None),
        )
    ).all()
    # Group by backend so each store is resolved once; reads use the backend
    # recorded on the row so changing the write backend never reinterprets a row.
    by_backend: dict[str, list[AgentTaskDeliverableDB]] = {}
    for row in rows:
        backend = row.storage_backend or "local"
        by_backend.setdefault(backend, []).append(row)

    for backend, group in by_backend.items():
        store = get_store(backend)
        for row in group:
            if row.storage_key is not None:
                await store.delete(row.storage_key)


async def delete_deliverable_objects_for_project(
    session: Session,
    project_id: str,
) -> None:
    """Delete Deliverable stored objects for every run in a project.

    Object cleanup happens while relational
    metadata still exists, so the manifest rows are readable when deciding
    which backend/key to delete. Missing objects are idempotent success
    (the ArtifactStore contract). A non-missing object that cannot be
    deleted raises a retryable 503 BEFORE any row is removed, so cleanup
    can be retried and bytes are never orphaned. The denial body carries
    no object keys or storage paths.
    """
    rows = session.exec(
        select(AgentTaskDeliverableDB).where(
            AgentTaskDeliverableDB.project == project_id,
            as_column(AgentTaskDeliverableDB.storage_key).is_not(None),
        )
    ).all()
    by_backend: dict[str, list[AgentTaskDeliverableDB]] = {}
    for row in rows:
        backend = row.storage_backend or "local"
        by_backend.setdefault(backend, []).append(row)
    for backend, group in by_backend.items():
        store = get_store(backend)
        for row in group:
            if row.storage_key is not None:
                try:
                    await store.delete(row.storage_key)
                except Exception as exc:
                    raise HTTPException(
                        status_code=503,
                        detail=(
                            "artifact storage cleanup failed; "
                            "project data was kept — retry deletion"
                        ),
                    ) from exc


async def cleanup_expired_artifact_uploads(session: Session) -> dict[str, int]:
    """Fail pending uploads past their TTL and remove their staging bytes.

    A pending upload older than ``APO_ARTIFACT_UPLOAD_TTL_SECONDS`` becomes
    ``failed``; its staging object (if any) is removed idempotently. Ready
    objects are never deleted merely because their Task Run is non-terminal —
    errored runs retain successfully uploaded evidence.
    """
    _, _, ttl_seconds = artifact_limits()
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=ttl_seconds)
    pending = session.exec(
        select(AgentTaskDeliverableDB).where(
            AgentTaskDeliverableDB.status == "pending",
            AgentTaskDeliverableDB.created_at < cutoff,
        )
    ).all()
    if not pending:
        return {"failed_uploads": 0}

    by_backend: dict[str, list[AgentTaskDeliverableDB]] = {}
    for row in pending:
        backend = row.storage_backend or "local"
        by_backend.setdefault(backend, []).append(row)

    failed = 0
    for backend, group in by_backend.items():
        store = get_store(backend)
        for row in group:
            # Remove any partial staging bytes idempotently.
            if row.storage_key is not None:
                try:
                    await store.delete(row.storage_key)
                except Exception:  # noqa: BLE001 - retain row, just mark failed
                    logger.warning(
                        "could not remove staging bytes for expired upload %s",
                        row.id,
                        exc_info=True,
                    )
            row.status = "failed"
            row.error_message = "upload expired before completion"
            session.add(row)
            failed += 1
    return {"failed_uploads": failed}


ARTIFACT_ORPHAN_GRACE_HOURS_ENV = "APO_ARTIFACT_ORPHAN_GRACE_HOURS"
DEFAULT_ARTIFACT_ORPHAN_GRACE_HOURS = 48


def artifact_orphan_grace_hours() -> int:
    value = os.environ.get(ARTIFACT_ORPHAN_GRACE_HOURS_ENV, "")
    try:
        hours = int(value)
    except ValueError:
        hours = DEFAULT_ARTIFACT_ORPHAN_GRACE_HOURS
    return max(hours, 0)


async def reap_unreferenced_artifact_objects(session: Session) -> int:
    """Delete artifact-store objects no manifest row references.

    Object deletion is manifest-driven everywhere else, so an object whose
    manifest row was lost (a crash between the store ``put`` and the row
    commit) would live forever. The sweep walks the LOCAL backend's object
    directory and removes entries that are (a) unreferenced by ANY manifest
    row in ANY status — deliverables including pending upload intents, and
    task-revision bundles — and (b) older than the grace window (mtime),
    which covers an in-flight upload between its staging rename and row
    commit. Staging ``*.part`` files are never touched (owned by
    ``cleanup_expired_artifact_uploads``). S3-hosted objects are not walked.
    """
    from .artifact_stores.registry import default_artifact_dir

    objects_dir = default_artifact_dir() / "objects"
    if not objects_dir.is_dir():
        return 0

    referenced: set[str] = set()
    if table_exists(session, "agent_task_deliverables"):
        referenced.update(
            str(row[0])
            for row in cast(
                "list[tuple[object, ...]]",
                session.execute(
                    text(
                        "SELECT storage_key FROM agent_task_deliverables "
                        "WHERE storage_key IS NOT NULL"
                    )
                ).all(),
            )
        )
    # Live result-evidence staging objects are referenced by their staging
    # rows (issue #251); without this the reaper would eat parts older than
    # the grace window while their attempt was still finalizing.
    if table_exists(session, "agent_task_result_evidence"):
        referenced.update(
            str(row[0])
            for row in cast(
                "list[tuple[object, ...]]",
                session.execute(
                    text(
                        "SELECT storage_key FROM agent_task_result_evidence "
                        "WHERE storage_key IS NOT NULL"
                    )
                ).all(),
            )
        )
    if table_exists(session, "task_revisions"):
        referenced.update(
            str(row[0])
            for row in cast(
                "list[tuple[object, ...]]",
                session.execute(
                    text(
                        "SELECT bundle_storage_key FROM task_revisions "
                        "WHERE bundle_storage_key IS NOT NULL"
                    )
                ).all(),
            )
        )

    grace_cutoff = datetime.now(timezone.utc) - timedelta(
        hours=artifact_orphan_grace_hours()
    )
    store = get_store("local")
    deleted = 0
    for shard_dir in sorted(objects_dir.iterdir()):
        if not shard_dir.is_dir():
            continue
        for entry in sorted(shard_dir.iterdir()):
            if not entry.is_file():
                continue
            # Store keys carry their shard segment: ``<shard>/<name>``.
            key = f"{shard_dir.name}/{entry.name}"
            if key in referenced:
                continue
            try:
                mtime = datetime.fromtimestamp(
                    entry.stat().st_mtime, tz=timezone.utc
                )
            except OSError:
                continue
            if mtime >= grace_cutoff:
                continue
            try:
                await store.delete(key)
                if not entry.exists():  # store.delete is idempotent-silent
                    deleted += 1
            except Exception:  # noqa: BLE001 - next pass retries
                logger.warning(
                    "could not reap orphaned artifact object %s",
                    key,
                    exc_info=True,
                )
    return deleted


VACUUM_MIN_FREE_BYTES_ENV = "APO_VACUUM_MIN_FREE_BYTES"
DEFAULT_VACUUM_MIN_FREE_BYTES = 10 * 1024 * 1024


def vacuum_min_free_bytes() -> int:
    value = os.environ.get(VACUUM_MIN_FREE_BYTES_ENV, "")
    try:
        parsed = int(value)
    except ValueError:
        parsed = DEFAULT_VACUUM_MIN_FREE_BYTES
    return max(parsed, 0)


def vacuum_sqlite() -> dict[str, object]:
    """Freelist-gated, cap-safe VACUUM on a dedicated autocommit connection.

    Geometry operators size for: the rebuild writes a full copy of the DB
    through temp storage — up to ~2x the database size in free space on the
    data volume (``SQLITE_TMPDIR`` is pointed there at engine setup) — and
    blocks writers for its whole duration.

    - Gated on ``freelist_pages * page_size >= APO_VACUUM_MIN_FREE_BYTES``
      so quiet days skip it entirely.
    - Runs on a raw ``sqlite3`` connection in autocommit mode: VACUUM cannot
      run inside a transaction.
    - The page cap (applied per-connection by the engine's connect hook)
      is lifted first — to an explicit value well above the current size,
      because ``max_page_count=0`` is NOT unlimited — and restored after,
      with readbacks asserted both ways.
    """
    result: dict[str, object] = {"vacuumed": False}
    if not is_sqlite():
        return result

    with engine.connect() as conn:
        page_size = int(conn.exec_driver_sql("PRAGMA page_size").scalar() or 0)
        freelist = int(conn.exec_driver_sql("PRAGMA freelist_count").scalar() or 0)
    reclaimable = page_size * freelist
    result["reclaimable_bytes"] = reclaimable
    if reclaimable < vacuum_min_free_bytes():
        return result

    import sqlite3

    # The engine URL is the source of truth for the file location (tests
    # and custom deployments point DATABASE_URL elsewhere); None means an
    # in-memory database, which has nothing to reclaim.
    db_path = engine.url.database
    if not db_path:
        return result
    try:
        raw = sqlite3.connect(db_path, timeout=5.0, isolation_level=None)

        def _pragma_int(statement: str) -> int:
            # PRAGMAs return result rows; every statement must be fully
            # consumed and closed before VACUUM runs, or SQLite refuses
            # with "SQL statements in progress".
            cursor = raw.execute(statement)
            rows = cursor.fetchall()
            cursor.close()
            # PRAGMAs return ints (page_count / max_page_count).
            return int(cast("int", rows[0][0])) if rows else 0

        def _run(statement: str) -> None:
            cursor = raw.execute(statement)
            _ = cursor.fetchall()
            cursor.close()

        try:
            try:
                configured_cap = int(os.environ.get("APO_MAX_DB_PAGES", "0"))
            except ValueError:
                configured_cap = 0
            page_count = _pragma_int("PRAGMA page_count")
            # Lift well above the current size (0 is not "unlimited").
            lifted = min(page_count + 131_072, 0x7FFFFFFF)
            applied = _pragma_int(f"PRAGMA max_page_count={lifted}")
            if applied < page_count:
                raise RuntimeError(
                    "could not lift max_page_count above the current size "
                    f"(applied={applied}, page_count={page_count})"
                )
            _run("VACUUM")
            if configured_cap > 0:
                restored = _pragma_int(f"PRAGMA max_page_count={configured_cap}")
                if restored != configured_cap:
                    raise RuntimeError(
                        f"could not restore max_page_count (expected "
                        f"{configured_cap}, got {restored})"
                    )
            result["vacuumed"] = True
        finally:
            raw.close()
    except Exception:
        logger.exception(
            "VACUUM failed — it needs up to ~2x the database size of free "
            "space on the data volume (temp dir: %s). Nothing was lost; the "
            "next maintenance pass retries",
            os.environ.get("SQLITE_TMPDIR", "<default /tmp>"),
        )
    return result


def _run_and_record_maintenance_pass() -> None:
    """One maintenance pass, logged and persisted.

    The pass's summary used to be discarded — an operator could not tell
    whether the loop ever ran. It now lands in the log (INFO, visible via
    the apo logger level set at app construction) and in the one-row
    maintenance_state table surfaced by GET /v1/admin/retention.
    """
    started_at = datetime.now(timezone.utc)
    began = time.monotonic()
    summary = run_maintenance_cleanup()
    duration_ms = int((time.monotonic() - began) * 1000)
    logger.info("Maintenance pass complete in %d ms: %s", duration_ms, summary)
    try:
        with Session(engine) as session:
            row = session.get(MaintenanceStateDB, 1)
            if row is None:
                row = MaintenanceStateDB(id=1)
                session.add(row)
            row.last_started_at = started_at
            row.last_finished_at = datetime.now(timezone.utc)
            row.duration_ms = duration_ms
            row.summary = summary
            session.commit()
    except Exception:
        # Bookkeeping must never kill the hygiene loop.
        logger.exception("Failed to persist maintenance pass state")


def run_maintenance_cleanup() -> dict[str, int]:
    """Run the daily maintenance pass; retention purge only if configured.

    Always-on hygiene: fail stuck non-terminal inbox batches past their
    horizon, blank past-window OTLP ingest payloads, reap old inbox rows,
    fail abandoned artifact uploads, reap expired credential tokens, reap
    unreferenced revision content, and reap orphaned artifact objects.
    When ``APO_RETENTION_DAYS`` is set, also purge old traces/runs/batches
    (bookmark-aware on both sides; the span orphan sweep runs inside that
    window). Returns a per-task summary; the freelist-gated VACUUM runs
    after it.
    """
    summary: dict[str, int] = {}
    now = datetime.now(timezone.utc)

    with Session(engine) as session:
        stuck_days = ingest_stuck_batch_days()
        if stuck_days > 0:
            summary["failed_stuck_batches"] = fail_stuck_ingest_batches(
                session, now - timedelta(days=stuck_days)
            )
        ingest_days = ingest_payload_retention_days()
        if ingest_days > 0:
            summary["trimmed_ingest_payloads"] = trim_old_ingest_payloads(
                session, now - timedelta(days=ingest_days)
            )
        row_days = ingest_batch_row_retention_days()
        if row_days > 0:
            summary["reaped_ingest_batches"] = reap_old_ingest_batch_rows(
                session, now - timedelta(days=row_days)
            )
        summary["failed_uploads"] = asyncio.run(
            cleanup_expired_artifact_uploads(session)
        ).get("failed_uploads", 0)
        if table_exists(session, "agent_task_result_evidence"):
            from apo.services.result_evidence import cleanup_stale_result_evidence

            summary["reaped_result_evidence"] = cleanup_stale_result_evidence(session)
        summary["expired_tokens"] = reap_expired_credentials(session)
        usage_days = usage_retention_days()
        if usage_days > 0:
            cutoff_day = (now - timedelta(days=usage_days)).strftime("%Y-%m-%d")
            summary["reaped_usage_rows"] = reap_old_usage_rows(session, cutoff_day)
        summary["unreferenced_revisions"] = reap_unreferenced_task_definition_revisions(
            session, now - timedelta(days=UNREFERENCED_REVISION_GRACE_DAYS)
        )
        summary["reaped_artifact_orphans"] = asyncio.run(
            reap_unreferenced_artifact_objects(session)
        )
        session.commit()

        evidence_windows = project_evidence_windows(session)
        if evidence_windows:
            summary.update(asyncio.run(expire_run_evidence(session, now)))
            session.commit()

        if RETENTION_DAYS > 0:
            cutoff = now - timedelta(days=RETENTION_DAYS)
            # One bookmark-aware plan drives BOTH object pre-passes and the
            # row deletes: a bookmarked task run keeps its verdict,
            # corrections, deliverable objects AND its batch's revision
            # bundles; deleting bundle objects for a surviving batch would
            # leave dangling manifest rows.
            task_run_ids, deletable_batch_ids = _old_batch_purge_plan(
                session, cutoff
            )
            if task_run_ids:
                asyncio.run(delete_deliverable_objects_for_runs(session, task_run_ids))
                session.commit()
            if deletable_batch_ids:
                from apo.services.task_revisions import delete_task_revision_bundles_for_batches

                _ = asyncio.run(
                    delete_task_revision_bundles_for_batches(
                        session, deletable_batch_ids
                    )
                )
                session.commit()

            summary["runs"] = _delete_old_runs(session, cutoff)
            summary["agent_task_batch_runs"] = _delete_old_batch_runs(
                session, cutoff, plan=(task_run_ids, deletable_batch_ids)
            )
            # Spans of the just-purged traces are now orphans; the sweep
            # also clears strays older than the window from earlier eras.
            summary["otlp_spans"] = delete_orphaned_spans(session, cutoff)
            session.commit()

    summary["total"] = sum(
        count
        for key, count in summary.items()
        if key
        not in (
            "total",
            "failed_uploads",
            "expired_tokens",
            "reaped_artifact_orphans",
            "vacuumed",
        )
    )

    # Summary first, vacuum after — a failed VACUUM must not lose the log
    # of what the pass freed.
    logger.info(
        "maintenance cleanup: %s (retention=%s days, evidence=%s days, ingest payload=%s days)",
        summary,
        RETENTION_DAYS,
        evidence_retention_days(),
        ingest_payload_retention_days(),
    )
    if is_sqlite():
        vacuum_info = vacuum_sqlite()
        summary["vacuumed"] = 1 if vacuum_info.get("vacuumed") else 0
        logger.info("vacuum: %s", vacuum_info)
    return summary


def run_retention_cleanup() -> dict[str, int]:
    """Back-compat alias: the retention-only view of the maintenance pass."""
    return run_maintenance_cleanup()


def get_db_size_info() -> dict[str, object]:
    """Report the current DB footprint. SQLite-only stats are best-effort."""
    info: dict[str, object] = {"dialect": "sqlite" if is_sqlite() else "postgres"}
    if not is_sqlite():
        return info

    sqlite_path = os.path.join(DATA_DIR, SQLITE_FILE_NAME)
    try:
        file_bytes = os.path.getsize(sqlite_path)
    except OSError:
        file_bytes = 0

    with engine.connect() as conn:
        page_size = conn.exec_driver_sql("PRAGMA page_size").scalar() or 0
        page_count = conn.exec_driver_sql("PRAGMA page_count").scalar() or 0
        freelist = conn.exec_driver_sql("PRAGMA freelist_count").scalar() or 0

    info["file_bytes"] = file_bytes
    info["page_size"] = page_size
    info["page_count"] = page_count
    info["freelist_pages"] = freelist
    info["max_page_count"] = MAX_DB_PAGES or None
    return info


def get_db_table_sizes(limit: int = 15) -> dict[str, object]:
    """Per-table on-disk bytes, largest first (SQLite ``dbstat``; best-effort).

    The maintenance story is tiered — verdict rows are tiny and live
    forever, evidence (spans, ingest payloads, transcripts, check reports)
    is most of the bytes — so per-table sizes are what tells an operator
    which knob actually moves their footprint.
    """
    if not is_sqlite():
        return {"tables": {}}
    try:
        with engine.connect() as conn:
            raw = cast(
                "list[tuple[object, ...]]",
                cast(
                    object,
                    conn.exec_driver_sql(
                        "SELECT name, SUM(pgsize) FROM dbstat GROUP BY name "
                        "ORDER BY 2 DESC"
                    ).fetchall(),
                ),
            )
    except Exception:  # noqa: BLE001 - dbstat needs a compile option; optional
        return {"tables": {}}
    tables = {
        str(row[0]): int(cast("int | None", row[1]) or 0)
        for row in raw
        if str(row[0]) not in ("sqlite_master",)
    }
    return {
        "tables": dict(list(tables.items())[:limit]),
        "tables_total_bytes": sum(tables.values()),
    }


# The hard page cap is applied per-connection by the engine's connect hook
# (see ``apo.db``); ``max_page_count`` is a per-connection pragma and this
# engine uses NullPool, so a one-shot startup PRAGMA would cover nothing.
# ``get_db_size_info`` reports the configured value from the env.


# --- Background loop -------------------------------------------------------

import threading  # noqa: E402

# Daily cleanup cadence. Short enough to keep the DB bounded, long enough
# to avoid overlapping VACUUMs.
_RETENTION_INTERVAL_SECONDS = 24 * 60 * 60

_retention_thread: threading.Thread | None = None
_retention_stop = threading.Event()


def start_retention_loop() -> None:
    """Run the maintenance pass once now, then daily, on a daemon thread.

    Always starts: the ingest-payload trim, abandoned-upload cleanup, and
    credential reaping are hygiene every deployment wants, independent of
    whether age-based retention is configured.
    """
    global _retention_thread
    if _retention_thread is not None and _retention_thread.is_alive():
        return

    _retention_stop.clear()

    def _loop() -> None:
        try:
            _run_and_record_maintenance_pass()
        except Exception:
            logger.exception("Initial maintenance cleanup failed")
        while not _retention_stop.wait(_RETENTION_INTERVAL_SECONDS):
            try:
                _run_and_record_maintenance_pass()
            except Exception:
                logger.exception("Maintenance cleanup failed")

    _retention_thread = threading.Thread(
        target=_loop, name="data-maintenance", daemon=True
    )
    _retention_thread.start()
    logger.info(
        "data maintenance loop started (retention=%s days, evidence=%s days, ingest payload=%s days)",
        RETENTION_DAYS,
        evidence_retention_days(),
        ingest_payload_retention_days(),
    )


def stop_retention_loop() -> None:
    _retention_stop.set()
