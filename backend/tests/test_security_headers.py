# pyright: reportAny=false, reportUnusedFunction=false

import pytest
from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient

from apo import auth as auth_module
from apo.auth import middleware as auth_middleware


@pytest.fixture(autouse=True)
def _force_auth_secret(monkeypatch: MonkeyPatch) -> None:
    """Enable auth middleware so non-public routes return 401 without credentials."""
    monkeypatch.setattr(auth_module, "AUTH_SECRET", "test-auth-secret")
    monkeypatch.setattr(auth_middleware, "AUTH_SECRET", "test-auth-secret")


class TestSecurityHeaders:
    """Tests that security headers are set on all backend responses."""

    def test_security_headers_on_normal_response(self, client: TestClient) -> None:
        """Public endpoints should include all base security headers."""
        resp = client.get("/auth/has-users")
        assert resp.status_code == 200
        assert resp.headers.get("x-content-type-options") == "nosniff"
        assert resp.headers.get("x-frame-options") == "DENY"
        assert resp.headers.get("referrer-policy") == "strict-origin-when-cross-origin"
        assert "geolocation=()" in resp.headers.get("permissions-policy", "")
        assert "camera=()" in resp.headers.get("permissions-policy", "")

    def test_hsts_on_https(self, client: TestClient) -> None:
        """HSTS header should be set when X-Forwarded-Proto is https."""
        resp = client.get("/auth/has-users", headers={"X-Forwarded-Proto": "https"})
        assert resp.status_code == 200
        assert (
            resp.headers.get("strict-transport-security")
            == "max-age=31536000; includeSubDomains"
        )

    def test_no_hsts_on_http(self, client: TestClient) -> None:
        """HSTS header should NOT be set for plain HTTP requests."""
        resp = client.get("/auth/has-users")
        assert resp.status_code == 200
        assert "strict-transport-security" not in resp.headers

    def test_hsts_not_set_on_forwarded_http(self, client: TestClient) -> None:
        """HSTS header should NOT be set when X-Forwarded-Proto is http."""
        resp = client.get("/auth/has-users", headers={"X-Forwarded-Proto": "http"})
        assert resp.status_code == 200
        assert "strict-transport-security" not in resp.headers

    def test_headers_on_404_response(self, client: TestClient) -> None:
        """Security headers should be present on 404 responses."""
        resp = client.get("/public/nonexistent")
        assert resp.status_code == 404
        assert resp.headers.get("x-content-type-options") == "nosniff"
        assert resp.headers.get("x-frame-options") == "DENY"

    def test_headers_on_auth_error(self, client: TestClient) -> None:
        """Security headers should be present on 401 unauthorized responses."""
        resp = client.get("/v1/datasets")
        assert resp.status_code == 401
        assert resp.headers.get("x-content-type-options") == "nosniff"
        assert resp.headers.get("x-frame-options") == "DENY"

    def test_options_preflight_has_security_headers(self, client: TestClient) -> None:
        """OPTIONS preflight responses should include security headers."""
        resp = client.options(
            "/auth/has-users",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert resp.headers.get("x-content-type-options") == "nosniff"

    def test_forwarded_proto_multiple_values(self, client: TestClient) -> None:
        """First value of comma-separated X-Forwarded-Proto should be used."""
        resp = client.get("/auth/has-users", headers={"X-Forwarded-Proto": "https, http"})
        assert (
            resp.headers.get("strict-transport-security")
            == "max-age=31536000; includeSubDomains"
        )

    def test_permissions_policy_denies_all_features(self, client: TestClient) -> None:
        """Permissions-Policy should deny geolocation, microphone, camera, etc."""
        resp = client.get("/auth/has-users")
        policy = resp.headers.get("permissions-policy", "")
        for feature in (
            "geolocation=()",
            "microphone=()",
            "camera=()",
            "payment=()",
            "usb=()",
            "magnetometer=()",
            "gyroscope=()",
            "accelerometer=()",
            "display-capture=()",
        ):
            assert feature in policy, f"Missing {feature} in Permissions-Policy"
