from uuid import UUID

from fastapi import APIRouter, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.reminders import service
from app.modules.reminders.schemas import AckRemindOut, ReminderCreate, ReminderOut

router = APIRouter(tags=["reminders"])


@router.post("/messages/{message_id}/reminders", response_model=ReminderOut, status_code=201)
async def create_reminder(
    message_id: UUID, data: ReminderCreate, user: CurrentUser, db: Db
) -> ReminderOut:
    """M12e 「リマインド」: a nudge about this message at remind_at (at least a minute ahead)."""
    return await service.create(db, user, message_id, data)


@router.post("/messages/{message_id}/ack/remind", response_model=AckRemindOut)
async def remind_unacknowledged(message_id: UUID, user: CurrentUser, db: Db) -> AckRemindOut:
    """L4: the author (or an administrator) reminds the members who have not acknowledged;
    each gets a reminder only they see. Once an hour per message (429 ack_remind_too_soon)."""
    return await service.remind_unacknowledged(db, user, message_id)


@router.get("/reminders", response_model=list[ReminderOut])
async def list_reminders(user: CurrentUser, db: Db) -> list[ReminderOut]:
    """My open reminders: fired ones first (newest nudge on top), then pending by time."""
    return await service.list_mine(db, user)


@router.delete("/reminders/{reminder_id}", status_code=204)
async def close_reminder(reminder_id: UUID, user: CurrentUser, db: Db) -> Response:
    """Cancels a pending reminder or marks a fired one done."""
    await service.close(db, user, reminder_id)
    return Response(status_code=204)
