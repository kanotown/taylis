"""Block lookups for the modules that act on them (messages, channels, notifications, activity).

Only reads, and only the models: the modules that import this never depend on the moderation
service (which itself posts messages), so there is no import cycle.
"""

import uuid
from collections.abc import Collection

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute
from sqlalchemy.sql.elements import ColumnElement

from app.modules.moderation.models import UserBlock


async def blocked_ids_of(db: AsyncSession, blocker_id: uuid.UUID) -> list[uuid.UUID]:
    """The people `blocker_id` blocked, oldest block first."""
    stmt = (
        select(UserBlock.blocked_id)
        .where(UserBlock.blocker_id == blocker_id)
        .order_by(UserBlock.created_at, UserBlock.blocked_id)
    )
    return list((await db.execute(stmt)).scalars().all())


async def is_blocked(db: AsyncSession, blocker_id: uuid.UUID, blocked_id: uuid.UUID) -> bool:
    stmt = select(
        exists().where(UserBlock.blocker_id == blocker_id, UserBlock.blocked_id == blocked_id)
    )
    return bool(await db.scalar(stmt))


async def blockers_among(
    db: AsyncSession, blocked_id: uuid.UUID, candidates: Collection[uuid.UUID]
) -> set[uuid.UUID]:
    """Which of `candidates` blocked `blocked_id` (push planning: they get nothing from them)."""
    if not candidates:
        return set()
    stmt = select(UserBlock.blocker_id).where(
        UserBlock.blocked_id == blocked_id, UserBlock.blocker_id.in_(list(candidates))
    )
    return set((await db.execute(stmt)).scalars().all())


def not_blocked_by(
    blocker_id: uuid.UUID, author: ColumnElement[uuid.UUID] | InstrumentedAttribute[uuid.UUID]
) -> ColumnElement[bool]:
    """A WHERE clause: `author` is not someone `blocker_id` blocked (the activity lists)."""
    return ~exists().where(UserBlock.blocker_id == blocker_id, UserBlock.blocked_id == author)
