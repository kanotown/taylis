import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.channels.models import Channel
from app.modules.reservations.models import (
    ACTIVE_STATUSES,
    Reservation,
    ReservationBot,
    ReservationPool,
)


async def get_pool(
    db: AsyncSession, pool_id: uuid.UUID, *, for_update: bool = False, skip_locked: bool = False
) -> ReservationPool | None:
    stmt = select(ReservationPool).where(ReservationPool.id == pool_id)
    if for_update:
        stmt = stmt.with_for_update(skip_locked=skip_locked).execution_options(
            populate_existing=True
        )
    return (await db.execute(stmt)).scalar_one_or_none()


async def pools_for_channel(db: AsyncSession, channel_id: uuid.UUID) -> list[ReservationPool]:
    stmt = (
        select(ReservationPool)
        .where(ReservationPool.channel_id == channel_id)
        .order_by(ReservationPool.created_at.asc(), ReservationPool.id.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def count_for_channel(db: AsyncSession, channel_id: uuid.UUID) -> int:
    stmt = (
        select(func.count())
        .select_from(ReservationPool)
        .where(ReservationPool.channel_id == channel_id)
    )
    return int((await db.execute(stmt)).scalar_one())


async def get_reservation(db: AsyncSession, reservation_id: uuid.UUID) -> Reservation | None:
    stmt = (
        select(Reservation)
        .where(Reservation.id == reservation_id)
        .execution_options(populate_existing=True)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def active_rows(db: AsyncSession, pool_ids: list[uuid.UUID]) -> list[Reservation]:
    """The pools' requests in the queue or holding a seat (fresh from the database)."""
    if not pool_ids:
        return []
    stmt = (
        select(Reservation)
        .where(Reservation.pool_id.in_(pool_ids), Reservation.status.in_(ACTIVE_STATUSES))
        .order_by(Reservation.requested_at.asc(), Reservation.id.asc())
        .execution_options(populate_existing=True)
    )
    return list((await db.execute(stmt)).scalars().all())


async def bot_row(db: AsyncSession, channel_id: uuid.UUID) -> ReservationBot | None:
    stmt = select(ReservationBot).where(ReservationBot.channel_id == channel_id)
    return (await db.execute(stmt)).scalar_one_or_none()


async def pools_to_watch(db: AsyncSession) -> list[uuid.UUID]:
    """Pools where time may change something: someone waits, or a holder was told they go."""
    busy = (
        select(Reservation.pool_id)
        .where(
            or_(
                Reservation.status == "waiting",
                Reservation.evict_notice_at.is_not(None)
                & Reservation.status.in_(("holding", "returning")),
            )
        )
        .distinct()
    )
    stmt = (
        select(ReservationPool.id)
        .join(Channel, Channel.id == ReservationPool.channel_id)
        .where(ReservationPool.id.in_(busy), Channel.archived_at.is_(None))
        .order_by(ReservationPool.id)
    )
    return list((await db.execute(stmt)).scalars().all())
