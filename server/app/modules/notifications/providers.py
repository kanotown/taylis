"""PushProvider implementations (PUSH_NOTIFICATIONS.md §8)."""

import logging
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, ClassVar, Literal, Protocol

import httpx
import jwt

from app.modules.auth.models import Device

log = logging.getLogger("app.push")

Outcome = Literal["sent", "retry", "invalid_token", "failed"]


@dataclass
class PushResult:
    outcome: Outcome
    detail: str | None = None
    retry_after: float | None = None


class PushProvider(Protocol):
    provider: str

    async def send(self, device: Device, payload: dict[str, Any]) -> PushResult: ...


class LogPushProvider:
    """Development default: logs what would have been sent."""

    def __init__(self, provider: str) -> None:
        self.provider = provider

    async def send(self, device: Device, payload: dict[str, Any]) -> PushResult:
        log.info(
            "push (%s, not configured) to device %s: %s",
            self.provider,
            device.id,
            payload.get("title"),
            extra={"device_id": str(device.id), "kind": payload.get("kind")},
        )
        return PushResult("sent", "logged")


class FakePushProvider:
    """Test double: records sends and returns scripted outcomes (default: sent)."""

    def __init__(self, provider: str = "apns") -> None:
        self.provider = provider
        self.sent: list[tuple[Device, dict[str, Any]]] = []
        self.outcomes: list[PushResult | Exception] = []

    async def send(self, device: Device, payload: dict[str, Any]) -> PushResult:
        self.sent.append((device, payload))
        if self.outcomes:
            outcome = self.outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        return PushResult("sent")


class APNsPushProvider:
    """APNs HTTP/2 with token-based (.p8) authentication."""

    provider = "apns"
    HOSTS: ClassVar[dict[str, str]] = {
        "sandbox": "https://api.sandbox.push.apple.com",
        "production": "https://api.push.apple.com",
    }
    TOKEN_LIFETIME_SECONDS = 50 * 60  # Apple requires a fresh token at least every hour

    def __init__(
        self,
        *,
        key: str,
        key_id: str,
        team_id: str,
        bundle_id: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.key = key
        self.key_id = key_id
        self.team_id = team_id
        self.bundle_id = bundle_id
        self.client = client or httpx.AsyncClient(http2=True, timeout=15.0)
        self._token: str | None = None
        self._token_issued_at = 0.0

    @classmethod
    def from_files(
        cls, *, key_path: str, key_id: str, team_id: str, bundle_id: str
    ) -> "APNsPushProvider":
        return cls(
            key=Path(key_path).read_text(), key_id=key_id, team_id=team_id, bundle_id=bundle_id
        )

    def auth_token(self, now: float | None = None) -> str:
        now = time.time() if now is None else now
        if self._token is None or now - self._token_issued_at > self.TOKEN_LIFETIME_SECONDS:
            self._token = jwt.encode(
                {"iss": self.team_id, "iat": int(now)},
                self.key,
                algorithm="ES256",
                headers={"kid": self.key_id},
            )
            self._token_issued_at = now
        return self._token

    def build_request(
        self, device: Device, payload: dict[str, Any]
    ) -> tuple[str, dict[str, str], dict[str, Any]]:
        host = self.HOSTS["sandbox" if device.push_environment == "sandbox" else "production"]
        url = f"{host}/3/device/{device.push_token}"
        expires = payload.get("expires_at")
        headers = {
            "authorization": f"bearer {self.auth_token()}",
            "apns-topic": self.bundle_id,
            "apns-push-type": "alert" if payload.get("kind") != "silent" else "background",
            "apns-priority": "10" if payload.get("kind") != "silent" else "5",
        }
        if payload.get("collapse_key"):
            headers["apns-collapse-id"] = str(payload["collapse_key"])[:64]
        if expires:
            headers["apns-expiration"] = str(int(datetime.fromisoformat(str(expires)).timestamp()))
        alert: dict[str, Any] = {"title": payload.get("title", ""), "body": payload.get("body", "")}
        if payload.get("subtitle"):
            alert["subtitle"] = payload["subtitle"]
        aps: dict[str, Any] = {"alert": alert, "sound": "default", "badge": payload.get("badge", 1)}
        if payload.get("channel_id"):
            aps["thread-id"] = str(payload["channel_id"])
        body = {
            "aps": aps,
            "kind": payload.get("kind"),
            "channel_id": payload.get("channel_id"),
            "message_id": payload.get("message_id"),
            "seq": payload.get("seq"),
        }
        return url, headers, body

    async def send(self, device: Device, payload: dict[str, Any]) -> PushResult:
        url, headers, body = self.build_request(device, payload)
        try:
            response = await self.client.post(url, headers=headers, json=body)
        except httpx.HTTPError as exc:
            return PushResult("retry", f"transport: {exc}")
        if response.status_code == 200:
            return PushResult("sent")
        reason = ""
        try:
            reason = str(response.json().get("reason", ""))
        except ValueError:
            pass
        if response.status_code in (400, 410) and reason in (
            "BadDeviceToken",
            "Unregistered",
            "DeviceTokenNotForTopic",
        ):
            return PushResult("invalid_token", reason)
        if response.status_code == 403:
            self._token = None  # force a fresh provider token next time
            log.error("APNs rejected the provider token (%s); check key / team / key id", reason)
            return PushResult("retry", reason)
        if response.status_code == 429 or response.status_code >= 500:
            retry_after = response.headers.get("retry-after")
            return PushResult(
                "retry",
                reason or str(response.status_code),
                float(retry_after) if retry_after else None,
            )
        return PushResult("failed", f"{response.status_code} {reason}")


def build_providers(settings: Any) -> dict[str, PushProvider]:
    """Provider registry from settings; unconfigured platforms log instead of sending."""
    providers: dict[str, PushProvider] = {}
    if settings.push_apns_enabled:
        providers["apns"] = APNsPushProvider.from_files(
            key_path=settings.push_apns_key_path,
            key_id=settings.push_apns_key_id,
            team_id=settings.push_apns_team_id,
            bundle_id=settings.push_apns_bundle_id,
        )
    else:
        providers["apns"] = LogPushProvider("apns")
    providers["fcm"] = LogPushProvider("fcm")  # FCM arrives in M7
    return providers
