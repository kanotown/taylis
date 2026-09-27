import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.emoji.models import CustomEmoji


async def get(db: AsyncSession, emoji_id: uuid.UUID) -> CustomEmoji | None:
    return await db.get(CustomEmoji, emoji_id)


async def get_by_name(db: AsyncSession, name: str) -> CustomEmoji | None:
    return (
        await db.execute(select(CustomEmoji).where(CustomEmoji.name == name))
    ).scalar_one_or_none()


async def list_all(db: AsyncSession) -> list[CustomEmoji]:
    return list((await db.execute(select(CustomEmoji).order_by(CustomEmoji.name))).scalars().all())
