"""Route modules grouped by domain for the FastAPI backend."""

from ..routes import (
    health,
    runs,
    admin,
    trace_stream,
    agent_task_runs,
    agent_task_files,
    agent_task_schedules,
    models,
    comments,
    api_keys,
    auth,
    projects,
    project_members,
    system_runtime,
)

__all__ = [
    "health",
    "runs",
    "admin",
    "trace_stream",
    "agent_task_runs",
    "agent_task_files",
    "agent_task_schedules",
    "models",
    "comments",
    "api_keys",
    "auth",
    "projects",
    "project_members",
    "system_runtime",
]
