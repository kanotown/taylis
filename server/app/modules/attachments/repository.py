import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attachments.models import Attachment


async def get(db: AsyncSession, attachment_id: uuid.UUID) -> Attachment | None:
    return await db.get(Attachment, attachment_id)


async def get_many(db: AsyncSession, ids: list[uuid.UUID]) -> list[Attachment]:
    if not ids:
        return []
    stmt = select(Attachment).where(Attachment.id.in_(ids))
    return list((await db.execute(stmt)).scalars().all())


async def for_messages(db: AsyncSession, message_ids: list[uuid.UUID]) -> list[Attachment]:
    if not message_ids:
        return []
    stmt = (
        select(Attachment)
        .where(Attachment.message_id.in_(message_ids), Attachment.status == "attached")
        .order_by(Attachment.created_at.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def for_message(db: AsyncSession, message_id: uuid.UUID) -> list[Attachment]:
    stmt = select(Attachment).where(Attachment.message_id == message_id)
    return list((await db.execute(stmt)).scalars().all())


async def expired_pending(db: AsyncSession, before: datetime, limit: int) -> list[Attachment]:
    stmt = (
        select(Attachment)
        .where(Attachment.status == "pending", Attachment.created_at < before)
        .order_by(Attachment.created_at.asc())
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


async def deleted(db: AsyncSession, limit: int) -> list[Attachment]:
    stmt = (
        select(Attachment)
        .where(Attachment.status == "deleted")
        .order_by(Attachment.deleted_at.asc())
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


async def all_live(db: AsyncSession) -> list[Attachment]:
    stmt = select(Attachment).where(Attachment.status != "deleted")
    return list((await db.execute(stmt)).scalars().all())
