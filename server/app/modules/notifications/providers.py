"""PushProvider implementations (PUSH_NOTIFICATIONS.md §8)."""

import json
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


def avatar_url(device: Device, path: object) -> str | None:
    """§16: the signed avatar path on the address this device reaches the server by; None when
    either is unknown (the extension then shows the notification without a picture)."""
    base = (device.base_url or "").rstrip("/")
    if not base or not isinstance(path, str) or not path.startswith("/"):
        return None
    return base + path


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
        if payload.get("kind") == "message" and payload.get("sender_id"):
            # §16: the Notification Service Extension turns it into a communication notification
            # (the sender's picture, the app icon small in the corner).
            aps["mutable-content"] = 1
        body = {
            "aps": aps,
            "kind": payload.get("kind"),
            "workspace_id": payload.get("workspace_id"),
            "channel_id": payload.get("channel_id"),
            "message_id": payload.get("message_id"),
            "seq": payload.get("seq"),
            # A reply's thread, so a tap opens it (M28d); None for a top-level post.
            "parent_id": payload.get("parent_id"),
            # kind calendar (M51): the event to open.
            "event_id": payload.get("event_id"),
            # kind task (M55): the task to open.
            "task_id": payload.get("task_id"),
            # kind canvas (M72): the canvas to open.
            "canvas_id": payload.get("canvas_id"),
            # kind reservation (M112): the pool (opens the reservations page).
            "pool_id": payload.get("pool_id"),
            # kind page (M120): the wiki page to open.
            "page_id": payload.get("page_id"),
        }
        if payload.get("sender_id"):
            # kind message (§16): the sender and the conversation for the extension.
            body["sender_id"] = payload.get("sender_id")
            body["sender_name"] = payload.get("sender_name")
            body["channel_type"] = payload.get("channel_type")
            avatar = avatar_url(device, payload.get("sender_avatar_path"))
            if avatar:
                body["sender_avatar_url"] = avatar
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


class FCMPushProvider:
    """FCM HTTP v1 with a service account: a JWT bearer grant yields short-lived OAuth2 tokens."""

    provider = "fcm"
    SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
    GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer"
    ASSERTION_LIFETIME_SECONDS = 3600
    TOKEN_SAFETY_MARGIN_SECONDS = 60

    def __init__(
        self,
        *,
        project_id: str,
        client_email: str,
        private_key: str,
        token_uri: str = "https://oauth2.googleapis.com/token",
        fcm_host: str = "https://fcm.googleapis.com",
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.project_id = project_id
        self.client_email = client_email
        self.private_key = private_key
        self.token_uri = token_uri
        self.fcm_host = fcm_host
        self.client = client or httpx.AsyncClient(http2=True, timeout=15.0)
        self._access_token: str | None = None
        self._access_token_expires_at = 0.0

    @classmethod
    def from_file(cls, path: str) -> "FCMPushProvider":
        """A service account key file from the Firebase console (never committed)."""
        info = json.loads(Path(path).read_text())
        return cls(
            project_id=info["project_id"],
            client_email=info["client_email"],
            private_key=info["private_key"],
            token_uri=info.get("token_uri", "https://oauth2.googleapis.com/token"),
        )

    def assertion(self, now: float) -> str:
        return jwt.encode(
            {
                "iss": self.client_email,
                "scope": self.SCOPE,
                "aud": self.token_uri,
                "iat": int(now),
                "exp": int(now) + self.ASSERTION_LIFETIME_SECONDS,
            },
            self.private_key,
            algorithm="RS256",
        )

    async def access_token(self, now: float | None = None) -> str:
        now = time.time() if now is None else now
        if (
            self._access_token is not None
            and now < self._access_token_expires_at - self.TOKEN_SAFETY_MARGIN_SECONDS
        ):
            return self._access_token
        response = await self.client.post(
            self.token_uri,
            data={"grant_type": self.GRANT_TYPE, "assertion": self.assertion(now)},
        )
        response.raise_for_status()
        data = response.json()
        self._access_token = str(data["access_token"])
        self._access_token_expires_at = now + float(data.get("expires_in", 3600))
        return self._access_token

    def build_message(
        self, device: Device, payload: dict[str, Any], now: float | None = None
    ) -> dict[str, Any]:
        """Data-only message (PUSH_NOTIFICATIONS.md §5): the app builds the notification itself."""
        now = time.time() if now is None else now
        silent = payload.get("kind") == "silent"
        data = {
            key: str(payload[key])
            for key in (
                "kind",
                "workspace_id",
                "channel_id",
                "message_id",
                "parent_id",
                "event_id",
                "task_id",
                "canvas_id",
                "pool_id",
                "page_id",
                "seq",
                "title",
                "subtitle",
                "body",
                "badge",
                "collapse_key",
                "sent_at",
                # kind message (§16): MessagingStyle with the sender's picture, which the app
                # fetches with its own session (no signed URL through Google).
                "sender_id",
                "sender_name",
                "sender_avatar",
                "channel_type",
            )
            if payload.get(key) is not None
        }
        android: dict[str, Any] = {"priority": "NORMAL" if silent else "HIGH"}
        if payload.get("collapse_key"):
            android["collapse_key"] = str(payload["collapse_key"])[:64]
        expires = payload.get("expires_at")
        if expires:
            ttl = max(0, int(datetime.fromisoformat(str(expires)).timestamp() - now))
            android["ttl"] = f"{ttl}s"
        return {"message": {"token": device.push_token, "data": data, "android": android}}

    @staticmethod
    def _error(response: httpx.Response) -> tuple[str, str, str]:
        """(status, errorCode, message) from an FCM error body; blanks when unparsable."""
        try:
            error = response.json().get("error", {})
        except ValueError:
            return "", "", ""
        code = ""
        for detail in error.get("details", []):
            if isinstance(detail, dict) and detail.get("errorCode"):
                code = str(detail["errorCode"])
        return str(error.get("status", "")), code, str(error.get("message", ""))

    async def send(self, device: Device, payload: dict[str, Any]) -> PushResult:
        url = f"{self.fcm_host}/v1/projects/{self.project_id}/messages:send"
        try:
            token = await self.access_token()
            response = await self.client.post(
                url,
                headers={"authorization": f"Bearer {token}"},
                json=self.build_message(device, payload),
            )
        except httpx.HTTPError as exc:
            return PushResult("retry", f"transport: {exc}")
        if response.status_code == 200:
            return PushResult("sent")
        status, code, message = self._error(response)
        detail = code or status or str(response.status_code)
        if response.status_code == 404 and (code == "UNREGISTERED" or status == "NOT_FOUND"):
            return PushResult("invalid_token", "UNREGISTERED")
        if response.status_code == 400 and "registration token" in message.lower():
            return PushResult("invalid_token", "INVALID_ARGUMENT")
        if response.status_code in (401, 403):
            self._access_token = None  # force a fresh access token next time
            log.error("FCM rejected the service account credentials (%s)", detail)
            return PushResult("retry", detail)
        if response.status_code == 429 or response.status_code >= 500:
            retry_after = response.headers.get("retry-after")
            return PushResult("retry", detail, float(retry_after) if retry_after else None)
        return PushResult("failed", f"{response.status_code} {detail} {message}".strip())


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
    if settings.push_fcm_enabled:
        providers["fcm"] = FCMPushProvider.from_file(settings.push_fcm_service_account_path)
    else:
        providers["fcm"] = LogPushProvider("fcm")
    return providers
