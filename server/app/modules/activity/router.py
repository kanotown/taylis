from datetime import datetime

from fastapi import APIRouter, Query

from app.core.db import Db
from app.modules.activity import service
from app.modules.activity.schemas import (
    ActivityFilter,
    ActivityListOut,
    ActivityReadIn,
    ActivitySummaryOut,
)
from app.modules.auth.deps import CurrentUser

router = APIRouter(tags=["activity"])


@router.get("/activity", response_model=ActivityListOut)
async def list_activity(
    user: CurrentUser,
    db: Db,
    filter: ActivityFilter = "all",
    cursor: datetime | None = None,
    limit: int = Query(default=50, ge=1, le=100),
) -> ActivityListOut:
    """Mentions of me, reactions to my messages and replies in threads I follow, newest first
    (M39)."""
    return await service.list_activity(db, user, kind=filter, cursor=cursor, limit=limit)


@router.get("/activity/summary", response_model=ActivitySummaryOut)
async def activity_summary(user: CurrentUser, db: Db) -> ActivitySummaryOut:
    """The activity tab's badge: items after my read position."""
    return await service.summary(db, user)


@router.put("/activity/read", response_model=ActivitySummaryOut)
async def mark_activity_read(user: CurrentUser, body: ActivityReadIn, db: Db) -> ActivitySummaryOut:
    """Everything up to `read_at` is read (it only moves forward)."""
    return await service.mark_read(db, user, body.read_at)
