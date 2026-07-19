"""GitHub OAuth integration service (SPEC-121).

Handles:

- OAuth authorize URL generation with project-scoped, signed state.
- Code-for-token exchange via GitHub's access_token endpoint.
- Fernet-encrypted storage of access tokens at rest.
- Reading repos / branches from the GitHub REST API on behalf of a
  connected project.
- Decrypting tokens for the sync service so private repos clone
  without per-user PATs.

Configuration is fully optional: when ``GITHUB_CLIENT_ID`` /
``GITHUB_CLIENT_SECRET`` / ``GITHUB_REDIRECT_URI`` /
``GITHUB_TOKEN_ENCRYPTION_KEY`` are unset, ``is_github_enabled()``
returns ``False`` and callers (routes, sync, UI) degrade gracefully to
the manual URL paste flow from SPEC-118/119.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import time
import urllib.parse
from base64 import urlsafe_b64decode, urlsafe_b64encode
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import cast

import httpx
from cryptography.fernet import Fernet, InvalidToken
from sqlmodel import Session, select

from ..models.db import GithubConnectionDB

logger = logging.getLogger(__name__)

GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_API_BASE = "https://api.github.com"

# Default OAuth scopes — repo covers public + private repos, workflows
# is not requested because we don't push commits. Keep the scope set
# minimal so the auth screen shows the least-creepy permission set.
DEFAULT_SCOPES = "repo"

# OAuth state lifetime — generous enough for the user to log in to
# GitHub and click Authorize, short enough to make replay impractical.
STATE_TTL_SECONDS = 10 * 60


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GithubConfig:
    client_id: str
    client_secret: str
    redirect_uri: str
    encryption_key: str


def load_github_config() -> GithubConfig | None:
    """Return the GitHub OAuth config, or ``None`` if not configured.

    All four env vars must be set together. Any missing value disables
    GitHub Connect — callers must check the return value.
    """
    client_id = os.environ.get("GITHUB_CLIENT_ID", "").strip()
    client_secret = os.environ.get("GITHUB_CLIENT_SECRET", "").strip()
    redirect_uri = os.environ.get("GITHUB_REDIRECT_URI", "").strip()
    encryption_key = os.environ.get("GITHUB_TOKEN_ENCRYPTION_KEY", "").strip()

    if not (client_id and client_secret and redirect_uri and encryption_key):
        return None
    return GithubConfig(
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=redirect_uri,
        encryption_key=encryption_key,
    )


def is_github_enabled() -> bool:
    """Cheap boolean check for route handlers and the UI availability API."""
    return load_github_config() is not None


# ---------------------------------------------------------------------------
# Encryption
# ---------------------------------------------------------------------------


def _fernet(config: GithubConfig) -> Fernet:
    return Fernet(config.encryption_key.encode("utf-8"))


def encrypt_token(token: str, config: GithubConfig) -> str:
    """Encrypt a GitHub access token for storage. Returns a Fernet token string."""
    return _fernet(config).encrypt(token.encode("utf-8")).decode("utf-8")


def decrypt_token(encrypted: str, config: GithubConfig) -> str:
    """Decrypt a stored token. Raises ``InvalidToken`` on tamper / wrong key."""
    return _fernet(config).decrypt(encrypted.encode("utf-8")).decode("utf-8")


def decrypt_connection_token(
    connection: GithubConnectionDB, config: GithubConfig
) -> str:
    """Decrypt the connection's access token. Used by the sync service."""
    return decrypt_token(connection.access_token_encrypted, config)


# ---------------------------------------------------------------------------
# OAuth state (CSRF protection)
# ---------------------------------------------------------------------------


def _state_signature(config: GithubConfig, payload_b64: str) -> str:
    """HMAC-SHA256 of the base64 state payload using client_secret as key."""
    digest = hmac.new(
        config.client_secret.encode("utf-8"),
        payload_b64.encode("utf-8"),
        "sha256",
    ).digest()
    return urlsafe_b64encode(digest).rstrip(b"=").decode("utf-8")


@dataclass(frozen=True)
class SignedState:
    project_id: str
    nonce: str
    expires_at: int
    next_path: str | None


def build_signed_state(
    config: GithubConfig,
    *,
    project_id: str,
    next_path: str | None,
    nonce: str,
) -> str:
    """Build a signed, time-limited OAuth state token.

    Structure: ``base64url(payload).signature`` where payload is a JSON
    object with ``project_id``, ``nonce``, ``expires_at``, ``next_path``.
    The signature is HMAC-SHA256 over the base64 payload using
    ``client_secret`` as the key, so only the backend can mint or verify
    states.
    """
    payload = {
        "project_id": project_id,
        "nonce": nonce,
        "exp": int(time.time()) + STATE_TTL_SECONDS,
        "next": next_path,
    }
    payload_json = json.dumps(payload, separators=(",", ":"))
    payload_b64 = urlsafe_b64encode(payload_json.encode("utf-8")).rstrip(b"=").decode("utf-8")
    signature = _state_signature(config, payload_b64)
    return f"{payload_b64}.{signature}"


def verify_signed_state(config: GithubConfig, state: str) -> SignedState | None:
    """Verify signature + expiry. Returns the decoded payload or ``None``."""
    if "." not in state:
        return None
    payload_b64, signature = state.rsplit(".", 1)
    expected = _state_signature(config, payload_b64)
    if not hmac.compare_digest(expected, signature):
        return None

    # base64url decode (add padding back)
    padding = "=" * (-len(payload_b64) % 4)
    try:
        payload_json = urlsafe_b64decode(payload_b64 + padding).decode("utf-8")
        payload = json.loads(payload_json)
    except (ValueError, json.JSONDecodeError):
        return None

    expires_at = int(payload.get("exp", 0))
    if expires_at < int(time.time()):
        return None

    return SignedState(
        project_id=str(payload.get("project_id", "")),
        nonce=str(payload.get("nonce", "")),
        expires_at=expires_at,
        next_path=payload.get("next") if isinstance(payload.get("next"), str) else None,
    )


# ---------------------------------------------------------------------------
# OAuth URLs
# ---------------------------------------------------------------------------


def build_authorize_url(
    config: GithubConfig,
    *,
    state: str,
    scopes: str = DEFAULT_SCOPES,
) -> str:
    """Build the GitHub OAuth authorize URL for redirecting the user."""
    params = {
        "client_id": config.client_id,
        "redirect_uri": config.redirect_uri,
        "scope": scopes,
        "state": state,
    }
    return f"{GITHUB_AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


# ---------------------------------------------------------------------------
# Token exchange
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AccessTokenResponse:
    access_token: str
    token_type: str
    scope: str
    raw: dict[str, object]


def exchange_code_for_token(
    config: GithubConfig, code: str
) -> AccessTokenResponse:
    """Exchange an OAuth code for an access token.

    Raises ``httpx.HTTPStatusError`` if GitHub returns non-2xx, or
    ``GithubOAuthError`` if GitHub returns 200 but no access_token
    (e.g. user denied access).
    """
    with httpx.Client(timeout=15.0) as client:
        response = client.post(
            GITHUB_TOKEN_URL,
            json={
                "client_id": config.client_id,
                "client_secret": config.client_secret,
                "code": code,
                "redirect_uri": config.redirect_uri,
            },
            headers={"Accept": "application/json"},
        )
        _ = response.raise_for_status()
        body = cast(dict[str, object], response.json())

    token = body.get("access_token")
    if not isinstance(token, str):
        error_description = body.get("error_description") or body.get("error")
        message = (
            str(error_description)
            if error_description
            else "GitHub did not return an access token."
        )
        raise GithubOAuthError(message)

    return AccessTokenResponse(
        access_token=token,
        token_type=str(body.get("token_type", "bearer")),
        scope=str(body.get("scope", "")),
        raw=body,
    )


class GithubOAuthError(Exception):
    """Raised when GitHub returns an error during the OAuth flow."""


# ---------------------------------------------------------------------------
# GitHub user / repos / branches
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GithubUser:
    id: str
    login: str


def fetch_authenticated_user(access_token: str) -> GithubUser:
    """Return the GitHub user the access token belongs to."""
    with httpx.Client(timeout=15.0) as client:
        response = client.get(
            f"{GITHUB_API_BASE}/user",
            headers=_auth_headers(access_token),
        )
        _ = response.raise_for_status()
        body = cast(dict[str, object], response.json())
    return GithubUser(
        id=str(body.get("id", "")),
        login=str(body.get("login", "")),
    )


@dataclass(frozen=True)
class GithubRepo:
    id: int
    full_name: str
    name: str
    clone_url: str
    default_branch: str
    private: bool
    pushed_at: str | None


def list_user_repos(access_token: str) -> list[GithubRepo]:
    """Return the user's repositories, sorted by last push (most recent first)."""
    with httpx.Client(timeout=15.0) as client:
        response = client.get(
            f"{GITHUB_API_BASE}/user/repos",
            headers=_auth_headers(access_token),
            params={
                "per_page": 100,
                "sort": "pushed",
                "direction": "desc",
                "affiliation": "owner,collaborator,organization_member",
            },
        )
        _ = response.raise_for_status()
        body = cast(list[dict[str, object]], response.json())

    repos: list[GithubRepo] = []
    for item in body:
        pushed_at_raw = item.get("pushed_at")
        repos.append(
            GithubRepo(
                id=int(item.get("id", 0)),  # pyright: ignore[reportArgumentType]
                full_name=str(item.get("full_name", "")),
                name=str(item.get("name", "")),
                clone_url=str(item.get("clone_url", "")),
                default_branch=str(item.get("default_branch", "main")),
                private=bool(item.get("private", False)),
                pushed_at=pushed_at_raw if isinstance(pushed_at_raw, str) else None,
            )
        )
    return repos


@dataclass(frozen=True)
class GithubBranch:
    name: str
    protected: bool


def list_repo_branches(
    access_token: str, owner: str, repo: str
) -> list[GithubBranch]:
    """Return branches for ``owner/repo``."""
    with httpx.Client(timeout=15.0) as client:
        response = client.get(
            f"{GITHUB_API_BASE}/repos/{owner}/{repo}/branches",
            headers=_auth_headers(access_token),
            params={"per_page": 100},
        )
        _ = response.raise_for_status()
        body = cast(list[dict[str, object]], response.json())

    return [
        GithubBranch(
            name=str(item.get("name", "")),
            protected=bool(item.get("protected", False)),
        )
        for item in body
    ]


@dataclass(frozen=True)
class GithubPathEntry:
    """One entry in a repo directory listing."""

    name: str
    path: str
    type: str  # "file" | "dir" | "symlink" | "submodule"
    has_task_file: bool = False


def list_repo_path_contents(
    access_token: str,
    owner: str,
    repo: str,
    *,
    path: str = "",
    ref: str = "",
) -> list[GithubPathEntry]:
    """List entries in ``owner/repo`` at ``path`` on ``ref``.

    Used by the dashboard's folder browser so the user can pick a
    subpath visually instead of typing. Hits GitHub's contents API
    (no clone required). Returns directories first, then files, mirroring
    how GitHub renders the page.
    """
    params: dict[str, str] = {}
    if ref:
        params["ref"] = ref
    # GitHub's contents API: empty path → root. Trailing slash must be
    # avoided since `/contents/` returns 404 while `/contents` returns
    # the repo root.
    base_url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/contents"
    url = f"{base_url}/{path}" if path else base_url
    with httpx.Client(timeout=15.0) as client:
        response = client.get(url, headers=_auth_headers(access_token), params=params)
        _ = response.raise_for_status()
        body = cast(list[dict[str, object]], response.json())

    entries = [
        GithubPathEntry(
            name=str(item.get("name", "")),
            path=str(item.get("path", "")),
            type=str(item.get("type", "file")),
            has_task_file=False,
        )
        for item in body
    ]
    # Sort: directories first, then alphabetical — matches GitHub's UI.
    entries.sort(key=lambda e: (e.type != "dir", e.name.lower()))
    return entries


def _auth_headers(access_token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


# ---------------------------------------------------------------------------
# Connection persistence
# ---------------------------------------------------------------------------


def get_connection(
    session: Session, project_id: str
) -> GithubConnectionDB | None:
    """Return the project's GitHub connection, or ``None``."""
    statement = select(GithubConnectionDB).where(
        GithubConnectionDB.project == project_id
    )
    return session.exec(statement).first()


def store_connection(
    session: Session,
    *,
    project_id: str,
    user: GithubUser,
    token_response: AccessTokenResponse,
    config: GithubConfig,
) -> GithubConnectionDB:
    """Create or replace the project's GitHub connection.

    The access token is encrypted with Fernet before persistence.
    Reconnecting with a different GitHub account replaces the row.
    """
    existing = get_connection(session, project_id)
    encrypted = encrypt_token(token_response.access_token, config)
    now = datetime.now(timezone.utc)

    if existing is None:
        row = GithubConnectionDB(
            project=project_id,
            github_user_id=user.id,
            github_username=user.login,
            access_token_encrypted=encrypted,
            scopes_granted=token_response.scope,
            token_type=token_response.token_type,
            created_at=now,
            updated_at=now,
        )
        session.add(row)
    else:
        existing.github_user_id = user.id
        existing.github_username = user.login
        existing.access_token_encrypted = encrypted
        existing.scopes_granted = token_response.scope
        existing.token_type = token_response.token_type
        existing.updated_at = now
        row = existing

    session.commit()
    session.refresh(row)
    return row


def delete_connection(session: Session, project_id: str) -> bool:
    """Delete the project's GitHub connection. Returns True if a row was deleted."""
    existing = get_connection(session, project_id)
    if existing is None:
        return False
    session.delete(existing)
    session.commit()
    return True


def resolve_access_token(
    session: Session,
    project_id: str,
    config: GithubConfig,
) -> str | None:
    """Return a decrypted access token for the project, or ``None``.

    Used by the sync service to inject the token into clone URLs so
    private repositories clone without a user-managed PAT. ``None`` is
    a sentinel for "no GitHub connection, fall back to anonymous clone".
    """
    connection = get_connection(session, project_id)
    if connection is None:
        return None
    try:
        return decrypt_connection_token(connection, config)
    except InvalidToken:
        # Key rotated or row tampered — surface as "connection broken" to
        # the operator. Reconnection will fix it.
        logger.warning(
            "Failed to decrypt GitHub connection token for project %s; user should reconnect.",
            project_id,
        )
        return None


__all__ = [
    "AccessTokenResponse",
    "GithubBranch",
    "GithubConfig",
    "GithubConnectionDB",
    "GithubOAuthError",
    "GithubPathEntry",
    "GithubRepo",
    "GithubUser",
    "SignedState",
    "build_authorize_url",
    "build_signed_state",
    "delete_connection",
    "decrypt_connection_token",
    "exchange_code_for_token",
    "fetch_authenticated_user",
    "get_connection",
    "is_github_enabled",
    "list_repo_branches",
    "list_repo_path_contents",
    "list_user_repos",
    "load_github_config",
    "resolve_access_token",
    "store_connection",
    "verify_signed_state",
]
