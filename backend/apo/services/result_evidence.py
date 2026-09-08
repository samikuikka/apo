"""Result-evidence staging service (issue #251).

Owns the out-of-band result transport: a document-heavy run whose
legitimate transcript / JSON deliverables / check report cannot fit the
result envelope uploads each as an attempt-scoped part through the
configured ``ArtifactStore`` while the attempt runs, then references the
parts by id from the small ``/result`` body.

The transport is deliberately identity-encoded — one digest over the exact
wire bytes, no compression to assume away for incompressible payloads
(``content_encoding`` exists on the row for a future gzip mode).

Invariants:

- Parts are owned by exactly one Attempt; every read, upload, and
  finalization reference is checked against that attempt. A part from
  another project/run/attempt is simply not found, never applied.
- A part must be ``ready`` (bytes verified by the store) before
  finalization may reference it; finalization re-verifies the logical
  digest of the bytes it reads.
- Staging is transient: successful finalization, failure finalization, run
  deletion, and the maintenance TTL all remove rows and objects. Permanent
  stores (``transcript_json``, deliverable rows, check reports) are the
  only thing that survives.
"""

# pyright: reportAny=false, reportDeprecated=false, reportImplicitStringConcatenation=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedImport=false

from __future__ import annotations

import hashlib
import json
import os
import secrets
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, col, select

from apo.models.db import AgentTaskResultEvidenceDB, TaskExecutionAttemptDB
from apo.services.agent_task_deliverables import (
    validate_deliverable_name,
    validate_sha256_hex,
)
from apo.services.artifact_store import ArtifactStore

SLOTS = frozenset({"transcript", "checks", "deliverable"})

_DEFAULT_MAX_ITEM_BYTES = 100 * 1024 * 1024  # 100 MiB per part
_DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024  # 512 MiB logical per attempt
# How long an unfinalized part may linger before maintenance reaps it.
# Attempts live hours; this bounds abandoned staging, not live uploads.
_DEFAULT_STALE_TTL_SECONDS = 86_400


class ResultEvidenceError(Exception):
    """A typed protocol violation; ``kind`` names the rule that fired."""

    kind: str
    message: str

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(f"{kind}: {message}")
        self.kind = kind
        self.message = message


def result_evidence_limits() -> tuple[int, int]:
    """Return ``(max_item_bytes, max_total_bytes)`` for evidence parts.

    Same validation contract as the artifact limits: invalid, zero, or
    negative values raise rather than silently disabling the bound.
    """

    def _positive(env: str, default: int) -> int:
        raw = os.environ.get(env)
        if raw is None or raw.strip() == "":
            return default
        try:
            value = int(raw)
        except ValueError as exc:
            raise ValueError(f"{env}={raw!r} is not a valid integer") from exc
        if value <= 0:
            raise ValueError(f"{env} must be positive, got {value}")
        return value

    return (
        _positive("APO_RESULT_EVIDENCE_MAX_ITEM_BYTES", _DEFAULT_MAX_ITEM_BYTES),
        _positive("APO_RESULT_EVIDENCE_MAX_TOTAL_BYTES", _DEFAULT_MAX_TOTAL_BYTES),
    )


def stale_evidence_ttl_seconds() -> int:
    raw = os.environ.get("APO_RESULT_EVIDENCE_STALE_TTL_SECONDS", "")
    try:
        value = int(raw) if raw.strip() else _DEFAULT_STALE_TTL_SECONDS
    except ValueError:
        value = _DEFAULT_STALE_TTL_SECONDS
    return max(value, 1)


async def create_result_evidence_intent(
    session: Session,
    store: ArtifactStore,
    *,
    attempt: TaskExecutionAttemptDB,
    slot: str,
    deliverable_name: str | None,
    size_bytes: int,
    sha256: str,
) -> AgentTaskResultEvidenceDB:
    """Open one evidence-part upload, idempotent on matching metadata.

    Raises :class:`ResultEvidenceError` with a route-mappable ``kind`` for
    every rule: non-running attempt, bad slot/name, over-limit size, or a
    same-slot intent with conflicting metadata.
    """
    if slot not in SLOTS:
        raise ResultEvidenceError("bad_slot", f"unknown evidence slot {slot!r}")
    if slot == "deliverable":
        if deliverable_name is None:
            raise ResultEvidenceError(
                "bad_slot", "slot 'deliverable' requires deliverable_name"
            )
        validate_deliverable_name(deliverable_name)
    elif deliverable_name is not None:
        raise ResultEvidenceError(
            "bad_slot", f"slot {slot!r} does not take a deliverable_name"
        )

    validate_sha256_hex(sha256)
    if size_bytes <= 0:
        raise ResultEvidenceError("bad_size", "size_bytes must be positive")

    max_item, max_total = result_evidence_limits()
    if size_bytes > max_item:
        raise ResultEvidenceError(
            "item_too_large", f"evidence part of {size_bytes} bytes exceeds the {max_item} byte per-item limit"
        )

    if attempt.status != "running":
        raise ResultEvidenceError(
            "attempt_not_running",
            f"evidence upload requires a running attempt (status={attempt.status!r})",
        )

    existing = _find_part(session, attempt.id, slot, deliverable_name)
    if existing is not None:
        if (
            existing.size_bytes == size_bytes
            and existing.sha256 == sha256
        ):
            return existing
        raise ResultEvidenceError(
            "slot_conflict",
            "an evidence part for this slot already exists with different metadata",
        )

    _reject_total_overflow(session, attempt.id, size_bytes, max_total)

    row = AgentTaskResultEvidenceDB(
        id=_new_id(),
        project=attempt.project,
        task_run_id=attempt.task_run_id,
        attempt_id=attempt.id,
        slot=slot,
        deliverable_name=deliverable_name,
        status="pending",
        storage_backend=store.name,
        storage_key=None,
        content_encoding="identity",
        size_bytes=size_bytes,
        sha256=sha256,
        stored_size_bytes=None,
        created_at=datetime.now(timezone.utc),
        ready_at=None,
    )
    session.add(row)
    session.flush()
    return row


async def complete_result_evidence_upload(
    session: Session,
    store: ArtifactStore,
    *,
    attempt: TaskExecutionAttemptDB,
    evidence_id: str,
    body_stream: AsyncIterator[bytes],
    declared_size: int | None,
) -> AgentTaskResultEvidenceDB:
    """Stream part bytes into the store, verify, and mark the row ready.

    The store independently counts and hashes; a mismatch leaves the row
    pending and raises (route maps to 422). A re-PUT of a ready row is an
    idempotent success — the freshly written duplicate object is removed.
    """
    row = session.get(AgentTaskResultEvidenceDB, evidence_id)
    if row is None or row.attempt_id != attempt.id:
        raise ResultEvidenceError("not_found", "evidence part not found for this attempt")
    if row.status == "ready":
        return row

    if declared_size is not None and declared_size != row.size_bytes:
        raise ResultEvidenceError(
            "size_mismatch",
            f"Content-Length {declared_size} does not match declared {row.size_bytes}",
        )

    key = _storage_key()
    stored = await store.put(
        key,
        body_stream,
        expected_size=row.size_bytes,
        expected_sha256=row.sha256,
    )

    # A concurrent PUT may have promoted the row while bytes streamed.
    session.refresh(row)
    if row.status == "ready":
        try:
            await store.delete(key)
        except Exception:  # noqa: BLE001 - duplicate bytes are best-effort
            pass
        return row

    row.storage_key = stored.key
    row.storage_backend = stored.backend
    row.stored_size_bytes = stored.size_bytes
    row.status = "ready"
    row.ready_at = datetime.now(timezone.utc)
    session.add(row)
    session.flush()
    return row


@dataclass
class ResolvedEvidence:
    """Finalization inputs read from verified evidence parts."""

    transcript: dict[str, object] | None = None
    checks: list[dict[str, object]] | None = None
    deliverables: dict[str, object] = field(default_factory=dict)
    used_part_ids: list[str] = field(default_factory=list)


async def resolve_result_evidence(
    session: Session,
    *,
    store: ArtifactStore,
    attempt_id: str,
    refs: list[str],
) -> ResolvedEvidence:
    """Resolve ``refs`` into finalization inputs, verifying each part.

    Every part must be owned by ``attempt_id`` and ready; bytes are read
    back through the store and their logical digest re-verified. Raises
    :class:`ResultEvidenceError` on any violation — finalization must not
    apply partially-trusted evidence. JSON parsing of multi-MiB parts runs
    off the event loop so heartbeats stay live during finalization.
    """
    import asyncio

    resolved = ResolvedEvidence()
    seen_parts: set[str] = set()

    for ref in refs:
        if ref in seen_parts:
            raise ResultEvidenceError("duplicate_ref", f"evidence part {ref} referenced twice")
        seen_parts.add(ref)
        row = session.get(AgentTaskResultEvidenceDB, ref)
        if row is None or row.attempt_id != attempt_id:
            # Cross-project/run/attempt references are opaque misses.
            raise ResultEvidenceError("not_found", f"evidence part {ref} not found for this attempt")
        if row.status != "ready":
            raise ResultEvidenceError(
                "not_ready", f"evidence part {ref} ({row.slot}) has no verified bytes"
            )
        if row.storage_key is None or row.storage_backend is None:
            raise ResultEvidenceError(
                "not_ready", f"evidence part {ref} has no stored object"
            )

        raw = b"".join([chunk async for chunk in store.open(row.storage_key)])
        if len(raw) != row.size_bytes or hashlib.sha256(raw).hexdigest() != row.sha256:
            raise ResultEvidenceError(
                "digest_mismatch",
                f"evidence part {ref} bytes no longer match its declared digest",
            )
        try:
            value = await asyncio.to_thread(_parse_json, raw)
        except (ValueError, UnicodeDecodeError) as exc:
            raise ResultEvidenceError(
                "bad_payload", f"evidence part {ref} is not valid JSON: {exc}"
            ) from exc

        if row.slot == "transcript":
            if not isinstance(value, dict):
                raise ResultEvidenceError(
                    "bad_payload", f"evidence part {ref} (transcript) must be a JSON object"
                )
            resolved.transcript = value
        elif row.slot == "checks":
            if not isinstance(value, list):
                raise ResultEvidenceError(
                    "bad_payload", f"evidence part {ref} (checks) must be a JSON array"
                )
            resolved.checks = value
        elif row.slot == "deliverable":
            name = row.deliverable_name
            if name is None:
                raise ResultEvidenceError(
                    "bad_payload", f"evidence part {ref} (deliverable) has no name"
                )
            resolved.deliverables[name] = value
        resolved.used_part_ids.append(row.id)

    return resolved


async def delete_result_evidence(
    session: Session,
    *,
    attempt_id: str | None = None,
    task_run_id: str | None = None,
) -> int:
    """Delete staging rows (and their objects) for an attempt or run.

    Objects go first and idempotently; rows follow in the same session so
    the caller's transaction owns the pair. Never raises for missing
    objects. Returns rows removed.
    """
    from apo.services.artifact_stores.registry import get_store

    query = select(AgentTaskResultEvidenceDB)
    if attempt_id is not None:
        query = query.where(col(AgentTaskResultEvidenceDB.attempt_id) == attempt_id)
    if task_run_id is not None:
        query = query.where(col(AgentTaskResultEvidenceDB.task_run_id) == task_run_id)
    rows = list(session.exec(query).all())
    if not rows:
        return 0

    by_backend: dict[str, list[AgentTaskResultEvidenceDB]] = {}
    for row in rows:
        by_backend.setdefault(row.storage_backend or "local", []).append(row)
    for backend, group in by_backend.items():
        store = get_store(backend)
        for row in group:
            if row.storage_key is not None:
                try:
                    await store.delete(row.storage_key)
                except Exception:  # noqa: BLE001 - row removal must not wedge
                    pass
    for row in rows:
        session.delete(row)
    session.flush()
    return len(rows)


def drop_result_evidence_rows(session: Session, *, attempt_id: str) -> int:
    """Delete staging rows only, synchronously (objects left to the reaper).

    Used from synchronous finalization paths where no event loop is
    available for object deletion: the row delete is what unblocks the
    slot and stops the parts being referenced; the orphan reaper collects
    the bytes afterwards.
    """
    rows = list(
        session.exec(
            select(AgentTaskResultEvidenceDB).where(
                col(AgentTaskResultEvidenceDB.attempt_id) == attempt_id
            )
        ).all()
    )
    for row in rows:
        session.delete(row)
    session.flush()
    return len(rows)


def cleanup_stale_result_evidence(session: Session) -> int:
    """Reap staging rows older than the TTL; returns rows removed.

    A synchronous sweep (object deletion is best-effort here — the orphan
    reaper collects any objects left behind). Live uploads have nothing to
    fear from a 24 h TTL: attempts are hour-scale and finalization removes
    staging immediately.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=stale_evidence_ttl_seconds())
    rows = list(
        session.exec(
            select(AgentTaskResultEvidenceDB).where(
                col(AgentTaskResultEvidenceDB.created_at) < cutoff
            )
        ).all()
    )
    for row in rows:
        session.delete(row)
    session.flush()
    return len(rows)


def _parse_json(raw: bytes) -> object:
    return json.loads(raw.decode("utf-8"))


def _find_part(
    session: Session,
    attempt_id: str,
    slot: str,
    deliverable_name: str | None,
) -> AgentTaskResultEvidenceDB | None:
    query = select(AgentTaskResultEvidenceDB).where(
        col(AgentTaskResultEvidenceDB.attempt_id) == attempt_id,
        col(AgentTaskResultEvidenceDB.slot) == slot,
    )
    if deliverable_name is None:
        query = query.where(col(AgentTaskResultEvidenceDB.deliverable_name).is_(None))
    else:
        query = query.where(col(AgentTaskResultEvidenceDB.deliverable_name) == deliverable_name)
    return session.exec(query).first()


def _reject_total_overflow(
    session: Session, attempt_id: str, incoming_size: int, max_total: int
) -> None:
    rows = session.exec(
        select(col(AgentTaskResultEvidenceDB.size_bytes)).where(
            col(AgentTaskResultEvidenceDB.attempt_id) == attempt_id
        )
    ).all()
    staged = sum(int(r) for r in rows)
    if staged + incoming_size > max_total:
        raise ResultEvidenceError(
            "total_too_large",
            f"evidence parts would exceed the {max_total} byte per-attempt limit",
        )


def _new_id() -> str:
    return "rev_" + secrets.token_hex(12)


def _storage_key() -> str:
    token = secrets.token_hex(16)
    shard = token[:2]
    return f"{shard}/{token}"


__all__ = [
    "ResolvedEvidence",
    "ResultEvidenceError",
    "cleanup_stale_result_evidence",
    "complete_result_evidence_upload",
    "create_result_evidence_intent",
    "delete_result_evidence",
    "drop_result_evidence_rows",
    "resolve_result_evidence",
    "result_evidence_limits",
    "stale_evidence_ttl_seconds",
]
