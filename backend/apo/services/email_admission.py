"""Disposable-email-domain admission guard.

Every path that admits a person by email address (hosted-access
invitations, project invitations, admin user creation) refuses
throwaway inbox domains, so one actor cannot farm burner accounts
against an installation.

The blocked set is bundled data: ``apo/data/disposable-email-domains.json``
(the CC0 ``disposable-email-domains`` snapshot), the same bundled-file
pattern as ``default-model-prices.json``. The file is parsed once into
an immutable matcher; a malformed bundled file fails hard.

An email's domain is blocked when it equals a listed domain or ends
with ``"." + listed domain``, so ``sub.mailinator.com`` is caught while
``notmailinator.com`` never is. Two layers guard against false
positives on a stale or recycled snapshot: a built-in allowlist of
major consumer providers is subtracted from the set at load time, and
``APO_DISPOSABLE_DOMAIN_ALLOWLIST`` (comma-separated domains) lets an
operator punch holes for their own users. Both lists fail closed: an
invalid bundled file or allowlist value is a startup error, never a
silent pass-through.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from fastapi import HTTPException

from .invitation_tokens import normalize_email

DISPOSABLE_DOMAINS_PATH = (
    Path(__file__).resolve().parents[1] / "data" / "disposable-email-domains.json"
)

MAX_EMAIL_LENGTH = 254

ALLOWLIST_ENV = "APO_DISPOSABLE_DOMAIN_ALLOWLIST"

# Dot-separated DNS labels, ascii lowercase (covers punycode). Domains
# only: a leading '@', uppercase, or a space can never be a valid entry.
_DOMAIN_RE = re.compile(
    r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$"
)

# Major consumer mailbox providers that must never be blocked, even if
# a future bundled snapshot lists one by mistake (domains get recycled
# and snapshots go stale). Subtracted from the bundled set at load.
_PROTECTED_PROVIDERS = frozenset(
    {
        "aol.com",
        "fastmail.com",
        "gmail.com",
        "googlemail.com",
        "gmx.com",
        "gmx.de",
        "gmx.net",
        "hey.com",
        "hotmail.com",
        "icloud.com",
        "live.com",
        "mac.com",
        "mail.com",
        "mail.ru",
        "me.com",
        "msn.com",
        "outlook.com",
        "pm.me",
        "126.com",
        "163.com",
        "proton.me",
        "protonmail.com",
        "qq.com",
        "yahoo.com",
        "yandex.com",
        "yandex.ru",
        "zoho.com",
    }
)


class DisposableDomainListError(RuntimeError):
    """Raised when the bundled blocklist or the allowlist env is invalid."""


@dataclass(frozen=True)
class DisposableDomainMatcher:
    """Immutable blocked-domain set; exact or dot-suffix membership."""

    blocked: frozenset[str]

    def is_blocked(self, domain: str) -> bool:
        """True when ``domain`` is listed or sits under a listed domain.

        Trailing dots are the DNS absolute-name form and most resolvers
        deliver ``mailinator.com.`` to ``mailinator.com``, so they are
        stripped before matching rather than trusted as a distinction.
        """
        domain = domain.strip().lower().rstrip(".")
        if domain in self.blocked:
            return True
        return _suffix_blocked(domain, self.blocked)


def _suffix_blocked(domain: str, blocked: frozenset[str]) -> bool:
    """Dot-suffix walk: blocks sub.mailinator.com, spares evilmailinator.com."""
    rest = domain.partition(".")[2]
    while rest:
        if rest in blocked:
            return True
        rest = rest.partition(".")[2]
    return False


def build_disposable_domain_matcher(
    *, path: Path | None = None
) -> DisposableDomainMatcher:
    """Load the bundled blocklist and env allowlist into a matcher.

    Raises :class:`DisposableDomainListError` on a malformed bundled
    file or an invalid ``APO_DISPOSABLE_DOMAIN_ALLOWLIST`` value, so a
    broken deployment fails at startup instead of silently allowing
    everything.
    """
    source = path or DISPOSABLE_DOMAINS_PATH
    try:
        raw = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DisposableDomainListError(
            f"{source.name}: cannot read bundled blocklist ({exc})"
        ) from exc
    entries = raw.get("domains") if isinstance(raw, dict) else None
    if not isinstance(entries, list) or not entries:
        raise DisposableDomainListError(
            f"{source.name}: 'domains' must be a non-empty list"
        )
    for entry in entries:
        if not isinstance(entry, str) or not _DOMAIN_RE.fullmatch(entry):
            raise DisposableDomainListError(
                f"{source.name}: invalid domain entry {entry!r}"
            )

    blocked = frozenset(entries) - _PROTECTED_PROVIDERS - _parse_env_allowlist()
    return DisposableDomainMatcher(blocked=blocked)


def _parse_env_allowlist() -> frozenset[str]:
    raw = os.environ.get(ALLOWLIST_ENV)
    if raw is None:
        return frozenset()
    domains: set[str] = set()
    for item in raw.split(","):
        entry = item.strip().lower()
        if not entry:
            continue
        if not _DOMAIN_RE.fullmatch(entry):
            raise DisposableDomainListError(
                f"{ALLOWLIST_ENV}: invalid domain {entry!r}"
            )
        domains.add(entry)
    return frozenset(domains)


@lru_cache(maxsize=1)
def get_disposable_domain_matcher() -> DisposableDomainMatcher:
    """Process-wide matcher; rebuilt only via cache clear (tests, reload)."""
    return build_disposable_domain_matcher()


def is_disposable_email(email: str) -> bool:
    """True when ``email``'s domain is blocked. Malformed input is not."""
    _, sep, domain = email.rpartition("@")
    if not sep or not domain:
        return False
    return get_disposable_domain_matcher().is_blocked(domain)


def require_admissible_email(email: str) -> None:
    """Reject disposable-domain emails with a 422 at the admission boundary."""
    if is_disposable_email(email):
        raise HTTPException(
            status_code=422,
            detail="Please use a permanent, non-disposable email address.",
        )


def require_email_shape(email: str) -> str:
    """Normalize an address, or 422 when it cannot be one.

    Exactly one address, one ``@``, no list separators. A comma list rode
    a single SMTP send into many inboxes, matched no disposable-domain
    blocklist entry (the whole string is not a blocked domain), and
    bypassed the per-email request limit (the limit key was the whole
    string). One address per request; anyone wanting more gets to ask
    again.
    """
    if email.count("@") != 1 or any(sep in email for sep in (",", ";")):
        raise HTTPException(
            status_code=422, detail="A valid email address is required"
        )
    normalized = normalize_email(email)
    local, _, domain = normalized.rpartition("@")
    if (
        not local
        or not domain
        or "." not in domain
        or len(normalized) > MAX_EMAIL_LENGTH
        or any(char.isspace() for char in normalized)
    ):
        raise HTTPException(
            status_code=422, detail="A valid email address is required"
        )
    return normalized


__all__ = [
    "ALLOWLIST_ENV",
    "DISPOSABLE_DOMAINS_PATH",
    "DisposableDomainListError",
    "DisposableDomainMatcher",
    "build_disposable_domain_matcher",
    "get_disposable_domain_matcher",
    "is_disposable_email",
    "require_admissible_email",
    "require_email_shape",
]
