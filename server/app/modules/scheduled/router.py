from uuid import UUID

from fastapi import APIRouter, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.messages.schemas import MessageOut
from app.modules.scheduled import service
from app.modules.scheduled.schemas import ScheduledCreate, ScheduledOut

router = APIRouter(tags=["scheduled"])


@router.post("/channels/{channel_id}/scheduled", response_model=ScheduledOut, status_code=201)
async def schedule_message(
    channel_id: UUID, data: ScheduledCreate, user: CurrentUser, db: Db
) -> ScheduledOut:
    """M12d 「後で送信」: the server posts this at send_at (at least a minute ahead)."""
    return await service.create(db, user, channel_id, data)


@router.get("/scheduled", response_model=list[ScheduledOut])
async def list_scheduled(user: CurrentUser, db: Db) -> list[ScheduledOut]:
    """My pending scheduled messages, soonest first."""
    return await service.list_mine(db, user)


@router.delete("/scheduled/{scheduled_id}", status_code=204)
async def cancel_scheduled(scheduled_id: UUID, user: CurrentUser, db: Db) -> Response:
    await service.cancel(db, user, scheduled_id)
    return Response(status_code=204)


@router.post("/scheduled/{scheduled_id}/send-now", response_model=MessageOut)
async def send_scheduled_now(scheduled_id: UUID, user: CurrentUser, db: Db) -> MessageOut:
    return await service.send_now(db, user, scheduled_id)
