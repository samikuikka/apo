"""Data retention / size control for the SQLite-backed store.

Two independent mechanisms keep the database from growing without bound:

1. **Time-based retention** (``APO_RETENTION_DAYS``): periodically deletes
   old traces, runs, and agent-task outputs older than the configured
   window, then ``VACUUM``s to reclaim file space. Driven by parent age so
   that child rows (metrics, call spans) are removed before their parents
   and FK constraints stay satisfied. Bookmarked runs are always kept.

2. **Hard size cap** (``APO_MAX_DB_PAGES``): sets SQLite's
   ``PRAGMA max_page_count``. Once the DB file reaches the cap, further
   writes fail with ``SQLITE_FULL`` rather than growing the file. This is a
   blunt safety valve — retention is the graceful path, the cap is the
   last line of defence.

Both default to off (0) so existing deployments are unaffected until an
operator opts in. Non-SQLite backends ignore the size cap (it is a SQLite
pragma) and simply skip the SQLite-specific optimisations.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, cast

from sqlalchemy import bindparam, text
from sqlalchemy.engine import CursorResult
from sqlmodel import Session

from ..db import DATA_DIR, SQLITE_FILE_NAME, engine, _is_sqlite

logger = logging.getLogger(__name__)

# Age-based retention. 0 = disabled (no automatic deletion).
RETENTION_DAYS = int(os.environ.get("APO_RETENTION_DAYS", "0"))

# Hard ceiling on the DB file size expressed in SQLite pages (4 KiB each
# by default). 0 = unlimited. e.g. 65536 pages ~= 256 MiB. SQLite-only.
MAX_DB_PAGES = int(os.environ.get("APO_MAX_DB_PAGES", "0"))


def _table_exists(session: Session, table_name: str) -> bool:
    if _is_sqlite():
        row = session.execute(
            text("SELECT 1 FROM sqlite_master WHERE type='table' AND name=:n"),
            {"n": table_name},
        ).first()
    else:
        row = session.execute(
            text("SELECT 1 FROM information_schema.tables WHERE table_name=:n"),
            {"n": table_name},
        ).first()
    return row is not None


def _delete_old_runs(session: Session, cutoff: datetime) -> int:
    """Delete non-bookmarked runs (and their children) older than ``cutoff``.

    Driven by parent age so children (run_metrics, logged_calls, and the
    call_metrics under those calls) are removed before the parents, keeping
    FK constraints (run_metrics.run_id, call_metrics.call_id) satisfied.
    """
    # Collect the IDs of runs to expire first — children reference these.
    old_run_ids = [
        row[0]
        for row in session.execute(
            text("SELECT id FROM runs WHERE created_at < :c AND bookmarked = 0"),
            {"c": cutoff},
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
    if _table_exists(session, "call_metrics"):
        deleted += _exec_in(
            "DELETE FROM call_metrics WHERE call_id IN "
            "(SELECT id FROM logged_calls WHERE run_id IN :ids)",
            old_run_ids,
        )
    if _table_exists(session, "logged_calls"):
        deleted += _exec_in(
            "DELETE FROM logged_calls WHERE run_id IN :ids", old_run_ids
        )
    if _table_exists(session, "run_metrics"):
        deleted += _exec_in(
            "DELETE FROM run_metrics WHERE run_id IN :ids", old_run_ids
        )
    deleted += _exec_in("DELETE FROM runs WHERE id IN :ids", old_run_ids)
    return deleted


def _delete_old_batch_runs(session: Session, cutoff: datetime) -> int:
    """Delete agent-task batch runs (and their task runs) older than cutoff."""
    old_batch_ids = [
        row[0]
        for row in session.execute(
            text("SELECT id FROM agent_task_batch_runs WHERE created_at < :c"),
            {"c": cutoff},
        ).all()
    ]
    if not old_batch_ids:
        return 0

    def _exec_in(sql: str, ids: list[str]) -> int:
        stmt = text(sql).bindparams(bindparam("ids", expanding=True))
        result = cast(CursorResult[Any], session.execute(stmt, {"ids": ids}))
        return result.rowcount or 0

    deleted = 0
    if _table_exists(session, "agent_task_runs"):
        deleted += _exec_in(
            "DELETE FROM agent_task_runs WHERE batch_run_id IN :ids",
            old_batch_ids,
        )
    deleted += _exec_in(
        "DELETE FROM agent_task_batch_runs WHERE id IN :ids", old_batch_ids
    )
    return deleted


def run_retention_cleanup() -> dict[str, int]:
    """Delete data older than the retention window and reclaim space.

    Returns a per-table deleted-row summary. Safe to call when retention
    is disabled — it then reports zeros without touching the DB.
    """
    if RETENTION_DAYS <= 0:
        return {"runs": 0, "agent_task_batch_runs": 0, "total": 0}

    cutoff = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    summary: dict[str, int] = {}
    with Session(engine) as session:
        summary["runs"] = _delete_old_runs(session, cutoff)
        summary["agent_task_batch_runs"] = _delete_old_batch_runs(session, cutoff)
        session.commit()

    summary["total"] = summary["runs"] + summary["agent_task_batch_runs"]

    # VACUUM reclaims file space after deletes. It must run outside a
    # transaction (its own autocommit connection), so we use the raw
    # engine connection. SQLite-only; a no-op elsewhere.
    if summary["total"] > 0 and _is_sqlite():
        with engine.connect() as conn:
            _ = conn.exec_driver_sql("VACUUM")

    logger.info(
        "retention cleanup: removed %s rows older than %s days",
        summary["total"],
        RETENTION_DAYS,
    )
    return summary


def get_db_size_info() -> dict[str, object]:
    """Report the current DB footprint. SQLite-only stats are best-effort."""
    info: dict[str, object] = {"dialect": "sqlite" if _is_sqlite() else "postgres"}
    if not _is_sqlite():
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


def apply_max_page_count() -> None:
    """Apply the hard size ceiling as a SQLite PRAGMA if configured.

    Called once at startup. ``max_page_count`` persists for the connection
    pool, so setting it via the maintenance connection is sufficient.
    """
    if not _is_sqlite() or MAX_DB_PAGES <= 0:
        return
    with engine.connect() as conn:
        _ = conn.exec_driver_sql(f"PRAGMA max_page_count={int(MAX_DB_PAGES)}")
    logger.info("SQLite max_page_count set to %s", MAX_DB_PAGES)


# --- Background loop -------------------------------------------------------

import threading  # noqa: E402

# Daily cleanup cadence. Short enough to keep the DB bounded, long enough
# to avoid overlapping VACUUMs.
_RETENTION_INTERVAL_SECONDS = 24 * 60 * 60

_retention_thread: threading.Thread | None = None
_retention_stop = threading.Event()


def start_retention_loop() -> None:
    """Run retention cleanup once now, then daily, on a daemon thread.

    No-op (does not start a thread) when retention is disabled, so idle
    deployments pay nothing.
    """
    global _retention_thread
    if RETENTION_DAYS <= 0:
        return
    if _retention_thread is not None and _retention_thread.is_alive():
        return

    _retention_stop.clear()

    def _loop() -> None:
        try:
            _ = run_retention_cleanup()
        except Exception:
            logger.exception("Initial retention cleanup failed")
        while not _retention_stop.wait(_RETENTION_INTERVAL_SECONDS):
            try:
                _ = run_retention_cleanup()
            except Exception:
                logger.exception("Retention cleanup failed")

    _retention_thread = threading.Thread(
        target=_loop, name="data-retention", daemon=True
    )
    _retention_thread.start()
    logger.info(
        "data retention loop started (window=%s days)", RETENTION_DAYS
    )


def stop_retention_loop() -> None:
    _retention_stop.set()
