"""In-memory TTL cache for API key validation results (SPEC-093).

Caches both valid keys (positive cache, 5-minute TTL) and invalid keys
(negative cache, 60-second TTL) so the database isn't hit on every
authenticated request. Thread-safe, self-evicts at capacity, and adds
zero external dependencies.

Design follows the same in-memory + lock + self-eviction pattern as
``LoginRateLimiter`` and ``ApiKeyUsageTracker``.
"""

import os
import threading
import time
from collections import OrderedDict
from typing import Literal

from ..models.db import ApiKeyDB

_MISS_SENTINEL: Literal["MISS"] = "MISS"


def cache_key_for_basic(public_key: str, secret_hash: str) -> str:
    """Build a cache key for Basic auth (public_key + secret_hash)."""
    return f"basic:{public_key}:{secret_hash}"


def cache_key_for_bearer_public(public_key: str) -> str:
    """Build a cache key for public-key Bearer auth."""
    return f"bearer_pub:{public_key}"


def cache_key_for_legacy(token_hash: str) -> str:
    """Build a cache key for legacy single-key Bearer auth."""
    return f"legacy:{token_hash}"


def _env_int(name: str, default: int) -> int:
    """Read an integer env var, falling back to default on parse failure."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _is_enabled() -> bool:
    """Return True unless ``API_KEY_CACHE_ENABLED=false``."""
    return os.environ.get("API_KEY_CACHE_ENABLED", "true").lower() != "false"


class ApiKeyCache:
    """In-memory TTL cache for API key validation results.

    Thread-safe. Self-evicts at capacity (FIFO via ``OrderedDict``).
    A cached ``None`` represents a negative cache entry (the key was
    looked up and not found). Callers distinguish "not in cache" from
    "cached as None" via the ``"MISS"`` sentinel returned by :meth:`get`.

    Args:
        ttl_seconds: Positive cache TTL. Defaults to env
            ``API_KEY_CACHE_TTL_SECONDS`` or 300s.
        negative_ttl_seconds: Negative cache TTL. Defaults to env
            ``API_KEY_CACHE_NEGATIVE_TTL`` or 60s.
        max_entries: Max entries before FIFO eviction. Defaults to env
            ``API_KEY_CACHE_MAX_ENTRIES`` or 10_000.
    """

    def __init__(
        self,
        ttl_seconds: int | None = None,
        negative_ttl_seconds: int | None = None,
        max_entries: int | None = None,
    ) -> None:
        self._ttl_seconds: int = (
            ttl_seconds
            if ttl_seconds is not None
            else _env_int("API_KEY_CACHE_TTL_SECONDS", 300)
        )
        self._negative_ttl_seconds: int = (
            negative_ttl_seconds
            if negative_ttl_seconds is not None
            else _env_int("API_KEY_CACHE_NEGATIVE_TTL", 60)
        )
        self._max_entries: int = (
            max_entries
            if max_entries is not None
            else _env_int("API_KEY_CACHE_MAX_ENTRIES", 10_000)
        )
        self._entries: OrderedDict[str, tuple[ApiKeyDB | None, float]] = OrderedDict()
        self._lock: threading.Lock = threading.Lock()

    def get(self, cache_key: str) -> ApiKeyDB | None | Literal["MISS"]:
        """Return the cached value, or ``"MISS"`` if not cached / expired / disabled.

        - Positive hit: returns the cached ``ApiKeyDB`` (TTL refreshed).
        - Negative hit: returns ``None`` (TTL NOT refreshed).
        - Miss / expired / disabled: returns ``"MISS"``.
        """
        if not _is_enabled():
            return _MISS_SENTINEL

        with self._lock:
            entry = self._entries.get(cache_key)
            if entry is None:
                return _MISS_SENTINEL

            value, expires_at = entry
            now = time.monotonic()
            if now >= expires_at:
                # Expired — drop and treat as miss
                _ = self._entries.pop(cache_key, None)
                return _MISS_SENTINEL

            # Sliding expiration for positive entries only — active keys stay cached.
            if value is not None:
                self._entries[cache_key] = (value, now + self._ttl_seconds)

            return value

    def set_positive(self, cache_key: str, api_key: ApiKeyDB) -> None:
        """Cache a valid key (positive cache, long TTL)."""
        if not _is_enabled():
            return
        with self._lock:
            now = time.monotonic()
            self._entries[cache_key] = (api_key, now + self._ttl_seconds)
            self._enforce_capacity()

    def set_negative(self, cache_key: str) -> None:
        """Cache that this key was not found (negative cache, short TTL)."""
        if not _is_enabled():
            return
        with self._lock:
            now = time.monotonic()
            self._entries[cache_key] = (None, now + self._negative_ttl_seconds)
            self._enforce_capacity()

    def invalidate(self, cache_key: str) -> None:
        """Remove a specific cache entry (call before delete/rotate)."""
        with self._lock:
            _ = self._entries.pop(cache_key, None)

    def invalidate_all(self) -> None:
        """Clear the entire cache (admin nuke / debugging)."""
        with self._lock:
            self._entries.clear()

    def __len__(self) -> int:
        """Return the current number of cached entries (for tests/debug)."""
        with self._lock:
            return len(self._entries)

    def _enforce_capacity(self) -> None:
        """Evict oldest entries (FIFO) until at or below ``max_entries``.

        Called after inserting a new entry, so a ``max_entries`` of 0 results
        in the just-inserted entry being immediately evicted.
        """
        while len(self._entries) > self._max_entries:
            try:
                _ = self._entries.popitem(last=False)
            except KeyError:
                break


api_key_cache = ApiKeyCache()
