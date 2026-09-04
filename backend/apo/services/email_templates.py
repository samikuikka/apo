"""HTML and plain-text email template renderers.

Styling follows the dashboard identity (docs/design.md): dark monochrome,
sharp corners, white-on-black primary action. Approximate hex equivalents
of the OKLCH tokens, since email clients can't run custom properties.
The Signal Sphere logo is served from the installation's public URL.
"""

from __future__ import annotations

import os

from .runtime_config import get_runtime_config

# Approximations of the dashboard OKLCH tokens for email clients.
_BG = "#000000"  # --background
_CARD = "#101010"  # --card
_BORDER = "#232323"  # --border
_FG = "#ffffff"  # --foreground
_MUTED = "#969696"  # --muted-foreground
_SUCCESS = "#3ecf6f"  # --success (the verdict green)

_LOGO_PATH = "/brand/signal-sphere-small.png"


def _logo_url() -> str:
    """Absolute URL for the brand mark, from the installation's public origin."""
    base = get_runtime_config().public_url or os.environ.get(
        "FRONTEND_URL", "http://localhost:3000"
    )
    return f"{base.rstrip('/')}{_LOGO_PATH}"


def _escape(text: str) -> str:
    """HTML-escape user-provided names interpolated into templates."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _layout(heading: str, body_html: str) -> str:
    """Wraps email content in the shared dark apo shell."""
    return f"""\
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin: 0; padding: 0; background-color: {_BG};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: {_BG};">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px;">
          <tr>
            <td style="padding-bottom: 32px;">
              <a href="{_logo_url()}" style="text-decoration: none;">
                <img src="{_logo_url()}" width="28" height="28" alt="apo" style="display: inline-block; vertical-align: middle; border: 0;">
                <span style="display: inline-block; vertical-align: middle; padding-left: 6px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 16px; font-weight: 600; color: {_FG}; letter-spacing: -0.01em;">apo</span>
              </a>
            </td>
          </tr>
          <tr>
            <td style="background-color: {_CARD}; border: 1px solid {_BORDER}; padding: 40px 40px 36px;">
              <h1 style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 21px; font-weight: 600; color: {_FG}; margin: 0 0 24px;">{heading}</h1>
              {body_html}
            </td>
          </tr>
          <tr>
            <td style="padding-top: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; color: {_MUTED}; text-align: center;">
              apo — turn prompt engineering into data-driven engineering
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


_PARA_STYLE = (
    "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, "
    "sans-serif; font-size: 15px; line-height: 1.6; "
    f"color: {_MUTED}; margin: 0 0 20px;"
)
_NOTE_STYLE = (
    "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, "
    "sans-serif; font-size: 13px; line-height: 1.6; "
    f"color: {_MUTED}; margin: 0;"
)


def _paragraph(text: str) -> str:
    return f'<p style="{_PARA_STYLE}">{text}</p>\n'


def _primary_button(label: str, url: str) -> str:
    """The one white-on-black primary action, sharp-cornered like the dashboard."""
    return (
        '<p style="margin: 32px 0;">\n'
        + f'  <a href="{url}" style="display: inline-block; background-color: {_FG}; '
        + f"color: {_BG}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', "
        + 'Roboto, sans-serif; font-size: 15px; font-weight: 600; text-decoration: none; '
        + f'padding: 12px 32px;">{label}</a>\n'
        + "</p>\n"
    )


def _fallback_link(url: str) -> str:
    return (
        f'<p style="{_PARA_STYLE}font-size: 13px;">'
        f"Or copy and paste this link into your browser:<br>"
        f'<a href="{url}" style="color: {_SUCCESS}; word-break: break-all; text-decoration: none;">{url}</a>'
        f"</p>\n"
    )


def _footer_note(text: str) -> str:
    return f'<p style="{_NOTE_STYLE}">{text}</p>\n'


def render_password_reset_email(
    reset_url: str,
    user_name: str | None,
) -> tuple[str, str]:
    """Returns (html, text) for the password reset email."""
    greeting = f"Hi {_escape(user_name)}," if user_name else "Hello,"

    body = (
        _paragraph(greeting)
        + _paragraph(
            "We received a request to reset your password. Click the button below to set a new password:"
        )
        + _primary_button("Reset password", reset_url)
        + _fallback_link(reset_url)
        + _footer_note(
            "This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email."
        )
    )
    html = _layout("Reset your password", body)

    text = f"""\
Reset your password

{greeting}

We received a request to reset your password. Click the link below to set a new password:

{reset_url}

This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.

apo
"""
    return html, text


def render_verification_email(
    code: str,
    user_name: str | None,
) -> tuple[str, str]:
    """Returns (html, text) for the email verification OTP email."""
    greeting = f"Hi {_escape(user_name)}," if user_name else "Hello,"

    code_block = (
        '<p style="margin: 32px 0; text-align: center;">\n'
        + "  <span style=\"display: inline-block; font-family: 'SF Mono', 'Fira Code', "
        + "'Fira Mono', 'Roboto Mono', monospace; font-size: 30px; font-weight: 600; "
        + f"letter-spacing: 8px; color: {_FG}; background-color: {_BG}; "
        + f'padding: 16px 28px 16px 36px; border-left: 3px solid {_SUCCESS};">{code}</span>\n'
        + "</p>\n"
    )

    body = (
        _paragraph(greeting)
        + _paragraph(
            "Use the code below to verify your email address and activate your account:"
        )
        + code_block
        + _footer_note(
            "This code expires in 10 minutes. If you didn't create an account, you can safely ignore this email."
        )
    )
    html = _layout("Verify your email", body)

    text = f"""\
Verify your email

{greeting}

Use the code below to verify your email address and activate your account:

{code}

This code expires in 10 minutes. If you didn't create an account, you can safely ignore this email.

apo
"""
    return html, text


def render_invitation_email(
    invite_url: str,
    inviter_name: str,
    workspace_name: str,
) -> tuple[str, str]:
    """Returns (html, text) for the user invitation email."""
    intro = (
        f'<strong style="color: {_FG};">{_escape(inviter_name)}</strong> has invited you to join '
        + f'<strong style="color: {_FG};">{_escape(workspace_name)}</strong> on apo.'
    )
    body = (
        _paragraph(intro)
        + _paragraph("Click the button below to get started:")
        + _primary_button("Accept invitation", invite_url)
        + _fallback_link(invite_url)
    )
    html = _layout("You're invited!", body)

    text = f"""\
You're invited!

{inviter_name} has invited you to join {workspace_name} on apo.

Click the link below to get started:

{invite_url}

apo
"""
    return html, text


def render_hosted_access_email(
    invite_url: str,
    inviter_name: str,
) -> tuple[str, str]:
    """Returns (html, text) for the hosted access admission email.

    Truthful about what the invitation is: the recipient creates their
    own apo Project on this installation. It must never claim they are
    joining the issuer's Project.
    """
    intro = (
        f'<strong style="color: {_FG};">{_escape(inviter_name)}</strong> has invited you to apo. '
        + f'Accepting creates <strong style="color: {_FG};">your own Project</strong> on this '
        + "apo installation — a private workspace for your tasks, runs, and evaluations."
    )
    body = (
        _paragraph(intro)
        + _paragraph("Click the button below to get started:")
        + _primary_button("Accept invitation", invite_url)
        + _fallback_link(invite_url)
    )
    html = _layout("You're invited to apo", body)

    text = f"""\
You're invited to apo!

{inviter_name} has invited you to apo. Accepting creates your own Project on this apo installation — a private workspace for your tasks, runs, and evaluations.

Click the link below to get started:

{invite_url}

apo
"""
    return html, text
