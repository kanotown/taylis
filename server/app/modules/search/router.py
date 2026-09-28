from uuid import UUID

from fastapi import APIRouter, Query, Request
from pydantic import AwareDatetime

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.auth.deps import CurrentUser
from app.modules.search import service
from app.modules.search.schemas import MAX_QUERY_LENGTH, HasFlag, SearchOut, SearchQuery, SearchSort

router = APIRouter(prefix="/search", tags=["search"])


@router.get("/messages", response_model=SearchOut)
async def search_messages(
    request: Request,
    user: CurrentUser,
    db: Db,
    q: str = Query(default="", max_length=MAX_QUERY_LENGTH),
    channel_id: UUID | None = None,
    from_user_id: UUID | None = None,
    after: AwareDatetime | None = None,
    before: AwareDatetime | None = None,
    has: list[HasFlag] = Query(default=[]),
    is_thread: bool = False,
    sort: SearchSort = "relevance",
    tz_offset_minutes: int = Query(default=0, ge=-840, le=840),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000),
) -> SearchOut:
    limiter = request.app.state.limiters["search"]
    key = str(user.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))
    params = SearchQuery(
        q=q,
        channel_id=channel_id,
        from_user_id=from_user_id,
        after=after,
        before=before,
        has=has,
        is_thread=is_thread,
        sort=sort,
        tz_offset_minutes=tz_offset_minutes,
        limit=limit,
        offset=offset,
    )
    settings = request.app.state.settings
    return await service.search(
        db, user, params, timeout_ms=settings.search_timeout_ms, gate=request.app.state.search_gate
    )
