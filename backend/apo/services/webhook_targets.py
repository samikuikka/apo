"""Webhook destination validation: keep deliveries off internal networks.

Webhook URLs are admin-configured and delivered server-side. Without a
destination check, a project admin on a hosted deployment can point a
webhook at internal services (the cloud metadata endpoint, the database,
loopback services) and read the delivery result back through the test
endpoint — a classic SSRF ladder.

Two layers:
  - ``validate_webhook_url`` — structural check (scheme, host) used at
    creation/update time for fast, actionable feedback.
  - ``assert_public_destination`` — resolves the hostname and rejects
    private/loopback/link-local/reserved addresses, run again at delivery
    time so a name whose DNS changed to an internal address after creation
    still cannot be reached (narrowing the DNS-rebinding window to one
    delivery).
"""

# pyright: reportUnusedCallResult=false

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

ALLOWED_SCHEMES = frozenset({"http", "https"})


class WebhookDestinationError(ValueError):
    """The webhook URL points somewhere deliveries must not go."""


def validate_webhook_url(url: str) -> None:
    """Structural validation at configuration time.

    Raises :class:`WebhookDestinationError` with an operator-actionable
    message; returns silently when the URL is shaped acceptably.
    """
    parts = urlsplit(url)
    if parts.scheme.lower() not in ALLOWED_SCHEMES:
        raise WebhookDestinationError(
            f"Webhook URL scheme must be http or https, got '{parts.scheme or 'none'}'."
        )
    hostname = parts.hostname
    if not hostname:
        raise WebhookDestinationError("Webhook URL must include a hostname.")
    # 'localhost' is a name, not a literal IP, but it always means loopback.
    if hostname.lower() == "localhost":
        raise WebhookDestinationError(
            "Webhook URL points at a non-public address (localhost). "
            "Deliveries to private, loopback, link-local, or reserved "
            "networks are blocked."
        )
    # Literal IPs are checked structurally here too, so a numeric loopback
    # never even reaches delivery-time resolution.
    _check_address(hostname)


def assert_public_destination(url: str) -> None:
    """Delivery-time check: resolve the hostname, reject internal targets."""
    parts = urlsplit(url)
    hostname = parts.hostname or ""
    if not hostname:
        raise WebhookDestinationError("Webhook URL has no hostname.")
    try:
        infos = socket.getaddrinfo(hostname, None)
    except OSError as exc:
        # Resolution failures surface as delivery failures downstream.
        raise WebhookDestinationError(
            f"Webhook hostname '{hostname}' does not resolve."
        ) from exc
    for info in infos:
        _check_address(str(info[4][0]))


def _check_address(host: str) -> None:
    """Reject a hostname or literal IP that denotes an internal network."""
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        # A DNS name — literal-IP checks below don't apply here; delivery-
        # time resolution covers names that resolve internally.
        return
    if (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    ):
        raise WebhookDestinationError(
            f"Webhook URL points at a non-public address ({addr}). "
            "Deliveries to private, loopback, link-local, or reserved "
            "networks are blocked."
        )
