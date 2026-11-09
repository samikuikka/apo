# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnusedImport=false, reportAttributeAccessIssue=false, reportUnusedFunction=false, reportUnusedCallResult=false

"""Disposable-email-domain admission guard.

Every admission path refuses throwaway inbox domains: the bundled CC0
snapshot is parsed once into an immutable matcher, matching is exact or
dot-suffix, and two false-positive guards (built-in provider allowlist,
``APO_DISPOSABLE_DOMAIN_ALLOWLIST``) fail closed on bad input.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from sqlmodel import Session

from apo.services.email_admission import (
    ALLOWLIST_ENV,
    DisposableDomainListError,
    build_disposable_domain_matcher,
    get_disposable_domain_matcher,
    is_disposable_email,
    require_admissible_email,
)
from apo.services.hosted_access_invitations import (
    create_or_refresh_hosted_access_invitation,
)


@pytest.fixture(autouse=True)
def _fresh_matcher(monkeypatch: pytest.MonkeyPatch):
    """Isolate env changes per test and drop the cached matcher after."""
    monkeypatch.delenv(ALLOWLIST_ENV, raising=False)
    get_disposable_domain_matcher.cache_clear()
    yield
    get_disposable_domain_matcher.cache_clear()


def _write_bundle(tmp_path: Path, domains: list[str]) -> Path:
    path = tmp_path / "disposable-email-domains.json"
    path.write_text(
        json.dumps({"snapshot": "2026-11-08", "domains": domains}),
        encoding="utf-8",
    )
    return path


class TestMatching:
    def test_bundled_snapshot_blocks_known_burner_domains(self) -> None:
        for domain in (
            "mailinator.com",
            "10minutemail.com",
            "guerrillamail.com",
            "temp-mail.org",
            "yopmail.com",
        ):
            assert is_disposable_email(f"user@{domain}"), domain

    def test_bundled_snapshot_allows_normal_domains(self) -> None:
        for email in (
            "user@gmail.com",
            "person@company.org",
            "someone@sub.example.com",
        ):
            assert not is_disposable_email(email), email

    def test_subdomain_of_a_blocked_domain_is_blocked(self) -> None:
        assert is_disposable_email("u@sub.mailinator.com")
        assert is_disposable_email("u@a.b.mailinator.com")

    def test_trailing_dot_absolute_name_form_is_blocked(self) -> None:
        # mailinator.com. is the DNS absolute-name form of the same
        # domain and resolves identically, so it must not slip past.
        assert is_disposable_email("burner@mailinator.com.")
        assert is_disposable_email("burner@sub.mailinator.com.")

    def test_lookalike_domain_is_not_blocked(self) -> None:
        # No dot boundary, so an unlisted registrable domain passes even
        # when it merely contains a blocked name as a substring. (The
        # upstream list does catalogue some defensive lookalikes like
        # notmailinator.com; these are verified absent from the bundle.)
        assert not is_disposable_email("u@zzmailinator.com")
        assert not is_disposable_email("u@not10minutemail.com")

    def test_uppercase_and_whitespace_email_is_normalized(self) -> None:
        assert is_disposable_email("  USER@MAILINATOR.COM ")
        assert not is_disposable_email("USER@GMAIL.COM")

    def test_plus_addressing_keeps_the_domain_checkable(self) -> None:
        assert is_disposable_email("user+tag@mailinator.com")
        assert not is_disposable_email("user+tag@gmail.com")

    def test_malformed_email_is_not_disposable(self) -> None:
        # Shape validation is the caller's job; the guard only answers
        # the domain question.
        assert not is_disposable_email("not-an-email")
        assert not is_disposable_email("")


class TestFalsePositiveGuards:
    def test_protected_provider_survives_even_if_the_bundle_lists_it(
        self, tmp_path: Path
    ) -> None:
        path = _write_bundle(tmp_path, ["gmail.com", "mailinator.com"])
        matcher = build_disposable_domain_matcher(path=path)
        assert not matcher.is_blocked("gmail.com")
        assert matcher.is_blocked("mailinator.com")

    def test_env_allowlist_punches_a_hole(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = _write_bundle(tmp_path, ["mailinator.com"])
        monkeypatch.setenv(ALLOWLIST_ENV, "Mailinator.com")
        matcher = build_disposable_domain_matcher(path=path)
        assert not matcher.is_blocked("mailinator.com")
        assert not matcher.is_blocked("sub.mailinator.com")

    def test_invalid_env_allowlist_fails_closed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = _write_bundle(tmp_path, ["mailinator.com"])
        monkeypatch.setenv(ALLOWLIST_ENV, "not a domain")
        with pytest.raises(DisposableDomainListError, match=ALLOWLIST_ENV):
            build_disposable_domain_matcher(path=path)


class TestBundleParsingFailsHard:
    def test_domain_entry_with_at_sign_is_rejected(self, tmp_path: Path) -> None:
        path = _write_bundle(tmp_path, ["user@mailinator.com"])
        with pytest.raises(DisposableDomainListError, match="invalid domain entry"):
            build_disposable_domain_matcher(path=path)

    def test_uppercase_entry_is_rejected(self, tmp_path: Path) -> None:
        path = _write_bundle(tmp_path, ["Mailinator.com"])
        with pytest.raises(DisposableDomainListError):
            build_disposable_domain_matcher(path=path)

    def test_empty_domain_list_is_rejected(self, tmp_path: Path) -> None:
        path = _write_bundle(tmp_path, [])
        with pytest.raises(DisposableDomainListError, match="non-empty"):
            build_disposable_domain_matcher(path=path)

    def test_missing_domains_key_is_rejected(self, tmp_path: Path) -> None:
        path = tmp_path / "disposable-email-domains.json"
        path.write_text(json.dumps({"snapshot": "2026-11-08"}), encoding="utf-8")
        with pytest.raises(DisposableDomainListError):
            build_disposable_domain_matcher(path=path)

    def test_malformed_json_is_rejected(self, tmp_path: Path) -> None:
        path = tmp_path / "disposable-email-domains.json"
        path.write_text("{not json", encoding="utf-8")
        with pytest.raises(DisposableDomainListError, match="cannot read"):
            build_disposable_domain_matcher(path=path)

    def test_missing_file_is_rejected(self, tmp_path: Path) -> None:
        path = tmp_path / "disposable-email-domains.json"
        with pytest.raises(DisposableDomainListError, match="cannot read"):
            build_disposable_domain_matcher(path=path)


class TestRequireAdmissibleEmail:
    def test_disposable_domain_raises_422(self) -> None:
        with pytest.raises(HTTPException) as exc:
            require_admissible_email("user@mailinator.com")
        assert exc.value.status_code == 422
        assert "permanent" in exc.value.detail

    def test_normal_email_passes(self) -> None:
        require_admissible_email("user@gmail.com")


class TestAdminUserRoute:
    def test_admin_user_creation_refuses_disposable_domain(
        self, client: Any, session: Session, make_authed_client: Any
    ) -> None:
        from sqlmodel import select

        from apo.models.db import UserDB

        resp = client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "AdminPass123", "name": "A"},
        )
        assert resp.status_code == 200
        admin = session.exec(select(UserDB)).first()
        assert admin is not None
        authed = make_authed_client(admin.id, session)

        blocked = authed.post(
            "/auth/users",
            json={
                "email": "burner@yopmail.com",
                "name": "Burner",
                "password": "correct horse battery staple 7",
            },
        )
        assert blocked.status_code == 422
        assert "permanent" in blocked.json()["detail"]

        allowed = authed.post(
            "/auth/users",
            json={
                "email": "real@example.org",
                "name": "Real",
                "password": "correct horse battery staple 7",
            },
        )
        assert allowed.status_code == 200


class TestAdmissionPaths:
    def test_hosted_access_invitation_refuses_disposable_domain(
        self, session: Session
    ) -> None:
        import asyncio

        from apo.models.db import UserDB

        admin = UserDB(
            email="admin@example.com",
            name="Admin",
            password_hash="x",
            is_admin=True,
            is_active=True,
        )
        session.add(admin)
        session.commit()

        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                create_or_refresh_hosted_access_invitation(
                    session, email="burner@mailinator.com", invited_by_user_id=admin.id
                )
            )
        assert exc.value.status_code == 422
        assert "permanent" in exc.value.detail

    def test_project_invitation_refuses_disposable_domain(
        self, session: Session
    ) -> None:
        import asyncio

        from apo.models.db import ProjectDB, ProjectMembershipDB, UserDB
        from apo.models.schemas import CreateProjectInvitationRequest
        from apo.services.project_invitations import create_or_refresh_invitation

        owner = UserDB(
            email="owner@example.com",
            name="Owner",
            password_hash="x",
            is_admin=False,
            is_active=True,
        )
        session.add(owner)
        session.commit()
        project = ProjectDB(id="proj-blocklist", name="P", created_by=owner.id)
        session.add(project)
        session.add(
            ProjectMembershipDB(
                project_id=project.id, user_id=owner.id, role="owner"
            )
        )
        session.commit()

        body = CreateProjectInvitationRequest(email="burner@10minutemail.com", role="member")
        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                create_or_refresh_invitation(
                    session,
                    project_id=project.id,
                    body=body,
                    invited_by_user_id=owner.id,
                    invited_by_role="owner",
                )
            )
        assert exc.value.status_code == 422
        assert "permanent" in exc.value.detail


class TestAcceptRecheck:
    """Acceptance re-checks admissibility where the user row is created.

    An invitation issued while a domain was allowlisted (or before the
    blocklist existed) must not admit once the allowlist is gone.
    """

    def test_project_invitation_accept_refuses_legacy_disposable_email(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import asyncio

        from apo.models.db import ProjectDB, ProjectMembershipDB, UserDB
        from apo.models.schemas import CreateProjectInvitationRequest
        from apo.services.project_invitations import (
            accept_invitation_create_account,
            create_or_refresh_invitation,
        )

        owner = UserDB(
            email="owner@example.com",
            name="Owner",
            password_hash="x",
            is_admin=False,
            is_active=True,
        )
        session.add(owner)
        session.commit()
        project = ProjectDB(id="proj-legacy", name="P", created_by=owner.id)
        session.add(project)
        session.add(
            ProjectMembershipDB(project_id=project.id, user_id=owner.id, role="owner")
        )
        session.commit()

        monkeypatch.setenv(ALLOWLIST_ENV, "mailinator.com")
        get_disposable_domain_matcher.cache_clear()
        body = CreateProjectInvitationRequest(email="burner@mailinator.com", role="member")
        created = asyncio.run(
            create_or_refresh_invitation(
                session,
                project_id=project.id,
                body=body,
                invited_by_user_id=owner.id,
                invited_by_role="owner",
            )
        )
        token = (created.invite_url or "").split("token=")[-1]
        assert token

        monkeypatch.delenv(ALLOWLIST_ENV)
        get_disposable_domain_matcher.cache_clear()

        with pytest.raises(HTTPException) as exc:
            accept_invitation_create_account(
                session,
                raw_token=token,
                name="Burner",
                password="correct horse battery staple 7",
            )
        assert exc.value.status_code == 422
        assert "permanent" in exc.value.detail

    def test_hosted_access_accept_refuses_legacy_disposable_email(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import asyncio

        from apo.models.db import UserDB
        from apo.services.hosted_access_invitations import (
            accept_hosted_access_create_account,
        )

        admin = UserDB(
            email="admin@example.com",
            name="Admin",
            password_hash="x",
            is_admin=True,
            is_active=True,
        )
        session.add(admin)
        session.commit()

        monkeypatch.setenv(ALLOWLIST_ENV, "mailinator.com")
        get_disposable_domain_matcher.cache_clear()
        created = asyncio.run(
            create_or_refresh_hosted_access_invitation(
                session, email="burner@mailinator.com", invited_by_user_id=admin.id
            )
        )
        token = (created.invite_url or "").split("token=")[-1]
        assert token

        monkeypatch.delenv(ALLOWLIST_ENV)
        get_disposable_domain_matcher.cache_clear()

        with pytest.raises(HTTPException) as exc:
            accept_hosted_access_create_account(
                session,
                raw_token=token,
                name="Burner",
                password="correct horse battery staple 7",
                project_name="Burner Project",
            )
        assert exc.value.status_code == 422
        assert "permanent" in exc.value.detail


class TestSetupExemption:
    def test_setup_bootstrap_accepts_a_disposable_domain(
        self, client: Any, session: Session
    ) -> None:
        """Bootstrap runs before any policy exists, so the first account is
        exempt: an operator signing up with an alias domain must not be
        locked out of a fresh installation."""
        from sqlmodel import select

        from apo.models.db import UserDB

        resp = client.post(
            "/auth/setup",
            json={
                "email": "founder@yopmail.com",
                "password": "AdminPass123",
                "name": "Founder",
            },
        )
        assert resp.status_code == 200, resp.text
        assert session.exec(select(UserDB)).first() is not None
