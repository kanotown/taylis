from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Query, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.bookmarks import service
from app.modules.bookmarks.schemas import BookmarkListOut, BookmarkStateOut

router = APIRouter(tags=["bookmarks"])


@router.get("/bookmarks", response_model=BookmarkListOut)
async def list_bookmarks(
    user: CurrentUser,
    db: Db,
    cursor: datetime | None = None,
    limit: int = Query(default=50, ge=1, le=100),
) -> BookmarkListOut:
    """My saved messages, newest saved first; `cursor` is the previous page's `next_cursor`."""
    return await service.list_bookmarks(db, user, cursor=cursor, limit=limit)


@router.put("/messages/{message_id}/bookmark", response_model=BookmarkStateOut)
async def add_bookmark(
    message_id: UUID, user: CurrentUser, db: Db, response: Response
) -> BookmarkStateOut:
    state, changed = await service.set_bookmark(db, user, message_id, bookmarked=True)
    response.status_code = 201 if changed else 200
    return state


@router.delete("/messages/{message_id}/bookmark", response_model=BookmarkStateOut)
async def remove_bookmark(message_id: UUID, user: CurrentUser, db: Db) -> BookmarkStateOut:
    state, _ = await service.set_bookmark(db, user, message_id, bookmarked=False)
    return state
