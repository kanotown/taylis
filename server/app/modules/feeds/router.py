from uuid import UUID

from fastapi import APIRouter, Request, Response

from app.core.db import Db
from app.core.errors import rate_limited
from app.core.ratelimit import RateLimiter
from app.modules.auth.deps import CurrentUser
from app.modules.feeds import service
from app.modules.feeds.schemas import FeedBotOut, FeedBotUpdate, FeedCreate, FeedOut, FeedUpdate

router = APIRouter(tags=["feeds"])

# docs/FEEDS.md §3. Whoever reads the channel sees its feeds; any member (not a guest) adds one,
# which is theirs; its owner, the channel's owners and administrators pause, resume and delete it.


@router.get("/channels/{channel_id}/feeds", response_model=list[FeedOut])
async def list_feeds(channel_id: UUID, user: CurrentUser, db: Db) -> list[FeedOut]:
    """The channel's feeds, oldest first (paused ones too), with the last fetch's outcome."""
    return await service.list_for_channel(db, user, channel_id)


@router.post("/channels/{channel_id}/feeds", response_model=FeedOut, status_code=201)
async def create_feed(
    channel_id: UUID, body: FeedCreate, request: Request, user: CurrentUser, db: Db
) -> FeedOut:
    """Fetches the URL once: it must be an RSS / Atom feed (or a page naming one), else 422
    feed_invalid with `details.reason`. Its current entries are recorded and not posted. At most
    20 per channel (409 too_many_channel_feeds) and 20 per person (409 too_many_feeds)."""
    limiter: RateLimiter = request.app.state.limiters["link_preview"]
    key = f"feed:{user.id}"
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))
    return await service.create(
        db,
        user,
        channel_id,
        body,
        settings=request.app.state.settings,
        fetch=request.app.state.feed_fetcher,
    )


@router.get("/channels/{channel_id}/feed-bot", response_model=FeedBotOut)
async def get_feed_bot(channel_id: UUID, user: CurrentUser, db: Db) -> FeedBotOut:
    """The channel's feed bot (null before the first feed), and for administrators the bots
    that may be adopted as it (M98)."""
    return await service.get_bot(db, user, channel_id)


@router.patch("/channels/{channel_id}/feed-bot", response_model=FeedBotOut)
async def update_feed_bot(
    channel_id: UUID, body: FeedBotUpdate, user: CurrentUser, db: Db
) -> FeedBotOut:
    """`display_name`: rename the feed bot (channel owners, administrators; 404
    feed_bot_not_found before the first feed). `bot_user_id`: administrators make one of the
    `candidates` the feed bot (409 feed_bot_unavailable otherwise); the feeds never deactivate
    an adopted bot. Both may come together (adopted first, then renamed)."""
    return await service.update_bot(db, user, channel_id, body)


@router.patch("/feeds/{feed_id}", response_model=FeedOut)
async def update_feed(feed_id: UUID, body: FeedUpdate, user: CurrentUser, db: Db) -> FeedOut:
    """Pause (`enabled: false`) or resume; entries published while paused are not posted."""
    return await service.update(db, user, feed_id, body)


@router.delete("/feeds/{feed_id}", status_code=204)
async def delete_feed(feed_id: UUID, user: CurrentUser, db: Db) -> Response:
    """Stops it for good; the posts stay."""
    await service.delete(db, user, feed_id)
    return Response(status_code=204)
