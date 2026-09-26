import uuid

from sqlalchemy import and_, delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.channels.models import ChannelMember  # read-only (ARCHITECTURE.md §5 exception)
from app.modules.favorites.models import ChannelFavorite


async def add(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> bool:
    stmt = (
        pg_insert(ChannelFavorite)
        .values(user_id=user_id, channel_id=channel_id)
        .on_conflict_do_nothing(index_elements=["user_id", "channel_id"])
    )
    result = await db.execute(stmt)
    return bool(getattr(result, "rowcount", 0))  # a CursorResult at runtime (DML)


async def remove(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> bool:
    result = await db.execute(
        delete(ChannelFavorite).where(
            ChannelFavorite.user_id == user_id, ChannelFavorite.channel_id == channel_id
        )
    )
    return bool(getattr(result, "rowcount", 0))


async def member_channel_ids(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Starred channels the user still belongs to (a star survives leaving, but is not shown)."""
    stmt = (
        select(ChannelFavorite.channel_id)
        .join(
            ChannelMember,
            and_(
                ChannelMember.channel_id == ChannelFavorite.channel_id,
                ChannelMember.user_id == ChannelFavorite.user_id,
            ),
        )
        .where(ChannelFavorite.user_id == user_id)
        .order_by(ChannelFavorite.created_at)
    )
    return list((await db.execute(stmt)).scalars().all())
