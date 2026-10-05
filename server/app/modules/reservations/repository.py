import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.groups.models import UserGroupMember
from app.modules.reservations import access
from app.modules.reservations.models import (
    ACTIVE_STATUSES,
    Reservation,
    ReservationBot,
    ReservationNotice,
    ReservationPool,
)
from app.modules.users.models import User


async def get_pool(
    db: AsyncSession, pool_id: uuid.UUID, *, for_update: bool = False, skip_locked: bool = False
) -> ReservationPool | None:
    stmt = select(ReservationPool).where(ReservationPool.id == pool_id)
    if for_update:
        stmt = stmt.with_for_update(skip_locked=skip_locked).execution_options(
            populate_existing=True
        )
    return (await db.execute(stmt)).scalar_one_or_none()


async def all_pools(db: AsyncSession) -> list[ReservationPool]:
    stmt = select(ReservationPool).order_by(
        ReservationPool.created_at.asc(), ReservationPool.id.asc()
    )
    return list((await db.execute(stmt)).scalars().all())


async def get_reservation(db: AsyncSession, reservation_id: uuid.UUID) -> Reservation | None:
    stmt = (
        select(Reservation)
        .where(Reservation.id == reservation_id)
        .execution_options(populate_existing=True)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def active_rows(db: AsyncSession, pool_ids: list[uuid.UUID]) -> list[Reservation]:
    """The pools' requests in the queue, booked or on a seat (fresh from the database)."""
    if not pool_ids:
        return []
    stmt = (
        select(Reservation)
        .where(Reservation.pool_id.in_(pool_ids), Reservation.status.in_(ACTIVE_STATUSES))
        .order_by(Reservation.requested_at.asc(), Reservation.id.asc())
        .execution_options(populate_existing=True)
    )
    return list((await db.execute(stmt)).scalars().all())


async def done_bookings_since(
    db: AsyncSession, pool_ids: list[uuid.UUID], since: datetime
) -> list[Reservation]:
    """Bookings that were used and ended after `since` (today's timeline)."""
    if not pool_ids:
        return []
    stmt = (
        select(Reservation)
        .where(
            Reservation.pool_id.in_(pool_ids),
            Reservation.kind == "booking",
            Reservation.status == "done",
            Reservation.end_reason.in_(("returned", "removed")),
            Reservation.end_at > since,
        )
        .order_by(Reservation.start_at.asc(), Reservation.id.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def bot_row(db: AsyncSession, channel_id: uuid.UUID) -> ReservationBot | None:
    stmt = select(ReservationBot).where(ReservationBot.channel_id == channel_id)
    return (await db.execute(stmt)).scalar_one_or_none()


async def pools_to_watch(db: AsyncSession) -> list[uuid.UUID]:
    """Pools where time may change something: anyone waiting, booked or on a seat."""
    busy = select(Reservation.pool_id).where(Reservation.status.in_(ACTIVE_STATUSES)).distinct()
    stmt = (
        select(ReservationPool.id).where(ReservationPool.id.in_(busy)).order_by(ReservationPool.id)
    )
    return list((await db.execute(stmt)).scalars().all())


async def group_member_ids(db: AsyncSession, group_id: uuid.UUID) -> set[uuid.UUID]:
    stmt = select(UserGroupMember.user_id).where(UserGroupMember.group_id == group_id)
    return set((await db.execute(stmt)).scalars().all())


async def admin_ids(db: AsyncSession) -> list[uuid.UUID]:
    stmt = (
        select(User.id)
        .where(User.role == "admin", User.deactivated_at.is_(None))
        .order_by(User.created_at.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def notice(db: AsyncSession, user_id: uuid.UUID, key: str) -> ReservationNotice | None:
    stmt = select(ReservationNotice).where(
        ReservationNotice.user_id == user_id, ReservationNotice.key == key
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def operator_notice_keys(
    db: AsyncSession, pool_id: uuid.UUID, user_ids: list[uuid.UUID]
) -> set[str]:
    """Every to-do key these people (the pool's operators now) were ever told of (open or
    done). A key told only to someone who can no longer operate is told again to who can."""
    stmt = (
        select(ReservationNotice.key)
        .where(
            ReservationNotice.pool_id == pool_id,
            ReservationNotice.operator.is_(True),
            ReservationNotice.user_id.in_(user_ids),
        )
        .distinct()
    )
    return set((await db.execute(stmt)).scalars().all())


async def open_operator_notices(db: AsyncSession, pool_id: uuid.UUID) -> list[ReservationNotice]:
    stmt = select(ReservationNotice).where(
        ReservationNotice.pool_id == pool_id,
        ReservationNotice.operator.is_(True),
        ReservationNotice.done_at.is_(None),
    )
    return list((await db.execute(stmt)).scalars().all())


async def notices_for(
    db: AsyncSession, user_id: uuid.UUID, *, before: datetime | None, limit: int
) -> list[tuple[ReservationNotice, str]]:
    """The activity items of kind reservation, newest first, with the pool's name; an
    operator's notice only while the reader can operate the pool (access.may_read)."""
    stmt = access.readable_notices(user_id).order_by(ReservationNotice.at.desc()).limit(limit)
    if before is not None:
        stmt = stmt.where(ReservationNotice.at < before)
    return [(row[0], row[1].name) for row in (await db.execute(stmt)).all()]


def unread_notices(user_id: uuid.UUID, since: datetime):  # type: ignore[no-untyped-def]
    """Not done, after the read position, readable now (access.may_read)."""
    return (
        access.readable_notices(user_id)
        .with_only_columns(ReservationNotice.id)
        .where(ReservationNotice.at > since, ReservationNotice.done_at.is_(None))
    )
