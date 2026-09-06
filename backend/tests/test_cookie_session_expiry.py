# pyright: reportAny=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportAttributeAccessIssue=false, reportMissingParameterType=false

"""Server-side enforcement of session-cookie expiry.

The browser's Max-Age and Auth.js's own expiry check only stop a *client*
from using an expired cookie. A stolen raw value is replayed with neither,
so the backend is the only place an expiry can be enforced. These tests
mint real JWE cookies (same HKDF derivation as Auth.js) and exercise the
middleware's decrypt-and-validate path directly.
"""

import json
import time
from collections.abc import Iterator
from uuid import uuid4

import pytest
from sqlmodel import Session

from apo import auth as auth_module
from apo.auth import hash_password
from apo.auth.middleware import _authenticate_cookie
from apo.models.db import UserDB

_TEST_SECRET = "unit-test-auth-secret-0123456789abcdef"


@pytest.fixture(name="auth_env")
def auth_env_fixture(monkeypatch: pytest.MonkeyPatch) -> Iterator[Session]:
    """Patch the decrypt secret and point the middleware's DB session at a
    fresh in-memory engine.

    The engine is patched through ``_authenticate_cookie.__globals__``: the
    middleware binds ``engine`` at import time, and some tests reload the
    middleware module mid-session, so ``sys.modules`` lookups are not
    guaranteed to address the namespace this function actually executes in
    (the conftest solves the same problem for AUTH_SECRET the same way).
    """
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, create_engine

    test_engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(test_engine)
    monkeypatch.setattr(auth_module, "AUTH_SECRET", _TEST_SECRET)
    monkeypatch.setitem(_authenticate_cookie.__globals__, "engine", test_engine)
    with Session(test_engine) as db:
        yield db


def _mint_session_cookie(payload: dict[str, object], secret: str) -> str:
    from jose import jwe

    from apo.auth import _NEXTAUTH_KEY_LEN, _hkdf_sha256

    cookie_name = "authjs.session-token"
    info = f"Auth.js Generated Encryption Key ({cookie_name})"
    key = _hkdf_sha256(
        ikm=secret.encode("utf-8"),
        salt=cookie_name.encode("utf-8"),
        info=info.encode("utf-8"),
        length=_NEXTAUTH_KEY_LEN,
    )
    # Auth.js session cookies are dir + A256CBC-HS512 JWEs; the 64-byte
    # HKDF output is the full content-encryption key for that suite.
    return jwe.encrypt(
        json.dumps(payload), key, algorithm="dir", encryption="A256CBC-HS512"
    ).decode("utf-8")


def _make_user(session: Session) -> UserDB:
    user = UserDB(
        email=f"expiry-{uuid4().hex[:8]}@test.com",
        name="Expiry Test",
        password_hash=hash_password("SecretPass123"),
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _cookie_for(
    user: UserDB, *, iat: int | None, exp: int | None, secret: str
) -> str:
    payload: dict[str, object] = {"sub": user.id}
    if iat is not None:
        payload["iat"] = iat
    if exp is not None:
        payload["exp"] = exp
    return _mint_session_cookie(payload, secret)


class TestCookieSessionExpiry:
    def test_current_cookie_authenticates(self, auth_env: Session) -> None:
        user = _make_user(auth_env)
        now = int(time.time())
        token = _cookie_for(user, iat=now - 60, exp=now + 3600, secret=_TEST_SECRET)
        ctx = _authenticate_cookie(token)
        assert ctx is not None
        assert ctx["user_id"] == user.id

    def test_expired_cookie_is_rejected(self, auth_env: Session) -> None:
        user = _make_user(auth_env)
        now = int(time.time())
        token = _cookie_for(user, iat=now - 7200, exp=now - 60, secret=_TEST_SECRET)
        assert _authenticate_cookie(token) is None

    def test_cookie_without_exp_is_rejected(self, auth_env: Session) -> None:
        """A token with no exp cannot be bounded — fail closed."""
        user = _make_user(auth_env)
        now = int(time.time())
        token = _cookie_for(user, iat=now - 60, exp=None, secret=_TEST_SECRET)
        assert _authenticate_cookie(token) is None

    def test_unparseable_exp_is_rejected(self, auth_env: Session) -> None:
        user = _make_user(auth_env)
        now = int(time.time())
        payload: dict[str, object] = {"sub": user.id, "iat": now - 60, "exp": "not-a-number"}
        token = _mint_session_cookie(payload, _TEST_SECRET)
        assert _authenticate_cookie(token) is None

    def test_stale_iat_beyond_age_cap_is_rejected(
        self, auth_env: Session
    ) -> None:
        """Fresh exp but issued 20 days ago (default cap is 14) — rejected."""
        user = _make_user(auth_env)
        now = int(time.time())
        token = _cookie_for(
            user, iat=now - 20 * 86400, exp=now + 10 * 86400, secret=_TEST_SECRET
        )
        assert _authenticate_cookie(token) is None

    def test_age_cap_env_override_raises_the_cap(
        self,
        auth_env: Session,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        user = _make_user(auth_env)
        now = int(time.time())
        monkeypatch.setenv("AUTH_SESSION_MAX_AGE_SECONDS", str(30 * 86400))
        token = _cookie_for(
            user, iat=now - 20 * 86400, exp=now + 10 * 86400, secret=_TEST_SECRET
        )
        assert _authenticate_cookie(token) is not None

    def test_age_cap_env_override_lowers_the_cap(
        self,
        auth_env: Session,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        user = _make_user(auth_env)
        now = int(time.time())
        monkeypatch.setenv("AUTH_SESSION_MAX_AGE_SECONDS", "60")
        stale = _cookie_for(user, iat=now - 120, exp=now + 3600, secret=_TEST_SECRET)
        assert _authenticate_cookie(stale) is None

        fresh = _cookie_for(user, iat=now - 10, exp=now + 3600, secret=_TEST_SECRET)
        assert _authenticate_cookie(fresh) is not None

    def test_invalidated_session_still_rejected_after_expiry_check(
        self, auth_env: Session
    ) -> None:
        """token_invalid_before keeps working alongside the new checks."""
        from datetime import datetime, timezone

        user = _make_user(auth_env)
        now = int(time.time())
        user.token_invalid_before = datetime.now(timezone.utc)
        auth_env.add(user)
        auth_env.commit()

        token = _cookie_for(user, iat=now - 60, exp=now + 3600, secret=_TEST_SECRET)
        assert _authenticate_cookie(token) is None
