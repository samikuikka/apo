# pyright: reportCallInDefaultInitializer=false, reportDeprecated=false, reportPrivateLocalImportUsage=false

import os

from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, text

from ..auth.deps import require_api_key_scope
from ..db import get_session, DATA_DIR, SQLITE_FILE_NAME

router = APIRouter(prefix="/v1/admin", tags=["admin"])

ADMIN_API_KEY = os.getenv("ADMIN_API_KEY")
type StatsMap = dict[str, int]


def verify_admin(request: Request) -> bool:
    if not ADMIN_API_KEY:
        return False
    provided = request.headers.get("x-admin-key")
    return provided == ADMIN_API_KEY


def _get_all_tables(session: Session) -> list[str]:
    """Get list of all non-system tables."""
    statement = text(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    rows = cast(list[tuple[object]], session.execute(statement).all())
    return [str(row[0]) for row in rows]


def _clear_tables(session: Session, table_names: list[str]):
    """Delete all data from the specified tables."""
    for table in table_names:
        _ = session.execute(text(f"DELETE FROM {table}"))
    session.commit()


@router.post("/reset-db")
async def reset_database(
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Reset the database by deleting all data."""
    if not verify_admin(request):
        raise HTTPException(
            status_code=401, detail="Unauthorized: Admin access required"
        )

    try:
        table_names = _get_all_tables(session)
        _clear_tables(session, table_names)

        return {
            "status": "success",
            "message": f"Database reset complete. Cleared {len(table_names)} tables: {', '.join(table_names)}",
            "tables_cleared": table_names,
        }
    except Exception as e:
        session.rollback()
        raise HTTPException(
            status_code=500, detail=f"Failed to reset database: {str(e)}"
        )


@router.post("/nuke-db")
async def nuke_database(
    request: Request,
    confirm: str | None = None,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
):
    """Completely delete and recreate the database file. Requires 'YES_I_AM_SURE' confirmation."""
    if not verify_admin(request):
        raise HTTPException(
            status_code=401, detail="Unauthorized: Admin access required"
        )

    if confirm != "YES_I_AM_SURE":
        raise HTTPException(
            status_code=400, detail="Must confirm with 'YES_I_AM_SURE' to nuke database"
        )

    try:
        session.close()
        db_path = os.path.join(DATA_DIR, SQLITE_FILE_NAME)

        if os.path.exists(db_path):
            os.remove(db_path)

        import asyncio

        from ..db import init_db

        # Off the loop — ``init_db`` runs the migration ladder, and the v26
        # backfill drives an async helper with ``asyncio.run``, which cannot
        # start a loop inside this handler's running one.
        await asyncio.to_thread(init_db)

        return {
            "status": "success",
            "message": "Database completely nuked and recreated",
            "db_path": db_path,
        }
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to nuke database: {str(e)}"
        )


@router.get("/stats")
async def get_db_stats(
    request: Request,
    session: Session = Depends(get_session),
    _: object = Depends(require_api_key_scope("full")),
) -> dict[str, str | int | StatsMap]:
    """Get database statistics for admin monitoring."""
    if not verify_admin(request):
        raise HTTPException(
            status_code=401, detail="Unauthorized: Admin access required"
        )

    try:
        table_names = _get_all_tables(session)

        stats: StatsMap = {}
        for table in table_names:
            count_row = cast(
                tuple[object, ...],
                cast(object, session.execute(text(f"SELECT COUNT(*) FROM {table}")).one()),
            )
            count_value = count_row[0]
            if not isinstance(count_value, int):
                count_value = int(str(count_value))
            stats[table] = count_value

        return {"status": "success", "stats": stats, "total_tables": len(table_names)}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to get database stats: {str(e)}"
        )


@router.get("/retention")
async def get_retention_info(
    request: Request,
    _: object = Depends(require_api_key_scope("full")),
):
    """Report DB size, per-table bytes, and the active retention policy."""
    if not verify_admin(request):
        raise HTTPException(
            status_code=401, detail="Unauthorized: Admin access required"
        )
    from ..services.retention import (
        MAX_DB_PAGES,
        RETENTION_DAYS,
        evidence_retention_days,
        get_db_size_info,
        get_db_table_sizes,
        ingest_batch_row_retention_days,
        ingest_payload_retention_days,
        ingest_stuck_batch_days,
    )
    from ..services.trace_ingestion_queue import queue_depth_report

    return {
        "status": "success",
        "retention_days": RETENTION_DAYS,
        "evidence_retention_days": evidence_retention_days(),
        "ingest_payload_retention_days": ingest_payload_retention_days(),
        "ingest_batch_row_retention_days": ingest_batch_row_retention_days(),
        "ingest_stuck_batch_days": ingest_stuck_batch_days(),
        "max_db_pages": MAX_DB_PAGES or None,
        "db": get_db_size_info(),
        "table_sizes": get_db_table_sizes(),
        "ingestion_queue": queue_depth_report(),
    }


@router.get("/retention/preview")
async def preview_retention_effects(
    request: Request,
    _: object = Depends(require_api_key_scope("full")),
):
    """Dry run of evidence expiry: what the next pass would delete, per project.

    The safety check before enabling or tightening a window — run this
    first, confirm the run list is what you expect, then let maintenance
    act. Deletes nothing.
    """
    if not verify_admin(request):
        raise HTTPException(
            status_code=401, detail="Unauthorized: Admin access required"
        )
    from datetime import datetime, timezone

    from ..db import engine
    from ..services.retention import preview_run_evidence_expiry

    with Session(engine) as session:
        return {
            "status": "success",
            "preview": preview_run_evidence_expiry(
                session, datetime.now(timezone.utc)
            ),
        }


@router.post("/retention/cleanup")
async def trigger_retention_cleanup(
    request: Request,
    _: object = Depends(require_api_key_scope("full")),
):
    """Run the maintenance cleanup immediately.

    Always-on hygiene runs (ingest payload trim, abandoned uploads,
    expired credentials); the age-based purge only runs when
    ``APO_RETENTION_DAYS`` is configured.
    """
    if not verify_admin(request):
        raise HTTPException(
            status_code=401, detail="Unauthorized: Admin access required"
        )
    from ..services.retention import run_maintenance_cleanup

    summary = run_maintenance_cleanup()
    return {"status": "success", "deleted": summary}


# ---------------------------------------------------------------------------
# re-pricing (CLI-driven history rewrite)
# ---------------------------------------------------------------------------
#
# ``POST /v1/admin/reprice`` kicks off a background reprice job and returns a
# job id immediately; ``GET /v1/admin/reprice/{job_id}`` polls status. The CLI
# uses the existing kick-off-then-poll pattern (see task-run.ts) to avoid the
# 15s HTTP timeout. Job state is in-memory: re-running is idempotent, so a
# process death mid-job just means re-running the command.

import threading
import uuid

from pydantic import BaseModel

_reprice_jobs: dict[str, dict[str, object]] = {}


class RepriceRequest(BaseModel):
    project: str | None = None
    model_id: int | None = None
    since: str | None = None
    until: str | None = None
    dry_run: bool = False


@router.post("/reprice")
async def start_reprice(
    request: Request,
    body: RepriceRequest,
    _: object = Depends(require_api_key_scope("full")),
) -> dict[str, str]:
    """Kick off a reprice job. Returns ``{job_id}`` immediately."""
    if not verify_admin(request):
        raise HTTPException(status_code=401, detail="Unauthorized: Admin access required")

    job_id = uuid.uuid4().hex[:12]
    _reprice_jobs[job_id] = {"status": "running", "summary": None, "error": None}

    thread = threading.Thread(
        target=_run_reprice_job,
        args=(job_id, body),
        daemon=True,
        name=f"reprice-{job_id}",
    )
    thread.start()
    return {"job_id": job_id}


def _run_reprice_job(job_id: str, req: RepriceRequest) -> None:
    from datetime import datetime as _dt

    from sqlmodel import Session

    from ..db import engine
    from ..services.reprice import reprice_calls

    try:
        since = _dt.fromisoformat(req.since) if req.since else None
        until = _dt.fromisoformat(req.until) if req.until else None
        with Session(engine) as session:
            summary = reprice_calls(
                session,
                project=req.project,
                model_id=req.model_id,
                since=since,
                until=until,
                dry_run=req.dry_run,
            )
        _reprice_jobs[job_id] = {"status": "done", "summary": summary, "error": None}
    except Exception as exc:  # noqa: BLE001 - report any failure to the poller
        _reprice_jobs[job_id] = {"status": "error", "summary": None, "error": str(exc)}


@router.get("/reprice/{job_id}")
async def get_reprice_status(
    job_id: str,
    request: Request,
    _: object = Depends(require_api_key_scope("full")),
) -> dict[str, object]:
    """Poll a reprice job's status."""
    if not verify_admin(request):
        raise HTTPException(status_code=401, detail="Unauthorized: Admin access required")
    if job_id not in _reprice_jobs:
        raise HTTPException(status_code=404, detail="unknown reprice job")
    return {"job_id": job_id, **_reprice_jobs[job_id]}


# ---------------------------------------------------------------------------
# projection preview backfill (storage single-homing Stage 2a)
#
# ``POST /v1/admin/projection/backfill`` re-projects traces whose runs have
# no stored previews yet (dual/slim mode), one commit per trace — idempotent
# and resumable, so a process death mid-job just means re-running. Trace lists
# are always preview-only; missing previews stay empty until this job fills them.
# ---------------------------------------------------------------------------

_projection_jobs: dict[str, dict[str, object]] = {}


class ProjectionBackfillRequest(BaseModel):
    project: str | None = None
    limit: int = 500


@router.post("/projection/backfill")
async def start_projection_backfill(
    request: Request,
    body: ProjectionBackfillRequest,
    _: object = Depends(require_api_key_scope("full")),
) -> dict[str, str]:
    """Kick off the preview backfill. Requires dual or slim write mode."""
    if not verify_admin(request):
        raise HTTPException(status_code=401, detail="Unauthorized: Admin access required")
    from ..services.projection_io import projection_write_mode

    if projection_write_mode() == "fat":
        raise HTTPException(
            status_code=400,
            detail=(
                "APO_PROJECTION_WRITE_MODE is 'fat' — previews are only "
                "written in dual or slim mode"
            ),
        )
    job_id = uuid.uuid4().hex[:12]
    _projection_jobs[job_id] = {
        "status": "running",
        "processed": 0,
        "skipped": 0,
        "errors": [],
    }
    thread = threading.Thread(
        target=_run_projection_backfill,
        args=(job_id, body.project, body.limit),
        daemon=True,
        name=f"projection-backfill-{job_id}",
    )
    thread.start()
    return {"job_id": job_id}


def _run_projection_backfill(
    job_id: str, project: str | None, limit: int
) -> None:
    """Worker: reproject traces lacking previews, updating job progress.

    Selection: never-previewed runs (both slots and pointers empty —
    fat-era rows), plus paired-era rows where a preview string lost its
    source pointer to the v40 drop (string ⇒ pointer is the write-path
    invariant, so its violation marks a row the new per-slot logic has
    not healed yet). Healed rows stop matching — the job drains.
    """
    from sqlalchemy import and_ as sql_and
    from sqlmodel import Session, col, or_, select

    from ..db import engine
    from ..models.db import RunDB
    from ..services.reproject import reproject_trace

    job = _projection_jobs[job_id]
    try:
        with Session(engine) as session:
            query = (
                select(RunDB.id, RunDB.project)
                .where(
                    or_(
                        sql_and(
                            col(RunDB.input_preview).is_(None),
                            col(RunDB.output_preview).is_(None),
                            col(RunDB.input_preview_call_row_id).is_(None),
                            col(RunDB.output_preview_call_row_id).is_(None),
                        ),
                        sql_and(
                            col(RunDB.input_preview).is_not(None),
                            col(RunDB.input_preview_call_row_id).is_(None),
                        ),
                        sql_and(
                            col(RunDB.output_preview).is_not(None),
                            col(RunDB.output_preview_call_row_id).is_(None),
                        ),
                    )
                )
                .limit(limit)
            )
            if project is not None:
                query = query.where(RunDB.project == project)
            rows = session.exec(query).all()
        for trace_id, trace_project in rows:
            try:
                projected = reproject_trace(str(trace_id), str(trace_project))
            except Exception as exc:  # noqa: BLE001 - keep the job running
                errors = cast("list[str]", job["errors"])
                errors.append(f"{trace_id}: {exc}")
                continue
            if projected > 0:
                job["processed"] = cast("int", job["processed"]) + 1
            else:
                job["skipped"] = cast("int", job["skipped"]) + 1
        job["status"] = "done"
    except Exception as exc:  # noqa: BLE001 - report any failure to the poller
        job["status"] = "error"
        job["error"] = str(exc)


@router.get("/projection/backfill/{job_id}")
async def get_projection_backfill_status(
    job_id: str,
    request: Request,
    _: object = Depends(require_api_key_scope("full")),
) -> dict[str, object]:
    """Poll a projection backfill job's status."""
    if not verify_admin(request):
        raise HTTPException(status_code=401, detail="Unauthorized: Admin access required")
    if job_id not in _projection_jobs:
        raise HTTPException(status_code=404, detail="unknown projection backfill job")
    return {"job_id": job_id, **_projection_jobs[job_id]}
