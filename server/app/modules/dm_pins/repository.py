import uuid

from sqlalchemy import and_, delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.channels.models import ChannelMember  # read-only (ARCHITECTURE.md §5 exception)
from app.modules.dm_pins.models import ConversationPin


async def add(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> bool:
    """False when it was pinned already (it keeps its place)."""
    stmt = (
        pg_insert(ConversationPin)
        .values(user_id=user_id, channel_id=channel_id)
        .on_conflict_do_nothing(index_elements=["user_id", "channel_id"])
    )
    result = await db.execute(stmt)
    return bool(getattr(result, "rowcount", 0))  # a CursorResult at runtime (DML)


async def remove(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> bool:
    result = await db.execute(
        delete(ConversationPin).where(
            ConversationPin.user_id == user_id, ConversationPin.channel_id == channel_id
        )
    )
    return bool(getattr(result, "rowcount", 0))


async def member_channel_ids(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Pinned conversations the user still belongs to, oldest pin first (a pin survives leaving
    a group DM, but is not shown)."""
    stmt = (
        select(ConversationPin.channel_id)
        .join(
            ChannelMember,
            and_(
                ChannelMember.channel_id == ConversationPin.channel_id,
                ChannelMember.user_id == ConversationPin.user_id,
            ),
        )
        .where(ConversationPin.user_id == user_id)
        .order_by(ConversationPin.created_at, ConversationPin.channel_id)
    )
    return list((await db.execute(stmt)).scalars().all())
