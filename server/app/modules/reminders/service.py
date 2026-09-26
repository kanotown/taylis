"""Reminders (M12e).

A reminder is personal: only its owner sees it. When its time comes the worker marks it
`fired` and writes reminder.updated; the push planner turns that event into a nudge on the
owner's devices, and the clients list fired reminders until they are marked done.
"""

import uuid
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import bad_request, not_found
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.messages import service as messages
from app.modules.messages.mentions import notification_text
from app.modules.reminders import repository as repo
from app.modules.reminders.events import REMINDER_UPDATED, ReminderUpdatedData
from app.modules.reminders.models import Reminder
from app.modules.reminders.schemas import ReminderCreate, ReminderOut
from app.modules.users.models import User

MIN_LEAD = timedelta(seconds=30)
MAX_LEAD = timedelta(days=366)
PREVIEW_LENGTH = 200


def to_out(row: Reminder) -> ReminderOut:
    return ReminderOut(
        id=row.id,
        message_id=row.message_id,
        channel_id=row.channel_id,
        note=row.note,
        preview=row.preview or "",
        remind_at=row.remind_at,
        status=row.status,  # type: ignore[arg-type]
        fired_at=row.fired_at,
        created_at=row.created_at,
    )


async def _emit(db: AsyncSession, row: Reminder) -> None:
    await write_outbox(
        db,
        event_type=REMINDER_UPDATED,
        audience_type="user",
        audience_id=row.user_id,
        channel_id=row.channel_id,
        payload=ReminderUpdatedData(reminder=to_out(row)).model_dump(mode="json"),
    )


async def create(
    db: AsyncSession, actor: User, message_id: uuid.UUID, data: ReminderCreate
) -> ReminderOut:
    message = await messages.get_message(db, actor, message_id)  # membership is checked here
    now = utcnow()
    if data.remind_at < now + MIN_LEAD:
        raise bad_request("remind_at_too_soon", "Pick a time at least a minute ahead")
    if data.remind_at > now + MAX_LEAD:
        raise bad_request("remind_at_too_far", "Pick a time within a year")
    preview = notification_text(message.body or "", {})[:PREVIEW_LENGTH]
    row = Reminder(
        user_id=actor.id,
        message_id=message.id,
        channel_id=message.channel_id,
        note=(data.note or "").strip() or None,
        preview=preview or "(添付ファイル)",
        remind_at=data.remind_at,
    )
    db.add(row)
    await db.flush()
    await _emit(db, row)
    await db.commit()
    return to_out(row)


async def list_mine(db: AsyncSession, actor: User) -> list[ReminderOut]:
    return [to_out(row) for row in await repo.list_open_for_user(db, actor.id)]


async def close(db: AsyncSession, actor: User, reminder_id: uuid.UUID) -> None:
    """DELETE: a pending reminder is cancelled, a fired one is done; either way it
    leaves the list."""
    row = await repo.get(db, reminder_id)
    if row is None or row.user_id != actor.id or row.status not in ("pending", "fired"):
        raise not_found("reminder_not_found", "No such reminder")
    row.status = "cancelled" if row.status == "pending" else "done"
    row.updated_at = utcnow()
    await _emit(db, row)
    await db.commit()


async def fire_due(db: AsyncSession, *, now: datetime | None = None, limit: int = 50) -> int:
    """Marks due reminders fired; the outbox event carries the nudge to the push planner."""
    moment = now or utcnow()
    fired = 0
    for row in await repo.due(db, moment, limit):
        row.status = "fired"
        row.fired_at = moment
        row.updated_at = moment
        await _emit(db, row)
        fired += 1
    await db.commit()
    return fired


async def fired_count(db: AsyncSession, user_id: uuid.UUID) -> int:
    return await repo.fired_count(db, user_id)
