import hashlib
import hmac
import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import bcrypt
from dotenv import load_dotenv
from jose import JWTError, jwt
from sqlmodel import Session

logger = logging.getLogger(__name__)

# Keep env loading local to the auth module so direct imports and scripts read
# the same backend/.env settings as app startup.
_ = load_dotenv(Path(__file__).resolve().parents[2] / ".env")

AUTH_SECRET = os.environ.get("AUTH_SECRET", "")
if not AUTH_SECRET:
    logger.warning("AUTH_SECRET not set. Auth will be bypassed in development.")

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = int(os.environ.get("AUTH_SESSION_MAX_AGE_DAYS", "7"))

_NEXTAUTH_KEY_LEN = 64
_NEXTAUTH_COOKIE_NAMES = ("authjs.session-token", "__Secure-authjs.session-token")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))


def validate_password_strength(password: str) -> str | None:
    if len(password) < 8:
        return "Password must be at least 8 characters"
    if not re.search(r"[a-zA-Z]", password):
        return "Password must contain at least one letter"
    if not re.search(r"\d", password):
        return "Password must contain at least one number"
    return None


def create_access_token(
    user_id: str,
    email: str,
    is_admin: bool,
    expires_delta: timedelta | None = None,
) -> str:
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    )
    payload: dict[str, object] = {
        "sub": user_id,
        "email": email,
        "is_admin": is_admin,
        "exp": expire,
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, AUTH_SECRET, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict[str, object] | None:
    if not AUTH_SECRET:
        return None
    try:
        return jwt.decode(token, AUTH_SECRET, algorithms=[ALGORITHM])
    except JWTError:
        return None


def decode_nextauth_token(token: str) -> dict[str, object] | None:
    if not AUTH_SECRET:
        return None

    for cookie_name in _NEXTAUTH_COOKIE_NAMES:
        payload = _try_decrypt_nextauth(token, cookie_name)
        if payload is not None:
            return payload
    return None


def _try_decrypt_nextauth(token: str, cookie_name: str) -> dict[str, object] | None:
    from jose import jwe

    info = f"Auth.js Generated Encryption Key ({cookie_name})"
    derived_key = _hkdf_sha256(
        ikm=AUTH_SECRET.encode("utf-8"),
        salt=cookie_name.encode("utf-8"),
        info=info.encode("utf-8"),
        length=_NEXTAUTH_KEY_LEN,
    )
    try:
        plaintext: bytes | None = jwe.decrypt(token.encode("utf-8"), derived_key)
        if plaintext is None:
            return None
        decoded: dict[str, object] = json.loads(plaintext)
        return decoded
    except Exception:
        return None


def _hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    hash_len = hashlib.sha256().digest_size
    if len(salt) == 0:
        salt = bytes(hash_len)
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()

    okm = b""
    prev = b""
    for i in range(1, (length + hash_len - 1) // hash_len + 1):
        prev = hmac.new(prk, prev + info + bytes([i]), hashlib.sha256).digest()
        okm += prev
    return okm[:length]


def validate_redirect_path(path: str) -> str:
    """Validate a redirect path. Returns a safe path or '/' if invalid."""
    if not path:
        return "/"
    cleaned = re.sub(r"[\x00-\x1f\x7f]", "", path).strip()
    if not cleaned:
        return "/"
    if not cleaned.startswith("/"):
        return "/"
    if cleaned.startswith("//") or cleaned.startswith("/\\"):
        return "/"
    lower = cleaned.lower()
    for scheme in ("javascript:", "data:", "vbscript:", "file:"):
        if lower.startswith(scheme) or lower.startswith("/" + scheme):
            return "/"
    return re.sub(r"/{2,}", "/", cleaned)


def validate_frontend_url(url: str) -> str:
    """Validate a FRONTEND_URL-like base URL. Returns it or a safe default."""
    if not url.startswith("http://") and not url.startswith("https://"):
        return "http://localhost:3000"
    return url.rstrip("/")


def invalidate_user_sessions(session: Session, user_id: str) -> None:
    """Set token_invalid_before to now for the given user. All existing JWTs become invalid."""
    from ..models.db import UserDB

    user = session.get(UserDB, user_id)
    if user:
        user.token_invalid_before = datetime.now(timezone.utc)
        session.add(user)
        session.commit()


_dummy_hash: str = hash_password("dummy-timing-safe-value")
