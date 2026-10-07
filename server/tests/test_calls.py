"""M130 (docs/CALLS.md): in-app calls on LiveKit — tokens, who may start and join, the webhook,
the reconcile loop, events, messages and pushes — and the end of M117's meeting links (§11)."""

import asyncio
import base64
import hashlib
import json
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import timedelta
from pathlib import Path
from typing import Any

import jwt
import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.calls import service as calls
from app.modules.calls.livekit import (
    FakeLiveKitGateway,
    InvalidWebhook,
    LiveKitConfig,
    LiveKitParticipant,
    LiveKitUnavailable,
    access_token,
    config_from_settings,
    verify_webhook,
)
from app.modules.calls.models import Call, CallParticipant
from app.modules.channels import service as channels
from app.modules.messages.models import Message
from app.modules.users.models import User
from app.modules.workspace import service as workspace
from tests.helpers import make_user
from tests.test_push_planner import add_device, deliveries, relay_with_planner

API = "/api/v1"
FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "livekit_webhooks.json").read_text())
SECRET = "test-livekit-secret-" + "x" * 24
CONFIG = LiveKitConfig(
    url="wss://livekit.chat.test",
    api_url="http://livekit:7880",
    api_key="taylis",
    api_secret=SECRET,
    max_participants=50,
)


@pytest.fixture
async def fake(app: FastAPI) -> AsyncIterator[FakeLiveKitGateway]:
    """The app with LiveKit configured (a fake) and PUBLIC_BASE_URL set."""
    gateway = FakeLiveKitGateway()
    app.state.calls = calls.CallsRuntime(
        config=CONFIG, gateway=gateway, public_base_url="https://chat.test"
    )
    workspace.set_in_app_calls_available(True)
    try:
        yield gateway
    finally:
        workspace.set_in_app_calls_available(False)


def sign(body: bytes, *, key: str = "taylis", secret: str = SECRET, ttl: int = 300) -> str:
    """What LiveKit's url_notifier sends (protocol/webhook: SetValidFor(5m), SetSha256)."""
    now = int(time.time())
    digest = base64.b64encode(hashlib.sha256(body).digest()).decode()
    claims = {"iss": key, "nbf": now, "iat": now, "exp": now + ttl, "sha256": digest}
    return jwt.encode(claims, secret, algorithm="HS256")


async def webhook(client: AsyncClient, event: dict[str, Any], **kw: Any) -> Any:
    body = json.dumps(event).encode()
    return await client.post(
        f"{API}/livekit/webhook",
        content=body,
        headers={"Authorization": sign(body, **kw), "Content-Type": "application/webhook+json"},
    )


def joined(call_id: str, user_id: str, sid: str) -> dict[str, Any]:
    return {
        "event": "participant_joined",
        "room": {"sid": "RM_x", "name": call_id},
        "participant": {
            "sid": sid,
            "identity": user_id,
            "state": "ACTIVE",
            "joinedAt": str(int(time.time())),
        },
        "id": "EV_" + uuid.uuid4().hex[:12],
        "createdAt": str(int(time.time())),
    }


def left(call_id: str, user_id: str, sid: str) -> dict[str, Any]:
    event = joined(call_id, user_id, sid)
    event["event"] = "participant_left"
    event["participant"]["state"] = "DISCONNECTED"
    return event


def finished(call_id: str) -> dict[str, Any]:
    return {
        "event": "room_finished",
        "room": {"sid": "RM_x", "name": call_id},
        "id": "EV_" + uuid.uuid4().hex[:12],
        "roomEndReason": "ROOM_END_IDLE_TIMEOUT",
    }


async def huddle(client: AsyncClient, channel_id: str, key: str | None = None) -> Any:
    return await client.post(
        f"{API}/channels/{channel_id}/huddle", json={"client_msg_id": key or str(uuid.uuid4())}
    )


async def events(db: AsyncSession, event_type: str) -> list[OutboxEvent]:
    stmt = select(OutboxEvent).where(OutboxEvent.event_type == event_type)
    return list((await db.execute(stmt.order_by(OutboxEvent.id))).scalars().all())


async def dm_of(client: AsyncClient, *others: User) -> dict[str, Any]:
    response = await client.post(f"{API}/dms", json={"user_ids": [str(u.id) for u in others]})
    data: dict[str, Any] = response.json()
    return data


# --- configuration, tokens, signatures ----------------------------------------------------------


def test_livekit_is_configured_only_when_complete(test_settings: Settings, tmp_path: Path) -> None:
    assert config_from_settings(test_settings) is None
    partial = test_settings.model_copy(update={"livekit_url": "ws://localhost:7880"})
    assert config_from_settings(partial) is None
    secret_file = tmp_path / "livekit_api_secret"
    secret_file.write_text("from-the-file\n")
    full = test_settings.model_copy(
        update={
            "livekit_url": "ws://localhost:7880",
            "livekit_api_url": "http://livekit:7880/",
            "livekit_api_key": "devkey",
            "livekit_api_secret_file": str(secret_file),
        }
    )
    config = config_from_settings(full)
    assert config is not None
    assert config.api_secret == "from-the-file" and config.api_url == "http://livekit:7880"
    assert config.max_participants == 50 and config.token_ttl_seconds == 600


def test_access_token_claims() -> None:
    now = 1_800_000_000
    token = access_token(
        CONFIG,
        room="room-1",
        identity="user-1",
        name="Alice",
        sources=("microphone", "camera"),
        metadata={"avatar_version": 7},
        now=now,
    )
    claims = jwt.decode(
        token.token,
        SECRET,
        algorithms=["HS256"],
        options={"verify_exp": False, "verify_nbf": False, "verify_iat": False},
    )
    assert claims["iss"] == "taylis" and claims["sub"] == "user-1" and claims["name"] == "Alice"
    assert claims["nbf"] == now and claims["exp"] == now + 600
    assert token.expires_at.timestamp() == now + 600
    assert claims["video"] == {
        "room": "room-1",
        "roomJoin": True,
        "canPublish": True,
        "canSubscribe": True,
        "canPublishData": False,
        "canPublishSources": ["microphone", "camera"],
        "canUpdateOwnMetadata": False,
    }
    for grant in ("roomCreate", "roomAdmin", "roomList", "recorder", "hidden"):
        assert grant not in claims["video"]
    assert json.loads(claims["metadata"]) == {"avatar_version": 7}


def test_sources_follow_settings_and_platform() -> None:
    every = ("microphone", "camera", "screen_share", "screen_share_audio")
    assert calls._sources("desktop", True, True) == every
    assert calls._sources(None, True, True) == every
    assert calls._sources("ios", True, True) == ("microphone", "camera")
    assert calls._sources("android", True, True) == ("microphone", "camera")
    assert calls._sources("desktop", False, True) == (
        "microphone",
        "screen_share",
        "screen_share_audio",
    )
    assert calls._sources("desktop", False, False) == ("microphone",)


def _recorded(index: int) -> tuple[bytes, str, LiveKitConfig, int]:
    event = FIXTURE["events"][index]
    config = LiveKitConfig(
        url="ws://x",
        api_url="http://x",
        api_key=FIXTURE["api_key"],
        api_secret=FIXTURE["api_secret"],
    )
    iat = jwt.decode(event["authorization"], options={"verify_signature": False})["iat"]
    return event["body"].encode(), event["authorization"], config, iat


def test_a_real_livekit_webhook_verifies() -> None:
    """Recorded from LiveKit 1.13.8 itself: a JWT without "Bearer" in Authorization, HS256 with
    the API secret, iss = the key, valid 5 minutes, `sha256` = base64 (standard, padded) of the
    body's SHA-256; content type application/webhook+json; camelCase JSON, int64 as strings."""
    body, auth, config, iat = _recorded(1)
    assert FIXTURE["events"][1]["content_type"] == "application/webhook+json"
    event = verify_webhook(config, body, auth, now=iat + 10)
    assert event["event"] == "participant_joined"
    assert event["participant"]["identity"] == "2b1e4f6a-8c3d-4e5f-9a0b-1c2d3e4f5a60"
    assert event["participant"]["joinedAt"].isdigit()
    claims = jwt.decode(auth, options={"verify_signature": False})
    assert set(claims) == {"iss", "exp", "nbf", "iat", "sha256"} and claims["exp"] - iat == 300


@pytest.mark.parametrize(
    "case", ["tampered", "expired", "other_secret", "other_key", "missing", "garbage"]
)
def test_bad_webhooks_are_refused(case: str) -> None:
    body, auth, config, iat = _recorded(1)
    now: float = iat + 10
    if case == "tampered":
        body = body.replace(b"ACTIVE", b"ACTIVf")
    elif case == "expired":
        now = iat + 300 + 3600  # a replay an hour later
    elif case == "other_secret":
        config = LiveKitConfig(url="", api_url="", api_key="devkey", api_secret="other")
    elif case == "other_key":
        config = LiveKitConfig(url="", api_url="", api_key="taylis", api_secret="secret")
    elif case == "missing":
        auth = ""
    else:
        auth = "Bearer not-a-token"
    with pytest.raises(InvalidWebhook):
        verify_webhook(config, body, auth, now=now)


async def test_recorded_webhooks_drive_a_call(
    db: AsyncSession, app: FastAPI, fake: FakeLiveKitGateway
) -> None:
    """The recorded join / leave / finish, replayed through the handler (twice: idempotent)."""
    user = User(
        id=uuid.UUID("2b1e4f6a-8c3d-4e5f-9a0b-1c2d3e4f5a60"),
        username="rec",
        display_name="Rec",
        password_hash="x",
        role="member",
    )
    db.add(user)
    await db.commit()
    dm, _ = await channels.get_or_create_dm(db, user, [])
    call = Call(
        id=uuid.UUID("7c0f2b8e-1d2a-4c55-9a1e-3f4b5c6d7e80"), channel_id=dm.id, started_by=user.id
    )
    db.add(call)
    await db.commit()
    outcomes = []
    for index in (0, 1, 1, 2, 2, 3, 3):
        body, auth, config, iat = _recorded(index)
        outcomes.append(await calls.handle_webhook(db, verify_webhook(config, body, auth, now=iat)))
    assert outcomes == [
        "ignored",  # room_started: the app made the room
        "updated",
        "duplicate",
        "updated",
        "duplicate",
        "ended",
        "unknown room",  # the call is over
    ]
    await db.refresh(call)
    assert call.ended_at is not None and call.end_reason == "empty"
    assert call.participant_count == 1 and call.peak_participants == 1
    rows = (await db.execute(select(CallParticipant))).scalars().all()
    assert len(rows) == 1 and rows[0].livekit_sid.startswith("PA_") and rows[0].left_at


# --- the workspace settings and M117's retirement ------------------------------------------------


async def test_settings_and_meeting_links_retired(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], fake: FakeLiveKitGateway
) -> None:
    admin = await make_user(db, "admin", role="admin")
    member = await make_user(db, "member")
    as_user(member)
    boot = (await client.get(f"{API}/sync/bootstrap")).json()
    settings = boot["workspace_settings"]
    assert settings["in_app_calls"] == {"enabled": True, "video": True, "screen_share": True}
    # The released M117 clients hide 📞.
    assert settings["calls_enabled"] is False and settings["meeting_base_url"] is None
    assert boot["active_calls"] == []
    # M117's endpoint: always 409 calls_disabled (whatever the body).
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    for body in ({"client_msg_id": str(uuid.uuid4())}, {}):
        old = await client.post(f"{API}/channels/{general['id']}/calls", json=body)
        assert old.status_code == 409 and old.json()["error"]["code"] == "calls_disabled"

    as_user(admin)
    for value in ("https://meet.jit.si/", "", None):
        retired = await client.patch(
            f"{API}/admin/workspace-settings", json={"meeting_base_url": value}
        )
        assert retired.status_code == 409
        assert retired.json()["error"]["code"] == "meeting_links_retired"
    off = await client.patch(
        f"{API}/admin/workspace-settings", json={"in_app_calls_enabled": False}
    )
    assert off.status_code == 200
    assert off.json()["in_app_calls_enabled"] is False
    assert off.json()["in_app_calls"]["enabled"] is False and off.json()["calls_enabled"] is False
    announced = await events(db, "workspace.settings_updated")
    assert announced[-1].payload["settings"]["in_app_calls"]["enabled"] is False

    as_user(member)
    refused = await huddle(client, general["id"])
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "calls_disabled"


async def test_without_livekit_calls_are_off(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    settings = (await client.get(f"{API}/sync/bootstrap")).json()["workspace_settings"]
    assert settings["in_app_calls"]["enabled"] is False
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    refused = await huddle(client, general["id"])
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "calls_disabled"
    assert (await client.post(f"{API}/livekit/webhook", content=b"{}")).status_code == 404


async def test_m117_messages_read_as_links(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    posted = await client.post(
        f"{API}/channels/{general['id']}/messages",
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": "📞 通話を始めました\nhttps://meet.jit.si/taylis-x",
        },
    )
    await db.execute(
        text("UPDATE messages SET call_url = 'https://meet.jit.si/taylis-x' WHERE id = :id"),
        {"id": posted.json()["id"]},
    )
    await db.commit()
    history = (await client.get(f"{API}/channels/{general['id']}/messages")).json()["messages"]
    assert history[0]["call"] == {
        "kind": "link",
        "url": "https://meet.jit.si/taylis-x",
        "started_by": str(alice.id),
        "call_id": None,
        "started_at": None,
        "ended_at": None,
        "duration_seconds": None,
        "participant_count": None,
    }


# --- starting and joining -----------------------------------------------------------------------


async def test_starting_a_call(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], fake: FakeLiveKitGateway
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    group = await dm_of(client, bob, carol)
    key = str(uuid.uuid4())
    started = await huddle(client, group["id"], key)
    assert started.status_code == 201, started.text
    assert started.headers["cache-control"] == "no-store"
    out = started.json()
    call, message, join = out["call"], out["message"], out["join"]
    assert call["channel_id"] == group["id"] and call["started_by"] == str(alice.id)
    assert call["message_id"] == message["id"] and call["ended_at"] is None
    assert call["participants"] == [] and call["participant_count"] == 0
    url = f"https://chat.test/call/{call['id']}"
    assert message["body"] == f"🎧 通話を始めました\n{url}"
    assert message["type"] == "user" and message["sender_id"] == str(alice.id)
    assert message["call"]["kind"] == "livekit" and message["call"]["url"] == url
    assert message["call"]["call_id"] == call["id"] and message["call"]["ended_at"] is None
    assert message["call"]["started_by"] == str(alice.id)
    assert join["url"] == "wss://livekit.chat.test"
    claims = jwt.decode(join["token"], SECRET, algorithms=["HS256"])
    assert claims["video"]["room"] == call["id"] and claims["sub"] == str(alice.id)
    assert claims["name"] == "Alice"
    assert fake.rooms == {call["id"]: []}
    started_events = await events(db, "call.started")
    assert len(started_events) == 1 and started_events[0].seq is None
    assert started_events[0].audience_type == "channel"
    assert started_events[0].payload["call"]["id"] == call["id"]
    created = await events(db, "message.created")
    assert created[-1].payload["message"]["call"]["call_id"] == call["id"]

    # A retry: the same call and message, a fresh token, nothing new.
    again = await huddle(client, group["id"], key)
    assert again.status_code == 200
    assert again.json()["call"]["id"] == call["id"]
    assert again.json()["message"]["id"] == message["id"]
    # Another key while it runs: join it (no second call or message).
    as_user(bob)
    joining = await huddle(client, group["id"])
    assert joining.status_code == 200 and joining.json()["call"]["id"] == call["id"]
    assert joining.json()["message"]["id"] == message["id"]
    assert jwt.decode(joining.json()["join"]["token"], SECRET, algorithms=["HS256"])["sub"] == str(
        bob.id
    )
    assert (await client.get(f"{API}/channels/{group['id']}")).json()["last_seq"] == 1
    assert len(await events(db, "call.started")) == 1
    # Join by id, the call, the active list, the bootstrap.
    rejoin = await client.post(f"{API}/calls/{call['id']}/join")
    assert rejoin.status_code == 200 and rejoin.json()["call"]["id"] == call["id"]
    assert (await client.get(f"{API}/calls/{call['id']}")).json()["call"]["id"] == call["id"]
    active = (await client.get(f"{API}/calls?active=true")).json()["calls"]
    assert [c["id"] for c in active] == [call["id"]]
    boot = (await client.get(f"{API}/sync/bootstrap")).json()
    assert [c["id"] for c in boot["active_calls"]] == [call["id"]]

    # A client_msg_id used for an ordinary message is not a call.
    plain = str(uuid.uuid4())
    await client.post(
        f"{API}/channels/{group['id']}/messages", json={"client_msg_id": plain, "body": "hi"}
    )
    reused = await huddle(client, group["id"], plain)
    assert reused.status_code == 409 and reused.json()["error"]["code"] == "idempotency_conflict"


async def test_call_url_without_public_base_url(
    client: AsyncClient,
    db: AsyncSession,
    app: FastAPI,
    as_user: Callable[[User], None],
    fake: FakeLiveKitGateway,
) -> None:
    """Never a null url: an M117 Android client cannot read one (docs/CALLS.md §5.4)."""
    app.state.calls.public_base_url = ""
    alice = await make_user(db, "alice")
    as_user(alice)
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    out = (await huddle(client, general["id"])).json()
    assert out["message"]["call"]["url"] == f"/call/{out['call']['id']}"
    assert out["message"]["body"] == "🎧 通話を始めました"


async def test_who_may_start_and_join(
    client: AsyncClient,
    db: AsyncSession,
    app: FastAPI,
    as_user: Callable[[User], None],
    fake: FakeLiveKitGateway,
) -> None:
    admin = await make_user(db, "admin", role="admin")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    guest = await make_user(db, "guest", role="guest")
    bot = await make_user(db, "bot", role="bot")
    as_user(admin)
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    news = (await client.post(f"{API}/channels", json={"name": "news"})).json()
    for user in (bob, guest, bot):
        added = await client.post(
            f"{API}/channels/{general['id']}/members", json={"user_id": str(user.id)}
        )
        assert added.status_code == 200, added.text
    await client.post(f"{API}/channels/{news['id']}/members", json={"user_id": str(bob.id)})
    await client.patch(f"{API}/channels/{news['id']}", json={"posting_policy": "owners"})

    # Not a member (also of a public channel), an unknown channel, no key.
    as_user(carol)
    denied = await huddle(client, general["id"])
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_a_member"
    assert (await huddle(client, str(uuid.uuid4()))).status_code == 404
    bad = await client.post(f"{API}/channels/{general['id']}/huddle", json={})
    assert bad.status_code == 422
    # A guest in the conversation may (the posting rule).
    as_user(guest)
    started = await huddle(client, general["id"])
    assert started.status_code == 201
    call_id = started.json()["call"]["id"]
    # Carol cannot see or join it; bots never take part.
    as_user(carol)
    assert (await client.get(f"{API}/calls/{call_id}")).status_code == 403
    assert (await client.post(f"{API}/calls/{call_id}/join")).status_code == 403
    assert (await client.get(f"{API}/calls?active=true")).json()["calls"] == []
    as_user(bot)
    assert (await client.post(f"{API}/calls/{call_id}/join")).status_code == 403
    assert (await client.get(f"{API}/calls/{uuid.uuid4()}")).status_code == 404

    # An announcement channel: members join, only owners and administrators start.
    as_user(bob)
    restricted = await huddle(client, news["id"])
    assert restricted.status_code == 403
    assert restricted.json()["error"]["code"] == "posting_restricted"
    as_user(admin)
    assert (await huddle(client, news["id"])).status_code == 201
    as_user(bob)
    assert (await huddle(client, news["id"])).status_code == 200

    # The cap: two people at most here; a third is refused, someone already in is not.
    app.state.calls.config = LiveKitConfig(
        url=CONFIG.url,
        api_url=CONFIG.api_url,
        api_key="taylis",
        api_secret=SECRET,
        max_participants=2,
    )
    for user, sid in ((guest, "PA_g"), (bob, "PA_b")):
        assert (await webhook(client, joined(call_id, str(user.id), sid))).status_code == 200
    as_user(admin)
    full = await client.post(f"{API}/calls/{call_id}/join")
    assert full.status_code == 409 and full.json()["error"]["code"] == "call_full"
    as_user(bob)
    assert (await client.post(f"{API}/calls/{call_id}/join")).status_code == 200

    # Archived.
    as_user(admin)
    assert (await client.post(f"{API}/channels/{general['id']}/archive")).status_code == 200
    as_user(bob)
    archived = await client.post(f"{API}/calls/{call_id}/join")
    assert archived.status_code == 409 and archived.json()["error"]["code"] == "channel_archived"


async def test_blocks(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], fake: FakeLiveKitGateway
) -> None:
    """§7.2: a 1:1 DM with a block either way has no call; a group DM is not refused."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    dm = await dm_of(client, bob)
    group = await dm_of(client, bob, carol)
    started = await huddle(client, dm["id"])
    assert started.status_code == 201
    as_user(bob)
    assert (await client.put(f"{API}/users/{alice.id}/block")).status_code in (200, 201)
    # The blocker cannot join; the blocked cannot start or join either.
    refused = await client.post(f"{API}/calls/{started.json()['call']['id']}/join")
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "dm_unavailable"
    as_user(alice)
    assert (await huddle(client, dm["id"])).json()["error"]["code"] == "dm_unavailable"
    assert (await huddle(client, group["id"])).status_code == 201
    as_user(bob)
    assert (await huddle(client, group["id"])).status_code == 200


async def test_livekit_down_posts_nothing(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], fake: FakeLiveKitGateway
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    fake.unavailable = True
    down = await huddle(client, general["id"])
    assert down.status_code == 503 and down.json()["error"]["code"] == "calls_unavailable"
    assert (await client.get(f"{API}/channels/{general['id']}")).json()["last_seq"] == 0
    assert (await db.execute(select(Call))).scalars().all() == []
    assert await events(db, "message.created") == [] and await events(db, "call.started") == []
    fake.unavailable = False
    assert (await huddle(client, general["id"])).status_code == 201


async def test_rate_limits(
    client: AsyncClient,
    db: AsyncSession,
    app: FastAPI,
    as_user: Callable[[User], None],
    fake: FakeLiveKitGateway,
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    statuses = [(await huddle(client, general["id"])).status_code for _ in range(11)]
    assert statuses[0] == 201 and statuses[1:10] == [200] * 9 and statuses[10] == 429


# --- the webhook, leaving, ending ---------------------------------------------------------------


async def test_webhook_tracks_who_is_in_and_ends_the_call(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], fake: FakeLiveKitGateway
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    dm = await dm_of(client, bob)
    out = (await huddle(client, dm["id"])).json()
    call_id = out["call"]["id"]

    assert (await webhook(client, joined(call_id, str(alice.id), "PA_a1"))).status_code == 200
    assert (await webhook(client, joined(call_id, str(alice.id), "PA_a1"))).status_code == 200
    assert (await webhook(client, joined(call_id, str(bob.id), "PA_b1"))).status_code == 200
    state = (await client.get(f"{API}/calls/{call_id}")).json()["call"]
    assert [p["user_id"] for p in state["participants"]] == [str(alice.id), str(bob.id)]
    assert state["participant_count"] == 2 and state["peak_participants"] == 2
    updates = await events(db, "call.updated")
    assert len(updates) == 2 and all(e.seq is None for e in updates)
    # Bob moves to another device (a new sid), the old one's leave comes late.
    await webhook(client, joined(call_id, str(bob.id), "PA_b2"))
    await webhook(client, left(call_id, str(bob.id), "PA_b1"))
    state = (await client.get(f"{API}/calls/{call_id}")).json()["call"]
    assert len(state["participants"]) == 2 and state["participant_count"] == 2
    # A leave that comes before its join: the row is made closed; the join changes nothing.
    await webhook(client, left(call_id, str(bob.id), "PA_b3"))
    await webhook(client, joined(call_id, str(bob.id), "PA_b3"))
    rows = (
        (await db.execute(select(CallParticipant).where(CallParticipant.livekit_sid == "PA_b3")))
        .scalars()
        .all()
    )
    assert len(rows) == 1 and rows[0].left_at is not None
    # Unknown rooms, people and events are fine; a bad signature is not.
    assert (
        await webhook(client, joined(str(uuid.uuid4()), str(bob.id), "PA_z"))
    ).status_code == 200
    assert (await webhook(client, joined("not-ours", str(bob.id), "PA_z"))).status_code == 200
    assert (await webhook(client, joined(call_id, "someone", "PA_z"))).status_code == 200
    assert (await webhook(client, {"event": "track_published"})).status_code == 200
    forged = await webhook(
        client, joined(call_id, str(bob.id), "PA_f"), secret="guessed-" + "y" * 40
    )
    assert forged.status_code == 401
    expired = await webhook(client, joined(call_id, str(bob.id), "PA_f"), ttl=-3600)
    assert expired.status_code == 401
    body = json.dumps(joined(call_id, str(bob.id), "PA_f")).encode()
    swapped = await client.post(
        f"{API}/livekit/webhook",
        content=body.replace(b"PA_f", b"PA_g"),
        headers={"Authorization": sign(body)},
    )
    assert swapped.status_code == 401
    assert (
        await db.execute(
            select(CallParticipant).where(CallParticipant.livekit_sid.in_(["PA_f", "PA_g"]))
        )
    ).scalars().all() == []

    # Alice hangs up.
    assert (await client.post(f"{API}/calls/{call_id}/leave")).status_code == 204
    assert ("remove_participant", f"{call_id}/{alice.id}") in fake.calls
    state = (await client.get(f"{API}/calls/{call_id}")).json()["call"]
    assert [p["user_id"] for p in state["participants"]] == [str(bob.id)]

    # LiveKit closes the room: the call ends, its message shows the summary with a new seq.
    seq_before = (await client.get(f"{API}/channels/{dm['id']}")).json()["last_seq"]
    assert (await webhook(client, finished(call_id))).status_code == 200
    assert (await webhook(client, finished(call_id))).status_code == 200
    ended = (await client.get(f"{API}/calls/{call_id}")).json()["call"]
    assert ended["ended_at"] is not None and ended["participants"] == []
    assert ended["participant_count"] == 2 and ended["peak_participants"] == 2
    ended_events = await events(db, "call.ended")
    assert len(ended_events) == 1 and ended_events[0].payload["call"]["ended_at"]
    updated = [e for e in await events(db, "message.updated") if e.payload["change"] == "call"]
    assert len(updated) == 1 and updated[0].seq == seq_before + 1
    card = updated[0].payload["message"]["call"]
    assert card["ended_at"] and card["participant_count"] == 2
    assert card["duration_seconds"] is not None and card["duration_seconds"] >= 0
    history = (await client.get(f"{API}/channels/{dm['id']}/messages")).json()["messages"]
    assert history[0]["call"]["ended_at"] == card["ended_at"]
    assert (await client.get(f"{API}/calls?active=true")).json()["calls"] == []
    gone = await client.post(f"{API}/calls/{call_id}/join")
    assert gone.status_code == 409 and gone.json()["error"]["code"] == "call_ended"
    # A retry of the ended call's start: 409 call_ended; a new key starts a new call.
    retry = await huddle(client, dm["id"], out["message"]["client_msg_id"])
    assert retry.status_code == 409 and retry.json()["error"]["code"] == "call_ended"
    fresh = await huddle(client, dm["id"])
    assert fresh.status_code == 201 and fresh.json()["call"]["id"] != call_id
    assert (await client.post(f"{API}/calls/{call_id}/leave")).status_code == 204


# --- reconciling --------------------------------------------------------------------------------


async def reconcile(app: FastAPI, fake: FakeLiveKitGateway, now: Any = None) -> int:
    """In its own session, as the loop runs it (the test's session holds the acting user)."""
    async with app.state.db.session_factory() as session:
        return await calls.reconcile(session, fake, now=now)


async def _open_call(client: AsyncClient, channel_id: str) -> str:
    response = await huddle(client, channel_id)
    assert response.status_code == 201, response.text
    call_id: str = response.json()["call"]["id"]
    return call_id


async def test_reconcile_without_webhooks(
    client: AsyncClient,
    db: AsyncSession,
    app: FastAPI,
    as_user: Callable[[User], None],
    fake: FakeLiveKitGateway,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    await client.post(f"{API}/channels/{general['id']}/members", json={"user_id": str(bob.id)})
    call_id = await _open_call(client, general["id"])

    # Joined with no webhook: the reconcile adds them.
    fake.join(call_id, str(alice.id), "PA_a")
    fake.join(call_id, str(bob.id), "PA_b")
    assert await reconcile(app, fake) == 1
    state = (await client.get(f"{API}/calls/{call_id}")).json()["call"]
    assert {p["user_id"] for p in state["participants"]} == {str(alice.id), str(bob.id)}
    assert await reconcile(app, fake) == 0  # nothing changed
    # Left with no webhook.
    fake.rooms[call_id] = [p for p in fake.rooms[call_id] if p.sid != "PA_b"]
    assert await reconcile(app, fake) == 1
    state = (await client.get(f"{API}/calls/{call_id}")).json()["call"]
    assert [p["user_id"] for p in state["participants"]] == [str(alice.id)]

    # LiveKit down: nothing is ended.
    fake.rooms.clear()
    fake.unavailable = True
    with pytest.raises(LiveKitUnavailable):
        await reconcile(app, fake, now=utcnow() + timedelta(hours=1))
    assert (await client.get(f"{API}/calls/{call_id}")).json()["call"]["ended_at"] is None
    # Back, and the room is gone: ended after the grace.
    fake.unavailable = False
    assert await reconcile(app, fake) == 0  # just started: LiveKit may not list it yet
    assert await reconcile(app, fake, now=utcnow() + timedelta(seconds=31)) == 1
    ended = (await client.get(f"{API}/calls/{call_id}")).json()["call"]
    assert ended["ended_at"] is not None and ended["participants"] == []
    row = await db.get(Call, uuid.UUID(call_id))
    assert row is not None
    await db.refresh(row)
    assert row.end_reason == "reconciled"
    assert len(await events(db, "call.ended")) == 1


async def test_reconcile_ends_an_empty_room_and_cuts_off_people(
    client: AsyncClient,
    db: AsyncSession,
    app: FastAPI,
    as_user: Callable[[User], None],
    fake: FakeLiveKitGateway,
) -> None:
    alice = await make_user(db, "alice", role="admin")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    for user in (bob, carol):
        await client.post(f"{API}/channels/{general['id']}/members", json={"user_id": str(user.id)})
    call_id = await _open_call(client, general["id"])
    for user, sid in ((alice, "PA_a"), (bob, "PA_b"), (carol, "PA_c")):
        fake.join(call_id, str(user.id), sid)
    fake.join(call_id, "not-a-user", "PA_x")
    await reconcile(app, fake)
    assert ("remove_participant", f"{call_id}/not-a-user") in fake.calls

    # Bob is removed from the channel, Carol's account is deactivated: both are cut off.
    assert (
        await client.delete(f"{API}/channels/{general['id']}/members/{bob.id}")
    ).status_code == 204
    await db.execute(
        text("UPDATE users SET deactivated_at = now() WHERE id = :id"), {"id": carol.id}
    )
    await db.commit()
    await reconcile(app, fake)
    assert ("remove_participant", f"{call_id}/{bob.id}") in fake.calls
    assert ("remove_participant", f"{call_id}/{carol.id}") in fake.calls
    state = (await client.get(f"{API}/calls/{call_id}")).json()["call"]
    assert [p["user_id"] for p in state["participants"]] == [str(alice.id)]

    # Everyone gone, the room still listed: ended once it has been quiet two minutes.
    fake.rooms[call_id] = []
    await reconcile(app, fake)
    assert (await client.get(f"{API}/calls/{call_id}")).json()["call"]["ended_at"] is None
    await reconcile(app, fake, now=utcnow() + timedelta(seconds=121))
    assert (await client.get(f"{API}/calls/{call_id}")).json()["call"]["ended_at"] is not None
    assert ("delete_room", call_id) in fake.calls

    # Archiving ends the call and deletes the room.
    second = await _open_call(client, general["id"])
    fake.join(second, str(alice.id), "PA_a2")
    assert (await client.post(f"{API}/channels/{general['id']}/archive")).status_code == 200
    await reconcile(app, fake)
    row = await db.get(Call, uuid.UUID(second))
    assert row is not None
    await db.refresh(row)
    assert row.ended_at is not None and row.end_reason == "archived"
    assert second not in fake.rooms


class HeldListing:
    """Holds FakeLiveKitGateway.list_participants after it has read the room (the answer is
    LiveKit's state when asked) until released, so webhooks can run in between."""

    def __init__(self, fake: FakeLiveKitGateway) -> None:
        self.fake = fake
        self.asked = asyncio.Event()
        self.release = asyncio.Event()
        self.original = fake.list_participants

    async def list_participants(self, room: str) -> list[LiveKitParticipant]:
        answer = await self.original(room)
        self.asked.set()
        await self.release.wait()
        return answer

    async def reconcile_around(
        self, app: FastAPI, meanwhile: Callable[[], Awaitable[None]], now: Any = None
    ) -> int:
        self.fake.list_participants = self.list_participants  # type: ignore[method-assign]
        try:
            task = asyncio.create_task(reconcile(app, self.fake, now=now))
            await asyncio.wait_for(self.asked.wait(), 5)
            await meanwhile()
            self.release.set()
            return await asyncio.wait_for(task, 5)
        finally:
            self.fake.list_participants = self.original  # type: ignore[method-assign]


async def test_reconcile_racing_webhooks_converges_on_livekit(
    client: AsyncClient,
    db: AsyncSession,
    app: FastAPI,
    as_user: Callable[[User], None],
    fake: FakeLiveKitGateway,
) -> None:
    """Review v0.1.43 #5: a join (or leave) webhook handled while the reconcile waits for
    LiveKit's list must not be undone by that older list; a connection only a reconcile closed
    comes back when LiveKit still has it; a confirmed leave does not."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    await client.post(f"{API}/channels/{general['id']}/members", json={"user_id": str(bob.id)})
    call_id = await _open_call(client, general["id"])
    later = utcnow() + timedelta(seconds=300)  # an empty room would be ended by now

    async def participants() -> list[str]:
        state = (await client.get(f"{API}/calls/{call_id}")).json()["call"]
        assert state["ended_at"] is None
        return sorted(p["user_id"] for p in state["participants"])

    # Alice joins while the reconcile waits for the (empty) list.
    async def alice_joins() -> None:
        fake.join(call_id, str(alice.id), "PA_a")
        assert (await webhook(client, joined(call_id, str(alice.id), "PA_a"))).status_code == 200
        assert await participants() == [str(alice.id)]

    await HeldListing(fake).reconcile_around(app, alice_joins, now=later)
    assert await participants() == [str(alice.id)]  # not closed, the call not ended
    assert await reconcile(app, fake, now=later) == 0
    assert await participants() == [str(alice.id)]

    # Bob joins, then leaves while the reconcile holds a list that still has him.
    fake.join(call_id, str(bob.id), "PA_b")
    await webhook(client, joined(call_id, str(bob.id), "PA_b"))
    assert await participants() == sorted([str(alice.id), str(bob.id)])

    async def bob_leaves() -> None:
        fake.rooms[call_id] = [p for p in fake.rooms[call_id] if p.sid != "PA_b"]
        await webhook(client, left(call_id, str(bob.id), "PA_b"))

    await HeldListing(fake).reconcile_around(app, bob_leaves, now=later)
    assert await participants() == [str(alice.id)]  # the older list does not bring him back
    row = (
        await db.execute(select(CallParticipant).where(CallParticipant.livekit_sid == "PA_b"))
    ).scalar_one()
    assert row.left_at is not None and row.left_reason == "left"

    # A connection missing from one list (only the reconcile closed it) comes back with the
    # next list that has it.
    held = [p for p in fake.rooms[call_id] if p.sid == "PA_a"]
    fake.rooms[call_id] = []
    assert await reconcile(app, fake) == 1
    assert await participants() == []
    fake.rooms[call_id] = held
    assert await reconcile(app, fake, now=later) == 1
    assert await participants() == [str(alice.id)]
    # A late participant_joined changes nothing either way (the row exists).
    await webhook(client, joined(call_id, str(alice.id), "PA_a"))
    assert await participants() == [str(alice.id)]

    # Closed by a reconcile, then LiveKit confirms the leave: a stale list does not reopen it.
    fake.rooms[call_id] = []
    assert await reconcile(app, fake) == 1
    await webhook(client, left(call_id, str(alice.id), "PA_a"))
    fake.rooms[call_id] = held
    assert await reconcile(app, fake) == 0
    assert await participants() == []
    db.expire_all()
    reasons = dict(
        (await db.execute(select(CallParticipant.livekit_sid, CallParticipant.left_reason))).all()
    )
    assert reasons == {"PA_a": "left", "PA_b": "left"}


async def test_wake_events(fake: FakeLiveKitGateway, app: FastAPI) -> None:
    handler = calls.CallsWakeHandler(app.state.calls)
    for event_type, wakes in (
        ("channel.member_removed", True),
        ("channel.archived", True),
        ("user.deactivated", True),
        ("block.updated", True),
        ("message.created", False),
    ):
        app.state.calls.wake.clear()
        await handler.handle(None, OutboxEvent(event_type=event_type), None)  # type: ignore[arg-type]
        assert app.state.calls.wake.is_set() is wakes


# --- pushes -------------------------------------------------------------------------------------


async def test_call_push_says_who_started_it(
    app: FastAPI, db: AsyncSession, test_settings: Settings, fake: FakeLiveKitGateway
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    await add_device(db, bob)
    await add_device(db, carol, token="tok-c")
    group, _ = await channels.get_or_create_dm(db, alice, [bob, carol])
    rt = app.state.calls
    started = await calls.huddle(db, rt, alice, group.id, uuid.uuid4())
    assert started.created

    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    rows = await deliveries(db)
    assert {r.payload["body"] for r in rows} == {"🎧 Alice さんが通話を始めました"}
    assert len(rows) == 2
    # Joining, leaving and ending push nothing.
    locked = await calls.get_call(db, started.call.id, for_update=True)
    assert locked is not None
    await calls.end_call_in_tx(db, locked, "admin")
    await db.commit()
    while await relay.process_batch():
        pass
    assert len(await deliveries(db)) == 2

    # In the reader's language; nothing from someone Carol blocked.
    await db.execute(text("UPDATE users SET locale = 'en' WHERE id = :id"), {"id": bob.id})
    await db.execute(
        text("INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (:a, :b)"),
        {"a": carol.id, "b": alice.id},
    )
    await db.commit()
    await calls.huddle(db, rt, alice, group.id, uuid.uuid4())
    while await relay.process_batch():
        pass
    rows = await deliveries(db)
    assert [r.payload["body"] for r in rows[2:]] == ["🎧 Alice started a call"]


async def test_message_card_counts(
    db: AsyncSession, app: FastAPI, fake: FakeLiveKitGateway
) -> None:
    alice = await make_user(db, "alice")
    dm, _ = await channels.get_or_create_dm(db, alice, [])
    started = await calls.huddle(db, app.state.calls, alice, dm.id, uuid.uuid4())
    message = await db.get(Message, started.message.id)
    assert message is not None and message.call_id == started.call.id
