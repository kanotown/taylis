import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.reminders.models import Reminder


async def get(db: AsyncSession, reminder_id: uuid.UUID) -> Reminder | None:
    return await db.get(Reminder, reminder_id)


async def list_open_for_user(db: AsyncSession, user_id: uuid.UUID) -> list[Reminder]:
    """Fired first (newest nudge on top), then pending by time."""
    stmt = (
        select(Reminder)
        .where(Reminder.user_id == user_id, Reminder.status.in_(("pending", "fired")))
        .order_by(Reminder.status.asc(), Reminder.remind_at.asc())
    )
    rows = list((await db.execute(stmt)).scalars().all())
    fired = sorted(
        (r for r in rows if r.status == "fired"), key=lambda r: r.remind_at, reverse=True
    )
    pending = [r for r in rows if r.status == "pending"]
    return fired + pending


async def count_open_for_user(db: AsyncSession, user_id: uuid.UUID) -> int:
    stmt = (
        select(func.count())
        .select_from(Reminder)
        .where(Reminder.user_id == user_id, Reminder.status.in_(("pending", "fired")))
    )
    return int((await db.execute(stmt)).scalar_one())


async def fired_count(db: AsyncSession, user_id: uuid.UUID) -> int:
    stmt = (
        select(func.count())
        .select_from(Reminder)
        .where(Reminder.user_id == user_id, Reminder.status == "fired")
    )
    return int((await db.execute(stmt)).scalar_one())


async def due(db: AsyncSession, now: datetime, limit: int) -> list[Reminder]:
    stmt = (
        select(Reminder)
        .where(Reminder.status == "pending", Reminder.remind_at <= now)
        .order_by(Reminder.remind_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    return list((await db.execute(stmt)).scalars().all())
