# pyright: reportAny=false, reportAttributeAccessIssue=false, reportDeprecated=false, reportExplicitAny=false, reportImplicitStringConcatenation=false, reportMissingParameterType=false, reportOptionalMemberAccess=false, reportPrivateLocalImportUsage=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedFunction=false, reportUnusedParameter=false

"""Account-level ingest quota (APO_USER_DAILY_SPAN_QUOTA).

Covers: the aggregate blocks across keys of one user while per-key
quotas stay unlimited, isolation between users, default-off behavior,
the per-key quota still answering first, non-fatal accounting that
survives a missing aggregate table, and the v63 migration seam.
"""

import hashlib
import json
import os
from collections.abc import Iterator
from datetime import datetime, timezone

import pytest
from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient
from sqlmodel import Session, select, text

from apo.db import engine as file_engine
from apo.db import reset_apo_file_db
from apo.models.db import (
    ApiKeyDB,
    OtlpIngestBatchDB,
    ProjectDB,
    ProjectMembershipDB,
    UserDB,
    UserDailyUsageDB,
)
from apo.services import ingest_quota

NOW = datetime.now(timezone.utc)


def _payload(spans: int = 2) -> bytes:
    span_list = []
    for i in range(spans):
        span_list.append(
            {
                "traceId": "ab" * 16,
                "spanId": f"{i + 1:016x}",
                "name": f"span.{i}",
                "kind": 1,
                "flags": 1,
                "startTimeUnixNano": "1700000000000000000",
                "status": {"code": 1},
            }
        )
    return json.dumps(
        {"resourceSpans": [{"scopeSpans": [{"scope": {"name": "t"}, "spans": span_list}]}]}
    ).encode()


def _auth(pk: str, sk: str) -> dict[str, str]:
    import base64

    token = base64.b64encode(f"{pk}:{sk}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def _ingest(client: TestClient, headers: dict[str, str]):
    return client.post(
        "/api/public/otel/v1/traces",
        headers={**headers, "Content-Type": "application/json"},
        content=_payload(),
    )


def _seed_user(session: Session, *, email: str, project: str) -> UserDB:
    session.add(UserDB(email=email, name=email.split("@")[0], password_hash="x", is_active=True))
    session.commit()
    user = session.exec(select(UserDB).where(UserDB.email == email)).first()
    assert user is not None
    session.add(ProjectDB(id=project, name=project, created_by=user.id))
    session.commit()
    now_iso = datetime.now(timezone.utc)
    session.add(
        ProjectMembershipDB(
            project_id=project, user_id=user.id, role="owner",
            created_at=now_iso, updated_at=now_iso,
        )
    )
    session.commit()
    return user


def _seed_key(
    session: Session, *, user_id: str, pk: str, sk: str, project: str
) -> ApiKeyDB:
    salt = os.environ.get("API_KEY_SALT", "")
    key = ApiKeyDB(
        name=f"key-{pk[-4:]}",
        public_key=pk,
        hashed_secret_key=hashlib.sha256(f"{sk}:{salt}".encode()).hexdigest(),
        display_secret_key=f"{sk[:11]}...",
        prefix=pk[:8],
        project=project,
        created_by=user_id,
        scope="full",
    )
    session.add(key)
    session.commit()
    session.refresh(key)
    return key


def _set_user_span_quota(user_id: str, quota: int | None) -> None:
    """Direct DB write on the file engine. The middleware reads the
    creator row fresh on every request, so the next ingest sees the new
    value without any cache invalidation."""
    with Session(file_engine) as s:
        user = s.get(UserDB, user_id)
        assert user is not None
        user.daily_span_quota = quota
        s.add(user)
        s.commit()


@pytest.fixture(autouse=True)
def _fresh_quota_caches() -> Iterator[None]:
    ingest_quota._today_counts.clear()
    ingest_quota._today_user_counts.clear()
    yield
    ingest_quota._today_counts.clear()
    ingest_quota._today_user_counts.clear()


@pytest.fixture(autouse=True)
def _user_quota_off_by_default(monkeypatch: MonkeyPatch) -> Iterator[None]:
    monkeypatch.delenv("APO_USER_DAILY_SPAN_QUOTA", raising=False)
    yield


@pytest.fixture()
def session_key(session: Session) -> tuple[ApiKeyDB, str]:
    """One user + one key on the test-session engine (accounting unit tests)."""
    user = _seed_user(session, email="acct-unit@test.dev", project="pu")
    key = _seed_key(
        session, user_id=user.id,
        pk="pk-apo-acctunit00001", sk="sk-apo-acctunit00001", project="pu",
    )
    return key, user.id


@pytest.fixture()
def file_keys() -> Iterator[dict[str, tuple[str, str, str, str]]]:
    """Three keys on the FILE engine the middleware reads.

    key-a and key-b belong to user1 (project p1); key-c belongs to user2
    (project p2). Returns pk/sk/key_id/user_id per key.
    """
    reset_apo_file_db()
    with Session(file_engine) as s:
        u1 = _seed_user(s, email="acct-u1@test.dev", project="p1")
        u1_id = u1.id
        u2 = _seed_user(s, email="acct-u2@test.dev", project="p2")
        u2_id = u2.id
        key_a = _seed_key(
            s, user_id=u1_id,
            pk="pk-apo-acctqa0000001", sk="sk-apo-acctqa0000001", project="p1",
        )
        key_a_id = key_a.id
        key_b = _seed_key(
            s, user_id=u1_id,
            pk="pk-apo-acctqa0000002", sk="sk-apo-acctqa0000002", project="p1",
        )
        key_b_id = key_b.id
        key_c = _seed_key(
            s, user_id=u2_id,
            pk="pk-apo-acctqa0000003", sk="sk-apo-acctqa0000003", project="p2",
        )
        key_c_id = key_c.id

    # Unify engines: the app's DI session must resolve to the SAME engine
    # the auth middleware reads, or accounting and assertions land on
    # different databases (prod is always one engine).
    from apo.api import app
    from apo.db import get_session

    def _file_session():
        with Session(file_engine) as request_session:
            yield request_session

    app.dependency_overrides[get_session] = _file_session
    try:
        yield {
            "a": ("pk-apo-acctqa0000001", "sk-apo-acctqa0000001", key_a_id, u1_id),
            "b": ("pk-apo-acctqa0000002", "sk-apo-acctqa0000002", key_b_id, u1_id),
            "c": ("pk-apo-acctqa0000003", "sk-apo-acctqa0000003", key_c_id, u2_id),
        }
    finally:
        app.dependency_overrides.pop(get_session, None)


# ---------------------------------------------------------------------------
# Enforcement through the real middleware stack (real auth)
# ---------------------------------------------------------------------------


@pytest.mark.real_auth
class TestAccountQuotaRealAuth:
    def test_aggregate_blocks_across_keys_of_one_user(
        self, client: TestClient, file_keys: dict[str, tuple[str, str, str, str]],
        monkeypatch: MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("APO_USER_DAILY_SPAN_QUOTA", "4")
        pk_a, sk_a, _, u1 = file_keys["a"]
        pk_b, sk_b, _, _ = file_keys["b"]

        # Per-key quotas are unlimited; only the account cap can answer.
        assert _ingest(client, _auth(pk_a, sk_a)).status_code == 200
        assert _ingest(client, _auth(pk_b, sk_b)).status_code == 200

        # Third batch would push the account to 6 > 4.
        resp = _ingest(client, _auth(pk_a, sk_a))
        assert resp.status_code == 429, resp.text
        assert "Retry-After" in resp.headers
        detail = resp.json()["detail"]
        assert "account" in detail["message"]
        assert detail["quota"]["limit"] == 4
        assert detail["quota"]["used"] == 4
        assert "reset_at" in detail["quota"]

        # Only the two accepted batches exist; the blocked one wrote nothing.
        with Session(file_engine) as s:
            batches = s.exec(select(OtlpIngestBatchDB)).all()
            assert len(batches) == 2
            agg = ingest_quota.today_user_usage(s, u1)
            assert agg is not None and agg["spans"] == 4

    def test_other_user_unaffected(
        self, client: TestClient, file_keys: dict[str, tuple[str, str, str, str]],
        monkeypatch: MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("APO_USER_DAILY_SPAN_QUOTA", "4")
        pk_a, sk_a, _, _ = file_keys["a"]
        pk_b, sk_b, _, _ = file_keys["b"]
        pk_c, sk_c, _, _ = file_keys["c"]

        assert _ingest(client, _auth(pk_a, sk_a)).status_code == 200
        assert _ingest(client, _auth(pk_b, sk_b)).status_code == 200
        assert _ingest(client, _auth(pk_a, sk_a)).status_code == 429

        # user2 has their own aggregate; their ingest is untouched.
        assert _ingest(client, _auth(pk_c, sk_c)).status_code == 200

    def test_off_by_default(
        self, client: TestClient, file_keys: dict[str, tuple[str, str, str, str]],
    ) -> None:
        pk_a, sk_a, _, _ = file_keys["a"]
        pk_b, sk_b, _, _ = file_keys["b"]
        assert _ingest(client, _auth(pk_a, sk_a)).status_code == 200
        assert _ingest(client, _auth(pk_b, sk_b)).status_code == 200
        assert _ingest(client, _auth(pk_a, sk_a)).status_code == 200

    def test_per_key_quota_still_answers_first(
        self, client: TestClient, file_keys: dict[str, tuple[str, str, str, str]],
        monkeypatch: MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("APO_USER_DAILY_SPAN_QUOTA", "100000")
        pk_a, sk_a, key_a_id, _ = file_keys["a"]

        from apo.auth.api_key_cache import api_key_cache

        with Session(file_engine) as s:
            row = s.get(ApiKeyDB, key_a_id)
            assert row is not None
            row.daily_span_quota = 1
            s.add(row)
            s.commit()
        api_key_cache.invalidate_all()

        resp = _ingest(client, _auth(pk_a, sk_a))
        assert resp.status_code == 429, resp.text
        message = resp.json()["detail"]["message"]
        assert "API key" in message and "account" not in message


@pytest.mark.real_auth
class TestPerUserSpanQuotaOverride:
    """The users.daily_span_quota column vs the env default."""

    def test_column_blocks_with_no_env(
        self, client: TestClient, file_keys: dict[str, tuple[str, str, str, str]],
    ) -> None:
        # Env unset (autouse fixture); the column alone carries the cap.
        pk_a, sk_a, _, u1 = file_keys["a"]
        pk_b, sk_b, _, _ = file_keys["b"]
        _set_user_span_quota(u1, 2)

        assert _ingest(client, _auth(pk_a, sk_a)).status_code == 200
        resp = _ingest(client, _auth(pk_b, sk_b))
        assert resp.status_code == 429, resp.text
        detail = resp.json()["detail"]
        assert "account" in detail["message"]
        assert detail["quota"]["limit"] == 2
        assert detail["quota"]["used"] == 2

    def test_null_falls_back_to_env(
        self, client: TestClient, file_keys: dict[str, tuple[str, str, str, str]],
        monkeypatch: MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("APO_USER_DAILY_SPAN_QUOTA", "4")
        pk_a, sk_a, _, _ = file_keys["a"]
        pk_b, sk_b, _, _ = file_keys["b"]
        # Column stays NULL: the env default is the limit.

        assert _ingest(client, _auth(pk_a, sk_a)).status_code == 200
        assert _ingest(client, _auth(pk_b, sk_b)).status_code == 200
        resp = _ingest(client, _auth(pk_a, sk_a))
        assert resp.status_code == 429, resp.text
        assert resp.json()["detail"]["quota"]["limit"] == 4

    def test_zero_exempts_from_env(
        self, client: TestClient, file_keys: dict[str, tuple[str, str, str, str]],
        monkeypatch: MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("APO_USER_DAILY_SPAN_QUOTA", "4")
        pk_a, sk_a, _, u1 = file_keys["a"]
        pk_b, sk_b, _, _ = file_keys["b"]
        _set_user_span_quota(u1, 0)

        # 6 accepted spans total, past the env cap of 4: column 0 means
        # this account is unlimited even under the env default.
        assert _ingest(client, _auth(pk_a, sk_a)).status_code == 200
        assert _ingest(client, _auth(pk_b, sk_b)).status_code == 200
        assert _ingest(client, _auth(pk_a, sk_a)).status_code == 200

    def test_raise_and_lower_reflect_on_next_ingest(
        self, client: TestClient, file_keys: dict[str, tuple[str, str, str, str]],
    ) -> None:
        pk_a, sk_a, _, u1 = file_keys["a"]
        pk_b, sk_b, _, _ = file_keys["b"]
        _set_user_span_quota(u1, 2)

        assert _ingest(client, _auth(pk_a, sk_a)).status_code == 200
        assert _ingest(client, _auth(pk_b, sk_b)).status_code == 429

        # Raise: the same third batch now fits (4 accepted, cap 6).
        _set_user_span_quota(u1, 6)
        assert _ingest(client, _auth(pk_b, sk_b)).status_code == 200

        # Lower below what this next batch needs: blocked again, at the
        # new limit. Only accepted batches count (the blocked second
        # batch wrote nothing), so used is 4.
        _set_user_span_quota(u1, 5)
        resp = _ingest(client, _auth(pk_a, sk_a))
        assert resp.status_code == 429, resp.text
        detail = resp.json()["detail"]
        assert detail["quota"]["limit"] == 5
        assert detail["quota"]["used"] == 4


# ---------------------------------------------------------------------------
# Accounting unit + seam
# ---------------------------------------------------------------------------


class TestAccounting:
    def test_user_rollup_row_written(
        self, session: Session, session_key: tuple[ApiKeyDB, str]
    ) -> None:
        key, user_id = session_key
        ingest_quota.record_ingest_usage(session, key.id, spans=5, bytes_=100)
        ingest_quota.record_ingest_usage(session, key.id, spans=3, bytes_=50)

        row = session.get(UserDailyUsageDB, (user_id, NOW.strftime("%Y-%m-%d")))
        assert row is not None
        assert row.span_count == 8
        assert row.request_count == 2
        agg = ingest_quota.today_user_usage(session, user_id)
        assert agg is not None and agg["spans"] == 8

    def test_record_survives_missing_user_table(
        self, session: Session, session_key: tuple[ApiKeyDB, str]
    ) -> None:
        key, _ = session_key
        session.execute(text("DROP TABLE user_daily_usage"))
        session.commit()

        # Accepted spans must not 500; per-key accounting still lands.
        ingest_quota.record_ingest_usage(session, key.id, spans=9, bytes_=9)
        per_key = ingest_quota.today_usage(session, key.id)
        assert per_key is not None and per_key["spans"] == 9

        session.execute(
            text(
                "CREATE TABLE user_daily_usage (user_id VARCHAR(36), day VARCHAR(10), "
                "span_count INTEGER DEFAULT 0, byte_count INTEGER DEFAULT 0, "
                "request_count INTEGER DEFAULT 0, updated_at DATETIME, "
                "PRIMARY KEY (user_id, day))"
            )
        )
        session.commit()


class TestV63Seam:
    def test_rerun_safe(self) -> None:
        import apo.models.db as mdb
        from apo.db import _migrate_to_v63, engine

        mdb.SQLModel.metadata.create_all(engine)
        _migrate_to_v63()
        _migrate_to_v63()  # must not raise
