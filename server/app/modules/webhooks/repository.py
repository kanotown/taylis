import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.webhooks.models import Webhook


async def get(
    db: AsyncSession, webhook_id: uuid.UUID, *, for_update: bool = False
) -> Webhook | None:
    stmt = select(Webhook).where(Webhook.id == webhook_id)
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_by_token_hash(db: AsyncSession, token_hash: bytes) -> Webhook | None:
    return (
        await db.execute(select(Webhook).where(Webhook.token_hash == token_hash))
    ).scalar_one_or_none()


async def list_all(db: AsyncSession) -> list[Webhook]:
    return list(
        (await db.execute(select(Webhook).order_by(Webhook.created_at.desc()))).scalars().all()
    )
