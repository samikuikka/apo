# pyright: reportAny=false, reportAttributeAccessIssue=false, reportDeprecated=false, reportExplicitAny=false, reportImplicitStringConcatenation=false, reportMissingParameterType=false, reportOptionalMemberAccess=false, reportPrivateLocalImportUsage=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedFunction=false, reportUnusedParameter=false

"""API keys stop authenticating when their creator is deactivated.

The middleware re-reads the creator's ``is_active`` on every Basic /
legacy-Bearer authentication. These tests run against the real
AuthMiddleware on the file engine: a warm positive key-cache entry must
not outlive the deactivation, and reactivation must restore the key on
the very next request.
"""

import base64
import hashlib
import json
import os
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlmodel import Session

from apo.db import engine as file_engine
from apo.db import reset_apo_file_db
from apo.models.db import ApiKeyDB, ProjectDB, ProjectMembershipDB, UserDB

_PK, _SK = "pk-apo-deacttest00001", "sk-apo-deacttest00001"
_PROJECT_ID = "deact-p1"
_CREATOR_EMAIL = "deact@test.dev"


def _basic_headers() -> dict[str, str]:
    token = base64.b64encode(f"{_PK}:{_SK}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def _ingest(client: TestClient) -> Response:
    body = json.dumps(
        {
            "resourceSpans": [
                {
                    "scopeSpans": [
                        {
                            "scope": {"name": "t"},
                            "spans": [
                                {
                                    "traceId": ("ab" * 15) + "01",
                                    "spanId": f"{1:016x}",
                                    "name": "span.0",
                                    "kind": 1,
                                    "flags": 1,
                                    "startTimeUnixNano": "1700000000000000000",
                                    "status": {"code": 1},
                                }
                            ],
                        }
                    ]
                }
            ]
        }
    ).encode()
    return client.post(
        "/api/public/otel/v1/traces",
        headers={**_basic_headers(), "Content-Type": "application/json"},
        content=body,
    )


def _set_creator_active(user_id: str, active: bool) -> None:
    """Flip the creator's is_active on the engine the middleware reads."""
    with Session(file_engine) as s:
        user = s.get(UserDB, user_id)
        assert user is not None
        user.is_active = active
        s.add(user)
        s.commit()


@pytest.fixture()
def file_key_creator(monkeypatch: pytest.MonkeyPatch):
    """Seed user+project+membership+key on the FILE engine; return user id.

    Known pk/sk pair with the salted hash formula so the Basic header is
    built in the test, not minted through an endpoint.
    """
    reset_apo_file_db()
    with Session(file_engine) as s:
        user = UserDB(email=_CREATOR_EMAIL, name="d", password_hash="x", is_active=True)
        s.add(user)
        s.commit()
        s.refresh(user)
        now_iso = datetime.now(timezone.utc)
        s.add(ProjectDB(id=_PROJECT_ID, name=_PROJECT_ID, created_by=user.id))
        s.commit()
        s.add(
            ProjectMembershipDB(
                project_id=_PROJECT_ID,
                user_id=user.id,
                role="owner",
                created_at=now_iso,
                updated_at=now_iso,
            )
        )
        salt = os.environ.get("API_KEY_SALT", "")
        s.add(
            ApiKeyDB(
                name="deact-test",
                public_key=_PK,
                hashed_secret_key=hashlib.sha256(f"{_SK}:{salt}".encode()).hexdigest(),
                display_secret_key="sk-apo-de...",
                prefix=_PK[:8],
                project=_PROJECT_ID,
                created_by=user.id,
                scope="full",
            )
        )
        s.commit()
        user_id = user.id

    # A GET whose real credential was rejected must not fall through to the
    # anonymous-demo credential: that path reads the secret from the live
    # environment, so an unset value keeps these 401s deterministic.
    monkeypatch.delenv("AUTH_SECRET", raising=False)

    # The app's DI session must resolve to the SAME engine the auth
    # middleware reads, or route handlers and assertions land on
    # different databases.
    from apo.api import app
    from apo.db import get_session

    def _file_session():
        with Session(file_engine) as request_session:
            yield request_session

    app.dependency_overrides[get_session] = _file_session
    try:
        yield user_id
    finally:
        app.dependency_overrides.pop(get_session, None)


@pytest.mark.real_auth
class TestDeactivatedCreatorKey:
    def test_key_works_before_deactivation(
        self, client: TestClient, file_key_creator: str
    ) -> None:
        resp = _ingest(client)
        assert resp.status_code == 200, resp.text

    def test_deactivated_creator_rejected_on_ingest(
        self, client: TestClient, file_key_creator: str
    ) -> None:
        # Warm the positive key cache first: the deactivation must take
        # effect against an already-cached valid key, not a cold one.
        assert _ingest(client).status_code == 200
        _set_creator_active(file_key_creator, False)
        resp = _ingest(client)
        assert resp.status_code == 401

    def test_deactivated_creator_rejected_on_project_route(
        self, client: TestClient, file_key_creator: str
    ) -> None:
        # Establish the pre-state so the final 401 can only come from the
        # middleware rejecting the credential, not from a wrong path.
        before = client.get(f"/v1/projects/{_PROJECT_ID}", headers=_basic_headers())
        assert before.status_code == 200, before.text
        _set_creator_active(file_key_creator, False)
        resp = client.get(f"/v1/projects/{_PROJECT_ID}", headers=_basic_headers())
        assert resp.status_code == 401

    def test_reactivation_restores_key(
        self, client: TestClient, file_key_creator: str
    ) -> None:
        assert _ingest(client).status_code == 200
        _set_creator_active(file_key_creator, False)
        assert _ingest(client).status_code == 401
        _set_creator_active(file_key_creator, True)
        resp = _ingest(client)
        assert resp.status_code == 200, resp.text
