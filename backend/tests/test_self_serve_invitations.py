# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnusedCallResult=false, reportUnusedParameter=false, reportUnusedFunction=false, reportAttributeAccessIssue=false, reportUntypedFunctionDecorator=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportCallIssue=false, reportMissingParameterType=false, reportImplicitStringConcatenation=false, reportPrivateLocalImportUsage=false

"""Self-serve invitations: the public admission door.

A visitor submits an email and the installation issues a hosted-access
invitation for it, delivered by email only. The accept link never appears
in a response or a log line, the door closes with one env flag, and a
self-serve account must verify its email before it can log in.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import threading
from datetime import timedelta
from pathlib import Path
from typing import Any, override

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import inspect
from sqlalchemy.pool import NullPool
from sqlmodel import Session, SQLModel, create_engine, select

import apo.db as apo_db
from apo.models.db import (
    HostedAccessInvitationDB,
    ProjectDB,
    ProjectMembershipDB,
    UserDB,
)
from apo.routes import hosted_access as routes_module
from apo.services import email as email_module
from apo.services import hosted_access_invitations as svc
from apo.services.email import EmailSendError, EmailService
from apo.services.hosted_access_invitations import (
    accept_hosted_access_create_account,
    accept_hosted_access_existing_account,
    create_or_refresh_hosted_access_invitation,
    mask_email,
    preview_hosted_access_invitation,
    resend_hosted_access_invitation,
)
from apo.services.invitation_tokens import utcnow
from apo.services.signup_config import (
    SignupConfigError,
    load_signup_config,
    validate_self_serve_delivery,
)

from .conftest import engine as test_engine

GENERIC_MESSAGE = "If the address is eligible, an invitation is on its way."
PASSWORD = "correct horse battery staple 7"
REQUEST_PATH = "/auth/hosted-access/request"
_LINK_RE = re.compile(r"https?://\S+/join\?token=([\w-]+)")


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


class CapturingEmailService(EmailService):
    """A configured transport that records messages instead of sending."""

    def __init__(self, *, fail: bool = False) -> None:
        self.sent: list[dict[str, str]] = []
        self.fail: bool = fail

    @property
    @override
    def is_configured(self) -> bool:
        return True

    @override
    async def send(
        self, to: str, subject: str, html: str, text: str | None = None
    ) -> None:
        if self.fail:
            raise EmailSendError("SMTP send failed: connection refused")
        self.sent.append({"to": to, "subject": subject, "html": html, "text": text or ""})


@pytest.fixture(name="mailbox")
def mailbox_fixture(monkeypatch: pytest.MonkeyPatch) -> CapturingEmailService:
    service = CapturingEmailService()
    monkeypatch.setattr(email_module, "_service", service)
    return service


@pytest.fixture(name="self_serve")
def self_serve_fixture(
    monkeypatch: pytest.MonkeyPatch, mailbox: CapturingEmailService
) -> CapturingEmailService:
    """The door open: self_serve mode with a working transport."""
    monkeypatch.setenv("APO_SIGNUP_MODE", "self_serve")
    return mailbox


@pytest.fixture(autouse=True)
def _reset_self_serve_limiters():
    def clear() -> None:
        routes_module.self_serve_ip_rate_limiter._attempts.clear()
        routes_module.self_serve_email_rate_limiter._attempts.clear()
        routes_module.hosted_access_rate_limiter._attempts.clear()

    clear()
    yield
    clear()


def _token_from(message: dict[str, str]) -> str:
    match = _LINK_RE.search(message["text"])
    assert match is not None, "the invitation email carries the accept link"
    return match.group(1)


def _invitations(session: Session) -> list[HostedAccessInvitationDB]:
    session.expire_all()
    return list(session.exec(select(HostedAccessInvitationDB)).all())


def _make_user(session: Session, email: str, *, is_admin: bool = False) -> UserDB:
    user = UserDB(
        email=email, name="User", password_hash="x", is_admin=is_admin, is_active=True
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _admin_invite_token(session: Session, email: str) -> str:
    """An admin-issued invitation on the log-only transport (link returned)."""
    admin = session.exec(select(UserDB).where(UserDB.is_admin)).first() or _make_user(
        session, "admin@example.com", is_admin=True
    )
    created = asyncio.run(
        create_or_refresh_hosted_access_invitation(
            session, email=email, invited_by_user_id=admin.id
        )
    )
    return (created.invite_url or "").split("token=")[-1]


# ---------------------------------------------------------------------------
# Request endpoint
# ---------------------------------------------------------------------------


class TestRequest:
    def test_request_creates_a_self_serve_invitation_and_emails_it(
        self, client: TestClient, session: Session, self_serve: CapturingEmailService
    ) -> None:
        response = client.post(REQUEST_PATH, json={"email": " Fresh@Example.com "})

        assert response.status_code == 202
        assert response.json() == {"message": GENERIC_MESSAGE}

        [invitation] = _invitations(session)
        assert invitation.email == "fresh@example.com"
        assert invitation.origin == "self_serve"
        assert invitation.invited_by_user_id is None
        assert invitation.delivery_method == "email"
        ttl = invitation.expires_at - utcnow()
        assert timedelta(hours=23, minutes=59) < ttl <= timedelta(hours=24)

        [message] = self_serve.sent
        assert message["to"] == "fresh@example.com"
        token = _token_from(message)
        assert hashlib.sha256(token.encode()).hexdigest() == invitation.token_hash

    def test_link_is_never_returned_or_logged_on_success(
        self,
        client: TestClient,
        self_serve: CapturingEmailService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        with caplog.at_level(logging.DEBUG):
            response = client.post(REQUEST_PATH, json={"email": "quiet@example.com"})

        token = _token_from(self_serve.sent[0])
        assert token not in response.text
        assert token not in caplog.text
        assert "token=" not in caplog.text

    def test_smtp_failure_returns_the_same_response_and_never_leaks_the_link(
        self,
        client: TestClient,
        session: Session,
        self_serve: CapturingEmailService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        self_serve.fail = True

        with caplog.at_level(logging.DEBUG):
            response = client.post(REQUEST_PATH, json={"email": "down@example.com"})

        assert response.status_code == 202
        assert response.json() == {"message": GENERIC_MESSAGE}
        assert "token=" not in response.text
        assert "token=" not in caplog.text

        [invitation] = _invitations(session)
        assert invitation.origin == "self_serve"
        assert invitation.delivery_method == "failed", "failure is recorded for admin resend"

    def test_admin_resend_of_a_self_serve_row_never_returns_the_link(
        self, client: TestClient, session: Session, self_serve: CapturingEmailService
    ) -> None:
        self_serve.fail = True
        client.post(REQUEST_PATH, json={"email": "down@example.com"})
        [invitation] = _invitations(session)

        still_down = asyncio.run(
            resend_hosted_access_invitation(session, invitation_id=invitation.id)
        )
        assert still_down.invite_url is None
        assert still_down.delivery_status == "failed"

        self_serve.fail = False
        recovered = asyncio.run(
            resend_hosted_access_invitation(session, invitation_id=invitation.id)
        )
        assert recovered.invite_url is None
        assert recovered.delivery_status == "sent"
        assert len(self_serve.sent) == 1

    def test_failed_delivery_can_be_requested_again_at_once(
        self, client: TestClient, self_serve: CapturingEmailService
    ) -> None:
        self_serve.fail = True
        client.post(REQUEST_PATH, json={"email": "retry@example.com"})
        self_serve.fail = False

        response = client.post(REQUEST_PATH, json={"email": "retry@example.com"})

        assert response.status_code == 202
        assert len(self_serve.sent) == 1

    def test_outstanding_cap(
        self,
        client: TestClient,
        session: Session,
        self_serve: CapturingEmailService,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("APO_SELF_SERVE_MAX_OUTSTANDING", "2")
        monkeypatch.setenv("APO_SELF_SERVE_REQUESTS_PER_HOUR_PER_IP", "50")

        statuses = [
            client.post(REQUEST_PATH, json={"email": f"cap{i}@example.com"}).status_code
            for i in range(3)
        ]

        assert statuses == [202, 202, 429]
        assert len(_invitations(session)) == 2
        assert len(self_serve.sent) == 2

    def test_outstanding_cap_answers_alike_for_known_and_unknown_emails(
        self,
        client: TestClient,
        session: Session,
        self_serve: CapturingEmailService,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A full door must not turn into an account-existence oracle."""
        monkeypatch.setenv("APO_SELF_SERVE_MAX_OUTSTANDING", "1")
        monkeypatch.setenv("APO_SELF_SERVE_REQUESTS_PER_HOUR_PER_IP", "50")
        _make_user(session, "member@example.com")
        client.post(REQUEST_PATH, json={"email": "first@example.com"})

        known = client.post(REQUEST_PATH, json={"email": "member@example.com"})
        unknown = client.post(REQUEST_PATH, json={"email": "nobody@example.com"})

        assert (known.status_code, known.json()) == (unknown.status_code, unknown.json())
        assert known.status_code == 429

    def test_expired_rows_free_their_place_under_the_cap(
        self,
        client: TestClient,
        session: Session,
        self_serve: CapturingEmailService,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("APO_SELF_SERVE_MAX_OUTSTANDING", "1")
        monkeypatch.setenv("APO_SELF_SERVE_REQUESTS_PER_HOUR_PER_IP", "50")
        client.post(REQUEST_PATH, json={"email": "old@example.com"})
        [invitation] = _invitations(session)
        invitation.expires_at = utcnow() - timedelta(minutes=1)
        session.add(invitation)
        session.commit()

        response = client.post(REQUEST_PATH, json={"email": "new@example.com"})

        assert response.status_code == 202
        assert len(self_serve.sent) == 2

    def test_existing_user_email_gets_the_generic_response_and_creates_nothing(
        self, client: TestClient, session: Session, self_serve: CapturingEmailService
    ) -> None:
        _make_user(session, "member@example.com")

        response = client.post(REQUEST_PATH, json={"email": "Member@Example.com"})

        assert response.status_code == 202
        assert response.json() == {"message": GENERIC_MESSAGE}
        assert _invitations(session) == []
        assert self_serve.sent == []

    def test_per_ip_limit_is_independent_of_email(
        self, client: TestClient, self_serve: CapturingEmailService
    ) -> None:
        responses = [
            client.post(REQUEST_PATH, json={"email": f"ip{i}@example.com"})
            for i in range(4)
        ]

        assert [r.status_code for r in responses] == [202, 202, 202, 429]
        assert int(responses[-1].headers["Retry-After"]) > 0
        assert len(self_serve.sent) == 3

    def test_per_email_limit_bounds_re_requests(
        self,
        client: TestClient,
        self_serve: CapturingEmailService,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("APO_SELF_SERVE_REQUESTS_PER_HOUR_PER_IP", "50")

        responses = [
            client.post(REQUEST_PATH, json={"email": "again@example.com"})
            for _ in range(4)
        ]

        assert [r.status_code for r in responses] == [202, 202, 202, 429]
        assert int(responses[-1].headers["Retry-After"]) > 0
        # A re-request inside the re-request window is a silent no-op: the
        # link already in the inbox keeps working and no second mail goes out.
        assert len(self_serve.sent) == 1

    def test_re_request_after_the_window_rotates_the_link(
        self, client: TestClient, session: Session, self_serve: CapturingEmailService
    ) -> None:
        client.post(REQUEST_PATH, json={"email": "slow@example.com"})
        first_token = _token_from(self_serve.sent[0])
        [invitation] = _invitations(session)
        invitation.updated_at = utcnow() - timedelta(
            minutes=svc.SELF_SERVE_REREQUEST_WINDOW_MINUTES + 1
        )
        session.add(invitation)
        session.commit()

        response = client.post(REQUEST_PATH, json={"email": "slow@example.com"})

        assert response.status_code == 202
        assert len(self_serve.sent) == 2
        assert len(_invitations(session)) == 1
        assert preview_hosted_access_invitation(session, first_token).valid is False
        second_token = _token_from(self_serve.sent[1])
        assert preview_hosted_access_invitation(session, second_token).valid is True

    def test_request_does_not_rotate_an_admin_issued_invitation(
        self, client: TestClient, session: Session, self_serve: CapturingEmailService
    ) -> None:
        """A stranger must not be able to kill the link an admin handed out."""
        admin = _make_user(session, "admin@example.com", is_admin=True)
        asyncio.run(
            create_or_refresh_hosted_access_invitation(
                session, email="vip@example.com", invited_by_user_id=admin.id
            )
        )
        admin_token = _token_from(self_serve.sent[0])
        [invitation] = _invitations(session)
        invitation.updated_at = utcnow() - timedelta(days=1)
        session.add(invitation)
        session.commit()

        response = client.post(REQUEST_PATH, json={"email": "vip@example.com"})

        assert response.status_code == 202
        assert response.json() == {"message": GENERIC_MESSAGE}
        assert len(self_serve.sent) == 1
        [invitation] = _invitations(session)
        assert invitation.origin == "admin"
        assert preview_hosted_access_invitation(session, admin_token).valid is True

    def test_simultaneous_requests_for_one_address_leave_one_invitation(
        self,
        client: TestClient,
        session: Session,
        self_serve: CapturingEmailService,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Two requests that both saw no active row: the second insert hits
        the one-active-row index and must not surface as a server error."""
        client.post(REQUEST_PATH, json={"email": "twice@example.com"})

        def sees_no_active_row(_session: Session, _email: str) -> None:
            return None

        monkeypatch.setattr(svc, "find_active_hosted_access_invitation", sees_no_active_row)

        response = client.post(REQUEST_PATH, json={"email": "twice@example.com"})

        assert response.status_code == 202
        assert response.json() == {"message": GENERIC_MESSAGE}
        assert len(_invitations(session)) == 1
        assert len(self_serve.sent) == 1

    def test_disposable_domain_follows_the_admission_contract(
        self, client: TestClient, session: Session, self_serve: CapturingEmailService
    ) -> None:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        with pytest.raises(HTTPException) as admin_path:
            asyncio.run(
                create_or_refresh_hosted_access_invitation(
                    session, email="burner@mailinator.com", invited_by_user_id=admin.id
                )
            )

        response = client.post(REQUEST_PATH, json={"email": "burner@mailinator.com"})

        assert response.status_code == admin_path.value.status_code == 422
        assert response.json()["detail"] == admin_path.value.detail
        assert _invitations(session) == []
        assert self_serve.sent == []

    @pytest.mark.parametrize("email", ["", "   ", "no-at-sign", "@", "a@", "@b.com"])
    def test_malformed_email_is_rejected(
        self, client: TestClient, self_serve: CapturingEmailService, email: str
    ) -> None:
        response = client.post(REQUEST_PATH, json={"email": email})

        assert response.status_code == 422
        assert self_serve.sent == []


# ---------------------------------------------------------------------------
# Access log
# ---------------------------------------------------------------------------


class TestAccessLogRedaction:
    """The preview endpoint takes the token in the query string, and
    uvicorn's access log records the whole request line. Without the
    redaction every opened link would sit in the server log while it can
    still be accepted. The test client never runs uvicorn's access logger,
    so these emit records the way uvicorn does, on the real logger."""

    @staticmethod
    def _emit(path: str) -> str:
        import importlib
        import io

        from uvicorn.logging import AccessFormatter

        # Building the app is what installs the filter.
        importlib.import_module("apo.api")

        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(
            AccessFormatter(
                '%(client_addr)s - "%(request_line)s" %(status_code)s', use_colors=False
            )
        )
        access_logger = logging.getLogger("uvicorn.access")
        previous_level = access_logger.level
        access_logger.addHandler(handler)
        access_logger.setLevel(logging.INFO)
        try:
            access_logger.info(
                '%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "GET", path, "1.1", 200
            )
        finally:
            access_logger.removeHandler(handler)
            access_logger.setLevel(previous_level)
        return stream.getvalue().strip()

    def test_preview_token_is_not_written_to_the_access_log(self) -> None:
        line = self._emit("/auth/hosted-access/preview?token=sEcReT-tok_123")

        assert "sEcReT" not in line
        assert line == (
            '127.0.0.1:5000 - "GET /auth/hosted-access/preview?token=[redacted] HTTP/1.1" 200 OK'
        )

    def test_token_is_redacted_wherever_it_sits_in_the_query(self) -> None:
        line = self._emit("/auth/invitations/preview?a=1&token=sEcReT-tok_123&b=2")

        assert "sEcReT" not in line
        assert "?a=1&token=[redacted]&b=2 " in line

    def test_requests_without_a_token_are_logged_unchanged(self) -> None:
        line = self._emit("/v1/runs?project=demo&tokens=5")

        assert line == '127.0.0.1:5000 - "GET /v1/runs?project=demo&tokens=5 HTTP/1.1" 200 OK'


# ---------------------------------------------------------------------------
# Double-accept race (both accept variants)
# ---------------------------------------------------------------------------


class TestAcceptRace:
    """Two accepts of one invitation that both passed validation before
    either wrote. The interleave is forced at a seam after the loser's
    checks, which is exactly the window a concurrent request lands in."""

    def test_two_new_account_accepts_yield_one_project(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        token = _admin_invite_token(session, "race@example.com")
        real_check = svc.require_admissible_email
        interleaved: list[str] = []

        def winner_lands_first(email: str) -> None:
            real_check(email)
            if interleaved:
                return
            interleaved.append(email)
            with Session(test_engine) as other:
                accept_hosted_access_create_account(
                    other, raw_token=token, name="Winner", password=PASSWORD,
                    project_name="Winner Project",
                )

        monkeypatch.setattr(svc, "require_admissible_email", winner_lands_first)

        with pytest.raises(HTTPException) as loser:
            accept_hosted_access_create_account(
                session, raw_token=token, name="Loser", password=PASSWORD,
                project_name="Loser Project",
            )

        assert loser.value.status_code == 409
        session.expire_all()
        assert [p.name for p in session.exec(select(ProjectDB)).all()] == ["Winner Project"]
        assert [
            u.name for u in session.exec(select(UserDB).where(UserDB.email == "race@example.com"))
        ] == ["Winner"]

    def test_two_existing_account_accepts_yield_one_project(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        user = _make_user(session, "known@example.com")
        token = _admin_invite_token(session, "known@example.com")
        real_validate = svc._validate_project_name
        interleaved: list[str] = []

        def winner_lands_first(project_name: str) -> str:
            cleaned = real_validate(project_name)
            if interleaved:
                return cleaned
            interleaved.append(cleaned)
            with Session(test_engine) as other:
                accept_hosted_access_existing_account(
                    other, raw_token=token, accepting_user_id=user.id,
                    project_name="Winner Project",
                )
            return cleaned

        monkeypatch.setattr(svc, "_validate_project_name", winner_lands_first)

        with pytest.raises(HTTPException) as loser:
            accept_hosted_access_existing_account(
                session, raw_token=token, accepting_user_id=user.id,
                project_name="Loser Project",
            )

        assert loser.value.status_code == 409
        session.expire_all()
        assert [p.name for p in session.exec(select(ProjectDB)).all()] == ["Winner Project"]
        [invitation] = _invitations(session)
        assert invitation.accepted_project_id == session.exec(select(ProjectDB)).one().id

    def test_new_account_accept_loses_to_an_existing_account_accept(
        self, session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        token = _admin_invite_token(session, "mixed@example.com")
        real_check = svc.require_admissible_email
        interleaved: list[str] = []

        def account_appears_and_accepts(email: str) -> None:
            real_check(email)
            if interleaved:
                return
            interleaved.append(email)
            with Session(test_engine) as other:
                existing = _make_user(other, "mixed@example.com")
                accept_hosted_access_existing_account(
                    other, raw_token=token, accepting_user_id=existing.id,
                    project_name="Winner Project",
                )

        monkeypatch.setattr(svc, "require_admissible_email", account_appears_and_accepts)

        with pytest.raises(HTTPException) as loser:
            accept_hosted_access_create_account(
                session, raw_token=token, name="Loser", password=PASSWORD,
                project_name="Loser Project",
            )

        assert loser.value.status_code == 409
        session.expire_all()
        assert [p.name for p in session.exec(select(ProjectDB)).all()] == ["Winner Project"]
        assert len(session.exec(select(ProjectMembershipDB)).all()) == 1

    def test_threads_on_a_file_database_yield_one_project(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The same race on real connections: both threads are held at a
        barrier after validation, then write against one SQLite file."""
        file_engine = create_engine(
            f"sqlite:///{tmp_path / 'race.db'}",
            connect_args={"check_same_thread": False},
            poolclass=NullPool,
        )
        apo_db.attach_sqlite_pragmas(file_engine)
        SQLModel.metadata.create_all(file_engine)
        with Session(file_engine) as setup:
            user = _make_user(setup, "known@example.com")
            user_id = user.id
            token = _admin_invite_token(setup, "known@example.com")

        barrier = threading.Barrier(2, timeout=10)
        real_validate = svc._validate_project_name

        def hold_until_both_validated(project_name: str) -> str:
            cleaned = real_validate(project_name)
            barrier.wait()
            return cleaned

        monkeypatch.setattr(svc, "_validate_project_name", hold_until_both_validated)
        outcomes: list[object] = []

        def accept(project_name: str) -> None:
            try:
                with Session(file_engine) as own:
                    result = accept_hosted_access_existing_account(
                        own, raw_token=token, accepting_user_id=user_id,
                        project_name=project_name,
                    )
                outcomes.append(result.status)
            except HTTPException as exc:
                outcomes.append(exc.status_code)
            except Exception as exc:  # surfaced through the assertion below
                outcomes.append(repr(exc))

        threads = [threading.Thread(target=accept, args=(f"P{i}",)) for i in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        assert sorted(outcomes, key=str) == [409, "accepted"]
        with Session(file_engine) as check:
            assert len(check.exec(select(ProjectDB)).all()) == 1
        file_engine.dispose()


# ---------------------------------------------------------------------------
# Preview masking
# ---------------------------------------------------------------------------


class TestPreviewMasking:
    @pytest.mark.parametrize(
        ("email", "masked"),
        [
            ("john@example.com", "j***n@example.com"),
            ("stranger@example.com", "s***r@example.com"),
            ("abc@example.com", "a***c@example.com"),
            # Showing both ends of a two-letter local part would show all of it.
            ("ab@example.com", "a***@example.com"),
            ("a@example.com", "a***@example.com"),
        ],
    )
    def test_mask_shape(self, email: str, masked: str) -> None:
        assert mask_email(email) == masked

    def test_preview_returns_the_masked_email(self, session: Session) -> None:
        token = _admin_invite_token(session, "john@example.com")

        preview = preview_hosted_access_invitation(session, token)

        assert preview.valid is True
        assert preview.email == "j***n@example.com"


# ---------------------------------------------------------------------------
# Startup-validated configuration
# ---------------------------------------------------------------------------


_SIGNUP_ENV = (
    "APO_SIGNUP_MODE",
    "APO_SELF_SERVE_INVITE_TTL_HOURS",
    "APO_SELF_SERVE_REQUESTS_PER_HOUR_PER_IP",
    "APO_SELF_SERVE_MAX_OUTSTANDING",
)


class TestSignupConfig:
    def test_defaults(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for name in _SIGNUP_ENV:
            monkeypatch.delenv(name, raising=False)

        config = load_signup_config()

        assert config.mode == "invite_only"
        assert config.invite_ttl_hours == 24
        assert config.requests_per_hour_per_ip == 3
        assert config.max_outstanding == 200

    def test_values_are_read_from_the_environment(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_SIGNUP_MODE", " Self_Serve ")
        monkeypatch.setenv("APO_SELF_SERVE_INVITE_TTL_HOURS", "6")
        monkeypatch.setenv("APO_SELF_SERVE_REQUESTS_PER_HOUR_PER_IP", "9")
        monkeypatch.setenv("APO_SELF_SERVE_MAX_OUTSTANDING", "50")

        config = load_signup_config()

        assert (config.mode, config.invite_ttl_hours) == ("self_serve", 6)
        assert (config.requests_per_hour_per_ip, config.max_outstanding) == (9, 50)

    @pytest.mark.parametrize(
        ("name", "value"),
        [
            ("APO_SIGNUP_MODE", "open"),
            ("APO_SIGNUP_MODE", ""),
            ("APO_SELF_SERVE_INVITE_TTL_HOURS", "0"),
            ("APO_SELF_SERVE_INVITE_TTL_HOURS", "-1"),
            ("APO_SELF_SERVE_INVITE_TTL_HOURS", "a day"),
            ("APO_SELF_SERVE_REQUESTS_PER_HOUR_PER_IP", ""),
            ("APO_SELF_SERVE_REQUESTS_PER_HOUR_PER_IP", "0"),
            ("APO_SELF_SERVE_MAX_OUTSTANDING", "0"),
            ("APO_SELF_SERVE_MAX_OUTSTANDING", "2.5"),
        ],
    )
    def test_invalid_value_names_the_variable(
        self, monkeypatch: pytest.MonkeyPatch, name: str, value: str
    ) -> None:
        monkeypatch.setenv(name, value)

        with pytest.raises(SignupConfigError, match=name):
            load_signup_config()

    def test_invalid_value_fails_app_construction(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from apo.api import create_app

        monkeypatch.setenv("APO_SIGNUP_MODE", "open")

        with pytest.raises(SignupConfigError, match="APO_SIGNUP_MODE"):
            create_app()

    def test_self_serve_without_a_transport_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_SIGNUP_MODE", "self_serve")

        with pytest.raises(SignupConfigError, match="EMAIL_TRANSPORT_URL"):
            validate_self_serve_delivery(load_signup_config(), email_configured=False)

        validate_self_serve_delivery(load_signup_config(), email_configured=True)

    def test_invite_only_needs_no_transport(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("APO_SIGNUP_MODE", raising=False)

        validate_self_serve_delivery(load_signup_config(), email_configured=False)


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------


_PRE_SELF_SERVE_INVITATIONS_DDL = """
CREATE TABLE hosted_access_invitations (
    id VARCHAR PRIMARY KEY,
    email VARCHAR NOT NULL,
    token_hash VARCHAR NOT NULL UNIQUE,
    invited_by_user_id VARCHAR NOT NULL REFERENCES users(id),
    delivery_method VARCHAR NOT NULL DEFAULT 'email',
    expires_at DATETIME NOT NULL,
    accepted_at DATETIME,
    accepted_by_user_id VARCHAR REFERENCES users(id),
    accepted_project_id VARCHAR,
    revoked_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""


@pytest.fixture(name="old_database")
def old_database_fixture(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A SQLite file in the shape the ladder left before self-serve: the
    inviter is NOT NULL, there is no origin, users carry no verification flag."""
    url = f"sqlite:///{tmp_path / 'old.db'}"
    old_engine = create_engine(
        url, connect_args={"check_same_thread": False}, poolclass=NullPool
    )
    apo_db.attach_sqlite_pragmas(old_engine)
    monkeypatch.setattr(apo_db, "DATABASE_URL", url)
    monkeypatch.setattr(apo_db, "engine", old_engine)
    SQLModel.metadata.create_all(old_engine)
    with old_engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE hosted_access_invitations")
        conn.exec_driver_sql(_PRE_SELF_SERVE_INVITATIONS_DDL)
        conn.exec_driver_sql(
            "CREATE INDEX ix_hosted_access_invitations_email"
            " ON hosted_access_invitations(email)"
        )
        conn.exec_driver_sql(
            "CREATE UNIQUE INDEX uq_hosted_access_invitations_active_email"
            " ON hosted_access_invitations(email)"
            " WHERE accepted_at IS NULL AND revoked_at IS NULL"
        )
        conn.exec_driver_sql("ALTER TABLE users DROP COLUMN requires_email_verification")
        conn.exec_driver_sql(
            "INSERT INTO users (id, email, name, password_hash, is_admin, is_active)"
            " VALUES ('admin-1', 'admin@example.com', 'Admin', 'x', 1, 1)"
        )
        conn.exec_driver_sql(
            "INSERT INTO hosted_access_invitations"
            " (id, email, token_hash, invited_by_user_id, expires_at)"
            " VALUES ('inv-1', 'old@example.com', 'hash-1', 'admin-1', '2099-01-01')"
        )
    yield old_engine
    old_engine.dispose()


class TestMigration:
    def test_old_database_gains_the_self_serve_shape(self, old_database: Any) -> None:
        apo_db._add_self_serve_invitation_schema()

        with old_database.connect() as conn:
            inspector = inspect(conn)
            columns = {
                c["name"]: c for c in inspector.get_columns("hosted_access_invitations")
            }
            assert columns["invited_by_user_id"]["nullable"] is True
            assert columns["origin"]["nullable"] is False
            index_names = {
                i["name"] for i in inspector.get_indexes("hosted_access_invitations")
            }
            assert {
                "ix_hosted_access_invitations_email",
                "uq_hosted_access_invitations_active_email",
                "ix_hosted_access_invitations_self_serve_outstanding",
            } <= index_names
            assert conn.exec_driver_sql(
                "SELECT id, email, invited_by_user_id, origin FROM hosted_access_invitations"
            ).fetchall() == [("inv-1", "old@example.com", "admin-1", "admin")]
            assert conn.exec_driver_sql(
                "SELECT id, requires_email_verification FROM users"
            ).fetchall() == [("admin-1", 0)]

    def test_migrated_table_takes_inviterless_rows_and_keeps_its_constraints(
        self, old_database: Any
    ) -> None:
        apo_db._add_self_serve_invitation_schema()

        with Session(old_database) as session:
            session.add(
                HostedAccessInvitationDB(
                    email="new@example.com",
                    invited_by_user_id=None,
                    origin="self_serve",
                    token_hash="hash-2",
                    expires_at=utcnow() + timedelta(hours=24),
                )
            )
            session.commit()
            rows = session.exec(select(HostedAccessInvitationDB)).all()
            assert sorted(row.origin for row in rows) == ["admin", "self_serve"]

        with old_database.begin() as conn:
            with pytest.raises(Exception, match="UNIQUE"):
                conn.exec_driver_sql(
                    "INSERT INTO hosted_access_invitations"
                    " (id, email, token_hash, origin, expires_at)"
                    " VALUES ('inv-dup', 'new@example.com', 'hash-3', 'self_serve', '2099-01-01')"
                )
        with old_database.connect() as conn:
            assert conn.exec_driver_sql("PRAGMA foreign_key_check").fetchall() == []

    def test_migration_is_idempotent(self, old_database: Any) -> None:
        apo_db._add_self_serve_invitation_schema()
        apo_db._add_self_serve_invitation_schema()

        with old_database.connect() as conn:
            assert conn.exec_driver_sql(
                "SELECT COUNT(*) FROM hosted_access_invitations"
            ).scalar_one() == 1

    def test_self_serve_rung_is_registered(self) -> None:
        # The hot-query indexes took v71 after this migration's era; the
        # registration itself is stable.
        rung = apo_db._SCHEMA_MIGRATIONS[70]
        assert "self-serve" in (rung.__doc__ or "")


# ---------------------------------------------------------------------------
# Scenes through the registered routes
# ---------------------------------------------------------------------------


def _accept_new(client: TestClient, token: str, project_name: str) -> Any:
    return client.post(
        "/auth/hosted-access/accept/create-account",
        json={
            "token": token,
            "name": "Newcomer",
            "password": PASSWORD,
            "project_name": project_name,
        },
    )


def _login(client: TestClient, email: str) -> Any:
    return client.post("/auth/verify-password", json={"email": email, "password": PASSWORD})


@pytest.mark.real_auth
class TestStrangerJourneyScene:
    """Real auth middleware: every step a stranger takes must be reachable
    with no session, which is what the PUBLIC_PATHS wiring provides."""

    def test_request_email_accept_then_gated_login(
        self, client: TestClient, session: Session, self_serve: CapturingEmailService
    ) -> None:
        requested = client.post(REQUEST_PATH, json={"email": "Stranger@Example.com"})
        assert requested.status_code == 202
        assert requested.json() == {"message": GENERIC_MESSAGE}

        [invitation_mail] = self_serve.sent
        assert invitation_mail["to"] == "stranger@example.com"
        token = _token_from(invitation_mail)

        preview = client.get("/auth/hosted-access/preview", params={"token": token})
        assert preview.status_code == 200
        assert preview.json() == {
            "valid": True,
            "reason": None,
            "email": "s***r@example.com",
            "requires_login": False,
            "requires_account_creation": True,
        }

        accepted = _accept_new(client, token, "Stranger Project")
        assert accepted.status_code == 200
        assert accepted.json() == {
            "status": "accepted",
            "project_id": accepted.json()["project_id"],
            "email": "stranger@example.com",
            "email_verification_required": True,
        }
        project_id = accepted.json()["project_id"]

        session.expire_all()
        user = session.exec(
            select(UserDB).where(UserDB.email == "stranger@example.com")
        ).one()
        assert user.requires_email_verification is True
        assert user.email_verified_at is None
        assert user.is_admin is False
        assert [p.id for p in session.exec(select(ProjectDB)).all()] == [project_id]
        [membership] = session.exec(select(ProjectMembershipDB)).all()
        assert (membership.user_id, membership.role) == (user.id, "owner")

        gated = _login(client, "stranger@example.com")
        assert gated.status_code == 403
        assert gated.json()["detail"] == {
            "message": "Email verification required",
            "code": "EMAIL_NOT_VERIFIED",
        }

        # The CLI's password-based entry points sit behind the same gate,
        # or an unverified account could mint an API key and never verify.
        credentials = {"email": "stranger@example.com", "password": PASSWORD}
        key_before = client.post(
            "/v1/api-keys/bootstrap",
            json={**credentials, "project": project_id, "name": "cli"},
        )
        project_before = client.post(
            "/v1/projects/bootstrap", json={**credentials, "name": "Second"}
        )
        assert key_before.status_code == project_before.status_code == 403
        assert key_before.json()["detail"]["code"] == "EMAIL_NOT_VERIFIED"
        assert project_before.json()["detail"]["code"] == "EMAIL_NOT_VERIFIED"

        otp_mail = self_serve.sent[-1]
        assert len(self_serve.sent) == 2
        assert otp_mail["to"] == "stranger@example.com"
        code_match = re.search(r"\b(\d{6})\b", otp_mail["text"])
        assert code_match is not None
        verified = client.post(
            "/auth/verify-email",
            json={"email": "stranger@example.com", "code": code_match.group(1)},
        )
        assert verified.status_code == 200
        assert verified.json()["verified"] is True

        logged_in = _login(client, "stranger@example.com")
        assert logged_in.status_code == 200
        assert [p["id"] for p in logged_in.json()["projects"]] == [project_id]
        key_after = client.post(
            "/v1/api-keys/bootstrap",
            json={**credentials, "project": project_id, "name": "cli"},
        )
        assert key_after.status_code in (200, 201)

        replay = _accept_new(client, token, "Second Project")
        assert replay.status_code == 409
        session.expire_all()
        assert len(session.exec(select(ProjectDB)).all()) == 1

    def test_admin_invited_acceptance_still_logs_in_without_a_code(
        self, client: TestClient, session: Session, self_serve: CapturingEmailService
    ) -> None:
        admin = _make_user(session, "admin@example.com", is_admin=True)
        asyncio.run(
            create_or_refresh_hosted_access_invitation(
                session, email="guest@example.com", invited_by_user_id=admin.id
            )
        )
        token = _token_from(self_serve.sent[0])

        accepted = _accept_new(client, token, "Guest Project")
        assert accepted.status_code == 200
        assert accepted.json()["email_verification_required"] is False

        session.expire_all()
        user = session.exec(select(UserDB).where(UserDB.email == "guest@example.com")).one()
        assert user.requires_email_verification is False
        assert user.email_verified_at is not None
        assert len(self_serve.sent) == 1, "no verification code is mailed"
        assert _login(client, "guest@example.com").status_code == 200

    def test_mode_endpoint_reports_the_open_door(
        self, client: TestClient, self_serve: CapturingEmailService
    ) -> None:
        response = client.get("/auth/hosted-access/mode")

        assert response.status_code == 200
        assert response.json() == {"mode": "self_serve"}


@pytest.mark.real_auth
class TestModeOffScene:
    def test_request_is_refused_and_mode_reports_invite_only(
        self,
        client: TestClient,
        session: Session,
        mailbox: CapturingEmailService,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("APO_SIGNUP_MODE", "invite_only")

        refused = client.post(REQUEST_PATH, json={"email": "stranger@example.com"})
        mode = client.get("/auth/hosted-access/mode")

        assert refused.status_code == 503
        assert "token=" not in refused.text
        assert mode.json() == {"mode": "invite_only"}
        assert _invitations(session) == []
        assert mailbox.sent == []

    def test_door_is_closed_by_default(
        self, client: TestClient, mailbox: CapturingEmailService, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("APO_SIGNUP_MODE", raising=False)

        assert client.post(REQUEST_PATH, json={"email": "a@example.com"}).status_code == 503
        assert client.get("/auth/hosted-access/mode").json() == {"mode": "invite_only"}

    def test_self_serve_without_a_transport_stays_closed(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Email-only delivery is the security property: with nothing to
        deliver through, the door must not open at runtime either."""
        monkeypatch.setenv("APO_SIGNUP_MODE", "self_serve")
        monkeypatch.setattr(email_module, "_service", email_module.LogOnlyEmailService())

        assert client.post(REQUEST_PATH, json={"email": "a@example.com"}).status_code == 503
        assert client.get("/auth/hosted-access/mode").json() == {"mode": "invite_only"}

    def test_outstanding_self_serve_link_still_accepts_after_the_door_closes(
        self,
        client: TestClient,
        self_serve: CapturingEmailService,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client.post(REQUEST_PATH, json={"email": "early@example.com"})
        token = _token_from(self_serve.sent[0])
        monkeypatch.setenv("APO_SIGNUP_MODE", "invite_only")

        assert _accept_new(client, token, "Early Project").status_code == 200


class TestAdminFlowUnchanged:
    def test_admin_create_and_list_with_the_door_closed(
        self, session: Session, make_authed_client: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_SIGNUP_MODE", "invite_only")
        admin = _make_user(session, "admin@example.com", is_admin=True)
        client: TestClient = make_authed_client(admin.id, session)

        created = client.post(
            "/v1/admin/hosted-access-invitations", json={"email": "invitee@example.com"}
        )

        assert created.status_code == 201
        body = created.json()
        assert body["invitation"]["origin"] == "admin"
        assert body["invitation"]["invited_by_user_id"] == admin.id
        assert body["delivery_status"] == "link_only"
        assert body["invite_url"], "the admin copy-link fallback is untouched"
        [listed] = client.get("/v1/admin/hosted-access-invitations").json()
        assert listed["origin"] == "admin"

    def test_admin_list_shows_self_serve_origin(
        self,
        client: TestClient,
        session: Session,
        self_serve: CapturingEmailService,
        make_authed_client: Any,
    ) -> None:
        client.post(REQUEST_PATH, json={"email": "walkin@example.com"})
        admin = _make_user(session, "admin@example.com", is_admin=True)
        admin_client: TestClient = make_authed_client(admin.id, session)

        [listed] = admin_client.get("/v1/admin/hosted-access-invitations").json()

        assert listed["origin"] == "self_serve"
        assert listed["invited_by_user_id"] is None

    def test_admin_reinvite_takes_over_a_self_serve_row(
        self,
        client: TestClient,
        session: Session,
        self_serve: CapturingEmailService,
    ) -> None:
        client.post(REQUEST_PATH, json={"email": "walkin@example.com"})
        assert [row.origin for row in _invitations(session)] == ["self_serve"]
        admin = _make_user(session, "admin@example.com", is_admin=True)

        asyncio.run(
            create_or_refresh_hosted_access_invitation(
                session, email="walkin@example.com", invited_by_user_id=admin.id
            )
        )

        [invitation] = _invitations(session)
        assert (invitation.origin, invitation.invited_by_user_id) == ("admin", admin.id)
