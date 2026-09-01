# pyright: reportUnusedCallResult=false

import os

from dotenv import load_dotenv
_ = load_dotenv()

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from sqlmodel import Session

from .bootstrap import bootstrap_initial_user
from .db import init_db, engine
from .services.email import init_email_service
from .services.run_events import set_event_loop
from .routes import (
    health,
    dev_signin,
    ingestion,
    runs,
    admin,
    metrics_analytics,
    trace_stream,
    agent_task_runs,
    agent_task_deliverables,
    agent_task_judgments,
    agent_task_test_result_corrections,
    agent_task_files,
    agent_task_schedules,
    agent_task_trace_projection,
    agent_task_views,
    models,
    analytics,
    scores,
    annotations,
    otlp_traces,
    langfuse_public,
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
    hosted_access,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _ = app
    import asyncio
    set_event_loop(asyncio.get_event_loop())
    init_email_service()
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
    from .services.agent_task_scheduler import start_schedule_dispatcher, stop_schedule_dispatcher
    from .services.retention import start_retention_loop, stop_retention_loop
    from .services.trace_ingestion_queue import (
        start_trace_ingestion_worker,
        stop_trace_ingestion_worker,
    )
    from .services.execution_leases import start_lease_reaper, stop_lease_reaper
    start_schedule_dispatcher()
    start_retention_loop()
    start_trace_ingestion_worker()
    start_lease_reaper()
    yield
    await stop_lease_reaper()
    await stop_trace_ingestion_worker()
    stop_retention_loop()
    stop_schedule_dispatcher()
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

    # validate transport limits at app construction (not lazily).
    transport_limits = load_telemetry_transport_limits()

    # validate admission limits and construct the controller.
    admission_limits = load_telemetry_admission_limits()
    admission_controller = TelemetryAdmissionController(admission_limits)
    app.state.admission_controller = admission_controller
    app.state.admission_limits = admission_limits

    # public readiness probe on app.state.
    from .services.public_readiness import PublicReadinessProbe
    app.state.public_readiness_probe = PublicReadinessProbe()

    # Middleware execution order (outer → inner):
    #   SecurityHeaders → RequestSize → Auth → TelemetryAdmission → CORS → router
    # Starlette's add_middleware is last-added-outermost, so TelemetryAdmission
    # is added AFTER Auth here to run INSIDE it — admission identities are
    # derived from request.state that Auth populates. (Previously the
    # order was inverted and every authenticated sender bucketed as
    # "open-dev" in the rate limiter.)
    app.add_middleware(TelemetryAdmissionMiddleware, controller=admission_controller)
    app.add_middleware(AuthMiddleware)
    app.add_middleware(RequestSizeMiddleware, otlp_limits=transport_limits)
    app.add_middleware(SecurityHeadersMiddleware)

    app.include_router(health.router)
    app.include_router(ingestion.router)
    app.include_router(runs.facets_router)
    app.include_router(runs.sessions_router)
    app.include_router(runs.router)
    app.include_router(runs.navigation_router)
    app.include_router(admin.router)
    app.include_router(metrics_analytics.router)
    app.include_router(trace_stream.router)
    app.include_router(agent_task_runs.router)
    app.include_router(agent_task_deliverables.router)
    app.include_router(agent_task_judgments.router)
    app.include_router(agent_task_test_result_corrections.router)
    app.include_router(agent_task_files.router)
    app.include_router(agent_task_schedules.router)
    app.include_router(agent_task_trace_projection.router)
    app.include_router(agent_task_views.router)
    app.include_router(project_model_prefs.router)
    from .routes import task_definition_sources
    app.include_router(task_definition_sources.router)
    app.include_router(models.router)
    app.include_router(analytics.router)
    app.include_router(scores.router)
    app.include_router(annotations.router)
    app.include_router(otlp_traces.router)
    app.include_router(langfuse_public.router)
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
    app.include_router(executor_pools.router)
    app.include_router(hosted_access.router)

    from fastapi import Request
    from fastapi.responses import JSONResponse
    from sqlalchemy.exc import OperationalError

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


app = create_app()
