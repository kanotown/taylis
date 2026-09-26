"""Message creation with channel sequence allocation and client idempotency keys."""

import uuid

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict, not_found
from app.modules.channels import service as channels
from app.modules.messages import repository as repo
from app.modules.messages.models import Message
from app.modules.messages.schemas import HistoryOut, MessageCreate, to_message_out
from app.modules.users.models import User


def _same_channel(existing: Message, channel_id: uuid.UUID) -> Message:
    if existing.channel_id != channel_id:
        raise conflict(
            "idempotency_conflict",
            "client_msg_id was already used for a message in another channel",
        )
    return existing


async def create_message(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, data: MessageCreate
) -> tuple[Message, bool]:
    """Returns (message, created). Retrying with the same client_msg_id returns the same message."""
    channel, _ = await channels.require_member(db, actor.id, channel_id)
    channels.require_writable(channel)

    existing = await repo.get_by_client_msg_id(db, actor.id, data.client_msg_id)
    if existing is not None:
        return _same_channel(existing, channel_id), False

    try:
        async with db.begin_nested():
            seq = await repo.allocate_seq(db, channel_id)
            message = Message(
                channel_id=channel_id,
                sender_id=actor.id,
                seq=seq,
                updated_seq=seq,
                client_msg_id=data.client_msg_id,
                body=data.body,
            )
            db.add(message)
            await db.flush()
    except IntegrityError:
        # Concurrent retry with the same client_msg_id: the savepoint (and its seq) rolled back.
        existing = await repo.get_by_client_msg_id(db, actor.id, data.client_msg_id)
        if existing is None:
            raise
        return _same_channel(existing, channel_id), False

    await db.commit()
    return message, True


async def list_history(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, *, before_seq: int | None, limit: int
) -> HistoryOut:
    await channels.require_member(db, actor.id, channel_id)
    # Read the channel cursor BEFORE the messages so the returned cursor is conservative
    # (SYNC_PROTOCOL.md §4.3).
    channel_last_seq = await repo.get_channel_last_seq(db, channel_id)
    rows = await repo.list_history(db, channel_id, before_seq=before_seq, limit=limit + 1)
    return HistoryOut(
        channel_last_seq=channel_last_seq,
        messages=[to_message_out(m) for m in rows[:limit]],
        has_more=len(rows) > limit,
    )


async def get_message(db: AsyncSession, actor: User, message_id: uuid.UUID) -> Message:
    message = await repo.get_message(db, message_id)
    if message is None or message.is_deleted:
        raise not_found("message_not_found", "Message not found")
    await channels.require_member(db, actor.id, message.channel_id)
    return message
