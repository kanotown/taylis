from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Path, Query, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.messages import service
from app.modules.messages.schemas import (
    EMOJI_PATTERN,
    DeltaOut,
    HistoryOut,
    MentionListOut,
    MessageCreate,
    MessageEdit,
    MessageOut,
)

router = APIRouter(tags=["messages"])

Emoji = Path(min_length=1, max_length=32, pattern=EMOJI_PATTERN)


@router.post("/channels/{channel_id}/messages", response_model=MessageOut)
async def create_message(
    channel_id: UUID, user: CurrentUser, body: MessageCreate, db: Db, response: Response
) -> MessageOut:
    message, created = await service.create_message(db, user, channel_id, body)
    response.status_code = 201 if created else 200
    return await service.message_out(db, message)


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
    return await service.message_out(db, await service.get_message(db, user, message_id))


@router.get("/messages/{message_id}/replies", response_model=list[MessageOut])
async def list_replies(message_id: UUID, user: CurrentUser, db: Db) -> list[MessageOut]:
    return await service.list_replies(db, user, message_id)


@router.get("/messages/{message_id}/context", response_model=list[MessageOut])
async def message_context(
    message_id: UUID, user: CurrentUser, db: Db, limit: int = Query(default=25, ge=1, le=100)
) -> list[MessageOut]:
    return await service.message_context(db, user, message_id, limit)


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


@router.post("/messages/{message_id}/poll/close", response_model=MessageOut)
async def close_poll(message_id: UUID, user: CurrentUser, db: Db) -> MessageOut:
    """M14b: the author or an administrator ends the voting."""
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
