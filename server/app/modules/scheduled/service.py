"""Scheduled messages (M12d).

The row keeps the draft (body, attachments, thread) and the time; a worker posts it through the
ordinary message path with the row's client_msg_id as the idempotency key, so a crash between
posting and marking the row sent cannot post twice. Attachments are reserved (status
`scheduled`) so the pending-upload GC leaves them alone until they are bound or cancelled.
"""

import logging
import uuid
from datetime import datetime, timedelta

from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, bad_request, conflict, not_found
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.attachments import service as attachments
from app.modules.attachments.schemas import to_attachment_out
from app.modules.channels import service as channels
from app.modules.messages import service as messages
from app.modules.messages.models import Message
from app.modules.messages.schemas import MessageCreate, MessageOut
from app.modules.scheduled import repository as repo
from app.modules.scheduled.events import SCHEDULED_UPDATED, ScheduledUpdatedData
from app.modules.scheduled.models import ScheduledMessage
from app.modules.scheduled.schemas import ScheduledCreate, ScheduledOut
from app.modules.users import service as users
from app.modules.users.models import User

log = logging.getLogger("app.scheduled")

MIN_LEAD = timedelta(seconds=30)
MAX_LEAD = timedelta(days=366)
# Open rows (pending or failed and not yet dismissed) one person may have (SECURITY.md §5).
MAX_OPEN_PER_USER = 100


async def to_out(db: AsyncSession, row: ScheduledMessage) -> ScheduledOut:
    rows = await attachments.get_many(db, list(row.attachment_ids or []))
    return ScheduledOut(
        id=row.id,
        channel_id=row.channel_id,
        parent_id=row.parent_id,
        client_msg_id=row.client_msg_id,
        body=row.body,
        attachments=[to_attachment_out(a) for a in rows],
        send_at=row.send_at,
        status=row.status,  # type: ignore[arg-type]
        error=row.error,
        sent_message_id=row.sent_message_id,
        created_at=row.created_at,
    )


async def _emit(db: AsyncSession, row: ScheduledMessage) -> None:
    out = await to_out(db, row)
    await write_outbox(
        db,
        event_type=SCHEDULED_UPDATED,
        audience_type="user",
        audience_id=row.user_id,
        channel_id=row.channel_id,
        payload=ScheduledUpdatedData(scheduled=out).model_dump(mode="json"),
    )


async def create(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, data: ScheduledCreate
) -> ScheduledOut:
    existing = await repo.get_by_client_msg_id(db, data.client_msg_id)
    if existing is not None:
        return await _retried(db, actor, channel_id, existing)
    channel, _ = await channels.require_member(db, actor.id, channel_id)
    channels.require_writable(channel)
    now = utcnow()
    if data.send_at < now + MIN_LEAD:
        raise bad_request("send_at_too_soon", "Pick a time at least a minute ahead")
    if data.send_at > now + MAX_LEAD:
        raise bad_request("send_at_too_far", "Pick a time within a year")
    if await repo.count_open_for_user(db, actor.id) >= MAX_OPEN_PER_USER:
        raise conflict(
            "too_many_scheduled", f"At most {MAX_OPEN_PER_USER} scheduled messages at a time"
        )
    if data.parent_id is not None:
        parent = await messages.get_message(db, actor, data.parent_id)
        if parent.channel_id != channel.id or parent.parent_id is not None:
            raise bad_request("invalid_parent", "Replies go to a top-level message of the channel")
    actor_id, channel_id = actor.id, channel.id  # instances expire on rollback
    await attachments.reserve_in_tx(db, actor.id, data.attachment_ids)
    row = ScheduledMessage(
        user_id=actor.id,
        channel_id=channel.id,
        parent_id=data.parent_id,
        client_msg_id=data.client_msg_id,
        body=data.body,
        attachment_ids=list(data.attachment_ids),
        send_at=data.send_at,
    )
    db.add(row)
    try:
        await db.flush()
        await _emit(db, row)
        await db.commit()
    except IntegrityError:
        # The same request twice at once (a retry that overtook the first): the row the other
        # one made is the answer, as when it had been found above.
        await db.rollback()
        existing = await repo.get_by_client_msg_id(db, data.client_msg_id)
        if existing is None:
            raise
        actor = await users.require_user(db, actor_id)
        return await _retried(db, actor, channel_id, existing)
    return await to_out(db, row)


async def _retried(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, existing: ScheduledMessage
) -> ScheduledOut:
    """A retried request: the row it created (the key is global, so check whose it is)."""
    if existing.user_id != actor.id or existing.channel_id != channel_id:
        raise conflict("idempotency_conflict", "client_msg_id was already used")
    return await to_out(db, existing)


async def list_mine(db: AsyncSession, actor: User) -> list[ScheduledOut]:
    """Pending and failed rows: a failed one stays listed with its error until dismissed, so its
    text can be taken back into a draft (it was only in this row)."""
    return [await to_out(db, row) for row in await repo.list_open_for_user(db, actor.id)]


async def _require_pending(
    db: AsyncSession, actor: User, scheduled_id: uuid.UUID
) -> ScheduledMessage:
    row = await repo.get(db, scheduled_id, for_update=True)  # the worker may be sending it
    if row is None or row.user_id != actor.id or row.status != "pending":
        raise not_found("scheduled_not_found", "No such scheduled message")
    return row


async def cancel(db: AsyncSession, actor: User, scheduled_id: uuid.UUID) -> None:
    """Cancels a pending row, or dismisses a failed one (its attachments were released already)."""
    row = await repo.get(db, scheduled_id, for_update=True)  # the worker may be sending it
    if row is None or row.user_id != actor.id or row.status not in ("pending", "failed"):
        raise not_found("scheduled_not_found", "No such scheduled message")
    if row.status == "pending":
        await attachments.release_in_tx(db, list(row.attachment_ids or []))
    row.status = "cancelled"
    row.updated_at = utcnow()
    await _emit(db, row)
    await db.commit()


async def send_now(db: AsyncSession, actor: User, scheduled_id: uuid.UUID) -> MessageOut:
    row = await _require_pending(db, actor, scheduled_id)
    message = await _send(db, row, actor)
    return (await messages.messages_out(db, [message]))[0]


async def _send(db: AsyncSession, row: ScheduledMessage, user: User) -> Message:
    try:
        data = MessageCreate(
            client_msg_id=row.client_msg_id,
            body=row.body,
            parent_id=row.parent_id,
            attachment_ids=list(row.attachment_ids or []),
        )
    except ValidationError as exc:
        # A row from before the body was checked at creation: failed like any other row, not a
        # crash that would hold up every later row.
        raise bad_request("invalid_body", "The message cannot be posted") from exc
    # Idempotent by client_msg_id: after a crash between the post and "sent", the retry finds the
    # message instead of failing on the channel's new state.
    message, _ = await messages.create_message(
        db, user, row.channel_id, data, advance_read=False
    )  # commits
    await db.refresh(row)  # the commit may have expired the row (session-dependent)
    row.status = "sent"
    row.sent_message_id = message.id
    row.error = None
    row.updated_at = utcnow()
    await _emit(db, row)
    await db.commit()
    return message


async def send_due(db: AsyncSession, *, now: datetime | None = None, limit: int = 20) -> int:
    """Posts every pending row whose time has come; a row that cannot be posted is marked failed.

    Any error stops only its own row: `due` orders by time, so a row that raised on every tick
    would otherwise hold back every later message of everyone (nothing scheduled would ever go
    out again until someone found the row).
    """
    moment = now or utcnow()
    sent = 0
    # Ids are read up front: a rollback below expires the instances (and lazy loads are sync).
    due = [(row.id, row.user_id) for row in await repo.due(db, moment, limit)]
    for row_id, user_id in due:
        row = await repo.get(db, row_id, for_update=True)  # a concurrent cancel waits for us
        user = await users.get_user(db, user_id)
        if row is None or row.status != "pending":
            await db.commit()
            continue
        if user is None or user.deactivated_at is not None:
            row.status, row.error, row.updated_at = "failed", "user_unavailable", utcnow()
            await attachments.release_in_tx(db, list(row.attachment_ids or []))
            await _emit(db, row)
            await db.commit()
            continue
        try:
            await _send(db, row, user)
            sent += 1
        except Exception as exc:
            if isinstance(exc, AppError):
                error = exc.code
                log.warning("scheduled message %s failed: %s", row_id, error)
            else:
                error = "send_failed"
                log.exception("scheduled message %s failed", row_id)
            await db.rollback()
            fresh = await repo.get(db, row_id)
            if fresh is not None and fresh.status == "pending":
                fresh.status, fresh.error, fresh.updated_at = "failed", error, utcnow()
                await attachments.release_in_tx(db, list(fresh.attachment_ids or []))
                await _emit(db, fresh)
                await db.commit()
    return sent
