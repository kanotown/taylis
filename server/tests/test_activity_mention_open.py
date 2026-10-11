"""2026-10-12 (SYNC_PROTOCOL.md §10.7, MOBILE_UI.md §6.4): opening a mention from the activity
(PUT /activity/items/read) reads its conversation up to it, and its thread for a reply, so the
channel's (thread's) mention badge goes on every device. Later messages stay unread.

User report: mentions handled from the activity left the channel's mention badge, because the
conversation opened at the mention (a window around it) never moves the read position."""

import uuid
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from tests.helpers import make_user

API = "/api/v1"
Actor = Callable[[User], None]


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> Any:
    payload = {"client_msg_id": str(uuid.uuid4()), "body": body, **extra}
    response = await client.post(f"{API}/channels/{channel_id}/messages", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _open(client: AsyncClient, *ids: str) -> dict[str, Any]:
    r = await client.put(f"{API}/activity/items/read", json={"item_ids": list(ids)})
    assert r.status_code == 200, r.text
    return dict(r.json())


async def _state(client: AsyncClient, channel_id: str) -> dict[str, Any]:
    """The read state as it is (a mark at 0 moves nothing)."""
    r = await client.put(f"{API}/channels/{channel_id}/read", json={"last_read_seq": 0})
    assert r.status_code == 200, r.text
    return dict(r.json())


async def _thread(client: AsyncClient, parent_id: str) -> dict[str, Any]:
    r = await client.get(f"{API}/messages/{parent_id}/thread")
    assert r.status_code == 200, r.text
    return dict(r.json())


async def _events(db: AsyncSession, kind: str) -> list[OutboxEvent]:
    stmt = select(OutboxEvent).where(OutboxEvent.event_type == kind)
    return list((await db.execute(stmt)).scalars().all())


async def _clear_events(db: AsyncSession) -> None:
    await db.execute(delete(OutboxEvent))
    await db.commit()


async def _setup(client: AsyncClient, db: AsyncSession, as_user: Actor) -> tuple[User, User, str]:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    as_user(bob)
    await client.post(f"{API}/channels/{general['id']}/join")
    return alice, bob, str(general["id"])


async def test_opening_a_mention_reads_the_channel_up_to_it(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice, _bob, general = await _setup(client, db, as_user)
    await _post(client, general, "before")
    mention = await _post(client, general, f"<@{alice.id}> look")
    await _post(client, general, "after 1")
    await _post(client, general, "after 2")
    as_user(alice)
    assert (await _state(client, general))["mention_count"] == 1
    await _clear_events(db)

    summary = await _open(client, mention["id"])
    assert summary["unread_count"] == 0 and summary["mention_unread"] is False
    state = await _state(client, general)
    # Read up to the mention: its badge is gone, the two later messages stay unread.
    assert state["last_read_seq"] == mention["seq"]
    assert state["mention_count"] == 0 and state["unread_count"] == 2
    # My devices follow (read.updated, an advance).
    [event] = await _events(db, "read.updated")
    assert event.audience_type == "user" and event.audience_id == alice.id
    assert event.payload["reason"] == "advance" and event.payload["mention_count"] == 0
    assert event.payload["last_read_seq"] == mention["seq"]

    # Opening it again moves nothing (nor back, after reading further).
    await client.put(f"{API}/channels/{general}/read", json={"last_read_seq": mention["seq"] + 2})
    await _open(client, mention["id"])
    assert (await _state(client, general))["last_read_seq"] == mention["seq"] + 2


async def test_a_mention_already_read_in_the_activity_still_reads_the_channel(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    """「すべて既読にする」 read the item (not the channel); opening it later still clears
    the badge."""
    alice, _bob, general = await _setup(client, db, as_user)
    mention = await _post(client, general, f"<@{alice.id}> look")
    as_user(alice)
    r = await client.put(f"{API}/activity/read", json={"read_at": mention["created_at"]})
    assert r.status_code == 200, r.text
    assert (await _state(client, general))["mention_count"] == 1
    await _open(client, mention["id"])
    assert (await _state(client, general))["mention_count"] == 0


async def test_a_mention_in_a_reply_reads_its_thread_and_the_channel_when_also_sent_there(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice, bob, general = await _setup(client, db, as_user)
    parent = await _post(client, general, "a topic")
    await _post(client, general, "first reply", parent_id=parent["id"])
    in_thread = await _post(client, general, f"<@{alice.id}> here", parent_id=parent["id"])
    await _post(client, general, "later reply", parent_id=parent["id"])
    as_user(alice)
    before = await _state(client, general)
    await _clear_events(db)

    await _open(client, in_thread["id"])
    thread = await _thread(client, parent["id"])
    assert thread["last_read_seq"] == in_thread["seq"]
    assert thread["mention_count"] == 0 and thread["unread_count"] == 1
    # A reply only in the thread is no channel row: the channel's position stays.
    assert (await _state(client, general))["last_read_seq"] == before["last_read_seq"]
    assert [e.payload["reason"] for e in await _events(db, "thread.updated")] == ["read"]
    assert await _events(db, "read.updated") == []

    # Sent to the channel too: both positions move, both badges go.
    as_user(bob)
    shared = await _post(
        client, general, f"<@{alice.id}> also", parent_id=parent["id"], also_in_channel=True
    )
    await _post(client, general, "after")
    as_user(alice)
    assert (await _state(client, general))["mention_count"] == 1
    await _open(client, shared["id"])
    state = await _state(client, general)
    assert state["last_read_seq"] == shared["seq"]
    assert state["mention_count"] == 0 and state["unread_count"] == 1
    assert (await _thread(client, parent["id"]))["last_read_seq"] == shared["seq"]


async def test_other_items_and_other_peoples_conversations_move_nothing(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice, bob, general = await _setup(client, db, as_user)
    as_user(alice)
    mine = await _post(client, general, "my plan")
    as_user(bob)
    await client.put(f"{API}/messages/{mine['id']}/reactions/👍")
    reply = await _post(client, general, "a reply", parent_id=mine["id"])
    await _post(client, general, "after")
    secret = (await client.post(f"{API}/channels", json={"name": "s", "type": "private"})).json()
    hidden = await _post(client, secret["id"], f"<@{alice.id}> not for you")
    as_user(alice)
    before = await _state(client, general)
    thread_before = await _thread(client, mine["id"])
    await _clear_events(db)

    # A reaction item (my own message), a reply that does not mention me, a mention in a
    # conversation I am not in: no position moves.
    await _open(client, mine["id"], reply["id"], hidden["id"])
    assert (await _state(client, general))["last_read_seq"] == before["last_read_seq"]
    assert (await _thread(client, mine["id"]))["last_read_seq"] == thread_before["last_read_seq"]
    assert await _events(db, "read.updated") == []
    assert await _events(db, "thread.updated") == []
