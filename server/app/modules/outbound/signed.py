"""Signed HTTP requests to outside systems: the 在室状況 webhooks (docs/PRESENCE.md §5) and the
操作ボタン relays (docs/ACTIONS.md §5) share this one sender.

Signing: X-Taylis-Signature: sha256=hex(HMAC-SHA256(key, timestamp + "." + body)); the key is a
file in a secrets folder, read at each send (never stored in the DB).

Sending: https and public addresses only (the link previews' SSRF check on the shape and on the
DNS answer at each send) unless the dev flag allows private targets; no redirects; one bound on the
whole send (DNS check, connect, request, answer) — httpx's own timeout is per read, so an answer
that trickles in a byte at a time would otherwise hold the caller for good; the answer's body is
read only up to a bounded prefix.
"""

import asyncio
import hashlib
import hmac
import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from app.core.time import utcnow
from app.modules.link_previews.fetcher import PreviewError, validate_public_url

SECRET_MIN_BYTES = 16


def body_bytes(body: dict[str, Any]) -> bytes:
    """The exact bytes sent (and signed): compact JSON, keys sorted, UTF-8."""
    return json.dumps(body, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


def signature(secret: bytes, timestamp: int, body: bytes) -> str:
    digest = hmac.new(secret, str(timestamp).encode() + b"." + body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def read_secret(folder: str, name: str | None) -> bytes | None:
    """The signing key in `folder/name`, or None when the name is empty, the file is missing or
    the key is shorter than SECRET_MIN_BYTES (after trimming whitespace)."""
    if not name or "/" in name or name.startswith("."):
        return None
    try:
        value = (Path(folder) / name).read_bytes().strip()
    except OSError:
        return None
    return value if len(value) >= SECRET_MIN_BYTES else None


def signed_headers(
    event: str, delivery_id: uuid.UUID, secret: bytes, body: bytes, *, user_agent: str
) -> dict[str, str]:
    timestamp = int(utcnow().timestamp())
    return {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": user_agent,
        "X-Taylis-Event": event,
        "X-Taylis-Delivery": str(delivery_id),
        "X-Taylis-Timestamp": str(timestamp),
        "X-Taylis-Signature": signature(secret, timestamp, body),
    }


@dataclass(frozen=True)
class Answer:
    """What came back: the status (None when nothing did, with `error` saying why) and up to the
    asked prefix of the body."""

    status_code: int | None
    error: str | None = None
    body: bytes = b""
    encoding: str = "utf-8"

    @property
    def ok(self) -> bool:
        return self.status_code is not None and 200 <= self.status_code < 300

    def text(self, limit: int) -> str:
        try:
            decoded = self.body.decode(self.encoding, errors="replace")
        except LookupError:  # a charset Python does not know
            decoded = self.body.decode("utf-8", errors="replace")
        return decoded[:limit]


# url, headers, body -> answer.
Poster = Callable[[str, dict[str, str], bytes], Awaitable[Answer]]


def build_poster(
    *,
    timeout: float,
    allow_private: bool,
    success_body_bytes: int,
    error_body_bytes: int,
    transport: httpx.AsyncBaseTransport | None = None,
) -> Poster:
    """POSTs with httpx under one `timeout` for the whole send. Reads at most
    `success_body_bytes` of a 2xx answer's body (0: not read at all) and `error_body_bytes` of
    any other's. A refused target is `Answer(None, "url_not_allowed")` (or the check's code)."""

    async def read_prefix(response: httpx.Response, limit: int) -> bytes:
        if limit <= 0:
            return b""
        prefix = bytearray()
        async for chunk in response.aiter_bytes():
            prefix += chunk
            if len(prefix) >= limit:
                break
        return bytes(prefix[:limit])

    async def post(url: str, headers: dict[str, str], body: bytes) -> Answer:
        if not allow_private:
            if not url.startswith("https://"):
                return Answer(None, "url_not_allowed")
            try:
                await validate_public_url(url)
            except PreviewError as exc:
                return Answer(None, exc.code)
        try:
            async with (
                httpx.AsyncClient(
                    follow_redirects=False, timeout=httpx.Timeout(timeout), transport=transport
                ) as client,
                client.stream("POST", url, content=body, headers=headers) as response,
            ):
                limit = success_body_bytes if response.is_success else error_body_bytes
                prefix = await read_prefix(response, limit)
                return Answer(response.status_code, None, prefix, response.encoding or "utf-8")
        except httpx.TimeoutException:
            return Answer(None, "timeout")
        except httpx.HTTPError as exc:
            return Answer(None, f"network: {type(exc).__name__}")

    async def send(url: str, headers: dict[str, str], body: bytes) -> Answer:
        try:
            async with asyncio.timeout(timeout):
                return await post(url, headers, body)
        except TimeoutError:
            return Answer(None, "timeout")

    return send
