import uuid

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.channels.models import Channel
from app.modules.messages.models import Message, Reaction


async def allocate_seq(
    db: AsyncSession, channel_id: uuid.UUID, *, touch_last_message: bool = True
) -> int:
    """Take the next channel sequence number. The row lock serialises writers until commit.

    Edits, deletes and reactions consume a seq too (DATA_MODEL.md "各操作と seq") but do not
    move ``last_message_at``.
    """
    values: dict[str, object] = {"last_seq": Channel.last_seq + 1}
    if touch_last_message:
        values["last_message_at"] = func.now()
    stmt = (
        update(Channel)
        .where(Channel.id == channel_id)
        .values(**values)
        .returning(Channel.last_seq)
        .execution_options(synchronize_session=False)
    )
    return int((await db.execute(stmt)).scalar_one())


async def get_channel_last_seq(db: AsyncSession, channel_id: uuid.UUID) -> int:
    result = await db.execute(select(Channel.last_seq).where(Channel.id == channel_id))
    return int(result.scalar_one())


async def get_message(db: AsyncSession, message_id: uuid.UUID) -> Message | None:
    return await db.get(Message, message_id)


async def get_by_client_msg_id(
    db: AsyncSession, sender_id: uuid.UUID, client_msg_id: uuid.UUID
) -> Message | None:
    stmt = select(Message).where(
        Message.sender_id == sender_id, Message.client_msg_id == client_msg_id
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def list_history(
    db: AsyncSession, channel_id: uuid.UUID, *, before_seq: int | None, limit: int
) -> list[Message]:
    stmt = select(Message).where(Message.channel_id == channel_id, Message.deleted_at.is_(None))
    if before_seq is not None:
        stmt = stmt.where(Message.seq < before_seq)
    stmt = stmt.order_by(Message.seq.desc()).limit(limit)
    return list((await db.execute(stmt)).scalars().all())


async def list_delta(
    db: AsyncSession, channel_id: uuid.UUID, *, since_seq: int, limit: int
) -> list[Message]:
    """Current state of every message changed after ``since_seq`` (tombstones included)."""
    stmt = (
        select(Message)
        .where(Message.channel_id == channel_id, Message.updated_seq > since_seq)
        .order_by(Message.updated_seq.asc())
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


async def reactions_for(
    db: AsyncSession, message_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[Reaction]]:
    if not message_ids:
        return {}
    stmt = (
        select(Reaction)
        .where(Reaction.message_id.in_(message_ids))
        .order_by(Reaction.created_at.asc(), Reaction.emoji.asc())
    )
    grouped: dict[uuid.UUID, list[Reaction]] = {}
    for reaction in (await db.execute(stmt)).scalars().all():
        grouped.setdefault(reaction.message_id, []).append(reaction)
    return grouped


async def add_reaction(
    db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID, emoji: str
) -> bool:
    """True when the reaction was new (INSERT ... ON CONFLICT DO NOTHING)."""
    stmt = (
        pg_insert(Reaction)
        .values(message_id=message_id, user_id=user_id, emoji=emoji)
        .on_conflict_do_nothing(index_elements=["message_id", "user_id", "emoji"])
        .returning(Reaction.message_id)
    )
    return (await db.execute(stmt)).first() is not None


async def remove_reaction(
    db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID, emoji: str
) -> bool:
    stmt = (
        delete(Reaction)
        .where(
            Reaction.message_id == message_id,
            Reaction.user_id == user_id,
            Reaction.emoji == emoji,
        )
        .returning(Reaction.message_id)
    )
    return (await db.execute(stmt)).first() is not None
