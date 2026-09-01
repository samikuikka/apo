"""OpenTelemetry setup for the example service.

Now uses ``apo-otel`` (packages/apo-otel-python) — the official OpenTelemetry
SDK configured to export to apo's OTLP endpoint. No custom JSON exporter.

Import this module once at app startup (``app/main.py`` does it) BEFORE any
OpenAI client is constructed, so the instrumentor can patch the SDK.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("example_service_py.otel")


def setup_otel() -> None:
    """Configure OpenTelemetry via apo-otel and instrument the OpenAI SDK.

    Idempotent: safe to call multiple times. Reads all config from env vars
    (APO_OTLP_ENDPOINT, APO_PROJECT, APO_PUBLIC_KEY, APO_SECRET_KEY, etc.).
    """
    try:
        from apo_otel import configure_apo_telemetry
    except ImportError:
        logger.warning(
            "apo-otel not installed; tracing disabled. "
            "Install with: cd packages/apo-otel-python && uv sync"
        )
        return

    import os

    handle = configure_apo_telemetry(
        take_ownership=True,
        # configure_apo_telemetry does not read APO_SERVICE_NAME itself
        # (its resolver only takes the kwarg) — pass the documented env
        # through so the Service column reflects the real service.
        service_name=os.getenv("APO_SERVICE_NAME", "example-service-py"),
    )
    handle.instrument_openai()
    logger.info("OpenTelemetry configured via apo-otel")


def instrument_http(app: object) -> None:
    """Auto-instrument the FastAPI app — every HTTP request becomes a span.

    This is the plain-service half of the demo: no agent, no task run, just
    request traces with framework attributes (http.request.method,
    url.path, http.response.status_code) exported to apo like any company
    service.
    """
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    except ImportError:
        logger.warning(
            "opentelemetry-instrumentation-fastapi not installed; "
            "HTTP request tracing disabled"
        )
        return
    FastAPIInstrumentor.instrument_app(app)  # pyright: ignore[reportUnknownMemberType]
    logger.info("FastAPI HTTP tracing enabled")
