import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.invites.models import Invite


async def get(db: AsyncSession, invite_id: uuid.UUID) -> Invite | None:
    return await db.get(Invite, invite_id)


async def get_by_token_hash(
    db: AsyncSession, token_hash: bytes, *, for_update: bool = False
) -> Invite | None:
    stmt = select(Invite).where(Invite.token_hash == token_hash)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def list_all(db: AsyncSession) -> list[Invite]:
    stmt = select(Invite).order_by(Invite.created_at.desc())
    return list((await db.execute(stmt)).scalars().all())
