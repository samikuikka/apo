"""Typed, startup-validated telemetry limits.

hard transport boundaries for the canonical OTLP endpoint.
identity-aware admission control policies (token buckets,
concurrency, invalid-auth throttle, batch caps).

There is no disable flag: ``0`` never means unlimited. A present empty,
non-integer, zero, or negative value fails startup with a message naming
the offending variable.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


class TelemetryLimitError(RuntimeError):
    """Raised when a telemetry limit env var has an invalid value."""


@dataclass(frozen=True)
class TelemetryTransportLimits:
    """Immutable hard boundaries for one OTLP/HTTP trace request."""

    max_request_bytes: int
    max_otlp_decompressed_bytes: int
    max_otlp_spans_per_request: int
    body_timeout_seconds: int


# (env var name, attribute name, default)
_LIMIT_SPECS: tuple[tuple[str, str, int], ...] = (
    ("APO_TELEMETRY_MAX_REQUEST_BYTES", "max_request_bytes", 10_485_760),
    ("APO_OTLP_MAX_DECOMPRESSED_BYTES", "max_otlp_decompressed_bytes", 10_485_760),
    ("APO_OTLP_MAX_SPANS_PER_REQUEST", "max_otlp_spans_per_request", 2048),
    ("APO_TELEMETRY_BODY_TIMEOUT_SECONDS", "body_timeout_seconds", 30),
)


def _parse_positive_int(name: str, raw: str | None, default: int) -> int:
    """Parse a positive base-10 integer env var.

    Missing → default. Present empty, non-integer, zero, or negative →
    :class:`TelemetryLimitError` naming only ``name``.
    """
    if raw is None:
        return default
    raw = raw.strip()
    if raw == "":
        raise TelemetryLimitError(f"{name} must be a positive integer (got empty)")
    try:
        value = int(raw)
    except ValueError:
        raise TelemetryLimitError(
            f"{name} must be a positive base-10 integer (got {raw!r})"
        ) from None
    if value <= 0:
        raise TelemetryLimitError(f"{name} must be a positive integer (got {value})")
    return value


def load_telemetry_transport_limits() -> TelemetryTransportLimits:
    """Load and validate transport limits from the environment.

    Reads each variable at call time (not import time) so tests and app
    construction see current values. Raises :class:`TelemetryLimitError`
    on the first invalid variable, naming only that variable.
    """
    fields: dict[str, int] = {}
    for env_name, attr_name, default in _LIMIT_SPECS:
        fields[attr_name] = _parse_positive_int(env_name, os.environ.get(env_name), default)
    return TelemetryTransportLimits(**fields)


# ---------------------------------------------------------------------------
# Admission control configuration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TokenBucketPolicy:
    """A refill rate and burst capacity for one resource dimension."""

    tokens_per_minute: int
    burst: int


@dataclass(frozen=True)
class TelemetryAdmissionLimits:
    """All admission-control policies, immutable after startup validation."""

    requests: TokenBucketPolicy
    global_requests: TokenBucketPolicy
    units: TokenBucketPolicy
    global_units: TokenBucketPolicy
    bytes: TokenBucketPolicy
    global_bytes: TokenBucketPolicy
    invalid_auth: TokenBucketPolicy
    max_concurrent_requests: int
    max_items_per_request: int
    max_tracked_identities: int
    bucket_idle_seconds: int


# Each tuple: (env_var, default). Token-bucket pairs are grouped so the
# loader can construct TokenBucketPolicy objects.
#
# Request-dimension calibration: apo's own task client batches exports but
# still flushes ~2 requests/s per run, and task suites run many runs
# back-to-back on one API key — a per-key budget at that exact rate never
# refills, so consecutive runs overdraft the bucket and spans are dropped to
# 429s (observed live: 472 throttles across three consecutive probe runs,
# including a cancelled run's final root-span flush). The request dimension
# must sit comfortably above the client's sustained rate so the units
# (spans) dimension remains the real quota.
_BUCKET_SPECS: tuple[tuple[str, int, str, int], ...] = (
    ("APO_TELEMETRY_REQUESTS_PER_MINUTE", 600, "APO_TELEMETRY_REQUEST_BURST", 60),
    ("APO_TELEMETRY_GLOBAL_REQUESTS_PER_MINUTE", 2400, "APO_TELEMETRY_GLOBAL_REQUEST_BURST", 200),
    ("APO_TELEMETRY_UNITS_PER_MINUTE", 12_000, "APO_TELEMETRY_UNIT_BURST", 2048),
    ("APO_TELEMETRY_GLOBAL_UNITS_PER_MINUTE", 30_000, "APO_TELEMETRY_GLOBAL_UNIT_BURST", 4096),
    ("APO_TELEMETRY_BYTES_PER_MINUTE", 31_457_280, "APO_TELEMETRY_BYTE_BURST", 10_485_760),
    ("APO_TELEMETRY_GLOBAL_BYTES_PER_MINUTE", 62_914_560, "APO_TELEMETRY_GLOBAL_BYTE_BURST", 20_971_520),
    ("APO_TELEMETRY_INVALID_AUTH_PER_MINUTE", 30, "APO_TELEMETRY_INVALID_AUTH_BURST", 10),
)

_SCALAR_SPECS: tuple[tuple[str, int], ...] = (
    ("APO_TELEMETRY_MAX_CONCURRENT_REQUESTS", 4),
    ("APO_TELEMETRY_MAX_ITEMS_PER_REQUEST", 2048),
    ("APO_TELEMETRY_MAX_TRACKED_IDENTITIES", 10_000),
    ("APO_TELEMETRY_BUCKET_IDLE_SECONDS", 900),
)

_BUCKET_ATTRS = (
    "requests",
    "global_requests",
    "units",
    "global_units",
    "bytes",
    "global_bytes",
    "invalid_auth",
)

_SCALAR_ATTRS = (
    "max_concurrent_requests",
    "max_items_per_request",
    "max_tracked_identities",
    "bucket_idle_seconds",
)


def load_telemetry_admission_limits() -> TelemetryAdmissionLimits:
    """Load and validate admission limits from the environment.

    Raises :class:`TelemetryLimitError` on the first invalid variable.
    """
    buckets: dict[str, TokenBucketPolicy] = {}
    for attr, (rate_var, rate_def, burst_var, burst_def) in zip(
        _BUCKET_ATTRS, _BUCKET_SPECS, strict=True
    ):
        rate = _parse_positive_int(rate_var, os.environ.get(rate_var), rate_def)
        burst = _parse_positive_int(burst_var, os.environ.get(burst_var), burst_def)
        buckets[attr] = TokenBucketPolicy(tokens_per_minute=rate, burst=burst)

    scalars: dict[str, int] = {}
    for attr, (env_name, default) in zip(_SCALAR_ATTRS, _SCALAR_SPECS, strict=True):
        scalars[attr] = _parse_positive_int(env_name, os.environ.get(env_name), default)

    return TelemetryAdmissionLimits(
        requests=buckets["requests"],
        global_requests=buckets["global_requests"],
        units=buckets["units"],
        global_units=buckets["global_units"],
        bytes=buckets["bytes"],
        global_bytes=buckets["global_bytes"],
        invalid_auth=buckets["invalid_auth"],
        max_concurrent_requests=scalars["max_concurrent_requests"],
        max_items_per_request=scalars["max_items_per_request"],
        max_tracked_identities=scalars["max_tracked_identities"],
        bucket_idle_seconds=scalars["bucket_idle_seconds"],
    )
