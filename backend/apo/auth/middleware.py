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
    validate_legacy_bearer,
)
from .api_key_tracker import api_key_usage_tracker
from .rate_limit import LoginRateLimiter
from ..services.installation_secrets import auth_secret_problem
from .service_tokens import decode_service_token
from ..services.executor_auth import validate_current_attempt_jwt

logger = logging.getLogger(__name__)

PUBLIC_PATHS: tuple[str, ...] = (
    "/health",
    "/docs",
    "/openapi.json",
    "/redoc",
    # detail-free public readiness probe.
    "/api/public/health",
    "/auth/verify-password",
    "/auth/setup",
    "/auth/has-users",
    # dev sign-in: the DEV_SIGNIN_ENABLED / deployment-profile
    # gate is enforced inside the handlers; the frontend button is cosmetic.
    "/auth/dev-signin",
    "/auth/dev-signin/available",
    "/auth/forgot-password",
    "/auth/reset-password",
    "/auth/verify-email",
    "/auth/resend-verification",
    # invitation preview + create-account acceptance must be
    # reachable before the invitee has a session. The existing-account
    # acceptance path stays authenticated.
    "/auth/invitations/preview",
    "/auth/invitations/accept/create-account",
    # hosted access admission: the bearer token is the
    # authority for preview and new-account acceptance. Existing-account
    # acceptance requires the session before its route runs.
    "/auth/hosted-access/preview",
    "/auth/hosted-access/accept/create-account",
    "/v1/api-keys/bootstrap",
    # CLI first-project bootstrap: authenticates via email + password in the
    # handler (mirrors /v1/api-keys/bootstrap). Must be reachable without a
    # session/API key, otherwise the middleware 401-blocks it before the
    # handler runs and `apo project create` can never succeed.
    "/v1/projects/bootstrap",
    # the executor protocol authenticates itself (one-time enrollment
    # token, long-lived apo_ex_ credential, or task_execution_attempt JWT) inside
    # each handler via Depends. Keeping it out of the user/api-key auth path
    # isolates the protocol's own credential model.
    "/v1/executor-protocol/v1",
    # protocol v2 (source-owned connected executors) uses the same
    # self-authenticating model with its own enrollment token and executor credential.
    "/v1/executor-protocol/v2",
)

_COOKIE_NAMES = ("authjs.session-token", "__Secure-authjs.session-token")
_RUN_PATCH_RE = re.compile(r"^/v1/runs/[^/]+$")
# a task-run service token may read its own projection.
# The route enforces sub == task_run_id; this guard only allows the path shape.
_TASK_RUN_TRACE_PROJECTION_RE = re.compile(
    r"^/v1/agent-task-runs/[^/]+/trace-projection$"
)
# a task-run service token may upload/read its own Deliverables.
# Routes enforce sub == task_run_id and Project ownership; these guards only
# allow the path shapes. The PUT upload route resolves the Task Run through
# the upload row, so it is matched by the opaque upload-id segment.
_TASK_RUN_DELIVERABLES_RE = re.compile(
    r"^/v1/agent-task-runs/[^/]+/(deliverables|artifact-uploads)(/[^/]+)?$"
)
_ARTIFACT_UPLOAD_RE = re.compile(r"^/v1/agent-task-artifact-uploads/[^/]+$")
_TASK_RUN_RESULT_RE = re.compile(r"^/v1/agent-task-runs/[^/]+/result$")
# Public comparison card: returns only view model names for OG image previews.
_COMPARISON_CARD_RE = re.compile(
    r"^/v1/projects/[^/]+/task-view-comparisons/[^/]+/card$"
)

_warned_no_secret = False
AuthContextValue: TypeAlias = str | bool | int | None
AuthContext: TypeAlias = dict[str, AuthContextValue]

# Anonymous demo visitors: when no credential is present and the
# request is a safe read, the middleware mints a synthetic GET-only
# "anonymous" credential. Per-route authorization (viewer-on-demo, 401
# everywhere else) is the real boundary — this is only the outer gate, and
# it stays deliberately dumb: method + kill switch + per-IP rate budget.
_anonymous_demo_limiter = LoginRateLimiter(
    max_attempts=int(os.environ.get("DEMO_ANON_RATE_LIMIT_MAX", "120")),
    window_seconds=int(os.environ.get("DEMO_ANON_RATE_LIMIT_WINDOW_SECONDS", "60")),
)


def _is_demo_enabled() -> bool:
    """APO_DEMO_ENABLED=false removes the demo (and anonymous access) entirely."""
    return os.environ.get("APO_DEMO_ENABLED", "true").strip().lower() not in (
        "false",
        "0",
        "no",
    )


def _authenticate_anonymous_demo(request: Request) -> AuthContext | JSONResponse | None:
    """Mint the anonymous demo credential, a 429 response, or ``None``.

    ``None`` means "not an anonymous demo request" — the caller answers 401
    exactly like any other no-credential request (fail-closed, byte-identical).
    GET/HEAD only; a per-IP sliding window keeps anonymous traffic bounded.
    """
    if request.method.upper() not in ("GET", "HEAD"):
        return None
    if not _is_demo_enabled():
        return None
    # A misconfigured deployment (missing/placeholder/short AUTH_SECRET)
    # fails closed everywhere — the anonymous path must not become the
    # crack that the required AUTH_SECRET check sealed. Read the secret from the environment
    # live (like the profile check) — never from the import-time binding.
    if auth_secret_problem(os.environ.get("AUTH_SECRET", ""), required=True) is not None:
        return None
    client_ip = request.client.host if request.client else "unknown"
    if not _anonymous_demo_limiter.is_allowed(client_ip):
        return JSONResponse(
            status_code=429,
            content={"detail": "Too many requests"},
            headers={"Retry-After": "60"},
        )
    _anonymous_demo_limiter.record_attempt(client_ip)
    return {"auth_method": "anonymous"}



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

        # the open-dev bypass is development-only.
        # Release profiles (local/server) with a missing or weak secret
        # fall through to authentication, which fails closed (401).
        if _is_open_dev_bypass_allowed():
            _warn_no_secret()
            return await call_next(request)

        user_info = _authenticate(request)
        if user_info is None:
            anonymous = _authenticate_anonymous_demo(request)
            if isinstance(anonymous, JSONResponse):
                return anonymous
            user_info = anonymous
            if user_info is None:
                return _unauthorized()

        auth_method = user_info.get("auth_method")
        if auth_method == "service_token" and not _service_token_allows_request(request):
            return _forbidden()
        if auth_method == "attempt_token" and not _attempt_token_allows_request(request):
            return _forbidden()

        for key, value in user_info.items():
            setattr(request.state, key, value)

        response = await call_next(request)
        # API-key usage is bookkeeping, not authentication. Defer its write
        # until the protected handler has finished so it cannot hold or wait
        # on SQLite's single writer while a caller-create request persists its
        # Batch, Run, Revision, and Attempt transaction.
        api_key_id = user_info.get("api_key_id")
        if auth_method == "api_key" and isinstance(api_key_id, str):
            api_key_usage_tracker.record_use(api_key_id, engine)
        _add_no_cache_headers(response, path)
        # Anonymous demo responses are never cacheable (shared caches must
        # not pin demo state that a fixture refresh can replace).
        if auth_method == "anonymous":
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
            response.headers["Pragma"] = "no-cache"
        return response


def _is_public(path: str) -> bool:
    if any(path == prefix or path.startswith(prefix + "/") for prefix in PUBLIC_PATHS):
        return True
    return _COMPARISON_CARD_RE.match(path) is not None


def _is_open_dev_bypass_allowed() -> bool:
    """Whether the open-dev (unauthenticated) bypass may be used.

    Behavior 2: the bypass is allowed ONLY in the ``development``
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

    # 3. Bearer auth (legacy single-key, service token, or attempt token).
    # a Bearer value beginning with ``pk-apo-`` is a public
    # identifier, not secret material. It is rejected here — before any DB
    # lookup, before ``last_used_at`` updates, and before auth-state
    # population — so that the response is indistinguishable from any other
    # invalid credential. The same generic 401 covers unknown identifiers,
    # expired keys, and revoked keys.
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

        return {
            "project": api_key.project,
            "user_id": api_key.created_by,
            "auth_method": "api_key",
            "api_key_scope": api_key.scope,
            "api_key_id": api_key.id,
            # Ingest guardrails — read from the cached row so the
            # existing key-cache invalidation covers quota/pause edits.
            "api_key_daily_quota": api_key.daily_span_quota,
            "api_key_ingest_paused": api_key.ingest_paused,
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
        attempt_auth = validate_current_attempt_jwt(session, token)
        if attempt_auth is not None:
            attempt, _claims = attempt_auth
            return {
                "project": attempt.project,
                "service_task_run_id": attempt.task_run_id,
                "attempt_id": attempt.id,
                "lease_generation": attempt.lease_generation,
                "auth_method": "attempt_token",
            }

        # a public identifier (``pk-apo-*``)
        # is not a credential. Reject it before the legacy secret-token
        # lookup so it does not query by ``public_key``, record
        # ``last_used_at``, or populate authentication state. Returning
        # ``None`` here yields the same generic 401 as an unknown credential.
        if is_public_key(token):
            return None

        # Legacy single-key Bearer (sk-xxx): full scope from key record
        api_key = validate_legacy_bearer(token, session)
        if api_key is None:
            return None

        if _is_expired(api_key.expires_at):
            return None

        return {
            "project": api_key.project,
            "user_id": api_key.created_by,
            "auth_method": "api_key",
            "api_key_scope": api_key.scope,
            "api_key_id": api_key.id,
            # Ingest guardrails — read from the cached row so the
            # existing key-cache invalidation covers quota/pause edits.
            "api_key_daily_quota": api_key.daily_span_quota,
            "api_key_ingest_paused": api_key.ingest_paused,
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
    # let a task-run token read its own trace projection.
    if method == "GET" and _TASK_RUN_TRACE_PROJECTION_RE.match(path) is not None:
        return True
    # let a task-run token manage its own Deliverables and report its
    # final result. The routes enforce sub == task_run_id and Project ownership;
    # this regex allow-list is not authorization.
    if _TASK_RUN_DELIVERABLES_RE.match(path) is not None:
        return True
    if method == "PUT" and _ARTIFACT_UPLOAD_RE.match(path) is not None:
        return True
    if method == "POST" and _TASK_RUN_RESULT_RE.match(path) is not None:
        return True
    return False


def _attempt_token_allows_request(request: Request) -> bool:
    """Confine a live Attempt capability to trace and Artifact transport."""
    path = request.url.path
    method = request.method.upper()
    if method == "POST" and path == "/api/public/otel/v1/traces":
        return True
    # let a live attempt token read its own trace
    # projection — the canonical read-back path the bundled executor's runner
    # polls after flushing its trace. The route enforces sub == task_run_id.
    if method == "GET" and _TASK_RUN_TRACE_PROJECTION_RE.match(path) is not None:
        return True
    if (
        method == "POST"
        and _TASK_RUN_DELIVERABLES_RE.match(path) is not None
        and path.endswith("/artifact-uploads")
    ):
        return True
    return method == "PUT" and _ARTIFACT_UPLOAD_RE.match(path) is not None


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
