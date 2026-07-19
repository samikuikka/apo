# pyright: reportAny=false, reportPrivateUsage=false, reportUntypedFunctionDecorator=false, reportCallIssue=false

import pytest

from apo.auth import validate_frontend_url, validate_redirect_path


class TestValidateRedirectPath:
    @pytest.mark.parametrize(
        "path,expected",
        [
            ("/dashboard", "/dashboard"),
            ("/traces?id=123#details", "/traces?id=123#details"),
            ("/", "/"),
            ("/ünicode/path", "/ünicode/path"),
            ("/%2F%2Fevil.com", "/%2F%2Fevil.com"),
        ],
    )
    def test_valid_paths(self, path: str, expected: str) -> None:
        assert validate_redirect_path(path) == expected

    @pytest.mark.parametrize(
        "path,expected",
        [
            ("", "/"),
            (None, "/"),
        ],
    )
    def test_empty_input(self, path: str | None, expected: str) -> None:
        assert validate_redirect_path(path or "") == expected

    @pytest.mark.parametrize(
        "path",
        [
            "//evil.com",
            "/\\evil.com",
            "https://evil.com",
            "http://evil.com",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox(1)",
            "file:///etc/passwd",
            "/javascript:alert(1)",
            "/data:text/html,<script>",
            "JavaScript:alert(1)",
            "  //evil.com",
        ],
    )
    def test_attack_vectors_blocked(self, path: str) -> None:
        assert validate_redirect_path(path) == "/"

    def test_control_char_stripped_then_validated(self) -> None:
        assert validate_redirect_path("/\x00admin") == "/admin"

    def test_null_byte_between_slashes_blocked(self) -> None:
        assert validate_redirect_path("/\x00/admin") == "/"

    def test_leading_whitespace_stripped(self) -> None:
        assert validate_redirect_path(" /admin") == "/admin"

    def test_tab_newline_injection_stripped(self) -> None:
        result = validate_redirect_path("/admin\x0d\x0aSet-Cookie:evil=1")
        assert result == "/adminSet-Cookie:evil=1"

    def test_mid_path_double_slashes_collapsed(self) -> None:
        assert validate_redirect_path("/dashboard//traces") == "/dashboard/traces"

    def test_leading_triple_slashes_blocked(self) -> None:
        assert validate_redirect_path("///evil.com") == "/"

    def test_whitespace_only_returns_default(self) -> None:
        assert validate_redirect_path("   ") == "/"

    def test_control_char_only_returns_default(self) -> None:
        assert validate_redirect_path("\x00\x01\x02") == "/"

    def test_idempotent_on_safe_path(self) -> None:
        path = "/dashboard/users"
        assert validate_redirect_path(validate_redirect_path(path)) == path

    def test_idempotent_on_root(self) -> None:
        assert validate_redirect_path(validate_redirect_path("/")) == "/"


class TestValidateFrontendUrl:
    def test_http_url_preserved(self) -> None:
        assert validate_frontend_url("http://localhost:3000") == "http://localhost:3000"

    def test_https_url_preserved(self) -> None:
        assert validate_frontend_url("https://example.com") == "https://example.com"

    def test_trailing_slash_stripped(self) -> None:
        assert validate_frontend_url("http://localhost:3000/") == "http://localhost:3000"

    def test_https_with_trailing_slash(self) -> None:
        assert validate_frontend_url("https://example.com/") == "https://example.com"

    def test_invalid_scheme_returns_default(self) -> None:
        assert validate_frontend_url("javascript://evil") == "http://localhost:3000"

    def test_ftp_scheme_returns_default(self) -> None:
        assert validate_frontend_url("ftp://evil.com") == "http://localhost:3000"

    def test_empty_string_returns_default(self) -> None:
        assert validate_frontend_url("") == "http://localhost:3000"

    def test_relative_url_returns_default(self) -> None:
        assert validate_frontend_url("/admin") == "http://localhost:3000"

    def test_double_slash_not_duplicated(self) -> None:
        url = validate_frontend_url("http://localhost:3000/")
        reset = f"{url}/reset-password?token=abc"
        assert reset == "http://localhost:3000/reset-password?token=abc"
        assert "//reset-password" not in reset
