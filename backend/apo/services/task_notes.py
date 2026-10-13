"""Task Notes: a Project's durable knowledge about a Folder, Task, or Test.

A Note is a statement, not a verdict: nothing here reads or writes a Check
Report, a correction, or a Run scalar. Scope is one of

- ``folder``: a path prefix matched on whole segments,
- ``task``: one folder-qualified Task id,
- ``test``: one ``test(...)`` id of one Task.

Task and Test Notes are anchored to the Task Definition Revision current when
they were written, so a reader viewing a Run pinned to a different revision can
be told the revisions differ without implying which one is newer.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timezone
from typing import Literal, cast

from sqlmodel import Session, col, func, or_, select

from apo.models.db import AgentTaskBatchRunDB, AgentTaskNoteDB, AgentTaskRunDB
from apo.models.schemas import TaskNote, TaskNoteScope
from apo.services.human_actor import HumanActor, user_labels
from apo.services.project_task_inventory import get_inventory_row

BODY_MIN_CHARS = 3
BODY_MAX_CHARS = 4000


class TaskNoteError(ValueError):
    """Domain rejection. The route maps ``kind`` onto the error contract."""

    kind: str

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


def _normalize_folder(folder: str) -> str:
    return "/".join(segment for segment in folder.strip().split("/") if segment)


def _ancestor_folders(task_id: str) -> list[str]:
    """Every folder a Task sits under, nearest last: ``a/b/t`` → ``a``, ``a/b``."""
    segments = task_id.split("/")[:-1]
    return ["/".join(segments[: i + 1]) for i in range(len(segments))]


def create_note(
    session: Session,
    *,
    project: str,
    folder: str | None,
    task_id: str | None,
    test_id: str | None,
    body: str,
    actor: HumanActor,
) -> TaskNote:
    scope, folder, task_id, test_id = _resolve_target(folder, task_id, test_id)
    now = datetime.now(timezone.utc)
    note = AgentTaskNoteDB(
        project=project,
        scope=scope,
        folder=folder,
        task_id=task_id,
        test_id=test_id,
        body=_validate_body(body),
        task_definition_revision_id=(
            _current_definition_revision(session, project, task_id) if task_id else None
        ),
        created_by_user_id=actor.user_id,
        created_via=actor.via,
        api_key_id=actor.api_key_id,
        created_at=now,
        updated_by_user_id=actor.user_id,
        updated_via=actor.via,
        updated_api_key_id=actor.api_key_id,
        updated_at=now,
    )
    session.add(note)
    session.commit()
    session.refresh(note)
    return _to_task_note(note, {actor.user_id: actor.label} if actor.user_id and actor.label else {})


def update_note(
    session: Session,
    note: AgentTaskNoteDB,
    *,
    body: str | None,
    archived: bool | None,
    actor: HumanActor,
) -> TaskNote:
    if body is None and archived is None:
        raise TaskNoteError("nothing_to_update", "give a new body, archived, or both")
    now = datetime.now(timezone.utc)
    if body is not None:
        note.body = _validate_body(body)
        # The text now speaks for the current definition, not the old one.
        if note.task_id:
            note.task_definition_revision_id = _current_definition_revision(
                session, note.project, note.task_id
            )
    if archived is not None:
        note.archived_at = now if archived else None
    note.updated_by_user_id = actor.user_id
    note.updated_via = actor.via
    note.updated_api_key_id = actor.api_key_id
    note.updated_at = now
    session.add(note)
    session.commit()
    session.refresh(note)
    return _to_task_note(note, user_labels(session, _user_ids([note])))


def list_notes(
    session: Session,
    *,
    project: str,
    task_id: str | None = None,
    folder: str | None = None,
    include_archived: bool = False,
) -> list[TaskNote]:
    """Notes for a Task (what applies to it) or under a Folder, or the whole Project.

    ``task_id``: the Task's ancestor Folders, the Task, and its Tests.
    ``folder``: Notes at or under the Folder, in every scope.
    Ordered folder → task → test, newest first within a scope.
    """
    if task_id is not None and folder is not None:
        raise TaskNoteError("ambiguous_filter", "filter by task_id or folder, not both")

    statement = select(AgentTaskNoteDB).where(AgentTaskNoteDB.project == project)
    if task_id is not None:
        statement = statement.where(
            or_(
                col(AgentTaskNoteDB.task_id) == task_id,
                col(AgentTaskNoteDB.folder).in_(_ancestor_folders(task_id)),
            )
        )
    elif folder is not None:
        prefix = _normalize_folder(folder)
        if not prefix:
            raise TaskNoteError("invalid_folder", "folder must name at least one path segment")
        # A prefix comparison, not LIKE: SQLite's LIKE is ASCII-case-
        # insensitive, so a differently-cased folder would match the notes
        # *under* it while the exact-match branch above misses — half a
        # result set. substr equality is case-sensitive on every backend
        # and needs no wildcard escaping.
        under = f"{prefix}/"
        statement = statement.where(
            or_(
                col(AgentTaskNoteDB.folder) == prefix,
                func.substr(col(AgentTaskNoteDB.folder), 1, len(under)) == under,
                func.substr(col(AgentTaskNoteDB.task_id), 1, len(under)) == under,
            )
        )
    if not include_archived:
        statement = statement.where(col(AgentTaskNoteDB.archived_at).is_(None))

    rows = list(session.exec(statement).all())
    rows.sort(key=_display_order)
    labels = user_labels(session, _user_ids(rows))
    return [_to_task_note(row, labels) for row in rows]


def notes_for_run(session: Session, *, project: str, task_run: AgentTaskRunDB) -> list[TaskNote]:
    """The Notes that apply to a Run's Task, each marked against the Run's revision."""
    notes = list_notes(session, project=project, task_id=task_run.task_id)
    run_revision = task_run.task_definition_revision_id
    for note in notes:
        if run_revision and note.task_definition_revision_id:
            note.task_definition_revision_matches_run = (
                note.task_definition_revision_id == run_revision
            )
    return notes


def _to_task_note(row: AgentTaskNoteDB, labels: dict[str, str]) -> TaskNote:
    return TaskNote(
        id=row.id,
        scope=cast(TaskNoteScope, row.scope),
        folder=row.folder,
        task_id=row.task_id,
        test_id=row.test_id,
        body=row.body,
        task_definition_revision_id=row.task_definition_revision_id,
        created_by_user_id=row.created_by_user_id,
        created_by_label=labels.get(row.created_by_user_id) if row.created_by_user_id else None,
        created_via=cast(Literal["session", "api_key", "open_dev"], row.created_via),
        created_at=row.created_at,
        updated_by_user_id=row.updated_by_user_id,
        updated_by_label=labels.get(row.updated_by_user_id) if row.updated_by_user_id else None,
        updated_via=cast(Literal["session", "api_key", "open_dev"], row.updated_via),
        updated_at=row.updated_at,
        archived_at=row.archived_at,
    )


_SCOPE_RANK: dict[str, int] = {"folder": 0, "task": 1, "test": 2}


def _display_order(row: AgentTaskNoteDB) -> tuple[str, int, str, float]:
    """By subject path, so a Folder precedes the Tasks under it and one Task's
    Notes stay together; then Task before Test; newest first."""
    return (
        row.folder or row.task_id or "",
        _SCOPE_RANK.get(row.scope, 3),
        row.test_id or "",
        -row.created_at.timestamp(),
    )


def _resolve_target(
    folder: str | None, task_id: str | None, test_id: str | None
) -> tuple[TaskNoteScope, str | None, str | None, str | None]:
    folder = _normalize_folder(folder) if folder is not None else None
    task_id = task_id.strip() if task_id is not None else None
    test_id = test_id.strip() if test_id is not None else None

    if folder is not None:
        if task_id or test_id:
            raise TaskNoteError("ambiguous_target", "a Note targets a folder or a task, not both")
        if not folder:
            raise TaskNoteError("invalid_folder", "folder must name at least one path segment")
        return "folder", folder, None, None
    if not task_id:
        raise TaskNoteError("target_required", "give folder, or task_id (with optional test_id)")
    if test_id is not None:
        if not test_id:
            raise TaskNoteError("invalid_test_id", "test_id must not be empty")
        return "test", None, task_id, test_id
    return "task", None, task_id, None


def _validate_body(body: str) -> str:
    text = body.strip()
    if not BODY_MIN_CHARS <= len(text) <= BODY_MAX_CHARS:
        raise TaskNoteError(
            "invalid_body",
            f"body must be {BODY_MIN_CHARS}–{BODY_MAX_CHARS} characters",
        )
    return text


def _current_definition_revision(session: Session, project: str, task_id: str) -> str | None:
    """The catalog's pinned revision, else the latest Run's."""
    row = get_inventory_row(session, project, task_id)
    if row is not None and row.task_definition_revision_id:
        return row.task_definition_revision_id
    statement = (
        select(AgentTaskRunDB.task_definition_revision_id)
        .join(AgentTaskBatchRunDB, col(AgentTaskBatchRunDB.id) == col(AgentTaskRunDB.batch_run_id))
        .where(
            AgentTaskBatchRunDB.project == project,
            AgentTaskRunDB.task_id == task_id,
            col(AgentTaskRunDB.task_definition_revision_id).is_not(None),
        )
        .order_by(
            col(AgentTaskBatchRunDB.created_at).desc(),
            col(AgentTaskRunDB.sequence_index).desc(),
        )
        .limit(1)
    )
    return session.exec(statement).first()


def _user_ids(rows: Sequence[AgentTaskNoteDB]) -> set[str]:
    ids: set[str] = set()
    for row in rows:
        if row.created_by_user_id:
            ids.add(row.created_by_user_id)
        if row.updated_by_user_id:
            ids.add(row.updated_by_user_id)
    return ids
