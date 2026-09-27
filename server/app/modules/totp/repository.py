import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.totp.models import UserTotp


async def get(db: AsyncSession, user_id: uuid.UUID, *, for_update: bool = False) -> UserTotp | None:
    stmt = select(UserTotp).where(UserTotp.user_id == user_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def remove(db: AsyncSession, user_id: uuid.UUID) -> bool:
    result = await db.execute(delete(UserTotp).where(UserTotp.user_id == user_id))
    return bool(getattr(result, "rowcount", 0))


async def enabled_ids(db: AsyncSession, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    if not ids:
        return set()
    stmt = select(UserTotp.user_id).where(
        UserTotp.user_id.in_(ids), UserTotp.enabled_at.is_not(None)
    )
    return set((await db.execute(stmt)).scalars().all())
