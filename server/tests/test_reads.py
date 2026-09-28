"""Read positions and unread counts (M8b): API rules, own-message reads, push checks."""

import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import build_settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.channels import service as channels
from app.modules.messages import repository as messages_repo
from app.modules.messages.models import Message
from app.modules.notifications.planner import PushPlanner
from app.modules.users.models import User
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body, **extra},
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


def _read(
    last_read_seq: int, unread: int, mentions: int, first_unread_at: str | None = None
) -> dict[str, Any]:
    return {
        "last_read_seq": last_read_seq,
        "unread_count": unread,
        "mention_count": mentions,
        "first_unread_at": first_unread_at,
    }


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
    assert await _state(client, cid) == _read(2, 0, 0)

    # Joining later: history before the join is not unread.
    as_user(bob)
    await client.post(f"/api/v1/channels/{cid}/join")
    assert await _state(client, cid) == _read(2, 0, 0)

    as_user(alice)
    m3 = await _post(client, cid, "m3")
    m4 = await _post(client, cid, f"<@{bob.id}> m4")
    as_user(bob)
    assert await _state(client, cid) == _read(2, 2, 1, m3["created_at"])

    marked = await client.put(f"/api/v1/channels/{cid}/read", json={"last_read_seq": 3})
    assert marked.status_code == 200
    assert marked.json() == _read(3, 1, 1, m4["created_at"])
    backwards = await client.put(f"/api/v1/channels/{cid}/read", json={"last_read_seq": 1})
    assert backwards.json()["last_read_seq"] == 3  # never regresses
    clamped = await client.put(f"/api/v1/channels/{cid}/read", json={"last_read_seq": 999})
    assert clamped.json() == _read(4, 0, 0)

    # Deleted messages are not unread; edits and reactions do not create unread items.
    as_user(alice)
    fifth = await _post(client, cid, "m5")
    await client.put(f"/api/v1/messages/{fifth['id']}/reactions/%F0%9F%91%8D")
    sixth = await _post(client, cid, "m6")
    await client.delete(f"/api/v1/messages/{sixth['id']}")
    as_user(bob)
    assert await _state(client, cid) == _read(4, 1, 0, fifth["created_at"])

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
    posted = [await _post(client, cid, body) for body in ("m1", "m2", f"<@{bob.id}> m3")]

    as_user(bob)
    await client.put(f"/api/v1/channels/{cid}/read", json={"last_read_seq": 3})
    assert await _state(client, cid) == _read(3, 0, 0)

    # 「ここから未読にする」 on m2: the position moves back and the counts are derived again.
    marked = await client.put(
        f"/api/v1/channels/{cid}/read", json={"last_read_seq": 1, "mode": "set"}
    )
    assert marked.status_code == 200
    assert marked.json() == _read(1, 2, 1, posted[1]["created_at"])
    # Setting the same position again changes nothing and emits nothing.
    again = await client.put(
        f"/api/v1/channels/{cid}/read", json={"last_read_seq": 1, "mode": "set"}
    )
    assert again.json()["last_read_seq"] == 1
    # set is clamped to last_seq like advance.
    clamped = await client.put(
        f"/api/v1/channels/{cid}/read", json={"last_read_seq": 999, "mode": "set"}
    )
    assert clamped.json() == _read(3, 0, 0)
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


async def test_first_unread_at_is_the_oldest_counted_message(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """M17 (SYNC_PROTOCOL.md §4.1, §10.1): the banner's 「… 以降」 uses the unread_count rules."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = (await client.post("/api/v1/channels", json={"name": "general"})).json()["id"]
    as_user(bob)
    await client.post(f"/api/v1/channels/{cid}/join")
    mine = await _post(client, cid, "bob's own")
    # Every row below is older than the first counted message, so min() would pick any of them
    # that the filter let through.
    as_user(alice)
    await _post(client, cid, "thread only", parent_id=mine["id"])
    gone = await _post(client, cid, "deleted")
    await client.delete(f"/api/v1/messages/{gone['id']}")
    seq = await messages_repo.allocate_seq(db, uuid.UUID(cid))
    db.add(
        Message(
            channel_id=uuid.UUID(cid),
            sender_id=alice.id,
            seq=seq,
            updated_seq=seq,
            type="system",
            body="joined",
            created_at=utcnow() - timedelta(days=1),
        )
    )
    await db.commit()
    first = await _post(client, cid, "first counted")
    shared = await _post(client, cid, "shared", parent_id=mine["id"], also_in_channel=True)

    as_user(bob)
    reset = await client.put(
        f"/api/v1/channels/{cid}/read", json={"last_read_seq": 0, "mode": "set"}
    )
    assert reset.json() == _read(0, 2, 0, first["created_at"])
    assert await _state(client, cid) == _read(0, 2, 0, first["created_at"])
    advanced = await client.put(
        f"/api/v1/channels/{cid}/read", json={"last_read_seq": first["seq"]}
    )
    assert advanced.json() == _read(first["seq"], 1, 0, shared["created_at"])
    assert await _state(client, cid) == _read(first["seq"], 1, 0, shared["created_at"])

    # read-all lists it explicitly (its own model), null once nothing is unread.
    done = await client.post("/api/v1/channels/read-all")
    assert done.json() == [{"channel_id": cid, **_read(shared["seq"], 0, 0)}]
    assert await _state(client, cid) == _read(shared["seq"], 0, 0)

    # read.updated carries what the change's response carried (my own post, set, advance, all).
    events = list((await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars())
    updates = [
        (e.payload["reason"], e.payload["first_unread_at"])
        for e in events
        if e.event_type == "read.updated" and e.audience_id == bob.id
    ]
    assert updates == [
        ("advance", None),
        ("set", first["created_at"]),
        ("advance", shared["created_at"]),
        ("advance", None),
    ]


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
    hi = await _post(client, dm["id"], "hi")
    as_user(bob)
    assert await _state(client, dm["id"]) == _read(0, 1, 0, hi["created_at"])


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
