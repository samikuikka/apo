# pyright: reportAny=false, reportMissingParameterType=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUntypedFunctionDecorator=false, reportUnusedCallResult=false, reportUnusedImport=false
# pyright: reportAttributeAccessIssue=false

"""Acceptance tests: shared telemetry admission control.

Red-first: tests written before implementation.
"""

from __future__ import annotations

import pytest


# ---------------------------------------------------------------------------
# Admission env vars (18 total)
# ---------------------------------------------------------------------------

_ADMISSION_VARS = (
    "APO_TELEMETRY_REQUESTS_PER_MINUTE",
    "APO_TELEMETRY_REQUEST_BURST",
    "APO_TELEMETRY_GLOBAL_REQUESTS_PER_MINUTE",
    "APO_TELEMETRY_GLOBAL_REQUEST_BURST",
    "APO_TELEMETRY_UNITS_PER_MINUTE",
    "APO_TELEMETRY_UNIT_BURST",
    "APO_TELEMETRY_GLOBAL_UNITS_PER_MINUTE",
    "APO_TELEMETRY_GLOBAL_UNIT_BURST",
    "APO_TELEMETRY_BYTES_PER_MINUTE",
    "APO_TELEMETRY_BYTE_BURST",
    "APO_TELEMETRY_GLOBAL_BYTES_PER_MINUTE",
    "APO_TELEMETRY_GLOBAL_BYTE_BURST",
    "APO_TELEMETRY_MAX_CONCURRENT_REQUESTS",
    "APO_TELEMETRY_INVALID_AUTH_PER_MINUTE",
    "APO_TELEMETRY_INVALID_AUTH_BURST",
    "APO_TELEMETRY_MAX_ITEMS_PER_REQUEST",
    "APO_TELEMETRY_MAX_TRACKED_IDENTITIES",
    "APO_TELEMETRY_BUCKET_IDLE_SECONDS",
)


def _clear_admission_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in _ADMISSION_VARS:
        monkeypatch.delenv(var, raising=False)


# ---------------------------------------------------------------------------
# Unit tests 1-2: TelemetryAdmissionLimits configuration
# ---------------------------------------------------------------------------


class TestAdmissionDefaults:
    """Acceptance test 1: all admission defaults are exact."""

    def test_defaults_match_the_spec_table(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from apo.services.telemetry_limits import load_telemetry_admission_limits

        _clear_admission_env(monkeypatch)
        limits = load_telemetry_admission_limits()

        assert limits.requests.tokens_per_minute == 120
        assert limits.requests.burst == 20
        assert limits.global_requests.tokens_per_minute == 600
        assert limits.global_requests.burst == 50
        assert limits.units.tokens_per_minute == 12_000
        assert limits.units.burst == 2048
        assert limits.global_units.tokens_per_minute == 30_000
        assert limits.global_units.burst == 4096
        assert limits.bytes.tokens_per_minute == 31_457_280
        assert limits.bytes.burst == 10_485_760
        assert limits.global_bytes.tokens_per_minute == 62_914_560
        assert limits.global_bytes.burst == 20_971_520
        assert limits.invalid_auth.tokens_per_minute == 30
        assert limits.invalid_auth.burst == 10
        assert limits.max_concurrent_requests == 4
        assert limits.max_items_per_request == 2048
        assert limits.max_tracked_identities == 10_000
        assert limits.bucket_idle_seconds == 900


class TestAdmissionValidation:
    """Acceptance test 2: invalid admission configuration fails startup."""

    @pytest.mark.parametrize("bad_value", ["", "abc", "0", "-1", "3.5"])  # pyright: ignore[reportCallIssue]
    def test_each_var_rejects_invalid_values(
        self, monkeypatch: pytest.MonkeyPatch, bad_value: str
    ) -> None:
        from apo.services.telemetry_limits import (
            TelemetryLimitError,
            load_telemetry_admission_limits,
        )

        for var in _ADMISSION_VARS:
            _clear_admission_env(monkeypatch)
            monkeypatch.setenv(var, bad_value)
            with pytest.raises(TelemetryLimitError) as exc_info:
                load_telemetry_admission_limits()
            assert var in str(exc_info.value)


# ---------------------------------------------------------------------------
# Layer 2 helpers: build controllers with tiny limits for fast tests
# ---------------------------------------------------------------------------


def _admission_limits(
    *,
    req_rate=6000, req_burst=100,
    g_req_rate=6000, g_req_burst=100,
    unit_rate=6000, unit_burst=100,
    g_unit_rate=6000, g_unit_burst=100,
    byte_rate=6000, byte_burst=100,
    g_byte_rate=6000, g_byte_burst=100,
    max_concurrency=4,
    max_identities=10_000,
    idle_seconds=900,
):
    from apo.services.telemetry_limits import (
        TelemetryAdmissionLimits,
        TokenBucketPolicy,
    )

    return TelemetryAdmissionLimits(
        requests=TokenBucketPolicy(req_rate, req_burst),
        global_requests=TokenBucketPolicy(g_req_rate, g_req_burst),
        units=TokenBucketPolicy(unit_rate, unit_burst),
        global_units=TokenBucketPolicy(g_unit_rate, g_unit_burst),
        bytes=TokenBucketPolicy(byte_rate, byte_burst),
        global_bytes=TokenBucketPolicy(g_byte_rate, g_byte_burst),
        invalid_auth=TokenBucketPolicy(30, 10),
        max_concurrent_requests=max_concurrency,
        max_items_per_request=2048,
        max_tracked_identities=max_identities,
        bucket_idle_seconds=idle_seconds,
    )


# ---------------------------------------------------------------------------
# Unit test 3: token bucket refills monotonically
# ---------------------------------------------------------------------------


class TestTokenBucketRefill:
    """Acceptance test 3: refill matches configured rate without wall-clock dependence."""

    def test_refill_after_time_advances(self) -> None:
        from apo.services.telemetry_admission import TelemetryAdmissionController

        clock = [100.0]
        limits = _admission_limits(req_rate=60, req_burst=10)
        ctrl = TelemetryAdmissionController(limits, now=lambda: clock[0])

        # Exhaust the 10-token burst.
        for _ in range(10):
            assert ctrl.consume_request("id1") is None
        assert ctrl.consume_request("id1") is not None  # exhausted

        # Advance 10 s → refills 60 * 10/60 = 10 tokens.
        clock[0] += 10
        for _ in range(10):
            assert ctrl.consume_request("id1") is None
        assert ctrl.consume_request("id1") is not None  # exhausted again


# ---------------------------------------------------------------------------
# Unit test 4: identity and global consumption is atomic
# ---------------------------------------------------------------------------


class TestAtomicPairedConsumption:
    """Acceptance test 4: global rejection does not consume the identity bucket."""

    def test_identity_balance_unchanged_on_global_rejection(self) -> None:
        from apo.services.telemetry_admission import TelemetryAdmissionController

        clock = [0.0]
        limits = _admission_limits(
            req_rate=60, req_burst=2,
            g_req_rate=60, g_req_burst=1,  # global burst of 1
        )
        ctrl = TelemetryAdmissionController(limits, now=lambda: clock[0])

        # Consume from "a" — uses the only global token.
        assert ctrl.consume_request("a") is None

        # Try "b" — identity has 2 tokens, global has 0 → reject.
        rejection = ctrl.consume_request("b")
        assert rejection is not None

        # White-box: verify identity "b"'s request bucket was NOT consumed.
        # The paired consume must be atomic — global rejection leaves the
        # identity balance at its full burst.
        with ctrl._lock:
            b_tokens = ctrl._identities["b"].requests.tokens
        assert b_tokens == 2.0


# ---------------------------------------------------------------------------
# Unit test 5: weighted bytes and units reject exact deficits
# ---------------------------------------------------------------------------


class TestWeightedDeficits:
    """Acceptance test 5: below/equal succeed; above rejects with Retry-After."""

    def test_bytes_below_equal_above(self) -> None:
        from apo.services.telemetry_admission import TelemetryAdmissionController

        limits = _admission_limits(byte_rate=600, byte_burst=100)
        ctrl = TelemetryAdmissionController(limits)

        assert ctrl.consume_bytes("id", 99) is None   # below
        assert ctrl.consume_bytes("id", 1) is None     # equal (99+1=100)
        rejection = ctrl.consume_bytes("id", 1)        # above
        assert rejection is not None
        assert rejection.resource == "bytes"
        assert rejection.retry_after_seconds >= 1

    def test_units_weighted_cost(self) -> None:
        from apo.services.telemetry_admission import TelemetryAdmissionController

        limits = _admission_limits(unit_rate=600, unit_burst=50)
        ctrl = TelemetryAdmissionController(limits)

        assert ctrl.consume_units("id", 50) is None    # exact burst
        rejection = ctrl.consume_units("id", 1)
        assert rejection is not None
        assert rejection.resource == "units"


# ---------------------------------------------------------------------------
# Unit test 6: idle eviction bounds memory
# ---------------------------------------------------------------------------


class TestIdleEviction:
    """Acceptance test 6: map never exceeds max_tracked_identities."""

    def test_eviction_enforces_cardinality(self) -> None:
        from apo.services.telemetry_admission import TelemetryAdmissionController

        clock = [0.0]
        limits = _admission_limits(max_identities=5, idle_seconds=900)
        ctrl = TelemetryAdmissionController(limits, now=lambda: clock[0])

        for i in range(20):
            ctrl.consume_request(f"id-{i}")

        assert ctrl.tracked_identity_count() <= 5


# ---------------------------------------------------------------------------
# Unit test 7: secrets never become identity keys
# ---------------------------------------------------------------------------


class _FakeState:
    """Minimal stand-in for request.state with attribute access."""

    def __init__(self, **kwargs: object) -> None:
        self.__dict__.update(kwargs)


class TestIdentityDerivation:
    """Acceptance test 7: exact subject prefixes; no secret/key substring."""

    def test_api_key_identity(self) -> None:
        from apo.services.telemetry_admission import derive_admission_identity

        state = _FakeState(auth_method="api_key", api_key_id="key-uuid-123")
        assert derive_admission_identity(state) == "api-key:key-uuid-123"

    def test_service_token_identity(self) -> None:
        from apo.services.telemetry_admission import derive_admission_identity

        state = _FakeState(auth_method="service_token", service_task_run_id="run-abc")
        assert derive_admission_identity(state) == "service-task-run:run-abc"

    def test_attempt_token_identity(self) -> None:
        from apo.services.telemetry_admission import derive_admission_identity

        state = _FakeState(auth_method="attempt_token", attempt_id="att-xyz")
        assert derive_admission_identity(state) == "attempt:att-xyz"

    def test_cookie_identity(self) -> None:
        from apo.services.telemetry_admission import derive_admission_identity

        state = _FakeState(auth_method="cookie", user_id="user-42")
        assert derive_admission_identity(state) == "user:user-42"

    def test_open_dev_identity(self) -> None:
        from apo.services.telemetry_admission import derive_admission_identity

        state = _FakeState()
        assert derive_admission_identity(state) == "open-dev"

    def test_api_key_without_id_is_fail_closed(self) -> None:
        from apo.services.telemetry_admission import derive_admission_identity

        state = _FakeState(auth_method="api_key")  # no api_key_id
        assert derive_admission_identity(state) is None


# ---------------------------------------------------------------------------
# Unit test 8: concurrency lease release is idempotent
# ---------------------------------------------------------------------------


class TestConcurrencyLease:
    """Acceptance test 8: four leases, fifth rejects, double-release is safe."""

    def test_acquire_release_idempotent(self) -> None:
        from apo.services.telemetry_admission import (
            AdmissionRejection,
            IngestionLease,
            TelemetryAdmissionController,
        )

        limits = _admission_limits(max_concurrency=4)
        ctrl = TelemetryAdmissionController(limits)

        leases = []
        for _ in range(4):
            result = ctrl.try_acquire_concurrency()
            assert isinstance(result, IngestionLease)
            leases.append(result)

        # Fifth rejects immediately.
        fifth = ctrl.try_acquire_concurrency()
        assert isinstance(fifth, AdmissionRejection)
        assert fifth.resource == "concurrency"

        # Release one, then release it AGAIN (idempotent — no extra slot).
        leases[0].release()
        leases[0].release()

        # Now one slot is free — acquire succeeds.
        result = ctrl.try_acquire_concurrency()
        assert isinstance(result, IngestionLease)


# ---------------------------------------------------------------------------
# Unit test 9: protected route matching is exact
# ---------------------------------------------------------------------------


class TestProtectedRouteRegistry:
    """Acceptance test 9: only listed telemetry writes are protected."""

    def test_exact_matches_are_protected(self) -> None:
        from apo.middleware.telemetry_admission import is_protected_telemetry_route

        protected = [
            ("POST", "/api/public/otel/v1/traces"),
            ("POST", "/api/v1/ingestion"),
            ("POST", "/api/v1/traces/abc123/scores"),
            ("POST", "/api/v1/observations/obs-1/scores"),
            ("POST", "/api/v1/scores/bulk"),
        ]
        for method, path in protected:
            assert is_protected_telemetry_route(method, path), f"{method} {path} should be protected"

    def test_adjacent_and_unrelated_paths_are_not_protected(self) -> None:
        from apo.middleware.telemetry_admission import is_protected_telemetry_route

        unprotected = [
            ("GET", "/api/public/otel/v1/traces"),
            ("POST", "/api/public/otel/v1/metrics"),
            ("POST", "/api/public/otel/foo"),
            ("GET", "/api/v1/ingestion"),
            ("POST", "/api/v1/scores"),
            ("POST", "/api/v1/ingestion/extra"),
            ("POST", "/api/public/ingestion"),
            ("POST", "/api/public/scores"),
            ("GET", "/api/v1/runs"),
            ("POST", "/api/v1/agent-task-runs"),
        ]
        for method, path in unprotected:
            assert not is_protected_telemetry_route(method, path), f"{method} {path} should NOT be protected"
