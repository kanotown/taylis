"""Pinned DMs (M118): personal, DMs and group DMs only, synced like favorites."""

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


async def _events(db: AsyncSession) -> list[OutboxEvent]:
    rows = await db.execute(
        select(OutboxEvent)
        .where(OutboxEvent.event_type == "dm_pin.updated")
        .order_by(OutboxEvent.id)
    )
    return list(rows.scalars().all())


async def _pins(client: AsyncClient) -> list[str]:
    boot: dict[str, Any] = (await client.get(f"{API}/sync/bootstrap")).json()
    return list(boot["dm_pins"])


async def test_pins_are_personal_ordered_and_synced(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    me = (await client.post(f"{API}/dms", json={"user_ids": [str(alice.id)]})).json()
    with_bob = (await client.post(f"{API}/dms", json={"user_ids": [str(bob.id)]})).json()
    group = (
        await client.post(f"{API}/dms", json={"user_ids": [str(bob.id), str(carol.id)]})
    ).json()
    assert me["type"] == "dm" and group["type"] == "group_dm"

    # Pin order: oldest pin first; pinning again keeps the place.
    first = await client.put(f"{API}/channels/{group['id']}/dm-pin")
    assert first.status_code == 201
    assert first.json() == {"channel_id": group["id"], "pinned": True}
    assert (await client.put(f"{API}/channels/{me['id']}/dm-pin")).status_code == 201
    assert (await client.put(f"{API}/channels/{with_bob['id']}/dm-pin")).status_code == 201
    assert (await client.put(f"{API}/channels/{group['id']}/dm-pin")).status_code == 200
    assert await _pins(client) == [group["id"], me["id"], with_bob["id"]]

    # Unpin and pin again: to the end. DELETE is idempotent.
    removed = await client.delete(f"{API}/channels/{group['id']}/dm-pin")
    assert removed.status_code == 200 and removed.json()["pinned"] is False
    assert (await client.delete(f"{API}/channels/{group['id']}/dm-pin")).status_code == 200
    await client.put(f"{API}/channels/{group['id']}/dm-pin")
    assert await _pins(client) == [me["id"], with_bob["id"], group["id"]]

    # Personal: bob sees none of alice's pins.
    as_user(bob)
    assert await _pins(client) == []

    # Only changes are announced, to alice's own devices, without a seq.
    events = await _events(db)
    shapes = {(e.audience_type, e.audience_id, e.seq) for e in events}
    assert len(events) == 5 and shapes == {("user", alice.id, None)}
    assert [(e.payload["channel_id"], e.payload["pinned"]) for e in events] == [
        (group["id"], True),
        (me["id"], True),
        (with_bob["id"], True),
        (group["id"], False),
        (group["id"], True),
    ]
    assert all(e.payload["at"] for e in events)
    # No channel seq is consumed.
    as_user(alice)
    assert (await client.get(f"{API}/channels/{group['id']}")).json()["last_seq"] == 0


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
        refused = await client.put(f"{API}/channels/{channel['id']}/dm-pin")
        assert refused.status_code == 409
        assert refused.json()["error"]["code"] == "dm_pin_not_dm"
        assert (await client.delete(f"{API}/channels/{channel['id']}/dm-pin")).status_code == 409
    with_bob = (await client.post(f"{API}/dms", json={"user_ids": [str(bob.id)]})).json()
    as_user(carol)
    denied = await client.put(f"{API}/channels/{with_bob['id']}/dm-pin")
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_a_member"
    assert await _events(db) == []


async def test_a_pin_outside_my_conversations_is_hidden(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """Group DMs are fixed, but a pin is shown only while I am a member (as favorites): the row
    stays and comes back with the membership."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    group = (
        await client.post(f"{API}/dms", json={"user_ids": [str(bob.id), str(carol.id)]})
    ).json()
    as_user(bob)
    assert (await client.put(f"{API}/channels/{group['id']}/dm-pin")).status_code == 201
    assert await _pins(client) == [group["id"]]
    member = (
        await db.execute(
            select(ChannelMember).where(
                ChannelMember.channel_id == uuid.UUID(group["id"]), ChannelMember.user_id == bob.id
            )
        )
    ).scalar_one()
    joined_at, role = member.joined_at, member.role
    await db.delete(member)
    await db.commit()
    assert await _pins(client) == []
    db.add(
        ChannelMember(
            channel_id=uuid.UUID(group["id"]), user_id=bob.id, role=role, joined_at=joined_at
        )
    )
    await db.commit()
    assert await _pins(client) == [group["id"]]
