"""Authentication middleware for the FastAPI backend.

Intercepts every request and validates either the Auth.js session cookie
(encrypted JWT), a short-lived service bearer token, a persistent Bearer
API key, or a Basic auth public:secret key pair. Sets ``request.state``
attributes that route handlers can read for identity information.
"""

import base64
import binascii
import logging
import os
import re
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import TypeAlias, cast, override

from sqlmodel import Session
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from ..db import engine
from ..models.db import UserDB
from . import AUTH_SECRET, decode_nextauth_token
from .api_key_auth import (
    is_public_key,
    validate_basic_auth,
    validate_bearer_public_key,
    validate_legacy_bearer,
)
from .api_key_tracker import api_key_usage_tracker
from .service_tokens import decode_service_token

logger = logging.getLogger(__name__)

PUBLIC_PATHS: tuple[str, ...] = (
    "/health",
    "/public",
    "/docs",
    "/openapi.json",
    "/redoc",
    "/auth/verify-password",
    "/auth/setup",
    "/auth/has-users",
    "/auth/forgot-password",
    "/auth/reset-password",
    "/auth/verify-email",
    "/auth/resend-verification",
    # SPEC-127: invitation preview + create-account acceptance must be
    # reachable before the invitee has a session. The existing-account
    # acceptance path stays authenticated.
    "/auth/invitations/preview",
    "/auth/invitations/accept/create-account",
    "/v1/api-keys/bootstrap",
)

_COOKIE_NAMES = ("authjs.session-token", "__Secure-authjs.session-token")
_RUN_PATCH_RE = re.compile(r"^/v1/runs/[^/]+$")
# SPEC-130 Track B: a task-run service token may read its own projection.
# The route enforces sub == task_run_id; this guard only allows the path shape.
_TASK_RUN_TRACE_PROJECTION_RE = re.compile(
    r"^/v1/agent-task-runs/[^/]+/trace-projection$"
)
_warned_no_secret = False
AuthContextValue: TypeAlias = str | bool
AuthContext: TypeAlias = dict[str, AuthContextValue]


class AuthMiddleware(BaseHTTPMiddleware):
    """Validates JWT cookies, service tokens, or API keys on every non-public request."""

    @override
    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        path = request.url.path

        if _is_public(path) or request.method == "OPTIONS":
            response = await call_next(request)
            _add_no_cache_headers(response, path)
            return response

        # SPEC-132 Behavior 2: the open-dev bypass is development-only.
        # Release profiles (local/server) with a missing or weak secret
        # fall through to authentication, which fails closed (401).
        if _is_open_dev_bypass_allowed():
            _warn_no_secret()
            return await call_next(request)

        user_info = _authenticate(request)
        if user_info is None:
            return _unauthorized()

        if (
            user_info.get("auth_method") == "service_token"
            and not _service_token_allows_request(request)
        ):
            return _forbidden()

        for key, value in user_info.items():
            setattr(request.state, key, value)

        response = await call_next(request)
        _add_no_cache_headers(response, path)
        return response


def _is_public(path: str) -> bool:
    return any(path == prefix or path.startswith(prefix + "/") for prefix in PUBLIC_PATHS)


def _is_open_dev_bypass_allowed() -> bool:
    """Whether the open-dev (unauthenticated) bypass may be used.

    SPEC-132 Behavior 2: the bypass is allowed ONLY in the ``development``
    profile with an empty ``AUTH_SECRET``. Release profiles (``local``,
    ``server``) must fail closed — a missing or weak secret yields 401s
    on protected routes, never open access.

    We read the profile live (not at module load) so tests and runtime
    env changes are honored. ``AUTH_SECRET`` is module-level (imported
    from ``apo.auth``); a weak secret here means the middleware cannot
    authenticate anyone, so the route must fail closed.
    """
    profile = os.environ.get("APO_DEPLOYMENT_PROFILE", "").strip().lower()
    if profile not in ("", "development"):
        return False
    # Development profile (or unset): allow open-dev only with no secret.
    return (AUTH_SECRET or "") == ""


def _warn_no_secret() -> None:
    global _warned_no_secret
    if not _warned_no_secret:
        logger.warning(
            "AUTH_SECRET not set; running in open dev mode. Set AUTH_SECRET to enable authentication."
        )
        _warned_no_secret = True


def _authenticate(request: Request) -> AuthContext | None:
    # 1. Cookie auth (dashboard) — highest priority
    cookie_token = _get_session_cookie(request)
    if cookie_token:
        cookie_user = _authenticate_cookie(cookie_token)
        if cookie_user is not None:
            return cookie_user

    # 2. Basic auth (two-key model: pk:sk) — full access
    basic_credentials = _get_basic_auth(request)
    if basic_credentials:
        return _authenticate_basic(basic_credentials[0], basic_credentials[1])

    # 3. Bearer auth (public-key ingest, legacy single-key, or service token)
    bearer = _get_bearer_token(request)
    if bearer:
        return _authenticate_bearer(bearer)

    return None


def _get_session_cookie(request: Request) -> str | None:
    for name in _COOKIE_NAMES:
        value = request.cookies.get(name)
        if value:
            return value

        chunked = _read_chunked_cookie(request, name)
        if chunked:
            return chunked

    return None


def _read_chunked_cookie(request: Request, base_name: str) -> str | None:
    chunks: list[tuple[int, str]] = []
    prefix = f"{base_name}."

    for cookie_name, cookie_value in request.cookies.items():
        if not cookie_name.startswith(prefix) or not cookie_value:
            continue

        suffix = cookie_name[len(prefix) :]
        if not suffix.isdigit():
            continue

        chunks.append((int(suffix), cookie_value))

    if not chunks:
        return None

    chunks.sort(key=lambda item: item[0])
    return "".join(value for _, value in chunks)


def _authenticate_cookie(token: str) -> AuthContext | None:
    payload = decode_nextauth_token(token)
    if payload is None:
        return None

    user_id = _extract_user_id(payload)
    if not user_id:
        return None

    with Session(engine) as session:
        user = session.get(UserDB, user_id)
        if user is None or not user.is_active:
            return None

        if user.token_invalid_before is not None:
            token_iat = _extract_token_iat(payload)
            if token_iat is not None and _is_before(token_iat, user.token_invalid_before):
                return None

        return {
            "user_id": user.id,
            "user_email": user.email,
            "auth_method": "cookie",
        }


def _extract_user_id(payload: dict[str, object]) -> str | None:
    sub = payload.get("sub")
    if isinstance(sub, str) and sub:
        return sub

    token_id = payload.get("id")
    if isinstance(token_id, str) and token_id:
        return token_id

    return None


def _extract_token_iat(payload: dict[str, object]) -> datetime | None:
    raw_iat = payload.get("iat")
    if raw_iat is None:
        logger.warning("Token payload missing 'iat' field; skipping token_invalid_before check")
        return None
    if isinstance(raw_iat, (int, float)):
        return datetime.fromtimestamp(raw_iat, tz=timezone.utc)
    if isinstance(raw_iat, str):
        try:
            return datetime.fromtimestamp(float(raw_iat), tz=timezone.utc)
        except ValueError:
            logger.warning("Token payload has unparseable 'iat' value: %s", raw_iat)
            return None
    logger.warning("Token payload has unexpected 'iat' type: %s", type(raw_iat).__name__)
    return None


def _is_before(token_iat: datetime, cutoff: datetime) -> bool:
    iat = token_iat.replace(tzinfo=None) if token_iat.tzinfo is not None else token_iat
    ref = cutoff.replace(tzinfo=None) if cutoff.tzinfo is not None else cutoff
    return iat < ref


def _get_basic_auth(request: Request) -> tuple[str, str] | None:
    """Extract and decode Basic auth credentials from the Authorization header.

    Returns a (public_key, secret_key) tuple if the header contains valid
    Basic auth, None otherwise. Handles malformed input gracefully.
    """
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Basic "):
        return None

    encoded = auth_header[6:].strip()
    try:
        decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None

    if ":" not in decoded:
        return None

    parts = decoded.split(":", 1)
    if len(parts) != 2:
        return None

    public_key, secret_key = parts
    if not public_key or not secret_key:
        return None

    return (public_key, secret_key)


def _authenticate_basic(public_key: str, secret_key: str) -> AuthContext | None:
    """Validate a public:secret key pair sent via Basic auth.

    Grants the key's stored scope (full or ingest).
    """
    with Session(engine) as session:
        api_key = validate_basic_auth(public_key, secret_key, session)
        if api_key is None:
            return None

        if _is_expired(api_key.expires_at):
            return None

        api_key_usage_tracker.record_use(api_key.id, engine)

        return {
            "project": api_key.project,
            "user_id": api_key.created_by,
            "auth_method": "api_key",
            "api_key_scope": api_key.scope,
        }


def _get_bearer_token(request: Request) -> str | None:
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header[7:].strip()
    return token if token else None


def _authenticate_bearer(token: str) -> AuthContext | None:
    service_claims = decode_service_token(token)
    if service_claims is not None:
        return {
            "project": cast(str, service_claims["project"]),
            "service_task_run_id": cast(str, service_claims["sub"]),
            "auth_method": "service_token",
        }

    with Session(engine) as session:
        # Public-key Bearer (pk-apo- prefix): ingest-only scope, forced by auth method
        if is_public_key(token):
            api_key = validate_bearer_public_key(token, session)
            if api_key is None:
                return None

            if _is_expired(api_key.expires_at):
                return None

            api_key_usage_tracker.record_use(api_key.id, engine)

            return {
                "project": api_key.project,
                "user_id": api_key.created_by,
                "auth_method": "api_key",
                "api_key_scope": "ingest",
            }

        # Legacy single-key Bearer (sk-xxx): full scope from key record
        api_key = validate_legacy_bearer(token, session)
        if api_key is None:
            return None

        if _is_expired(api_key.expires_at):
            return None

        api_key_usage_tracker.record_use(api_key.id, engine)

        return {
            "project": api_key.project,
            "user_id": api_key.created_by,
            "auth_method": "api_key",
            "api_key_scope": api_key.scope,
        }


def _is_expired(expires_at: datetime | None) -> bool:
    """Check if an API key has expired based on its expires_at value.

    Returns True if expires_at is set and in the past.
    Expired keys are treated the same as invalid (no info leakage).
    """
    if expires_at is None:
        return False
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    expires_naive = expires_at.replace(tzinfo=None) if expires_at.tzinfo else expires_at
    return expires_naive < now


def _service_token_allows_request(request: Request) -> bool:
    path = request.url.path
    method = request.method.upper()
    if method == "POST" and path == "/api/public/otel/v1/traces":
        return True
    if method == "PATCH" and _RUN_PATCH_RE.match(path) is not None:
        return True
    # SPEC-130 Track B: let a task-run token read its own trace projection.
    return method == "GET" and _TASK_RUN_TRACE_PROJECTION_RE.match(path) is not None


def _unauthorized() -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={"detail": "Authentication required"},
    )


def _forbidden() -> JSONResponse:
    return JSONResponse(
        status_code=403,
        content={"detail": "Not authorized for this route"},
    )


def _add_no_cache_headers(response: Response, path: str) -> None:
    if path.startswith("/auth/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        response.headers["Pragma"] = "no-cache"
