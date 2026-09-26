import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.scheduled.models import ScheduledMessage


async def get(db: AsyncSession, scheduled_id: uuid.UUID) -> ScheduledMessage | None:
    return await db.get(ScheduledMessage, scheduled_id)


async def list_pending_for_user(db: AsyncSession, user_id: uuid.UUID) -> list[ScheduledMessage]:
    stmt = (
        select(ScheduledMessage)
        .where(ScheduledMessage.user_id == user_id, ScheduledMessage.status == "pending")
        .order_by(ScheduledMessage.send_at.asc(), ScheduledMessage.id.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def due(db: AsyncSession, now: datetime, limit: int) -> list[ScheduledMessage]:
    """Pending rows whose time has come, locked so a second worker skips them."""
    stmt = (
        select(ScheduledMessage)
        .where(ScheduledMessage.status == "pending", ScheduledMessage.send_at <= now)
        .order_by(ScheduledMessage.send_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    return list((await db.execute(stmt)).scalars().all())
