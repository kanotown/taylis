import uuid
from datetime import datetime

from sqlalchemy import and_, delete, exists, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.modules.bookmarks.models import Bookmark
from app.modules.channels.models import ChannelMember  # read-only: membership
from app.modules.messages.models import Message  # read-only (ARCHITECTURE.md §5 exception)


async def add(db: AsyncSession, user_id: uuid.UUID, message_id: uuid.UUID) -> bool:
    stmt = (
        pg_insert(Bookmark)
        .values(user_id=user_id, message_id=message_id)
        .on_conflict_do_nothing(index_elements=["user_id", "message_id"])
    )
    result = await db.execute(stmt)
    return bool(getattr(result, "rowcount", 0))  # a CursorResult at runtime (DML)


async def remove(db: AsyncSession, user_id: uuid.UUID, message_id: uuid.UUID) -> bool:
    result = await db.execute(
        delete(Bookmark).where(Bookmark.user_id == user_id, Bookmark.message_id == message_id)
    )
    return bool(getattr(result, "rowcount", 0))


def _visible(user_id: uuid.UUID) -> ColumnElement[bool]:
    """The message still exists and I am still in its channel (a bookmark must not keep showing
    a private channel's messages after I left it)."""
    return and_(
        Message.deleted_at.is_(None),
        exists(
            select(ChannelMember.user_id).where(
                ChannelMember.channel_id == Message.channel_id, ChannelMember.user_id == user_id
            )
        ),
    )


async def channel_of(db: AsyncSession, message_id: uuid.UUID) -> uuid.UUID | None:
    return (await db.execute(select(Message.channel_id).where(Message.id == message_id))).scalar()


async def live_ids(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Saved message ids I can still see (for bootstrap)."""
    stmt = (
        select(Bookmark.message_id)
        .join(Message, Message.id == Bookmark.message_id)
        .where(Bookmark.user_id == user_id, _visible(user_id))
        .order_by(Bookmark.created_at.desc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def list_for_user(
    db: AsyncSession, user_id: uuid.UUID, *, before: datetime | None, limit: int
) -> list[tuple[Bookmark, Message]]:
    stmt = (
        select(Bookmark, Message)
        .join(Message, Message.id == Bookmark.message_id)
        .where(Bookmark.user_id == user_id, _visible(user_id))
        .order_by(Bookmark.created_at.desc())
        .limit(limit)
    )
    if before is not None:
        stmt = stmt.where(Bookmark.created_at < before)
    return [(row[0], row[1]) for row in (await db.execute(stmt)).all()]
