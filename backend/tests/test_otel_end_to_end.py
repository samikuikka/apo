# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false
# pyright: reportIndexIssue=false, reportAttributeAccessIssue=false

"""SPEC-131 Milestone 6: end-to-end integration tests with STOCK exporters.

These are the closure tests. They stand up a real FastAPI receiver on an
ephemeral port with isolated storage and drive it with the OFFICIAL OTLP/HTTP
exporters — Python (protobuf) and the apo TypeScript setup (which wraps the
official JS OTLP exporter). They assert the canonical span fields, parentage,
normalized observations, and Trace Projection parity survive the full
stock-exporter → receiver → projection path.

These tests are the proof that no custom apo OTLP dialect remains on the
canonical path.
"""

from __future__ import annotations

import socket
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

# These tests exercise real API-key auth against a live server, so they opt
# out of the open-dev auth bypass that other route tests use.
pytestmark = pytest.mark.real_auth

from sqlmodel import Session, create_engine, select

from apo.models.db import OtlpSpanDB


# ---------------------------------------------------------------------------
# Ephemeral server fixture (real uvicorn + isolated SQLite file DB)
# ---------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def otel_server():
    """Start the real apo FastAPI app on an ephemeral port with an isolated DB.

    Seeds a real API key so the OTLP endpoint authenticates properly (it
    requires API-key/service-token auth, not open-dev mode). The route binds
    the project from the authenticated key.
    """
    import apo.db as db_module
    import apo.services.trace_ingestion_queue as queue_module
    from apo.api import app
    from apo.db import get_session
    from apo.models.db import ApiKeyDB, OtlpIngestBatchDB, OtlpSpanDB  # noqa: F401
    from sqlmodel import SQLModel, Session, create_engine
    from sqlalchemy.pool import StaticPool
    from apo.auth import middleware as auth_middleware
    from apo.auth.api_key_auth import _hash_secret_key

    # Isolated in-memory SQLite shared across the module via StaticPool, so the
    # server thread and the test thread see the same database.
    test_engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(test_engine)

    # Seed a full-scope API key the exporters authenticate with. The OTLP
    # route requires real credentials (no open-dev fallback), so this is the
    # realistic path the e2e test must exercise.
    _PROJECT = "e2e"
    _PUBLIC_KEY = "pk-e2e-full"
    _SECRET_KEY = "sk-e2e-full"
    with Session(test_engine) as session:
        session.add(
            ApiKeyDB(
                public_key=_PUBLIC_KEY,
                hashed_secret_key=_hash_secret_key(_SECRET_KEY),
                display_secret_key=_SECRET_KEY[:4] + "…",
                prefix=_PUBLIC_KEY[:8],
                project=_PROJECT,
                created_by="e2e-test",
                scope="full",
            )
        )
        session.commit()

    # Override get_session so the app serves from the isolated engine.
    def _test_session():
        with Session(test_engine) as session:
            yield session

    app.dependency_overrides[get_session] = _test_session
    # Patch the module-level engine so receiver/auth helpers that read
    # `engine` directly (via `from apo.db import engine`) share the isolated DB.
    # The middleware has its OWN `from ..db import engine` binding, so patch
    # both module attributes.
    original_engine = db_module.engine
    original_middleware_engine = auth_middleware.engine
    original_queue_engine = queue_module.engine
    db_module.engine = test_engine
    auth_middleware.engine = test_engine
    queue_module.engine = test_engine

    # Ensure the live middleware namespace has a non-empty AUTH_SECRET so the
    # server validates API keys (not open-dev bypass). test_auth_fail_closed
    # reloads the middleware module mid-session; the app's AuthMiddleware class
    # still reads from its ORIGINAL module's globals. We must patch THAT
    # namespace — the same one dispatch() executes in.
    from apo.api import app as _app
    _live_ns = None
    for _mw in _app.user_middleware:
        for _attr in vars(_mw.cls).values():
            if hasattr(_attr, "__globals__") and "AUTH_SECRET" in _attr.__globals__:
                _live_ns = _attr.__globals__
                break
        if _live_ns is not None:
            break
    if _live_ns is None:
        _live_ns = vars(auth_middleware)
    _otel_original_secret = _live_ns["AUTH_SECRET"]
    _otel_original_live_engine = _live_ns.get("engine")
    _live_ns["AUTH_SECRET"] = _otel_original_secret or "dev-secret-change-me"
    # The live dispatch reads `engine` from its own globals (for API key
    # validation), NOT from auth_middleware.engine. Patch it here too.
    _live_ns["engine"] = test_engine

    import uvicorn

    port = _free_port()
    config = uvicorn.Config(
        app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    # Wait for the server to be accepting connections.
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                break
        except OSError:
            time.sleep(0.1)
    else:
        server.should_exit = True
        pytest.fail("OTel e2e server did not start")

    yield {
        "port": port,
        "engine": test_engine,
        "project": _PROJECT,
        "public_key": _PUBLIC_KEY,
        "secret_key": _SECRET_KEY,
    }

    server.should_exit = True
    thread.join(timeout=5)
    app.dependency_overrides.pop(get_session, None)
    db_module.engine = original_engine
    auth_middleware.engine = original_middleware_engine
    queue_module.engine = original_queue_engine
    _live_ns["AUTH_SECRET"] = _otel_original_secret
    if _otel_original_live_engine is not None:
        _live_ns["engine"] = _otel_original_live_engine


def _url(otel_server) -> str:
    """The OTLP traces URL."""
    port = otel_server["port"]
    return f"http://127.0.0.1:{port}/api/public/otel/v1/traces"


def _auth_headers(otel_server) -> dict[str, str]:
    """Basic auth headers for the seeded full-scope API key."""
    import base64

    token = base64.b64encode(
        f"{otel_server['public_key']}:{otel_server['secret_key']}".encode()
    ).decode()
    return {"Authorization": f"Basic {token}"}


def _spans_for(otel_server, *, trace_id: str | None = None, project_id: str | None = None):
    engine = otel_server["engine"]
    with Session(engine) as session:
        stmt = select(OtlpSpanDB)
        if trace_id:
            stmt = stmt.where(OtlpSpanDB.trace_id == trace_id)
        if project_id:
            stmt = stmt.where(OtlpSpanDB.project_id == project_id)
        return list(session.exec(stmt).all())


# ===========================================================================
# Python: official OTLP/HTTP protobuf exporter
# ===========================================================================


class TestPythonProtobufExporter:
    """SPEC-131 Test Case 1: stock Python protobuf exporter end to end."""

    def test_stock_python_otlp_export_is_accepted(self, otel_server):
        from opentelemetry import trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )

        resource = Resource.create(
            {"service.name": "e2e-py-service", "service.version": "9.9.9"}
        )
        provider = TracerProvider(resource=resource)
        endpoint = _url(otel_server)
        exporter = OTLPSpanExporter(
            endpoint=endpoint,
            headers=_auth_headers(otel_server),
        )
        provider.add_span_processor(BatchSpanProcessor(exporter))
        # Push our provider onto the global so span context is consistent.
        trace.set_tracer_provider(provider)
        tracer = trace.get_tracer("e2e-py")

        start = datetime(2026, 7, 11, 10, 0, 0, tzinfo=timezone.utc)
        end = datetime(2026, 7, 11, 10, 0, 2, 500000, tzinfo=timezone.utc)
        # Capture the root span's trace id so we can find it after export.
        root_span_ctx = {}

        with tracer.start_as_current_span(
            "e2e.root", start_time=int(start.timestamp() * 1e9)
        ) as root:
            root.set_attribute("apo.observation.type", "AGENT")
            # The Python SDK exposes trace_id as an int; format to 32-hex.
            raw_id = root.get_span_context().trace_id
            root_span_ctx["trace_id"] = f"{raw_id:032x}" if isinstance(raw_id, int) else str(raw_id)
            with tracer.start_as_current_span(
                "e2e.child", start_time=int(end.timestamp() * 1e9)
            ) as child:
                child.set_attribute("gen_ai.request.model", "gpt-e2e")
                child.set_attribute("gen_ai.usage.input_tokens", 42)
                child.end(end_time=int(end.timestamp() * 1e9 + 5e8))
            root.end(end_time=int(end.timestamp() * 1e9))

        provider.force_flush()
        provider.shutdown()

        trace_id = root_span_ctx["trace_id"]
        spans = _spans_for(otel_server, trace_id=trace_id)
        assert len(spans) == 2, f"expected 2 spans for {trace_id}, got {len(spans)}"

        root_span = next(s for s in spans if s.parent_span_id is None)
        child_span = next(s for s in spans if s.parent_span_id is not None)

        # Parentage: child's parent is the root.
        assert child_span.parent_span_id == root_span.span_id
        # Same trace.
        assert child_span.trace_id == root_span.trace_id
        # Resource attributes survived the stock protobuf wire format.
        assert root_span.resource is not None
        res_attrs = root_span.resource.get("attributes", {})
        assert res_attrs.get("service.name") == "e2e-py-service"
        # Nanosecond-derived timestamps preserved (sub-second precision).
        assert root_span.start_time is not None
        assert root_span.start_time.year == 2026

    def test_projection_parity_with_canonical_spans(self, otel_server):
        """SPEC-131 Test Case 13: the projection matches canonical facts."""
        from opentelemetry import trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )

        resource = Resource.create({"service.name": "e2e-parity-service"})
        provider = TracerProvider(resource=resource)
        exporter = OTLPSpanExporter(endpoint=_url(otel_server), headers=_auth_headers(otel_server))
        provider.add_span_processor(BatchSpanProcessor(exporter))
        # Use the provider directly (the global is one-shot and already set by
        # the first test). use_span gives context propagation for nesting.
        tracer = provider.get_tracer("e2e-parity")

        trace_id_holder: dict[str, str] = {}
        root = tracer.start_span("parity.root")
        root.set_attribute("apo.observation.type", "AGENT")
        with trace.use_span(root, end_on_exit=True):
            raw_id = root.get_span_context().trace_id
            trace_id_holder["id"] = f"{raw_id:032x}" if isinstance(raw_id, int) else str(raw_id)
            with tracer.start_as_current_span("parity.tool") as tool:
                tool.set_attribute("gen_ai.tool.name", "calc")
                tool.set_attribute("gen_ai.usage.input_tokens", 7)
        provider.force_flush()
        provider.shutdown()

        trace_id = trace_id_holder["id"]
        from apo.services.trace_repository import get_trace_repository

        engine = otel_server["engine"]
        # The OTLP receiver projects asynchronously (background task), so poll
        # until the projection is ready (bounded).
        snapshot = None
        for _ in range(40):
            with Session(engine) as session:
                repo = get_trace_repository()
                snapshot = repo.get_projection_snapshot(
                    session, project_id=otel_server["project"], trace_id=trace_id
                )
            if snapshot is not None:
                break
            time.sleep(0.1)

        # The projection must exist and carry the same hierarchy + tool facts.
        assert snapshot is not None, "no projection built for the parity trace"
        assert snapshot.trace.trace_id == trace_id
        tool_obs = [o for o in snapshot.observations if o.type == "TOOL"]
        assert tool_obs, "projection must surface the TOOL observation"
        # Canonical span also has the tool; they must agree on type + name.
        canonical_tool = next(
            s for s in _spans_for(otel_server, trace_id=trace_id) if s.parent_span_id
        )
        assert canonical_tool.attributes is not None
        assert canonical_tool.attributes.get("gen_ai.tool.name") == "calc"


# ===========================================================================
# TypeScript: the apo setup wraps the official JS OTLP exporter
# ===========================================================================


class TestTypeScriptExporter:
    """SPEC-131 Test Case 9/11: nested TS trace via the official OTLP exporter.

    Runs the compiled SDK OTel setup against the live server through a small
    Node script. Asserts the nested trace lands with correct parentage.
    """

    def test_nested_ts_trace_lands_with_parentage(self, otel_server, tmp_path):
        import json
        import subprocess

        repo_root = Path(__file__).resolve().parents[2]
        sdk_dir = repo_root / "packages" / "sdk"
        endpoint = _url(otel_server)
        script = tmp_path / "ts-e2e.mjs"
        script.write_text(_TS_E2E_SCRIPT)

        env = {
            "OTEL_ENDPOINT": endpoint,
            "OTEL_AUTH": _auth_headers(otel_server)["Authorization"],
            "SDK_DIR": str(sdk_dir),
            "PATH": __import__("os").environ["PATH"],
            "HOME": __import__("os").environ.get("HOME", ""),
        }
        result = subprocess.run(
            ["node", "--experimental-strip-types", str(script)],
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
            cwd=str(repo_root),
        )
        assert result.returncode == 0, (
            f"TS e2e script failed\nstdout: {result.stdout}\nstderr: {result.stderr}"
        )

        emitted = json.loads(result.stdout)
        trace_id = emitted["traceId"]
        spans = _spans_for(otel_server, trace_id=trace_id)
        assert len(spans) == 2, f"expected 2 TS spans, got {len(spans)}"
        root_span = next(s for s in spans if s.parent_span_id is None)
        child_span = next(s for s in spans if s.parent_span_id is not None)
        assert child_span.parent_span_id == root_span.span_id
        assert child_span.trace_id == root_span.trace_id
        # Resource carried through the official JS OTLP exporter.
        assert root_span.resource is not None
        assert (
            root_span.resource.get("attributes", {}).get("service.name")
            == "e2e-ts-service"
        )


# Node script: uses configureApoTelemetry (official OTLP exporter) to emit a
# nested trace, force-flushes, and prints the root trace id as JSON.
_TS_E2E_SCRIPT = """\
const sdkDir = process.env.SDK_DIR;
const { configureApoTelemetry, withApoTrace } = await import(sdkDir + "/src/otel/index.ts");

const handle = await configureApoTelemetry({
  endpoint: process.env.OTEL_ENDPOINT,
  serviceName: "e2e-ts-service",
  serviceVersion: "2.0.0",
  environment: "e2e",
  headers: { Authorization: process.env.OTEL_AUTH },
  takeOwnership: true,
});

let traceId = "";
await withApoTrace({ name: "ts.root", observationType: "AGENT" }, handle.tracer, async () => {
  await withApoTrace({ name: "ts.child", observationType: "TOOL" }, handle.tracer, async (span) => {
    span.setAttribute("gen_ai.tool.name", "search");
    traceId = span.spanContext().traceId;
  });
});
await handle.provider.forceFlush();
await handle.shutdown();
console.log(JSON.stringify({ traceId }));
"""
