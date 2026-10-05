"""Signed, short-lived avatar URLs for push notifications (PUSH_NOTIFICATIONS.md §16, SECURITY.md).

The iOS Notification Service Extension has no credentials, so a message push carries a URL to the
sender's picture that works without a session: HMAC-SHA256 with SECRET_KEY over (user, avatar
version, expiry). It is scoped to that one picture: a new picture (another version) or a removed
one makes the URL answer 404, and it stops working at its expiry.
"""

import base64
import hashlib
import hmac
import time
import uuid
from datetime import datetime
from urllib.parse import urlencode

LIFETIME_SECONDS = 24 * 3600


def version_of(updated_at: datetime) -> str:
    """The picture's version in a signed URL: avatar_updated_at as whole microseconds (compact)."""
    return str(int(updated_at.timestamp() * 1_000_000))


def _signature(secret: str, user_id: uuid.UUID, version: str, expires: int) -> str:
    # Domain-separated from every other use of SECRET_KEY (access tokens, webhooks…).
    message = f"avatar-push\n{user_id}\n{version}\n{expires}".encode()
    digest = hmac.new(secret.encode(), message, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def signed_path(
    secret: str,
    user_id: uuid.UUID,
    updated_at: datetime,
    *,
    now: float | None = None,
    lifetime: int = LIFETIME_SECONDS,
) -> str:
    """`/api/v1/users/<id>/avatar/signed?v=…&exp=…&sig=…`, valid for `lifetime` seconds."""
    now = time.time() if now is None else now
    version = version_of(updated_at)
    expires = int(now) + lifetime
    query = urlencode(
        {"v": version, "exp": expires, "sig": _signature(secret, user_id, version, expires)}
    )
    return f"/api/v1/users/{user_id}/avatar/signed?{query}"


def verify(
    secret: str,
    user_id: uuid.UUID,
    version: str,
    expires: int,
    signature: str,
    *,
    now: float | None = None,
) -> bool:
    """Whether the signature is this server's for exactly these values and has not expired."""
    now = time.time() if now is None else now
    if not secret or expires < now:
        return False
    expected = _signature(secret, user_id, version, expires)
    return hmac.compare_digest(expected.encode(), signature.encode())
