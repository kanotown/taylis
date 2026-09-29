"""Message creation with channel sequence allocation and client idempotency keys."""

import uuid
from datetime import datetime

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import bad_request, conflict, forbidden, not_found
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.attachments import service as attachments
from app.modules.attachments.schemas import to_attachment_out
from app.modules.channels import repository as channel_repo
from app.modules.channels import service as channels
from app.modules.groups import service as groups
from app.modules.messages import repository as repo
from app.modules.messages.events import (
    MESSAGE_CREATED,
    MESSAGE_DELETED,
    MESSAGE_UPDATED,
    MessageCreatedData,
    MessageDeletedData,
    MessageUpdatedData,
)
from app.modules.messages.mentions import extract_group_mentions, extract_mentions
from app.modules.messages.models import Message
from app.modules.messages.schemas import (
    DeltaOut,
    HistoryOut,
    MentionListOut,
    MessageCreate,
    MessageEdit,
    MessageOut,
    MessageRevisionOut,
    thread_of,
    to_message_out,
)
from app.modules.reads import service as reads
from app.modules.threads import service as threads
from app.modules.users import service as users
from app.modules.users.models import User


def _same_channel(existing: Message, channel_id: uuid.UUID) -> Message:
    if existing.channel_id != channel_id:
        raise conflict(
            "idempotency_conflict",
            "client_msg_id was already used for a message in another channel",
        )
    return existing


async def _with_group_members(
    db: AsyncSession, sender_id: uuid.UUID, body: str, mentioned: list[uuid.UUID]
) -> list[uuid.UUID]:
    """M12k: `<@group:id>` counts as a mention of every active member (except the sender)."""
    group_ids = extract_group_mentions(body)
    if not group_ids:
        return mentioned
    extra = [
        uid
        for uid in await groups.expand(db, group_ids)
        if uid != sender_id and uid not in mentioned
    ]
    return list(mentioned) + extra


async def _keyword_hits(
    db: AsyncSession,
    channel_id: uuid.UUID,
    sender_id: uuid.UUID,
    body: str,
    mentioned: list[uuid.UUID],
) -> list[uuid.UUID]:
    """M12g: members whose notification keywords occur in the body count as mentioned. Kept apart
    from `mentioned_user_ids` so the other members never learn someone's keywords."""
    member_ids = (await channel_repo.member_ids_for_channels(db, [channel_id])).get(channel_id, [])
    candidates = [uid for uid in member_ids if uid != sender_id and uid not in mentioned]
    return await users.keyword_mentions(db, body, candidates)


async def create_message(
    db: AsyncSession,
    actor: User,
    channel_id: uuid.UUID,
    data: MessageCreate,
    *,
    advance_read: bool = True,
) -> tuple[Message, bool]:
    """Returns (message, created). Retrying with the same client_msg_id returns the same message.

    `advance_read=False` for posts nobody is looking at (scheduled sends): the sender's read
    position stays where it was.
    """
    # A retry of a message that is already stored gets that message back, whatever happened to
    # the channel since (archived, restricted, left): otherwise the client would mark a delivered
    # message failed and the user would send it again.
    existing = await repo.get_by_client_msg_id(db, actor.id, data.client_msg_id)
    if existing is not None:
        return _same_channel(existing, channel_id), False
    channel, membership = await channels.require_member(db, actor.id, channel_id)
    channels.require_writable(channel)
    if (
        channel.posting_policy == "owners"  # M15a: an announcement channel
        and (data.parent_id is None or data.also_in_channel)  # M15c: that posts to the channel too
        and not actor.is_admin
        and actor.role != "bot"
        and membership.role != "owner"
    ):
        raise forbidden("posting_restricted", "Only owners and administrators can post here")

    parent: Message | None = None
    if data.parent_id is not None:
        parent = await repo.get_message(db, data.parent_id)
        if parent is None or parent.is_deleted or parent.channel_id != channel_id:
            raise not_found("message_not_found", "Parent message not found")
        if parent.parent_id is not None:
            raise bad_request("reply_depth", "Replies to replies are not allowed")

    if (
        data.poll is not None and not data.body.strip()
    ):  # M14b: previews / pushes / search see the question
        data.body = f"📊 {data.poll.question}"
    mentioned, mention_all = extract_mentions(data.body)
    mentioned = await _with_group_members(db, actor.id, data.body, mentioned)
    keyword_hits = await _keyword_hits(db, channel_id, actor.id, data.body, mentioned)
    try:
        async with db.begin_nested():
            seq = await repo.allocate_seq(db, channel_id)
            message = Message(
                channel_id=channel_id,
                sender_id=actor.id,
                parent_id=data.parent_id,
                also_in_channel=data.also_in_channel,
                seq=seq,
                updated_seq=seq,
                client_msg_id=data.client_msg_id,
                body=data.body,
                mentioned_user_ids=mentioned,
                keyword_user_ids=keyword_hits,
                mention_all=mention_all,
                poll=(
                    {
                        "question": data.poll.question,
                        "options": data.poll.options,
                        "multiple": data.poll.multiple,
                        "closed_at": None,
                    }
                    if data.poll
                    else None
                ),
                priority=data.priority,
                ack_requested=data.ack_requested,
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
            # Posting in the channel reads it (SYNC_PROTOCOL.md §10); a thread reply only moves the
            # thread's position (THREADS.md), and a scheduled send moves nothing.
            if advance_read and data.parent_id is None:
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
    if has_more:
        # A reply and its parent share one updated_seq: a page must end on a boundary, or the
        # next page (updated_seq > cursor) would skip the half left behind.
        boundary = rows[limit - 1].updated_seq
        rows = [r for r in rows if r.updated_seq < boundary] + await repo.list_at_updated_seq(
            db, channel_id, boundary
        )
        next_since_seq = boundary
    else:
        next_since_seq = max(channel_last_seq, since_seq)
    return DeltaOut(
        messages=await messages_out(db, rows),
        next_since_seq=next_since_seq,
        has_more=has_more,
    )


async def keyword_user_ids(db: AsyncSession, message_id: uuid.UUID) -> set[uuid.UUID]:
    """M12g keyword hits: private, so events leave them out and pushes read them here."""
    message = await repo.get_message(db, message_id)
    return set(message.keyword_user_ids) if message is not None else set()


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
    votes = await repo.poll_votes_for(db, [m.id for m in rows if m.poll and not m.is_deleted])
    acks = await repo.acks_for(db, [m.id for m in rows if m.ack_requested and not m.is_deleted])
    return [
        to_message_out(
            m, reactions.get(m.id, []), files.get(m.id, []), votes.get(m.id, []), acks.get(m.id, [])
        )
        for m in rows
    ]


async def live_bodies(db: AsyncSession, message_ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    """Bodies of the messages that still exist (reminder previews); deleted ones are absent."""
    return await repo.live_bodies(db, message_ids)


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
    now = utcnow()
    if data.body != message.body:  # M14c: keep the replaced body for the author's history
        await repo.add_revision(
            db, message.id, message.body, message.edited_at or message.created_at, now
        )
    message.body = data.body
    message.mentioned_user_ids, message.mention_all = extract_mentions(data.body)
    message.mentioned_user_ids = await _with_group_members(
        db, message.sender_id, data.body, message.mentioned_user_ids
    )
    message.keyword_user_ids = await _keyword_hits(
        db, message.channel_id, message.sender_id, data.body, message.mentioned_user_ids
    )
    message.edited_at = now
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
    message.pinned_at = None
    message.pinned_by = None
    message.updated_seq = seq
    await db.flush()
    await repo.delete_revisions(db, message.id)  # M14c: a deleted message keeps no old text
    await repo.delete_acks(db, message.id)  # M15e
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


async def list_mentions(
    db: AsyncSession, actor: User, *, cursor: datetime | None, limit: int
) -> MentionListOut:
    rows = await repo.list_mentions(db, actor.id, before=cursor, limit=limit)
    return MentionListOut(
        items=await messages_out(db, rows), next_cursor=rows[-1].created_at if rows else None
    )


async def set_pin(
    db: AsyncSession, actor: User, message_id: uuid.UUID, *, pinned: bool
) -> tuple[MessageOut, bool]:
    """Any member pins / unpins (Slack, Mattermost): (message, changed). A change consumes a seq so
    delta sync carries the pin state (DATA_MODEL.md 各操作と seq)."""
    message = await _require_live_message(db, actor, message_id)
    if (message.pinned_at is not None) == pinned:
        return await message_out(db, message), False
    seq = await repo.allocate_seq(db, message.channel_id, touch_last_message=False)
    message.pinned_at = utcnow() if pinned else None
    message.pinned_by = actor.id if pinned else None
    message.updated_seq = seq
    await db.flush()
    out = await message_out(db, message)
    await write_outbox(
        db,
        event_type=MESSAGE_UPDATED,
        audience_type="channel",
        channel_id=message.channel_id,
        seq=seq,
        payload=MessageUpdatedData(message=out, change="pin").model_dump(mode="json"),
    )
    await db.commit()
    return out, True


async def list_pins(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, limit: int
) -> list[MessageOut]:
    await channels.require_member(db, actor.id, channel_id)
    return await messages_out(db, await repo.list_pinned(db, channel_id, limit=limit))


async def list_revisions(
    db: AsyncSession, actor: User, message_id: uuid.UUID
) -> list[MessageRevisionOut]:
    """M14c: earlier bodies, oldest first. Only the author sees them (an edit may have removed
    something that was never meant to stay, e.g. a pasted password)."""
    message = await get_message(db, actor, message_id)
    if message.sender_id != actor.id:
        raise forbidden("not_message_owner", "Only the author can see the edit history")
    return [
        MessageRevisionOut(body=r.body, written_at=r.written_at, replaced_at=r.replaced_at)
        for r in await repo.revisions_for(db, message.id)
    ]


async def _bump_and_announce(db: AsyncSession, message: Message, change: str) -> MessageOut:
    """A change that keeps the row alive: new updated_seq, message.updated for the channel."""
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
        payload=MessageUpdatedData(message=out, change=change).model_dump(mode="json"),  # type: ignore[arg-type]
    )
    await db.commit()
    return out


async def set_vote(
    db: AsyncSession, actor: User, message_id: uuid.UUID, index: int, *, present: bool
) -> tuple[MessageOut, bool]:
    """M14b: vote (present=True) or withdraw a vote: (message, changed). Single-choice polls
    replace the previous vote."""
    message = await _require_live_message(db, actor, message_id)
    poll = message.poll
    if not poll:
        raise not_found("poll_not_found", "This message has no poll")
    if poll.get("closed_at"):
        raise conflict("poll_closed", "The poll is closed")
    if index < 0 or index >= len(poll.get("options", [])):
        raise bad_request("poll_option_invalid", "No such option")
    current = await repo.user_votes(db, message.id, actor.id)
    if present:
        if index in current:
            return await message_out(db, message), False
        if not poll.get("multiple") and current:
            await repo.remove_votes(db, message.id, actor.id)
        await repo.add_vote(db, message.id, actor.id, index)
    else:
        if index not in current:
            return await message_out(db, message), False
        await repo.remove_votes(db, message.id, actor.id, index)
    return await _bump_and_announce(db, message, "poll"), True


async def set_ack(
    db: AsyncSession, actor: User, message_id: uuid.UUID, *, present: bool
) -> MessageOut:
    """M15e: acknowledge (present=True) a message that asked for it, or take it back."""
    message = await _require_live_message(db, actor, message_id)
    if not message.ack_requested:
        raise conflict("ack_not_requested", "This message does not ask for acknowledgements")
    if message.sender_id == actor.id:
        raise bad_request("ack_own_message", "You cannot acknowledge your own message")
    if present == await repo.has_ack(db, message.id, actor.id):
        return await message_out(db, message)
    if present:
        await repo.add_ack(db, message.id, actor.id)
    else:
        await repo.remove_ack(db, message.id, actor.id)
    return await _bump_and_announce(db, message, "ack")


async def close_poll(db: AsyncSession, actor: User, message_id: uuid.UUID) -> MessageOut:
    """Only the author ends the voting (not an administrator either: testers, 2026-09-29); results
    stay visible."""
    message = await _require_live_message(db, actor, message_id)
    poll = message.poll
    if not poll:
        raise not_found("poll_not_found", "This message has no poll")
    if message.sender_id != actor.id:
        raise forbidden("forbidden", "Only the author can close a poll")
    if poll.get("closed_at"):
        return await message_out(db, message)
    message.poll = {**poll, "closed_at": utcnow().isoformat()}
    return await _bump_and_announce(db, message, "poll")


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
