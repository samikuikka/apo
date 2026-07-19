"""Short-lived service bearer tokens for agent task trace ingestion.

These tokens allow the example-service (or similar) to ingest traces and
update runs without a full user session cookie. They are JWTs signed with
the same ``AUTH_SECRET`` used by the rest of the auth system.
"""

import logging
import os
from datetime import datetime, timedelta, timezone

from jose import JWTError, jwt

logger = logging.getLogger(__name__)

ALGORITHM = "HS256"
TOKEN_TTL_MINUTES = 15

_AGENT_TASK_TRACE_PERMISSIONS = ("trace:ingest", "trace:complete", "trace:read-own")

AUTH_SECRET = os.environ.get("AUTH_SECRET", "")
if not AUTH_SECRET:
    logger.warning("AUTH_SECRET not set. Service tokens will not be issued.")


def create_agent_task_trace_token(
    *,
    task_run_id: str,
    project: str,
    expires_in_seconds: int = TOKEN_TTL_MINUTES * 60,
) -> str:
    """Create a short-lived service token for agent task trace ingestion."""
    expire = datetime.now(timezone.utc) + timedelta(seconds=expires_in_seconds)
    payload: dict[str, object] = {
        "sub": task_run_id,
        "project": project,
        "typ": "agent_task_trace",
        "permissions": list(_AGENT_TASK_TRACE_PERMISSIONS),
        "exp": expire,
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, AUTH_SECRET, algorithm=ALGORITHM)


def decode_service_token(token: str) -> dict[str, object] | None:
    """Decode and validate a service bearer token.

    Returns the token claims if valid, ``None`` otherwise.
    """
    if not AUTH_SECRET:
        return None
    try:
        payload: dict[str, object] = jwt.decode(token, AUTH_SECRET, algorithms=[ALGORITHM])
    except JWTError:
        return None

    if payload.get("typ") != "agent_task_trace":
        return None

    return payload
