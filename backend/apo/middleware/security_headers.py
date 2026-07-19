"""Security headers middleware for the FastAPI backend.

Sets security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
Permissions-Policy, Strict-Transport-Security) on every response, including
error responses from downstream middleware and route handlers.
"""

from collections.abc import Awaitable, Callable
from typing import override

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

_PERMISSION_POLICY_FEATURES: tuple[str, ...] = (
    "geolocation=()",
    "microphone=()",
    "camera=()",
    "payment=()",
    "usb=()",
    "magnetometer=()",
    "gyroscope=()",
    "accelerometer=()",
    "display-capture=()",
)

_PERMISSION_POLICY_HEADER = ", ".join(_PERMISSION_POLICY_FEATURES)
_HSTS_HEADER = "max-age=31536000; includeSubDomains"


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Sets security headers on all backend responses."""

    @override
    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        response = await call_next(request)
        _apply_security_headers(response, request)
        return response


def _apply_security_headers(response: Response, request: Request) -> None:
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = _PERMISSION_POLICY_HEADER

    if _is_https(request):
        response.headers["Strict-Transport-Security"] = _HSTS_HEADER


def _is_https(request: Request) -> bool:
    """Detect HTTPS from forwarded-proto header or request scheme."""
    forwarded_proto = request.headers.get("x-forwarded-proto", "")
    if forwarded_proto:
        return forwarded_proto.split(",")[0].strip() == "https"
    return request.url.scheme == "https"
