from uuid import UUID

from fastapi import APIRouter, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.recurring import service
from app.modules.recurring.schemas import (
    RecurringPostCreate,
    RecurringPostOut,
    RecurringPostUpdate,
    RecurringRunOut,
)

router = APIRouter(tags=["recurring"])

# RECURRING.md §3. Whoever reads the channel sees its recurring posts; the channel's owners and
# the administrators among its members manage them (403 recurring_manage_restricted).


@router.get("/channels/{channel_id}/recurring-posts", response_model=list[RecurringPostOut])
async def list_recurring_posts(
    channel_id: UUID, user: CurrentUser, db: Db
) -> list[RecurringPostOut]:
    """The channel's recurring posts, oldest first (paused ones too)."""
    return await service.list_for_channel(db, user, channel_id)


@router.post(
    "/channels/{channel_id}/recurring-posts", response_model=RecurringPostOut, status_code=201
)
async def create_recurring_post(
    channel_id: UUID, body: RecurringPostCreate, user: CurrentUser, db: Db
) -> RecurringPostOut:
    """A new recurring post with its own bot (named `name`), which joins the channel. At most 20
    per channel (409 too_many_recurring_posts)."""
    return await service.create(db, user, channel_id, body)


@router.patch("/recurring-posts/{post_id}", response_model=RecurringPostOut)
async def update_recurring_post(
    post_id: UUID, body: RecurringPostUpdate, user: CurrentUser, db: Db
) -> RecurringPostOut:
    """Changes apply to the next posts. A new schedule or zone, and resuming, compute
    next_run_at again from now."""
    return await service.update(db, user, post_id, body)


@router.delete("/recurring-posts/{post_id}", status_code=204)
async def delete_recurring_post(post_id: UUID, user: CurrentUser, db: Db) -> Response:
    """Stops it for good; the posts made (and their collections) stay."""
    await service.delete(db, user, post_id)
    return Response(status_code=204)


@router.post("/recurring-posts/{post_id}/run", response_model=RecurringRunOut, status_code=201)
async def run_recurring_post(post_id: UUID, user: CurrentUser, db: Db) -> RecurringRunOut:
    """今すぐ投稿: posts now (also while paused); the next scheduled time stays."""
    return RecurringRunOut(message_id=await service.run_now(db, user, post_id))
