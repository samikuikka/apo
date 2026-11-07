"""Identity-aware telemetry admission control.

Token-bucket admission for requests, bytes, and Telemetry Ingestion Units,
layered as per-identity and per-installation (global) buckets. A route-specific
concurrency guard and an invalid-auth throttle complete the surface.

The controller is process-local, thread-safe (one lock), uses
``time.monotonic()``, and bounds memory independently of attacker-controlled
identity cardinality. A process restart resets all buckets.
"""

# pyright: reportAny=false, reportDeprecated=false, reportExplicitAny=false, reportUnannotatedClassAttribute=false, reportUnusedCallResult=false

from __future__ import annotations

import math
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, Union

from .telemetry_limits import TelemetryAdmissionLimits, TokenBucketPolicy

AdmissionResource = Literal["requests", "bytes", "units", "concurrency"]

# Which dimension rejected: the caller's own bucket or the installation-wide
# aggregate. Rate-limit responses expose it so clients can tell a personal
# quota from a saturated backend.
AdmissionScope = Literal["identity", "global"]


@dataclass(frozen=True)
class AdmissionRejection:
    """Why a request was rejected and when the caller may retry.

    ``scope`` names the bucket that ran dry: the per-identity bucket or the
    global one. Defaults to ``"identity"`` because a rejection without an
    explicit scope is always a single caller's own bucket.
    """

    resource: AdmissionResource
    retry_after_seconds: int
    limit: int
    scope: AdmissionScope = "identity"


class IngestionLease:
    """A concurrency lease. ``release`` is idempotent."""

    __slots__ = ("_release_fn", "_released")

    def __init__(self, release_fn: Callable[[], None]) -> None:
        self._release_fn = release_fn
        self._released = False

    def __enter__(self) -> IngestionLease:
        return self

    def __exit__(self, *args: object) -> bool:
        self.release()
        return False

    def release(self) -> None:
        """Idempotent: safe to call from ``finally`` and again manually."""
        if not self._released:
            self._released = True
            self._release_fn()


class _Bucket:
    """One token bucket for one resource dimension."""

    __slots__ = ("tokens", "last_refill")

    def __init__(self, tokens: float, last_refill: float) -> None:
        self.tokens = tokens
        self.last_refill = last_refill


class _IdentityBuckets:
    """All per-identity resource buckets plus LRU metadata."""

    __slots__ = ("requests", "bytes_t", "units", "last_seen")

    def __init__(self, now: float, limits: TelemetryAdmissionLimits) -> None:
        self.requests = _Bucket(float(limits.requests.burst), now)
        self.bytes_t = _Bucket(float(limits.bytes.burst), now)
        self.units = _Bucket(float(limits.units.burst), now)
        self.last_seen = now


# Union type for try_acquire_concurrency return
AdmissionResult = Union[AdmissionRejection, IngestionLease]


class TelemetryAdmissionController:
    """Process-local admission controller.

    All consume methods are atomic across the paired identity + global
    buckets: if the global bucket rejects, the identity bucket is unchanged.
    """

    def __init__(
        self,
        limits: TelemetryAdmissionLimits,
        *,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._limits = limits
        self._now = now
        self._lock = threading.Lock()
        self._identities: OrderedDict[str, _IdentityBuckets] = OrderedDict()
        self._invalid_auth: OrderedDict[str, _Bucket] = OrderedDict()

        t0 = now()
        self._global_requests = _Bucket(float(limits.global_requests.burst), t0)
        self._global_bytes = _Bucket(float(limits.global_bytes.burst), t0)
        self._global_units = _Bucket(float(limits.global_units.burst), t0)
        self._concurrency = 0

    # ------------------------------------------------------------------ public

    def consume_request(self, identity: str) -> AdmissionRejection | None:
        return self._consume_paired(
            identity,
            1,
            "requests",
            "requests",
            self._limits.requests,
            self._global_requests,
            self._limits.global_requests,
        )

    def consume_request_identity(self, identity: str) -> AdmissionRejection | None:
        """Consume one request token from the identity bucket only.

        The mirror of :meth:`consume_request_global`, for deployments that
        cap each caller but disable the installation-wide aggregate: the
        paired consume would still charge the global bucket (left at its
        telemetry default), silently reintroducing the cap the operator
        turned off.
        """
        with self._lock:
            now = self._now()
            ident = self._get_or_create_identity(identity, now)
            self._refill(ident.requests, self._limits.requests, now)
            if ident.requests.tokens < 1:
                return AdmissionRejection(
                    "requests",
                    self._retry_after(
                        1,
                        ident.requests.tokens,
                        self._limits.requests.tokens_per_minute,
                    ),
                    self._limits.requests.burst,
                    scope="identity",
                )
            ident.requests.tokens -= 1
            return None

    def consume_request_global(self) -> AdmissionRejection | None:
        """Consume one request token from the global bucket only.

        Used for callers without a derived identity (unauthenticated
        traffic) and when the caller's own dimension is disabled: the
        installation-wide aggregate must still be charged, but there is no
        identity bucket to pair with. Takes the same lock and applies the
        same refill and retry-after discipline as ``consume_request``.
        """
        with self._lock:
            now = self._now()
            self._refill(self._global_requests, self._limits.global_requests, now)
            if self._global_requests.tokens < 1:
                return AdmissionRejection(
                    "requests",
                    self._retry_after(
                        1,
                        self._global_requests.tokens,
                        self._limits.global_requests.tokens_per_minute,
                    ),
                    self._limits.global_requests.burst,
                    scope="global",
                )
            self._global_requests.tokens -= 1
            return None

    def consume_bytes(self, identity: str, amount: int) -> AdmissionRejection | None:
        return self._consume_paired(
            identity,
            amount,
            "bytes",
            "bytes_t",
            self._limits.bytes,
            self._global_bytes,
            self._limits.global_bytes,
        )

    def consume_units(self, identity: str, amount: int) -> AdmissionRejection | None:
        return self._consume_paired(
            identity,
            amount,
            "units",
            "units",
            self._limits.units,
            self._global_units,
            self._limits.global_units,
        )

    def consume_invalid_auth(self, client_ip: str) -> AdmissionRejection | None:
        """Throttle repeated failed authentications by client IP."""
        with self._lock:
            now = self._now()
            bucket = self._invalid_auth.get(client_ip)
            if bucket is None:
                bucket = _Bucket(float(self._limits.invalid_auth.burst), now)
                self._invalid_auth[client_ip] = bucket
                self._evict_map(self._invalid_auth, now)
            self._refill(bucket, self._limits.invalid_auth, now)
            if bucket.tokens < 1:
                return AdmissionRejection(
                    "requests",
                    self._retry_after(1, bucket.tokens, self._limits.invalid_auth.tokens_per_minute),
                    self._limits.invalid_auth.burst,
                )
            bucket.tokens -= 1
            return None

    def try_acquire_concurrency(self) -> AdmissionResult:
        with self._lock:
            if self._concurrency >= self._limits.max_concurrent_requests:
                return AdmissionRejection(
                    "concurrency",
                    1,
                    self._limits.max_concurrent_requests,
                    # Concurrency is installation-wide, never per caller.
                    scope="global",
                )
            self._concurrency += 1

        def _release() -> None:
            with self._lock:
                self._concurrency = max(0, self._concurrency - 1)

        return IngestionLease(_release)

    def tracked_identity_count(self) -> int:
        """Test/debug: number of per-identity bucket sets currently tracked."""
        with self._lock:
            return len(self._identities)

    # ----------------------------------------------------------------- private

    def _consume_paired(
        self,
        identity: str,
        amount: int,
        resource: AdmissionResource,
        bucket_attr: str,
        ident_policy: TokenBucketPolicy,
        global_bucket: _Bucket,
        global_policy: TokenBucketPolicy,
    ) -> AdmissionRejection | None:
        with self._lock:
            now = self._now()
            ident = self._get_or_create_identity(identity, now)
            ident_bucket: _Bucket = getattr(ident, bucket_attr)

            self._refill(ident_bucket, ident_policy, now)
            self._refill(global_bucket, global_policy, now)
            ident.last_seen = now

            # Atomic: check both before consuming either.
            if ident_bucket.tokens < amount:
                return AdmissionRejection(
                    resource,
                    self._retry_after(amount, ident_bucket.tokens, ident_policy.tokens_per_minute),
                    ident_policy.burst,
                    scope="identity",
                )
            if global_bucket.tokens < amount:
                return AdmissionRejection(
                    resource,
                    self._retry_after(amount, global_bucket.tokens, global_policy.tokens_per_minute),
                    global_policy.burst,
                    scope="global",
                )
            # Both passed: consume.
            ident_bucket.tokens -= amount
            global_bucket.tokens -= amount
            return None

    def _get_or_create_identity(self, identity: str, now: float) -> _IdentityBuckets:
        ident = self._identities.get(identity)
        if ident is None:
            ident = _IdentityBuckets(now, self._limits)
            self._identities[identity] = ident
            self._evict_map(self._identities, now)
        else:
            self._identities.move_to_end(identity)
        return ident

    def _evict_map(self, m: OrderedDict[str, Any], now: float) -> None:
        """Drop idle entries, then enforce hard cardinality (LRU)."""
        idle_cutoff = now - self._limits.bucket_idle_seconds
        stale = [k for k, v in m.items() if getattr(v, "last_seen", now) < idle_cutoff]
        for k in stale:
            del m[k]
        while len(m) > self._limits.max_tracked_identities:
            m.popitem(last=False)

    @staticmethod
    def _refill(bucket: _Bucket, policy: TokenBucketPolicy, now: float) -> None:
        elapsed = now - bucket.last_refill
        if elapsed > 0:
            refill = elapsed * policy.tokens_per_minute / 60.0
            bucket.tokens = min(float(policy.burst), bucket.tokens + refill)
            bucket.last_refill = now

    @staticmethod
    def _retry_after(needed: float, available: float, rate_per_minute: int) -> int:
        deficit = needed - available
        if deficit <= 0:
            return 1
        seconds = deficit * 60.0 / rate_per_minute
        return max(1, math.ceil(seconds))


# ---------------------------------------------------------------------------
# Identity derivation
# ---------------------------------------------------------------------------


def derive_admission_identity(state: object) -> str | None:
    """Derive a stable, non-secret admission identity from request state.

    Maps each authentication method to an internal subject prefixed by its
    kind. Public keys, secrets, JWTs, IPs, and Project names are NEVER used
    as bucket keys.

    Returns ``None`` when a protected authenticated request has no derivable
    internal identity (fail-closed → the middleware returns 503).
    Returns ``"open-dev"`` for unauthenticated open-development requests.
    """
    auth_method = getattr(state, "auth_method", None)

    if auth_method == "api_key":
        api_key_id = getattr(state, "api_key_id", None)
        return f"api-key:{api_key_id}" if api_key_id else None
    if auth_method == "service_token":
        task_run_id = getattr(state, "service_task_run_id", None)
        return f"service-task-run:{task_run_id}" if task_run_id else None
    if auth_method == "attempt_token":
        attempt_id = getattr(state, "attempt_id", None)
        return f"attempt:{attempt_id}" if attempt_id else None
    if auth_method == "cookie":
        user_id = getattr(state, "user_id", None)
        return f"user:{user_id}" if user_id else None

    # Open-development bypass (no auth_method set).
    return "open-dev"
