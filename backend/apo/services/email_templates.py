"""HTML and plain-text email template renderers."""

from __future__ import annotations


def render_password_reset_email(
    reset_url: str,
    user_name: str | None,
) -> tuple[str, str]:
    """Returns (html, text) for the password reset email."""
    greeting = f"Hi {user_name}," if user_name else "Hello,"

    html = f"""\
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
  <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 24px;">Reset your password</h1>
  <p style="font-size: 15px; line-height: 1.6; color: #4a4a4a;">
    {greeting}
  </p>
  <p style="font-size: 15px; line-height: 1.6; color: #4a4a4a;">
    We received a request to reset your password. Click the button below to set a new password:
  </p>
  <p style="margin: 32px 0;">
    <a href="{reset_url}" style="display: inline-block; background-color: #6366f1; color: #ffffff; font-size: 15px; font-weight: 500; text-decoration: none; padding: 12px 32px; border-radius: 8px;">
      Reset password
    </a>
  </p>
  <p style="font-size: 14px; line-height: 1.6; color: #6b7280;">
    Or copy and paste this link into your browser:<br>
    <a href="{reset_url}" style="color: #6366f1; word-break: break-all;">{reset_url}</a>
  </p>
  <p style="font-size: 14px; line-height: 1.6; color: #6b7280;">
    This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
  </p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;">
  <p style="font-size: 13px; color: #9ca3af;">
    apo
  </p>
</body>
</html>"""

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
    greeting = f"Hi {user_name}," if user_name else "Hello,"

    html = f"""\
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
  <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 24px;">Verify your email</h1>
  <p style="font-size: 15px; line-height: 1.6; color: #4a4a4a;">
    {greeting}
  </p>
  <p style="font-size: 15px; line-height: 1.6; color: #4a4a4a;">
    Use the code below to verify your email address and activate your account:
  </p>
  <p style="margin: 32px 0; text-align: center;">
    <span style="display: inline-block; font-family: 'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace; font-size: 32px; font-weight: 600; letter-spacing: 8px; color: #1a1a1a; background-color: #f3f4f6; padding: 16px 32px; border-radius: 8px;">
      {code}
    </span>
  </p>
  <p style="font-size: 14px; line-height: 1.6; color: #6b7280;">
    This code expires in 10 minutes. If you didn't create an account, you can safely ignore this email.
  </p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;">
  <p style="font-size: 13px; color: #9ca3af;">
    apo
  </p>
</body>
</html>"""

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
    html = f"""\
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
  <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 24px;">You're invited!</h1>
  <p style="font-size: 15px; line-height: 1.6; color: #4a4a4a;">
    <strong>{inviter_name}</strong> has invited you to join <strong>{workspace_name}</strong> on apo.
  </p>
  <p style="font-size: 15px; line-height: 1.6; color: #4a4a4a;">
    Click the button below to get started:
  </p>
  <p style="margin: 32px 0;">
    <a href="{invite_url}" style="display: inline-block; background-color: #6366f1; color: #ffffff; font-size: 15px; font-weight: 500; text-decoration: none; padding: 12px 32px; border-radius: 8px;">
      Accept invitation
    </a>
  </p>
  <p style="font-size: 14px; line-height: 1.6; color: #6b7280;">
    Or copy and paste this link into your browser:<br>
    <a href="{invite_url}" style="color: #6366f1; word-break: break-all;">{invite_url}</a>
  </p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 32px 0;">
  <p style="font-size: 13px; color: #9ca3af;">
    apo
  </p>
</body>
</html>"""

    text = f"""\
You're invited!

{inviter_name} has invited you to join {workspace_name} on apo.

Click the link below to get started:

{invite_url}

apo
"""
    return html, text
