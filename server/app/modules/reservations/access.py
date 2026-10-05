"""Who may manage or operate a reservation pool, and who may read an operator's notice
(docs/RESERVATIONS.md §1, §5). Plain rules on loaded rows, shared by the service, the activity
list and badge, the WebSocket audience and the push planner, so they never disagree.

An operator's notice (a to-do) names the people concerned with their e-mail addresses, so it is
written only for those who can operate the pool, and checked again whenever it is shown or
delivered: someone who lost the right since (made a guest, deactivated, taken off the pool's
operators) no longer sees one queued or kept for them (review v0.1.37 #2)."""

import uuid

from sqlalchemy import ColumnElement, and_, any_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.reservations.models import ReservationNotice, ReservationPool
from app.modules.users.models import User


def can_manage(user: User, pool: ReservationPool) -> bool:
    return user.is_admin or (user.id == pool.created_by and not user.is_guest)


def can_operate(user: User, pool: ReservationPool) -> bool:
    return can_manage(user, pool) or (user.id in pool.operator_ids and not user.is_guest)


def may_receive_operator_notice(user: User, pool: ReservationPool) -> bool:
    return user.is_active and user.role != "bot" and can_operate(user, pool)


def may_read(user: User, notice: ReservationNotice, pool: ReservationPool | None) -> bool:
    """Whether `user` may see this notice now: their own news always; an operator's notice only
    while they can operate its pool."""
    if not notice.operator:
        return True
    return pool is not None and may_receive_operator_notice(user, pool)


async def may_deliver(db: AsyncSession, notice_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    """For the WebSocket audience and the push planner: the notice still exists and its reader
    may read it now."""
    notice = await db.get(ReservationNotice, notice_id)
    if notice is None:
        return False
    if not notice.operator:
        return True
    user = await db.get(User, user_id, populate_existing=True)
    pool = await db.get(ReservationPool, notice.pool_id, populate_existing=True)
    return user is not None and may_read(user, notice, pool)


def readable_clause() -> ColumnElement[bool]:
    """may_read in SQL, for a query that joins ReservationPool and the reader's User row."""
    return or_(
        ReservationNotice.operator.is_(False),
        and_(
            User.deactivated_at.is_(None),
            or_(
                User.role == "admin",
                and_(
                    User.role.not_in(("guest", "bot")),
                    or_(
                        ReservationPool.created_by == User.id,
                        User.id == any_(ReservationPool.operator_ids),
                    ),
                ),
            ),
        ),
    )


def readable_notices(user_id: uuid.UUID):  # type: ignore[no-untyped-def]
    """The reader's notices joined with their pool and the reader, filtered by may_read."""
    return (
        select(ReservationNotice, ReservationPool)
        .join(ReservationPool, ReservationPool.id == ReservationNotice.pool_id)
        .join(User, User.id == ReservationNotice.user_id)
        .where(ReservationNotice.user_id == user_id, readable_clause())
    )
