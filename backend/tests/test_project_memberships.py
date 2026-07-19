# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

"""Tests for SPEC-122: project-scoped admins and membership."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import ProjectDB, ProjectMembershipDB, UserDB
from apo.services.project_memberships import (
    DEMO_PROJECT_ID,
    add_member,
    compute_permissions,
    count_owners,
    create_owner_membership,
    get_project_membership,
    require_project_member,
    require_project_role,
    require_project_role_or_legacy,
    update_member_role,
)


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _make_user(session: Session, email: str, name: str = "") -> UserDB:
    user = UserDB(
        email=email,
        name=name,
        password_hash="x",
        is_active=True,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _make_project(session: Session, creator: UserDB, name: str = "Test") -> ProjectDB:
    project = ProjectDB(
        id=f"proj-{creator.id[:8]}",
        name=name,
        created_by=creator.id,
    )
    session.add(project)
    session.commit()
    session.refresh(project)
    create_owner_membership(session, project.id, creator.id)
    return project


# ---------------------------------------------------------------------------
# Service-level tests
# ---------------------------------------------------------------------------


class TestCreateOwnerMembership:
    def test_creator_becomes_owner(self, session: Session) -> None:
        user = _make_user(session, "alice@test.com")
        project = ProjectDB(id="proj-a", name="A", created_by=user.id)
        session.add(project)
        session.commit()

        membership = create_owner_membership(session, project.id, user.id)

        assert membership.role == "owner"
        assert membership.project_id == project.id
        assert membership.user_id == user.id

        loaded = get_project_membership(session, project.id, user.id)
        assert loaded is not None
        assert loaded.role == "owner"


class TestRequireProjectRole:
    def test_owner_passes_all_roles(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        for role in ("member", "admin", "owner"):
            membership = require_project_role(
                session, project.id, owner.id, minimum_role=role
            )
            assert membership.role == "owner"

    def test_member_rejected_from_admin(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        member = _make_user(session, "member@test.com")
        add_member(
            session,
            project_id=project.id,
            email="member@test.com",
            role="member",
            actor_role="owner",
        )

        # member can pass member check
        membership = require_project_role(
            session, project.id, member.id, minimum_role="member"
        )
        assert membership.role == "member"

        # member fails admin check
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            require_project_role(
                session, project.id, member.id, minimum_role="admin"
            )
        assert exc.value.status_code == 403
        assert "admin" in exc.value.detail

    def test_non_member_rejected(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        _project = _make_project(session, owner)
        other = _make_user(session, "other@test.com")

        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            require_project_member(session, "proj-does-not-exist", other.id)
        # project exists check happens at the route layer; at service
        # layer we just see no membership.
        assert exc.value.status_code == 403

    def test_demo_returns_synthetic_member(self, session: Session) -> None:
        user = _make_user(session, "demo-user@test.com")
        membership = require_project_member(
            session, DEMO_PROJECT_ID, user.id
        )
        assert membership.role == "member"
        assert membership.project_id == DEMO_PROJECT_ID

    def test_demo_rejects_admin_role(self, session: Session) -> None:
        user = _make_user(session, "demo-admin@test.com")
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            require_project_role(
                session, DEMO_PROJECT_ID, user.id, minimum_role="admin"
            )
        assert exc.value.status_code == 403


class TestComputePermissions:
    def test_owner_has_all(self) -> None:
        perms = compute_permissions("owner")
        assert perms.role == "owner"
        assert perms.can_manage_project
        assert perms.can_manage_members
        assert perms.can_run_tasks
        assert perms.can_edit_scores

    def test_admin_can_manage(self) -> None:
        perms = compute_permissions("admin")
        assert perms.role == "admin"
        assert perms.can_manage_project
        assert perms.can_manage_members
        assert perms.can_run_tasks

    def test_member_cannot_manage(self) -> None:
        perms = compute_permissions("member")
        assert perms.role == "member"
        assert not perms.can_manage_project
        assert not perms.can_manage_members
        assert perms.can_run_tasks
        assert perms.can_edit_scores

    def test_demo_role_is_none(self) -> None:
        perms = compute_permissions(None)
        assert perms.role is None
        assert not perms.can_manage_project
        assert perms.can_manage_members is False
        assert perms.can_run_tasks  # demo is readable


class TestLastOwnerProtection:
    def test_cannot_demote_last_owner(self, session: Session) -> None:
        owner = _make_user(session, "only-owner@test.com")
        project = _make_project(session, owner)
        assert count_owners(session, project.id) == 1

        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            update_member_role(
                session,
                project_id=project.id,
                user_id=owner.id,
                new_role="admin",
                actor_id=owner.id,
                actor_role="owner",
            )
        assert exc.value.status_code == 400
        assert "last owner" in exc.value.detail.lower()

    def test_can_demote_owner_when_others_exist(self, session: Session) -> None:
        owner1 = _make_user(session, "owner1@test.com")
        project = _make_project(session, owner1)
        owner2 = _make_user(session, "owner2@test.com")
        add_member(
            session,
            project_id=project.id,
            email="owner2@test.com",
            role="member",
            actor_role="owner",
        )
        update_member_role(
            session,
            project_id=project.id,
            user_id=owner2.id,
            new_role="owner",
            actor_id=owner1.id,
            actor_role="owner",
        )
        assert count_owners(session, project.id) == 2

        # Now demote owner1
        result = update_member_role(
            session,
            project_id=project.id,
            user_id=owner1.id,
            new_role="admin",
            actor_id=owner1.id,
            actor_role="owner",
        )
        assert result.role == "admin"
        assert count_owners(session, project.id) == 1


class TestAdminCannotPromoteToOwner:
    def test_admin_cannot_promote_to_owner(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        admin = _make_user(session, "admin@test.com")
        add_member(
            session,
            project_id=project.id,
            email="admin@test.com",
            role="admin",
            actor_role="owner",
        )
        member = _make_user(session, "member@test.com")
        add_member(
            session,
            project_id=project.id,
            email="member@test.com",
            role="member",
            actor_role="owner",
        )

        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            update_member_role(
                session,
                project_id=project.id,
                user_id=member.id,
                new_role="owner",
                actor_id=admin.id,
                actor_role="admin",
            )
        assert exc.value.status_code == 403


class TestAddMember:
    def test_add_member_by_email(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        _member_user = _make_user(session, "newbie@test.com", "Newbie")

        result = add_member(
            session,
            project_id=project.id,
            email="newbie@test.com",
            role="member",
            actor_role="owner",
        )
        assert result.email == "newbie@test.com"
        assert result.role == "member"

    def test_duplicate_member_rejected(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        _member_user = _make_user(session, "dup@test.com")

        add_member(
            session,
            project_id=project.id,
            email="dup@test.com",
            role="member",
            actor_role="owner",
        )

        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            add_member(
                session,
                project_id=project.id,
                email="dup@test.com",
                role="member",
                actor_role="owner",
            )
        assert exc.value.status_code == 409

    def test_unknown_email_rejected(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)

        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            add_member(
                session,
                project_id=project.id,
                email="nonexistent@test.com",
                role="member",
                actor_role="owner",
            )
        assert exc.value.status_code == 404


class TestLegacyFallback:
    def test_legacy_project_allows_owner(self, session: Session) -> None:
        user = _make_user(session, "legacy@test.com")
        # No ProjectDB row — pure legacy / ad-hoc use
        membership = require_project_role_or_legacy(
            session, "ad-hoc-project", user.id, minimum_role="admin"
        )
        assert membership.role == "owner"
        assert membership.user_id == user.id


# ---------------------------------------------------------------------------
# API integration tests
# ---------------------------------------------------------------------------


def _authed_client_for(
    make_authed_client: Any, user: UserDB, session: Session
) -> TestClient:
    return make_authed_client(user.id, session)


class TestProjectMembersApi:
    def test_owner_can_list_members(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        authed = _authed_client_for(make_authed_client, owner, session)

        resp = authed.get(f"/v1/projects/{project.id}/members")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["email"] == "owner@test.com"
        assert data[0]["role"] == "owner"

    def test_member_cannot_list_members(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        member = _make_user(session, "member@test.com", "Member")
        add_member(
            session,
            project_id=project.id,
            email="member@test.com",
            role="member",
            actor_role="owner",
        )

        authed = _authed_client_for(make_authed_client, member, session)
        resp = authed.get(f"/v1/projects/{project.id}/members")
        assert resp.status_code == 403

    def test_owner_can_add_member(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        _newbie = _make_user(session, "newbie@test.com", "Newbie")

        authed = _authed_client_for(make_authed_client, owner, session)
        resp = authed.post(
            f"/v1/projects/{project.id}/members",
            json={"email": "newbie@test.com", "role": "member"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["email"] == "newbie@test.com"
        assert data["role"] == "member"

    def test_owner_can_promote_member(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        member = _make_user(session, "member@test.com", "Member")
        add_member(
            session,
            project_id=project.id,
            email="member@test.com",
            role="member",
            actor_role="owner",
        )

        authed = _authed_client_for(make_authed_client, owner, session)
        resp = authed.patch(
            f"/v1/projects/{project.id}/members/{member.id}",
            json={"role": "admin"},
        )
        assert resp.status_code == 200
        assert resp.json()["role"] == "admin"

    def test_owner_can_remove_member(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        member = _make_user(session, "member@test.com", "Member")
        add_member(
            session,
            project_id=project.id,
            email="member@test.com",
            role="member",
            actor_role="owner",
        )

        authed = _authed_client_for(make_authed_client, owner, session)
        resp = authed.delete(
            f"/v1/projects/{project.id}/members/{member.id}"
        )
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}

        # Confirm membership is gone
        assert get_project_membership(session, project.id, member.id) is None

    def test_cannot_remove_last_owner(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "only-owner@test.com", "Owner")
        project = _make_project(session, owner)

        authed = _authed_client_for(make_authed_client, owner, session)
        resp = authed.delete(
            f"/v1/projects/{project.id}/members/{owner.id}"
        )
        assert resp.status_code == 400
        assert "last owner" in resp.json()["detail"].lower()

    def test_demo_rejects_member_management(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        user = _make_user(session, "demo-user@test.com", "Demo")
        authed = _authed_client_for(make_authed_client, user, session)
        resp = authed.get(f"/v1/projects/{DEMO_PROJECT_ID}/members")
        assert resp.status_code == 403


class TestProjectAccess:
    def test_creator_gets_owner_role_in_response(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "creator@test.com", "Creator")
        authed = _authed_client_for(make_authed_client, owner, session)

        resp = authed.post("/v1/projects", json={"name": "My Project"})
        assert resp.status_code == 201
        data = resp.json()
        assert data["current_user_role"] == "owner"
        assert data["permissions"]["can_manage_project"] is True
        assert data["permissions"]["can_manage_members"] is True
        assert data["trace_content_policy"] == "redacted"

    def test_creator_can_explicitly_enable_full_trace_content(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "trace-owner@test.com", "Trace Owner")
        authed = _authed_client_for(make_authed_client, owner, session)
        created = authed.post("/v1/projects", json={"name": "Traces"})
        project_id = created.json()["id"]

        updated = authed.patch(
            f"/v1/projects/{project_id}",
            json={"trace_content_policy": "full"},
        )

        assert updated.status_code == 200
        assert updated.json()["trace_content_policy"] == "full"
        project = session.get(ProjectDB, project_id)
        assert project is not None
        session.refresh(project)
        assert project.trace_content_policy == "full"

    def test_member_cannot_change_trace_content_policy(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "policy-owner@test.com", "Owner")
        project = _make_project(session, owner)
        member = _make_user(session, "policy-member@test.com", "Member")
        add_member(
            session,
            project_id=project.id,
            email=member.email,
            role="member",
            actor_role="owner",
        )
        authed = _authed_client_for(make_authed_client, member, session)

        response = authed.patch(
            f"/v1/projects/{project.id}",
            json={"trace_content_policy": "full"},
        )

        assert response.status_code == 403

    def test_member_can_view_project(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        member = _make_user(session, "member@test.com", "Member")
        add_member(
            session,
            project_id=project.id,
            email="member@test.com",
            role="member",
            actor_role="owner",
        )

        authed = _authed_client_for(make_authed_client, member, session)
        resp = authed.get(f"/v1/projects/{project.id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["current_user_role"] == "member"
        assert data["permissions"]["can_manage_project"] is False
        assert data["permissions"]["can_manage_members"] is False
        assert data["permissions"]["can_run_tasks"] is True

    def test_non_member_cannot_view_project(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        other = _make_user(session, "other@test.com", "Other")

        authed = _authed_client_for(make_authed_client, other, session)
        resp = authed.get(f"/v1/projects/{project.id}")
        assert resp.status_code == 403

    def test_list_returns_only_member_projects(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        _project_a = _make_project(session, owner)
        # Create another project this user doesn't own
        other_owner = _make_user(session, "other@test.com")
        _project_b = _make_project(session, other_owner, "Other")

        authed = _authed_client_for(make_authed_client, owner, session)
        resp = authed.get("/v1/projects")
        assert resp.status_code == 200
        data = resp.json()
        project_ids = [p["id"] for p in data]
        # Should include own project + demo, but not other's project
        assert any(p_id.startswith("proj-") for p_id in project_ids)
        assert all(p["id"] != _project_b.id for p in data)


class TestProjectDeleteRoleCheck:
    def test_member_cannot_delete_project(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        member = _make_user(session, "member@test.com", "Member")
        add_member(
            session,
            project_id=project.id,
            email="member@test.com",
            role="member",
            actor_role="owner",
        )

        authed = _authed_client_for(make_authed_client, member, session)
        resp = authed.delete(f"/v1/projects/{project.id}")
        assert resp.status_code == 403

    def test_admin_cannot_delete_project(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        admin = _make_user(session, "admin@test.com", "Admin")
        add_member(
            session,
            project_id=project.id,
            email="admin@test.com",
            role="admin",
            actor_role="owner",
        )

        authed = _authed_client_for(make_authed_client, admin, session)
        resp = authed.delete(f"/v1/projects/{project.id}")
        assert resp.status_code == 403

    def test_owner_can_delete_project(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)

        authed = _authed_client_for(make_authed_client, owner, session)
        resp = authed.delete(f"/v1/projects/{project.id}")
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}


class TestSetupNoLongerGrantsAdmin:
    def test_first_user_is_not_auto_admin(
        self, client: TestClient, session: Session
    ) -> None:
        """SPEC-122: ``/auth/setup`` must not grant product-admin to the first user."""
        resp = client.post(
            "/auth/setup",
            json={
                "email": "first@test.com",
                "password": "Password123",
                "name": "First",
            },
        )
        assert resp.status_code == 200

        user = session.exec(select(UserDB)).first()
        assert user is not None
        assert user.is_admin is False


# ---------------------------------------------------------------------------
# Read-side authorization regression tests
# ---------------------------------------------------------------------------
#
# These tests pin down the gaps the post-implementation review found:
# ordinary members must not be able to enumerate API keys, webhooks, or
# annotation queues for projects where they lack the management role.


class TestApiKeyListAdminScoped:
    """SPEC-122: API key inventory is admin-scoped."""

    def test_member_cannot_list_keys_for_project(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        member = _make_user(session, "member@test.com", "Member")
        add_member(
            session,
            project_id=project.id,
            email="member@test.com",
            role="member",
            actor_role="owner",
        )
        # Owner creates a key
        owner_client = _authed_client_for(make_authed_client, owner, session)
        create_resp = owner_client.post(
            "/v1/api-keys",
            json={"name": "Owner key", "project": project.id},
        )
        assert create_resp.status_code == 200

        member_client = _authed_client_for(
            make_authed_client, member, session
        )
        resp = member_client.get(
            "/v1/api-keys", params={"project": project.id}
        )
        assert resp.status_code == 403, (
            "members must not enumerate keys for a project"
        )

    def test_admin_can_list_keys_for_project(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        admin = _make_user(session, "admin@test.com", "Admin")
        add_member(
            session,
            project_id=project.id,
            email="admin@test.com",
            role="admin",
            actor_role="owner",
        )
        owner_client = _authed_client_for(make_authed_client, owner, session)
        create_resp = owner_client.post(
            "/v1/api-keys",
            json={"name": "Owner key", "project": project.id},
        )
        assert create_resp.status_code == 200

        admin_client = _authed_client_for(
            make_authed_client, admin, session
        )
        resp = admin_client.get(
            "/v1/api-keys", params={"project": project.id}
        )
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    def test_unscoped_list_excludes_member_only_projects(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        member = _make_user(session, "member@test.com", "Member")
        add_member(
            session,
            project_id=project.id,
            email="member@test.com",
            role="member",
            actor_role="owner",
        )
        owner_client = _authed_client_for(make_authed_client, owner, session)
        create_resp = owner_client.post(
            "/v1/api-keys",
            json={"name": "Owner key", "project": project.id},
        )
        assert create_resp.status_code == 200

        member_client = _authed_client_for(
            make_authed_client, member, session
        )
        resp = member_client.get("/v1/api-keys")
        assert resp.status_code == 200
        # Member is not admin anywhere; unscoped list should not surface
        # keys for the project they're only a member of.
        assert all(
            k["project"] != project.id for k in resp.json()
        ), "members must not see keys for member-only projects in unscoped list"


class TestWebhookReadAdminScoped:
    """SPEC-122: webhook inventory is admin-scoped."""

    def test_member_cannot_list_webhooks(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        member = _make_user(session, "member@test.com", "Member")
        add_member(
            session,
            project_id=project.id,
            email="member@test.com",
            role="member",
            actor_role="owner",
        )
        owner_client = _authed_client_for(make_authed_client, owner, session)
        create_resp = owner_client.post(
            "/v1/webhooks",
            json={"project": project.id, "url": "https://example.com/hook"},
        )
        assert create_resp.status_code == 201

        member_client = _authed_client_for(
            make_authed_client, member, session
        )
        resp = member_client.get(
            "/v1/webhooks", params={"project": project.id}
        )
        assert resp.status_code == 403, (
            "members must not enumerate webhooks for a project"
        )

    def test_member_cannot_get_webhook_by_id(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        member = _make_user(session, "member@test.com", "Member")
        add_member(
            session,
            project_id=project.id,
            email="member@test.com",
            role="member",
            actor_role="owner",
        )
        owner_client = _authed_client_for(make_authed_client, owner, session)
        create_resp = owner_client.post(
            "/v1/webhooks",
            json={"project": project.id, "url": "https://example.com/hook"},
        )
        assert create_resp.status_code == 201
        webhook_id = create_resp.json()["id"]

        member_client = _authed_client_for(
            make_authed_client, member, session
        )
        resp = member_client.get(f"/v1/webhooks/{webhook_id}")
        assert resp.status_code == 403, (
            "members must not read webhook details by id"
        )


class TestAnnotationQueueListScoped:
    """SPEC-122: annotation queue inventory must respect project boundary."""

    def test_member_can_list_queues_for_their_project(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        # Members need to see queues to work on annotations.
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        member = _make_user(session, "member@test.com", "Member")
        add_member(
            session,
            project_id=project.id,
            email="member@test.com",
            role="member",
            actor_role="owner",
        )
        owner_client = _authed_client_for(make_authed_client, owner, session)
        create_resp = owner_client.post(
            "/api/v1/annotations/queues",
            json={
                "project": project.id,
                "name": "Review queue",
                "target_type": "TRACE",
            },
        )
        assert create_resp.status_code == 200

        member_client = _authed_client_for(
            make_authed_client, member, session
        )
        resp = member_client.get(
            "/api/v1/annotations/queues", params={"project": project.id}
        )
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    def test_non_member_cannot_list_queues(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        other = _make_user(session, "other@test.com", "Other")

        other_client = _authed_client_for(make_authed_client, other, session)
        resp = other_client.get(
            "/api/v1/annotations/queues", params={"project": project.id}
        )
        assert resp.status_code == 403

    def test_unscoped_list_excludes_unrelated_projects(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner_a = _make_user(session, "owner-a@test.com", "Owner A")
        project_a = _make_project(session, owner_a, "Project A")
        owner_b = _make_user(session, "owner-b@test.com", "Owner B")
        project_b = _make_project(session, owner_b, "Project B")

        owner_a_client = _authed_client_for(
            make_authed_client, owner_a, session
        )
        owner_a_client.post(
            "/api/v1/annotations/queues",
            json={
                "project": project_a.id,
                "name": "A queue",
                "target_type": "TRACE",
            },
        )
        owner_b_client = _authed_client_for(
            make_authed_client, owner_b, session
        )
        owner_b_client.post(
            "/api/v1/annotations/queues",
            json={
                "project": project_b.id,
                "name": "B queue",
                "target_type": "TRACE",
            },
        )

        # Owner A's unscoped list must NOT include project B's queue.
        resp = owner_a_client.get("/api/v1/annotations/queues")
        assert resp.status_code == 200
        queue_projects = {q["project"] for q in resp.json()}
        assert project_a.id in queue_projects
        assert project_b.id not in queue_projects
