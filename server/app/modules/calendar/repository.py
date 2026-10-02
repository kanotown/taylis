import uuid
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.calendar.models import (
    MAX_ALL_DAY_DAYS,
    MAX_TIMED_DAYS,
    CalendarEvent,
    CalendarEventAlarm,
    CalendarEventOverride,
    CalendarFeed,
)


async def get(db: AsyncSession, event_id: uuid.UUID, *, lock: bool = False) -> CalendarEvent | None:
    stmt = select(CalendarEvent).where(CalendarEvent.id == event_id)
    if lock:
        stmt = stmt.with_for_update()
    return (await db.execute(stmt)).scalar_one_or_none()


async def by_client_id(
    db: AsyncSession, owner_id: uuid.UUID, client_event_id: uuid.UUID
) -> CalendarEvent | None:
    stmt = select(CalendarEvent).where(
        CalendarEvent.owner_id == owner_id, CalendarEvent.client_event_id == client_event_id
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def overlapping(
    db: AsyncSession,
    *,
    owner_id: uuid.UUID | None,
    channel_ids: list[uuid.UUID],
    start: datetime,
    end: datetime,
    first_day: date,
    last_day: date,
    limit: int,
) -> list[CalendarEvent]:
    """Live one-off events overlapping [start, end): timed ones by instant, all-day ones by date
    (first_day..last_day, the caller's days). `owner_id` adds that person's own calendar.
    Recurring events are `recurring_overlapping`'s.

    The start bounds (an event lasts at most 14 / 60 days) keep the scans on the indexes."""
    whose = _whose(owner_id, channel_ids)
    if not whose:
        return []
    timed = and_(
        CalendarEvent.all_day.is_(False),
        CalendarEvent.starts_at < end,
        CalendarEvent.starts_at >= start - timedelta(days=MAX_TIMED_DAYS),
        CalendarEvent.ends_at > start,
    )
    all_day = and_(
        CalendarEvent.all_day.is_(True),
        CalendarEvent.start_date <= last_day,
        CalendarEvent.start_date > first_day - timedelta(days=MAX_ALL_DAY_DAYS),
        CalendarEvent.end_date >= first_day,
    )
    stmt = (
        select(CalendarEvent)
        .where(
            CalendarEvent.deleted_at.is_(None),
            CalendarEvent.rrule.is_(None),
            or_(*whose),
            or_(timed, all_day),
        )
        .order_by(
            CalendarEvent.start_date.asc().nulls_last(),
            CalendarEvent.starts_at.asc().nulls_last(),
            CalendarEvent.id,
        )
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


def _whose(owner_id: uuid.UUID | None, channel_ids: list[uuid.UUID]) -> list[Any]:
    whose: list[Any] = []
    if owner_id is not None:
        whose.append(and_(CalendarEvent.channel_id.is_(None), CalendarEvent.owner_id == owner_id))
    if channel_ids:
        whose.append(CalendarEvent.channel_id.in_(channel_ids))
    return whose


async def recurring_overlapping(
    db: AsyncSession,
    *,
    owner_id: uuid.UUID | None,
    channel_ids: list[uuid.UUID],
    start: datetime,
    end: datetime,
    first_day: date,
    last_day: date,
) -> list[CalendarEvent]:
    """Live recurring events that may have an occurrence in the range (M68): begun before its
    end and not over before its start, or with an occurrence moved into it. The caller expands."""
    whose = _whose(owner_id, channel_ids)
    if not whose:
        return []
    begun = or_(
        and_(CalendarEvent.all_day.is_(False), CalendarEvent.starts_at < end),
        and_(CalendarEvent.all_day.is_(True), CalendarEvent.start_date <= last_day),
    )
    not_over = or_(CalendarEvent.series_end.is_(None), CalendarEvent.series_end >= start)
    moved_in = (
        select(CalendarEventOverride.series_id)
        .where(
            CalendarEventOverride.cancelled.is_(False),
            or_(
                and_(
                    CalendarEventOverride.all_day.is_(False),
                    CalendarEventOverride.starts_at < end,
                    CalendarEventOverride.ends_at > start,
                ),
                and_(
                    CalendarEventOverride.all_day.is_(True),
                    CalendarEventOverride.start_date <= last_day,
                    CalendarEventOverride.end_date >= first_day,
                ),
            ),
        )
        .scalar_subquery()
    )
    stmt = (
        select(CalendarEvent)
        .where(
            CalendarEvent.deleted_at.is_(None),
            CalendarEvent.rrule.is_not(None),
            or_(*whose),
            or_(and_(begun, not_over), CalendarEvent.id.in_(moved_in)),
        )
        .order_by(CalendarEvent.id)
    )
    return list((await db.execute(stmt)).scalars().all())


async def overrides_of(
    db: AsyncSession, series_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[CalendarEventOverride]]:
    found: dict[uuid.UUID, list[CalendarEventOverride]] = {i: [] for i in series_ids}
    if not series_ids:
        return found
    stmt = (
        select(CalendarEventOverride)
        .where(CalendarEventOverride.series_id.in_(series_ids))
        .order_by(CalendarEventOverride.series_id, CalendarEventOverride.occurrence_start)
    )
    for row in (await db.execute(stmt)).scalars().all():
        found[row.series_id].append(row)
    return found


async def overrides_list(db: AsyncSession, series_id: uuid.UUID) -> list[CalendarEventOverride]:
    return (await overrides_of(db, [series_id]))[series_id]


async def override(
    db: AsyncSession, series_id: uuid.UUID, key: str
) -> CalendarEventOverride | None:
    return await db.get(CalendarEventOverride, (series_id, key))


async def delete_overrides(db: AsyncSession, series_id: uuid.UUID) -> None:
    await db.execute(
        delete(CalendarEventOverride).where(CalendarEventOverride.series_id == series_id)
    )


async def feeds_of(db: AsyncSession, user_id: uuid.UUID) -> list[CalendarFeed]:
    stmt = (
        select(CalendarFeed)
        .where(CalendarFeed.user_id == user_id)
        .order_by(CalendarFeed.created_at, CalendarFeed.id)
    )
    return list((await db.execute(stmt)).scalars().all())


async def feed_by_hash(db: AsyncSession, token_hash: bytes) -> CalendarFeed | None:
    stmt = select(CalendarFeed).where(CalendarFeed.token_hash == token_hash)
    return (await db.execute(stmt)).scalar_one_or_none()


async def alarm(
    db: AsyncSession, event_id: uuid.UUID, user_id: uuid.UUID
) -> CalendarEventAlarm | None:
    return await db.get(CalendarEventAlarm, (event_id, user_id))


async def alarms_of_user(
    db: AsyncSession, user_id: uuid.UUID, event_ids: list[uuid.UUID]
) -> dict[uuid.UUID, CalendarEventAlarm]:
    if not event_ids:
        return {}
    stmt = select(CalendarEventAlarm).where(
        CalendarEventAlarm.user_id == user_id, CalendarEventAlarm.event_id.in_(event_ids)
    )
    return {row.event_id: row for row in (await db.execute(stmt)).scalars().all()}


async def alarms_of_event(db: AsyncSession, event_id: uuid.UUID) -> list[CalendarEventAlarm]:
    stmt = (
        select(CalendarEventAlarm)
        .where(CalendarEventAlarm.event_id == event_id)
        .order_by(CalendarEventAlarm.user_id)
        .with_for_update()
    )
    return list((await db.execute(stmt)).scalars().all())


async def due_alarms(db: AsyncSession, now: datetime, limit: int) -> list[CalendarEventAlarm]:
    stmt = (
        select(CalendarEventAlarm)
        .where(CalendarEventAlarm.status == "pending", CalendarEventAlarm.fire_at <= now)
        .order_by(CalendarEventAlarm.fire_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    return list((await db.execute(stmt)).scalars().all())


async def delete_alarms_in_channel(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID
) -> int:
    """Someone left a channel: their alarms on its events go (CALENDAR.md §3)."""
    events = select(CalendarEvent.id).where(CalendarEvent.channel_id == channel_id)
    result = await db.execute(
        delete(CalendarEventAlarm)
        .where(CalendarEventAlarm.user_id == user_id, CalendarEventAlarm.event_id.in_(events))
        .returning(CalendarEventAlarm.event_id)
    )
    return len(result.all())
