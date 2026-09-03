"""Public readiness probe.

Wraps the existing ``run_readiness_checks`` with a 5-second TTL cache,
concurrent-call coalescing, and a caller deadline. Returns only a boolean —
no check names, paths, or exception detail ever reach the public surface.
"""

# pyright: reportUnannotatedClassAttribute=false, reportUnusedImport=false

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable

from .readiness import ReadinessReport

PUBLIC_READINESS_TTL_SECONDS: float = 5.0
PUBLIC_READINESS_DEADLINE_SECONDS: float = 5.0


class PublicReadinessProbe:
    """Detail-free, cached, coalesced readiness evaluation.

    Concurrent callers share one in-flight check via an ``asyncio.Lock``.
    A completed result is cached for ``ttl_seconds``. A caller that exceeds
    ``deadline_seconds`` receives ``False`` without starting a replacement.
    """

    def __init__(
        self,
        check: Callable[[], ReadinessReport] | None = None,
        *,
        ttl_seconds: float = PUBLIC_READINESS_TTL_SECONDS,
        deadline_seconds: float = PUBLIC_READINESS_DEADLINE_SECONDS,
    ) -> None:
        if check is None:
            from .runtime_config import run_readiness_checks
            check = run_readiness_checks
        self._check = check
        self._ttl = ttl_seconds
        self._deadline = deadline_seconds
        self._cached: bool | None = None
        self._cached_at: float = 0.0
        self._lock = asyncio.Lock()

    async def is_ready(self) -> bool:
        """Return a cached/coalesced readiness result (never detail)."""
        # Fast path: fresh cache.
        if self._cached is not None and (time.monotonic() - self._cached_at) < self._ttl:
            return self._cached

        # Coalesced slow path: one caller runs the check, others wait.
        async with self._lock:
            # Re-check cache (another caller may have populated it while we waited).
            if self._cached is not None and (time.monotonic() - self._cached_at) < self._ttl:
                return self._cached

            try:
                report = await asyncio.wait_for(
                    asyncio.to_thread(self._check),
                    timeout=self._deadline,
                )
                self._cached = report.ok
            except (asyncio.TimeoutError, Exception):
                self._cached = False

            self._cached_at = time.monotonic()
            return self._cached
