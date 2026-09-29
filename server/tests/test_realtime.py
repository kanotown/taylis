"""WebSocket delivery over a real uvicorn server (SYNC_PROTOCOL.md §5, §7)."""

import asyncio
import json
import uuid
from typing import Any

import httpx
import pytest
import websockets
from sqlalchemy import func, select

from app.events.models import OutboxEvent
from tests.conftest import LiveServer
from tests.helpers import http_login, make_user

PASSWORD = "correct-horse-battery"


async def _recv(ws: websockets.ClientConnection, wait: float = 5.0) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(await asyncio.wait_for(ws.recv(), wait))
    return data


async def _connect(live: LiveServer, token: str) -> websockets.ClientConnection:
    ws = await websockets.connect(live.ws_url)
    await ws.send(json.dumps({"type": "auth", "token": token}))
    hello = await _recv(ws)
    assert hello["type"] == "hello" and hello["heartbeat_interval_sec"] == 1
    return ws


async def _recv_type(
    ws: websockets.ClientConnection, kind: str, wait: float = 5.0
) -> dict[str, Any]:
    """The next frame of `kind`, skipping others (presence announcements arrive at any time)."""
    deadline = asyncio.get_running_loop().time() + wait
    while True:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise TimeoutError(kind)
        frame = await _recv(ws, remaining)
        if frame["type"] == kind:
            return frame


async def _recv_presence(ws: websockets.ClientConnection, user_id: str, wait: float = 5.0) -> str:
    deadline = asyncio.get_running_loop().time() + wait
    while True:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise TimeoutError("presence " + user_id)
        frame = await _recv_type(ws, "presence", remaining)
        if frame["user_id"] == user_id:
            return str(frame["status"])


async def _close_code(ws: websockets.ClientConnection) -> int:
    with pytest.raises(websockets.ConnectionClosed) as excinfo:
        await asyncio.wait_for(ws.recv(), 5.0)
    assert excinfo.value.rcvd is not None
    return int(excinfo.value.rcvd.code)


async def _wait_outbox_drained(live: LiveServer) -> None:
    """Setup steps emit events too; wait until the relay has delivered them."""
    for _ in range(200):
        async with live.app.state.db.session_factory() as db:
            pending = await db.scalar(
                select(func.count())
                .select_from(OutboxEvent)
                .where(OutboxEvent.processed_at.is_(None))
            )
        if not pending:
            return
        await asyncio.sleep(0.05)
    raise AssertionError("outbox was not drained by the relay")


async def _setup(live: LiveServer) -> tuple[dict[str, Any], dict[str, Any], str]:
    async with live.app.state.db.session_factory() as db:
        await make_user(db, "alice", password=PASSWORD)
        await make_user(db, "bob", password=PASSWORD)
    alice = await http_login(live.base_url, "alice", PASSWORD)
    bob = await http_login(live.base_url, "bob", PASSWORD)
    async with httpx.AsyncClient(base_url=live.base_url) as client:
        auth = {"Authorization": f"Bearer {alice['access_token']}"}
        created = await client.post("/api/v1/channels", json={"name": "general"}, headers=auth)
        channel = created.json()
        bob_auth = {"Authorization": f"Bearer {bob['access_token']}"}
        await client.post(f"/api/v1/channels/{channel['id']}/join", headers=bob_auth)
    await _wait_outbox_drained(live)
    return alice, bob, str(channel["id"])


async def _post(
    live: LiveServer, tokens: dict[str, Any], channel_id: str, body: str
) -> dict[str, Any]:
    async with httpx.AsyncClient(base_url=live.base_url) as client:
        response = await client.post(
            f"/api/v1/channels/{channel_id}/messages",
            json={"client_msg_id": str(uuid.uuid4()), "body": body},
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        assert response.status_code == 201, response.text
        data: dict[str, Any] = response.json()
        return data


async def test_ws_rejects_missing_or_invalid_auth(live: LiveServer) -> None:
    ws = await websockets.connect(live.ws_url)
    await ws.send(json.dumps({"type": "ping"}))
    error = await _recv(ws)
    assert error["type"] == "error" and error["code"] == "auth_required"
    assert await _close_code(ws) == 4001

    ws = await websockets.connect(live.ws_url)
    await ws.send(json.dumps({"type": "auth", "token": "not-a-token"}))
    error = await _recv(ws)
    assert error["type"] == "error" and error["code"] == "invalid_token"
    assert await _close_code(ws) == 4001

    ws = await websockets.connect(live.ws_url)  # silence: auth timeout (0.5 s in tests)
    error = await _recv(ws)
    assert error["type"] == "error" and error["code"] == "auth_required"
    assert await _close_code(ws) == 4001


async def test_ws_hello_ping_and_live_message_events(live: LiveServer) -> None:
    alice, bob, channel_id = await _setup(live)
    ws = await _connect(live, bob["access_token"])
    await ws.send(json.dumps({"type": "ping", "active": True}))
    pong = await _recv_type(ws, "pong")  # presence announcements may come first
    assert pong["type"] == "pong"
    assert live.app.state.hub.is_active(uuid.UUID(bob["user"]["id"]), within_seconds=5)

    posted = await _post(live, alice, channel_id, "hello bob")
    event = await _recv_type(ws, "event")
    assert event["type"] == "event" and event["event"] == "message.created"
    assert event["channel_id"] == channel_id and event["seq"] == 1
    assert event["data"]["message"]["id"] == posted["id"]
    assert event["data"]["message"]["body"] == "hello bob"

    await ws.send("not json")
    error = await _recv_type(ws, "error")
    assert error["type"] == "error" and error["code"] == "invalid_frame"
    await ws.close()


async def test_ws_events_missed_while_disconnected_are_recovered_by_delta(
    live: LiveServer,
) -> None:
    alice, bob, channel_id = await _setup(live)
    ws = await _connect(live, bob["access_token"])
    await _post(live, alice, channel_id, "m1")
    assert (await _recv_type(ws, "event"))["seq"] == 1
    await ws.close()

    await _post(live, alice, channel_id, "m2")
    await _post(live, alice, channel_id, "m3")

    async with httpx.AsyncClient(base_url=live.base_url) as client:
        auth = {"Authorization": f"Bearer {bob['access_token']}"}
        bootstrap = (await client.get("/api/v1/sync/bootstrap", headers=auth)).json()
        assert bootstrap["channels"][0]["last_seq"] == 3
        response = await client.get(
            f"/api/v1/channels/{channel_id}/sync", params={"since_seq": 1}, headers=auth
        )
        delta = response.json()
        assert [m["body"] for m in delta["messages"]] == ["m2", "m3"]
        assert delta["next_since_seq"] == 3 and delta["has_more"] is False

    ws = await _connect(live, bob["access_token"])
    await _post(live, alice, channel_id, "m4")
    # The relay polls, so m3's event may still be published after the reconnect; a late event
    # for a seq the delta already brought is allowed (clients drop it by seq).
    event = await _recv_type(ws, "event")
    while event["seq"] < 4:
        event = await _recv_type(ws, "event")
    assert event["seq"] == 4 and event["data"]["message"]["body"] == "m4"
    await ws.close()


async def test_ws_is_closed_when_the_session_is_revoked(live: LiveServer) -> None:
    _alice, bob, _channel = await _setup(live)
    ws = await _connect(live, bob["access_token"])
    async with httpx.AsyncClient(base_url=live.base_url) as client:
        response = await client.post(
            "/api/v1/auth/logout", headers={"Authorization": f"Bearer {bob['access_token']}"}
        )
        assert response.status_code == 204
    event = await _recv_type(ws, "event")
    assert event["event"] == "session.revoked" and event["data"]["reason"] == "logout"
    assert await _close_code(ws) == 4003


async def test_ws_membership_events_reach_the_new_member(live: LiveServer) -> None:
    alice, bob, _ = await _setup(live)
    ws = await _connect(live, bob["access_token"])
    async with httpx.AsyncClient(base_url=live.base_url) as client:
        auth = {"Authorization": f"Bearer {alice['access_token']}"}
        created = await client.post(
            "/api/v1/channels", json={"type": "private", "name": "secret"}, headers=auth
        )
        private = created.json()
        await client.post(
            f"/api/v1/channels/{private['id']}/members",
            json={"user_id": bob["user"]["id"]},
            headers=auth,
        )
    received = {}
    for _ in range(2):
        event = await _recv_type(ws, "event")
        received[event["event"]] = event
    assert set(received) == {"channel.member_added", "channel.created"}
    assert received["channel.created"]["data"]["channel"]["name"] == "secret"
    assert bob["user"]["id"] in received["channel.created"]["data"]["member_ids"]
    await ws.close()


async def test_presence_follows_connections_pings_and_the_sweep(live: LiveServer) -> None:
    alice, bob, _channel_id = await _setup(live)
    alice_id, bob_id = alice["user"]["id"], bob["user"]["id"]
    hub = live.app.state.hub
    hub.away_seconds = 0.3  # the activity window lapses quickly in this test

    bob_ws = await _connect(live, bob["access_token"])
    assert await _recv_presence(bob_ws, bob_id) == "online"  # own announcement
    # bootstrap lists who is connected right now.
    async with httpx.AsyncClient(base_url=live.base_url) as client:
        auth = {"Authorization": f"Bearer {alice['access_token']}"}
        boot = (await client.get("/api/v1/sync/bootstrap", headers=auth)).json()
    assert boot["presence"] == [{"user_id": bob_id, "status": "online"}]

    alice_ws = await _connect(live, alice["access_token"])
    assert await _recv_presence(bob_ws, alice_id) == "online"

    # No activity for away_seconds: the sweep announces away; a ping with active=true undoes it.
    await asyncio.sleep(0.4)
    hub.sweep_presence()
    assert await _recv_presence(bob_ws, alice_id) == "away"
    await alice_ws.send(json.dumps({"type": "ping", "active": True}))
    assert (await _recv_type(alice_ws, "pong"))["type"] == "pong"
    assert await _recv_presence(bob_ws, alice_id) == "online"
    assert hub.presence_status(uuid.UUID(alice_id)) == "online"

    # The last connection going away is offline; a second connection of the same user is not.
    alice_ws2 = await _connect(live, alice["access_token"])
    await alice_ws.close()
    await asyncio.sleep(0.2)
    assert hub.presence_status(uuid.UUID(alice_id)) == "online"
    await alice_ws2.close()
    assert await _recv_presence(bob_ws, alice_id) == "offline"
    await bob_ws.close()


async def test_typing_reaches_other_members_only_and_is_rate_limited(live: LiveServer) -> None:
    alice, bob, channel_id = await _setup(live)
    async with live.app.state.db.session_factory() as db:
        await make_user(db, "carol", password=PASSWORD)
    carol = await http_login(live.base_url, "carol", PASSWORD)
    alice_ws = await _connect(live, alice["access_token"])
    bob_ws = await _connect(live, bob["access_token"])
    carol_ws = await _connect(live, carol["access_token"])

    await alice_ws.send(json.dumps({"type": "typing", "channel_id": channel_id}))
    frame = await _recv_type(bob_ws, "typing")
    assert frame == {
        "type": "typing",
        "channel_id": channel_id,
        "parent_id": None,
        "user_id": alice["user"]["id"],
    }
    # A second frame inside the interval is dropped; carol (not a member) never sees any.
    await alice_ws.send(json.dumps({"type": "typing", "channel_id": channel_id}))
    with pytest.raises(TimeoutError):
        await _recv_type(bob_ws, "typing", wait=0.5)
    with pytest.raises(TimeoutError):
        await _recv_type(carol_ws, "typing", wait=0.3)
    # Typing from a non-member is ignored; the sender never gets their own indicator.
    await carol_ws.send(json.dumps({"type": "typing", "channel_id": channel_id}))
    with pytest.raises(TimeoutError):
        await _recv_type(bob_ws, "typing", wait=0.5)
    with pytest.raises(TimeoutError):
        await _recv_type(alice_ws, "typing", wait=0.3)
    for ws in (alice_ws, bob_ws, carol_ws):
        await ws.close()
