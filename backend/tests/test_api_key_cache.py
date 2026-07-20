# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnusedParameter=false, reportExplicitAny=false, reportUnusedFunction=false, reportAttributeAccessIssue=false, reportAssignmentType=false

"""Tests for the API key auth cache (SPEC-093).

Covers:
- ``ApiKeyCache`` class behavior (TTL, eviction, invalidation, thread safety)
- Validation function integration (positive/negative cache hits skip the DB)
- Cache invalidation on revoke/rotate (via API)
- Edge cases (expiry still applies, cache disabled, new key after negative cache)
"""

import hashlib
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import patch

import pytest
from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.auth.api_key_auth import (
    generate_key_pair,
    validate_basic_auth,
    validate_bearer_public_key,
    validate_legacy_bearer,
)
from apo.auth.api_key_cache import (
    ApiKeyCache,
    api_key_cache,
    cache_key_for_basic,
    cache_key_for_bearer_public,
    cache_key_for_legacy,
)
from apo.auth.middleware import _is_expired
from apo.models.db import ApiKeyDB, UserDB

from .conftest import TEST_PROJECT_ID, seed_project_for_user

_TEST_EMAIL = "test@example.com"
_TEST_PASSWORD = "TestPass123"
_TEST_NAME = "Test User"


def _make_api_key(public_key: str = "pk-apo-test", project: str = "test") -> ApiKeyDB:
    """Build a minimal ApiKeyDB for unit tests (no DB needed)."""
    return ApiKeyDB(
        name="Test",
        prefix=public_key[:8],
        public_key=public_key,
        project=project,
        created_by="user1",
    )


def _setup_and_get_authed_client(
    client: TestClient, session: Session, make_authed_client: Any
) -> TestClient:
    """Create a user via the public setup endpoint, then return an authed client."""
    client.post(
        "/auth/setup",
        json={"email": _TEST_EMAIL, "password": _TEST_PASSWORD, "name": _TEST_NAME},
    )
    user = session.exec(select(UserDB)).first()
    assert user is not None
    # Issue #11: mint paths require a real project + membership.
    seed_project_for_user(session, user.id)
    return make_authed_client(user.id, session)


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    """Clear the singleton API key cache before and after each test."""
    api_key_cache.invalidate_all()
    yield
    api_key_cache.invalidate_all()


# ---------------------------------------------------------------------------
# Unit tests: ApiKeyCache class
# ---------------------------------------------------------------------------


class TestApiKeyCacheGetSet:
    def test_positive_hit_returns_cached_value(self) -> None:
        cache = ApiKeyCache(ttl_seconds=60, negative_ttl_seconds=60)
        key_obj = _make_api_key("pk-apo-abc")
        cache.set_positive("k1", key_obj)
        assert cache.get("k1") is key_obj

    def test_negative_hit_returns_none(self) -> None:
        cache = ApiKeyCache(ttl_seconds=60, negative_ttl_seconds=60)
        cache.set_negative("k1")
        result = cache.get("k1")
        assert result is None

    def test_miss_returns_MISS_sentinel(self) -> None:
        cache = ApiKeyCache(ttl_seconds=60, negative_ttl_seconds=60)
        assert cache.get("nonexistent") == "MISS"

    def test_positive_entry_expires_after_ttl(self) -> None:
        cache = ApiKeyCache(ttl_seconds=1, negative_ttl_seconds=60)
        cache.set_positive("k1", _make_api_key())
        assert cache.get("k1") != "MISS"
        time.sleep(1.1)
        assert cache.get("k1") == "MISS"

    def test_negative_entry_expires_after_negative_ttl(self) -> None:
        cache = ApiKeyCache(ttl_seconds=60, negative_ttl_seconds=1)
        cache.set_negative("k1")
        assert cache.get("k1") is None
        time.sleep(1.1)
        assert cache.get("k1") == "MISS"

    def test_sliding_expiration_refreshes_positive_ttl_on_get(self) -> None:
        cache = ApiKeyCache(ttl_seconds=2, negative_ttl_seconds=60)
        cache.set_positive("k1", _make_api_key())
        # At 1s: still valid, get refreshes TTL for another 2s
        time.sleep(1.0)
        assert cache.get("k1") != "MISS"
        # At 2.5s: without refresh, the original 2s TTL would have expired (0.5s ago).
        # With sliding expiration, the get at 1s pushed expiry to 3s, so this is still valid.
        time.sleep(1.5)
        assert cache.get("k1") != "MISS"

    def test_negative_entry_ttl_not_refreshed_on_get(self) -> None:
        cache = ApiKeyCache(ttl_seconds=60, negative_ttl_seconds=2)
        cache.set_negative("k1")
        time.sleep(1.0)
        assert cache.get("k1") is None  # Still within 2s window
        time.sleep(1.1)
        # Total elapsed 2.1s — negative TTL (2s) has elapsed even though we read at 1s.
        assert cache.get("k1") == "MISS"


class TestApiKeyCacheInvalidation:
    def test_invalidate_removes_positive_entry(self) -> None:
        cache = ApiKeyCache()
        cache.set_positive("k1", _make_api_key())
        cache.invalidate("k1")
        assert cache.get("k1") == "MISS"

    def test_invalidate_removes_negative_entry(self) -> None:
        cache = ApiKeyCache()
        cache.set_negative("k1")
        cache.invalidate("k1")
        assert cache.get("k1") == "MISS"

    def test_invalidate_missing_key_is_noop(self) -> None:
        cache = ApiKeyCache()
        # Should not raise
        cache.invalidate("nonexistent")

    def test_invalidate_all_clears_everything(self) -> None:
        cache = ApiKeyCache()
        cache.set_positive("k1", _make_api_key())
        cache.set_negative("k2")
        cache.invalidate_all()
        assert cache.get("k1") == "MISS"
        assert cache.get("k2") == "MISS"
        assert len(cache) == 0


class TestApiKeyCacheEviction:
    def test_self_eviction_at_capacity(self) -> None:
        cache = ApiKeyCache(max_entries=3)
        cache.set_positive("k1", _make_api_key("pk-1"))
        cache.set_positive("k2", _make_api_key("pk-2"))
        cache.set_positive("k3", _make_api_key("pk-3"))
        assert len(cache) == 3
        # Inserting a 4th evicts the oldest (k1)
        cache.set_positive("k4", _make_api_key("pk-4"))
        assert len(cache) == 3
        assert cache.get("k1") == "MISS"  # Evicted
        assert cache.get("k2") != "MISS"
        assert cache.get("k3") != "MISS"
        assert cache.get("k4") != "MISS"

    def test_zero_max_entries_never_caches(self) -> None:
        cache = ApiKeyCache(max_entries=0)
        cache.set_positive("k1", _make_api_key())
        assert cache.get("k1") == "MISS"


class TestApiKeyCacheDisabled:
    def test_cache_disabled_via_env_returns_MISS_on_get(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("API_KEY_CACHE_ENABLED", "false")
        cache = ApiKeyCache()
        cache.set_positive("k1", _make_api_key())
        assert cache.get("k1") == "MISS"

    def test_cache_disabled_via_env_set_positive_is_noop(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("API_KEY_CACHE_ENABLED", "false")
        cache = ApiKeyCache()
        cache.set_positive("k1", _make_api_key())
        assert len(cache) == 0

    def test_cache_disabled_via_env_set_negative_is_noop(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("API_KEY_CACHE_ENABLED", "false")
        cache = ApiKeyCache()
        cache.set_negative("k1")
        assert len(cache) == 0


class TestApiKeyCacheThreadSafety:
    def test_concurrent_access_does_not_crash_or_corrupt(self) -> None:
        cache = ApiKeyCache(ttl_seconds=60, negative_ttl_seconds=60, max_entries=1000)
        errors: list[Exception] = []

        def worker(worker_id: int) -> None:
            try:
                for i in range(50):
                    key = f"key-{worker_id}-{i}"
                    cache.set_positive(key, _make_api_key(f"pk-{key}"))
                    result = cache.get(key)
                    assert result is not None, f"missed {key} just after set"
                    cache.invalidate(key)
                    cache.set_negative(key)
                    assert cache.get(key) is None
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f"Errors in worker threads: {errors}"


# ---------------------------------------------------------------------------
# Integration tests: validation functions consult the cache
# ---------------------------------------------------------------------------


class TestValidationCachingBasic:
    def test_positive_cache_hit_skips_db(self, session: Session) -> None:
        public_key, secret_key, hashed_secret_key, display = generate_key_pair()
        session.add(
            ApiKeyDB(
                name="Test",
                prefix=public_key[:8],
                public_key=public_key,
                hashed_secret_key=hashed_secret_key,
                display_secret_key=display,
                project="test",
                created_by="user1",
            )
        )
        session.commit()

        with patch.object(session, "exec", wraps=session.exec) as spy:
            result1 = validate_basic_auth(public_key, secret_key, session)
            assert result1 is not None
            assert spy.call_count == 1

            result2 = validate_basic_auth(public_key, secret_key, session)
            assert result2 is not None
            assert spy.call_count == 1  # No new DB call — cache hit

    def test_negative_cache_hit_skips_db(self, session: Session) -> None:
        with patch.object(session, "exec", wraps=session.exec) as spy:
            result1 = validate_basic_auth("pk-apo-missing", "sk-apo-wrong", session)
            assert result1 is None
            assert spy.call_count == 1

            result2 = validate_basic_auth("pk-apo-missing", "sk-apo-wrong", session)
            assert result2 is None
            assert spy.call_count == 1  # No new DB call — negative cache hit


class TestCacheKeyDerivation:
    def test_basic_cache_key_includes_public_and_secret_hash(self) -> None:
        assert (
            cache_key_for_basic("pk-apo-1", "hash-a")
            != cache_key_for_basic("pk-apo-1", "hash-b")
        )
        assert (
            cache_key_for_basic("pk-apo-1", "hash-a")
            != cache_key_for_basic("pk-apo-2", "hash-a")
        )

    def test_bearer_public_cache_key_uses_only_public_key(self) -> None:
        assert cache_key_for_bearer_public("pk-apo-1") == "bearer_pub:pk-apo-1"

    def test_legacy_cache_key_uses_token_hash(self) -> None:
        assert cache_key_for_legacy("abc123") == "legacy:abc123"


class TestValidationCachingBasicExpiry:
    def test_positive_cache_expires_after_ttl(self, session: Session) -> None:
        """After the positive TTL elapses, the validation function hits the DB again."""
        local_cache = ApiKeyCache(ttl_seconds=1, negative_ttl_seconds=60)
        public_key, secret_key, hashed_secret_key, display = generate_key_pair()
        session.add(
            ApiKeyDB(
                name="Test",
                prefix=public_key[:8],
                public_key=public_key,
                hashed_secret_key=hashed_secret_key,
                display_secret_key=display,
                project="test",
                created_by="user1",
            )
        )
        session.commit()

        with patch(
            "apo.auth.api_key_auth.api_key_cache", local_cache
        ), patch.object(session, "exec", wraps=session.exec) as spy:
            # First lookup: DB hit, caches positive
            validate_basic_auth(public_key, secret_key, session)
            assert spy.call_count == 1

            # Immediate second lookup: cache hit, no new DB call
            validate_basic_auth(public_key, secret_key, session)
            assert spy.call_count == 1

            # Wait for positive TTL to expire, then re-lookup: DB hit again
            time.sleep(1.1)
            validate_basic_auth(public_key, secret_key, session)
            assert spy.call_count == 2


class TestValidationCachingBearerPublic:
    def test_positive_cache_hit_skips_db(self, session: Session) -> None:
        public_key, _, hashed_secret_key, display = generate_key_pair()
        session.add(
            ApiKeyDB(
                name="Test",
                prefix=public_key[:8],
                public_key=public_key,
                hashed_secret_key=hashed_secret_key,
                display_secret_key=display,
                project="test",
                created_by="user1",
            )
        )
        session.commit()

        with patch.object(session, "exec", wraps=session.exec) as spy:
            result1 = validate_bearer_public_key(public_key, session)
            assert result1 is not None
            assert spy.call_count == 1

            result2 = validate_bearer_public_key(public_key, session)
            assert result2 is not None
            assert spy.call_count == 1  # Cache hit

    def test_negative_cache_hit_skips_db(self, session: Session) -> None:
        with patch.object(session, "exec", wraps=session.exec) as spy:
            result1 = validate_bearer_public_key("pk-apo-missing", session)
            assert result1 is None
            assert spy.call_count == 1

            result2 = validate_bearer_public_key("pk-apo-missing", session)
            assert result2 is None
            assert spy.call_count == 1  # Negative cache hit


class TestValidationCachingLegacy:
    def test_positive_cache_hit_skips_db(self, session: Session) -> None:
        token = "sk-legacylegacy1234567890abcdef"
        hashed = hashlib.sha256(token.encode()).hexdigest()
        session.add(
            ApiKeyDB(
                name="Legacy",
                prefix=token[:8],
                hashed_key=hashed,
                project="test",
                created_by="user1",
            )
        )
        session.commit()

        with patch.object(session, "exec", wraps=session.exec) as spy:
            result1 = validate_legacy_bearer(token, session)
            assert result1 is not None
            assert spy.call_count == 1

            result2 = validate_legacy_bearer(token, session)
            assert result2 is not None
            assert spy.call_count == 1  # Cache hit

    def test_negative_cache_hit_skips_db(self, session: Session) -> None:
        with patch.object(session, "exec", wraps=session.exec) as spy:
            result1 = validate_legacy_bearer("sk-nonexistent", session)
            assert result1 is None
            assert spy.call_count == 1

            result2 = validate_legacy_bearer("sk-nonexistent", session)
            assert result2 is None
            assert spy.call_count == 1  # Negative cache hit


class TestNewKeyAfterNegativeCache:
    def test_new_key_found_after_negative_cache_expires(self, session: Session) -> None:
        """A key created after a negative cache entry is found once the negative TTL expires."""
        # Use a cache with a short negative TTL (1s)
        local_cache = ApiKeyCache(ttl_seconds=300, negative_ttl_seconds=1)
        public_key, _, hashed_secret_key, display = generate_key_pair()

        # Patch the module-level singleton so validate_bearer_public_key uses our cache
        with patch(
            "apo.auth.api_key_auth.api_key_cache", local_cache
        ):
            # First lookup — key does not exist yet → negative cached
            result1 = validate_bearer_public_key(public_key, session)
            assert result1 is None

            # Now create the key in the DB
            session.add(
                ApiKeyDB(
                    name="Late",
                    prefix=public_key[:8],
                    public_key=public_key,
                    hashed_secret_key=hashed_secret_key,
                    display_secret_key=display,
                    project="test",
                    created_by="user1",
                )
            )
            session.commit()

            # Immediate re-lookup still returns None (negative cache hit)
            result2 = validate_bearer_public_key(public_key, session)
            assert result2 is None

            # Wait for negative TTL to expire, then lookup finds the key
            time.sleep(1.1)
            result3 = validate_bearer_public_key(public_key, session)
            assert result3 is not None
            assert result3.public_key == public_key


class TestCacheDisabledSkipsCache:
    def test_validate_skips_cache_when_disabled(
        self, monkeypatch: MonkeyPatch, session: Session
    ) -> None:
        """When API_KEY_CACHE_ENABLED=false, every validation hits the DB."""
        monkeypatch.setenv("API_KEY_CACHE_ENABLED", "false")
        public_key, _, hashed_secret_key, display = generate_key_pair()
        session.add(
            ApiKeyDB(
                name="Test",
                prefix=public_key[:8],
                public_key=public_key,
                hashed_secret_key=hashed_secret_key,
                display_secret_key=display,
                project="test",
                created_by="user1",
            )
        )
        session.commit()

        with patch.object(session, "exec", wraps=session.exec) as spy:
            validate_bearer_public_key(public_key, session)
            assert spy.call_count == 1
            validate_bearer_public_key(public_key, session)
            assert spy.call_count == 2  # Not cached — second DB hit


# ---------------------------------------------------------------------------
# Integration tests: expiry still applies to cached keys
# ---------------------------------------------------------------------------


class TestExpiryStillApplies:
    def test_cached_key_with_past_expires_at_rejected_by_is_expired(
        self, session: Session
    ) -> None:
        """The cache returns the key, but the middleware's _is_expired still rejects it."""
        past = datetime.now(timezone.utc) - timedelta(hours=1)
        public_key, secret_key, hashed_secret_key, display = generate_key_pair()
        session.add(
            ApiKeyDB(
                name="Test",
                prefix=public_key[:8],
                public_key=public_key,
                hashed_secret_key=hashed_secret_key,
                display_secret_key=display,
                project="test",
                created_by="user1",
                expires_at=past,
            )
        )
        session.commit()

        # The validation function finds and caches the key (expiry is not checked here)
        result = validate_basic_auth(public_key, secret_key, session)
        assert result is not None
        # The middleware's expiry check would reject this cached key
        assert _is_expired(result.expires_at) is True

    def test_cached_value_is_independent_of_subsequent_db_mutations(
        self, session: Session
    ) -> None:
        """After caching, mutating the DB row doesn't affect the cached value.

        In production, each request uses a fresh session, so the cached object
        is detached. We simulate that here with ``expunge_all``.
        """
        future = datetime.now(timezone.utc) + timedelta(days=1)
        public_key, secret_key, hashed_secret_key, display = generate_key_pair()
        session.add(
            ApiKeyDB(
                name="Test",
                prefix=public_key[:8],
                public_key=public_key,
                hashed_secret_key=hashed_secret_key,
                display_secret_key=display,
                project="original",
                created_by="user1",
                expires_at=future,
            )
        )
        session.commit()

        result1 = validate_basic_auth(public_key, secret_key, session)
        assert result1 is not None
        assert result1.project == "original"

        # Detach the cached object from the session (simulates session close in prod)
        session.expunge_all()

        # Mutate the project via a fresh query
        db_key = session.exec(
            select(ApiKeyDB).where(ApiKeyDB.public_key == public_key)
        ).first()
        assert db_key is not None
        db_key.project = "changed"
        session.add(db_key)
        session.commit()
        session.expunge_all()

        # Cached result still has the original project (snapshot at cache time)
        result2 = validate_basic_auth(public_key, secret_key, session)
        assert result2 is not None
        assert result2.project == "original"


# ---------------------------------------------------------------------------
# Integration tests: cache invalidation on revoke / rotate
# ---------------------------------------------------------------------------


class TestCacheInvalidationOnRevoke:
    def test_revoke_invalidates_bearer_pub_cache(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "To Revoke", "project": TEST_PROJECT_ID},
        )
        assert create_resp.status_code == 200
        public_key = create_resp.json()["public_key"]
        key_id = create_resp.json()["id"]

        # Populate the cache via direct validation
        result_before = validate_bearer_public_key(public_key, session)
        assert result_before is not None
        # Confirm cache is populated
        assert (
            api_key_cache.get(cache_key_for_bearer_public(public_key))
            is result_before
        )

        # Revoke via API
        revoke_resp = authed.delete(f"/v1/api-keys/{key_id}")
        assert revoke_resp.status_code == 200

        # Cache entry should be invalidated
        assert api_key_cache.get(cache_key_for_bearer_public(public_key)) == "MISS"

        # Direct validation now hits DB and returns None (key is gone)
        result_after = validate_bearer_public_key(public_key, session)
        assert result_after is None


class TestCacheInvalidationOnRotate:
    def test_rotate_invalidates_old_bearer_pub_cache(
        self,
        client: TestClient,
        session: Session,
        make_authed_client: Any,
    ) -> None:
        authed = _setup_and_get_authed_client(client, session, make_authed_client)
        create_resp = authed.post(
            "/v1/api-keys",
            json={"name": "To Rotate", "project": TEST_PROJECT_ID},
        )
        assert create_resp.status_code == 200
        old_public_key = create_resp.json()["public_key"]
        key_id = create_resp.json()["id"]

        # Populate the cache for the OLD public key
        result_before = validate_bearer_public_key(old_public_key, session)
        assert result_before is not None
        assert (
            api_key_cache.get(cache_key_for_bearer_public(old_public_key))
            is result_before
        )

        # Rotate via API
        rotate_resp = authed.post(f"/v1/api-keys/{key_id}/rotate")
        assert rotate_resp.status_code == 200
        new_public_key = rotate_resp.json()["public_key"]
        assert new_public_key != old_public_key

        # Cache entry for the OLD public key should be invalidated
        assert api_key_cache.get(cache_key_for_bearer_public(old_public_key)) == "MISS"

        # Direct validation of the OLD public key now returns None
        result_after = validate_bearer_public_key(old_public_key, session)
        assert result_after is None

        # The NEW public key works (and gets cached on first lookup)
        result_new = validate_bearer_public_key(new_public_key, session)
        assert result_new is not None
