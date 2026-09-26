import uuid
from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookmarks.models import Bookmark
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


async def live_ids(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Saved message ids whose message still exists (for bootstrap; deleted ones are dropped)."""
    stmt = (
        select(Bookmark.message_id)
        .join(Message, Message.id == Bookmark.message_id)
        .where(Bookmark.user_id == user_id, Message.deleted_at.is_(None))
        .order_by(Bookmark.created_at.desc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def list_for_user(
    db: AsyncSession, user_id: uuid.UUID, *, before: datetime | None, limit: int
) -> list[tuple[Bookmark, Message]]:
    stmt = (
        select(Bookmark, Message)
        .join(Message, Message.id == Bookmark.message_id)
        .where(Bookmark.user_id == user_id, Message.deleted_at.is_(None))
        .order_by(Bookmark.created_at.desc())
        .limit(limit)
    )
    if before is not None:
        stmt = stmt.where(Bookmark.created_at < before)
    return [(row[0], row[1]) for row in (await db.execute(stmt)).all()]
