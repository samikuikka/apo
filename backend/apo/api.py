import os

from dotenv import load_dotenv
_ = load_dotenv()

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from sqlmodel import Session

from .bootstrap import bootstrap_initial_user
from .db import init_db, engine
from .services.agent_task_runner import recover_stuck_runs
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
    agent_task_files,
    agent_task_schedules,
    agent_task_trace_projection,
    models,
    analytics,
    scores,
    annotations,
    otlp_traces,
    langfuse_public,
    run_events,
    webhooks,
    comments,
    public,
    api_keys,
    auth,
    demo,
    projects,
    project_members,
    github,
    system_runtime,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _ = app
    import asyncio
    set_event_loop(asyncio.get_event_loop())
    init_email_service()
    init_db()
    # SPEC-122: ensure the demo project exists at startup so it shows
    # up in project lists and users can browse it read-only, regardless
    # of whether demo *authoring* (seeding task runs) is enabled.
    from .services.demo_workspace import _ensure_demo_project_exists
    _ensure_demo_project_exists()
    with Session(engine) as session:
        bootstrap_initial_user(session)
    recover_stuck_runs()
    from .services.agent_task_scheduler import start_schedule_dispatcher, stop_schedule_dispatcher
    from .services.retention import apply_max_page_count, start_retention_loop, stop_retention_loop
    from .services.trace_ingestion_queue import (
        start_trace_ingestion_worker,
        stop_trace_ingestion_worker,
    )
    apply_max_page_count()
    start_schedule_dispatcher()
    start_retention_loop()
    start_trace_ingestion_worker()
    yield
    await stop_trace_ingestion_worker()
    stop_retention_loop()
    stop_schedule_dispatcher()
    if "sqlite" in str(engine.url):
        with engine.connect() as conn:
            _ = conn.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE);")


def create_app() -> FastAPI:
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
    from .middleware.security_headers import SecurityHeadersMiddleware

    app.add_middleware(AuthMiddleware)
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
    app.include_router(agent_task_files.router)
    app.include_router(agent_task_schedules.router)
    app.include_router(agent_task_trace_projection.router)
    app.include_router(models.router)
    app.include_router(analytics.router)
    app.include_router(scores.router)
    app.include_router(annotations.router)
    app.include_router(otlp_traces.router)
    app.include_router(langfuse_public.router)
    app.include_router(run_events.router)
    app.include_router(webhooks.router)
    app.include_router(comments.router)
    app.include_router(public.router)
    app.include_router(api_keys.router)
    app.include_router(auth.router)
    app.include_router(demo.router)
    app.include_router(projects.router)
    app.include_router(project_members.router)
    app.include_router(github.router)
    app.include_router(system_runtime.router)

    return app


app = create_app()
