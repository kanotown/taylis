from uuid import UUID

from fastapi import APIRouter, Query, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.messages import service
from app.modules.messages.schemas import HistoryOut, MessageCreate, MessageOut, to_message_out

router = APIRouter(tags=["messages"])


@router.post("/channels/{channel_id}/messages", response_model=MessageOut)
async def create_message(
    channel_id: UUID, user: CurrentUser, body: MessageCreate, db: Db, response: Response
) -> MessageOut:
    message, created = await service.create_message(db, user, channel_id, body)
    response.status_code = 201 if created else 200
    return to_message_out(message)


@router.get("/channels/{channel_id}/messages", response_model=HistoryOut)
async def list_history(
    channel_id: UUID,
    user: CurrentUser,
    db: Db,
    before_seq: int | None = Query(default=None, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
) -> HistoryOut:
    return await service.list_history(db, user, channel_id, before_seq=before_seq, limit=limit)


@router.get("/messages/{message_id}", response_model=MessageOut)
async def get_message(message_id: UUID, user: CurrentUser, db: Db) -> MessageOut:
    return to_message_out(await service.get_message(db, user, message_id))
