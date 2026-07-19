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

    handle = configure_apo_telemetry(take_ownership=True)
    handle.instrument_openai()
    logger.info("OpenTelemetry configured via apo-otel")
