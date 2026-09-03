"""Task Definition Revision service.

Ensures immutable, deduplicated Task Definition Revisions from publication
and direct CLI runs. Source text is stored as private Project data and is
never executed, transpiled, imported, or validated beyond structural
path/content/size checks.
"""

# pyright: reportAny=false, reportDeprecated=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnnecessaryIsInstance=false, reportUnreachable=false, reportUnusedImport=false, reportUnusedParameter=false

from __future__ import annotations

import hashlib
import json
from typing import Any, cast

from sqlmodel import Session, select

from apo.models.db import (
    AgentTaskRunDB,
    TaskDefinitionRevisionDB,
)

MAX_DEFINITION_BYTES = 1_000_000


class TaskDefinitionValidationError(ValueError):
    """Raised when a Task Definition document fails structural validation."""

    kind: str

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(f"[{kind}] {message}")
        self.kind = kind


def compute_task_definition_digest(document: dict[str, Any]) -> str:
    """Canonical SHA-256 digest of a Task Definition document.

    Matches the CLI's computeTaskDefinitionDigest: compact JSON with sorted
    keys over ``{schema_version, files: [{path, content}]}``.
    """
    payload = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def validate_task_definition_document(
    document: dict[str, Any],
    *,
    task_id: str,
) -> dict[str, Any]:
    """Structurally validate a Task Definition document.

    Returns the normalized document. Raises on invalid structure, path,
    content, or size. Does NOT execute, transpile, or import source.
    """
    if not isinstance(document, dict):
        raise TaskDefinitionValidationError("invalid_task_definition", "document is not an object")
    if document.get("schema_version") != 1:
        raise TaskDefinitionValidationError("invalid_task_definition", "schema_version must be 1")
    files = document.get("files")
    if not isinstance(files, list) or len(files) != 1:
        raise TaskDefinitionValidationError("invalid_task_definition", "exactly one file required")
    file = files[0]
    if not isinstance(file, dict):
        raise TaskDefinitionValidationError("invalid_task_definition", "file entry is not an object")
    path = file.get("path")
    content = file.get("content")
    if not isinstance(path, str) or not path:
        raise TaskDefinitionValidationError("invalid_task_definition", "file path is required")
    if not isinstance(content, str):
        raise TaskDefinitionValidationError("invalid_task_definition", "file content must be a string")
    if "/" in path or "\\" in path:
        raise TaskDefinitionValidationError("invalid_task_definition", f"path must be a basename, got: {path}")
    if "\0" in content:
        raise TaskDefinitionValidationError("invalid_task_definition", "content contains NUL bytes")
    content_bytes = content.encode("utf-8")
    if len(content_bytes) > MAX_DEFINITION_BYTES:
        raise TaskDefinitionValidationError(
            "invalid_task_definition", f"content exceeds {MAX_DEFINITION_BYTES} bytes"
        )
    return document


def ensure_task_definition_revision(
    session: Session,
    *,
    project_id: str,
    task_id: str,
    document: dict[str, Any],
) -> TaskDefinitionRevisionDB:
    """Ensure an immutable Definition Revision exists for the given document.

    Deduplicates by ``(project, task_id, content_sha256)``. If a matching
    row exists, it is reused. Otherwise a new row is created. The source
    text is never mutated after creation.
    """
    validated = validate_task_definition_document(document, task_id=task_id)
    digest = compute_task_definition_digest(validated)

    existing = session.exec(
        select(TaskDefinitionRevisionDB).where(
            TaskDefinitionRevisionDB.project == project_id,
            TaskDefinitionRevisionDB.task_id == task_id,
            TaskDefinitionRevisionDB.content_sha256 == digest,
        )
    ).first()
    if existing is not None:
        return existing

    content = validated["files"][0]["content"]
    size_bytes = len(cast(str, content).encode("utf-8"))

    rev = TaskDefinitionRevisionDB(
        project=project_id,
        task_id=task_id,
        schema_version=1,
        content_sha256=digest,
        source_files_json=cast(list[dict[str, object]], validated["files"]),
        source_size_bytes=size_bytes,
    )
    session.add(rev)
    session.flush()
    return rev


def get_definition_for_run(
    session: Session,
    task_run_id: str,
) -> TaskDefinitionRevisionDB | None:
    """Resolve the pinned Definition Revision for a Task Run."""
    run = session.get(AgentTaskRunDB, task_run_id)
    if run is None or run.task_definition_revision_id is None:
        return None
    return session.get(TaskDefinitionRevisionDB, run.task_definition_revision_id)


def read_definition_source(
    session: Session,
    *,
    task_run_id: str,
    file_path: str,
) -> dict[str, Any] | None:
    """Read one source file from the Run's pinned Definition Revision.

    Returns ``{name, path, content, size_bytes, language, lines}`` or
    ``None`` when the Run, Revision, or file is absent.
    """
    rev = get_definition_for_run(session, task_run_id)
    if rev is None:
        return None
    for file in rev.source_files_json or []:
        if file.get("path") == file_path:
            content = cast(str, file["content"])
            content_bytes = content.encode("utf-8")
            return {
                "name": file_path,
                "path": file_path,
                "content": content,
                "size_bytes": len(content_bytes),
                "language": "typescript",
                "lines": content.count("\n") + 1,
            }
    return None


def to_definition_summary(
    rev: TaskDefinitionRevisionDB,
) -> dict[str, Any]:
    """Build a public-safe summary for the Run detail response."""
    files = []
    for file in rev.source_files_json or []:
        content = cast(str, file.get("content", ""))
        files.append({
            "path": file.get("path", ""),
            "language": "typescript",
            "size_bytes": len(content.encode("utf-8")),
            "lines": content.count("\n") + 1,
        })
    return {
        "id": rev.id,
        "digest": rev.content_sha256,
        "files": files,
        "created_at": rev.created_at.isoformat() if rev.created_at else None,
    }


__all__ = [
    "MAX_DEFINITION_BYTES",
    "TaskDefinitionValidationError",
    "compute_task_definition_digest",
    "ensure_task_definition_revision",
    "get_definition_for_run",
    "read_definition_source",
    "to_definition_summary",
    "validate_task_definition_document",
]
