import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.scheduled.models import ScheduledMessage


async def get(
    db: AsyncSession, scheduled_id: uuid.UUID, *, for_update: bool = False
) -> ScheduledMessage | None:
    return await db.get(ScheduledMessage, scheduled_id, with_for_update=for_update)


async def get_by_client_msg_id(
    db: AsyncSession, client_msg_id: uuid.UUID
) -> ScheduledMessage | None:
    stmt = select(ScheduledMessage).where(ScheduledMessage.client_msg_id == client_msg_id)
    return (await db.execute(stmt)).scalar_one_or_none()


async def list_open_for_user(db: AsyncSession, user_id: uuid.UUID) -> list[ScheduledMessage]:
    """Pending rows, and failed ones the user has not dismissed yet (their text is still wanted)."""
    stmt = (
        select(ScheduledMessage)
        .where(
            ScheduledMessage.user_id == user_id,
            ScheduledMessage.status.in_(("pending", "failed")),
        )
        .order_by(ScheduledMessage.send_at.asc(), ScheduledMessage.id.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def count_open_for_user(db: AsyncSession, user_id: uuid.UUID) -> int:
    stmt = (
        select(func.count())
        .select_from(ScheduledMessage)
        .where(
            ScheduledMessage.user_id == user_id,
            ScheduledMessage.status.in_(("pending", "failed")),
        )
    )
    return int((await db.execute(stmt)).scalar_one())


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
