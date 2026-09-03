# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnusedCallResult=false, reportUnusedImport=false, reportUnusedParameter=false

"""Tests for project-scoped admins and membership."""

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
        assert exc.value.status_code == 403  # pyright: ignore[reportAttributeAccessIssue]
        assert "admin" in exc.value.detail  # pyright: ignore[reportAttributeAccessIssue]

    def test_non_member_rejected(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        _project = _make_project(session, owner)
        other = _make_user(session, "other@test.com")

        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            require_project_member(session, "proj-does-not-exist", other.id)
        # project exists check happens at the route layer; at service
        # layer we just see no membership.
        assert exc.value.status_code == 403  # pyright: ignore[reportAttributeAccessIssue]

    def test_demo_returns_synthetic_viewer(self, session: Session) -> None:
        user = _make_user(session, "demo-user@test.com")
        membership = require_project_member(
            session, DEMO_PROJECT_ID, user.id
        )
        assert membership.role == "viewer"
        assert membership.project_id == DEMO_PROJECT_ID

    def test_demo_read_floor_accepts_viewer(self, session: Session) -> None:
        user = _make_user(session, "demo-viewer@test.com")
        membership = require_project_role(
            session, DEMO_PROJECT_ID, user.id, minimum_role="viewer"
        )
        assert membership.role == "viewer"

    def test_demo_rejects_admin_role(self, session: Session) -> None:
        user = _make_user(session, "demo-admin@test.com")
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            require_project_role(
                session, DEMO_PROJECT_ID, user.id, minimum_role="admin"
            )
        assert exc.value.status_code == 403  # pyright: ignore[reportAttributeAccessIssue]


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
        # None is now only the unknown-role fallback: nothing allowed.
        perms = compute_permissions(None)
        assert perms.role is None
        assert not perms.can_manage_project
        assert perms.can_manage_members is False
        assert not perms.can_run_tasks
        assert not perms.can_edit_scores

    def test_viewer_is_read_only(self) -> None:
        perms = compute_permissions("viewer")
        assert perms.role == "viewer"
        assert not perms.can_manage_project
        assert not perms.can_manage_members
        assert not perms.can_run_tasks
        assert not perms.can_edit_scores

    def test_viewer_passes_viewer_floor_but_not_member(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        viewer = _make_user(session, "viewer@test.com")
        add_member(
            session,
            project_id=project.id,
            email="viewer@test.com",
            role="viewer",
            actor_role="owner",
        )
        membership = require_project_role(
            session, project.id, viewer.id, minimum_role="viewer"
        )
        assert membership.role == "viewer"

        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            require_project_role(session, project.id, viewer.id, minimum_role="member")
        assert exc.value.status_code == 403  # pyright: ignore[reportAttributeAccessIssue]


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
        assert exc.value.status_code == 400  # pyright: ignore[reportAttributeAccessIssue]
        assert "last owner" in exc.value.detail.lower()  # pyright: ignore[reportAttributeAccessIssue]

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
        assert exc.value.status_code == 403  # pyright: ignore[reportAttributeAccessIssue]


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
        assert exc.value.status_code == 409  # pyright: ignore[reportAttributeAccessIssue]

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
        assert exc.value.status_code == 404  # pyright: ignore[reportAttributeAccessIssue]


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


# ---------------------------------------------------------------------------
# Read-side authorization regression tests
# ---------------------------------------------------------------------------
#
# These tests pin down the gaps the post-implementation review found:
# ordinary members must not be able to enumerate API keys or webhooks
# for projects where they lack the management role.


class TestApiKeyListAdminScoped:
    """API key inventory is admin-scoped."""

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
    """Webhook inventory is admin-scoped."""

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
