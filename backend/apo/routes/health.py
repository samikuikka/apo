from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlmodel import Session, select

from ..db import engine
from ..models.db import UserDB

router = APIRouter()


@router.get("/hello")
async def read_root():
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
