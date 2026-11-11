# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnusedCallResult=false, reportUnusedParameter=false, reportUnusedVariable=false, reportAttributeAccessIssue=false, reportUntypedFunctionDecorator=false, reportUnknownParameterType=false, reportUnusedImport=false, reportUnknownVariableType=false, reportCallIssue=false

"""Invite-only hosted access provisioning.

One invitation admits one person to the installation; acceptance
materializes exactly one invitee-owned Project. Admission never touches
an existing Project, never grants the issuer membership, and is atomic
under failure and replay.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import timedelta
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.auth.rate_limit import LoginRateLimiter
from apo.models.db import (
    HostedAccessInvitationDB,
    ProjectDB,
    ProjectMembershipDB,
    RunDB,
    UserDB,
)
from apo.services import hosted_access_invitations as svc
from apo.services.hosted_access_invitations import (
    accept_hosted_access_create_account,
    accept_hosted_access_existing_account,
    create_or_refresh_hosted_access_invitation,
    list_hosted_access_invitations,
    preview_hosted_access_invitation,
    resend_hosted_access_invitation,
    revoke_hosted_access_invitation,
)


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------


def _make_user(
    session: Session,
    email: str,
    *,
    name: str = "User",
    is_admin: bool = False,
) -> UserDB:
    user = UserDB(
        email=email,
        name=name,
        password_hash="x",
        is_admin=is_admin,
        is_active=True,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _make_project(session: Session, owner: UserDB, name: str = "Company") -> ProjectDB:
    project = ProjectDB(id=f"proj-{uuid4().hex[:8]}", name=name, created_by=owner.id)
    session.add(project)
    membership = ProjectMembershipDB(
        project_id=project.id, user_id=owner.id, role="owner"
    )
    session.add(membership)
    session.commit()
    session.refresh(project)
    return project


def _invite(session: Session, *, email: str, admin: UserDB) -> Any:
    return asyncio.run(
        create_or_refresh_hosted_access_invitation(
            session, email=email, invited_by_user_id=admin.id
        )
    )


def _accept_new(
    session: Session,
    *,
    token: str,
    name: str = "Invitee",
    password: str = "correct horse battery staple 7",
    project_name: str = "My Project",
) -> Any:
    return accept_hosted_access_create_account(
        session,
        raw_token=token,
        name=name,
        password=password,
        project_name=project_name,
    )


def _counts(session: Session) -> tuple[int, int, int]:
    users = len(session.exec(select(UserDB)).all())
    projects = len(session.exec(select(ProjectDB)).all())
    memberships = len(session.exec(select(ProjectMembershipDB)).all())
    return users, projects, memberships


def _plain_client(session: Session) -> Any:
    """Unauthenticated client against the registered app with the test session.

    Mirrors the conftest ``make_authed_client`` pattern minus the injected
    identity — public hosted-access endpoints authenticate by bearer token.
    """
    from fastapi import FastAPI

    from apo.api import app
    from apo.db import get_session

    new_app = FastAPI()
    new_app.include_router(app.router)
    new_app.dependency_overrides[get_session] = lambda: session
    return TestClient(new_app)


# ---------------------------------------------------------------------------
# Issue / refresh / revoke / resend lifecycle
# ---------------------------------------------------------------------------


class TestIssueLifecycle:
    def test_issuing_creates_no_user_project_or_membership(
        self, session: Session
    ) -> None:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        company = _make_project(session, admin)
        before = _counts(session)

        response = _invite(session, email=" NewUser@Example.COM ", admin=admin)

        after = _counts(session)
        assert before == after, "issuing admission must not create rows"

        rows = session.exec(select(HostedAccessInvitationDB)).all()
        assert len(rows) == 1
        row = rows[0]
        assert row.email == "newuser@example.com", "email is normalized on write"
        assert row.invited_by_user_id == admin.id
        assert row.accepted_at is None and row.revoked_at is None

        # only the SHA-256 of the token is stored, never the raw value
        raw_url = response.invite_url or ""
        raw_token = raw_url.split("token=")[-1] if raw_url else ""
        assert raw_token, "link-only fallback must surface the URL once"
        assert row.token_hash == hashlib.sha256(raw_token.encode()).hexdigest()
        assert row.token_hash != raw_token
        assert response.delivery_status == "link_only"

    def test_same_email_refreshes_active_invitation(self, session: Session) -> None:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        first = _invite(session, email="friend@example.com", admin=admin)
        first_token = (first.invite_url or "").split("token=")[-1]

        second = _invite(session, email="FRIEND@example.com", admin=admin)

        rows = session.exec(select(HostedAccessInvitationDB)).all()
        assert len(rows) == 1, "one active row per email"
        second_token = (second.invite_url or "").split("token=")[-1]
        assert second_token and second_token != first_token, "token rotates"
        assert rows[0].expires_at > first.invitation.expires_at - timedelta(
            minutes=1
        ), "expiry refreshes"

        # the superseded token must no longer preview as valid
        preview = preview_hosted_access_invitation(session, first_token)
        assert preview.valid is False

    def test_list_returns_summaries_with_audit_fields(
        self, session: Session
    ) -> None:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        _invite(session, email="a@example.com", admin=admin)
        summaries = list_hosted_access_invitations(session)
        assert len(summaries) == 1
        assert summaries[0].email == "a@example.com"
        assert summaries[0].invited_by_user_id == admin.id
        assert summaries[0].accepted_project_id is None

    def test_invalid_email_rejected(self, session: Session) -> None:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc:
            _invite(session, email="not-an-email", admin=admin)
        assert exc.value.status_code == 422

    def test_revoke_is_idempotent_and_invalidates(
        self, session: Session
    ) -> None:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        created = _invite(session, email="gone@example.com", admin=admin)
        token = (created.invite_url or "").split("token=")[-1]

        revoke_hosted_access_invitation(session, invitation_id=created.invitation.id)
        revoke_hosted_access_invitation(session, invitation_id=created.invitation.id)

        preview = preview_hosted_access_invitation(session, token)
        assert preview.valid is False
        assert preview.reason == "revoked"
        assert preview.email is None, "revoked token reveals no data"

        rows = session.exec(select(HostedAccessInvitationDB)).all()
        assert rows[0].revoked_at is not None

    def test_expired_invitation_rejected_but_resendable(
        self, session: Session
    ) -> None:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        created = _invite(session, email="late@example.com", admin=admin)
        row = session.get(HostedAccessInvitationDB, created.invitation.id)
        assert row is not None
        row.expires_at = row.expires_at - timedelta(days=30)
        session.add(row)
        session.commit()

        preview = preview_hosted_access_invitation(
            session, (created.invite_url or "").split("token=")[-1]
        )
        assert preview.valid is False
        assert preview.reason == "expired"

        # expired rows stay visible to the administrator and may be resent
        summaries = list_hosted_access_invitations(session)
        assert len(summaries) == 1

        resent = asyncio.run(
            resend_hosted_access_invitation(
                session, invitation_id=created.invitation.id
            )
        )
        new_token = (resent.invite_url or "").split("token=")[-1]
        assert preview_hosted_access_invitation(session, new_token).valid is True
        # the old (expired) token stays dead
        old_preview = preview_hosted_access_invitation(
            session, (created.invite_url or "").split("token=")[-1]
        )
        assert old_preview.valid is False

    def test_unknown_token_preview_is_generic(self, session: Session) -> None:
        preview = preview_hosted_access_invitation(session, "no-such-token")
        assert preview.valid is False
        assert preview.reason == "invalid"
        assert preview.email is None


# ---------------------------------------------------------------------------
# Acceptance: atomicity and shape
# ---------------------------------------------------------------------------


class TestAcceptNewUser:
    def _seed_and_invite(self, session: Session) -> tuple[UserDB, str]:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        created = _invite(session, email="invitee@example.com", admin=admin)
        token = (created.invite_url or "").split("token=")[-1]
        return admin, token

    def test_acceptance_creates_user_project_owner_membership(
        self, session: Session
    ) -> None:
        admin, token = self._seed_and_invite(session)

        result = _accept_new(session, token=token, project_name="Fresh Start")

        user = session.exec(
            select(UserDB).where(UserDB.email == "invitee@example.com")
        ).one()
        assert user.is_admin is False
        assert user.is_active is True

        project = session.get(ProjectDB, result.project_id)
        assert project is not None
        assert project.name == "Fresh Start"

        memberships = session.exec(
            select(ProjectMembershipDB).where(
                ProjectMembershipDB.project_id == result.project_id
            )
        ).all()
        assert len(memberships) == 1
        assert memberships[0].user_id == user.id
        assert memberships[0].role == "owner"
        # invariant: the issuer gains no membership anywhere
        admin_memberships = session.exec(
            select(ProjectMembershipDB).where(
                ProjectMembershipDB.user_id == admin.id
            )
        ).all()
        assert admin_memberships == [], "issuer must not join the new Project"

    @pytest.mark.parametrize(
        "stage",
        ["_stage_new_user", "_stage_project", "_stage_owner_membership"],
    )
    def test_failure_after_any_stage_rolls_back_everything(
        self, session: Session, monkeypatch: pytest.MonkeyPatch, stage: str
    ) -> None:
        from fastapi import HTTPException

        admin, token = self._seed_and_invite(session)
        before = _counts(session)

        real = getattr(svc, stage)
        calls: list[str] = []

        def exploding(*args: Any, **kwargs: Any) -> Any:
            calls.append(stage)
            real(*args, **kwargs)
            raise RuntimeError("injected failure after staging")

        monkeypatch.setattr(svc, stage, exploding)
        with pytest.raises(RuntimeError):
            _accept_new(session, token=token)
        assert calls, f"failure was never injected into {stage}"

        assert _counts(session) == before, f"{stage} failure left partial rows"
        rows = session.exec(select(HostedAccessInvitationDB)).all()
        assert rows[0].accepted_at is None, "invitation must survive a failed accept"

        # the invitation is still usable after the failure
        monkeypatch.setattr(svc, stage, real)
        result = _accept_new(session, token=token)
        users, projects, memberships = _counts(session)
        assert users == before[0] + 1
        assert projects == before[1] + 1
        assert memberships == before[2] + 1
        assert result.status == "accepted"

    def test_replayed_accept_conflicts_and_creates_nothing(
        self, session: Session
    ) -> None:
        from fastapi import HTTPException

        _admin, token = self._seed_and_invite(session)
        first = _accept_new(session, token=token)
        after_first = _counts(session)

        with pytest.raises(HTTPException) as exc:
            _accept_new(session, token=token)
        assert exc.value.status_code in (404, 409)

        assert _counts(session) == after_first, "replay created duplicate rows"
        rows = session.exec(select(HostedAccessInvitationDB)).all()
        assert rows[0].accepted_project_id == first.project_id

    def test_existing_email_on_create_account_conflicts(
        self, session: Session
    ) -> None:
        from fastapi import HTTPException

        _make_user(session, "invitee@example.com")
        admin = _make_user(session, "admin@example.com", is_admin=True)
        created = _invite(session, email="invitee@example.com", admin=admin)
        token = (created.invite_url or "").split("token=")[-1]

        with pytest.raises(HTTPException) as exc:
            _accept_new(session, token=token)
        assert exc.value.status_code == 409

    def test_weak_password_and_blank_fields_rejected(
        self, session: Session
    ) -> None:
        from fastapi import HTTPException

        _admin, token = self._seed_and_invite(session)

        for kwargs in (
            {"password": "short1"},
            {"name": "   "},
            {"project_name": "   "},
        ):
            with pytest.raises(HTTPException) as exc:
                _accept_new(session, token=token, **kwargs)
            assert exc.value.status_code == 422, kwargs

        # nothing was consumed by the invalid attempts
        result = _accept_new(session, token=token)
        assert result.status == "accepted"

    def test_accepted_token_preview_reports_accepted(
        self, session: Session
    ) -> None:
        _admin, token = self._seed_and_invite(session)
        _accept_new(session, token=token)

        preview = preview_hosted_access_invitation(session, token)
        assert preview.valid is False
        assert preview.reason == "accepted"


class TestAcceptExistingUser:
    def _seed(self, session: Session) -> tuple[str, UserDB]:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        existing = _make_user(session, "known@example.com", name="Known")
        created = _invite(session, email="known@example.com", admin=admin)
        token = (created.invite_url or "").split("token=")[-1]
        return token, existing

    def test_matching_email_accepts_into_new_project(
        self, session: Session
    ) -> None:
        token, existing = self._seed(session)
        users_before = len(session.exec(select(UserDB)).all())

        result = accept_hosted_access_existing_account(
            session,
            raw_token=token,
            accepting_user_id=existing.id,
            project_name="Second Brain",
        )

        assert result.status == "accepted"
        assert (
            len(session.exec(select(UserDB)).all()) == users_before
        ), "no duplicate user"
        membership = session.exec(
            select(ProjectMembershipDB).where(
                ProjectMembershipDB.project_id == result.project_id
            )
        ).one()
        assert membership.user_id == existing.id
        assert membership.role == "owner"

    def test_mismatched_email_conflicts_and_consumes_nothing(
        self, session: Session
    ) -> None:
        from fastapi import HTTPException

        token, _existing = self._seed(session)
        other = _make_user(session, "other@example.com")

        with pytest.raises(HTTPException) as exc:
            accept_hosted_access_existing_account(
                session,
                raw_token=token,
                accepting_user_id=other.id,
                project_name="Not Yours",
            )
        assert exc.value.status_code == 409

        rows = session.exec(select(HostedAccessInvitationDB)).all()
        assert rows[0].accepted_at is None, "mismatch consumed the invitation"
        assert session.exec(select(ProjectDB)).all() == [], "mismatch created a Project"


# ---------------------------------------------------------------------------
# Token hygiene
# ---------------------------------------------------------------------------


class TestTokenHygiene:
    def test_raw_token_never_persisted_or_logged(
        self, session: Session, caplog: pytest.LogCaptureFixture
    ) -> None:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        with caplog.at_level(logging.DEBUG, logger="apo.services.hosted_access_invitations"):
            created = _invite(session, email="spy@example.com", admin=admin)
            token = (created.invite_url or "").split("token=")[-1]
            assert token

        rows = session.exec(select(HostedAccessInvitationDB)).all()
        for row in rows:
            for field in (
                row.token_hash,
                row.email,
                row.id,
                row.invited_by_user_id or "",
            ):
                assert token not in field
        for record in caplog.records:
            assert token not in record.getMessage()


# ---------------------------------------------------------------------------
# Registered-route scenes
# ---------------------------------------------------------------------------


class TestAdminRoutes:
    def test_admin_manages_full_lifecycle(
        self, session: Session, make_authed_client: Any
    ) -> None:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        client: TestClient = make_authed_client(admin.id, session)

        listed = client.get("/v1/admin/hosted-access-invitations")
        assert listed.status_code == 200
        assert listed.json() == []

        created = client.post(
            "/v1/admin/hosted-access-invitations", json={"email": "Route@Example.com"}
        )
        assert created.status_code in (200, 201)
        body = created.json()
        assert body["invitation"]["email"] == "route@example.com"
        invitation_id = body["invitation"]["id"]
        assert body["invite_url"], "link-only fallback carries the URL once"

        resent = client.post(
            f"/v1/admin/hosted-access-invitations/{invitation_id}/resend"
        )
        assert resent.status_code == 200
        assert resent.json()["invite_url"]

        revoked = client.delete(
            f"/v1/admin/hosted-access-invitations/{invitation_id}"
        )
        assert revoked.status_code in (200, 204)

        final = client.get("/v1/admin/hosted-access-invitations").json()
        assert final[0]["revoked_at"] is not None

    def test_project_owner_without_admin_is_forbidden(
        self, session: Session, make_authed_client: Any
    ) -> None:
        owner = _make_user(session, "owner@example.com")
        _make_project(session, owner)
        client: TestClient = make_authed_client(owner.id, session)

        assert (
            client.get("/v1/admin/hosted-access-invitations").status_code == 403
        )
        assert (
            client.post(
                "/v1/admin/hosted-access-invitations", json={"email": "x@example.com"}
            ).status_code
            == 403
        )

    def test_project_api_key_cannot_issue_even_from_admin_creator(
        self, session: Session, make_api_key_client: Any
    ) -> None:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        company = _make_project(session, admin)
        client: TestClient = make_api_key_client(admin.id, company.id, session)

        assert (
            client.get("/v1/admin/hosted-access-invitations").status_code == 403
        )
        assert (
            client.post(
                "/v1/admin/hosted-access-invitations", json={"email": "x@example.com"}
            ).status_code
            == 403
        )

    def test_inactive_admin_is_forbidden(
        self, session: Session, make_authed_client: Any
    ) -> None:
        admin = _make_user(session, "sleepy@example.com", is_admin=True)
        admin.is_active = False
        session.add(admin)
        session.commit()
        client: TestClient = make_authed_client(admin.id, session)
        assert (
            client.get("/v1/admin/hosted-access-invitations").status_code == 403
        )


class TestPublicAcceptanceRoutes:
    def test_public_token_creates_account_and_project_once(
        self, session: Session
    ) -> None:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        created = _invite(session, email="public@example.com", admin=admin)
        token = (created.invite_url or "").split("token=")[-1]

        client = _plain_client(session)
        preview = client.get(
            "/auth/hosted-access/preview", params={"token": token}
        )
        assert preview.status_code == 200
        assert preview.json() == {
            "valid": True,
            "reason": None,
            "email": "p***c@example.com",
            "requires_login": False,
            "requires_account_creation": True,
        }

        accepted = client.post(
            "/auth/hosted-access/accept/create-account",
            json={
                "token": token,
                "name": "Public Invitee",
                "password": "correct horse battery staple 7",
                "project_name": "Hosted Home",
            },
        )
        assert accepted.status_code == 200
        project_id = accepted.json()["project_id"]
        assert session.get(ProjectDB, project_id) is not None

        replay = client.post(
            "/auth/hosted-access/accept/create-account",
            json={
                "token": token,
                "name": "Public Invitee",
                "password": "correct horse battery staple 7",
                "project_name": "Hosted Home 2",
            },
        )
        assert replay.status_code in (404, 409)
        assert len(session.exec(select(ProjectDB)).all()) == 1  # the single new Project

    def test_existing_account_route_requires_matching_session(
        self, session: Session, make_authed_client: Any
    ) -> None:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        existing = _make_user(session, "known@example.com")
        created = _invite(session, email="known@example.com", admin=admin)
        token = (created.invite_url or "").split("token=")[-1]

        client: TestClient = make_authed_client(existing.id, session)
        accepted = client.post(
            "/auth/hosted-access/accept/existing-account",
            json={"token": token, "project_name": "From Session"},
        )
        assert accepted.status_code == 200

    def test_rate_limited_public_endpoints(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from apo.routes import hosted_access as routes_module

        admin = _make_user(session, "admin@example.com", is_admin=True)
        created = _invite(session, email="flood@example.com", admin=admin)
        token = (created.invite_url or "").split("token=")[-1]

        monkeypatch.setattr(
            routes_module,
            "hosted_access_rate_limiter",
            LoginRateLimiter(max_attempts=2, window_seconds=60),
        )
        client = _plain_client(session)
        statuses = [
            client.get("/auth/hosted-access/preview", params={"token": token}).status_code
            for _ in range(3)
        ]
        assert statuses == [200, 200, 429]



# ---------------------------------------------------------------------------
# Cross-Project isolation
# ---------------------------------------------------------------------------


class TestCompanyEvidenceIsolation:
    def test_invitee_cannot_read_company_project(
        self, session: Session, make_authed_client: Any, make_api_key_client: Any
    ) -> None:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        company = _make_project(session, admin, name="Company")
        sentinel = RunDB(
            id="run-sentinel",
            project=company.id,
        )
        session.add(sentinel)
        session.commit()

        created = _invite(session, email="outsider@example.com", admin=admin)
        token = (created.invite_url or "").split("token=")[-1]
        result = _accept_new(session, token=token, project_name="Outsider Land")
        outsider_project = result.project_id

        invitee = session.exec(
            select(UserDB).where(UserDB.email == "outsider@example.com")
        ).one()
        invitee_client: TestClient = make_authed_client(invitee.id, session)

        listed = invitee_client.get("/v1/projects").json()
        listed_ids = [p["id"] for p in listed]
        assert outsider_project in listed_ids
        assert company.id not in listed_ids

        assert (
            invitee_client.get(f"/v1/projects/{company.id}").status_code == 403
        )
        assert (
            invitee_client.get(
                "/v1/runs/run-sentinel", params={"project": company.id}
            ).status_code
            == 403
        )

        # a Project-B API key minted for the invitee is equally blind
        invitee_key: TestClient = make_api_key_client(
            invitee.id, outsider_project, session
        )
        assert (
            invitee_key.get("/v1/runs/run-sentinel", params={"project": company.id}).status_code
            == 403
        )
        assert (
            invitee_key.get(f"/v1/projects/{company.id}").status_code == 403
        )
