"""Everything that talks to LiveKit (M130, docs/CALLS.md §2, §3.2, §7.1).

No LiveKit SDK: the three things the app needs are written with the dependencies it already has.

- access tokens for the clients (`pyjwt`, HS256, `access_token`);
- the webhook's signature (`verify_webhook`): a JWT in the `Authorization` header signed with the
  API secret, whose `sha256` claim is the base64 SHA-256 of the body;
- RoomService over Twirp (JSON POSTs to `/twirp/livekit.RoomService/<Method>` with a short-lived
  admin token, `HttpLiveKitGateway`).

The rest of the app only sees `LiveKitGateway` (a fake replaces it in the tests), like the push
providers.
"""

import base64
import hashlib
import json
import logging
import time
import uuid
import warnings
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

import httpx
import jwt
from jwt.warnings import InsecureKeyLengthWarning

from app.core.settings import Settings

log = logging.getLogger("app.calls.livekit")

# Every source a client may publish (LiveKit's TrackSource names in the token).
ALL_SOURCES = ("microphone", "camera", "screen_share", "screen_share_audio")
# The webhook's token lives five minutes (LiveKit's url_notifier); a little slack for clocks.
WEBHOOK_LEEWAY_SECONDS = 60


class LiveKitUnavailable(Exception):
    """LiveKit could not be reached, or answered with an error we cannot act on."""


@dataclass(frozen=True)
class LiveKitConfig:
    url: str  # what clients connect to (wss://livekit.example.com)
    api_url: str  # what the app reaches RoomService on (http://livekit:7880)
    api_key: str
    api_secret: str
    max_participants: int = 50
    token_ttl_seconds: int = 600
    timeout_seconds: float = 5.0
    # §2.1: LiveKit closes a room nobody joined after empty_timeout, and one everybody left after
    # departure_timeout.
    empty_timeout_seconds: int = 120
    departure_timeout_seconds: int = 20


def config_from_settings(settings: Settings) -> LiveKitConfig | None:
    """None unless the URL, the API URL, the key and the secret are all set (§3.4)."""
    secret = settings.livekit_api_secret.strip()
    if settings.livekit_api_secret_file:
        try:
            secret = Path(settings.livekit_api_secret_file).read_text().strip() or secret
        except OSError:
            log.warning("LIVEKIT_API_SECRET_FILE cannot be read: in-app calls are off")
    parts = (settings.livekit_url, settings.livekit_api_url, settings.livekit_api_key, secret)
    if not all(p.strip() for p in parts):
        if any(p.strip() for p in parts):
            log.warning(
                "LiveKit is partly configured (LIVEKIT_URL, LIVEKIT_API_URL, LIVEKIT_API_KEY and "
                "the secret are all needed): in-app calls are off"
            )
        return None
    if len(secret.encode()) < 32:
        if settings.environment == "production":
            log.warning(
                "LIVEKIT_API_SECRET is shorter than 32 bytes: make a long random one "
                "(docs/CALLS.md §7.4); in-app calls are off"
            )
            return None
        log.info("LiveKit's short development secret is in use (local development only)")
    return LiveKitConfig(
        url=settings.livekit_url.strip(),
        api_url=settings.livekit_api_url.strip().rstrip("/"),
        api_key=settings.livekit_api_key.strip(),
        api_secret=secret,
        max_participants=settings.livekit_max_participants,
        token_ttl_seconds=settings.livekit_token_ttl_seconds,
        timeout_seconds=settings.livekit_api_timeout_seconds,
    )


def _encode(claims: dict[str, Any], secret: str) -> str:
    # LiveKit's --dev secret ("secret") is short; config_from_settings warns once about short
    # secrets instead of every token.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", InsecureKeyLengthWarning)
        return jwt.encode(claims, secret, algorithm="HS256")


# --- access tokens (§7.1) ----------------------------------------------------------------------


@dataclass(frozen=True)
class AccessToken:
    token: str
    expires_at: datetime


def access_token(
    config: LiveKitConfig,
    *,
    room: str,
    identity: str,
    name: str,
    sources: tuple[str, ...],
    metadata: dict[str, Any] | None = None,
    now: float | None = None,
) -> AccessToken:
    """A token for one room only: join, publish the given sources, subscribe. Never roomCreate,
    roomAdmin, roomList, recorder or hidden; no data channel (§1: the chat is the conversation)."""
    issued = int(time.time() if now is None else now)
    expires = issued + config.token_ttl_seconds
    claims: dict[str, Any] = {
        "iss": config.api_key,
        "sub": identity,
        "name": name,
        "nbf": issued,
        "iat": issued,
        "exp": expires,
        "jti": uuid.uuid4().hex,
        "video": {
            "room": room,
            "roomJoin": True,
            "canPublish": True,
            "canSubscribe": True,
            "canPublishData": False,
            "canPublishSources": list(sources),
            "canUpdateOwnMetadata": False,
        },
        "metadata": json.dumps(metadata or {}, separators=(",", ":")),
    }
    token = _encode(claims, config.api_secret)
    return AccessToken(token=token, expires_at=datetime.fromtimestamp(expires, UTC))


def _service_token(config: LiveKitConfig, video: dict[str, Any]) -> str:
    """The app's own short token for one RoomService call."""
    now = int(time.time())
    claims = {"iss": config.api_key, "nbf": now, "exp": now + 60, "video": video}
    return _encode(claims, config.api_secret)


# --- the webhook (§3.2) -------------------------------------------------------------------------


class InvalidWebhook(Exception):
    pass


def verify_webhook(
    config: LiveKitConfig, body: bytes, authorization: str | None, *, now: float | None = None
) -> dict[str, Any]:
    """The event, once its signature is checked: `Authorization` holds a JWT (no "Bearer"
    prefix) signed HS256 with the API secret, issued by the API key, unexpired, whose `sha256`
    claim is the standard base64 of the body's SHA-256 (verified against LiveKit 1.13.8 in dev
    mode, 2026-10-07). Anything else raises InvalidWebhook."""
    if not authorization:
        raise InvalidWebhook("no Authorization header")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", InsecureKeyLengthWarning)
            claims = jwt.decode(
                token,
                config.api_secret,
                algorithms=["HS256"],
                options={"verify_exp": False, "verify_nbf": False, "verify_iat": False},
            )
    except jwt.PyJWTError as exc:
        raise InvalidWebhook(f"bad token: {exc}") from exc
    clock = time.time() if now is None else now
    if claims.get("iss") != config.api_key:
        raise InvalidWebhook("issued by another key")
    exp = claims.get("exp")
    if not isinstance(exp, int | float) or exp + WEBHOOK_LEEWAY_SECONDS < clock:
        raise InvalidWebhook("expired")
    nbf = claims.get("nbf")
    if isinstance(nbf, int | float) and nbf - WEBHOOK_LEEWAY_SECONDS > clock:
        raise InvalidWebhook("not yet valid")
    digest = base64.b64encode(hashlib.sha256(body).digest()).decode()
    if claims.get("sha256") != digest:
        raise InvalidWebhook("body does not match its signature")
    try:
        event = json.loads(body)
    except ValueError as exc:
        raise InvalidWebhook("body is not JSON") from exc
    if not isinstance(event, dict):
        raise InvalidWebhook("body is not an object")
    return event


def parse_timestamp(value: Any) -> datetime | None:
    """LiveKit's int64 seconds come as JSON strings ("1791329539")."""
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(seconds, UTC) if seconds > 0 else None


# --- RoomService --------------------------------------------------------------------------------


@dataclass(frozen=True)
class LiveKitParticipant:
    sid: str
    identity: str
    joined_at: datetime | None = None


@dataclass(frozen=True)
class LiveKitRoom:
    name: str
    num_participants: int = 0


class LiveKitGateway(Protocol):
    """The RoomService calls the app makes. Each raises LiveKitUnavailable when LiveKit cannot be
    reached; a room or participant that is already gone is not an error."""

    async def create_room(self, name: str) -> None: ...

    async def delete_room(self, name: str) -> None: ...

    async def list_rooms(self) -> list[LiveKitRoom]: ...

    async def list_participants(self, room: str) -> list[LiveKitParticipant]: ...

    async def remove_participant(self, room: str, identity: str) -> None: ...


class HttpLiveKitGateway:
    """RoomService over Twirp's JSON protocol (httpx). Requests use the proto field names, which
    the Twirp server accepts; answers come back with the same names."""

    def __init__(self, config: LiveKitConfig, client: httpx.AsyncClient | None = None) -> None:
        self.config = config
        self._client = client or httpx.AsyncClient(timeout=config.timeout_seconds)

    async def _post(self, method: str, body: dict[str, Any], video: dict[str, Any]) -> Any:
        url = f"{self.config.api_url}/twirp/livekit.RoomService/{method}"
        headers = {"Authorization": "Bearer " + _service_token(self.config, video)}
        try:
            response = await self._client.post(url, json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise LiveKitUnavailable(f"{method}: {exc!r}") from exc
        if response.status_code == 404:
            return None  # the room or participant is gone already
        if response.status_code != 200:
            raise LiveKitUnavailable(f"{method}: {response.status_code} {response.text[:200]}")
        try:
            return response.json()
        except ValueError as exc:
            raise LiveKitUnavailable(f"{method}: not JSON") from exc

    async def create_room(self, name: str) -> None:
        await self._post(
            "CreateRoom",
            {
                "name": name,
                "empty_timeout": self.config.empty_timeout_seconds,
                "departure_timeout": self.config.departure_timeout_seconds,
                "max_participants": self.config.max_participants,
            },
            {"roomCreate": True},
        )

    async def delete_room(self, name: str) -> None:
        await self._post("DeleteRoom", {"room": name}, {"roomCreate": True})

    async def list_rooms(self) -> list[LiveKitRoom]:
        data = await self._post("ListRooms", {}, {"roomList": True}) or {}
        return [
            LiveKitRoom(
                name=str(r.get("name", "")), num_participants=int(r.get("num_participants") or 0)
            )
            for r in data.get("rooms") or []
        ]

    async def list_participants(self, room: str) -> list[LiveKitParticipant]:
        data = await self._post(
            "ListParticipants", {"room": room}, {"roomAdmin": True, "room": room}
        )
        return [
            LiveKitParticipant(
                sid=str(p.get("sid", "")),
                identity=str(p.get("identity", "")),
                joined_at=parse_timestamp(p.get("joined_at")),
            )
            for p in (data or {}).get("participants") or []
        ]

    async def remove_participant(self, room: str, identity: str) -> None:
        await self._post(
            "RemoveParticipant",
            {"room": room, "identity": identity},
            {"roomAdmin": True, "room": room},
        )


@dataclass
class FakeLiveKitGateway:
    """In-memory LiveKit for the tests: rooms with their participants, every call recorded, and a
    switch that makes it unreachable."""

    rooms: dict[str, list[LiveKitParticipant]] = field(default_factory=dict)
    calls: list[tuple[str, str]] = field(default_factory=list)
    unavailable: bool = False

    def _check(self, method: str, arg: str) -> None:
        self.calls.append((method, arg))
        if self.unavailable:
            raise LiveKitUnavailable(f"{method}: fake is down")

    async def create_room(self, name: str) -> None:
        self._check("create_room", name)
        self.rooms.setdefault(name, [])

    async def delete_room(self, name: str) -> None:
        self._check("delete_room", name)
        self.rooms.pop(name, None)

    async def list_rooms(self) -> list[LiveKitRoom]:
        self._check("list_rooms", "")
        return [LiveKitRoom(name=n, num_participants=len(p)) for n, p in self.rooms.items()]

    async def list_participants(self, room: str) -> list[LiveKitParticipant]:
        self._check("list_participants", room)
        return list(self.rooms.get(room, []))

    async def remove_participant(self, room: str, identity: str) -> None:
        self._check("remove_participant", f"{room}/{identity}")
        if room in self.rooms:
            self.rooms[room] = [p for p in self.rooms[room] if p.identity != identity]

    def join(self, room: str, identity: str, sid: str | None = None) -> LiveKitParticipant:
        """A client connected (what LiveKit would then announce with participant_joined)."""
        participant = LiveKitParticipant(
            sid=sid or "PA_" + uuid.uuid4().hex[:12], identity=identity, joined_at=datetime.now(UTC)
        )
        self.rooms.setdefault(room, []).append(participant)
        return participant
