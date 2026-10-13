"""Scene tests: Task Notes through the app.

Covers scope resolution (ancestor Folders on whole segments, Task, Tests),
Folder listing, the definition-revision anchor, archive/restore, the error
contract, the write-credential rule shared with corrections, and project
deletion.
"""

# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownParameterType=false
# pyright: reportUnusedCallResult=false, reportAttributeAccessIssue=false
# pyright: reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false
# pyright: reportExplicitAny=false, reportImplicitOverride=false, reportUnusedParameter=false

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlmodel import Session, select
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskNoteDB,
    AgentTaskRunDB,
    ProjectDB,
    ProjectMembershipDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    UserDB,
)
from apo.services.project_deletion import delete_project_data
from apo.services.task_definition_revisions import ensure_task_definition_revision

NOW = datetime.now(timezone.utc)
TASK = "harvey-lab/assess-risk"
NOTES = "/v1/projects/p1/task-notes"


def _seed_project(session: Session, project: str = "p1") -> None:
    if not session.get(UserDB, "u1"):
        session.add(UserDB(id="u1", email="u1@test.com", name="U1", password_hash="x"))
    if not session.get(ProjectDB, project):
        session.add(ProjectDB(id=project, name=f"Project {project}", created_by="u1"))
        session.flush()
        session.add(
            ProjectMembershipDB(
                project_id=project, user_id="u1", role="owner", created_at=NOW, updated_at=NOW
            )
        )
    session.commit()


def _revision(session: Session, content: str, task_id: str = TASK) -> str:
    rev = ensure_task_definition_revision(
        session,
        project_id="p1",
        task_id=task_id,
        document={"schema_version": 1, "files": [{"path": "t.eval.ts", "content": content}]},
    )
    session.commit()
    return rev.id


def _pin_catalog(session: Session, revision_id: str, task_id: str = TASK) -> None:
    source = session.exec(select(ProjectTaskSourceDB).where(ProjectTaskSourceDB.project == "p1")).first()
    if source is None:
        source = ProjectTaskSourceDB(project="p1", source_type="published", status="ready")
        session.add(source)
        session.commit()
    row = session.exec(
        select(ProjectTaskInventoryDB).where(ProjectTaskInventoryDB.task_id == task_id)
    ).first()
    if row is None:
        row = ProjectTaskInventoryDB(
            project="p1",
            task_source_id=source.id,
            task_id=task_id,
            display_name=task_id.rsplit("/", 1)[-1],
            folder_path=task_id.rsplit("/", 1)[0],
            task_path=f"/{task_id}",
            source_type="published",
        )
    row.task_definition_revision_id = revision_id
    session.add(row)
    session.commit()


def _seed_run(session: Session, revision_id: str, run_id: str, created_at: datetime) -> None:
    batch = AgentTaskBatchRunDB(
        id=f"batch-{run_id}", project="p1", selection_type="task", status="completed", created_at=created_at
    )
    session.add(batch)
    session.flush()
    session.add(
        AgentTaskRunDB(
            id=run_id,
            batch_run_id=batch.id,
            task_id=TASK,
            task_path=f"/{TASK}",
            status="failed",
            pass_result=False,
            task_definition_revision_id=revision_id,
        )
    )
    session.commit()


def _add(client: TestClient, body: str = "audited 2026-10-12: sound", **target: str) -> Any:
    return client.post(NOTES, json={**target, "body": body})


def _list(client: TestClient, **params: Any) -> list[dict[str, Any]]:
    resp = client.get(NOTES, params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()["notes"]


def _client_with_state(session: Session, **state: Any) -> TestClient:
    from apo.api import app as root_app
    from apo.db import get_session

    class InjectState(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next: Any) -> Response:
            for key, value in state.items():
                setattr(request.state, key, value)
            return await call_next(request)

    new_app = FastAPI()
    new_app.include_router(root_app.router)
    new_app.add_middleware(InjectState)
    new_app.dependency_overrides[get_session] = lambda: session
    return TestClient(new_app)


class TestScopes:
    def test_task_listing_returns_ancestor_folders_task_and_tests(
        self, client: TestClient, session: Session
    ) -> None:
        _seed_project(session)
        _add(client, "judge flips on harvey prompts", folder="harvey-lab")
        _add(client, "a sibling folder", folder="harvey-labs")
        _add(client, "normally 45-47/48", task_id=TASK)
        _add(client, "audited, misses are real", task_id=TASK, test_id="C-021")
        _add(client, "another task", task_id="harvey-lab/other")

        notes = _list(client, task_id=TASK)

        assert [(n["scope"], n["folder"] or n["test_id"] or n["task_id"]) for n in notes] == [
            ("folder", "harvey-lab"),
            ("task", TASK),
            ("test", "C-021"),
        ]

    def test_nested_task_sees_every_ancestor_folder(
        self, client: TestClient, session: Session
    ) -> None:
        _seed_project(session)
        _add(client, "top", folder="a")
        _add(client, "middle", folder="a/b")
        _add(client, "not an ancestor", folder="a/c")

        notes = _list(client, task_id="a/b/t")

        assert [n["folder"] for n in notes] == ["a", "a/b"]

    def test_folder_listing_includes_everything_under_it_on_whole_segments(
        self, client: TestClient, session: Session
    ) -> None:
        _seed_project(session)
        _add(client, "set note", folder="harvey-lab")
        _add(client, "nested set", folder="harvey-lab/contracts")
        _add(client, "task note", task_id=TASK)
        _add(client, "test note", task_id=TASK, test_id="C-021")
        _add(client, "sibling folder", folder="harvey-labs")
        _add(client, "sibling task", task_id="harvey-labs/x")

        bodies = {n["body"] for n in _list(client, folder="/harvey-lab/")}

        assert bodies == {"set note", "nested set", "task note", "test note"}

    def test_folder_wildcards_are_literal(self, client: TestClient, session: Session) -> None:
        _seed_project(session)
        _add(client, "underscore folder", folder="a_b")
        _add(client, "lookalike", task_id="axb/t")

        assert {n["body"] for n in _list(client, folder="a_b")} == {"underscore folder"}

    def test_folder_match_is_case_sensitive_like_task_ids(
        self, client: TestClient, session: Session
    ) -> None:
        """A Folder query matches the stored casing, on every backend.

        SQLite's LIKE is ASCII-case-insensitive, so a differently-cased
        folder query used to leak the notes *under* the folder (prefix
        matches) while hiding the ones *on* it (exact matches) — half a
        result set. Task ids are case-sensitive; folders inherit that.
        """
        _seed_project(session)
        _add(client, "on the set", folder="Harvey-Lab")
        _add(client, "nested set", folder="Harvey-Lab/contracts")
        _add(client, "task under it", task_id="Harvey-Lab/x")

        assert _list(client, folder="harvey-lab") == []
        assert len(_list(client, folder="Harvey-Lab")) == 3

    def test_folder_is_normalized_on_write(self, client: TestClient, session: Session) -> None:
        _seed_project(session)
        resp = _add(client, folder="/harvey-lab/")
        assert resp.status_code == 201
        assert resp.json()["folder"] == "harvey-lab"


class TestRevisionAnchor:
    def test_task_note_anchors_to_the_catalog_revision(
        self, client: TestClient, session: Session
    ) -> None:
        _seed_project(session)
        rev = _revision(session, "v1")
        _pin_catalog(session, rev)

        resp = _add(client, task_id=TASK, test_id="C-021")

        assert resp.json()["task_definition_revision_id"] == rev

    def test_without_a_catalog_row_the_latest_run_revision_is_used(
        self, client: TestClient, session: Session
    ) -> None:
        _seed_project(session)
        _seed_run(session, _revision(session, "v1"), "run-old", NOW - timedelta(days=1))
        newer = _revision(session, "v2")
        _seed_run(session, newer, "run-new", NOW)

        resp = _add(client, task_id=TASK)

        assert resp.json()["task_definition_revision_id"] == newer

    def test_editing_the_body_re_anchors_to_the_current_revision(
        self, client: TestClient, session: Session
    ) -> None:
        _seed_project(session)
        _pin_catalog(session, _revision(session, "v1"))
        note = _add(client, task_id=TASK).json()
        v2 = _revision(session, "v2")
        _pin_catalog(session, v2)

        archived = client.patch(f"/v1/task-notes/{note['id']}", json={"archived": True}).json()
        assert archived["task_definition_revision_id"] == note["task_definition_revision_id"]

        edited = client.patch(f"/v1/task-notes/{note['id']}", json={"body": "re-checked on v2"}).json()
        assert edited["task_definition_revision_id"] == v2

    def test_folder_notes_have_no_anchor(self, client: TestClient, session: Session) -> None:
        _seed_project(session)
        assert _add(client, folder="harvey-lab").json()["task_definition_revision_id"] is None


class TestArchive:
    def test_archived_notes_are_hidden_until_asked_for_and_restorable(
        self, client: TestClient, session: Session
    ) -> None:
        _seed_project(session)
        note = _add(client, task_id=TASK).json()

        client.patch(f"/v1/task-notes/{note['id']}", json={"archived": True})
        assert _list(client, task_id=TASK) == []
        assert _list(client, task_id=TASK, include_archived=True)[0]["archived_at"] is not None

        client.patch(f"/v1/task-notes/{note['id']}", json={"archived": False})
        assert _list(client, task_id=TASK)[0]["archived_at"] is None


class TestErrorContract:
    def test_target_rules(self, client: TestClient, session: Session) -> None:
        _seed_project(session)
        cases = [
            ({}, "target_required"),
            ({"folder": "a", "task_id": TASK}, "ambiguous_target"),
            ({"folder": "/"}, "invalid_folder"),
            ({"task_id": TASK, "test_id": "  "}, "invalid_test_id"),
            ({"test_id": "C-1"}, "target_required"),
        ]
        for target, kind in cases:
            resp = client.post(NOTES, json={**target, "body": "some text"})
            assert resp.status_code == 422, target
            assert resp.json()["detail"]["kind"] == kind, target

    def test_body_length(self, client: TestClient, session: Session) -> None:
        _seed_project(session)
        for body in ("  x ", "y" * 4001):
            resp = _add(client, body, task_id=TASK)
            assert resp.json()["detail"]["kind"] == "invalid_body"

    def test_patch_needs_a_change(self, client: TestClient, session: Session) -> None:
        _seed_project(session)
        note = _add(client, task_id=TASK).json()
        resp = client.patch(f"/v1/task-notes/{note['id']}", json={})
        assert resp.json()["detail"]["kind"] == "nothing_to_update"

    def test_list_takes_one_filter(self, client: TestClient, session: Session) -> None:
        _seed_project(session)
        resp = client.get(NOTES, params={"task_id": TASK, "folder": "harvey-lab"})
        assert resp.json()["detail"]["kind"] == "ambiguous_filter"

    def test_unknown_note(self, client: TestClient, session: Session) -> None:
        _seed_project(session)
        assert client.patch("/v1/task-notes/note_missing", json={"archived": True}).status_code == 404


class TestAuth:
    def test_api_key_note_is_attributed_to_its_creator(
        self, make_api_key_client: Any, session: Session
    ) -> None:
        _seed_project(session)
        keyed = make_api_key_client("u1", "p1", session)

        note = _add(keyed, task_id=TASK).json()

        assert note["created_via"] == "api_key"
        assert note["created_by_label"] == "u1@test.com"
        assert _list(keyed, task_id=TASK)[0]["created_by_label"] == "u1@test.com"

    def test_edit_attributes_the_current_text_to_its_editor(
        self, make_authed_client: Any, session: Session
    ) -> None:
        _seed_project(session)
        session.add(UserDB(id="u2", email="u2@test.com", name="U2", password_hash="x"))
        session.flush()
        session.add(
            ProjectMembershipDB(
                project_id="p1", user_id="u2", role="member", created_at=NOW, updated_at=NOW
            )
        )
        session.commit()
        creator = make_authed_client("u1", session)
        editor = make_authed_client("u2", session)
        note = _add(creator, task_id=TASK).json()

        edited = editor.patch(f"/v1/task-notes/{note['id']}", json={"body": "re-checked by u2"})

        assert edited.status_code == 200
        assert edited.json()["created_by_label"] == "u1@test.com"
        assert edited.json()["updated_by_label"] == "u2@test.com"
        assert edited.json()["updated_via"] == "session"
        assert _list(editor, task_id=TASK)[0]["updated_by_label"] == "u2@test.com"

    def test_ingest_key_cannot_write(self, make_api_key_client: Any, session: Session) -> None:
        _seed_project(session)
        ingest = make_api_key_client("u1", "p1", session, scope="ingest")

        resp = _add(ingest, task_id=TASK)

        assert resp.status_code == 403
        assert resp.json()["detail"]["kind"] == "full_scope_required"
        assert session.exec(select(AgentTaskNoteDB)).all() == []

    def test_runtime_token_cannot_write(self, session: Session) -> None:
        _seed_project(session)
        tokened = _client_with_state(session, auth_method="service_token", project="p1")

        resp = _add(tokened, task_id=TASK)

        assert resp.status_code in (401, 403)
        assert session.exec(select(AgentTaskNoteDB)).all() == []

    def test_key_for_another_project_cannot_read_or_edit(
        self, client: TestClient, make_api_key_client: Any, session: Session
    ) -> None:
        _seed_project(session)
        note = _add(client, task_id=TASK).json()
        outsider = make_api_key_client("u-outsider", "other-project", session)

        assert outsider.get(NOTES, params={"task_id": TASK}).status_code in (403, 404)
        assert outsider.patch(f"/v1/task-notes/{note['id']}", json={"archived": True}).status_code == 404

    def test_demo_project_is_read_only(self, client: TestClient, session: Session) -> None:
        resp = client.post("/v1/projects/demo/task-notes", json={"task_id": TASK, "body": "nope"})
        assert resp.status_code == 403


class TestLifecycle:
    def test_project_deletion_removes_notes(self, client: TestClient, session: Session) -> None:
        _seed_project(session)
        _add(client, task_id=TASK)
        _add(client, folder="harvey-lab")

        deleted = delete_project_data(session, "p1", keep_project=False, keep_api_keys=False)

        assert deleted["agent_task_notes"] == 2
        assert session.exec(select(AgentTaskNoteDB)).all() == []


class TestRunDetail:
    def test_run_reads_its_task_notes_marked_against_its_revision(
        self, client: TestClient, session: Session
    ) -> None:
        _seed_project(session)
        v1 = _revision(session, "v1")
        _pin_catalog(session, v1)
        _add(client, "written on v1", task_id=TASK, test_id="C-021")
        _add(client, "set-wide", folder="harvey-lab")
        v2 = _revision(session, "v2")
        _seed_run(session, v1, "run-v1", NOW - timedelta(days=1))
        _seed_run(session, v2, "run-v2", NOW)

        on_v1 = client.get("/v1/agent-task-runs/run-v1").json()["task_notes"]
        on_v2 = client.get("/v1/agent-task-runs/run-v2").json()["task_notes"]

        assert [(n["body"], n["task_definition_revision_matches_run"]) for n in on_v1] == [
            ("set-wide", None),
            ("written on v1", True),
        ]
        assert [n["task_definition_revision_matches_run"] for n in on_v2] == [None, False]

    def test_run_without_notes_has_an_empty_list(self, client: TestClient, session: Session) -> None:
        _seed_project(session)
        _seed_run(session, _revision(session, "v1"), "run-1", NOW)

        assert client.get("/v1/agent-task-runs/run-1").json()["task_notes"] == []
