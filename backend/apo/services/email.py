# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportImplicitStringConcatenation=false
"""Pluggable email transport service: SMTP, SES, or log-only fallback."""

from __future__ import annotations

import asyncio
import logging
import os
from abc import ABC, abstractmethod
from email.message import EmailMessage
from typing import override
from urllib.parse import ParseResult, unquote, urlparse

logger = logging.getLogger(__name__)


class EmailSendError(Exception):
    """Raised when email delivery fails."""


class EmailService(ABC):
    """Abstract base for email transports."""

    @property
    @abstractmethod
    def is_configured(self) -> bool:
        """True if a real transport is configured (not log-only)."""

    @abstractmethod
    async def send(
        self,
        to: str,
        subject: str,
        html: str,
        text: str | None = None,
    ) -> None:
        """Send an email. Raises EmailSendError on failure."""


class LogOnlyEmailService(EmailService):
    """Dev fallback: logs email content to stdout."""

    @property
    @override
    def is_configured(self) -> bool:
        return False

    @override
    async def send(
        self,
        to: str,
        subject: str,
        html: str,
        text: str | None = None,
    ) -> None:
        logger.info("=== Email (log-only, not sent) ===")
        logger.info("To: %s", to)
        logger.info("Subject: %s", subject)
        logger.info("Body:\n%s", text if text else html)
        logger.info("=== End Email ===")


class SMTPEmailService(EmailService):
    """SMTP transport using aiosmtplib."""

    _host: str
    _port: int
    _username: str | None
    _password: str | None
    _use_tls: bool
    _start_tls: bool
    _timeout: int
    _from_address: str
    _from_name: str

    def __init__(
        self,
        host: str,
        port: int,
        username: str | None,
        password: str | None,
        use_tls: bool,
        start_tls: bool,
        timeout: int,
        from_address: str,
        from_name: str,
    ) -> None:
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._use_tls = use_tls
        self._start_tls = start_tls
        self._timeout = timeout
        self._from_address = from_address
        self._from_name = from_name

    @property
    @override
    def is_configured(self) -> bool:
        return True

    @override
    async def send(
        self,
        to: str,
        subject: str,
        html: str,
        text: str | None = None,
    ) -> None:
        msg = EmailMessage()
        msg["From"] = _format_from_header(self._from_name, self._from_address)
        msg["To"] = to
        msg["Subject"] = subject
        if text:
            msg.set_content(text)
            msg.add_alternative(html, subtype="html")
        else:
            msg.set_content(html, subtype="html")

        try:
            import aiosmtplib

            _ = await aiosmtplib.send(
                msg,
                hostname=self._host,
                port=self._port,
                username=self._username,
                password=self._password,
                use_tls=self._use_tls,
                start_tls=self._start_tls,
                timeout=self._timeout,
            )
        except Exception as exc:
            raise EmailSendError(f"SMTP send failed: {exc}") from exc


class SESEmailService(EmailService):
    """AWS SES transport using boto3 (optional dependency)."""

    _region: str
    _from_address: str
    _from_name: str

    def __init__(self, region: str, from_address: str, from_name: str) -> None:
        self._region = region
        self._from_address = from_address
        self._from_name = from_name

    @property
    @override
    def is_configured(self) -> bool:
        return True

    @override
    async def send(
        self,
        to: str,
        subject: str,
        html: str,
        text: str | None = None,
    ) -> None:
        try:
            import boto3
        except ImportError as exc:
            raise EmailSendError("boto3 is not installed") from exc

        client = boto3.client("ses", region_name=self._region)
        body: dict[str, dict[str, str]] = {"Html": {"Data": html}}
        if text:
            body["Text"] = {"Data": text}

        try:
            await asyncio.to_thread(
                client.send_email,
                Source=_format_from_header(self._from_name, self._from_address),
                Destination={"ToAddresses": [to]},
                Message={
                    "Subject": {"Data": subject},
                    "Body": body,
                },
            )
        except Exception as exc:
            raise EmailSendError(f"SES send failed: {exc}") from exc


def _format_from_header(name: str, address: str) -> str:
    """Format a From header, including display name when available."""
    if name:
        return f"{name} <{address}>"
    return address


_service: EmailService = LogOnlyEmailService()


def init_email_service() -> None:
    """Initialize the email service from environment variables.

    Called at app startup. Falls back to LogOnlyEmailService on any error.
    """
    global _service

    transport_url = os.environ.get("EMAIL_TRANSPORT_URL", "").strip()
    from_address = os.environ.get("EMAIL_FROM_ADDRESS", "").strip()
    from_name = os.environ.get("EMAIL_FROM_NAME", "apo").strip()

    if not transport_url:
        logger.info("EMAIL_TRANSPORT_URL not set, using log-only email service")
        _service = LogOnlyEmailService()
        return

    if not from_address:
        logger.warning(
            "EMAIL_TRANSPORT_URL set but EMAIL_FROM_ADDRESS missing,"
            " falling back to log-only email service"
        )
        _service = LogOnlyEmailService()
        return

    parsed = urlparse(transport_url)
    scheme = parsed.scheme.lower()

    if scheme == "smtp":
        _service = _build_smtp_service(parsed, from_address, from_name)
    elif scheme == "ses":
        _service = _build_ses_service(parsed, from_address, from_name)
    else:
        logger.warning(
            "Unknown email transport scheme '%s', falling back to log-only",
            scheme,
        )
        _service = LogOnlyEmailService()


def _build_smtp_service(
    parsed: ParseResult,
    from_address: str,
    from_name: str,
) -> EmailService:
    host = parsed.hostname
    port = parsed.port or 587

    if not host:
        logger.warning("SMTP URL has no host, falling back to log-only")
        return LogOnlyEmailService()

    username = unquote(parsed.username) if parsed.username else None
    password = unquote(parsed.password) if parsed.password else None

    tls_env = os.environ.get("EMAIL_SMTP_TLS", "").strip().lower()
    if tls_env == "false":
        use_tls = False
        start_tls = False
    elif tls_env == "true":
        use_tls = port == 465
        start_tls = port != 465
    else:
        use_tls = port == 465
        start_tls = port == 587

    timeout = int(os.environ.get("EMAIL_SMTP_TIMEOUT", "30"))

    logger.info("SMTP email service configured: %s:%d", host, port)
    return SMTPEmailService(
        host=host,
        port=port,
        username=username,
        password=password,
        use_tls=use_tls,
        start_tls=start_tls,
        timeout=timeout,
        from_address=from_address,
        from_name=from_name,
    )


def _build_ses_service(
    parsed: ParseResult,
    from_address: str,
    from_name: str,
) -> EmailService:
    region = parsed.hostname or ""

    if not region:
        logger.warning("SES URL has no region, falling back to log-only")
        return LogOnlyEmailService()

    try:
        import boto3  # noqa: F401  # pyright: ignore[reportUnusedImport]
    except ImportError:
        logger.warning(
            "SES transport requested but boto3 not installed,"
            " falling back to log-only"
        )
        return LogOnlyEmailService()

    logger.info("SES email service configured: region=%s", region)
    return SESEmailService(
        region=region,
        from_address=from_address,
        from_name=from_name,
    )


def get_email_service() -> EmailService:
    """Returns the configured singleton email service instance."""
    return _service
