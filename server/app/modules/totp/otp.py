"""RFC 6238 time-based one-time passwords (SHA-1, 6 digits, 30 s), with no dependency beyond
the QR image. Every authenticator app (Google Authenticator, 1Password, Aegis, ...) uses these
defaults; the provisioning URI is the de facto `otpauth://` format."""

import base64
import hashlib
import hmac
import io
import secrets
import string
import struct
from datetime import UTC, datetime
from urllib.parse import quote

import qrcode

DIGITS = 6
PERIOD_SECONDS = 30
WINDOW = 1  # steps of clock skew tolerated on either side
__all__ = ["UTC", "datetime"]  # re-exported for tests that build timestamps
_RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/o, 1/l/i confusion


def generate_secret() -> bytes:
    return secrets.token_bytes(20)


def base32(secret: bytes) -> str:
    return base64.b32encode(secret).decode("ascii").rstrip("=")


def hotp(secret: bytes, counter: int, digits: int = DIGITS) -> str:
    digest = hmac.new(secret, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF
    return str(value % (10**digits)).zfill(digits)


def step_at(now: datetime) -> int:
    return int(now.timestamp()) // PERIOD_SECONDS


def matching_step(secret: bytes, code: str, now: datetime) -> int | None:
    """The step whose code equals `code` within the skew window, else None."""
    current = step_at(now)
    for delta in range(-WINDOW, WINDOW + 1):
        step = current + delta
        if hmac.compare_digest(hotp(secret, step), code):
            return step
    return None


def normalize_code(code: str) -> str:
    return code.strip().replace(" ", "")


def is_totp_shape(code: str) -> bool:
    return len(code) == DIGITS and code.isdigit()


def provisioning_uri(secret: bytes, username: str, issuer: str) -> str:
    label = quote(f"{issuer}:{username}", safe=":")
    return (
        f"otpauth://totp/{label}?secret={base32(secret)}&issuer={quote(issuer)}"
        f"&algorithm=SHA1&digits={DIGITS}&period={PERIOD_SECONDS}"
    )


def qr_png(text: str) -> bytes:
    image = qrcode.make(text, box_size=6, border=2)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def recovery_codes(count: int = 8) -> list[str]:
    """One-time codes shown once, shaped `xxxxx-xxxxx`."""
    out: list[str] = []
    for _ in range(count):
        raw = "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(10))
        out.append(f"{raw[:5]}-{raw[5:]}")
    return out


def normalize_recovery(code: str) -> str:
    return "".join(ch for ch in code.lower() if ch in string.ascii_lowercase + string.digits)
