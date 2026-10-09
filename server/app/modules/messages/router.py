from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Path, Query, Request, Response

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.auth.deps import CurrentUser
from app.modules.messages import service
from app.modules.messages.schemas import (
    EMOJI_MAX_LENGTH,
    EMOJI_PATTERN,
    AckPendingOut,
    DeltaOut,
    HistoryOut,
    MentionListOut,
    MessageCreate,
    MessageEdit,
    MessageOut,
    MessageRevisionOut,
    PollAnswersIn,
    PollDecideIn,
)

router = APIRouter(tags=["messages"])

Emoji = Path(min_length=1, max_length=EMOJI_MAX_LENGTH, pattern=EMOJI_PATTERN)


@router.post("/channels/{channel_id}/messages", response_model=MessageOut)
async def create_message(
    channel_id: UUID,
    user: CurrentUser,
    body: MessageCreate,
    db: Db,
    request: Request,
    response: Response,
) -> MessageOut:
    limiter = request.app.state.limiters["message"]  # SECURITY.md §5: posts per user per minute
    key = str(user.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))
    message, created = await service.create_message(db, user, channel_id, body)
    response.status_code = 201 if created else 200
    return await service.message_out(db, message, user.id)


@router.get("/channels/{channel_id}/messages", response_model=HistoryOut)
async def list_history(
    channel_id: UUID,
    user: CurrentUser,
    db: Db,
    before_seq: int | None = Query(default=None, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
) -> HistoryOut:
    return await service.list_history(db, user, channel_id, before_seq=before_seq, limit=limit)


@router.get("/channels/{channel_id}/sync", response_model=DeltaOut)
async def list_delta(
    channel_id: UUID,
    user: CurrentUser,
    db: Db,
    since_seq: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=200),
) -> DeltaOut:
    return await service.list_delta(db, user, channel_id, since_seq=since_seq, limit=limit)


@router.get("/messages/{message_id}", response_model=MessageOut)
async def get_message(message_id: UUID, user: CurrentUser, db: Db) -> MessageOut:
    message = await service.get_readable_message(db, user, message_id)  # M27: also a public preview
    return await service.message_out(db, message, user.id)


@router.get("/messages/{message_id}/replies", response_model=list[MessageOut])
async def list_replies(message_id: UUID, user: CurrentUser, db: Db) -> list[MessageOut]:
    return await service.list_replies(db, user, message_id)


@router.get("/messages/{message_id}/context", response_model=list[MessageOut])
async def message_context(
    message_id: UUID, user: CurrentUser, db: Db, limit: int = Query(default=25, ge=1, le=100)
) -> list[MessageOut]:
    return await service.message_context(db, user, message_id, limit)


@router.get("/messages/{message_id}/revisions", response_model=list[MessageRevisionOut])
async def list_revisions(message_id: UUID, user: CurrentUser, db: Db) -> list[MessageRevisionOut]:
    """M14c: the bodies earlier edits replaced, oldest first (author only)."""
    return await service.list_revisions(db, user, message_id)


@router.patch("/messages/{message_id}", response_model=MessageOut)
async def edit_message(
    message_id: UUID, user: CurrentUser, body: MessageEdit, db: Db
) -> MessageOut:
    return await service.edit_message(db, user, message_id, body)


@router.delete("/messages/{message_id}", response_model=MessageOut)
async def delete_message(message_id: UUID, user: CurrentUser, db: Db) -> MessageOut:
    """Returns the tombstone so the caller can apply it locally."""
    return await service.delete_message(db, user, message_id)


@router.get("/mentions", response_model=MentionListOut)
async def list_mentions(
    user: CurrentUser,
    db: Db,
    cursor: datetime | None = None,
    limit: int = Query(default=50, ge=1, le=100),
) -> MentionListOut:
    """Messages that mention me or everyone, in my channels, newest first (M11h)."""
    return await service.list_mentions(db, user, cursor=cursor, limit=limit)


@router.get("/channels/{channel_id}/pins", response_model=list[MessageOut])
async def list_pins(
    channel_id: UUID, user: CurrentUser, db: Db, limit: int = Query(default=100, ge=1, le=200)
) -> list[MessageOut]:
    """Pinned messages, most recently pinned first (M11c)."""
    return await service.list_pins(db, user, channel_id, limit)


@router.put("/messages/{message_id}/pin", response_model=MessageOut)
async def pin_message(
    message_id: UUID, user: CurrentUser, db: Db, response: Response
) -> MessageOut:
    message, changed = await service.set_pin(db, user, message_id, pinned=True)
    response.status_code = 201 if changed else 200
    return message


@router.delete("/messages/{message_id}/pin", response_model=MessageOut)
async def unpin_message(message_id: UUID, user: CurrentUser, db: Db) -> MessageOut:
    message, _ = await service.set_pin(db, user, message_id, pinned=False)
    return message


@router.put("/messages/{message_id}/poll/votes/{index}", response_model=MessageOut)
async def vote(
    message_id: UUID, index: int, user: CurrentUser, db: Db, response: Response
) -> MessageOut:
    """M14b: vote for an option (a single-choice poll moves the vote); 201 when it changed."""
    message, changed = await service.set_vote(db, user, message_id, index, present=True)
    response.status_code = 201 if changed else 200
    return message


@router.delete("/messages/{message_id}/poll/votes/{index}", response_model=MessageOut)
async def unvote(message_id: UUID, index: int, user: CurrentUser, db: Db) -> MessageOut:
    message, _ = await service.set_vote(db, user, message_id, index, present=False)
    return message


@router.put("/messages/{message_id}/ack", response_model=MessageOut)
async def acknowledge(message_id: UUID, user: CurrentUser, db: Db) -> MessageOut:
    """M15e: 「確認しました」 on a message that asks for it (not your own); idempotent."""
    return await service.set_ack(db, user, message_id, present=True)


@router.get("/messages/{message_id}/ack/pending", response_model=AckPendingOut)
async def ack_pending(message_id: UUID, user: CurrentUser, db: Db) -> AckPendingOut:
    """L4: the channel's members (not the author, bots or deactivated people) yet to acknowledge."""
    return AckPendingOut(user_ids=await service.ack_pending(db, user, message_id))


@router.delete("/messages/{message_id}/ack", response_model=MessageOut)
async def unacknowledge(message_id: UUID, user: CurrentUser, db: Db) -> MessageOut:
    return await service.set_ack(db, user, message_id, present=False)


@router.put("/messages/{message_id}/poll/answers", response_model=MessageOut)
async def set_poll_answers(
    message_id: UUID, body: PollAnswersIn, user: CurrentUser, db: Db, response: Response
) -> MessageOut:
    """M53: my yes / maybe / no on a scheduling poll, all at once (slots left out become
    unanswered), and my comment (a string sets it, null or blank removes it, left out keeps
    it). 201 when something changed. 409 poll_decided / poll_closed once it takes no answers."""
    message, changed = await service.set_answers(db, user, message_id, body)
    response.status_code = 201 if changed else 200
    return message


@router.post("/messages/{message_id}/poll/decide", response_model=MessageOut)
async def decide_poll(
    message_id: UUID,
    body: PollDecideIn,
    user: CurrentUser,
    db: Db,
    request: Request,
    response: Response,
) -> MessageOut:
    """M53: the poll's author, the channel's owners and administrators decide a slot. The answers
    close, the event goes into the channel's calendar (not in a DM, nor with create_event false)
    and a thread reply says so. The same slot again: 200, nothing changes; another: 409."""
    message, changed = await service.decide_poll(
        db, user, message_id, body, base_url=public_base_url(request)
    )
    response.status_code = 201 if changed else 200
    return message


@router.delete("/messages/{message_id}/poll/decide", response_model=MessageOut)
async def undecide_poll(message_id: UUID, user: CurrentUser, db: Db) -> MessageOut:
    """M53: take the decision back (answers open again). The calendar event stays."""
    return await service.undecide_poll(db, user, message_id)


def public_base_url(request: Request) -> str:
    """The address links point at: PUBLIC_BASE_URL when set, else the one the request came to
    (behind the reverse proxy, uvicorn's --proxy-headers make it the public one)."""
    configured: str = request.app.state.settings.public_base_url.strip()
    return (configured or str(request.base_url)).rstrip("/")


@router.post("/messages/{message_id}/poll/close", response_model=MessageOut)
async def close_poll(message_id: UUID, user: CurrentUser, db: Db) -> MessageOut:
    """M14b: the author ends the voting (only the author, not an administrator)."""
    return await service.close_poll(db, user, message_id)


@router.put("/messages/{message_id}/reactions/{emoji}", response_model=MessageOut)
async def add_reaction(
    message_id: UUID, user: CurrentUser, db: Db, response: Response, emoji: str = Emoji
) -> MessageOut:
    message, changed = await service.set_reaction(db, user, message_id, emoji, present=True)
    response.status_code = 201 if changed else 200
    return message


@router.delete("/messages/{message_id}/reactions/{emoji}", response_model=MessageOut)
async def remove_reaction(
    message_id: UUID, user: CurrentUser, db: Db, emoji: str = Emoji
) -> MessageOut:
    message, _ = await service.set_reaction(db, user, message_id, emoji, present=False)
    return message
