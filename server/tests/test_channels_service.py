import asyncio
import uuid

import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.modules.channels import service as channels
from app.modules.channels.schemas import ChannelCreate, ChannelUpdate
from tests.helpers import make_user


async def test_create_channel_makes_creator_owner(db: AsyncSession) -> None:
    alice = await make_user(db, "alice")
    out = await channels.create_channel(db, alice, ChannelCreate(name="general", topic="hello"))
    assert out.type == "public"
    assert out.membership is not None and out.membership.role == "owner"
    assert out.last_seq == 0

    with pytest.raises(AppError) as excinfo:
        await channels.create_channel(db, alice, ChannelCreate(name="GENERAL"))
    assert excinfo.value.code == "name_taken"


async def test_private_channel_is_invisible_to_non_members(db: AsyncSession) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    private = await channels.create_channel(db, alice, ChannelCreate(type="private", name="secret"))
    public = await channels.create_channel(db, alice, ChannelCreate(name="town"))

    with pytest.raises(AppError) as excinfo:
        await channels.get_channel(db, bob, private.id)
    assert excinfo.value.code == "not_a_member"

    visible = await channels.get_channel(db, bob, public.id)
    assert visible.membership is None

    listed = await channels.list_channels(db, bob, include_public=True)
    assert [c.id for c in listed] == [public.id]

    with pytest.raises(AppError) as excinfo:
        await channels.join_channel(db, bob, private.id)
    assert excinfo.value.code == "not_a_member"

    joined = await channels.join_channel(db, bob, public.id)
    assert joined.membership is not None and joined.membership.role == "member"


async def test_member_management_requires_owner_or_admin(db: AsyncSession) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    admin = await make_user(db, "root", role="admin")
    ch = await channels.create_channel(db, alice, ChannelCreate(type="private", name="team"))

    await channels.add_member(db, alice, ch.id, bob)
    await channels.add_member(db, bob, ch.id, carol)  # any member may invite
    members = await channels.list_members(db, carol, ch.id)
    assert {m.user_id for m in members} == {alice.id, bob.id, carol.id}

    with pytest.raises(AppError) as excinfo:
        await channels.remove_member(db, bob, ch.id, carol.id)
    assert excinfo.value.code == "forbidden"

    await channels.remove_member(db, admin, ch.id, carol.id)  # admin without membership
    await channels.remove_member(db, alice, ch.id, bob.id)
    assert [m.user_id for m in await channels.list_members(db, alice, ch.id)] == [alice.id]

    renamed = await channels.update_channel(
        db, alice, ch.id, ChannelUpdate(name="team-2", topic="t")
    )
    assert renamed.name == "team-2" and renamed.topic == "t"

    archived = await channels.archive_channel(db, alice, ch.id)
    assert archived.archived is True
    with pytest.raises(AppError) as excinfo:
        await channels.add_member(db, alice, ch.id, bob)
    assert excinfo.value.code == "channel_archived"


async def test_dm_resolution_is_idempotent_and_order_insensitive(db: AsyncSession) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")

    first, created = await channels.get_or_create_dm(db, alice, [bob])
    assert created and first.type == "dm"
    assert first.dm_user_ids == sorted([alice.id, bob.id])
    assert first.membership is not None

    second, created = await channels.get_or_create_dm(db, bob, [alice])
    assert not created and second.id == first.id

    group, created = await channels.get_or_create_dm(db, alice, [carol, bob])
    assert created and group.type == "group_dm" and group.id != first.id

    with pytest.raises(AppError) as excinfo:
        await channels.leave_channel(db, alice, first.id)
    assert excinfo.value.code == "dm_immutable"

    too_many = [await make_user(db, f"u{i}") for i in range(9)]
    with pytest.raises(AppError) as excinfo:
        await channels.get_or_create_dm(db, alice, too_many)
    assert excinfo.value.code == "too_many_members"


async def test_concurrent_dm_creation_converges(app: FastAPI, db: AsyncSession) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")

    async def create() -> uuid.UUID:
        async with app.state.db.session_factory() as session:
            out, _ = await channels.get_or_create_dm(session, alice, [bob])
            return out.id

    ids = await asyncio.gather(*(create() for _ in range(8)))
    assert len(set(ids)) == 1
