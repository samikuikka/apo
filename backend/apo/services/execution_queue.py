"""Execution queue — Batch + Task Run + Attempt creation.

- ephemeral caller Executor.
- server-initiated runs become durable
  queued Attempts on a Project Pool. The Control Plane never executes customer
  code; it returns immediately after the Revision/Bundle and Attempts are
  durable, and an Executor claims later.
"""

from __future__ import annotations

import secrets
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from apo.db_helpers import as_column
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ExecutorPoolDB,
    ProjectDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    TaskExecutionAttemptDB,
)
from apo.models.execution import (
    CallerIdentity,
    CallerSourceAttestation,
    CallerTaskDescriptor,
)
from apo.services.executor_auth import (
    ATTEMPT_LEASE_SECONDS,
    DEFAULT_QUEUE_TTL_SECONDS,
    create_attempt_jwt,
)
from apo.services.task_revisions import create_attested_task_revision

_CALLER_LEASE_JWT_TTL_SECONDS = 2 * 60 * 60  # covers max task timeout + finalization grace


class CallerExecutionError(ValueError):
    """Raised on invalid caller create-and-claim input."""


@dataclass(frozen=True)
class CallerClaimResult:
    batch: AgentTaskBatchRunDB
    task_run: AgentTaskRunDB
    attempt: TaskExecutionAttemptDB
    attempt_jwt: str


def create_caller_batch_run(
    session: Session,
    *,
    project_id: str,
    task: CallerTaskDescriptor,
    environment: str,
    run_metadata: dict[str, object] | None,
    attestation: CallerSourceAttestation,
    caller_identity: CallerIdentity,
    task_definition: dict[str, object],
) -> CallerClaimResult:
    """Atomically create one Batch + Task Run + attested Revision + leased caller
    Attempt, and mint the Attempt JWT. Supports exactly one Task.

    SPEC-169: ensures an immutable run-only Definition Revision and pins it on
    the Run. Does not move the published Catalog inventory pointer. Recorded
    caller Runs never exist without their canonical Task definition.

    The caller owns execution; the backend marks the Task Run ``running`` only
    when the CLI later calls ``/start`` (the Attempt is created ``leased``).
    """
    _validate_caller_identity(caller_identity)
    project = session.get(ProjectDB, project_id)
    if project is None:
        raise CallerExecutionError(f"project not found: {project_id!r}")

    now = datetime.now(timezone.utc)
    batch_id = "bch_" + secrets.token_hex(12)
    run_id = "run_" + secrets.token_hex(12)

    batch = AgentTaskBatchRunDB(
        id=batch_id,
        project=project_id,
        selection_type="caller-task",
        # Snapshot the resolved selection so the Batch can name itself by the
        # Task that ran instead of falling back to its selection type.
        selection_query={"task_paths": [task.task_id]},
        task_root=None,
        grep=None,
        environment=environment,
        run_metadata=run_metadata or {},
        status="queued",
        execution_target_json={"kind": "caller"},
        created_at=now,
    )
    session.add(batch)
    session.flush()

    task_run = AgentTaskRunDB(
        id=run_id,
        batch_run_id=batch_id,
        task_id=task.task_id,
        task_path=task.task_path,
        sequence_index=0,
        status="pending",
    )
    # SPEC-169: pin the Task Definition Revision (run-only, does not publish).
    from apo.services.task_definition_revisions import ensure_task_definition_revision

    def_rev = ensure_task_definition_revision(
        session,
        project_id=project_id,
        task_id=task.task_id,
        document=task_definition,
    )
    task_run.task_definition_revision_id = def_rev.id
    session.add(task_run)
    session.flush()

    revision = create_attested_task_revision(
        session, project_id=project_id, batch_run_id=batch_id, attestation=attestation,
    )
    session.flush()

    attempt = TaskExecutionAttemptDB(
        project=project_id,
        batch_run_id=batch_id,
        task_run_id=run_id,
        task_revision_id=revision.id,
        sequence_index=0,
        target_kind="caller",
        executor_pool_id=None,
        executor_id=None,
        status="leased",
        lease_generation=1,
        lease_expires_at=now + timedelta(seconds=ATTEMPT_LEASE_SECONDS),
        queue_expires_at=now + timedelta(seconds=DEFAULT_QUEUE_TTL_SECONDS),
        queued_at=now,
        claimed_at=now,
        heartbeat_at=now,
        executor_snapshot_json=_caller_snapshot(caller_identity),
    )
    session.add(attempt)
    session.commit()
    session.refresh(batch)
    session.refresh(task_run)
    session.refresh(attempt)

    jwt = create_attempt_jwt(
        attempt=attempt, lease_generation=1, expires_in_seconds=_CALLER_LEASE_JWT_TTL_SECONDS,
    )
    return CallerClaimResult(batch=batch, task_run=task_run, attempt=attempt, attempt_jwt=jwt)


def _caller_snapshot(identity: CallerIdentity) -> dict[str, object]:
    return {
        "client": identity.client,
        "client_version": identity.client_version,
        "hostname_hash": identity.hostname_hash,
        "ci_provider": identity.ci_provider,
        "ci_job_id": identity.ci_job_id,
        "git_branch": identity.git_branch,
        "os": identity.os,
        "architecture": identity.architecture,
    }


_MAX_IDENTITY_FIELD_BYTES = 255
_MAX_IDENTITY_TOTAL_BYTES = 4 * 1024


def _validate_caller_identity(identity: CallerIdentity) -> None:
    fields = {
        "client": identity.client, "client_version": identity.client_version,
        "hostname_hash": identity.hostname_hash, "ci_provider": identity.ci_provider,
        "ci_job_id": identity.ci_job_id, "git_branch": identity.git_branch,
        "os": identity.os, "architecture": identity.architecture,
    }
    total = 0
    for name, value in fields.items():
        if value is None:
            continue
        b = len(str(value).encode("utf-8"))
        if b > _MAX_IDENTITY_FIELD_BYTES:
            raise CallerExecutionError(f"caller_identity.{name} exceeds 255-byte limit")
        total += b
    if total > _MAX_IDENTITY_TOTAL_BYTES:
        raise CallerExecutionError("caller_identity exceeds 4 KiB total limit")


__all__ = [
    "CallerClaimResult",
    "CallerExecutionError",
    "PoolResolutionError",
    "SourceOwnedSelectionError",
    "create_caller_batch_run",
    "create_pooled_batch_run",
    "create_source_owned_batch_run",
    "resolve_execution_pool",
]


# ============================================================================
# pooled Batch creation
# ============================================================================


class PoolResolutionError(ValueError):
    """Raised when no usable execution Pool can be resolved for a Batch.

    Carries a ``kind`` (``executor_pool_required`` / ``executor_pool_disabled`` /
    ``executor_pool_archived`` / ``executor_pool_not_owned``) so routes map to
    the spec's 409/422 contract.
    """

    kind: str

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(f"[{kind}] {message}")
        self.kind = kind


def resolve_execution_pool(
    session: Session,
    *,
    project_id: str,
    explicit_pool_id: str | None,
) -> ExecutorPoolDB:
    """Resolve the Pool a Batch targets: explicit wins, else Project default.

    Disabled/archived Pools reject new Batch creation (the user can correct it
    before creating misleading queued work). Offline Pools are accepted.
    """
    pool_id = explicit_pool_id
    if pool_id is None:
        project = session.get(ProjectDB, project_id)
        pool_id = project.default_executor_pool_id if project is not None else None
    if pool_id is None:
        raise PoolResolutionError(
            "executor_pool_required",
            "no executor pool specified and the project has no default pool",
        )
    pool = session.get(ExecutorPoolDB, pool_id)
    if pool is None or pool.project != project_id:
        raise PoolResolutionError(
            "executor_pool_not_owned",
            "executor pool does not belong to this project",
        )
    if pool.archived_at is not None:
        raise PoolResolutionError(
            "executor_pool_archived", "executor pool is archived"
        )
    if not pool.enabled:
        raise PoolResolutionError(
            "executor_pool_disabled", "executor pool is disabled"
        )
    return pool


async def create_pooled_batch_run(
    session: Session,
    *,
    project_id: str,
    pool_id: str | None,
    selection_type: str,
    task_paths: list[str] | None,
    task_root: str | None,
    grep: str | None,
    environment: str,
    run_metadata: dict[str, object] | None,
    task_source: ProjectTaskSourceDB | None,
    resolved_commit_sha: str | None = None,
    queue_ttl_seconds: int | None = None,
) -> AgentTaskBatchRunDB:
    """Create a pooled Batch: Revision/Bundle + ordered queued Attempts.

    Returns immediately after the work is durable. The Control Plane does not
    execute customer code or wait for an Executor. Sequential Task order within
    one Batch is preserved by ``sequence_index`` (only the lowest non-terminal
    Attempt is claimable). If Bundle persistence succeeds but the DB transaction
    fails, the service deletes the orphan object.
    """
    from apo.services.agent_task_runner import create_batch_run
    from apo.services.task_revisions import (
        delete_task_revision_bundle,
        materialize_pooled_task_revision,
    )

    if task_source is None:
        raise PoolResolutionError(
            "executor_pool_required",
            "pooled execution requires a configured project task source",
        )
    pool = resolve_execution_pool(session, project_id=project_id, explicit_pool_id=pool_id)

    revision = None
    try:
        # Selection, Batch, Task Runs, Revision, and Attempts share one DB
        # transaction. The object store write precedes the final commit.
        batch = create_batch_run(
            session,
            project=project_id,
            selection_type=selection_type,
            task_paths=task_paths,
            task_root=task_root,
            grep=grep,
            environment=environment,
            run_metadata=run_metadata,
            task_source=task_source,
            commit=False,
        )
        batch.execution_target_json = {"kind": "pool", "pool_id": pool.id}
        session.add(batch)

        revision = await materialize_pooled_task_revision(
            session,
            project_id=project_id,
            batch_run_id=batch.id,
            task_source=task_source,
            resolved_commit_sha=resolved_commit_sha,
            commit=False,
        )
        task_runs = session.exec(
            select(AgentTaskRunDB)
            .where(AgentTaskRunDB.batch_run_id == batch.id)
            .order_by(
                as_column(AgentTaskRunDB.sequence_index),
                as_column(AgentTaskRunDB.id),
            )
        ).all()
        inventory = _inventory_paths(session, task_runs)
        now = datetime.now(timezone.utc)
        queue_ttl = (
            queue_ttl_seconds
            if queue_ttl_seconds is not None
            else pool.queue_ttl_seconds
        )
        if queue_ttl <= 0:
            raise ValueError("queue_ttl_seconds must be positive")
        for idx, task_run in enumerate(task_runs):
            task_run.sequence_index = idx
            task_run.task_path = inventory[task_run.task_inventory_id]
            session.add(
                TaskExecutionAttemptDB(
                    project=project_id,
                    batch_run_id=batch.id,
                    task_run_id=task_run.id,
                    task_revision_id=revision.id,
                    sequence_index=idx,
                    target_kind="pool",
                    executor_pool_id=pool.id,
                    executor_id=None,
                    status="queued",
                    queue_expires_at=now
                    + timedelta(seconds=queue_ttl),
                    queued_at=now,
                )
            )
            session.add(task_run)
        session.commit()
        session.refresh(batch)
        return batch
    except Exception:
        session.rollback()
        if revision is not None:
            await delete_task_revision_bundle(revision)
        raise


def _inventory_paths(
    session: Session,
    task_runs: Sequence[AgentTaskRunDB],
) -> dict[str | None, str]:
    inventory_ids = {
        task_run.task_inventory_id
        for task_run in task_runs
        if task_run.task_inventory_id is not None
    }
    rows = session.exec(
        select(ProjectTaskInventoryDB).where(
            as_column(ProjectTaskInventoryDB.id).in_(inventory_ids)
        )
    ).all()
    paths: dict[str | None, str] = {row.id: row.task_path for row in rows}
    missing = [
        task_run.id
        for task_run in task_runs
        if task_run.task_inventory_id not in paths
    ]
    if missing:
        raise ValueError(
            "pooled Task Runs require persisted inventory-relative paths: "
            + ", ".join(missing)
        )
    return paths


# ============================================================================
# source-owned dashboard Batch creation
# ============================================================================


class SourceOwnedSelectionError(ValueError):
    """Raised on invalid source-owned Batch creation input.

    Carries a ``kind`` (``task_catalog_missing`` / ``task_not_in_catalog`` /
    ``source_owned_selection_invalid``) so the route maps to the spec's
    409/422 contract.
    """

    kind: str

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(f"[{kind}] {message}")
        self.kind = kind


def create_source_owned_batch_run(
    session: Session,
    *,
    project_id: str,
    user_id: str,
    task_ids: list[str],
    environment: str = "default",
    run_metadata: dict[str, object] | None = None,
    queue_ttl_seconds: int | None = None,
    queue_deadline: datetime | None = None,
    selection_snapshot: dict[str, object] | None = None,
    commit: bool = True,
) -> AgentTaskBatchRunDB:
    """Atomically create a source-owned dashboard Batch without materializing source.

    Creates one queued Batch, ordered pending Task Runs (carrying canonical
    catalog Task IDs and safe display metadata), and ordered queued
    source-owned Attempts in one transaction. No Revision, Bundle, repository
    checkout, source sync, or local path resolution occurs.

    Every Attempt has ``assignment_kind="source_owned"`` and
    ``target_user_id`` equal to the acting User. All Attempts share one queue
    deadline: an explicit ``queue_deadline`` (used by the scheduler so all
    Attempts in one Occurrence share ``occurrence + 24h``), else
    ``created_at + 24 hours``.

    ``commit=False`` lets the scheduler compose Occurrence + Batch + cadence
    advancement in one transaction without performing irreversible external
    work; the caller owns the commit. ``selection_snapshot`` is stored on the
    Batch's ``selection_query`` so later catalog changes cannot mutate its
    resolved identity.
    """
    resolved = _resolve_source_owned_task_ids(session, project_id=project_id, task_ids=task_ids)

    pool = _ensure_source_owned_pool_for_queue(session, project_id)

    now = datetime.now(timezone.utc)
    if queue_deadline is None:
        queue_ttl = (
            queue_ttl_seconds if queue_ttl_seconds is not None else DEFAULT_QUEUE_TTL_SECONDS
        )
        if queue_ttl <= 0:
            raise ValueError("queue_ttl_seconds must be positive")
        queue_deadline = now + timedelta(seconds=queue_ttl)

    batch_id = "bch_" + secrets.token_hex(12)
    batch = AgentTaskBatchRunDB(
        id=batch_id,
        project=project_id,
        selection_type="tasks",
        selection_query=selection_snapshot,
        task_root=None,
        grep=None,
        environment=environment,
        requested_by_user_id=user_id,
        run_metadata=run_metadata or {},
        status="queued",
        execution_target_json={"kind": "source_owned"},
        created_at=now,
    )
    session.add(batch)
    session.flush()

    for index, inventory in enumerate(resolved):
        run_id = "run_" + secrets.token_hex(12)
        task_run = AgentTaskRunDB(
            id=run_id,
            batch_run_id=batch_id,
            task_id=inventory.task_id,
            task_path=inventory.task_path,
            task_inventory_id=inventory.id,
            # SPEC-169: pin the published Definition Revision from inventory.
            task_definition_revision_id=inventory.task_definition_revision_id,
            sequence_index=index,
            adapter_name=inventory.adapter_name,
            status="pending",
        )
        session.add(task_run)
        session.add(
            TaskExecutionAttemptDB(
                project=project_id,
                batch_run_id=batch_id,
                task_run_id=run_id,
                task_revision_id=None,
                sequence_index=index,
                target_kind="pool",
                assignment_kind="source_owned",
                target_user_id=user_id,
                executor_pool_id=pool.id,
                executor_id=None,
                status="queued",
                queue_expires_at=queue_deadline,
                queued_at=now,
            )
        )

    if commit:
        session.commit()
        session.refresh(batch)
    else:
        session.flush()
    return batch


def _resolve_source_owned_task_ids(
    session: Session,
    *,
    project_id: str,
    task_ids: list[str],
) -> list[ProjectTaskInventoryDB]:
    """Validate and resolve exact catalog Task IDs against the current catalog.

    Rejects empty/duplicate IDs (``source_owned_selection_invalid``), a
    missing catalog (``task_catalog_missing``), and any absent Task ID
    (``task_not_in_catalog``) without creating partial rows.
    """
    if not task_ids:
        raise SourceOwnedSelectionError(
            "source_owned_selection_invalid", "at least one task_id is required"
        )
    if len(set(task_ids)) != len(task_ids):
        raise SourceOwnedSelectionError(
            "source_owned_selection_invalid", "duplicate task_ids are not allowed"
        )

    source = session.exec(
        select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == project_id)
    ).first()
    if source is None or source.source_type != "published" or not source.catalog_digest:
        raise SourceOwnedSelectionError(
            "task_catalog_missing",
            "project has no published task catalog",
        )

    rows = session.exec(
        select(ProjectTaskInventoryDB).where(
            ProjectTaskInventoryDB.project == project_id,
            as_column(ProjectTaskInventoryDB.task_id).in_(task_ids),
        )
    ).all()
    by_id = {row.task_id: row for row in rows}
    missing = [task_id for task_id in task_ids if task_id not in by_id]
    if missing:
        raise SourceOwnedSelectionError(
            "task_not_in_catalog",
            "task ids not in the current catalog: " + ", ".join(missing),
        )
    return [by_id[task_id] for task_id in task_ids]


def _ensure_source_owned_pool_for_queue(
    session: Session, project_id: str
) -> ExecutorPoolDB:
    """Return the canonical source-owned Pool for the project.

    Reuses ``ensure_source_owned_pool`` so we never create a
    second source-owned execution model.
    """
    from .source_owned_executor import ensure_source_owned_pool

    return ensure_source_owned_pool(session, project_id)
