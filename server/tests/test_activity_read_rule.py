"""2026-10-06 (MOBILE_UI.md §6.4): a mention or a thread reply read in its conversation is read in
the activity feed too (the badge, `read` on the items); the other kinds keep the read position."""

import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import build_settings
from app.core.time import utcnow
from app.modules.notifications.planner import PushPlanner
from app.modules.users.models import User
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> Any:
    payload = {"client_msg_id": str(uuid.uuid4()), "body": body, **extra}
    response = await client.post(f"/api/v1/channels/{channel_id}/messages", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _summary(client: AsyncClient) -> Any:
    return (await client.get("/api/v1/activity/summary")).json()


async def _read_flags(client: AsyncClient) -> dict[tuple[str, str], bool]:
    feed = (await client.get("/api/v1/activity")).json()
    return {(i["kind"], i["message"]["id"]): i["read"] for i in feed["items"]}


async def _read_channel(client: AsyncClient, channel_id: str, seq: int) -> None:
    r = await client.put(f"/api/v1/channels/{channel_id}/read", json={"last_read_seq": seq})
    assert r.status_code == 200, r.text


async def _read_thread(client: AsyncClient, parent_id: str, seq: int) -> None:
    r = await client.put(f"/api/v1/messages/{parent_id}/thread/read", json={"last_read_seq": seq})
    assert r.status_code == 200, r.text


async def _setup(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> tuple[User, User, User, dict[str, Any]]:
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
    return alice, bob, carol, general


async def test_reads_in_the_conversation_clear_the_activity_items(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice, bob, carol, general = await _setup(client, db, as_user)
    as_user(alice)
    mine = await _post(client, general["id"], "my plan")
    as_user(bob)
    await client.put(f"/api/v1/messages/{mine['id']}/reactions/👍")
    mention = await _post(client, general["id"], f"<@{alice.id}> <@{carol.id}> look")
    reply = await _post(client, general["id"], "a reply", parent_id=mine["id"])
    later = await _post(client, general["id"], f"<@{alice.id}> and this")

    as_user(alice)
    summary = await _summary(client)
    assert summary["unread_count"] == 4 and summary["mention_unread"] is True
    assert set((await _read_flags(client)).values()) == {False}

    # The thread read in the thread: its reply is read (the channel's position does not cover it).
    await _read_thread(client, mine["id"], reply["seq"])
    flags = await _read_flags(client)
    assert flags[("thread_reply", reply["id"])] is True
    assert (await _summary(client))["unread_count"] == 3

    # The channel read up to the first mention: it is read, the later one still counts, and so
    # does the reaction (no read position but the activity one).
    await _read_channel(client, general["id"], mention["seq"])
    flags = await _read_flags(client)
    assert flags[("mention", mention["id"])] is True
    assert flags[("mention", later["id"])] is False
    assert flags[("reaction", mine["id"])] is False
    summary = await _summary(client)
    assert summary["unread_count"] == 2 and summary["mention_unread"] is True
    boot = (await client.get("/api/v1/sync/bootstrap")).json()
    assert boot["activity"]["unread_count"] == 2

    # The rest of the channel: only the reaction is left (not a mention: the badge is not red).
    await _read_channel(client, general["id"], later["seq"])
    summary = await _summary(client)
    assert summary["unread_count"] == 1 and summary["mention_unread"] is False

    # Mark as unread moves the channel's position back: the mention is unread again.
    await client.put(
        f"/api/v1/channels/{general['id']}/read",
        json={"last_read_seq": later["seq"] - 1, "mode": "set"},
    )
    assert (await _summary(client))["unread_count"] == 2

    # The activity read position still reads everything.
    read = await client.put("/api/v1/activity/read", json={"read_at": utcnow().isoformat()})
    assert read.json()["unread_count"] == 0
    assert set((await _read_flags(client)).values()) == {True}

    # Carol's reads were never alice's, and alice's are not carol's.
    as_user(carol)
    flags = await _read_flags(client)
    assert flags == {("mention", mention["id"]): False}
    assert (await _summary(client))["unread_count"] == 1


async def test_a_mention_in_a_reply_is_read_in_its_thread(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice, bob, _carol, general = await _setup(client, db, as_user)
    as_user(bob)
    parent = await _post(client, general["id"], "a topic")
    in_thread = await _post(client, general["id"], f"<@{alice.id}> here", parent_id=parent["id"])
    shared = await _post(
        client,
        general["id"],
        f"<@{alice.id}> also in the channel",
        parent_id=parent["id"],
        also_in_channel=True,
    )
    as_user(alice)
    assert (await _summary(client))["unread_count"] == 2

    # The channel read: the reply also sent there is read; the one only in the thread is not.
    await _read_channel(client, general["id"], shared["seq"])
    flags = await _read_flags(client)
    assert flags == {("mention", shared["id"]): True, ("mention", in_thread["id"]): False}
    summary = await _summary(client)
    assert summary["unread_count"] == 1 and summary["mention_unread"] is True

    # The thread read (alice does not have to follow it).
    await _read_thread(client, parent["id"], in_thread["seq"])
    assert (await _summary(client))["unread_count"] == 0
    assert set((await _read_flags(client)).values()) == {True}


async def test_the_push_badge_follows_the_read_positions(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """The app icon / push badge (PUSH_NOTIFICATIONS.md §4.2) counts conversations, not activity
    items: it agrees with GET /sync/summary, and a mention read in its channel leaves both it and
    the activity badge."""
    alice, bob, _carol, general = await _setup(client, db, as_user)
    as_user(bob)
    mention = await _post(client, general["id"], f"<@{alice.id}> look")
    as_user(alice)
    planner = PushPlanner(build_settings(), is_active=lambda _uid: False)
    synced = (await client.get("/api/v1/sync/summary")).json()
    assert await planner.badge_for(db, alice.id) == synced["badge"] == 1
    assert (await _summary(client))["unread_count"] == 1

    await _read_channel(client, general["id"], mention["seq"])
    synced = (await client.get("/api/v1/sync/summary")).json()
    assert await planner.badge_for(db, alice.id) == synced["badge"] == 0
    assert (await _summary(client))["unread_count"] == 0
