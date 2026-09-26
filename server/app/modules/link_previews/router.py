from fastapi import APIRouter, Query, Request

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.auth.deps import CurrentUser
from app.modules.link_previews import service
from app.modules.link_previews.schemas import LinkPreviewOut
from app.modules.link_previews.service import MAX_URL_LENGTH

router = APIRouter(prefix="/link-previews", tags=["link-previews"])


@router.get("", response_model=LinkPreviewOut)
async def get_link_preview(
    request: Request,
    user: CurrentUser,
    db: Db,
    url: str = Query(min_length=8, max_length=MAX_URL_LENGTH),
) -> LinkPreviewOut:
    """Open Graph data for a link in a message (M11g); cached, rate limited per user."""
    limiter = request.app.state.limiters["link_preview"]
    key = str(user.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))
    state = request.app.state
    return await service.get_preview(db, url, settings=state.settings, fetch=state.link_fetcher)
