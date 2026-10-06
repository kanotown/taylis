from typing import Literal, get_args
from uuid import UUID

from fastapi import APIRouter, Query, Request
from pydantic import AwareDatetime

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.auth.deps import CurrentUser
from app.modules.search import service
from app.modules.search.schemas import (
    MAX_QUERY_LENGTH,
    CanvasSearchOut,
    CanvasSearchQuery,
    HasFlag,
    PageSearchOut,
    PageSearchQuery,
    SearchOut,
    SearchQuery,
    SearchSort,
)
from app.modules.users.models import User

router = APIRouter(prefix="/search", tags=["search"])


def _limit(request: Request, user: User) -> None:
    """Searches per user per minute (settings.search_rate_limit_per_user), messages and canvases
    together."""
    limiter = request.app.state.limiters["search"]
    key = str(user.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))


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
    # One of each flag at most (the model's own limit; past it the request is a 422, not a 500).
    has: list[HasFlag] = Query(default=[], max_length=len(get_args(HasFlag))),
    is_thread: bool = False,
    is_times: bool = False,
    sort: SearchSort = "relevance",
    tz_offset_minutes: int = Query(default=0, ge=-840, le=840),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000),
) -> SearchOut:
    _limit(request, user)
    params = SearchQuery(
        q=q,
        channel_id=channel_id,
        from_user_id=from_user_id,
        after=after,
        before=before,
        has=has,
        is_thread=is_thread,
        is_times=is_times,
        sort=sort,
        tz_offset_minutes=tz_offset_minutes,
        limit=limit,
        offset=offset,
    )
    settings = request.app.state.settings
    return await service.search(
        db, user, params, timeout_ms=settings.search_timeout_ms, gate=request.app.state.search_gate
    )


@router.get("/canvases", response_model=CanvasSearchOut)
async def search_canvases(
    request: Request,
    user: CurrentUser,
    db: Db,
    q: str = Query(default="", max_length=MAX_QUERY_LENGTH),
    channel_id: UUID | None = None,
    from_user_id: UUID | None = Query(
        default=None, description="The canvas's creator or its last editor"
    ),
    after: AwareDatetime | None = Query(default=None, description="Updated at or after"),
    before: AwareDatetime | None = Query(default=None, description="Updated before"),
    sort: SearchSort = "relevance",
    tz_offset_minutes: int = Query(default=0, ge=-840, le=840),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000),
) -> CanvasSearchOut:
    """M42 (CANVAS.md §4.8): canvases of my conversations whose title or body matches (Japanese
    and English, Groonga query syntax as for messages; from:@ in:# before: after: on:), with a
    plain-text excerpt around the first match."""
    _limit(request, user)
    params = CanvasSearchQuery(
        q=q,
        channel_id=channel_id,
        from_user_id=from_user_id,
        after=after,
        before=before,
        sort=sort,
        tz_offset_minutes=tz_offset_minutes,
        limit=limit,
        offset=offset,
    )
    settings = request.app.state.settings
    return await service.search_canvases(
        db, user, params, timeout_ms=settings.search_timeout_ms, gate=request.app.state.search_gate
    )


@router.get("/pages", response_model=PageSearchOut)
async def search_pages(
    request: Request,
    user: CurrentUser,
    db: Db,
    q: str = Query(default="", max_length=MAX_QUERY_LENGTH),
    in_page: UUID | None = Query(default=None, description="This page and the pages below it"),
    from_user_id: UUID | None = Query(
        default=None, description="The page's creator or its last editor"
    ),
    after: AwareDatetime | None = Query(default=None, description="Updated at or after"),
    before: AwareDatetime | None = Query(default=None, description="Updated before"),
    kind: Literal["page", "database", "row"] | None = None,
    sort: SearchSort = "relevance",
    tz_offset_minutes: int = Query(default=0, ge=-840, le=840),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10_000),
) -> PageSearchOut:
    """M120 (docs/WIKI.md §8.1): wiki pages I can read whose title, body or properties match
    (Japanese and English, the same query syntax; in:<page title> narrows to a subtree), with an
    excerpt. Pages I cannot read are never counted."""
    _limit(request, user)
    params = PageSearchQuery(
        q=q,
        in_page=in_page,
        from_user_id=from_user_id,
        after=after,
        before=before,
        kind=kind,
        sort=sort,
        tz_offset_minutes=tz_offset_minutes,
        limit=limit,
        offset=offset,
    )
    settings = request.app.state.settings
    return await service.search_pages(
        db, user, params, timeout_ms=settings.search_timeout_ms, gate=request.app.state.search_gate
    )
