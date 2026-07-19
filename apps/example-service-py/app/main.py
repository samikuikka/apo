"""FastAPI app for the Python example service.

Two routes:
  - ``GET /``            → landing text (mirrors the TS example-service page)
  - ``POST /api/agent/chat`` → runs the agentic loop and returns ChatResponse
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import JSONResponse

# Load env + set up OpenTelemetry BEFORE importing agent, so the OpenAI SDK
# is instrumented before any client is constructed.
load_dotenv()
from . import otel as _otel  # noqa: E402

_otel.setup_otel()

from .agent import handle_chat  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("example_service_py")


@asynccontextmanager
async def lifespan(_: FastAPI):
    logger.info("example-service-py starting on :3002")
    yield
    logger.info("example-service-py shutting down")


app = FastAPI(title="apo example service (Python)", lifespan=lifespan)


@app.get("/")
def root() -> dict[str, str]:
    return {"status": "ok", "service": "example-service-py", "port": "3002"}


@app.post("/api/agent/chat")
async def chat(request: dict[str, Any]) -> JSONResponse:
    try:
        result = handle_chat(request)
        return JSONResponse(result)
    except Exception as exc:  # noqa: BLE001
        message = str(exc) or exc.__class__.__name__
        logger.exception("chat failed")
        return JSONResponse({"error": message}, status_code=500)
