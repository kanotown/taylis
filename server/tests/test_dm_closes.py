"""Closed DMs (M141, 「会話を閉じる」): personal, DMs and group DMs only; a new message or an
explicit open brings the conversation back."""

import uuid
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.channels.models import ChannelMember
from app.modules.users.models import User
from tests.helpers import make_user

API = "/api/v1"


async def _events(db: AsyncSession, kind: str = "dm_close.updated") -> list[OutboxEvent]:
    rows = await db.execute(
        select(OutboxEvent).where(OutboxEvent.event_type == kind).order_by(OutboxEvent.id)
    )
    return list(rows.scalars().all())


async def _boot(client: AsyncClient) -> dict[str, Any]:
    boot: dict[str, Any] = (await client.get(f"{API}/sync/bootstrap")).json()
    return boot


async def _closed(client: AsyncClient) -> list[str]:
    return list((await _boot(client))["closed_dms"])


async def _dm(client: AsyncClient, *users: User) -> dict[str, Any]:
    body: dict[str, Any] = (
        await client.post(f"{API}/dms", json={"user_ids": [str(u.id) for u in users]})
    ).json()
    return body


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> dict[str, Any]:
    response = await client.post(
        f"{API}/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body, **extra},
    )
    assert response.status_code in (200, 201), response.text
    out: dict[str, Any] = response.json()
    return out


async def test_close_is_personal_idempotent_and_announced(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    me = await _dm(client, alice)
    with_bob = await _dm(client, bob)
    group = await _dm(client, bob, carol)

    closed = await client.put(f"{API}/channels/{with_bob['id']}/close")
    assert closed.status_code == 200
    assert closed.json()["channel_id"] == with_bob["id"] and closed.json()["closed"] is True
    assert closed.json()["closed_at"]
    # The self-DM and group DMs can be closed too; closing again changes nothing.
    assert (await client.put(f"{API}/channels/{me['id']}/close")).status_code == 200
    assert (await client.put(f"{API}/channels/{group['id']}/close")).status_code == 200
    assert (await client.put(f"{API}/channels/{group['id']}/close")).status_code == 200
    assert await _closed(client) == [with_bob["id"], me["id"], group["id"]]

    # Personal: bob still sees everything.
    as_user(bob)
    assert await _closed(client) == []

    # DELETE opens it again; idempotent.
    as_user(alice)
    opened = await client.delete(f"{API}/channels/{group['id']}/close")
    assert opened.status_code == 200
    assert opened.json() == {"channel_id": group["id"], "closed": False, "closed_at": None}
    assert (await client.delete(f"{API}/channels/{group['id']}/close")).status_code == 200
    assert await _closed(client) == [with_bob["id"], me["id"]]

    # Only changes are announced, to alice's own devices, without a seq.
    events = await _events(db)
    assert {(e.audience_type, e.audience_id, e.seq) for e in events} == {("user", alice.id, None)}
    assert [(e.payload["channel_id"], e.payload["closed"]) for e in events] == [
        (with_bob["id"], True),
        (me["id"], True),
        (group["id"], True),
        (group["id"], False),
    ]
    assert all(e.payload["at"] for e in events)
    # No channel seq is consumed.
    assert (await client.get(f"{API}/channels/{group['id']}")).json()["last_seq"] == 0


async def test_a_new_message_reopens_it(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    dm = await _dm(client, bob)
    first = await _post(client, dm["id"], "hello")
    assert (await client.put(f"{API}/channels/{dm['id']}/close")).status_code == 200
    assert await _closed(client) == [dm["id"]]

    # Edits, reactions and thread-only replies do not reopen it (no new timeline row).
    edit = await client.patch(f"{API}/messages/{first['id']}", json={"body": "hello!"})
    assert edit.status_code == 200, edit.text
    as_user(bob)
    react = await client.put(f"{API}/messages/{first['id']}/reactions/%F0%9F%91%8D")
    assert react.status_code in (200, 201), react.text
    await _post(client, dm["id"], "in a thread", parent_id=first["id"])
    as_user(alice)
    assert await _closed(client) == [dm["id"]]

    # A reply also sent to the conversation does, as any new message (no write, no event).
    as_user(bob)
    await _post(client, dm["id"], "also here", parent_id=first["id"], also_in_channel=True)
    as_user(alice)
    assert await _closed(client) == []
    assert [e.payload["closed"] for e in await _events(db)] == [True]

    # Closed again, then a new top-level message from me (another device) reopens it too.
    await client.put(f"{API}/channels/{dm['id']}/close")
    assert await _closed(client) == [dm["id"]]
    await _post(client, dm["id"], "from my phone")
    assert await _closed(client) == []


async def test_closing_marks_read_and_unpins_but_keeps_star_and_section(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(bob)
    dm = await _dm(client, alice)
    for text in ("one", "two", "three"):
        await _post(client, dm["id"], text)
    as_user(alice)
    assert (await client.put(f"{API}/channels/{dm['id']}/dm-pin")).status_code == 201
    assert (await client.put(f"{API}/channels/{dm['id']}/favorite")).status_code in (200, 201)
    boot = await _boot(client)
    row = next(c for c in boot["channels"] if c["id"] == dm["id"])
    assert row["read_state"]["unread_count"] == 3

    assert (await client.put(f"{API}/channels/{dm['id']}/close")).status_code == 200
    boot = await _boot(client)
    row = next(c for c in boot["channels"] if c["id"] == dm["id"])
    assert row["read_state"]["unread_count"] == 0
    assert row["read_state"]["last_read_seq"] == row["last_seq"]
    assert boot["dm_pins"] == []
    assert boot["favorites"] == [dm["id"]]  # kept: it comes back where it was filed
    reads = [e for e in await _events(db, "read.updated") if e.audience_id == alice.id]
    assert reads and reads[-1].payload["last_read_seq"] == row["last_seq"]
    pins = [e.payload["pinned"] for e in await _events(db, "dm_pin.updated")]
    assert pins == [True, False]

    # Closing an unpinned conversation announces no pin change.
    await client.delete(f"{API}/channels/{dm['id']}/close")
    await client.put(f"{API}/channels/{dm['id']}/close")
    assert [e.payload["pinned"] for e in await _events(db, "dm_pin.updated")] == [True, False]


async def test_resolving_the_dm_again_reopens_it(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    dm = await _dm(client, bob)
    await client.put(f"{API}/channels/{dm['id']}/close")
    # bob resolving it does not reopen alice's.
    as_user(bob)
    await _dm(client, alice)
    as_user(alice)
    assert await _closed(client) == [dm["id"]]
    again = await client.post(f"{API}/dms", json={"user_ids": [str(bob.id)]})
    assert again.status_code == 200 and again.json()["id"] == dm["id"]
    assert await _closed(client) == []
    assert [e.payload["closed"] for e in await _events(db)] == [True, False]


async def test_only_dms_and_only_members(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    secret = (
        await client.post(f"{API}/channels", json={"name": "secret", "type": "private"})
    ).json()
    for channel in (general, secret):
        refused = await client.put(f"{API}/channels/{channel['id']}/close")
        assert refused.status_code == 409
        assert refused.json()["error"]["code"] == "dm_close_not_dm"
        assert (await client.delete(f"{API}/channels/{channel['id']}/close")).status_code == 409
    with_bob = await _dm(client, bob)
    as_user(carol)
    denied = await client.put(f"{API}/channels/{with_bob['id']}/close")
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_a_member"
    assert await _events(db) == []


async def test_a_close_outside_my_conversations_is_hidden(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    group = await _dm(client, bob, carol)
    as_user(bob)
    await client.put(f"{API}/channels/{group['id']}/close")
    member = (
        await db.execute(
            select(ChannelMember).where(
                ChannelMember.channel_id == uuid.UUID(group["id"]), ChannelMember.user_id == bob.id
            )
        )
    ).scalar_one()
    await db.delete(member)
    await db.commit()
    assert await _closed(client) == []
