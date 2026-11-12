import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

MAX_ENTRIES = 10_000


def monotonic() -> float:
    """Clock seam. Production reads the real monotonic clock; tests patch
    this module attribute and advance it instead of sleeping out windows."""
    return time.monotonic()


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
            now = monotonic()
            cutoff = now - self.window_seconds
            attempts = [t for t in self._attempts.get(key, []) if t > cutoff]
            if attempts:
                self._attempts[key] = attempts
            else:
                # A key whose every attempt left the window holds no state;
                # forgetting it keeps a once-seen address from holding a
                # slot forever (and dodging eviction below).
                self._attempts.pop(key, None)
            return len(attempts) < self.max_attempts

    def allow_and_record(self, key: str) -> bool:
        """Check and record under one lock acquisition.

        The two-step is_allowed + record_attempt let concurrent requests
        for one key all pass the check before any of them recorded, so a
        burst overshot the window by however many raced. This method cannot.
        """
        with self._lock:
            now = monotonic()
            cutoff = now - self.window_seconds
            attempts = [t for t in self._attempts.get(key, []) if t > cutoff]
            allowed = len(attempts) < self.max_attempts
            if allowed:
                attempts.append(now)
            self._attempts[key] = attempts
            if len(self._attempts) > MAX_ENTRIES:
                self._evict_oldest_batch()
            return allowed

    def record_attempt(self, key: str) -> None:
        """Record a login attempt for the given key."""
        with self._lock:
            now = monotonic()
            if key not in self._attempts:
                self._attempts[key] = []
            self._attempts[key].append(now)
            if len(self._attempts) > MAX_ENTRIES:
                self._evict_oldest_batch()

    def get_retry_after(self, key: str) -> int:
        """Returns seconds until the next attempt is allowed."""
        with self._lock:
            now = monotonic()
            cutoff = now - self.window_seconds
            attempts = self._attempts.get(key, [])
            attempts = [t for t in attempts if t > cutoff]

            if not attempts:
                return 0

            oldest_in_window = min(attempts)
            retry_after = oldest_in_window + self.window_seconds - now
            return max(1, int(retry_after) + 1)

    def _evict_oldest_batch(self) -> None:
        """Drop the oldest tenth of the tracked keys, in one pass.

        Eviction runs on the recording path only, in batches. Scanning for
        the single oldest key on every check let a rotating-address flood
        (thousands of fresh addresses, all passing their own windows) turn
        each request into an O(addresses) scan under the global lock and
        serialize every caller on it.
        """
        ordered = sorted(
            self._attempts.items(),
            key=lambda item: item[1][0] if item[1] else float("inf"),
        )
        for key, _timestamps in ordered[: max(1, MAX_ENTRIES // 10)]:
            del self._attempts[key]


login_rate_limiter = LoginRateLimiter()
