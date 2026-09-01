# pyright: reportAny=false

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlmodel import Session, select

from ..db import engine
from ..models.db import UserDB

router = APIRouter()


@router.get("/hello")
async def read_root():
    """Unauthenticated liveness ping."""
    return {"message": "Hello from apo backend"}


@router.get("/health")
async def health_check():
    """Liveness + readiness probe. Verifies DB connectivity."""
    try:
        with Session(engine) as session:
            _ = session.exec(select(UserDB).limit(1)).first()
    except Exception:
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy"},
        )
    return {"status": "ok"}


@router.get("/api/public/health")
async def public_readiness(request: Request):
    """Detail-free public readiness status.

    Returns only ``{"status":"ready"}`` (200) or ``{"status":"not_ready"}``
    (503). Never includes check names, paths, or exception detail.
    """
    from ..services.public_readiness import PublicReadinessProbe

    probe = getattr(request.app.state, "public_readiness_probe", None)
    if probe is None:
        probe = PublicReadinessProbe()
    ready = await probe.is_ready()
    return JSONResponse(
        content={"status": "ready" if ready else "not_ready"},
        status_code=200 if ready else 503,
        headers={"Cache-Control": "no-store"},
    )
