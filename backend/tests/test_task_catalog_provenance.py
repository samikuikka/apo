"""Catalog provenance: when a task first appeared and what it's for (issue #444).

First-seen facts (``first_published_at`` / ``first_published_by_user_id``)
must survive the replace-in-place publication keyed by ``task_id``. The
description is client-sent from the eval's declared description. Neither may
move the catalog digest, which ``apo connect`` claims gate on. Git authorship
fields are no longer part of the catalog: they recorded whatever identity the
publishing repo happened to configure (a dev account, an agent, a fixture),
never a meaningful author — a payload still carrying them (an older CLI) is
accepted, the fields are ignored.
"""

# pyright: reportAny=false, reportExplicitAny=false

from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import (
    ProjectDB,
    ProjectMembershipDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    UserDB,
)
from apo.services.task_catalog import compute_catalog_digest

_USER = "user-catalog-prov"
_PROJECT = "proj-catalog-prov"


def _seed(session: Session) -> None:
    now = datetime.now(timezone.utc)
    session.add(UserDB(id=_USER, email=f"{_USER}@test", name="Catalog Owner", password_hash="x"))
    session.commit()
    session.add(ProjectDB(id=_PROJECT, name=_PROJECT, created_by=_USER, created_at=now))
    session.commit()
    session.add(
        ProjectMembershipDB(
            project_id=_PROJECT, user_id=_USER, role="owner", created_at=now, updated_at=now
        )
    )
    session.commit()


def _task(
    task_id: str = "chat/alpha",
    *,
    description: str | None = "Grades the Q3 summary against its work log.",
) -> dict[str, Any]:
    folder, _, name = task_id.rpartition("/")
    task: dict[str, Any] = {
        "task_id": task_id,
        "display_name": name,
        "task_path": task_id,
        "folder_path": folder,
        "adapter_name": "chatAdapter",
        "has_checks": True,
        "tags": [],
    }
    if description is not None:
        task["description"] = description
    return task


def _row(session: Session, task_id: str) -> ProjectTaskInventoryDB:
    session.expire_all()
    return session.exec(
        select(ProjectTaskInventoryDB).where(
            ProjectTaskInventoryDB.project == _PROJECT,
            ProjectTaskInventoryDB.task_id == task_id,
        )
    ).one()


def _publish(client: TestClient, tasks: list[dict[str, Any]]) -> Any:
    return client.put(
        f"/v1/projects/{_PROJECT}/task-catalog",
        json={"schema_version": 2, "tasks": tasks},
    )


def test_first_seen_survives_republish(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)

    first = _publish(client, [_task()]).json()
    first_row = _row(session, "chat/alpha")
    assert first_row.first_published_at is not None
    assert first_row.first_published_by_user_id == _USER
    assert first_row.description == "Grades the Q3 summary against its work log."

    # Second publication: content changed, description absent. First-seen
    # survives; an absent description carries the last stated one; a new task
    # starts its own first-seen at this publication.
    second = _publish(
        client,
        [_task(description=None), _task("chat/beta", description=None)],
    ).json()
    assert second["catalog_digest"] != first["catalog_digest"]

    again = _row(session, "chat/alpha")
    assert again.first_published_at == first_row.first_published_at
    assert again.first_published_by_user_id == _USER
    # Absent description carries the last stated one; it does not erase.
    assert again.description == "Grades the Q3 summary against its work log."

    beta = _row(session, "chat/beta")
    assert beta.first_published_at is not None
    assert beta.first_published_at > again.first_published_at
    assert beta.description is None


def test_git_fields_from_older_cli_are_ignored(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """A CLI predating the removal still sends git authorship; the publish
    succeeds and the row records nothing of it."""
    _seed(session)
    client = make_authed_client(_USER, session)

    legacy = _task()
    legacy.update(
        {
            "git_author_name": "Teammate One",
            "git_author_email": "teammate@example.com",
            "git_first_commit_at": "2026-10-02T09:30:00+00:00",
            "git_first_commit_sha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        }
    )
    assert _publish(client, [legacy]).status_code == 200
    summaries = client.get(f"/v1/projects/{_PROJECT}/agent-tasks").json()
    assert "git_author_name" not in summaries[0]


def test_description_never_moves_the_digest(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)

    with_description = _publish(client, [_task()]).json()["catalog_digest"]
    without = _publish(client, [_task(description=None)]).json()["catalog_digest"]
    # The CLI twin (task-catalog-digest.ts) hashes the seven metadata fields
    # only; the description must be excluded here to match.
    bare = _task(description=None)
    bare.pop("definition", None)
    assert with_description == without == compute_catalog_digest([bare])


def test_readding_after_removal_starts_a_new_first_seen(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)

    _publish(client, [_task()])
    original = _row(session, "chat/alpha").first_published_at
    # Remove: publish the catalog without the task.
    _publish(client, [_task("chat/other", description=None)])
    # Re-add later.
    _publish(client, [_task()])
    assert _row(session, "chat/alpha").first_published_at > original


def test_invalid_description_is_rejected(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)

    huge_description = _task()
    huge_description["description"] = "x" * 4001
    assert _publish(client, [huge_description]).status_code == 422


def test_summaries_carry_provenance_and_publisher_label(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    _seed(session)
    client = make_authed_client(_USER, session)

    _publish(client, [_task()])

    summaries = client.get(f"/v1/projects/{_PROJECT}/agent-tasks").json()
    alpha = next(s for s in summaries if s["id"] == "chat/alpha")
    assert alpha["description"] == "Grades the Q3 summary against its work log."
    assert alpha["first_published_at"] is not None
    assert alpha["first_published_by_user_id"] == _USER
    # The route enriches the raw id into a human label.
    assert alpha["first_published_by"] == "Catalog Owner"

    detail = client.get(f"/v1/projects/{_PROJECT}/agent-tasks/chat/alpha").json()
    assert detail["description"] == "Grades the Q3 summary against its work log."


def test_grep_matches_description(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """Search finds a task by what it is for, not only by name and path."""
    _seed(session)
    client = make_authed_client(_USER, session)

    _publish(client, [_task(), _task("chat/beta", description=None)])

    hits = client.get(
        f"/v1/projects/{_PROJECT}/agent-tasks", params={"grep": "invoice"}
    ).json()
    assert [h["id"] for h in hits] == []
    hits = client.get(
        f"/v1/projects/{_PROJECT}/agent-tasks", params={"grep": "summary"}
    ).json()
    assert [h["id"] for h in hits] == ["chat/alpha"]
    assert hits[0]["description"] == "Grades the Q3 summary against its work log."


def test_blank_description_is_normalized_to_absent(
    session: Session, make_authed_client: Callable[..., TestClient]
) -> None:
    """A whitespace-only description is "declared none": the row and every
    response read it back as ``None`` so the UI renders silence, not filler."""
    _seed(session)
    client = make_authed_client(_USER, session)

    padded = _task(description="   ")
    _publish(client, [padded, _task("chat/trimmed", description="  Padded edges  ")])

    assert _row(session, "chat/alpha").description is None
    assert _row(session, "chat/trimmed").description == "Padded edges"

    summaries = client.get(f"/v1/projects/{_PROJECT}/agent-tasks").json()
    alpha = next(s for s in summaries if s["id"] == "chat/alpha")
    assert alpha["description"] is None


def test_sync_path_sets_description_from_discovered_source(session: Session) -> None:
    """Source sync reads the description from the eval file, so a re-sync
    states the current text — including its removal — rather than carrying
    the last one forward."""
    from apo.services.agent_task_discovery import DiscoveredAgentTask
    from apo.services.project_task_inventory import replace_inventory

    _seed(session)
    now = datetime.now(timezone.utc)
    source = ProjectTaskSourceDB(
        project=_PROJECT, source_type="git", status="ready", created_at=now, updated_at=now
    )
    session.add(source)
    session.commit()

    def discovered(description: str | None) -> DiscoveredAgentTask:
        return DiscoveredAgentTask(
            id="chat/alpha",
            task_path="chat/alpha",
            folder_path="chat",
            display_name="alpha",
            adapter_name="chatAdapter",
            has_checks=True,
            tags=[],
            description=description,
        )

    _ = replace_inventory(
        session, project_id=_PROJECT, source=source,
        discovered=[discovered("Extract structured data from an invoice.")],
        resolved_commit_sha=None,
    )
    assert _row(session, "chat/alpha").description == "Extract structured data from an invoice."

    _ = replace_inventory(
        session, project_id=_PROJECT, source=source,
        discovered=[discovered(None)], resolved_commit_sha="abc",
    )
    assert _row(session, "chat/alpha").description is None


def test_sync_path_preserves_first_seen(session: Session) -> None:
    """``replace_inventory`` (source sync / demo) replaces rows too — the same
    carry-forward applies there, or a re-sync would reset first-seen."""
    from apo.services.agent_task_discovery import DiscoveredAgentTask
    from apo.services.project_task_inventory import replace_inventory

    _seed(session)
    now = datetime.now(timezone.utc)
    source = ProjectTaskSourceDB(
        project=_PROJECT, source_type="git", status="ready", created_at=now, updated_at=now
    )
    session.add(source)
    session.commit()
    discovered = [
        DiscoveredAgentTask(
            id="chat/alpha",
            task_path="chat/alpha",
            folder_path="chat",
            display_name="alpha",
            adapter_name="chatAdapter",
            has_checks=True,
            tags=[],
        )
    ]
    _ = replace_inventory(
        session, project_id=_PROJECT, source=source, discovered=discovered, resolved_commit_sha=None
    )
    first = _row(session, "chat/alpha")

    _ = replace_inventory(
        session, project_id=_PROJECT, source=source, discovered=discovered, resolved_commit_sha="abc"
    )
    again = _row(session, "chat/alpha")
    assert again.first_published_at == first.first_published_at
