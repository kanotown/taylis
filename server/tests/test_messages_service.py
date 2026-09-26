import asyncio
import uuid

import pytest
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.modules.channels import service as channels
from app.modules.channels.schemas import ChannelCreate
from app.modules.messages import service as messages
from app.modules.messages.schemas import MessageCreate
from app.modules.users.models import User
from tests.helpers import make_user


def _msg(body: str = "hello") -> MessageCreate:
    return MessageCreate(client_msg_id=uuid.uuid4(), body=body)


async def test_sequence_and_idempotency(db: AsyncSession) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    ch = await channels.create_channel(db, alice, ChannelCreate(name="general"))
    other = await channels.create_channel(db, alice, ChannelCreate(name="random"))

    first = _msg("one")
    m1, created = await messages.create_message(db, alice, ch.id, first)
    assert created and m1.seq == 1 and m1.updated_seq == 1
    m2, created = await messages.create_message(db, alice, ch.id, _msg("two"))
    assert created and m2.seq == 2

    replay, created = await messages.create_message(db, alice, ch.id, first)
    assert not created and replay.id == m1.id and replay.seq == 1

    with pytest.raises(AppError) as excinfo:
        await messages.create_message(db, alice, other.id, first)
    assert excinfo.value.code == "idempotency_conflict"

    with pytest.raises(AppError) as excinfo:
        await messages.create_message(db, bob, ch.id, _msg())
    assert excinfo.value.code == "not_a_member"

    history = await messages.list_history(db, alice, ch.id, before_seq=None, limit=50)
    assert history.channel_last_seq == 2
    assert [m.seq for m in history.messages] == [2, 1]


async def test_archived_channel_rejects_messages(db: AsyncSession) -> None:
    alice = await make_user(db, "alice")
    ch = await channels.create_channel(db, alice, ChannelCreate(name="old"))
    await channels.archive_channel(db, alice, ch.id)
    with pytest.raises(AppError) as excinfo:
        await messages.create_message(db, alice, ch.id, _msg())
    assert excinfo.value.code == "channel_archived"


async def test_concurrent_posts_get_contiguous_sequence(app: FastAPI, db: AsyncSession) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    ch = await channels.create_channel(db, alice, ChannelCreate(name="busy"))
    await channels.join_channel(db, bob, ch.id)

    async def post(user: User, i: int) -> int:
        async with app.state.db.session_factory() as session:
            message, _ = await messages.create_message(session, user, ch.id, _msg(f"m{i}"))
            return message.seq

    seqs = await asyncio.gather(*(post(alice if i % 2 else bob, i) for i in range(20)))
    assert sorted(seqs) == list(range(1, 21))
    history = await messages.list_history(db, alice, ch.id, before_seq=None, limit=200)
    assert history.channel_last_seq == 20
    assert [m.seq for m in history.messages] == list(range(20, 0, -1))


async def test_history_pagination(db: AsyncSession) -> None:
    alice = await make_user(db, "alice")
    ch = await channels.create_channel(db, alice, ChannelCreate(name="paged"))
    for i in range(7):
        await messages.create_message(db, alice, ch.id, _msg(f"m{i}"))

    page1 = await messages.list_history(db, alice, ch.id, before_seq=None, limit=3)
    assert [m.seq for m in page1.messages] == [7, 6, 5] and page1.has_more
    page2 = await messages.list_history(db, alice, ch.id, before_seq=5, limit=3)
    assert [m.seq for m in page2.messages] == [4, 3, 2] and page2.has_more
    page3 = await messages.list_history(db, alice, ch.id, before_seq=2, limit=3)
    assert [m.seq for m in page3.messages] == [1] and not page3.has_more

    fetched = await messages.get_message(db, alice, page3.messages[0].id)
    assert fetched.body == "m0"


def test_body_validation_strips_control_characters() -> None:
    assert MessageCreate(client_msg_id=uuid.uuid4(), body="a\x00b\tc\n").body == "ab\tc\n"
    with pytest.raises(ValidationError):
        MessageCreate(client_msg_id=uuid.uuid4(), body="\x01 \x02")
    with pytest.raises(ValidationError):
        MessageCreate(client_msg_id=uuid.uuid4(), body="x" * 20_001)
