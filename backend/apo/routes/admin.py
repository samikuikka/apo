# pyright: reportCallInDefaultInitializer=false, reportDeprecated=false

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

        from ..db import init_db

        init_db()

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
    """Report DB size and the active retention/size-cap configuration."""
    if not verify_admin(request):
        raise HTTPException(
            status_code=401, detail="Unauthorized: Admin access required"
        )
    from ..services.retention import (
        RETENTION_DAYS,
        MAX_DB_PAGES,
        get_db_size_info,
    )

    return {
        "status": "success",
        "retention_days": RETENTION_DAYS,
        "max_db_pages": MAX_DB_PAGES or None,
        "db": get_db_size_info(),
    }


@router.post("/retention/cleanup")
async def trigger_retention_cleanup(
    request: Request,
    _: object = Depends(require_api_key_scope("full")),
):
    """Run a retention cleanup immediately. Honours APO_RETENTION_DAYS."""
    if not verify_admin(request):
        raise HTTPException(
            status_code=401, detail="Unauthorized: Admin access required"
        )
    from ..services.retention import RETENTION_DAYS, run_retention_cleanup

    if RETENTION_DAYS <= 0:
        raise HTTPException(
            status_code=400,
            detail="Retention is disabled (APO_RETENTION_DAYS=0).",
        )
    summary = run_retention_cleanup()
    return {"status": "success", "deleted": summary}


