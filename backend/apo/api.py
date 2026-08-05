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
    ingestion,
    runs,
    admin,
    metrics_analytics,
    trace_stream,
    agent_task_runs,
    agent_task_deliverables,
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
    demo,
    projects,
    project_members,
    system_runtime,
    executor_protocol,
    executor_protocol_v2,
    executor_pools,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _ = app
    import asyncio
    set_event_loop(asyncio.get_event_loop())
    init_email_service()
    init_db()
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
    # ensure the demo project exists at startup so it shows
    # up in project lists and users can browse it read-only.
    from .services.demo_workspace import _ensure_demo_project_exists  # pyright: ignore[reportPrivateUsage]
    _ensure_demo_project_exists()
    with Session(engine) as session:
        bootstrap_initial_user(session)
    from .services.agent_task_scheduler import start_schedule_dispatcher, stop_schedule_dispatcher
    from .services.retention import apply_max_page_count, start_retention_loop, stop_retention_loop
    from .services.trace_ingestion_queue import (
        start_trace_ingestion_worker,
        stop_trace_ingestion_worker,
    )
    from .services.execution_leases import start_lease_reaper, stop_lease_reaper
    apply_max_page_count()
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
    #   SecurityHeaders → Auth → TelemetryAdmission → RequestSize → CORS → router
    app.add_middleware(AuthMiddleware)
    app.add_middleware(TelemetryAdmissionMiddleware, controller=admission_controller)
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
    app.include_router(agent_task_files.router)
    app.include_router(agent_task_schedules.router)
    app.include_router(agent_task_trace_projection.router)
    app.include_router(agent_task_views.router)
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
    app.include_router(demo.router)
    app.include_router(projects.router)
    app.include_router(project_members.router)
    app.include_router(system_runtime.router)
    app.include_router(executor_protocol.router)
    app.include_router(executor_protocol_v2.router)
    app.include_router(executor_pools.router)

    return app


app = create_app()
