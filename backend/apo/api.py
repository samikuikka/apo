# pyright: reportUnusedCallResult=false

import os

from dotenv import load_dotenv
_ = load_dotenv()

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware

from sqlmodel import Session

from .bootstrap import bootstrap_initial_user
from .db import init_db, engine, is_sqlite
from .services.email import init_email_service
from .services.run_events import set_event_loop
from .routes import (
    health,
    dev_signin,
    ingestion,
    runs,
    admin,
    trace_stream,
    agent_task_runs,
    agent_task_deliverables,
    agent_task_judgments,
    agent_task_test_result_corrections,
    agent_task_notes,
    agent_task_files,
    agent_task_schedules,
    agent_task_trace_projection,
    agent_task_views,
    models,
    scores,
    otlp_traces,
    run_events,
    webhooks,
    comments,
    api_keys,
    auth,
    projects,
    project_members,
    project_model_prefs,
    system_runtime,
    executor_protocol,
    executor_protocol_v2,
    executor_pools,
    executor_result_evidence,
    automations,
    hosted_access,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _ = app
    import asyncio
    set_event_loop(asyncio.get_event_loop())
    init_email_service()
    # self_serve promises delivery by email only, so a transport must be
    # there before anything can be requested; refusing here is the loud
    # boot-time failure instead of a 503 per request.
    from .services.email import get_email_service
    from .services.signup_config import (
        load_signup_config,
        validate_self_serve_delivery,
    )

    validate_self_serve_delivery(
        load_signup_config(), email_configured=get_email_service().is_configured
    )
    # Off the loop: the v26 deliverables backfill drives an async placement
    # helper with ``asyncio.run``, which refuses to start a loop when one is
    # already running in this thread. Calling it inline here crashed startup
    # ("asyncio.run() cannot be called from a running event loop") on every
    # database upgrading through v26 with legacy blobs.
    await asyncio.to_thread(init_db)
    # retire bundled execution before any scheduler/reaper/demo
    # startup. Fence legacy state and purge Bundle objects idempotently.
    with Session(engine) as session:
        from .services.execution_retirement import (
            purge_legacy_bundle_objects,
            retire_legacy_execution_rows,
        )
        from datetime import datetime, timezone

        retire_legacy_execution_rows(session, now=datetime.now(timezone.utc))
        await purge_legacy_bundle_objects(session)
    # Demo workspace: ensure the project row (kill-switch
    # gated), then reconcile its data to the shipped fixture. Synchronous
    # OTLP replay — must complete before the ingestion worker starts.
    from .services.demo_workspace import ensure_demo_project_exists
    if ensure_demo_project_exists():
        from .services.demo_fixture import load_demo_fixture
        with Session(engine) as demo_session:
            load_demo_fixture(demo_session)
    with Session(engine) as session:
        bootstrap_initial_user(session)
    # Orphaned pending automation deliveries are marked error, never retried.
    from .services.automations import recover_stale_automations

    with Session(engine) as session:
        recover_stale_automations(session)
    from .services.agent_task_scheduler import start_schedule_dispatcher, stop_schedule_dispatcher
    from .services.retention import start_retention_loop, stop_retention_loop
    from .services.trace_ingestion_queue import (
        start_trace_ingestion_worker,
        stop_trace_ingestion_worker,
    )
    from .services.execution_leases import start_lease_reaper, stop_lease_reaper
    from .services.automation_window_evaluator import (
        start_window_evaluator,
        stop_window_evaluator,
    )
    start_schedule_dispatcher()
    start_retention_loop()
    start_trace_ingestion_worker()
    start_lease_reaper()
    start_window_evaluator()
    yield
    await stop_lease_reaper()
    await stop_trace_ingestion_worker()
    await stop_window_evaluator()
    stop_retention_loop()
    stop_schedule_dispatcher()
    from .services.automations import stop_automation_deliveries

    await stop_automation_deliveries()
    if "sqlite" in str(engine.url):
        with engine.connect() as conn:
            _ = conn.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE);")


def create_app() -> FastAPI:
    # validate installation configuration before constructing
    # anything. Release profiles fail fast on missing/weak secrets.
    from .services.installation_secrets import (
        load_installation_config,
        validate_installation_secrets,
    )

    config = load_installation_config()
    validate_installation_secrets(config)

    # disable framework docs in the Server Profile.
    if config.deployment_profile == "server":
        app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    else:
        app = FastAPI(lifespan=lifespan)

    frontend_url = os.environ.get("FRONTEND_URL", "http://localhost:3000")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[frontend_url],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    from .auth.middleware import AuthMiddleware
    from .middleware.request_size import RequestSizeMiddleware
    from .middleware.security_headers import SecurityHeadersMiddleware
    from .middleware.telemetry_admission import TelemetryAdmissionMiddleware
    from .services.telemetry_admission import TelemetryAdmissionController
    from .services.telemetry_limits import (
        load_telemetry_admission_limits,
        load_telemetry_transport_limits,
    )

    # The daily maintenance loop logs its pass summaries at INFO; the root
    # logger stays at WARNING by default, so apo's own INFO lines would be
    # invisible without this (issue #231's "log-invisible maintenance").
    # A level alone is not enough: with no handler configured anywhere,
    # Python's last-resort handler only emits WARNING+, so documented
    # log-based flows (reading the password-reset link from
    # `docker compose logs backend`) printed nothing. Attach a real
    # handler unless one is already configured (e.g. by a test runner).
    import logging
    import sys

    level_name = os.environ.get("LOG_LEVEL", "info").strip().upper() or "INFO"
    level = logging.getLevelName(level_name)
    apo_logger = logging.getLogger("apo")
    apo_logger.setLevel(level if isinstance(level, int) else logging.INFO)
    if not logging.getLogger().handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(
            logging.Formatter("%(levelname)s:     %(name)s - %(message)s")
        )
        apo_logger.addHandler(handler)

    # Uvicorn configures its loggers before it imports the app, so the
    # filter added here survives; invitation tokens in query strings must
    # not reach the access log.
    from .services.access_log import install_access_log_redaction

    install_access_log_redaction()

    # validate transport limits at app construction (not lazily).
    transport_limits = load_telemetry_transport_limits()

    # validate per-route write-body limits the same way.
    from .services.request_body_limits import load_request_body_limits

    body_limits = load_request_body_limits()
    # Fail fast on invalid evidence-limit env values too, same eager
    # contract as the transport caps (issue #251).
    from .services.result_evidence import result_evidence_limits

    result_evidence_limits()
    # Export render budgets share the write caps' fail-fast contract: an
    # invalid value must stop startup, not 500 on the first export request.
    from .services.export_budget import load_export_byte_limits

    load_export_byte_limits()
    # An unknown signup mode or a bad self-serve limit must stop startup:
    # a typo here would otherwise decide who can create an account.
    from .services.signup_config import load_signup_config

    load_signup_config()
    # Same contract for the live-stream bounds: the stream cap and the
    # subscriber queue budgets are read lazily (first stream, first
    # broadcaster), so an invalid value must stop startup here instead.
    from .services.sse_limits import load_sse_limits

    load_sse_limits()
    # Creation-cap defaults share the same fail-fast contract: an invalid
    # value must stop startup, not 500 on the first key or project create.
    from .services.user_quotas import load_default_creation_caps

    load_default_creation_caps()
    # The SQLite page-cache budget is read per connection, so an invalid
    # value must stop startup here, not 500 on the first database session.
    if is_sqlite():
        from .db import sqlite_cache_size_kib

        sqlite_cache_size_kib()

    # validate admission limits and construct the controller.
    admission_limits = load_telemetry_admission_limits()
    admission_controller = TelemetryAdmissionController(admission_limits)
    app.state.admission_controller = admission_controller
    app.state.admission_limits = admission_limits

    # public readiness probe on app.state.
    from .services.public_readiness import PublicReadinessProbe
    app.state.public_readiness_probe = PublicReadinessProbe()

    # Middleware execution order (outer → inner):
    #   SecurityHeaders → RequestSize → Auth → RequestBudget →
    #   TelemetryAdmission → ReadThrottle → CORS → router
    # Starlette's add_middleware is last-added-outermost, so RequestBudget,
    # TelemetryAdmission and ReadThrottle are added AFTER Auth here to run
    # INSIDE it: their identities are derived from request.state that Auth
    # populates. (Previously the order was inverted and every authenticated
    # sender bucketed as "open-dev" in the rate limiter.)
    from .middleware.read_throttle import ReadThrottle, ReadThrottleMiddleware

    app.add_middleware(ReadThrottleMiddleware, throttle=ReadThrottle())
    app.add_middleware(TelemetryAdmissionMiddleware, controller=admission_controller)

    # Aggregate request budget: the two limiters above cap specific heavy
    # reads and telemetry writes, but nothing bounded total request rate
    # until this global-plus-per-identity backstop. Own controller so
    # budget charges never drain the telemetry admission buckets. The
    # middleware also owns the per-address window for public-path
    # traffic, so it is wired whenever any of the three dimensions is live.
    from dataclasses import replace

    from .middleware.request_budget import (
        RequestBudgetMiddleware,
        load_request_budget_limits,
    )

    request_budget_limits = load_request_budget_limits()
    if (
        request_budget_limits.identity is not None
        or request_budget_limits.global_requests is not None
        or request_budget_limits.public_path_per_ip is not None
    ):
        telemetry_defaults = load_telemetry_admission_limits()
        # A disabled dimension keeps the telemetry default because the
        # budget middleware never consults that field of the controller.
        budget_admission_limits = replace(
            telemetry_defaults,
            requests=(
                request_budget_limits.identity
                if request_budget_limits.identity is not None
                else telemetry_defaults.requests
            ),
            global_requests=(
                request_budget_limits.global_requests
                if request_budget_limits.global_requests is not None
                else telemetry_defaults.global_requests
            ),
        )
        app.add_middleware(
            RequestBudgetMiddleware,
            controller=TelemetryAdmissionController(budget_admission_limits),
            limits=request_budget_limits,
        )

    app.add_middleware(AuthMiddleware)
    app.add_middleware(
        RequestSizeMiddleware, otlp_limits=transport_limits, body_limits=body_limits
    )
    app.add_middleware(SecurityHeadersMiddleware)

    app.include_router(health.router)
    app.include_router(ingestion.router)
    app.include_router(runs.facets_router)
    app.include_router(runs.sessions_router)
    app.include_router(runs.router)
    app.include_router(runs.navigation_router)
    app.include_router(admin.router)
    app.include_router(trace_stream.router)
    app.include_router(agent_task_runs.router)
    app.include_router(agent_task_deliverables.router)
    app.include_router(agent_task_judgments.router)
    app.include_router(agent_task_test_result_corrections.router)
    app.include_router(agent_task_notes.router)
    app.include_router(agent_task_files.router)
    app.include_router(agent_task_schedules.router)
    app.include_router(agent_task_trace_projection.router)
    app.include_router(agent_task_views.router)
    app.include_router(project_model_prefs.router)
    from .routes import task_definition_sources
    app.include_router(task_definition_sources.router)
    app.include_router(models.router)
    app.include_router(scores.router)
    app.include_router(otlp_traces.router)
    app.include_router(run_events.router)
    app.include_router(webhooks.router)
    app.include_router(comments.router)
    app.include_router(api_keys.router)
    app.include_router(auth.router)
    app.include_router(dev_signin.router)
    app.include_router(projects.router)
    app.include_router(project_members.router)
    app.include_router(system_runtime.router)
    app.include_router(executor_protocol.router)
    app.include_router(executor_protocol_v2.router)
    app.include_router(executor_result_evidence.router)
    app.include_router(executor_pools.router)
    app.include_router(automations.router)
    app.include_router(hosted_access.router)

    from fastapi import Request
    from fastapi.responses import JSONResponse
    from sqlalchemy.exc import OperationalError

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        """Answer 422 with details that cannot crash on hostile input.

        FastAPI's default handler echoes the raw input value back into
        the error details. Re-encoding that echo is what breaks: deep
        nesting overflows the encoder (RecursionError), lone surrogates
        fail UTF-8 (UnicodeEncodeError), Infinity fails JSON compliance
        (ValueError). All three surfaced as 500s on public auth routes
        under malformed-input fuzzing. The safe shape carries the
        structured fields (loc, msg, type, primitive ctx) and never the
        raw input.
        """
        _ = request
        return JSONResponse(
            status_code=422,
            content={"detail": _safe_validation_errors(exc)},
        )

    @app.exception_handler(UnicodeEncodeError)
    async def unencodable_text_handler(
        request: Request, exc: UnicodeEncodeError
    ) -> JSONResponse:
        """A value that cannot be encoded (typically a lone surrogate
        from a JSON string literal) fails when SQLite binds the
        parameter. Reject the request at the boundary with 422 instead
        of letting the binding error surface as a 500 mid-write."""
        _ = request, exc
        return JSONResponse(
            status_code=422,
            content={
                "detail": (
                    "Request text cannot be stored: it contains "
                    "characters outside encodable Unicode"
                )
            },
        )

    @app.exception_handler(OperationalError)
    async def db_full_handler(request: Request, exc: OperationalError) -> JSONResponse:
        """SQLITE_FULL (APO_MAX_DB_PAGES hit or disk full) must read as a
        storage-policy problem, not a generic 500 — tell the operator which
        knob fixes it. Any other OperationalError passes through as 500."""
        message = str(getattr(exc, "orig", exc))
        if "database or disk is full" not in message.lower():
            return JSONResponse(status_code=500, content={"detail": "database error"})
        return JSONResponse(
            status_code=503,
            content={
                "detail": (
                    "storage is full — the database cannot accept writes. "
                    "Raise APO_MAX_DB_PAGES (or free disk), or bound growth via "
                    "APO_EVIDENCE_RETENTION_DAYS / APO_RETENTION_DAYS and run "
                    "the maintenance cleanup."
                )
            },
        )

    return app


def _safe_validation_errors(exc: RequestValidationError) -> list[dict[str, object]]:
    """Structured validation errors without the raw input echo.

    Every field kept here is generated by pydantic (loc parts, message,
    error type) or constrained to a short primitive, so serializing the
    list can never raise on the attacker-controlled input.
    """
    import math

    safe: list[dict[str, object]] = []
    for err in exc.errors()[:20]:
        entry: dict[str, object] = {
            "loc": [str(part) for part in err.get("loc", ())],
            "msg": str(err.get("msg", ""))[:300],
            "type": str(err.get("type", "")),
        }
        ctx: dict[str, object] = {}
        for key, value in (err.get("ctx") or {}).items():
            if isinstance(value, bool) or isinstance(value, int):
                ctx[key] = value
            elif isinstance(value, float) and math.isfinite(value):
                ctx[key] = value
            elif isinstance(value, str) and len(value) <= 64:
                ctx[key] = value
        if ctx:
            entry["ctx"] = ctx
        safe.append(entry)
    return safe


app = create_app()
