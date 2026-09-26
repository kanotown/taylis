"""Read positions and unread counts (M8b): API rules, own-message reads, push checks."""

import uuid
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import build_settings
from app.events.models import OutboxEvent
from app.modules.channels import service as channels
from app.modules.notifications.planner import PushPlanner
from app.modules.users.models import User
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body},
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


async def _state(client: AsyncClient, channel_id: str) -> dict[str, Any]:
    bootstrap = (await client.get("/api/v1/sync/bootstrap")).json()
    state: dict[str, Any] = next(
        c["read_state"] for c in bootstrap["channels"] if c["id"] == channel_id
    )
    return state


async def test_read_position_is_monotonic_and_counts_are_derived(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")

    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    cid = channel["id"]
    await _post(client, cid, "m1")
    await _post(client, cid, "m2")
    # The author's own messages are read (SYNC_PROTOCOL.md §10).
    assert await _state(client, cid) == {"last_read_seq": 2, "unread_count": 0, "mention_count": 0}

    # Joining later: history before the join is not unread.
    as_user(bob)
    await client.post(f"/api/v1/channels/{cid}/join")
    assert await _state(client, cid) == {"last_read_seq": 2, "unread_count": 0, "mention_count": 0}

    as_user(alice)
    await _post(client, cid, "m3")
    await _post(client, cid, f"<@{bob.id}> m4")
    as_user(bob)
    assert await _state(client, cid) == {"last_read_seq": 2, "unread_count": 2, "mention_count": 1}

    marked = await client.put(f"/api/v1/channels/{cid}/read", json={"last_read_seq": 3})
    assert marked.status_code == 200
    assert marked.json() == {"last_read_seq": 3, "unread_count": 1, "mention_count": 1}
    backwards = await client.put(f"/api/v1/channels/{cid}/read", json={"last_read_seq": 1})
    assert backwards.json()["last_read_seq"] == 3  # never regresses
    clamped = await client.put(f"/api/v1/channels/{cid}/read", json={"last_read_seq": 999})
    assert clamped.json() == {"last_read_seq": 4, "unread_count": 0, "mention_count": 0}

    # Deleted messages are not unread; edits and reactions do not create unread items.
    as_user(alice)
    fifth = await _post(client, cid, "m5")
    await client.put(f"/api/v1/messages/{fifth['id']}/reactions/%F0%9F%91%8D")
    sixth = await _post(client, cid, "m6")
    await client.delete(f"/api/v1/messages/{sixth['id']}")
    as_user(bob)
    assert await _state(client, cid) == {"last_read_seq": 4, "unread_count": 1, "mention_count": 0}

    # Sending marks everything read for the sender.
    await _post(client, cid, "from bob")
    assert (await _state(client, cid))["unread_count"] == 0
    assert (await _state(client, cid))["last_read_seq"] == channel_last_seq(
        await client.get(f"/api/v1/channels/{cid}")
    )

    # read.updated goes to the user's own devices only, and only when the position moved.
    events = list((await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars())
    reads = [
        (e.audience_type, e.payload["last_read_seq"])
        for e in events
        if e.event_type == "read.updated" and e.audience_id == bob.id
    ]
    assert reads == [("user", 3), ("user", 4), ("user", 9)]

    # Non-members cannot mark.
    carol = await make_user(db, "carol")
    as_user(carol)
    denied = await client.put(f"/api/v1/channels/{cid}/read", json={"last_read_seq": 1})
    assert denied.status_code == 403


async def test_mark_unread_sets_the_position_and_recounts(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = (await client.post("/api/v1/channels", json={"name": "general"})).json()["id"]
    as_user(bob)
    await client.post(f"/api/v1/channels/{cid}/join")
    as_user(alice)
    for body in ("m1", "m2", f"<@{bob.id}> m3"):
        await _post(client, cid, body)

    as_user(bob)
    await client.put(f"/api/v1/channels/{cid}/read", json={"last_read_seq": 3})
    assert await _state(client, cid) == {"last_read_seq": 3, "unread_count": 0, "mention_count": 0}

    # 「ここから未読にする」 on m2: the position moves back and the counts are derived again.
    marked = await client.put(
        f"/api/v1/channels/{cid}/read", json={"last_read_seq": 1, "mode": "set"}
    )
    assert marked.status_code == 200
    assert marked.json() == {"last_read_seq": 1, "unread_count": 2, "mention_count": 1}
    # Setting the same position again changes nothing and emits nothing.
    again = await client.put(
        f"/api/v1/channels/{cid}/read", json={"last_read_seq": 1, "mode": "set"}
    )
    assert again.json()["last_read_seq"] == 1
    # set is clamped to last_seq like advance.
    clamped = await client.put(
        f"/api/v1/channels/{cid}/read", json={"last_read_seq": 999, "mode": "set"}
    )
    assert clamped.json() == {"last_read_seq": 3, "unread_count": 0, "mention_count": 0}
    # The default mode stays monotonic from wherever set left the position.
    await client.put(f"/api/v1/channels/{cid}/read", json={"last_read_seq": 0, "mode": "set"})
    advanced = await client.put(f"/api/v1/channels/{cid}/read", json={"last_read_seq": 2})
    assert advanced.json()["last_read_seq"] == 2
    lower = await client.put(f"/api/v1/channels/{cid}/read", json={"last_read_seq": 1})
    assert lower.json()["last_read_seq"] == 2

    events = list((await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars())
    positions = [
        (e.payload["last_read_seq"], e.payload["reason"])
        for e in events
        if e.event_type == "read.updated" and e.audience_id == bob.id
    ]
    assert positions == [(3, "advance"), (1, "set"), (3, "set"), (0, "set"), (2, "advance")]


def channel_last_seq(response: Any) -> int:
    value: int = response.json()["last_seq"]
    return value


async def test_dm_starts_unread_for_the_other_party(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})).json()
    await _post(client, dm["id"], "hi")
    as_user(bob)
    assert await _state(client, dm["id"]) == {
        "last_read_seq": 0,
        "unread_count": 1,
        "mention_count": 0,
    }


async def test_push_skips_read_recipients_and_counts_the_badge(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})).json()
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")
    as_user(alice)
    first = await _post(client, dm["id"], "one")
    await _post(client, dm["id"], "two")
    await _post(client, general["id"], f"<@{bob.id}> look")

    planner = PushPlanner(build_settings(), is_active=lambda _uid: False)
    channel = await channels.require_channel(db, uuid.UUID(dm["id"]))
    assert await planner.select_recipients(db, channel, [bob.id], first) == [bob.id]
    assert await planner.badge_for(db, bob.id) == 3  # 2 unread DMs + 1 mention

    as_user(bob)
    await client.put(f"/api/v1/channels/{dm['id']}/read", json={"last_read_seq": 1})
    assert await planner.select_recipients(db, channel, [bob.id], first) == []  # seq 1 is read
    assert await planner.badge_for(db, bob.id) == 2
