"""
Agent Task Files API endpoints.

Provides endpoints for browsing and reading task source files
(the ``*.eval.ts`` task file, checks.ts, user-simulator.ts, etc.) from the filesystem.
"""

# pyright: reportCallInDefaultInitializer=false

import os
from pathlib import Path
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlmodel import Session

from ..db import get_session
from ..models.db import ProjectDB
from ..services.agent_task_discovery import discover_agent_task_by_id
from ..services.project_task_inventory import get_inventory_row
from ..services.project_task_source_sync import (
    SyncError,
    resolve_inventory_task_dir,
)
from ..services.project_task_sources import DEMO_PROJECT_ID, get_task_source_db
from ..services.project_memberships import require_project_member

router = APIRouter(prefix="/v1", tags=["agent-tasks"])

MAX_FILE_SIZE = 1_000_000

SKIP_NAMES = {".git", ".DS_Store", "node_modules", "__pycache__"}

EXTENSION_LANGUAGE_MAP: dict[str, str] = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".md": "markdown",
    ".json": "json",
    ".diff": "diff",
    ".patch": "diff",
    ".txt": "text",
    ".css": "css",
    ".html": "html",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".sh": "bash",
    ".sql": "sql",
}


class TaskFileEntry(BaseModel):
    name: str
    path: str
    type: str
    size_bytes: int | None = None
    extension: str | None = None


class TaskFileListResponse(BaseModel):
    task_id: str
    task_path: str
    files: list[TaskFileEntry]


class TaskFileContentResponse(BaseModel):
    name: str
    path: str
    content: str
    size_bytes: int
    language: str
    lines: int


def _detect_language(extension: str) -> str:
    return EXTENSION_LANGUAGE_MAP.get(extension.lower(), "text")


def _get_user_id(request: Request) -> str:
    user_id = cast(str | None, getattr(request.state, "user_id", None))
    if user_id:
        return user_id
    raise HTTPException(status_code=401, detail="Authentication required")


def _load_project_for_request(
    session: Session,
    project_id: str,
    request: Request,
) -> ProjectDB:
    project = session.get(ProjectDB, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if project_id == DEMO_PROJECT_ID:
        return project
    user_id = _get_user_id(request)
    require_project_member(session, project_id, user_id)
    return project


def _list_files_recursive(task_dir: Path) -> list[TaskFileEntry]:
    entries: list[TaskFileEntry] = []
    for root, dirs, files in os.walk(task_dir):
        dirs[:] = sorted(
            d for d in dirs if d not in SKIP_NAMES and not d.startswith(".")
        )

        rel_root = Path(root).relative_to(task_dir)

        for dirname in dirs:
            rel_path = str(rel_root / dirname) if str(rel_root) != "." else dirname
            entries.append(
                TaskFileEntry(
                    name=dirname,
                    path=rel_path,
                    type="directory",
                    size_bytes=None,
                    extension=None,
                )
            )

        for filename in sorted(files):
            if filename.startswith("."):
                continue
            filepath = Path(root) / filename
            rel_path = str(rel_root / filename) if str(rel_root) != "." else filename
            ext = Path(filename).suffix or None
            try:
                size = filepath.stat().st_size
            except OSError:
                size = 0
            entries.append(
                TaskFileEntry(
                    name=filename,
                    path=rel_path,
                    type="file",
                    size_bytes=size,
                    extension=ext,
                )
            )

    return entries


def _build_file_list_response(task_id: str, task_dir: Path, task_path: str) -> TaskFileListResponse:
    entries = _list_files_recursive(task_dir)

    directories = sorted(
        [e for e in entries if e.type == "directory"], key=lambda e: e.path
    )
    files = sorted([e for e in entries if e.type == "file"], key=lambda e: e.path)

    return TaskFileListResponse(
        task_id=task_id,
        task_path=task_path,
        files=directories + files,
    )


def _read_file_response(task_dir: Path, file_path: str) -> TaskFileContentResponse:
    resolved = (task_dir / file_path).resolve()

    if not str(resolved).startswith(str(task_dir)):
        raise HTTPException(status_code=403, detail="Access denied")

    if not resolved.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")

    if resolved.is_dir():
        raise HTTPException(status_code=400, detail="Path is a directory, not a file")

    size = resolved.stat().st_size
    if size > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large to display")

    try:
        content = resolved.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        raise HTTPException(
            status_code=422, detail="Cannot read file: binary or unsupported encoding"
        )

    ext = resolved.suffix
    language = _detect_language(ext)
    lines = content.count("\n") + (0 if content.endswith("\n") else 1) if content else 0

    return TaskFileContentResponse(
        name=resolved.name,
        path=file_path,
        content=content,
        size_bytes=size,
        language=language,
        lines=lines,
    )


@router.get("/agent-tasks/{task_id:path}/files", response_model=TaskFileListResponse)
async def list_task_files(
    task_id: str,
    task_root: str | None = Query(default=None),
    project: str | None = Query(default=None),
) -> TaskFileListResponse:
    """List all files in a task folder recursively."""
    _ = project
    task = discover_agent_task_by_id(task_root, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Task not found: {task_id}")

    task_dir = Path(task.task_path)
    if not task_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Task folder not found: {task_id}")

    return _build_file_list_response(task_id, task_dir, task.task_path)


@router.get(
    "/agent-tasks/{task_id:path}/files/{file_path:path}",
    response_model=TaskFileContentResponse,
)
async def read_task_file(
    task_id: str,
    file_path: str,
    task_root: str | None = Query(default=None),
    project: str | None = Query(default=None),
) -> TaskFileContentResponse:
    """Read a specific file from a task folder."""
    _ = project
    task = discover_agent_task_by_id(task_root, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Task not found: {task_id}")

    task_dir = Path(task.task_path).resolve()
    return _read_file_response(task_dir, file_path)


@router.get(
    "/projects/{project_id}/agent-tasks/{task_id:path}/files",
    response_model=TaskFileListResponse,
)
async def list_project_task_files(
    project_id: str,
    task_id: str,
    request: Request,
    session: Session = Depends(get_session),
    commit_sha: str | None = Query(default=None),
) -> TaskFileListResponse:
    """List files for a project-scoped task from persisted inventory."""
    _ = _load_project_for_request(session, project_id, request)

    source = get_task_source_db(session, project_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Project has no task source configured.")

    row = get_inventory_row(session, project_id, task_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Task not found: {task_id}")

    try:
        task_dir = resolve_inventory_task_dir(
            session,
            source,
            row.task_path,
            resolved_commit_sha=commit_sha or source.last_resolved_commit_sha,
        )
    except SyncError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return _build_file_list_response(task_id, task_dir, row.task_path)


@router.get(
    "/projects/{project_id}/agent-tasks/{task_id:path}/files/{file_path:path}",
    response_model=TaskFileContentResponse,
)
async def read_project_task_file(
    project_id: str,
    task_id: str,
    file_path: str,
    request: Request,
    session: Session = Depends(get_session),
    commit_sha: str | None = Query(default=None),
) -> TaskFileContentResponse:
    """Read one file for a project-scoped task from persisted inventory."""
    _ = _load_project_for_request(session, project_id, request)

    source = get_task_source_db(session, project_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Project has no task source configured.")

    row = get_inventory_row(session, project_id, task_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Task not found: {task_id}")

    try:
        task_dir = resolve_inventory_task_dir(
            session,
            source,
            row.task_path,
            resolved_commit_sha=commit_sha or source.last_resolved_commit_sha,
        )
    except SyncError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return _read_file_response(task_dir, file_path)
