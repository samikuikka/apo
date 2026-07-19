"""System runtime routes (SPEC-124 / SPEC-125).

Exposes the deployment topology descriptor and the deep readiness probe
that operators (and Compose healthchecks) can rely on beyond the basic
``/health`` liveness probe. SPEC-125 adds the agent-task runtime
availability endpoint.
"""

# pyright: reportCallInDefaultInitializer=false

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from ..auth.deps import require_admin
from ..models.db import UserDB
from ..services.agent_task_runtime import get_task_runtime_status
from ..services.runtime_config import (
    get_runtime_config,
    run_readiness_checks,
)

router = APIRouter()


@router.get("/health/ready")
async def readiness_check() -> JSONResponse:
    """Deep readiness probe used by operators and Compose healthchecks.

    Returns 503 when any operator-relevant prerequisite fails so the
    probe is actually meaningful, not just a liveness signal.
    """
    report = run_readiness_checks()
    payload = report.model_dump()
    status_code = 200 if report.ok else 503
    return JSONResponse(status_code=status_code, content=payload)


@router.get("/v1/system/runtime-config", tags=["system"])
async def get_runtime_config_endpoint(
    _user: UserDB = Depends(require_admin),
):
    """Return the runtime topology descriptor for this instance."""
    return get_runtime_config().model_dump()


@router.get("/v1/system/task-runtime", tags=["system"])
async def get_task_runtime_endpoint(
    _user: UserDB = Depends(require_admin),
):
    """Return the availability status of the packaged agent-task runtime."""
    return get_task_runtime_status().model_dump()
