"""Saved messages (M11c). Membership is checked through `messages`; a change fans out to the
user's own devices as bookmark.updated (outbox, audience user)."""

import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.events.outbox import write_outbox
from app.modules.bookmarks import repository as repo
from app.modules.bookmarks.events import BOOKMARK_UPDATED, BookmarkUpdatedData
from app.modules.bookmarks.schemas import BookmarkItem, BookmarkListOut, BookmarkStateOut
from app.modules.messages import service as messages
from app.modules.users.models import User


async def set_bookmark(
    db: AsyncSession, actor: User, message_id: uuid.UUID, *, bookmarked: bool
) -> tuple[BookmarkStateOut, bool]:
    message = await messages.get_message(db, actor, message_id)
    changed = (
        await repo.add(db, actor.id, message.id)
        if bookmarked
        else await repo.remove(db, actor.id, message.id)
    )
    if changed:
        await write_outbox(
            db,
            event_type=BOOKMARK_UPDATED,
            audience_type="user",
            audience_id=actor.id,
            channel_id=message.channel_id,
            payload=BookmarkUpdatedData(
                message_id=message.id, channel_id=message.channel_id, bookmarked=bookmarked
            ).model_dump(mode="json"),
        )
    await db.commit()
    return BookmarkStateOut(message_id=message.id, bookmarked=bookmarked), changed


async def list_bookmarks(
    db: AsyncSession, actor: User, *, cursor: datetime | None, limit: int
) -> BookmarkListOut:
    rows = await repo.list_for_user(db, actor.id, before=cursor, limit=limit)
    outs = await messages.messages_out(db, [message for _, message in rows])
    items = [
        BookmarkItem(message=out, created_at=bookmark.created_at)
        for out, (bookmark, _) in zip(outs, rows, strict=True)
    ]
    return BookmarkListOut(items=items, next_cursor=rows[-1][0].created_at if rows else None)


async def ids_for(db: AsyncSession, user_id: uuid.UUID) -> list[uuid.UUID]:
    return await repo.live_ids(db, user_id)
