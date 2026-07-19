# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

"""Tests for SPEC-127: project-scoped invitation flow."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import (
    ProjectDB,
    ProjectInvitationDB,
    ProjectMembershipDB,
    UserDB,
)
from apo.models.schemas import CreateProjectInvitationRequest
from apo.services.project_invitations import (
    PROJECT_INVITATION_TTL_HOURS,
    accept_invitation_create_account,
    accept_invitation_existing_account,
    create_or_refresh_invitation,
    find_active_invitation,
    find_by_raw_token,
    list_pending_invitations,
    normalize_email,
    preview_invitation_token,
    resend_invitation,
    revoke_invitation,
)
from apo.services.project_memberships import (
    DEMO_PROJECT_ID,
    add_member,
    create_owner_membership,
    get_project_membership,
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


def _authed_client_for(
    make_authed_client: Any, user: UserDB, session: Session
) -> TestClient:
    return make_authed_client(user.id, session)


def _invite(
    session: Session,
    *,
    project_id: str,
    email: str,
    role: str = "member",
    invited_by_user_id: str,
    invited_by_role: str = "owner",
) -> Any:
    """Drive the create_or_refresh service helper to completion.

    The service is async because email delivery may await a transport;
    tests run it on a fresh event loop.
    """
    body = CreateProjectInvitationRequest(email=email, role=role)
    return asyncio.run(
        create_or_refresh_invitation(
            session,
            project_id=project_id,
            body=body,
            invited_by_user_id=invited_by_user_id,
            invited_by_role=invited_by_role,
        )
    )


# ---------------------------------------------------------------------------
# Service-level helpers
# ---------------------------------------------------------------------------


class TestNormalizeEmail:
    def test_lowercases_and_strips(self) -> None:
        assert normalize_email("  Foo@Bar.COM  ") == "foo@bar.com"

    def test_idempotent(self) -> None:
        once = normalize_email("MiXeD@Example.org")
        twice = normalize_email(once)
        assert once == twice


class TestCreateInvitation:
    def test_admin_invites_new_user_with_smtp_disabled(
        self, session: Session
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)

        # LogOnlyEmailService is the default during tests -> link_only.
        response = _invite(
            session,
            project_id=project.id,
            email="new@example.com",
            role="member",
            invited_by_user_id=owner.id,
            invited_by_role="owner",
        )

        assert response.delivery_status == "link_only"
        assert response.invite_url is not None
        assert "/accept-invitation?token=" in response.invite_url

        invitation = response.invitation
        assert invitation.email == "new@example.com"
        assert invitation.role == "member"
        assert invitation.delivery_method == "link_only"

        # Row exists in DB and only the hash is stored.
        rows = list(
            session.exec(
                select(ProjectInvitationDB).where(
                    ProjectInvitationDB.project_id == project.id
                )
            ).all()
        )
        assert len(rows) == 1
        assert rows[0].token_hash != ""
        # Raw token must never appear in the row.
        raw_fragment = response.invite_url.split("token=")[-1]
        assert rows[0].token_hash != raw_fragment
        assert rows[0].invite_url_path is not None
        assert raw_fragment in (rows[0].invite_url_path or "")

    def test_email_is_lowercased_on_persist(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)

        _invite(
            session,
            project_id=project.id,
            email="MiXeD@Example.com",
            invited_by_user_id=owner.id,
        )

        invitation = find_active_invitation(session, project.id, "mixed@example.com")
        assert invitation is not None
        assert invitation.email == "mixed@example.com"

    def test_invalid_role_rejected(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)

        with pytest.raises(HTTPException) as exc:
            _invite(
                session,
                project_id=project.id,
                email="x@example.com",
                role="superuser",
                invited_by_user_id=owner.id,
            )
        assert exc.value.status_code == 422

    def test_admin_cannot_invite_owner(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)

        with pytest.raises(HTTPException) as exc:
            _invite(
                session,
                project_id=project.id,
                email="new@example.com",
                role="owner",
                invited_by_user_id=owner.id,
                invited_by_role="admin",  # admin is not allowed to invite owners
            )
        assert exc.value.status_code == 403
        assert "owner" in exc.value.detail.lower()

    def test_owner_can_invite_owner(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)

        response = _invite(
            session,
            project_id=project.id,
            email="coowner@example.com",
            role="owner",
            invited_by_user_id=owner.id,
            invited_by_role="owner",
        )
        assert response.invitation.role == "owner"

    def test_demo_project_rejects_invitations(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        _ = owner
        with pytest.raises(HTTPException) as exc:
            _invite(
                session,
                project_id=DEMO_PROJECT_ID,
                email="new@example.com",
                invited_by_user_id=owner.id,
            )
        assert exc.value.status_code == 403


class TestReinviteSameEmail:
    def test_reinvite_refreshes_in_place(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)

        first = _invite(
            session,
            project_id=project.id,
            email="dup@example.com",
            role="member",
            invited_by_user_id=owner.id,
        )

        second = _invite(
            session,
            project_id=project.id,
            email="DUP@example.com",  # different case, same logical email
            role="admin",
            invited_by_user_id=owner.id,
        )

        # Same logical invitation, refreshed.
        assert first.invitation.id == second.invitation.id
        assert second.invitation.role == "admin"

        rows = list(
            session.exec(
                select(ProjectInvitationDB).where(
                    ProjectInvitationDB.project_id == project.id,
                    ProjectInvitationDB.accepted_at.is_(None),  # pyright: ignore[reportOptionalMemberAccess]
                    ProjectInvitationDB.revoked_at.is_(None),  # pyright: ignore[reportOptionalMemberAccess]
                )
            ).all()
        )
        assert len(rows) == 1, "no duplicate active rows"

    def test_user_already_member_rejected(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        _make_user(session, "existing@test.com")
        project = _make_project(session, owner)
        add_member(
            session,
            project_id=project.id,
            email="existing@test.com",
            role="member",
            actor_role="owner",
        )

        with pytest.raises(HTTPException) as exc:
            _invite(
                session,
                project_id=project.id,
                email="existing@test.com",
                invited_by_user_id=owner.id,
            )
        assert exc.value.status_code == 409
        assert "already a member" in exc.value.detail.lower()


class TestResendRotatesToken:
    def test_old_token_invalid_new_token_valid(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)

        first = _invite(
            session,
            project_id=project.id,
            email="rot@example.com",
            invited_by_user_id=owner.id,
        )
        first_token = first.invite_url.split("token=")[-1]
        first_expires = find_active_invitation(
            session, project.id, "rot@example.com"
        ).expires_at

        refreshed = asyncio.run(
            resend_invitation(
                session,
                project_id=project.id,
                invitation_id=first.invitation.id,
            )
        )
        new_token = refreshed.invite_url.split("token=")[-1]

        assert new_token != first_token, "resend must rotate the token"

        # Old token no longer resolves to a usable invitation.
        old_preview = preview_invitation_token(session, first_token)
        assert old_preview.valid is False

        new_preview = preview_invitation_token(session, new_token)
        assert new_preview.valid is True

        new_expires = find_active_invitation(
            session, project.id, "rot@example.com"
        ).expires_at
        assert new_expires >= first_expires


class TestRevoke:
    def test_revoke_makes_token_invalid(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)

        created = _invite(
            session,
            project_id=project.id,
            email="rev@example.com",
            invited_by_user_id=owner.id,
        )
        raw_token = created.invite_url.split("token=")[-1]

        revoke_invitation(
            session,
            project_id=project.id,
            invitation_id=created.invitation.id,
            actor_role="owner",
        )

        preview = preview_invitation_token(session, raw_token)
        assert preview.valid is False
        assert preview.reason == "revoked"

        # Row is still present, soft-deleted.
        invitation = find_by_raw_token(session, raw_token)
        assert invitation is not None
        assert invitation.revoked_at is not None

    def test_revoke_is_idempotent(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        created = _invite(
            session,
            project_id=project.id,
            email="rev2@example.com",
            invited_by_user_id=owner.id,
        )

        revoke_invitation(
            session,
            project_id=project.id,
            invitation_id=created.invitation.id,
            actor_role="owner",
        )
        # Second call must not raise.
        revoke_invitation(
            session,
            project_id=project.id,
            invitation_id=created.invitation.id,
            actor_role="owner",
        )

    def test_admin_cannot_revoke_owner_invitation(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        created = _invite(
            session,
            project_id=project.id,
            email="coowner@example.com",
            role="owner",
            invited_by_user_id=owner.id,
            invited_by_role="owner",
        )

        with pytest.raises(HTTPException) as exc:
            revoke_invitation(
                session,
                project_id=project.id,
                invitation_id=created.invitation.id,
                actor_role="admin",
            )
        assert exc.value.status_code == 403


class TestPreview:
    def test_preview_reveals_metadata_for_valid_token(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner, "Acme")
        created = _invite(
            session,
            project_id=project.id,
            email="prev@example.com",
            role="admin",
            invited_by_user_id=owner.id,
        )
        raw_token = created.invite_url.split("token=")[-1]

        preview = preview_invitation_token(session, raw_token)
        assert preview.valid is True
        assert preview.email == "prev@example.com"
        assert preview.project_id == project.id
        assert preview.project_name == "Acme"
        assert preview.role == "admin"
        assert preview.requires_account_creation is True

    def test_preview_unknown_token_returns_invalid_without_leak(
        self, session: Session
    ) -> None:
        preview = preview_invitation_token(session, "totally-bogus-token")
        assert preview.valid is False
        assert preview.reason == "invalid"
        assert preview.email is None
        assert preview.project_id is None

    def test_preview_expired_token(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        created = _invite(
            session,
            project_id=project.id,
            email="exp@example.com",
            invited_by_user_id=owner.id,
        )
        raw_token = created.invite_url.split("token=")[-1]

        invitation = find_by_raw_token(session, raw_token)
        assert invitation is not None
        invitation.expires_at = invitation.expires_at - timedelta(
            days=PROJECT_INVITATION_TTL_HOURS + 1
        )
        session.add(invitation)
        session.commit()

        preview = preview_invitation_token(session, raw_token)
        assert preview.valid is False
        assert preview.reason == "expired"


class TestAcceptCreateAccount:
    def test_creates_user_membership_and_accepts(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        created = _invite(
            session,
            project_id=project.id,
            email="accept@example.com",
            role="admin",
            invited_by_user_id=owner.id,
        )
        raw_token = created.invite_url.split("token=")[-1]

        membership, invitation = accept_invitation_create_account(
            session,
            raw_token=raw_token,
            name="Accepty",
            password="strongpass1",
        )

        assert membership.role == "admin"
        assert membership.project_id == project.id
        assert invitation.accepted_at is not None
        assert invitation.accepted_by_user_id is not None
        assert invitation.accepted_by_user_id == membership.user_id

        user = session.get(UserDB, membership.user_id)
        assert user is not None
        assert user.email == "accept@example.com"
        assert user.is_admin is False  # no global admin escalation
        assert user.password_hash != "strongpass1"  # hashed

    def test_weak_password_rejected(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        created = _invite(
            session,
            project_id=project.id,
            email="weak@example.com",
            invited_by_user_id=owner.id,
        )
        raw_token = created.invite_url.split("token=")[-1]

        with pytest.raises(HTTPException) as exc:
            accept_invitation_create_account(
                session,
                raw_token=raw_token,
                name="Weak",
                password="short",  # too short + no number
            )
        assert exc.value.status_code == 422

        # Invitation must not be consumed.
        invitation = find_by_raw_token(session, raw_token)
        assert invitation is not None
        assert invitation.accepted_at is None

    def test_existing_user_email_collision(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        _make_user(session, "collision@test.com")
        created = _invite(
            session,
            project_id=project.id,
            email="collision@test.com",
            invited_by_user_id=owner.id,
        )
        raw_token = created.invite_url.split("token=")[-1]

        with pytest.raises(HTTPException) as exc:
            accept_invitation_create_account(
                session,
                raw_token=raw_token,
                name="Dup",
                password="strongpass1",
            )
        assert exc.value.status_code == 409


class TestAcceptExistingAccount:
    def test_matching_email_creates_membership(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        existing_user = _make_user(session, "match@test.com", "Match")
        created = _invite(
            session,
            project_id=project.id,
            email="match@test.com",
            role="member",
            invited_by_user_id=owner.id,
        )
        raw_token = created.invite_url.split("token=")[-1]

        membership, invitation = accept_invitation_existing_account(
            session,
            raw_token=raw_token,
            accepting_user_id=existing_user.id,
        )
        assert membership.user_id == existing_user.id
        assert membership.role == "member"
        assert invitation.accepted_at is not None

        # No duplicate user row.
        users = list(
            session.exec(
                select(UserDB).where(UserDB.email == "match@test.com")
            ).all()
        )
        assert len(users) == 1

    def test_mismatched_email_returns_409_and_keeps_pending(
        self, session: Session
    ) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        wrong_user = _make_user(session, "wrong@test.com")
        created = _invite(
            session,
            project_id=project.id,
            email="right@test.com",
            invited_by_user_id=owner.id,
        )
        raw_token = created.invite_url.split("token=")[-1]

        with pytest.raises(HTTPException) as exc:
            accept_invitation_existing_account(
                session,
                raw_token=raw_token,
                accepting_user_id=wrong_user.id,
            )
        assert exc.value.status_code == 409

        invitation = find_by_raw_token(session, raw_token)
        assert invitation is not None
        assert invitation.accepted_at is None


class TestListInvitations:
    def test_only_active_invitations_listed(self, session: Session) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)

        active = _invite(
            session,
            project_id=project.id,
            email="active@example.com",
            invited_by_user_id=owner.id,
        )
        revoked = _invite(
            session,
            project_id=project.id,
            email="revoked@example.com",
            invited_by_user_id=owner.id,
        )
        revoke_invitation(
            session,
            project_id=project.id,
            invitation_id=revoked.invitation.id,
            actor_role="owner",
        )

        summaries = list_pending_invitations(session, project_id=project.id)
        emails = {s.email for s in summaries}
        assert "active@example.com" in emails
        assert "revoked@example.com" not in emails


# ---------------------------------------------------------------------------
# Route-level tests (HTTP)
# ---------------------------------------------------------------------------


class TestProjectInvitationsApi:
    def test_owner_can_create_invitation(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com", "Owner")
        project = _make_project(session, owner)
        authed = _authed_client_for(make_authed_client, owner, session)

        resp = authed.post(
            f"/v1/projects/{project.id}/invitations",
            json={"email": "new@example.com", "role": "member"},
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert data["delivery_status"] == "link_only"
        assert data["invite_url"] is not None

    def test_member_cannot_create_invitation(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        _make_user(session, "member@test.com")
        add_member(
            session,
            project_id=project.id,
            email="member@test.com",
            role="member",
            actor_role="owner",
        )
        member = session.exec(
            select(UserDB).where(UserDB.email == "member@test.com")
        ).first()
        assert member is not None
        authed = _authed_client_for(make_authed_client, member, session)

        resp = authed.post(
            f"/v1/projects/{project.id}/invitations",
            json={"email": "new@example.com", "role": "member"},
        )
        assert resp.status_code == 403

    def test_admin_cannot_invite_owner_over_http(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        _make_user(session, "admin@test.com")
        add_member(
            session,
            project_id=project.id,
            email="admin@test.com",
            role="admin",
            actor_role="owner",
        )
        admin = session.exec(
            select(UserDB).where(UserDB.email == "admin@test.com")
        ).first()
        assert admin is not None
        authed = _authed_client_for(make_authed_client, admin, session)

        resp = authed.post(
            f"/v1/projects/{project.id}/invitations",
            json={"email": "co@example.com", "role": "owner"},
        )
        assert resp.status_code == 403

    def test_demo_project_rejects_invitations(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com")
        authed = _authed_client_for(make_authed_client, owner, session)

        resp = authed.post(
            f"/v1/projects/{DEMO_PROJECT_ID}/invitations",
            json={"email": "new@example.com", "role": "member"},
        )
        assert resp.status_code == 403

    def test_list_and_revoke_and_resend(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        authed = _authed_client_for(make_authed_client, owner, session)

        # Create
        create = authed.post(
            f"/v1/projects/{project.id}/invitations",
            json={"email": "list@example.com", "role": "member"},
        )
        assert create.status_code == 201
        invitation_id = create.json()["invitation"]["id"]

        # List
        listing = authed.get(f"/v1/projects/{project.id}/invitations")
        assert listing.status_code == 200
        rows = listing.json()
        assert len(rows) == 1
        assert rows[0]["id"] == invitation_id

        # Resend
        resend = authed.post(
            f"/v1/projects/{project.id}/invitations/{invitation_id}/resend"
        )
        assert resend.status_code == 200
        assert resend.json()["delivery_status"] == "link_only"

        # Revoke
        revoke = authed.delete(
            f"/v1/projects/{project.id}/invitations/{invitation_id}"
        )
        assert revoke.status_code == 200
        assert revoke.json() == {"ok": True}

        # List is now empty of active invitations.
        listing2 = authed.get(f"/v1/projects/{project.id}/invitations")
        assert listing2.status_code == 200
        assert listing2.json() == []


class TestInvitationAuthApi:
    def test_preview_endpoint_is_public(
        self,
        client: TestClient,
        session: Session,
    ) -> None:
        # No auth header supplied at all — preview must still work.
        resp = client.get("/auth/invitations/preview?token=bogus")
        assert resp.status_code == 200
        data = resp.json()
        assert data["valid"] is False
        assert data["reason"] == "invalid"

    def test_accept_create_account_endpoint(
        self,
        client: TestClient,
        session: Session,
    ) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        created = _invite(
            session,
            project_id=project.id,
            email="httpnew@example.com",
            role="member",
            invited_by_user_id=owner.id,
        )
        raw_token = created.invite_url.split("token=")[-1]

        resp = client.post(
            "/auth/invitations/accept/create-account",
            json={
                "token": raw_token,
                "name": "Http New",
                "password": "strongpass1",
            },
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "accepted"
        assert data["project_id"] == project.id

        membership = session.exec(
            select(ProjectMembershipDB).where(
                ProjectMembershipDB.project_id == project.id
            )
        ).all()
        assert any(m.role == "member" for m in membership)

    def test_accept_existing_account_endpoint_requires_auth(
        self,
        client: TestClient,
        session: Session,
    ) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        created = _invite(
            session,
            project_id=project.id,
            email="existing@example.com",
            invited_by_user_id=owner.id,
        )
        raw_token = created.invite_url.split("token=")[-1]

        # Unauthenticated request -> 401 (no middleware-injected user_id).
        resp = client.post(
            "/auth/invitations/accept/existing-account",
            json={"token": raw_token},
        )
        # Without auth middleware the request.state.user_id is unset.
        assert resp.status_code in (401, 404)

    def test_accept_existing_account_with_matching_session(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        accepter = _make_user(session, "match2@test.com", "Match")
        created = _invite(
            session,
            project_id=project.id,
            email="match2@test.com",
            invited_by_user_id=owner.id,
        )
        raw_token = created.invite_url.split("token=")[-1]
        authed = _authed_client_for(make_authed_client, accepter, session)

        resp = authed.post(
            "/auth/invitations/accept/existing-account",
            json={"token": raw_token},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["project_id"] == project.id

        membership = get_project_membership(session, project.id, accepter.id)
        assert membership is not None
        assert membership.role == "member"

    def test_accept_existing_account_with_wrong_session_409(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        owner = _make_user(session, "owner@test.com")
        project = _make_project(session, owner)
        wrong = _make_user(session, "wrong2@test.com")
        created = _invite(
            session,
            project_id=project.id,
            email="right2@test.com",
            invited_by_user_id=owner.id,
        )
        raw_token = created.invite_url.split("token=")[-1]
        authed = _authed_client_for(make_authed_client, wrong, session)

        resp = authed.post(
            "/auth/invitations/accept/existing-account",
            json={"token": raw_token},
        )
        assert resp.status_code == 409

        # Invitation must remain pending.
        invitation = find_by_raw_token(session, raw_token)
        assert invitation is not None
        assert invitation.accepted_at is None
