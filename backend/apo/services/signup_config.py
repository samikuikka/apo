"""Typed, startup-validated signup configuration.

``APO_SIGNUP_MODE`` is the kill switch for the public admission door:
``invite_only`` (the default) admits nobody without an administrator,
``self_serve`` lets a visitor request an invitation for their own email.

There is no disable flag among the limits: ``0`` never means unlimited. A
present empty, non-integer, zero, or negative value fails startup with a
message naming the offending variable, and so does an unknown mode. A typo
in the mode must not silently open or close the door.

Self-serve invitations are delivered by email only (the accept link is
never returned to the requester), so ``self_serve`` with no email
transport is refused at startup rather than left to fail per request.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Final, Literal

SignupMode = Literal["invite_only", "self_serve"]

SIGNUP_MODE_ENV: Final = "APO_SIGNUP_MODE"
_MODES: Final[tuple[SignupMode, ...]] = ("invite_only", "self_serve")


class SignupConfigError(RuntimeError):
    """Raised when a signup env var has an invalid value."""


@dataclass(frozen=True)
class SignupConfig:
    """Immutable signup policy for one process."""

    mode: SignupMode
    invite_ttl_hours: int
    requests_per_hour_per_ip: int
    max_outstanding: int

    @property
    def self_serve(self) -> bool:
        return self.mode == "self_serve"


def load_signup_config() -> SignupConfig:
    """Load and validate signup configuration from the environment.

    Reads each variable at call time (not import time) so tests and app
    construction see current values. Raises :class:`SignupConfigError` on
    the first invalid variable, naming only that variable.
    """
    limits = {
        attr: _parse_positive_int(env_name, os.environ.get(env_name), default)
        for env_name, attr, default in _LIMIT_SPECS
    }
    return SignupConfig(mode=_parse_mode(os.environ.get(SIGNUP_MODE_ENV)), **limits)


def validate_self_serve_delivery(config: SignupConfig, *, email_configured: bool) -> None:
    """Refuse ``self_serve`` when no real email transport is configured."""
    if config.self_serve and not email_configured:
        raise SignupConfigError(
            f"{SIGNUP_MODE_ENV}=self_serve needs a working email transport: "
            + "set EMAIL_TRANSPORT_URL and EMAIL_FROM_ADDRESS, or use invite_only"
        )


def _parse_mode(raw: str | None) -> SignupMode:
    if raw is None:
        return "invite_only"
    value = raw.strip().lower()
    if value not in _MODES:
        raise SignupConfigError(
            f"{SIGNUP_MODE_ENV} must be one of {', '.join(_MODES)} (got {raw!r})"
        )
    return value


def _parse_positive_int(name: str, raw: str | None, default: int) -> int:
    if raw is None:
        return default
    raw = raw.strip()
    if raw == "":
        raise SignupConfigError(f"{name} must be a positive integer (got empty)")
    try:
        value = int(raw)
    except ValueError:
        raise SignupConfigError(
            f"{name} must be a positive base-10 integer (got {raw!r})"
        ) from None
    if value <= 0:
        raise SignupConfigError(f"{name} must be a positive integer (got {value})")
    return value


# (env var name, attribute name, default)
#
# TTL 24 h: a self-serve link is a credential nobody vouched for, so it
# lives a day instead of the week an administrator's invitation gets.
# 3 requests per hour per IP: enough for a typo and a retry, too few to
# farm invitations from one address. 200 outstanding: bounds what a
# distributed flood can leave pending while staying far above an honest
# day of signups on a small installation.
_LIMIT_SPECS: Final[tuple[tuple[str, str, int], ...]] = (
    ("APO_SELF_SERVE_INVITE_TTL_HOURS", "invite_ttl_hours", 24),
    ("APO_SELF_SERVE_REQUESTS_PER_HOUR_PER_IP", "requests_per_hour_per_ip", 3),
    ("APO_SELF_SERVE_MAX_OUTSTANDING", "max_outstanding", 200),
)


__all__ = [
    "SIGNUP_MODE_ENV",
    "SignupConfig",
    "SignupConfigError",
    "SignupMode",
    "load_signup_config",
    "validate_self_serve_delivery",
]
