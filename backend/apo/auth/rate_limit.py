import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

MAX_ENTRIES = 10_000


class LoginRateLimiter:
    """In-memory sliding window rate limiter for login attempts.

    Args:
        max_attempts: Override env-based max attempts. Falls back to env var.
        window_seconds: Override env-based window. Falls back to env var.
    """

    def __init__(
        self,
        max_attempts: int | None = None,
        window_seconds: int | None = None,
    ) -> None:
        self.max_attempts: int = (
            max_attempts
            if max_attempts is not None
            else int(os.environ.get("AUTH_RATE_LIMIT_MAX_ATTEMPTS", "10"))
        )
        self.window_seconds: int = (
            window_seconds
            if window_seconds is not None
            else int(os.environ.get("AUTH_RATE_LIMIT_WINDOW_SECONDS", "300"))
        )
        self._attempts: dict[str, list[float]] = {}
        self._lock: threading.Lock = threading.Lock()

    def is_allowed(self, key: str) -> bool:
        """Check if request is allowed. Returns False if rate exceeded."""
        with self._lock:
            now = time.monotonic()
            cutoff = now - self.window_seconds
            attempts = self._attempts.get(key, [])
            attempts = [t for t in attempts if t > cutoff]
            self._attempts[key] = attempts

            if len(attempts) >= self.max_attempts:
                return False

            if len(self._attempts) > MAX_ENTRIES:
                self._evict_oldest()

            return True

    def record_attempt(self, key: str) -> None:
        """Record a login attempt for the given key."""
        with self._lock:
            now = time.monotonic()
            if key not in self._attempts:
                self._attempts[key] = []
            self._attempts[key].append(now)

    def get_retry_after(self, key: str) -> int:
        """Returns seconds until the next attempt is allowed."""
        with self._lock:
            now = time.monotonic()
            cutoff = now - self.window_seconds
            attempts = self._attempts.get(key, [])
            attempts = [t for t in attempts if t > cutoff]

            if not attempts:
                return 0

            oldest_in_window = min(attempts)
            retry_after = oldest_in_window + self.window_seconds - now
            return max(1, int(retry_after) + 1)

    def _evict_oldest(self) -> None:
        oldest_key: str | None = None
        oldest_time: float = float("inf")
        for key, timestamps in self._attempts.items():
            if timestamps and timestamps[0] < oldest_time:
                oldest_time = timestamps[0]
                oldest_key = key
        if oldest_key is not None:
            del self._attempts[oldest_key]


login_rate_limiter = LoginRateLimiter()
