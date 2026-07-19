"""GitHub OAuth API endpoints (SPEC-121).

Provides the OAuth round-trip and the repos/branches listing that the
dashboard uses to render the "Connect GitHub" picker. When GitHub OAuth
is not configured (env vars missing), every endpoint reports
``enabled: false`` instead of erroring.
"""

# pyright: reportCallInDefaultInitializer=false

import os
import secrets
import urllib.parse
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from sqlmodel import Session

from ..db import get_session
from ..models.db import GithubConnectionDB
from ..services.github_oauth import (
    DEFAULT_SCOPES,
    GithubOAuthError,
    GithubPathEntry,
    GithubRepo,
    GithubBranch,
    build_authorize_url,
    build_signed_state,
    delete_connection,
    exchange_code_for_token,
    fetch_authenticated_user,
    get_connection,
    is_github_enabled,
    list_repo_branches,
    list_repo_path_contents,
    list_user_repos,
    load_github_config,
    resolve_access_token,
    store_connection,
    verify_signed_state,
)
from .projects import _get_user_id, _load_project_for_user

router = APIRouter(prefix="/v1", tags=["github"])


def _dashboard_url(path: str) -> str:
    """Prefix a relative dashboard path with the configured frontend URL.

    The OAuth callback runs on the backend (port 8000), so a relative
    redirect would keep the browser on port 8000 and 404. Always bounce
    through the dashboard origin instead.
    """
    base = os.environ.get("FRONTEND_URL", "http://localhost:3000").rstrip("/")
    if path.startswith("http://") or path.startswith("https://"):
        return path
    if not path.startswith("/"):
        path = "/" + path
    return f"{base}{path}"


def _require_github_enabled() -> None:
    """Common guard for endpoints that need the GitHub OAuth env vars."""
    if not is_github_enabled():
        raise HTTPException(
            status_code=503,
            detail=(
                "GitHub OAuth is not configured on this server. "
                "Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, "
                "GITHUB_REDIRECT_URI, and GITHUB_TOKEN_ENCRYPTION_KEY."
            ),
        )


def _serialize_connection(conn: GithubConnectionDB) -> dict[str, object]:
    """Public shape of a connection — never expose the encrypted token."""
    return {
        "project": conn.project,
        "github_username": conn.github_username,
        "github_user_id": conn.github_user_id,
        "scopes_granted": conn.scopes_granted,
        "connected_at": conn.created_at.isoformat() if conn.created_at else None,
    }


def _serialize_repo(repo: GithubRepo) -> dict[str, object]:
    return {
        "id": repo.id,
        "full_name": repo.full_name,
        "name": repo.name,
        "clone_url": repo.clone_url,
        "default_branch": repo.default_branch,
        "private": repo.private,
        "pushed_at": repo.pushed_at,
    }


def _serialize_branch(branch: GithubBranch) -> dict[str, object]:
    return {"name": branch.name, "protected": branch.protected}


# ---------------------------------------------------------------------------
# Availability + auth URL
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/github/availability")
async def get_github_availability(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Report whether GitHub Connect is available for this deployment.

    Cheap endpoint the frontend polls on the task source form to decide
    whether to render the Connect button at all.
    """
    user_id = _get_user_id(request)
    _ = _load_project_for_user(session, project_id, user_id)
    config = load_github_config()
    if config is None:
        return {"enabled": False, "client_id": None}
    return {"enabled": True, "client_id": config.client_id}


@router.get("/projects/{project_id}/github/auth-url")
async def get_github_auth_url(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
    next: str | None = Query(default=None),
):
    """Return the GitHub OAuth authorize URL with a signed state token.

    Frontend redirects the top-level window to this URL. GitHub sends
    the user back to ``/v1/github/callback`` which 302's onward to the
    ``next`` dashboard path.
    """
    _require_github_enabled()
    config = load_github_config()
    if config is None:
        raise HTTPException(status_code=503, detail="GitHub OAuth not configured.")

    user_id = _get_user_id(request)
    _ = _load_project_for_user(session, project_id, user_id)

    state = build_signed_state(
        config,
        project_id=project_id,
        next_path=next,
        nonce=secrets.token_urlsafe(16),
    )
    url = build_authorize_url(config, state=state, scopes=DEFAULT_SCOPES)
    return {"url": url}


# ---------------------------------------------------------------------------
# OAuth callback (GitHub redirects here with code + state)
# ---------------------------------------------------------------------------


@router.get("/github/callback")
async def github_callback(
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    error_description: str | None = Query(default=None),
    session: Session = Depends(get_session),
):
    """Handle the GitHub OAuth redirect.

    On success: stores the connection and redirects to the ``next`` path
    (defaults to the project tasks page). On failure: redirects to the
    project tasks page with a ``github_error`` query param so the form
    can render an inline message.
    """
    config = load_github_config()
    if config is None:
        # GitHub somehow called us back without us being configured.
        return RedirectResponse(url=_dashboard_url("/"), status_code=302)

    # If GitHub reported an error (user denied, app suspended, etc.),
    # short-circuit to the dashboard with the error code.
    if error or not code or not state:
        params = {"github_error": error or "unknown_error"}
        if error_description:
            params["github_error_description"] = error_description
        return RedirectResponse(
            url=_dashboard_url(f"/?{urllib.parse.urlencode(params)}"),
            status_code=302,
        )

    signed = verify_signed_state(config, state)
    if signed is None:
        return RedirectResponse(
            url=_dashboard_url("/?github_error=invalid_state"),
            status_code=302,
        )

    project_id = signed.project_id
    next_path = signed.next_path or f"/project/{project_id}/agent-tasks"

    try:
        token_response = exchange_code_for_token(config, code)
        user = fetch_authenticated_user(token_response.access_token)
    except GithubOAuthError as exc:
        params = {"github_error": "exchange_failed", "github_error_description": str(exc)}
        return RedirectResponse(
            url=_dashboard_url(f"{next_path}?{urllib.parse.urlencode(params)}"),
            status_code=302,
        )
    except Exception as exc:  # noqa: BLE001 — surface any HTTP error as a redirect
        params = {"github_error": "exchange_failed", "github_error_description": str(exc)}
        return RedirectResponse(
            url=_dashboard_url(f"{next_path}?{urllib.parse.urlencode(params)}"),
            status_code=302,
        )

    _ = store_connection(
        session,
        project_id=project_id,
        user=user,
        token_response=token_response,
        config=config,
    )

    return RedirectResponse(url=_dashboard_url(next_path), status_code=302)


# ---------------------------------------------------------------------------
# Connection + repos + branches
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/github/connection")
async def get_project_github_connection(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Return the project's GitHub connection, or ``null``."""
    _require_github_enabled()
    user_id = _get_user_id(request)
    _ = _load_project_for_user(session, project_id, user_id)
    conn = get_connection(session, project_id)
    return _serialize_connection(conn) if conn else None


@router.get("/projects/{project_id}/github/repos")
async def list_project_github_repos(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """List the GitHub user's repos using the project's stored token."""
    _require_github_enabled()
    config = load_github_config()
    if config is None:
        raise HTTPException(status_code=503, detail="GitHub OAuth not configured.")

    user_id = _get_user_id(request)
    _ = _load_project_for_user(session, project_id, user_id)

    token = resolve_access_token(session, project_id, config)
    if token is None:
        raise HTTPException(
            status_code=401,
            detail="GitHub account is not connected for this project.",
        )
    try:
        repos = list_user_repos(token)
    except Exception as exc:  # noqa: BLE001 — surface GitHub API errors readably
        raise HTTPException(
            status_code=502, detail=f"GitHub API error: {exc}"
        ) from exc
    return [_serialize_repo(repo) for repo in repos]


@router.get(
    "/projects/{project_id}/github/repos/{owner}/{repo}/branches"
)
async def list_project_github_branches(
    project_id: str,
    owner: str,
    repo: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """List branches for ``owner/repo`` using the project's stored token."""
    _require_github_enabled()
    config = load_github_config()
    if config is None:
        raise HTTPException(status_code=503, detail="GitHub OAuth not configured.")

    user_id = _get_user_id(request)
    _ = _load_project_for_user(session, project_id, user_id)

    token = resolve_access_token(session, project_id, config)
    if token is None:
        raise HTTPException(
            status_code=401,
            detail="GitHub account is not connected for this project.",
        )
    try:
        branches = list_repo_branches(token, owner, repo)
    except Exception as exc:  # noqa: BLE001 — surface GitHub API errors readably
        raise HTTPException(
            status_code=502, detail=f"GitHub API error: {exc}"
        ) from exc
    return [_serialize_branch(branch) for branch in branches]


@router.get(
    "/projects/{project_id}/github/repos/{owner}/{repo}/contents"
)
async def list_project_github_contents(
    project_id: str,
    owner: str,
    repo: str,
    request: Request,
    session: Session = Depends(get_session),
    path: str = Query(default=""),
    ref: str = Query(default=""),
):
    """List entries in ``owner/repo`` at ``path`` on ``ref``.

    Powers the dashboard's folder browser so users can pick a subpath
    visually instead of typing. Returns directories first, then files.
    """
    _require_github_enabled()
    config = load_github_config()
    if config is None:
        raise HTTPException(status_code=503, detail="GitHub OAuth not configured.")

    user_id = _get_user_id(request)
    _ = _load_project_for_user(session, project_id, user_id)

    token = resolve_access_token(session, project_id, config)
    if token is None:
        raise HTTPException(
            status_code=401,
            detail="GitHub account is not connected for this project.",
        )
    try:
        entries = list_repo_path_contents(token, owner, repo, path=path, ref=ref)
    except Exception as exc:  # noqa: BLE001 — surface GitHub API errors readably
        raise HTTPException(
            status_code=502, detail=f"GitHub API error: {exc}"
        ) from exc
    return [_serialize_path_entry(entry) for entry in entries]


def _serialize_path_entry(entry: GithubPathEntry) -> dict[str, object]:
    return {
        "name": entry.name,
        "path": entry.path,
        "type": entry.type,
    }


@router.delete("/projects/{project_id}/github/connection")
async def disconnect_project_github(
    project_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    """Delete the project's GitHub connection."""
    _require_github_enabled()
    user_id = _get_user_id(request)
    _ = _load_project_for_user(session, project_id, user_id)
    deleted = delete_connection(session, project_id)
    return {"ok": True, "deleted": deleted}


# Re-export ``cast`` so type-checkers treat the module-level binding as
# used (the helper is reserved for upcoming batch endpoints).
_ = cast
