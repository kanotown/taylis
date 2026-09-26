"""Message creation with channel sequence allocation and client idempotency keys."""

import uuid

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import bad_request, conflict, forbidden, not_found
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.attachments import service as attachments
from app.modules.attachments.schemas import to_attachment_out
from app.modules.channels import service as channels
from app.modules.messages import repository as repo
from app.modules.messages.events import (
    MESSAGE_CREATED,
    MESSAGE_DELETED,
    MESSAGE_UPDATED,
    MessageCreatedData,
    MessageDeletedData,
    MessageUpdatedData,
)
from app.modules.messages.mentions import extract_mentions
from app.modules.messages.models import Message
from app.modules.messages.schemas import (
    DeltaOut,
    HistoryOut,
    MessageCreate,
    MessageEdit,
    MessageOut,
    thread_of,
    to_message_out,
)
from app.modules.reads import service as reads
from app.modules.threads import service as threads
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

    parent: Message | None = None
    if data.parent_id is not None:
        parent = await repo.get_message(db, data.parent_id)
        if parent is None or parent.is_deleted or parent.channel_id != channel_id:
            raise not_found("message_not_found", "Parent message not found")
        if parent.parent_id is not None:
            raise bad_request("reply_depth", "Replies to replies are not allowed")

    mentioned, mention_all = extract_mentions(data.body)
    try:
        async with db.begin_nested():
            seq = await repo.allocate_seq(db, channel_id)
            message = Message(
                channel_id=channel_id,
                sender_id=actor.id,
                parent_id=data.parent_id,
                seq=seq,
                updated_seq=seq,
                client_msg_id=data.client_msg_id,
                body=data.body,
                mentioned_user_ids=mentioned,
                mention_all=mention_all,
            )
            db.add(message)
            await db.flush()
            bound = await attachments.bind_in_tx(
                db, actor.id, channel_id, message.id, data.attachment_ids
            )
            attachments_out = [to_attachment_out(a) for a in bound]
            parent_thread = None
            if parent is not None:
                # The reply consumes the seq; the parent's counters move to it (DATA_MODEL.md).
                parent.reply_count += 1
                parent.last_reply_at = message.created_at
                parent.updated_seq = seq
                await db.flush()
                # Followers (THREADS.md): auto-follow, then they are the push targets.
                await threads.on_reply_created_in_tx(db, parent, message)
                parent_thread = thread_of(parent, await threads.followers(db, parent.id))
            await write_outbox(
                db,
                event_type=MESSAGE_CREATED,
                audience_type="channel",
                channel_id=channel_id,
                seq=seq,
                payload=MessageCreatedData(
                    message=to_message_out(message, attachments=attachments_out),
                    parent_thread=parent_thread,
                ).model_dump(mode="json"),
            )
            # The sender has read their own message (SYNC_PROTOCOL.md §10).
            await reads.advance_in_tx(db, actor.id, channel_id, seq, last_seq=seq)
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
        messages=await messages_out(db, rows[:limit]),
        has_more=len(rows) > limit,
    )


async def message_context(
    db: AsyncSession, actor: User, message_id: uuid.UUID, limit: int
) -> list[MessageOut]:
    message = await get_message(db, actor, message_id)
    if message.parent_id is not None:
        message = await get_message(db, actor, message.parent_id)
    return await messages_out(db, await repo.list_context(db, message, limit))


async def list_delta(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, *, since_seq: int, limit: int
) -> DeltaOut:
    """State-based delta sync (SYNC_PROTOCOL.md §4.3)."""
    await channels.require_member(db, actor.id, channel_id)
    # Read the cursor BEFORE the rows so a cursor without has_more is conservative.
    channel_last_seq = await repo.get_channel_last_seq(db, channel_id)
    rows = await repo.list_delta(db, channel_id, since_seq=since_seq, limit=limit + 1)
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_since_seq = rows[-1].updated_seq if has_more else max(channel_last_seq, since_seq)
    return DeltaOut(
        messages=await messages_out(db, rows),
        next_since_seq=next_since_seq,
        has_more=has_more,
    )


async def get_message(db: AsyncSession, actor: User, message_id: uuid.UUID) -> Message:
    message = await repo.get_message(db, message_id)
    if message is None or message.is_deleted:
        raise not_found("message_not_found", "Message not found")
    await channels.require_member(db, actor.id, message.channel_id)
    return message


async def messages_out(db: AsyncSession, rows: list[Message]) -> list[MessageOut]:
    """Response shapes with reactions and attachments filled in (DATA_MODEL.md)."""
    live = [m.id for m in rows if not m.is_deleted]
    reactions = await repo.reactions_for(db, live)
    files = await attachments.for_messages(db, live)
    return [to_message_out(m, reactions.get(m.id, []), files.get(m.id, [])) for m in rows]


async def message_out(db: AsyncSession, message: Message) -> MessageOut:
    return (await messages_out(db, [message]))[0]


async def _require_live_message(db: AsyncSession, actor: User, message_id: uuid.UUID) -> Message:
    message = await get_message(db, actor, message_id)
    channel = await channels.require_channel(db, message.channel_id)
    channels.require_writable(channel)
    return message


async def edit_message(
    db: AsyncSession, actor: User, message_id: uuid.UUID, data: MessageEdit
) -> MessageOut:
    """Only the author edits; the edit consumes a seq so delta sync picks it up (§8)."""
    message = await _require_live_message(db, actor, message_id)
    if message.sender_id != actor.id:
        raise forbidden("not_message_owner", "Only the author can edit a message")
    seq = await repo.allocate_seq(db, message.channel_id, touch_last_message=False)
    message.body = data.body
    message.mentioned_user_ids, message.mention_all = extract_mentions(data.body)
    message.edited_at = utcnow()
    message.updated_seq = seq
    await db.flush()
    out = await message_out(db, message)
    await write_outbox(
        db,
        event_type=MESSAGE_UPDATED,
        audience_type="channel",
        channel_id=message.channel_id,
        seq=seq,
        payload=MessageUpdatedData(message=out, change="body").model_dump(mode="json"),
    )
    await db.commit()
    return out


async def delete_message(db: AsyncSession, actor: User, message_id: uuid.UUID) -> MessageOut:
    """Tombstone (author or admin): the body is cleared, the row stays for delta sync."""
    message = await _require_live_message(db, actor, message_id)
    if message.sender_id != actor.id and actor.role != "admin":
        raise forbidden("not_message_owner", "Only the author or an admin can delete a message")
    seq = await repo.allocate_seq(db, message.channel_id, touch_last_message=False)
    message.deleted_at = utcnow()
    message.body = ""
    message.mentioned_user_ids = []
    message.mention_all = False
    message.updated_seq = seq
    await db.flush()
    await attachments.mark_deleted_in_tx(db, message.id)
    parent_thread = None
    if message.parent_id is not None:
        parent = await repo.get_message(db, message.parent_id)
        if parent is not None:
            parent.reply_count = max(0, parent.reply_count - 1)
            parent.updated_seq = seq
            await db.flush()
            await threads.on_reply_deleted_in_tx(db, parent)
            parent_thread = thread_of(parent, await threads.followers(db, parent.id))
    out = to_message_out(message)
    await write_outbox(
        db,
        event_type=MESSAGE_DELETED,
        audience_type="channel",
        channel_id=message.channel_id,
        seq=seq,
        payload=MessageDeletedData(message=out, parent_thread=parent_thread).model_dump(
            mode="json"
        ),
    )
    await db.commit()
    return out


async def set_reaction(
    db: AsyncSession, actor: User, message_id: uuid.UUID, emoji: str, *, present: bool
) -> tuple[MessageOut, bool]:
    """Add (present=True) or remove a reaction: (message, changed). Only changes consume a seq."""
    message = await _require_live_message(db, actor, message_id)
    if present:
        changed = await repo.add_reaction(db, message.id, actor.id, emoji)
    else:
        changed = await repo.remove_reaction(db, message.id, actor.id, emoji)
    if not changed:
        return await message_out(db, message), False
    seq = await repo.allocate_seq(db, message.channel_id, touch_last_message=False)
    message.updated_seq = seq
    await db.flush()
    out = await message_out(db, message)
    await write_outbox(
        db,
        event_type=MESSAGE_UPDATED,
        audience_type="channel",
        channel_id=message.channel_id,
        seq=seq,
        payload=MessageUpdatedData(message=out, change="reactions").model_dump(mode="json"),
    )
    await db.commit()
    return out, True


async def list_replies(db: AsyncSession, actor: User, parent_id: uuid.UUID) -> list[MessageOut]:
    """GET /messages/{id}/replies: a thread is small enough to return whole, oldest first."""
    parent = await get_message(db, actor, parent_id)
    return await messages_out(db, await repo.list_replies(db, parent.id))


async def export_rows(db: AsyncSession, channel_id: uuid.UUID) -> list[MessageOut]:
    """For the export-channel CLI (M10): the channel's live messages with reactions and files."""
    return await messages_out(db, await repo.list_all(db, channel_id))
