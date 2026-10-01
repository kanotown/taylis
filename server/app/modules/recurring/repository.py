import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.channels.models import ChannelMember
from app.modules.recurring.models import Collection, RecurringPost
from app.modules.users.models import User  # read-only


async def get(
    db: AsyncSession, post_id: uuid.UUID, *, for_update: bool = False
) -> RecurringPost | None:
    stmt = select(RecurringPost).where(
        RecurringPost.id == post_id, RecurringPost.deleted_at.is_(None)
    )
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def list_for_channel(db: AsyncSession, channel_id: uuid.UUID) -> list[RecurringPost]:
    stmt = (
        select(RecurringPost)
        .where(RecurringPost.channel_id == channel_id, RecurringPost.deleted_at.is_(None))
        .order_by(RecurringPost.created_at.asc(), RecurringPost.id.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def count_for_channel(db: AsyncSession, channel_id: uuid.UUID) -> int:
    stmt = (
        select(func.count())
        .select_from(RecurringPost)
        .where(RecurringPost.channel_id == channel_id, RecurringPost.deleted_at.is_(None))
    )
    return int((await db.execute(stmt)).scalar_one())


async def due(db: AsyncSession, now: datetime, limit: int) -> list[RecurringPost]:
    stmt = (
        select(RecurringPost)
        .where(
            RecurringPost.enabled.is_(True),
            RecurringPost.deleted_at.is_(None),
            RecurringPost.next_run_at <= now,
        )
        .order_by(RecurringPost.next_run_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    return list((await db.execute(stmt)).scalars().all())


async def overdue_collections(db: AsyncSession, now: datetime, limit: int) -> list[Collection]:
    stmt = (
        select(Collection)
        .where(Collection.reminded_at.is_(None), Collection.due_at <= now)
        .order_by(Collection.due_at.asc())
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    return list((await db.execute(stmt)).scalars().all())


async def get_post_any(db: AsyncSession, post_id: uuid.UUID) -> RecurringPost | None:
    """Also a deleted one (its collections stay)."""
    return await db.get(RecurringPost, post_id)


async def eligible_members(db: AsyncSession, channel_id: uuid.UUID) -> list[uuid.UUID]:
    """The channel's people who can submit: active, not bots. By display name."""
    stmt = (
        select(User.id)
        .join(ChannelMember, ChannelMember.user_id == User.id)
        .where(
            ChannelMember.channel_id == channel_id,
            User.role != "bot",
            User.deactivated_at.is_(None),
        )
        .order_by(User.display_name, User.id)
    )
    return list((await db.execute(stmt)).scalars().all())
