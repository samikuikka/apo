# pyright: reportAny=false

from fastapi.testclient import TestClient

DEFAULT_ORIGIN = "http://localhost:3000"


class TestCORS:
    """Tests that CORS is restricted to FRONTEND_URL (no wildcard)."""

    def test_cors_allows_default_frontend_origin(self, client: TestClient) -> None:
        """The default FRONTEND_URL origin should receive CORS allow-origin header."""
        resp = client.get("/health", headers={"Origin": DEFAULT_ORIGIN})
        assert resp.status_code == 200
        assert resp.headers.get("access-control-allow-origin") == DEFAULT_ORIGIN
        assert resp.headers.get("access-control-allow-credentials") == "true"

    def test_cors_rejects_unknown_origin(self, client: TestClient) -> None:
        """Unknown origins should NOT receive CORS headers."""
        resp = client.get("/health", headers={"Origin": "http://evil.com"})
        assert resp.status_code == 200
        assert resp.headers.get("access-control-allow-origin") is None

    def test_cors_preflight_allows_default_frontend(self, client: TestClient) -> None:
        """OPTIONS preflight from allowed origin should return proper CORS headers."""
        resp = client.options(
            "/health",
            headers={
                "Origin": DEFAULT_ORIGIN,
                "Access-Control-Request-Method": "GET",
            },
        )
        assert resp.status_code == 200
        assert resp.headers.get("access-control-allow-origin") == DEFAULT_ORIGIN
        assert "GET" in resp.headers.get("access-control-allow-methods", "")

    def test_cors_preflight_rejects_unknown_origin(self, client: TestClient) -> None:
        """OPTIONS preflight from unknown origin should not return CORS headers."""
        resp = client.options(
            "/health",
            headers={
                "Origin": "http://evil.com",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert resp.headers.get("access-control-allow-origin") is None

    def test_cors_not_sent_without_origin_header(self, client: TestClient) -> None:
        """Requests without an Origin header should not get CORS headers."""
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.headers.get("access-control-allow-origin") is None
