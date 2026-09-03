"""Task Catalog service.

Owns validation, canonical digest calculation, and idempotent atomic
replacement of a Project's task catalog. No source files, repository
credentials, or Git operations cross this boundary.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnusedImport=false

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from sqlmodel import Session, select

from ..models.db import ProjectTaskInventoryDB, ProjectTaskSourceDB

_MAX_TASKS = 5000
_MAX_TASK_ID_BYTES = 512
_MAX_NAME_BYTES = 255
_MAX_PATH_BYTES = 1024
_MAX_TAGS = 32
_MAX_TAG_BYTES = 64


def _utf8_bytes(s: str) -> int:
    return len(s.encode("utf-8"))


def _validate_path(value: str, field: str, max_bytes: int, allow_empty: bool = False) -> None:
    if not value:
        if allow_empty:
            return
        raise ValueError(f"{field} must be non-empty")
    if _utf8_bytes(value) > max_bytes:
        raise ValueError(f"{field} exceeds {max_bytes} UTF-8 bytes")
    if value.startswith("/"):
        raise ValueError(f"{field} must be relative (no leading /)")
    if "\\" in value:
        raise ValueError(f"{field} must not contain backslash")
    if "\x00" in value:
        raise ValueError(f"{field} must not contain NUL")
    segments = value.split("/")
    if any(seg in (".", "..") for seg in segments):
        raise ValueError(f"{field} must not contain . or .. segments")


def validate_catalog_request(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate and normalize all tasks. Raises ValueError on any failure."""
    if len(tasks) > _MAX_TASKS:
        raise ValueError(f"At most {_MAX_TASKS} tasks per publication (got {len(tasks)})")

    seen_ids: set[str] = set()
    normalized: list[dict[str, Any]] = []

    for i, task in enumerate(tasks):
        task_id = task.get("task_id", "")
        if not task_id:
            raise ValueError(f"Task {i}: task_id is required")
        if _utf8_bytes(task_id) > _MAX_TASK_ID_BYTES:
            raise ValueError(f"Task {i}: task_id exceeds {_MAX_TASK_ID_BYTES} bytes")
        if task_id in seen_ids:
            raise ValueError(f"Task {i}: duplicate task_id '{task_id}'")
        seen_ids.add(task_id)

        display_name = task.get("display_name", "")
        if not display_name:
            raise ValueError(f"Task {i}: display_name is required")
        if _utf8_bytes(display_name) > _MAX_NAME_BYTES:
            raise ValueError(f"Task {i}: display_name exceeds {_MAX_NAME_BYTES} bytes")

        adapter_name = task.get("adapter_name", "")
        if not adapter_name:
            raise ValueError(f"Task {i}: adapter_name is required")
        if _utf8_bytes(adapter_name) > _MAX_NAME_BYTES:
            raise ValueError(f"Task {i}: adapter_name exceeds {_MAX_NAME_BYTES} bytes")

        task_path = task.get("task_path", "")
        _validate_path(task_path, f"Task {i}: task_path", _MAX_PATH_BYTES)

        folder_path = task.get("folder_path", "")
        _validate_path(folder_path, f"Task {i}: folder_path", _MAX_PATH_BYTES, allow_empty=True)

        # Verify task_id == folder_path + "/" + display_name
        expected_id = f"{folder_path}/{display_name}" if folder_path else display_name
        if task_id != expected_id:
            raise ValueError(f"Task {i}: task_id must equal folder_path/display_name combination")

        tags = task.get("tags", [])
        if len(tags) > _MAX_TAGS:
            raise ValueError(f"Task {i}: at most {_MAX_TAGS} tags")
        seen_tags: set[str] = set()
        for tag in tags:
            if not tag:
                raise ValueError(f"Task {i}: empty tag")
            if _utf8_bytes(tag) > _MAX_TAG_BYTES:
                raise ValueError(f"Task {i}: tag exceeds {_MAX_TAG_BYTES} bytes")
            if tag in seen_tags:
                raise ValueError(f"Task {i}: duplicate tag '{tag}'")
            seen_tags.add(tag)

        normalized.append({
            "task_id": task_id,
            "display_name": display_name,
            "task_path": task_path,
            "folder_path": folder_path,
            "adapter_name": adapter_name,
            "has_checks": bool(task.get("has_checks", False)),
            "tags": sorted(tags),
        })

    normalized.sort(key=lambda t: t["task_id"])
    return normalized


def compute_catalog_digest(normalized_tasks: list[dict[str, Any]]) -> str:
    """Compute the canonical SHA-256 digest of the normalized catalog."""
    doc = {"schema_version": 1, "tasks": normalized_tasks}
    payload = json.dumps(doc, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def publish_catalog(
    session: Session,
    project_id: str,
    normalized_tasks: list[dict[str, Any]],
    user_id: str | None = None,
) -> dict[str, Any]:
    """Atomically replace a Project's task catalog.

    When tasks carry a ``definition`` document (schema v2), the
    canonical source is validated, deduplicated into immutable
    TaskDefinitionRevisionDB rows, and pinned on the inventory pointer.
    The catalog digest commits to the definition digest.
    Returns the TaskCatalog response dict.
    """
    from apo.services.task_definition_revisions import (
        ensure_task_definition_revision,
    )

    # Build the digest projection: for v2 tasks, substitute definition_digest
    # for the source-bearing definition object.
    digest_tasks: list[dict[str, Any]] = []
    for task in normalized_tasks:
        dt = {k: v for k, v in task.items() if k != "definition"}
        definition = task.get("definition")
        if isinstance(definition, dict):
            rev = ensure_task_definition_revision(
                session, project_id=project_id, task_id=task["task_id"], document=definition,
            )
            dt["definition_digest"] = rev.content_sha256
        digest_tasks.append(dt)

    digest = compute_catalog_digest_v2(digest_tasks)
    now = datetime.now(timezone.utc)

    # Check for idempotent re-publish (same digest → no-op)
    existing = session.exec(
        select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == project_id)
    ).first()

    if existing and existing.catalog_digest == digest and existing.source_type == "published":
        return {
            "project": project_id,
            "schema_version": 2,
            "task_count": existing.task_count or len(normalized_tasks),
            "catalog_digest": digest,
            "published_at": existing.published_at.isoformat() if existing.published_at else now.isoformat(),
            "execution_mode": "caller",
        }

    # Upsert catalog status
    if existing is None:
        existing = ProjectTaskSourceDB(
            project=project_id,
            source_type="published",
            status="ready",
        )
        session.add(existing)

    existing.source_type = "published"
    existing.catalog_digest = digest
    existing.task_count = len(normalized_tasks)
    existing.published_at = now
    existing.catalog_schema_version = 2
    if user_id:
        existing.published_by_user_id = user_id
    session.add(existing)
    session.flush()

    # Replace inventory rows
    old_rows = session.exec(
        select(ProjectTaskInventoryDB).where(
            ProjectTaskInventoryDB.task_source_id == existing.id
        )
    ).all()
    for row in old_rows:
        session.delete(row)

    for task in normalized_tasks:
        definition = task.get("definition")
        rev_id: str | None = None
        if isinstance(definition, dict):
            rev = ensure_task_definition_revision(
                session, project_id=project_id, task_id=task["task_id"], document=definition,
            )
            rev_id = rev.id
        inv = ProjectTaskInventoryDB(
            project=project_id,
            task_source_id=existing.id,
            task_id=task["task_id"],
            display_name=task["display_name"],
            adapter_name=task["adapter_name"],
            folder_path=task["folder_path"],
            task_path=task["task_path"],
            has_checks=task["has_checks"],
            source_type="published",
            task_definition_revision_id=rev_id,
        )
        session.add(inv)

    session.commit()
    session.refresh(existing)

    return {
        "project": project_id,
        "schema_version": 2,
        "task_count": len(normalized_tasks),
        "catalog_digest": digest,
        "published_at": now.isoformat(),
        "execution_mode": "caller",
    }


def compute_catalog_digest_v2(digest_tasks: list[dict[str, Any]]) -> str:
    """Compute the canonical SHA-256 digest of the v2 catalog.

    Uses schema_version 2 and includes ``definition_digest`` instead of
    source-bearing ``definition`` objects. Falls back to schema v1 shape
    when no task carries a definition_digest.
    """
    has_definitions = any("definition_digest" in t for t in digest_tasks)
    doc = {
        "schema_version": 2 if has_definitions else 1,
        "tasks": digest_tasks,
    }
    payload = json.dumps(doc, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def get_catalog_status(session: Session, project_id: str) -> dict[str, Any] | None:
    """Return the current TaskCatalog status, or None if unpublished."""
    source = session.exec(
        select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == project_id)
    ).first()

    if source is None:
        return None

    execution_mode = "bundled_demo" if source.source_type == "demo" else "caller"
    return {
        "project": project_id,
        "schema_version": 1,
        "task_count": source.task_count or 0,
        "catalog_digest": source.catalog_digest or "",
        "published_at": source.published_at.isoformat() if source.published_at else None,
        "execution_mode": execution_mode,
    }
