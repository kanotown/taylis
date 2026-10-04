import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.emoji.models import CustomEmoji, EmojiPack


async def get(db: AsyncSession, emoji_id: uuid.UUID) -> CustomEmoji | None:
    return await db.get(CustomEmoji, emoji_id)


async def get_by_name(db: AsyncSession, name: str) -> CustomEmoji | None:
    return (
        await db.execute(select(CustomEmoji).where(CustomEmoji.name == name))
    ).scalar_one_or_none()


async def get_by_names(db: AsyncSession, names: Sequence[str]) -> list[CustomEmoji]:
    if not names:
        return []
    return list(
        (await db.execute(select(CustomEmoji).where(CustomEmoji.name.in_(list(names)))))
        .scalars()
        .all()
    )


async def list_all(db: AsyncSession) -> list[CustomEmoji]:
    return list((await db.execute(select(CustomEmoji).order_by(CustomEmoji.name))).scalars().all())


async def get_pack_by_name(db: AsyncSession, name: str) -> EmojiPack | None:
    return (await db.execute(select(EmojiPack).where(EmojiPack.name == name))).scalar_one_or_none()


async def list_packs(db: AsyncSession) -> list[EmojiPack]:
    stmt = select(EmojiPack).order_by(EmojiPack.position, EmojiPack.name)
    return list((await db.execute(stmt)).scalars().all())
