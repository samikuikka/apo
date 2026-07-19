"""Tests for SPEC-121 GitHub OAuth crypto + state handling.

Covers the security-sensitive bits without needing real GitHub
credentials: Fernet round-trip, HMAC state signing/verification,
state expiry, malformed-input rejection.
"""

from __future__ import annotations

import json
import time
from base64 import urlsafe_b64decode, urlsafe_b64encode

import pytest
from cryptography.fernet import Fernet, InvalidToken

from apo.services.github_oauth import (
    DEFAULT_SCOPES,
    GITHUB_AUTHORIZE_URL,
    GithubConfig,
    build_authorize_url,
    build_signed_state,
    decrypt_token,
    encrypt_token,
    verify_signed_state,
)


@pytest.fixture
def config() -> GithubConfig:
    return GithubConfig(
        client_id="test-client-id",
        client_secret="test-client-secret",
        redirect_uri="http://localhost:8000/v1/github/callback",
        encryption_key=Fernet.generate_key().decode("utf-8"),
    )


# ---------------------------------------------------------------------------
# Fernet round-trip
# ---------------------------------------------------------------------------


def test_encrypt_decrypt_round_trip(config: GithubConfig) -> None:
    token = "gho_fake_access_token_abc123"
    encrypted = encrypt_token(token, config)
    assert encrypted != token
    assert decrypt_token(encrypted, config) == token


def test_decrypt_rejects_tampered_ciphertext(config: GithubConfig) -> None:
    encrypted = encrypt_token("gho_secret", config)
    tampered = encrypted[:-4] + "AAAA"
    with pytest.raises(InvalidToken):
        decrypt_token(tampered, config)


def test_decrypt_rejects_wrong_key() -> None:
    config_a = GithubConfig(
        client_id="a",
        client_secret="a",
        redirect_uri="a",
        encryption_key=Fernet.generate_key().decode("utf-8"),
    )
    config_b = GithubConfig(
        client_id="b",
        client_secret="b",
        redirect_uri="b",
        encryption_key=Fernet.generate_key().decode("utf-8"),
    )
    encrypted = encrypt_token("gho_secret", config_a)
    with pytest.raises(InvalidToken):
        decrypt_token(encrypted, config_b)


# ---------------------------------------------------------------------------
# Signed state — happy path
# ---------------------------------------------------------------------------


def test_state_round_trip_preserves_payload(config: GithubConfig) -> None:
    state = build_signed_state(
        config,
        project_id="proj-abc",
        next_path="/project/proj-abc/agent-tasks",
        nonce="nonce-123",
    )
    signed = verify_signed_state(config, state)
    assert signed is not None
    assert signed.project_id == "proj-abc"
    assert signed.next_path == "/project/proj-abc/agent-tasks"
    assert signed.nonce == "nonce-123"


def test_authorize_url_contains_state_and_client_id(config: GithubConfig) -> None:
    state = build_signed_state(
        config, project_id="proj-abc", next_path=None, nonce="n"
    )
    url = build_authorize_url(config, state=state, scopes=DEFAULT_SCOPES)
    assert url.startswith(GITHUB_AUTHORIZE_URL)
    assert f"client_id={config.client_id}" in url
    assert f"state={state}" in url
    # URL-encoded but still present
    assert "scope=repo" in url
    assert f"redirect_uri=http%3A%2F%2Flocalhost%3A8000" in url


# ---------------------------------------------------------------------------
# Signed state — failure modes
# ---------------------------------------------------------------------------


def test_state_rejects_bad_signature(config: GithubConfig) -> None:
    state = build_signed_state(
        config, project_id="proj-abc", next_path=None, nonce="n"
    )
    payload_b64, _ = state.rsplit(".", 1)
    forged = f"{payload_b64}.AAAAAAAAAAAAAAAAAAAAAA"
    assert verify_signed_state(config, forged) is None


def test_state_rejects_wrong_secret(config: GithubConfig) -> None:
    other_config = GithubConfig(
        client_id=config.client_id,
        client_secret="different-secret",
        redirect_uri=config.redirect_uri,
        encryption_key=config.encryption_key,
    )
    state = build_signed_state(
        config, project_id="proj-abc", next_path=None, nonce="n"
    )
    # Should fail verification under the different-secret config.
    assert verify_signed_state(other_config, state) is None


def test_state_rejects_expired(config: GithubConfig) -> None:
    """Forge a state with past expiry by bypassing the public builder."""
    payload = {
        "project_id": "proj-abc",
        "nonce": "n",
        "exp": int(time.time()) - 60,  # expired 1 minute ago
        "next": None,
    }
    payload_json = json.dumps(payload, separators=(",", ":"))
    payload_b64 = (
        urlsafe_b64encode(payload_json.encode("utf-8"))
        .rstrip(b"=")
        .decode("utf-8")
    )
    import hmac

    signature = (
        urlsafe_b64encode(
            hmac.new(
                config.client_secret.encode("utf-8"),
                payload_b64.encode("utf-8"),
                "sha256",
            ).digest()
        )
        .rstrip(b"=")
        .decode("utf-8")
    )
    state = f"{payload_b64}.{signature}"
    assert verify_signed_state(config, state) is None


def test_state_rejects_malformed(config: GithubConfig) -> None:
    assert verify_signed_state(config, "") is None
    assert verify_signed_state(config, "no-dot-here") is None
    assert verify_signed_state(config, "aaaa.bbbb.cccc") is None  # extra dots

    # Verify the verify path doesn't blow up on garbage base64 payload.
    assert verify_signed_state(config, "@@@@.bbbb") is None


def test_state_rejects_tampered_payload(config: GithubConfig) -> None:
    """Mutating the payload half of the state invalidates the signature."""
    state = build_signed_state(
        config, project_id="proj-abc", next_path=None, nonce="n"
    )
    payload_b64, signature = state.rsplit(".", 1)
    # Decode payload, change project_id, re-encode.
    padding = "=" * (-len(payload_b64) % 4)
    payload = json.loads(urlsafe_b64decode(payload_b64 + padding).decode("utf-8"))
    payload["project_id"] = "proj-different"
    new_payload_b64 = (
        urlsafe_b64encode(
            json.dumps(payload, separators=(",", ":")).encode("utf-8")
        )
        .rstrip(b"=")
        .decode("utf-8")
    )
    assert verify_signed_state(config, f"{new_payload_b64}.{signature}") is None
