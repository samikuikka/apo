"""Two-key API authentication helpers (SPEC-092).

Provides validation functions for the three wire formats:
    - Basic auth (public_key:secret_key) — full access
    - Bearer public key (pk-apo-xxx) — ingest-only scope
    - Legacy Bearer (sk-xxx) — backward-compatible full access

Also provides ``generate_key_pair`` for creating new pk-apo/sk-apo pairs.

Each validation function consults the in-memory ``api_key_cache`` (SPEC-093)
before hitting the database. Both positive (valid key) and negative (not found)
results are cached.
"""

import hashlib
import os
import secrets
from uuid import uuid4

from sqlmodel import Session, select

from ..models.db import ApiKeyDB
from .api_key_cache import (
    api_key_cache,
    cache_key_for_basic,
    cache_key_for_bearer_public,
    cache_key_for_legacy,
)

_PUBLIC_KEY_PREFIX = "pk-apo-"
_SECRET_KEY_PREFIX = "sk-apo-"


def _get_salt() -> str:
    """Return the API key salt from the environment (empty string if unset)."""
    return os.environ.get("API_KEY_SALT", "")


def _hash_secret_key(secret_key: str) -> str:
    """Hash a secret key with the configured salt using SHA256."""
    salt = _get_salt()
    return hashlib.sha256(f"{secret_key}:{salt}".encode()).hexdigest()


def _format_display_key(secret_key: str) -> str:
    """Format a secret key for display: first 8 + '...' + last 4.

    Example: sk-apo-b1c2d3e4-f5a6-7890-bcde-f12345678901 -> sk-apo-b1c2...8901
    """
    if len(secret_key) <= 12:
        return secret_key
    return f"{secret_key[:8]}...{secret_key[-4:]}"


def generate_key_pair() -> tuple[str, str, str, str]:
    """Generate a public/secret key pair.

    Returns:
        A tuple of (public_key, secret_key, hashed_secret_key, display_secret_key).
            - public_key: pk-apo-<uuid4>
            - secret_key: sk-apo-<uuid4> (shown once to the user)
            - hashed_secret_key: SHA256(secret_key + salt) for storage
            - display_secret_key: masked form for UI lists
    """
    public_key = f"{_PUBLIC_KEY_PREFIX}{uuid4()}"
    secret_key = f"{_SECRET_KEY_PREFIX}{uuid4()}"
    hashed_secret_key = _hash_secret_key(secret_key)
    display_secret_key = _format_display_key(secret_key)
    return public_key, secret_key, hashed_secret_key, display_secret_key


def is_public_key(token: str) -> bool:
    """Check if a bearer token is a public key (pk-apo- prefix)."""
    return token.startswith(_PUBLIC_KEY_PREFIX)


def validate_basic_auth(
    public_key: str, secret_key: str, session: Session
) -> ApiKeyDB | None:
    """Validate a public:secret key pair via Basic auth.

    Both the public_key and the hashed secret must match.
    Returns the ApiKeyDB if valid, None otherwise. Results are cached
    (positive and negative) to skip the DB on subsequent calls.
    """
    fast_hash = _hash_secret_key(secret_key)
    cache_key = cache_key_for_basic(public_key, fast_hash)

    cached = api_key_cache.get(cache_key)
    if cached != "MISS":
        return cached

    statement = select(ApiKeyDB).where(
        ApiKeyDB.public_key == public_key,
        ApiKeyDB.hashed_secret_key == fast_hash,
    )
    api_key = session.exec(statement).first()

    if api_key is not None:
        api_key_cache.set_positive(cache_key, api_key)
    else:
        api_key_cache.set_negative(cache_key)

    return api_key


def validate_bearer_public_key(
    public_key: str, session: Session
) -> ApiKeyDB | None:
    """Validate a public-key-only Bearer token.

    Looks up by public_key only — no secret needed.
    Grants ingest-only scope regardless of the key's stored scope.
    Results are cached (positive and negative) to skip the DB on subsequent calls.
    """
    cache_key = cache_key_for_bearer_public(public_key)

    cached = api_key_cache.get(cache_key)
    if cached != "MISS":
        return cached

    statement = select(ApiKeyDB).where(ApiKeyDB.public_key == public_key)
    api_key = session.exec(statement).first()

    if api_key is not None:
        api_key_cache.set_positive(cache_key, api_key)
    else:
        api_key_cache.set_negative(cache_key)

    return api_key


def validate_legacy_bearer(token: str, session: Session) -> ApiKeyDB | None:
    """Validate a legacy single-key Bearer token (sk-xxx without pk-apo- prefix).

    Looks up by SHA256(token) in the hashed_key column.
    Returns the ApiKeyDB if valid, None otherwise. Results are cached
    (positive and negative) to skip the DB on subsequent calls.
    """
    hashed = hashlib.sha256(token.encode()).hexdigest()
    cache_key = cache_key_for_legacy(hashed)

    cached = api_key_cache.get(cache_key)
    if cached != "MISS":
        return cached

    statement = select(ApiKeyDB).where(ApiKeyDB.hashed_key == hashed)
    api_key = session.exec(statement).first()

    if api_key is not None:
        api_key_cache.set_positive(cache_key, api_key)
    else:
        api_key_cache.set_negative(cache_key)

    return api_key


def generate_legacy_key() -> tuple[str, str, str]:
    """Generate a legacy single key (backward compat with existing SDK users).

    Returns:
        A tuple of (full_key, prefix, hashed_key).
    """
    raw = secrets.token_hex(24)
    full_key = f"sk-{raw}"
    prefix = full_key[:8]
    hashed_key = hashlib.sha256(full_key.encode()).hexdigest()
    return full_key, prefix, hashed_key
