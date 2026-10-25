# pyright: reportAny=false, reportPrivateUsage=false, reportImplicitStringConcatenation=false

from starlette.requests import Request

from apo.auth.middleware import _get_session_cookie


class TestCookieNameAlignment:
    """Tests that backend middleware checks the same cookie names NextAuth sets."""

    def test_get_session_cookie_finds_http_cookie(self) -> None:
        """The plain (HTTP) session cookie name should be recognized."""
        scope = {
            "type": "http",
            "headers": [(b"cookie", b"authjs.session-token=jwt-token-123")],
        }
        request = Request(scope)  # type: ignore[arg-type]
        assert _get_session_cookie(request) == "jwt-token-123"

    def test_get_session_cookie_finds_https_cookie(self) -> None:
        """The __Secure- prefixed (HTTPS) session cookie name should be recognized."""
        scope = {
            "type": "http",
            "headers": [
                (b"cookie", b"__Secure-authjs.session-token=jwt-token-456"),
            ],
        }
        request = Request(scope)  # type: ignore[arg-type]
        assert _get_session_cookie(request) == "jwt-token-456"

    def test_get_session_cookie_returns_none_when_absent(self) -> None:
        """No session cookie present should return None."""
        scope = {
            "type": "http",
            "headers": [(b"cookie", b"other-cookie=value")],
        }
        request = Request(scope)  # type: ignore[arg-type]
        assert _get_session_cookie(request) is None

    def test_get_session_cookie_prefers_first_match(self) -> None:
        """When both cookies present, the first in _COOKIE_NAMES order wins."""
        scope = {
            "type": "http",
            "headers": [
                (
                    b"cookie",
                    b"authjs.session-token=http-value; __Secure-authjs.session-token=https-value",
                ),
            ],
        }
        request = Request(scope)  # type: ignore[arg-type]
        assert _get_session_cookie(request) == "http-value"

    def test_get_session_cookie_reassembles_chunked_authjs_cookie(self) -> None:
        """Chunked Auth.js cookies should be reassembled in numeric order."""
        scope = {
            "type": "http",
            "headers": [
                (
                    b"cookie",
                    b"authjs.session-token.1=second; authjs.session-token.0=first; other-cookie=value",
                ),
            ],
        }
        request = Request(scope)  # type: ignore[arg-type]
        assert _get_session_cookie(request) == "firstsecond"
