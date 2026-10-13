"""The push relay (docs/PUSH_RELAY.md): one Taylis server sends another's pushes.

APNs and FCM only take pushes signed with the keys of whoever distributes the app, so a server
without those keys (a self-hosted one, or a second server of the same lab) asks a server that has
them. Phase 1 (2026-10-13): the asking server sends the device's own token; the relay checks who
asks, sends with its providers and answers with the outcome, which the asking server records as
if it had sent the push itself (an invalid token is dropped there, as before).

Both halves live here:

- `RelayPushProvider`, a PushProvider for the asking server (`PUSH_RELAY_URL`,
  `PUSH_RELAY_CLIENT_ID` and the key file `client_secret` in `PUSH_RELAY_SECRETS_DIR`);
- `router`, `POST /api/v1/push-relay/send` on the relay (`PUSH_RELAY_SERVE=true`; one key file
  per asking server in `PUSH_RELAY_SECRETS_DIR/clients/<client id>`). Off: 404.

A request is signed like the attendance webhooks (outbound/signed.py): X-Taylis-Signature =
sha256=HMAC(key, timestamp + "." + body), the timestamp within RELAY_MAX_SKEW_SECONDS, plus
X-Taylis-Relay-Client naming the key. Nothing is stored on the relay: no token, no body.
"""

import asyncio
import hmac
import logging
import time
import uuid
from collections import deque
from typing import Any, Literal

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError

from app.core.settings import Settings
from app.modules.auth.models import Device
from app.modules.notifications.providers import PushProvider, PushResult
from app.modules.outbound import signed

log = logging.getLogger("app.push.relay")

RELAY_PATH = "/push-relay/send"
CLIENT_HEADER = "X-Taylis-Relay-Client"
RELAY_MAX_SKEW_SECONDS = 300
RELAY_MAX_BODY_BYTES = 32 * 1024
RELAY_TIMEOUT_SECONDS = 15.0
USER_AGENT = "Taylis-PushRelay/1"


class RelayRequest(BaseModel):
    provider: Literal["apns", "fcm"]
    token: str = Field(min_length=1, max_length=4096)
    environment: Literal["sandbox", "production"] | None = None
    # The asking server's address as this device reaches it (the sender's picture, §16).
    base_url: str | None = Field(default=None, max_length=255)
    payload: dict[str, Any]


class RelayAnswer(BaseModel):
    outcome: Literal["sent", "retry", "invalid_token", "failed"]
    detail: str | None = None
    retry_after: float | None = None


def _client_secret(settings: Settings) -> bytes | None:
    return signed.read_secret(settings.push_relay_secrets_dir, "client_secret")


def _relay_key(settings: Settings, client_id: str) -> bytes | None:
    return signed.read_secret(f"{settings.push_relay_secrets_dir}/clients", client_id)


# --- the asking server ---------------------------------------------------------------------


class RelayPushProvider:
    """Sends through the relay; the outcome is the relay's (sent, retry, invalid_token, failed)."""

    def __init__(
        self,
        provider: str,
        *,
        url: str,
        client_id: str,
        settings: Settings,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.provider = provider
        self.url = url.rstrip("/")
        self.client_id = client_id
        self.settings = settings
        self.client = client or httpx.AsyncClient(
            timeout=RELAY_TIMEOUT_SECONDS, follow_redirects=False
        )

    def body(self, device: Device, payload: dict[str, Any]) -> bytes:
        return signed.body_bytes(
            {
                "provider": self.provider,
                "token": device.push_token,
                "environment": device.push_environment,
                "base_url": device.base_url,
                "payload": payload,
            }
        )

    async def send(self, device: Device, payload: dict[str, Any]) -> PushResult:
        secret = _client_secret(self.settings)
        if secret is None:
            log.error("push relay: no client_secret in %s", self.settings.push_relay_secrets_dir)
            return PushResult("retry", "relay key missing")
        body = self.body(device, payload)
        timestamp = int(time.time())
        headers = {
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": USER_AGENT,
            CLIENT_HEADER: self.client_id,
            "X-Taylis-Timestamp": str(timestamp),
            "X-Taylis-Signature": signed.signature(secret, timestamp, body),
        }
        try:
            response = await self.client.post(self.url, content=body, headers=headers)
        except httpx.HTTPError as exc:
            return PushResult("retry", f"relay transport: {exc}")
        if response.status_code == 200:
            try:
                answer = RelayAnswer.model_validate(response.json())
            except (ValueError, ValidationError):
                return PushResult("retry", "relay answer unreadable")
            return PushResult(answer.outcome, answer.detail, answer.retry_after)
        if response.status_code in (401, 403, 404):
            # Wrong key, unknown client, or the relay is off: an operator has to act; keep the
            # push pending (it expires by its TTL) rather than drop the device.
            log.error(
                "push relay refused us (%s): check the URL, client id and key", response.status_code
            )
            return PushResult("retry", f"relay {response.status_code}")
        if response.status_code == 429 or response.status_code >= 500:
            retry_after = response.headers.get("retry-after")
            return PushResult(
                "retry",
                f"relay {response.status_code}",
                float(retry_after) if retry_after else None,
            )
        return PushResult("failed", f"relay {response.status_code}")


# --- the relay -----------------------------------------------------------------------------


class RateLimiter:
    """At most `per_minute` sends per client in any 60 s (per process)."""

    def __init__(self) -> None:
        self.sent: dict[str, deque[float]] = {}

    def allow(self, client_id: str, per_minute: int, now: float | None = None) -> float | None:
        """None when allowed (and counted); else the seconds until the oldest send leaves."""
        now = time.monotonic() if now is None else now
        window = self.sent.setdefault(client_id, deque())
        while window and window[0] <= now - 60:
            window.popleft()
        if len(window) >= per_minute:
            return max(1.0, window[0] + 60 - now)
        window.append(now)
        return None


router = APIRouter(tags=["push-relay"])


def _fail(status: int, code: str) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": code, "message": code, "details": {}}}, status_code=status
    )


@router.post(RELAY_PATH, include_in_schema=False)
async def relay_send(request: Request) -> JSONResponse:
    settings: Settings = request.app.state.settings
    if not settings.push_relay_serve:
        raise HTTPException(status_code=404)
    client_id = request.headers.get(CLIENT_HEADER, "")
    key = _relay_key(settings, client_id)
    raw = await request.body()
    if len(raw) > RELAY_MAX_BODY_BYTES:
        return _fail(413, "too_large")
    try:
        timestamp = int(request.headers.get("X-Taylis-Timestamp", ""))
    except ValueError:
        timestamp = 0
    given = request.headers.get("X-Taylis-Signature", "")
    if (
        key is None
        or abs(time.time() - timestamp) > RELAY_MAX_SKEW_SECONDS
        or not hmac.compare_digest(given, signed.signature(key, timestamp, raw))
    ):
        log.warning("push relay: refused a request (client %r)", client_id[:64])
        return _fail(401, "relay_unauthorized")
    wait = request.app.state.push_relay_limiter.allow(
        client_id, settings.push_relay_rate_per_minute
    )
    if wait is not None:
        response = _fail(429, "rate_limited")
        response.headers["Retry-After"] = str(int(wait) + 1)
        return response
    try:
        ask = RelayRequest.model_validate_json(raw)
    except ValidationError:
        return _fail(422, "validation_error")
    providers: dict[str, PushProvider] = request.app.state.push_providers
    device = Device(
        id=uuid.uuid4(),
        platform="ios" if ask.provider == "apns" else "android",
        push_provider=ask.provider,
        push_token=ask.token,
        push_environment=ask.environment,
        base_url=ask.base_url,
    )
    try:
        result = await asyncio.wait_for(
            providers[ask.provider].send(device, ask.payload), RELAY_TIMEOUT_SECONDS
        )
    except TimeoutError:
        result = PushResult("retry", "relay: provider timeout")
    log.info(
        "push relay: %s for %s via %s",
        result.outcome,
        client_id,
        ask.provider,
        extra={
            "relay_client": client_id,
            "outcome": result.outcome,
            "kind": ask.payload.get("kind"),
        },
    )
    answer = RelayAnswer(
        outcome=result.outcome, detail=result.detail, retry_after=result.retry_after
    )
    return JSONResponse(answer.model_dump())
