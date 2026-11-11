"""Keep bearer tokens out of the access log.

Invitation previews take their token in the query string
(``/auth/hosted-access/preview?token=...``), and uvicorn's access log
records the whole request line. Unredacted, every link an invitee opens
would be written to the server log while it can still be accepted, which
turns read access to logs into the ability to create accounts. For a
self-serve invitation that link is meant to exist in one inbox and
nowhere else.

The value is replaced in the log record itself, so it holds for whatever
handler or formatter the deployment attaches. A reverse proxy in front of
apo keeps its own access log and needs its own redaction: this covers
only what the backend process writes.
"""

from __future__ import annotations

import logging
import re
from typing import override

_ACCESS_LOGGER = "uvicorn.access"
# A ``token`` query parameter, at the start of the query or after ``&``.
# Anchoring on the separator leaves ``tokens=5`` and path segments alone.
_TOKEN_QUERY = re.compile(r"(?<=[?&]token=)[^&\s]+")
_REDACTED = "[redacted]"


class RedactTokenQueryFilter(logging.Filter):
    """Replace ``token`` query values in an access-log record's arguments."""

    @override
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(
                _TOKEN_QUERY.sub(_REDACTED, arg) if isinstance(arg, str) else arg
                for arg in record.args
            )
        return True


def install_access_log_redaction() -> None:
    """Attach the redaction to uvicorn's access logger. Idempotent."""
    access_logger = logging.getLogger(_ACCESS_LOGGER)
    if not any(isinstance(f, RedactTokenQueryFilter) for f in access_logger.filters):
        access_logger.addFilter(RedactTokenQueryFilter())


__all__ = ["RedactTokenQueryFilter", "install_access_log_redaction"]
