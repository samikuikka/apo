# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

"""Regression tests for issue #14: DELETE /v1/projects/{id} cascade.

The endpoint 500'd with ``FOREIGN KEY constraint failed`` because the old
handler called ``session.delete(project)`` with no dependent cleanup, and
production runs with ``PRAGMA foreign_keys=ON``. These tests build a project
with one row in every dependent table, delete it via the API, and assert
nothing is left behind — so a future table that isn't covered by the cascade
gets caught here.
"""

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import (
    AdaptiveTaskStateDB,
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    AnnotationQueueDB,
    ApiKeyDB,
    CallMetricDB,
    CommentDB,
    CommentReactionDB,
    GithubConnectionDB,
    LoggedCallDB,
    OtlpIngestBatchDB,
    OtlpSpanDB,
    ProjectDB,
    ProjectInvitationDB,
    ProjectMembershipDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
    RunDB,
    RunMetricDB,
    ScoreConfigDB,
    SessionDB,
    UserDB,
    WebhookDB,
)
from apo.models.pricing import ModelDefinitionDB
from apo.services.project_memberships import create_owner_membership


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_user(session: Session, email: str) -> UserDB:
    user = UserDB(
        email=email,
        name=email,
        password_hash="x",
        is_active=True,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _make_project(session: Session, owner: UserDB, slug: str) -> ProjectDB:
    project = ProjectDB(id=slug, name=slug, created_by=owner.id)
    session.add(project)
    session.commit()
    session.refresh(project)
    create_owner_membership(session, project.id, owner.id)
    return project


def _seed_full_project(session: Session, project_id: str, owner_id: str) -> None:
    """Insert one row in every project-dependent table, in FK-safe order."""
    now = datetime.now(timezone.utc)

    # Task source → inventory (inventory FKs the source).
    source = ProjectTaskSourceDB(
        id=f"src-{project_id}",
        project=project_id,
        source_type="filesystem",
        display_name="Tasks",
        status="ready",
        subpath="tasks",
        created_at=now,
    )
    session.add(source)
    session.flush()
    inventory = ProjectTaskInventoryDB(
        id=f"inv-{project_id}",
        project=project_id,
        task_source_id=source.id,
        task_id="cost-inquiry",
        display_name="cost-inquiry",
        adapter_name="demoAdapter",
        folder_path="",
        task_path="cost-inquiry",
        source_type="filesystem",
        source_ref="tasks",
        source_commit_sha="abc",
        discovered_at=now,
    )
    session.add(inventory)
    session.flush()

    # Batch → task run (task run FKs the batch).
    batch = AgentTaskBatchRunDB(
        id=f"batch-{project_id}",
        project=project_id,
        selection_type="task",
        status="passed",
        total_tasks=1,
        passed_tasks=1,
        created_at=now,
    )
    session.add(batch)
    session.flush()
    task_run = AgentTaskRunDB(
        id=f"run-{project_id}",
        batch_run_id=batch.id,
        task_id="cost-inquiry",
        task_path="cost-inquiry",
        status="passed",
        pass_result=True,
    )
    session.add(task_run)
    session.flush()

    # Schedule → adaptive state (adaptive state FKs the schedule).
    schedule = AgentTaskScheduleDB(
        id=f"schedule-{project_id}",
        project=project_id,
        name="daily",
        selection_type="task",
        cadence_type="daily",
        next_run_at=now + timedelta(days=1),
        created_at=now,
    )
    session.add(schedule)
    session.flush()
    session.add(
        AdaptiveTaskStateDB(
            id=f"{schedule.id}||cost-inquiry",
            schedule_id=schedule.id,
            task_id="cost-inquiry",
            next_run_at=now + timedelta(days=1),
        )
    )

    # Comment → reaction (reaction FKs the comment).
    comment = CommentDB(
        id=f"comment-{project_id}",
        project_id=project_id,
        object_id=f"run-{project_id}",
        object_type="run",
        content="looks good",
    )
    session.add(comment)
    session.flush()
    session.add(
        CommentReactionDB(comment_id=comment.id, emoji="👍", user_id="u1")
    )

    # Direct soft-reference tables (no FK to projects, but must be cleaned).
    session.add(ScoreConfigDB(project=project_id, name="faithfulness", data_type="NUMERIC"))
    session.add(
        AnnotationQueueDB(project=project_id, name="review", target_type="TRACE")
    )
    session.add(WebhookDB(project=project_id, url="https://hook.test", secret="s"))
    session.add(SessionDB(id=f"sess-{project_id}", project=project_id))
    session.add(
        RunDB(id=f"trace-{project_id}", project=project_id, created_at=now)
    )
    session.add(
        RunMetricDB(
            project=project_id,
            run_id=f"trace-{project_id}",
            metric_name="latency",
            metric_type="aggregate",
        )
    )
    session.add(
        CallMetricDB(
            project=project_id,
            call_id=f"span-{project_id}",
            metric_name="latency",
            metric_type="aggregate",
        )
    )
    session.add(
        LoggedCallDB(
            id=f"span-{project_id}",
            project=project_id,
            task_id="cost-inquiry",
            model="gpt-4",
            created_at=now,
            input={},
            messages=[],
            output={},
        )
    )
    session.add(
        OtlpIngestBatchDB(
            id=f"batch-otlp-{project_id}",
            project_id=project_id,
            payload="{}",
        )
    )
    session.add(
        OtlpSpanDB(
            project_id=project_id,
            trace_id=f"trace-{project_id}",
            span_id=f"span-{project_id}",
        )
    )
    session.add(
        ModelDefinitionDB(
            project=project_id,
            model_name="gpt-4",
            match_pattern="gpt-4",
            provider="openai",
        )
    )

    # Hard-FK tables that every project has.
    session.add(
        ProjectInvitationDB(
            project_id=project_id,
            email="invitee@test.com",
            role="member",
            invited_by_user_id=owner_id,
            token_hash=f"hash-{project_id}",
            expires_at=now + timedelta(days=1),
        )
    )
    session.add(
        GithubConnectionDB(
            project=project_id,
            github_user_id="gh-123",
            access_token_encrypted="enc",
        )
    )
    session.add(
        ApiKeyDB(
            id=f"key-{project_id}",
            prefix="sk-apo-test",
            project=project_id,
            created_by=owner_id,
        )
    )
    session.commit()


def _dependent_counts(session: Session, project_id: str) -> dict[str, int]:
    """Count surviving rows referencing ``project_id`` across every dependent table."""
    return {
        "memberships": len(
            session.exec(
                select(ProjectMembershipDB).where(
                    ProjectMembershipDB.project_id == project_id
                )
            ).all()
        ),
        "invitations": len(
            session.exec(
                select(ProjectInvitationDB).where(
                    ProjectInvitationDB.project_id == project_id
                )
            ).all()
        ),
        "task_sources": len(
            session.exec(
                select(ProjectTaskSourceDB).where(
                    ProjectTaskSourceDB.project == project_id
                )
            ).all()
        ),
        "inventory": len(
            session.exec(
                select(ProjectTaskInventoryDB).where(
                    ProjectTaskInventoryDB.project == project_id
                )
            ).all()
        ),
        "github_connections": len(
            session.exec(
                select(GithubConnectionDB).where(
                    GithubConnectionDB.project == project_id
                )
            ).all()
        ),
        "api_keys": len(
            session.exec(
                select(ApiKeyDB).where(ApiKeyDB.project == project_id)
            ).all()
        ),
        "runs": len(
            session.exec(
                select(RunDB).where(RunDB.project == project_id)
            ).all()
        ),
        "run_metrics": len(
            session.exec(
                select(RunMetricDB).where(RunMetricDB.project == project_id)
            ).all()
        ),
        "call_metrics": len(
            session.exec(
                select(CallMetricDB).where(CallMetricDB.project == project_id)
            ).all()
        ),
        "logged_calls": len(
            session.exec(
                select(LoggedCallDB).where(LoggedCallDB.project == project_id)
            ).all()
        ),
        "otlp_spans": len(
            session.exec(
                select(OtlpSpanDB).where(OtlpSpanDB.project_id == project_id)
            ).all()
        ),
        "otlp_ingest_batches": len(
            session.exec(
                select(OtlpIngestBatchDB).where(
                    OtlpIngestBatchDB.project_id == project_id
                )
            ).all()
        ),
        "schedules": len(
            session.exec(
                select(AgentTaskScheduleDB).where(
                    AgentTaskScheduleDB.project == project_id
                )
            ).all()
        ),
        "score_configs": len(
            session.exec(
                select(ScoreConfigDB).where(ScoreConfigDB.project == project_id)
            ).all()
        ),
        "annotation_queues": len(
            session.exec(
                select(AnnotationQueueDB).where(
                    AnnotationQueueDB.project == project_id
                )
            ).all()
        ),
        "webhooks": len(
            session.exec(
                select(WebhookDB).where(WebhookDB.project == project_id)
            ).all()
        ),
        "comments": len(
            session.exec(
                select(CommentDB).where(CommentDB.project_id == project_id)
            ).all()
        ),
        "model_definitions": len(
            session.exec(
                select(ModelDefinitionDB).where(
                    ModelDefinitionDB.project == project_id
                )
            ).all()
        ),
    }


def _authed_client(
    make_authed_client: Any, user: UserDB, session: Session
) -> TestClient:
    return make_authed_client(user.id, session)


# ---------------------------------------------------------------------------
# delete_project cascade
# ---------------------------------------------------------------------------


class TestDeleteProjectCascade:
    def test_delete_cascades_to_all_dependents(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@delete.test")
        project = _make_project(session, owner, "proj-delete")
        _seed_full_project(session, project.id, owner.id)

        # Sanity: dependents exist before the delete.
        before = _dependent_counts(session, project.id)
        assert all(count >= 1 for count in before.values()), before

        authed = _authed_client(make_authed_client, owner, session)
        resp = authed.delete(f"/v1/projects/{project.id}")

        assert resp.status_code == 200, resp.text
        assert resp.json() == {"ok": True}

        # The project row itself is gone.
        assert session.get(ProjectDB, project.id) is None

        # Every dependent table is empty for this project. A non-zero count
        # here means the cascade missed a table — add it to delete_project_data.
        after = _dependent_counts(session, project.id)
        leftovers = {k: v for k, v in after.items() if v > 0}
        assert leftovers == {}, f"orphaned rows after delete: {leftovers}"

    def test_delete_demo_project_rejected(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "demo-guard@delete.test")
        authed = _authed_client(make_authed_client, owner, session)
        resp = authed.delete("/v1/projects/demo")
        assert resp.status_code == 400

    def test_member_cannot_delete(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner2@delete.test")
        project = _make_project(session, owner, "proj-rbac")
        member = _make_user(session, "member@delete.test")

        from apo.services.project_memberships import add_member

        add_member(
            session,
            project_id=project.id,
            email="member@delete.test",
            role="member",
            actor_role="owner",
        )

        authed = _authed_client(make_authed_client, member, session)
        resp = authed.delete(f"/v1/projects/{project.id}")
        assert resp.status_code == 403
        # Project survived the rejected delete.
        assert session.get(ProjectDB, project.id) is not None


# ---------------------------------------------------------------------------
# reset_project_data semantics (shares the cascade)
# ---------------------------------------------------------------------------


class TestResetProjectData:
    def test_reset_clears_observation_data_but_keeps_project_and_api_keys(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner3@reset.test")
        project = _make_project(session, owner, "proj-reset")
        _seed_full_project(session, project.id, owner.id)

        authed = _authed_client(make_authed_client, owner, session)
        resp = authed.post(f"/v1/projects/{project.id}/reset-data")

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        # The deleted map lists at least the observation tables it cleared.
        assert body["deleted"]["runs"] >= 1
        assert body["deleted"]["agent_task_batch_runs"] >= 1

        # The project shell survives reset.
        assert session.get(ProjectDB, project.id) is not None
        # API keys are kept by reset (the owner's credentials stay valid).
        assert (
            len(
                session.exec(
                    select(ApiKeyDB).where(ApiKeyDB.project == project.id)
                ).all()
            )
            >= 1
        )
        # But observation data is gone.
        assert (
            len(
                session.exec(
                    select(RunDB).where(RunDB.project == project.id)
                ).all()
            )
            == 0
        )
        assert (
            len(
                session.exec(
                    select(AgentTaskBatchRunDB).where(
                        AgentTaskBatchRunDB.project == project.id
                    )
                ).all()
            )
            == 0
        )
