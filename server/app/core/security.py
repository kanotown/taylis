"""Password hashing (argon2id), opaque token helpers and JWT access tokens."""

import asyncio
import hashlib
import secrets
import string
import uuid
from dataclasses import dataclass
from datetime import datetime

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.errors import unauthorized

_hasher = PasswordHasher()
_dummy_hash: str | None = None


def _get_dummy_hash() -> str:
    """A real hash used to equalise timing when the username does not exist."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = _hasher.hash(secrets.token_urlsafe(16))
    return _dummy_hash


async def hash_password(password: str) -> str:
    return await asyncio.to_thread(_hasher.hash, password)


async def verify_password(password_hash: str | None, password: str) -> bool:
    target = password_hash or _get_dummy_hash()

    def _verify() -> bool:
        try:
            return bool(_hasher.verify(target, password))
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return False

    ok = await asyncio.to_thread(_verify)
    return ok and password_hash is not None


def generate_refresh_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode("utf-8")).digest()


_PASSWORD_ALPHABET = string.ascii_letters + string.digits


def generate_temporary_password(length: int = 16) -> str:
    return "".join(secrets.choice(_PASSWORD_ALPHABET) for _ in range(length))


@dataclass(frozen=True)
class AccessClaims:
    user_id: uuid.UUID
    session_id: uuid.UUID


def create_access_token(
    *, user_id: uuid.UUID, session_id: uuid.UUID, secret: str, ttl_seconds: int, now: datetime
) -> str:
    issued = int(now.timestamp())
    payload = {
        "sub": str(user_id),
        "sid": str(session_id),
        "iat": issued,
        "exp": issued + ttl_seconds,
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def decode_access_token(token: str, secret: str) -> AccessClaims:
    try:
        data = jwt.decode(
            token, secret, algorithms=["HS256"], options={"require": ["exp", "iat", "sub", "sid"]}
        )
    except jwt.ExpiredSignatureError as exc:
        raise unauthorized("token_expired", "Access token expired") from exc
    except jwt.InvalidTokenError as exc:
        raise unauthorized("invalid_token", "Invalid access token") from exc
    try:
        return AccessClaims(
            user_id=uuid.UUID(str(data["sub"])), session_id=uuid.UUID(str(data["sid"]))
        )
    except (KeyError, ValueError) as exc:
        raise unauthorized("invalid_token", "Invalid access token") from exc
