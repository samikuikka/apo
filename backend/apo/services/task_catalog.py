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
from .task_definition_revisions import (
    TaskDefinitionValidationError,
    ensure_task_definition_revision,
    validate_task_definition_document,
)

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

        entry: dict[str, Any] = {
            "task_id": task_id,
            "display_name": display_name,
            "task_path": task_path,
            "folder_path": folder_path,
            "adapter_name": adapter_name,
            "has_checks": bool(task.get("has_checks", False)),
            "tags": sorted(tags),
        }
        definition = task.get("definition")
        if definition is not None:
            try:
                entry["definition"] = validate_task_definition_document(
                    definition, task_id=task_id
                )
            except TaskDefinitionValidationError as exc:
                raise ValueError(f"Task {i}: {exc}") from exc
        normalized.append(entry)

    normalized.sort(key=lambda t: t["task_id"])
    return normalized


def compute_catalog_digest(normalized_tasks: list[dict[str, Any]]) -> str:
    """Compute the canonical SHA-256 digest of the normalized catalog.

    Commits to task metadata only, never to ``definition``: it must equal the
    CLI's computeCatalogDigest, which ``apo connect`` reports and claims gate on.

    The canonical form is pinned by tests against the TypeScript twin
    (``packages/cli/src/lib/task-catalog-digest.ts``): tasks sorted by
    ``task_id`` in Unicode code-point order (the sort happens here, so any
    input order digests identically), keys sorted, compact separators, and
    characters serialized raw (``ensure_ascii=False``) so both languages
    hash the same UTF-8 bytes. ASCII-only catalogs digest identically to the
    pre-canonical form; catalogs with non-ASCII or mixed-case ids previously
    mismatched across the two languages (a spurious ``catalog_mismatch``).
    """
    metadata = [{k: v for k, v in t.items() if k != "definition"} for t in normalized_tasks]
    metadata.sort(key=lambda t: t["task_id"])
    doc = {"schema_version": 1, "tasks": metadata}
    payload = json.dumps(
        doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def publish_catalog(
    session: Session,
    project_id: str,
    normalized_tasks: list[dict[str, Any]],
    user_id: str | None = None,
) -> dict[str, Any]:
    """Atomically replace a Project's task catalog.

    When tasks carry a ``definition`` document (schema v2), the
    canonical source is deduplicated into immutable TaskDefinitionRevisionDB
    rows and pinned on the inventory pointer. The catalog digest stays over
    metadata only (see ``compute_catalog_digest``), so a source-only edit
    re-pins revisions without moving the digest executors match on.
    Returns the TaskCatalog response dict.
    """
    revision_ids: dict[str, str | None] = {}
    for task in normalized_tasks:
        definition = task.get("definition")
        revision_ids[task["task_id"]] = (
            ensure_task_definition_revision(
                session, project_id=project_id, task_id=task["task_id"], document=definition,
            ).id
            if isinstance(definition, dict)
            else None
        )

    digest = compute_catalog_digest(normalized_tasks)
    now = datetime.now(timezone.utc)

    existing = session.exec(
        select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == project_id)
    ).first()

    if (
        existing
        and existing.catalog_digest == digest
        and existing.source_type == "published"
        and _pinned_revisions(session, existing.id) == revision_ids
    ):
        # Nothing to replace, but the catalog was just re-asserted: Notes
        # compare this time with the latest Run to pick the current source.
        existing.published_at = now
        if user_id:
            existing.published_by_user_id = user_id
        session.add(existing)
        session.commit()
        return {
            "project": project_id,
            "schema_version": 2,
            "task_count": existing.task_count or len(normalized_tasks),
            "catalog_digest": digest,
            "published_at": now.isoformat(),
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
    removed = {
        row.task_id: row.task_path or ""
        for row in old_rows
        if row.task_id not in {task["task_id"] for task in normalized_tasks}
    }
    for row in old_rows:
        session.delete(row)

    for task in normalized_tasks:
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
            task_definition_revision_id=revision_ids[task["task_id"]],
        )
        session.add(inv)

    session.commit()
    session.refresh(existing)

    affected_schedules: list[dict[str, Any]] = []
    if removed:
        from apo.services.adaptive_scheduler import handle_tasks_removed_from_catalog

        affected_schedules = handle_tasks_removed_from_catalog(
            session, project_id=project_id, removed=removed
        )
        session.commit()

    result: dict[str, Any] = {
        "project": project_id,
        "schema_version": 2,
        "task_count": len(normalized_tasks),
        "catalog_digest": digest,
        "published_at": now.isoformat(),
        "execution_mode": "caller",
    }
    if removed:
        # Publish-time warning (tasks with schedules/history left the
        # catalog) so callers can surface it instead of discovering it as a
        # trigger-time failure later.
        result["removed_tasks"] = sorted(removed)
        result["affected_schedules"] = affected_schedules
    return result


def _pinned_revisions(session: Session, source_id: str | None) -> dict[str, str | None]:
    rows = session.exec(
        select(ProjectTaskInventoryDB).where(ProjectTaskInventoryDB.task_source_id == source_id)
    ).all()
    return {row.task_id: row.task_definition_revision_id for row in rows}


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
