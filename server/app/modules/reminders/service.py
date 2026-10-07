"""Reminders (M12e).

A reminder is personal: only its owner sees it. When its time comes the worker marks it
`fired` and writes reminder.updated; the push planner turns that event into a nudge on the
owner's devices, and the clients list fired reminders until they are marked done.
"""

import uuid
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app import i18n
from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.roles import has_capability
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.channels import service as channels
from app.modules.messages import service as messages
from app.modules.messages.mentions import notification_text
from app.modules.reminders import repository as repo
from app.modules.reminders.events import REMINDER_UPDATED, ReminderUpdatedData
from app.modules.reminders.models import Reminder
from app.modules.reminders.schemas import AckRemindOut, ReminderCreate, ReminderOut
from app.modules.users import service as users
from app.modules.users.models import User

MIN_LEAD = timedelta(seconds=30)
MAX_LEAD = timedelta(days=366)
PREVIEW_LENGTH = 200
# Open reminders (pending or fired) one person may have: it bounds GET /reminders too, whose
# list is the open rows (SECURITY.md §5).
MAX_OPEN_PER_USER = 200
# L4: how often the members who have not acknowledged a message may be reminded of it.
ACK_REMIND_INTERVAL = timedelta(hours=1)


def _preview(body: str | None) -> str:
    """From the live message: an edit shows up, and a deleted message leaves no text behind."""
    if body is None:
        return "(削除されたメッセージ)"
    return notification_text(body, {})[:PREVIEW_LENGTH] or "(添付ファイル)"


def to_out(row: Reminder, body: str | None) -> ReminderOut:
    return ReminderOut(
        id=row.id,
        message_id=row.message_id,
        channel_id=row.channel_id,
        note=row.note,
        preview=_preview(body),
        remind_at=row.remind_at,
        status=row.status,  # type: ignore[arg-type]
        fired_at=row.fired_at,
        created_at=row.created_at,
        kind=row.kind,  # type: ignore[arg-type]
    )


async def _emit(db: AsyncSession, row: Reminder, body: str | None) -> None:
    await write_outbox(
        db,
        event_type=REMINDER_UPDATED,
        audience_type="user",
        audience_id=row.user_id,
        channel_id=row.channel_id,
        payload=ReminderUpdatedData(reminder=to_out(row, body)).model_dump(mode="json"),
    )


async def _visible_bodies(db: AsyncSession, rows: list[Reminder]) -> dict[uuid.UUID, str]:
    """Bodies of the reminded messages the owners can still see (live, and still members)."""
    bodies = await messages.live_bodies(db, [row.message_id for row in rows])
    visible: dict[uuid.UUID, str] = {}
    for row in rows:
        body = bodies.get(row.message_id)
        if body is not None and await channels.membership_of(db, row.user_id, row.channel_id):
            visible[row.message_id] = body
    return visible


async def create(
    db: AsyncSession, actor: User, message_id: uuid.UUID, data: ReminderCreate
) -> ReminderOut:
    message = await messages.get_message(db, actor, message_id)  # membership is checked here
    now = utcnow()
    if data.remind_at < now + MIN_LEAD:
        raise bad_request("remind_at_too_soon", "Pick a time at least a minute ahead")
    if data.remind_at > now + MAX_LEAD:
        raise bad_request("remind_at_too_far", "Pick a time within a year")
    if await repo.count_open_for_user(db, actor.id) >= MAX_OPEN_PER_USER:
        raise conflict("too_many_reminders", f"At most {MAX_OPEN_PER_USER} reminders at a time")
    row = Reminder(
        user_id=actor.id,
        message_id=message.id,
        channel_id=message.channel_id,
        note=(data.note or "").strip() or None,
        preview="",  # never a copy of the body: it is read from the message when shown
        remind_at=data.remind_at,
    )
    db.add(row)
    await db.flush()
    await _emit(db, row, message.body or "")
    await db.commit()
    return to_out(row, message.body or "")


async def list_mine(db: AsyncSession, actor: User) -> list[ReminderOut]:
    """Reminders whose message is gone (or whose channel I left) are left out; the worker
    cancels them when they come due. A request to acknowledge that I have since acknowledged
    is left out too (L4), and a request to submit once I have replied in the thread (L6)."""
    rows = await repo.list_open_for_user(db, actor.id)
    bodies = await _visible_bodies(db, rows)
    acked = {
        row.message_id
        for row in rows
        if (row.kind == "ack" and await messages.has_acked(db, row.message_id, actor.id))
        or (row.kind == "collect" and await messages.has_live_reply(db, row.message_id, actor.id))
    }
    return [
        to_out(row, bodies[row.message_id])
        for row in rows
        if row.message_id in bodies and row.message_id not in acked
    ]


async def remind_unacknowledged(
    db: AsyncSession, actor: User, message_id: uuid.UUID
) -> AckRemindOut:
    """L4 (LAB.md H): the author or an administrator nudges the members who have not
    acknowledged, through a reminder only each of them sees (their list, push and badge), at
    most once an hour per message. Someone whose earlier nudge is still open is not nudged again."""
    message = await messages.require_ack_message(db, actor, message_id)
    if message.sender_id != actor.id and not has_capability(actor, "channels.moderate"):
        raise forbidden("ack_remind_forbidden", "Only the author or an administrator can remind")
    now = utcnow()
    last = await repo.last_created(db, message.id, "ack")
    if last is not None and now - last < ACK_REMIND_INTERVAL:
        wait = int((ACK_REMIND_INTERVAL - (now - last)).total_seconds()) + 1
        raise AppError(
            429,
            "ack_remind_too_soon",
            "Reminded less than an hour ago",
            details={"retry_after_seconds": wait},
        )
    pending = await messages.ack_pending_ids_in_tx(db, message)
    already = await repo.open_user_ids(db, message.id, "ack")
    body = message.body or ""
    reminded = 0
    people = await users.get_users(db, list(pending))
    for user_id in pending:
        if user_id in already:
            continue
        # M115: the note in the reader's language (docs/I18N.md).
        lc = await i18n.text_locale(db, people[user_id]) if user_id in people else "ja"
        note = i18n.t("reminder.ack_note", lc, name=actor.display_name)[:200]
        await create_system_in_tx(
            db,
            user_id=user_id,
            message_id=message.id,
            channel_id=message.channel_id,
            note=note,
            kind="ack",
            body=body,
            now=now,
        )
        reminded += 1
    await db.commit()
    return AckRemindOut(reminded=reminded)


async def create_system_in_tx(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    message_id: uuid.UUID,
    channel_id: uuid.UUID,
    note: str,
    kind: str,
    body: str,
    now: datetime,
) -> None:
    """A reminder made for someone (LAB.md §3): fired at once, so it reaches their list, their
    devices (the push planner) and their badge like one they set themselves."""
    row = Reminder(
        user_id=user_id,
        message_id=message_id,
        channel_id=channel_id,
        note=note,
        preview="",
        remind_at=now,
        status="fired",
        fired_at=now,
        kind=kind,
    )
    db.add(row)
    await db.flush()
    await _emit(db, row, body)


async def close(db: AsyncSession, actor: User, reminder_id: uuid.UUID) -> None:
    """DELETE: a pending reminder is cancelled, a fired one is done; either way it
    leaves the list."""
    row = await repo.get(db, reminder_id)
    if row is None or row.user_id != actor.id or row.status not in ("pending", "fired"):
        raise not_found("reminder_not_found", "No such reminder")
    row.status = "cancelled" if row.status == "pending" else "done"
    row.updated_at = utcnow()
    bodies = await _visible_bodies(db, [row])
    await _emit(db, row, bodies.get(row.message_id))
    await db.commit()


async def fire_due(db: AsyncSession, *, now: datetime | None = None, limit: int = 50) -> int:
    """Marks due reminders fired; the outbox event carries the nudge to the push planner."""
    moment = now or utcnow()
    fired = 0
    rows = await repo.due(db, moment, limit)
    bodies = await _visible_bodies(db, rows)
    for row in rows:
        row.updated_at = moment
        if row.message_id not in bodies:
            # Deleted, or the owner left the channel: nothing to remind of, nothing to leak.
            row.status = "cancelled"
            await _emit(db, row, None)
            continue
        row.status = "fired"
        row.fired_at = moment
        await _emit(db, row, bodies[row.message_id])
        fired += 1
    await db.commit()
    return fired


async def fired_count(db: AsyncSession, user_id: uuid.UUID) -> int:
    return await repo.fired_count(db, user_id)
