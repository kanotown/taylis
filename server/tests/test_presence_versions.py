"""Review v0.1.49 #5: a WebSocket registers its user's presence flags (オフライン表示, 離席中)
as read when it authenticated; a change made on another device meanwhile must win (PRESENCE.md
§11.4). The hub keeps the flags' version (users.updated_at) and ignores older ones."""

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
import websockets

from app.modules.auth.service import AuthContext
from app.realtime import router as rt
from app.realtime.hub import RealtimeHub
from tests.conftest import LiveServer
from tests.helpers import http_login, make_user
from tests.test_realtime import PASSWORD, _connect, _recv, _recv_presence


def _presence_of(conn: Any, user_id: uuid.UUID) -> list[str]:
    frames = [conn.queue.get_nowait() for _ in range(conn.queue.qsize())]
    return [
        f["status"]
        for f in frames
        if f.get("type") == "presence" and f.get("user_id") == str(user_id)
    ]


def test_hub_keeps_the_newest_flags() -> None:
    hub = RealtimeHub()
    user, watcher = uuid.uuid4(), uuid.uuid4()
    seen = hub.new_connection(watcher, uuid.uuid4())
    t0 = datetime(2026, 10, 10, tzinfo=UTC)
    hub.set_presence_flags(user, hidden=True, away=False, version=t0 + timedelta(seconds=2))
    # A socket whose snapshot is older (not hidden, read before the change) does not undo it.
    hub.new_connection(user, uuid.uuid4(), presence_hidden=False, presence_version=t0)
    assert hub.presence_status(user) == "offline"
    # Neither does one without a version, nor a slower request with an older row.
    hub.new_connection(user, uuid.uuid4())
    hub.set_presence_flags(user, hidden=False, away=True, version=t0 + timedelta(seconds=1))
    assert hub.presence_status(user) == "offline"
    assert _presence_of(seen, user) == []
    # The same version (the same row) or a newer one applies.
    hub.set_presence_flags(user, hidden=True, away=False, version=t0 + timedelta(seconds=2))
    hub.new_connection(
        user, uuid.uuid4(), presence_away=True, presence_version=t0 + timedelta(seconds=3)
    )
    assert hub.presence_status(user) == "away"
    assert _presence_of(seen, user) == ["away"]


async def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _set(client: httpx.AsyncClient, token: str, change: tuple[str, Any]) -> dict[str, Any]:
    kind, value = change
    headers = await _bearer(token)
    if kind == "put":
        response = await client.put(
            "/api/v1/users/me/presence", json={"status": value}, headers=headers
        )
    else:  # the settings' 在席を隠す (older clients): PATCH presence_hidden alone
        response = await client.patch(
            "/api/v1/users/me", json={"presence_hidden": value}, headers=headers
        )
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


@pytest.mark.parametrize(
    ("before", "change", "expected", "manual"),
    [
        # test_ws_started_before_invisible_republishes_online (the review's scenario).
        (None, ("put", "invisible"), "offline", None),
        (("put", "away"), ("put", "invisible"), "offline", None),
        (None, ("put", "away"), "away", "away"),
        (("put", "invisible"), ("put", "away"), "away", "away"),
        (("put", "away"), ("put", "auto"), "online", None),
        (("put", "invisible"), ("put", "auto"), "online", None),
        (None, ("patch", True), "offline", None),
        # PATCH moves presence_hidden alone: the manual away stays under it.
        (("put", "away"), ("patch", True), "offline", "away"),
        (("patch", True), ("patch", False), "online", None),
    ],
)
async def test_ws_registered_after_a_change_keeps_it(
    live: LiveServer,
    monkeypatch: pytest.MonkeyPatch,
    before: tuple[str, Any] | None,
    change: tuple[str, Any],
    expected: str,
    manual: str | None,
) -> None:
    async with live.app.state.db.session_factory() as db:
        alice = await make_user(db, "alice", password=PASSWORD)
        await make_user(db, "bob", password=PASSWORD)
    a = await http_login(live.base_url, "alice", PASSWORD)
    b = await http_login(live.base_url, "bob", PASSWORD)
    hub: RealtimeHub = live.app.state.hub
    watcher = await _connect(live, b["access_token"])

    entered, release = asyncio.Event(), asyncio.Event()
    original = rt._authenticate

    async def paused(websocket: Any, settings: Any) -> AuthContext | None:
        context = await original(websocket, settings)
        if context is not None and context.user.id == alice.id:
            entered.set()
            await asyncio.wait_for(release.wait(), 10)
        return context

    monkeypatch.setattr(rt, "_authenticate", paused)
    async with httpx.AsyncClient(base_url=live.base_url) as client:
        if before is not None:
            await _set(client, a["access_token"], before)
        ws = await websockets.connect(live.ws_url)
        try:
            await ws.send(json.dumps({"type": "auth", "token": a["access_token"]}))
            await asyncio.wait_for(entered.wait(), 10)
            # Another device changes the status after this socket read alice's row.
            await _set(client, a["access_token"], change)
            assert hub.presence_status(alice.id) == "offline"  # not connected yet
            release.set()
            assert (await _recv(ws))["type"] == "hello"
            # Registered: the hub, REST and what others are told agree with the change.
            assert hub.presence_status(alice.id) == expected
            me = await client.get("/api/v1/users/me", headers=await _bearer(a["access_token"]))
            assert me.json()["presence_hidden"] is (expected == "offline")
            assert me.json()["presence_manual"] == manual
            if expected == "offline":
                # Nothing was announced: the next frame about alice is the one a later choice
                # makes (a stale online would come first).
                await _set(client, a["access_token"], ("put", "away"))
                assert await _recv_presence(watcher, str(alice.id)) == "away"
            else:
                assert await _recv_presence(watcher, str(alice.id)) == expected
        finally:
            release.set()
            await ws.close()
            await watcher.close()
