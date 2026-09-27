import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.channel_links.models import ChannelLink


async def links_for(db: AsyncSession, channel_id: uuid.UUID) -> list[ChannelLink]:
    stmt = (
        select(ChannelLink)
        .where(ChannelLink.channel_id == channel_id)
        .order_by(ChannelLink.position, ChannelLink.created_at)
    )
    return list((await db.execute(stmt)).scalars().all())


async def get(db: AsyncSession, channel_id: uuid.UUID, link_id: uuid.UUID) -> ChannelLink | None:
    stmt = select(ChannelLink).where(
        ChannelLink.id == link_id, ChannelLink.channel_id == channel_id
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def remove(db: AsyncSession, link: ChannelLink) -> None:
    await db.delete(link)
