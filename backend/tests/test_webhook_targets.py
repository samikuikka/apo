"""Webhook destination validation — SSRF guard for server-side deliveries."""

from __future__ import annotations

import pytest

from apo.services.webhook_targets import (
    WebhookDestinationError,
    assert_public_destination,
    validate_webhook_url,
)


class TestValidateWebhookUrl:
    def test_accepts_public_https(self) -> None:
        validate_webhook_url("https://hooks.example.com/incoming")

    def test_accepts_public_http(self) -> None:
        validate_webhook_url("http://hooks.example.com/incoming")

    @pytest.mark.parametrize(
        "url",
        [
            "ftp://example.com/hook",
            "file:///etc/passwd",
            "gopher://example.com",
            "example.com/hook",  # no scheme
        ],
    )
    def test_rejects_non_http_schemes(self, url: str) -> None:
        with pytest.raises(WebhookDestinationError, match="scheme"):
            validate_webhook_url(url)

    @pytest.mark.parametrize(
        "url",
        [
            "http://127.0.0.1:8000/hook",
            "http://localhost/hook",
            "http://169.254.169.254/latest/meta-data",
            "http://10.0.0.5/hook",
            "http://192.168.1.10/hook",
            "http://[::1]/hook",
            "http://[fe80::1]/hook",
            "http://0.0.0.0/hook",
        ],
    )
    def test_rejects_internal_literal_addresses(self, url: str) -> None:
        with pytest.raises(WebhookDestinationError, match="non-public"):
            validate_webhook_url(url)

    def test_rejects_missing_hostname(self) -> None:
        with pytest.raises(WebhookDestinationError, match="hostname"):
            validate_webhook_url("https:///path-only")

    def test_error_message_names_the_address(self) -> None:
        with pytest.raises(WebhookDestinationError, match=r"169\.254\.169\.254"):
            validate_webhook_url("http://169.254.169.254/latest/meta-data")


class TestAssertPublicDestination:
    def test_accepts_resolving_public_host(self) -> None:
        # example.com resolves to public documentation addresses.
        assert_public_destination("https://example.com/hook")

    def test_rejects_unresolvable_host(self) -> None:
        with pytest.raises(WebhookDestinationError, match="does not resolve"):
            assert_public_destination("https://nonexistent-xyz-invalid.example/")

    def test_rejects_loopback_name(self) -> None:
        with pytest.raises(WebhookDestinationError, match="non-public"):
            assert_public_destination("http://localhost:8000/hook")
