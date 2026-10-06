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

# M76 (CANVAS.md §20): kinds only a client that names them gets (the phones before M77 fail on
# an item without `message`); the summary counts them only then, so the badge matches the list.
Include = Query(
    default=[],
    description=(
        "Extra kinds this client shows (repeat for several): canvas_mention (M76), "
        "reservation (M112), page_mention and page_shared (M120). "
        "Unknown values are ignored."
    ),
)


@router.get("/activity", response_model=ActivityListOut)
async def list_activity(
    user: CurrentUser,
    db: Db,
    filter: ActivityFilter = "all",
    cursor: datetime | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    include: list[str] = Include,
) -> ActivityListOut:
    """Mentions of me, reactions to my messages and replies in threads I follow, newest first
    (M39); with `include=canvas_mention`, canvases that mention me too (M76, under all and
    mentions); with `include=reservation`, reservation notices (M112, under all)."""
    return await service.list_activity(
        db, user, kind=filter, cursor=cursor, limit=limit, include=include
    )


@router.get("/activity/summary", response_model=ActivitySummaryOut)
async def activity_summary(
    user: CurrentUser, db: Db, include: list[str] = Include
) -> ActivitySummaryOut:
    """The activity tab's badge: items after my read position (the `include`d kinds too), less
    mentions and thread replies already read in their conversation (MOBILE_UI.md §6.4)."""
    return await service.summary(db, user, include)


@router.put("/activity/read", response_model=ActivitySummaryOut)
async def mark_activity_read(
    user: CurrentUser,
    body: ActivityReadIn,
    db: Db,
    include: list[str] = Include,
) -> ActivitySummaryOut:
    """Everything up to `read_at` is read (it only moves forward); every kind shares the one
    position."""
    return await service.mark_read(db, user, body.read_at, include)
