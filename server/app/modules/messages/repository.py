import uuid

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.channels.models import Channel
from app.modules.messages.models import Message


async def allocate_seq(db: AsyncSession, channel_id: uuid.UUID) -> int:
    """Take the next channel sequence number. The row lock serialises writers until commit."""
    stmt = (
        update(Channel)
        .where(Channel.id == channel_id)
        .values(last_seq=Channel.last_seq + 1, last_message_at=func.now())
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
