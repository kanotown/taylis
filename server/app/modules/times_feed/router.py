from fastapi import APIRouter, Query

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.times_feed import service
from app.modules.times_feed.schemas import TimesFeedOut

router = APIRouter(tags=["times"])


@router.get("/times/feed", response_model=TimesFeedOut)
async def times_feed(
    user: CurrentUser,
    db: Db,
    cursor: str | None = Query(default=None, max_length=100),
    limit: int = Query(default=50, ge=1, le=100),
) -> TimesFeedOut:
    """L8: the timeline posts of the times I follow and have not muted, newest first
    (docs/TIMES_FEED.md). `cursor` is the previous page's `next_cursor`."""
    return await service.feed(db, user, cursor=cursor, limit=limit)
