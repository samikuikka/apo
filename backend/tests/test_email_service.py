# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportMissingImports=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportAttributeAccessIssue=false, reportCallIssue=false, reportUntypedFunctionDecorator=false, reportUnannotatedClassAttribute=false, reportUnknownLambdaType=false, reportUnusedParameter=false

import importlib.util

from unittest.mock import AsyncMock, patch

import pytest

from apo.services.email import (
    EmailSendError,
    EmailService,
    LogOnlyEmailService,
    SESEmailService,
    SMTPEmailService,
    get_email_service,
    init_email_service,
)
from apo.services.email_templates import (
    render_invitation_email,
    render_password_reset_email,
)


# ---- Environment helpers ----

_EMAIL_ENV_KEYS = [
    "EMAIL_TRANSPORT_URL",
    "EMAIL_FROM_ADDRESS",
    "EMAIL_FROM_NAME",
    "EMAIL_SMTP_TLS",
    "EMAIL_SMTP_TIMEOUT",
]


@pytest.fixture(autouse=True)
def clean_email_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove all email env vars and reset the singleton before each test."""
    for key in _EMAIL_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    import apo.services.email as email_mod

    email_mod._service = LogOnlyEmailService()


# ---- Template tests ----


class TestPasswordResetTemplate:
    def test_html_contains_reset_url(self) -> None:
        url = "http://app.example.com/reset-password?token=abc123"
        html, _ = render_password_reset_email(url, "Alice")
        assert url in html

    def test_text_contains_reset_url(self) -> None:
        url = "http://app.example.com/reset-password?token=abc123"
        _, text = render_password_reset_email(url, "Alice")
        assert url in text

    def test_html_contains_user_name(self) -> None:
        html, _ = render_password_reset_email("http://app/reset?token=x", "Alice")
        assert "Alice" in html

    def test_text_contains_user_name(self) -> None:
        _, text = render_password_reset_email("http://app/reset?token=x", "Alice")
        assert "Alice" in text

    def test_generic_greeting_when_name_is_none(self) -> None:
        html, text = render_password_reset_email("http://app/reset?token=x", None)
        assert "Hello," in html
        assert "Hello," in text

    def test_generic_greeting_when_name_is_empty(self) -> None:
        html, text = render_password_reset_email("http://app/reset?token=x", "")
        assert "Hello," in html
        assert "Hello," in text

    def test_returns_tuple_of_two_strings(self) -> None:
        result = render_password_reset_email("http://app/reset?token=x", "Bob")
        assert isinstance(result, tuple)
        assert len(result) == 2
        assert all(isinstance(part, str) for part in result)


class TestInvitationTemplate:
    def test_html_contains_invite_url(self) -> None:
        url = "http://app.example.com/invite?token=xyz"
        html, _ = render_invitation_email(url, "Admin", "My Workspace")
        assert url in html

    def test_text_contains_invite_url(self) -> None:
        url = "http://app.example.com/invite?token=xyz"
        _, text = render_invitation_email(url, "Admin", "My Workspace")
        assert url in text

    def test_html_contains_inviter_name(self) -> None:
        html, _ = render_invitation_email("http://invite", "Alice", "Workspace")
        assert "Alice" in html

    def test_html_contains_workspace_name(self) -> None:
        html, _ = render_invitation_email("http://invite", "Alice", "Acme Corp")
        assert "Acme Corp" in html

    def test_text_contains_workspace_name(self) -> None:
        _, text = render_invitation_email("http://invite", "Alice", "Acme Corp")
        assert "Acme Corp" in text


# ---- LogOnlyEmailService tests ----


class TestLogOnlyEmailService:
    def test_is_not_configured(self) -> None:
        svc = LogOnlyEmailService()
        assert svc.is_configured is False

    @pytest.mark.asyncio
    async def test_send_logs_content(self) -> None:
        svc = LogOnlyEmailService()
        with patch("apo.services.email.logger") as mock_logger:
            await svc.send(
                to="user@test.com",
                subject="Test Subject",
                html="<p>Hello</p>",
                text="Hello",
            )
            log_calls = [str(call) for call in mock_logger.info.call_args_list]
            assert any("user@test.com" in c for c in log_calls)
            assert any("Test Subject" in c for c in log_calls)
            assert any("Hello" in c for c in log_calls)

    @pytest.mark.asyncio
    async def test_send_logs_html_when_no_text(self) -> None:
        svc = LogOnlyEmailService()
        with patch("apo.services.email.logger") as mock_logger:
            await svc.send(
                to="user@test.com",
                subject="Subject",
                html="<p>HTML body</p>",
            )
            log_calls = [str(call) for call in mock_logger.info.call_args_list]
            assert any("HTML body" in c for c in log_calls)


# ---- SMTP service tests ----


class TestSMTPEmailService:
    def test_is_configured(self) -> None:
        svc = SMTPEmailService(
            host="smtp.test.com",
            port=587,
            username="user",
            password="pass",
            use_tls=False,
            start_tls=True,
            timeout=30,
            from_address="noreply@test.com",
            from_name="Test",
        )
        assert svc.is_configured is True

    @pytest.mark.asyncio
    async def test_send_calls_aiosmtplib(self) -> None:
        svc = SMTPEmailService(
            host="smtp.test.com",
            port=587,
            username="user",
            password="pass",
            use_tls=False,
            start_tls=True,
            timeout=30,
            from_address="noreply@test.com",
            from_name="Test",
        )
        with patch("aiosmtplib.send", new_callable=AsyncMock) as mock_send:
            await svc.send(
                to="user@test.com",
                subject="Test",
                html="<p>Hello</p>",
                text="Hello",
            )
            mock_send.assert_called_once()
            call_kwargs = mock_send.call_args
            assert call_kwargs.kwargs["hostname"] == "smtp.test.com"
            assert call_kwargs.kwargs["port"] == 587
            assert call_kwargs.kwargs["username"] == "user"
            assert call_kwargs.kwargs["start_tls"] is True

    @pytest.mark.asyncio
    async def test_send_raises_on_failure(self) -> None:
        svc = SMTPEmailService(
            host="smtp.test.com",
            port=587,
            username="user",
            password="pass",
            use_tls=False,
            start_tls=True,
            timeout=30,
            from_address="noreply@test.com",
            from_name="Test",
        )
        with patch("aiosmtplib.send", new_callable=AsyncMock) as mock_send:
            mock_send.side_effect = ConnectionRefusedError("Connection refused")
            with pytest.raises(EmailSendError, match="SMTP send failed"):
                await svc.send(
                    to="user@test.com",
                    subject="Test",
                    html="<p>Hello</p>",
                )


# ---- SES service tests ----


_boto3_available = importlib.util.find_spec("boto3") is not None


class _FakeSESClient:
    """Mock SES client for testing."""

    def __init__(self, *, fail: bool = False) -> None:
        self._fail = fail

    def send_email(self, **kwargs: object) -> dict[str, str]:
        if self._fail:
            raise Exception("SES error")
        return {"MessageId": "test-123"}


class TestSESEmailService:
    def test_is_configured(self) -> None:
        svc = SESEmailService(
            region="us-east-1",
            from_address="noreply@test.com",
            from_name="Test",
        )
        assert svc.is_configured is True

    @pytest.mark.asyncio
    async def test_send_raises_when_boto3_not_installed(self) -> None:
        svc = SESEmailService(
            region="us-east-1",
            from_address="noreply@test.com",
            from_name="Test",
        )
        with patch.dict("sys.modules", {"boto3": None}):
            with pytest.raises(EmailSendError, match="boto3 is not installed"):
                await svc.send(
                    to="user@test.com",
                    subject="Test",
                    html="<p>Hello</p>",
                )

    @pytest.mark.skipif(not _boto3_available, reason="boto3 not installed")
    @pytest.mark.asyncio
    async def test_send_calls_boto3(self) -> None:
        svc = SESEmailService(
            region="us-east-1",
            from_address="noreply@test.com",
            from_name="Test",
        )
        with patch("boto3.client", return_value=_FakeSESClient()):
            await svc.send(
                to="user@test.com",
                subject="Test",
                html="<p>Hello</p>",
                text="Hello",
            )

    @pytest.mark.skipif(not _boto3_available, reason="boto3 not installed")
    @pytest.mark.asyncio
    async def test_send_raises_on_boto3_failure(self) -> None:
        svc = SESEmailService(
            region="us-east-1",
            from_address="noreply@test.com",
            from_name="Test",
        )
        with patch("boto3.client", return_value=_FakeSESClient(fail=True)):
            with pytest.raises(EmailSendError, match="SES send failed"):
                await svc.send(
                    to="user@test.com",
                    subject="Test",
                    html="<p>Hello</p>",
                )


# ---- init_email_service tests ----


class TestInitEmailService:
    def test_no_env_uses_log_only(self) -> None:
        init_email_service()
        svc = get_email_service()
        assert isinstance(svc, LogOnlyEmailService)
        assert svc.is_configured is False

    def test_smtp_url_creates_smtp_service(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(
            "EMAIL_TRANSPORT_URL", "smtp://user:pass@smtp.example.com:587"
        )
        monkeypatch.setenv("EMAIL_FROM_ADDRESS", "noreply@example.com")
        init_email_service()
        svc = get_email_service()
        assert isinstance(svc, SMTPEmailService)

    def test_ses_url_creates_ses_service(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("EMAIL_TRANSPORT_URL", "ses://us-east-1")
        monkeypatch.setenv("EMAIL_FROM_ADDRESS", "noreply@example.com")
        init_email_service()
        svc = get_email_service()
        if _boto3_available:
            assert isinstance(svc, SESEmailService)
        else:
            assert isinstance(svc, LogOnlyEmailService)

    def test_missing_from_address_falls_back(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(
            "EMAIL_TRANSPORT_URL", "smtp://user:pass@smtp.example.com:587"
        )
        monkeypatch.delenv("EMAIL_FROM_ADDRESS", raising=False)
        init_email_service()
        svc = get_email_service()
        assert isinstance(svc, LogOnlyEmailService)

    def test_unknown_scheme_falls_back(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("EMAIL_TRANSPORT_URL", "foo://bar")
        monkeypatch.setenv("EMAIL_FROM_ADDRESS", "noreply@example.com")
        init_email_service()
        svc = get_email_service()
        assert isinstance(svc, LogOnlyEmailService)

    def test_malformed_smtp_falls_back(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("EMAIL_TRANSPORT_URL", "smtp://")
        monkeypatch.setenv("EMAIL_FROM_ADDRESS", "noreply@example.com")
        init_email_service()
        svc = get_email_service()
        assert isinstance(svc, LogOnlyEmailService)

    def test_smtp_port_465_uses_implicit_tls(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(
            "EMAIL_TRANSPORT_URL", "smtp://user:pass@smtp.example.com:465"
        )
        monkeypatch.setenv("EMAIL_FROM_ADDRESS", "noreply@example.com")
        init_email_service()
        svc = get_email_service()
        assert isinstance(svc, SMTPEmailService)
        assert svc._use_tls is True
        assert svc._start_tls is False

    def test_smtp_port_587_uses_starttls(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(
            "EMAIL_TRANSPORT_URL", "smtp://user:pass@smtp.example.com:587"
        )
        monkeypatch.setenv("EMAIL_FROM_ADDRESS", "noreply@example.com")
        init_email_service()
        svc = get_email_service()
        assert isinstance(svc, SMTPEmailService)
        assert svc._use_tls is False
        assert svc._start_tls is True

    def test_smtp_tls_false_disables_tls(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(
            "EMAIL_TRANSPORT_URL", "smtp://user:pass@smtp.example.com:587"
        )
        monkeypatch.setenv("EMAIL_FROM_ADDRESS", "noreply@example.com")
        monkeypatch.setenv("EMAIL_SMTP_TLS", "false")
        init_email_service()
        svc = get_email_service()
        assert isinstance(svc, SMTPEmailService)
        assert svc._use_tls is False
        assert svc._start_tls is False

    def test_from_name_defaults_to_apo(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(
            "EMAIL_TRANSPORT_URL", "smtp://user:pass@smtp.example.com:587"
        )
        monkeypatch.setenv("EMAIL_FROM_ADDRESS", "noreply@example.com")
        monkeypatch.delenv("EMAIL_FROM_NAME", raising=False)
        init_email_service()
        svc = get_email_service()
        assert isinstance(svc, SMTPEmailService)
        assert svc._from_name == "apo"


# ---- Integration: forgot-password with email ----


class TestForgotPasswordEmailIntegration:
    def test_email_service_is_called_on_forgot_password(
        self, client: object
    ) -> None:
        from fastapi.testclient import TestClient

        assert isinstance(client, TestClient)
        client.post(
            "/auth/setup",
            json={
                "email": "admin@test.com",
                "password": "SecurePass123",
                "name": "Admin",
            },
        )

        mock_service = AsyncMock(spec=EmailService)
        mock_service.send = AsyncMock()
        with patch(
            "apo.routes.auth.get_email_service", return_value=mock_service
        ):
            resp = client.post(
                "/auth/forgot-password",
                json={"email": "admin@test.com"},
            )

        assert resp.status_code == 200
        mock_service.send.assert_called_once()
        call_kwargs = mock_service.send.call_args
        assert call_kwargs.kwargs["to"] == "admin@test.com"
        assert "reset" in call_kwargs.kwargs["subject"].lower()

    def test_email_failure_does_not_change_response(
        self, client: object
    ) -> None:
        from fastapi.testclient import TestClient

        assert isinstance(client, TestClient)
        client.post(
            "/auth/setup",
            json={
                "email": "admin@test.com",
                "password": "SecurePass123",
                "name": "Admin",
            },
        )

        mock_service = AsyncMock(spec=EmailService)
        mock_service.send = AsyncMock(side_effect=EmailSendError("SMTP down"))
        with patch(
            "apo.routes.auth.get_email_service", return_value=mock_service
        ):
            resp = client.post(
                "/auth/forgot-password",
                json={"email": "admin@test.com"},
            )

        assert resp.status_code == 200
        assert "reset link has been sent" in resp.json()["message"]
