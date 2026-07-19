"""
Debounced last_used_at writer for API keys.

Avoids per-request DB writes by tracking the last write timestamp per key
and only writing at most once per DEBOUNCE_SECONDS.
Thread-safe via a simple lock (same pattern as LoginRateLimiter).
"""

import logging
import threading
import time
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)

DEBOUNCE_SECONDS = 60
MAX_ENTRIES = 10_000


class ApiKeyUsageTracker:
    """In-memory debounce tracker for API key last_used_at updates.

    Only writes last_used_at to the DB if the key hasn't been written
    in the last DEBOUNCE_SECONDS. Thread-safe.
    """

    def __init__(self, debounce_seconds: int = DEBOUNCE_SECONDS) -> None:
        self._debounce_seconds: int = debounce_seconds
        self._last_written: dict[str, float] = {}
        self._lock: threading.Lock = threading.Lock()

    def record_use(self, key_id: str, engine: Engine) -> None:
        """Record an API key usage, writing to DB if debounce window has elapsed.

        Args:
            key_id: The API key ID.
            engine: SQLAlchemy engine instance for DB access.
        """
        with self._lock:
            now = time.monotonic()
            last = self._last_written.get(key_id)

            if last is not None and (now - last) < self._debounce_seconds:
                return

            if len(self._last_written) > MAX_ENTRIES:
                self._evict_oldest()

            self._last_written[key_id] = now

        self._write_last_used(key_id, engine)

    def _write_last_used(self, key_id: str, engine: Engine) -> None:
        """Write last_used_at to the DB via a raw UPDATE."""
        try:
            now_str = datetime.now(timezone.utc).isoformat()
            with engine.begin() as conn:
                _ = conn.execute(
                    text(
                        "UPDATE api_keys SET last_used_at = :now WHERE id = :key_id"
                    ),
                    {"now": now_str, "key_id": key_id},
                )
        except Exception:
            logger.warning(
                "Failed to update last_used_at for key %s", key_id, exc_info=True
            )

    def _evict_oldest(self) -> None:
        """Remove the oldest entry from the debounce cache."""
        oldest_key: str | None = None
        oldest_time: float = float("inf")
        for key, ts in self._last_written.items():
            if ts < oldest_time:
                oldest_time = ts
                oldest_key = key
        if oldest_key is not None:
            del self._last_written[oldest_key]


api_key_usage_tracker = ApiKeyUsageTracker()
