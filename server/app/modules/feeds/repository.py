import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.feeds.models import ChannelFeed


async def get(
    db: AsyncSession, feed_id: uuid.UUID, *, for_update: bool = False
) -> ChannelFeed | None:
    stmt = select(ChannelFeed).where(ChannelFeed.id == feed_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def list_for_channel(db: AsyncSession, channel_id: uuid.UUID) -> list[ChannelFeed]:
    stmt = (
        select(ChannelFeed)
        .where(ChannelFeed.channel_id == channel_id)
        .order_by(ChannelFeed.created_at.asc(), ChannelFeed.id.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def count_for_channel(db: AsyncSession, channel_id: uuid.UUID) -> int:
    stmt = select(func.count()).select_from(ChannelFeed).where(ChannelFeed.channel_id == channel_id)
    return int((await db.execute(stmt)).scalar_one())


async def count_for_owner(db: AsyncSession, owner_id: uuid.UUID) -> int:
    stmt = select(func.count()).select_from(ChannelFeed).where(ChannelFeed.owner_id == owner_id)
    return int((await db.execute(stmt)).scalar_one())


async def find_by_url(db: AsyncSession, channel_id: uuid.UUID, url: str) -> ChannelFeed | None:
    stmt = select(ChannelFeed).where(ChannelFeed.channel_id == channel_id, ChannelFeed.url == url)
    return (await db.execute(stmt)).scalar_one_or_none()


async def bot_of_channel(db: AsyncSession, channel_id: uuid.UUID) -> uuid.UUID | None:
    """The bot the channel's feeds post as (they share one)."""
    stmt = (
        select(ChannelFeed.bot_user_id)
        .where(ChannelFeed.channel_id == channel_id)
        .order_by(ChannelFeed.created_at.asc())
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def bot_in_use(db: AsyncSession, bot_user_id: uuid.UUID, *, besides: uuid.UUID) -> bool:
    stmt = (
        select(ChannelFeed.id)
        .where(ChannelFeed.bot_user_id == bot_user_id, ChannelFeed.id != besides)
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none() is not None


async def claim_due(db: AsyncSession, now: datetime, limit: int) -> list[ChannelFeed]:
    """Enabled feeds whose time has come, locked (another worker skips them)."""
    stmt = (
        select(ChannelFeed)
        .where(ChannelFeed.enabled.is_(True), ChannelFeed.next_fetch_at <= now)
        .order_by(ChannelFeed.next_fetch_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    return list((await db.execute(stmt)).scalars().all())
