"""POST /threads/read-all (THREADS.md §3, 2026-10-09): the threads list's 「すべて既読にする」."""

import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.users.models import User
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> Any:
    payload = {"client_msg_id": str(uuid.uuid4()), "body": body, **extra}
    response = await client.post(f"/api/v1/channels/{channel_id}/messages", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _thread(client: AsyncClient, parent_id: str) -> Any:
    return (await client.get(f"/api/v1/messages/{parent_id}/thread")).json()


async def _read_all_events(db: AsyncSession) -> list[OutboxEvent]:
    stmt = select(OutboxEvent).where(OutboxEvent.event_type == "threads.read_all")
    return list((await db.execute(stmt.order_by(OutboxEvent.id))).scalars())


async def test_read_all_marks_my_followed_threads_only(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    await db.execute(update(User).values(activity_read_at=utcnow() - timedelta(hours=1)))
    await db.commit()

    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    for other in (bob, carol):
        as_user(other)
        await client.post(f"/api/v1/channels/{general['id']}/join")
    as_user(bob)
    left = (await client.post("/api/v1/channels", json={"name": "left"})).json()
    as_user(alice)
    await client.post(f"/api/v1/channels/{left['id']}/join")

    # mine: alice's parent, carol replies (follows), bob replies mentioning alice.
    mine = await _post(client, general["id"], "plan")
    as_user(carol)
    await _post(client, general["id"], "carol's reply", parent_id=mine["id"])
    as_user(bob)
    mention = await _post(client, general["id"], f"<@{alice.id}> look", parent_id=mine["id"])
    # joined: bob's parent, alice replies (follows), bob replies again.
    joined = await _post(client, general["id"], "bob's topic")
    as_user(alice)
    await _post(client, general["id"], "alice's reply", parent_id=joined["id"])
    as_user(bob)
    latest = await _post(client, general["id"], "bob again", parent_id=joined["id"])
    # unfollowed: alice's parent with a reply, then alice unfollows by hand.
    as_user(alice)
    dropped = await _post(client, general["id"], "unfollowed topic")
    as_user(bob)
    await _post(client, general["id"], "reply", parent_id=dropped["id"])
    as_user(alice)
    r = await client.put(
        f"/api/v1/messages/{dropped['id']}/thread/follow", json={"following": False}
    )
    assert r.status_code == 200
    # gone: alice's parent in a channel she then leaves.
    gone = await _post(client, left["id"], "elsewhere")
    as_user(bob)
    gone_reply = await _post(client, left["id"], "reply", parent_id=gone["id"])
    as_user(alice)
    assert (await client.post(f"/api/v1/channels/{left['id']}/leave")).status_code == 204

    before = (await client.get("/api/v1/sync/bootstrap")).json()["threads"]
    assert before == {"unread_count": 2, "mention_count": 1}
    activity = (await client.get("/api/v1/activity/summary")).json()
    assert activity["unread_count"] >= 2 and activity["mention_unread"] is True
    as_user(carol)
    carol_before = await _thread(client, mine["id"])
    assert carol_before["unread_count"] == 1

    as_user(alice)
    response = await client.post("/api/v1/threads/read-all")
    assert response.status_code == 200, response.text
    out = response.json()
    assert out["summary"] == {"unread_count": 0, "mention_count": 0}
    moved = {t["parent_id"]: t for t in out["threads"]}
    assert set(moved) == {mine["id"], joined["id"]}
    assert moved[mine["id"]] == {
        "parent_id": mine["id"],
        "channel_id": general["id"],
        "last_read_seq": mention["seq"],
        "unread_count": 0,
        "mention_count": 0,
    }
    assert moved[joined["id"]]["last_read_seq"] == latest["seq"]

    assert (await _thread(client, mine["id"]))["unread_count"] == 0
    assert (await _thread(client, dropped["id"]))["unread_count"] == 1  # not followed: kept
    assert (await client.get("/api/v1/sync/bootstrap")).json()["threads"]["unread_count"] == 0
    # The activity items of those replies are read by the thread positions (MOBILE_UI.md §6.4).
    activity = (await client.get("/api/v1/activity/summary")).json()
    assert activity["unread_count"] == 0 and activity["mention_unread"] is False
    feed = (await client.get("/api/v1/activity", params={"filter": "threads"})).json()
    assert feed["items"] and all(item["read"] for item in feed["items"])

    # Other people are untouched.
    as_user(carol)
    assert (await _thread(client, mine["id"]))["last_read_seq"] == carol_before["last_read_seq"]
    assert (await _thread(client, mine["id"]))["unread_count"] == 1

    # One event to alice's devices with the same body as the response.
    events = await _read_all_events(db)
    assert len(events) == 1
    assert events[0].audience_type == "user" and events[0].audience_id == alice.id
    assert events[0].payload == out

    # Idempotent: nothing moves, no new event.
    as_user(alice)
    again = (await client.post("/api/v1/threads/read-all")).json()
    assert again == {"summary": {"unread_count": 0, "mention_count": 0}, "threads": []}
    assert len(await _read_all_events(db)) == 1

    # Rejoining the left channel: its thread was not read.
    await client.post(f"/api/v1/channels/{left['id']}/join")
    assert (await _thread(client, gone["id"]))["last_read_seq"] < gone_reply["seq"]


async def test_read_all_never_moves_backwards(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")
    as_user(alice)
    parent = await _post(client, general["id"], "topic")
    as_user(bob)
    first = await _post(client, general["id"], "one", parent_id=parent["id"])
    second = await _post(client, general["id"], "two", parent_id=parent["id"])
    # The newest reply is deleted: the position is the newest live reply, and an existing
    # position beyond it stays.
    as_user(alice)
    r = await client.put(
        f"/api/v1/messages/{parent['id']}/thread/read", json={"last_read_seq": second["seq"]}
    )
    assert r.json()["last_read_seq"] == second["seq"]
    as_user(bob)
    assert (await client.delete(f"/api/v1/messages/{second['id']}")).status_code == 200
    as_user(alice)
    out = (await client.post("/api/v1/threads/read-all")).json()
    assert out["threads"] == []
    assert (await _thread(client, parent["id"]))["last_read_seq"] == second["seq"]
    assert first["seq"] < second["seq"]
