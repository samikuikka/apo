"""Demo workspace API endpoints."""

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session

from ..db import get_session
from ..services.demo_workspace import (
    DEMO_PROJECT_ID,
    is_demo_read_only,
    is_demo_seeded,
    seed_demo_workspace,
    reset_demo_schedules,
)

router = APIRouter(prefix="/v1/demo", tags=["demo"])


@router.get("/status")
async def demo_status(session: Session = Depends(get_session)):
    """Check if the demo workspace is seeded and ready."""
    seeded = is_demo_seeded(session)
    return {
        "enabled": True,
        "project_id": DEMO_PROJECT_ID,
        "seeded": seeded,
        "read_only": is_demo_read_only(),
    }


@router.post("/seed")
async def seed_demo(
    force: bool = Query(False, description="Re-seed by clearing existing demo data"),
    session: Session = Depends(get_session),
):
    """Seed the demo workspace with real task data. Idempotent unless force=True."""
    reset_demo_schedules(session)
    batch_id = seed_demo_workspace(force=force)
    return {
        "ok": True,
        "project_id": DEMO_PROJECT_ID,
        "batch_run_id": batch_id,
        "already_seeded": batch_id is None,
        "force": force,
    }
