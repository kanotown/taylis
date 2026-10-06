"""Message creation with channel sequence allocation and client idempotency keys."""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import bad_request, conflict, forbidden, not_found
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.activity.events import REACTION_ADDED
from app.modules.activity.rules import reaction_audience
from app.modules.activity.schemas import ReactionAddedData
from app.modules.attachments import service as attachments
from app.modules.attachments.schemas import to_attachment_out
from app.modules.calendar import service as calendar
from app.modules.calendar.schemas import CalendarEventCreate
from app.modules.channels import repository as channel_repo
from app.modules.channels import service as channels
from app.modules.channels.schemas import LastMessageOut
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
from app.modules.messages.mentions import (
    MENTION_USER,
    attachment_text,
    extract_group_mentions,
    extract_mentions,
    notification_text,
)
from app.modules.messages.models import Message, with_replier
from app.modules.messages.schedule import decided_text
from app.modules.messages.schemas import (
    CollectionOut,
    DeltaOut,
    HistoryOut,
    MentionListOut,
    MessageCreate,
    MessageEdit,
    MessageOut,
    MessageRevisionOut,
    MessageTaskOut,
    PollAnswersIn,
    PollCreate,
    PollDecideIn,
    collection_out,
    thread_of,
    to_message_out,
)
from app.modules.reads import service as reads
from app.modules.recurring.models import Collection
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


def _stored_poll(poll: PollCreate) -> dict[str, Any]:
    """messages.poll (DATA_MODEL.md 投票). A scheduling poll (M53) also keeps its slots, the zone
    of their labels and the decision."""
    stored: dict[str, Any] = {
        "question": poll.question,
        "options": poll.options,
        "multiple": poll.multiple,
        "anonymous": poll.anonymous,
        "closed_at": None,
    }
    if poll.kind == "schedule":
        stored |= {"kind": "schedule", "slots": poll.stored_slots(), "tz": poll.tz, "decided": None}
    return stored


async def create_message(
    db: AsyncSession,
    actor: User,
    channel_id: uuid.UUID,
    data: MessageCreate,
    *,
    advance_read: bool = True,
    commit: bool = True,
    mentions: bool = True,
    workflow: tuple[uuid.UUID, str] | None = None,
    call_url: str | None = None,
) -> tuple[Message, bool]:
    """Returns (message, created). Retrying with the same client_msg_id returns the same message.

    `advance_read=False` for posts nobody is looking at (scheduled sends): the sender's read
    position stays where it was. `commit=False` leaves the transaction open for a caller that
    writes more in it (M42: a canvas shared to its conversation). `mentions=False` for an
    automatic post that must not call anyone (Review v0.1.22 #8: the deadline bot): no user,
    group, @channel or @here mention is taken from the body, whatever text it carries.
    `workflow` = (id, name) marks a post made through a workflow's form (M94,
    docs/WORKFLOWS.md); everything else is an ordinary post by the actor. `call_url` marks the
    post that starts a call (M117, docs/CALLS.md; the calls module checks the setting).
    """
    # A retry of a message that is already stored gets that message back, whatever happened to
    # the channel since (archived, restricted, left): otherwise the client would mark a delivered
    # message failed and the user would send it again.
    existing = await repo.get_by_client_msg_id(db, actor.id, data.client_msg_id)
    if existing is not None:
        return _same_channel(existing, channel_id), False
    channel, membership = await channels.require_member(db, actor.id, channel_id)
    channels.require_writable(channel)
    if channel.type == "dm":
        await channels.require_dm_allowed(db, actor.id, channel)
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
        _require_user_message(parent)

    if (
        data.poll is not None and not data.body.strip()
    ):  # M14b: previews / pushes / search see the question
        data.body = f"📊 {data.poll.question}"
    mentioned: list[uuid.UUID] = []
    mention_all = False
    if mentions:
        mentioned, mention_all = extract_mentions(data.body)
        mentioned = await _with_group_members(db, actor.id, data.body, mentioned)
    keyword_hits = await _keyword_hits(db, channel_id, actor.id, data.body, mentioned)
    try:
        async with db.begin_nested():
            seq = await repo.allocate_seq(db, channel_id)
            if parent is not None:
                # Read the counters again under the channel lock: a reply committed since the
                # parent was loaded must not be lost (reply_count, reply_user_ids).
                await db.refresh(parent)
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
                poll=_stored_poll(data.poll) if data.poll else None,
                priority=data.priority,
                ack_requested=data.ack_requested,
                workflow_id=workflow[0] if workflow else None,
                workflow_name=workflow[1] if workflow else None,
                call_url=call_url,
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
                parent.reply_user_ids = with_replier(parent.reply_user_ids, actor.id)
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
            if parent is not None:
                await _collection_reply_changed_in_tx(db, parent, actor.id, message.id)
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

    if commit:
        await db.commit()
    return message, True


async def list_history(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, *, before_seq: int | None, limit: int
) -> HistoryOut:
    # M27: also a public channel the actor has not joined (its preview, Slack).
    await channels.require_readable(db, actor, channel_id)
    # Read the channel cursor BEFORE the messages so the returned cursor is conservative
    # (SYNC_PROTOCOL.md §4.3).
    channel_last_seq = await repo.get_channel_last_seq(db, channel_id)
    rows = await repo.list_history(db, channel_id, before_seq=before_seq, limit=limit + 1)
    return HistoryOut(
        channel_last_seq=channel_last_seq,
        messages=await messages_out(db, rows[:limit], actor.id),
        has_more=len(rows) > limit,
    )


async def message_context(
    db: AsyncSession, actor: User, message_id: uuid.UUID, limit: int
) -> list[MessageOut]:
    message = await get_readable_message(db, actor, message_id)
    if message.parent_id is not None:
        message = await get_readable_message(db, actor, message.parent_id)
    return await messages_out(db, await repo.list_context(db, message, limit), actor.id)


async def list_delta(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, *, since_seq: int, limit: int
) -> DeltaOut:
    """State-based delta sync (SYNC_PROTOCOL.md §4.3)."""
    await channels.require_readable(db, actor, channel_id)
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
        messages=await messages_out(db, rows, actor.id),
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


async def get_readable_message(db: AsyncSession, actor: User, message_id: uuid.UUID) -> Message:
    """A message to read, also in a public channel the actor has not joined (M27); changing it
    goes through get_message (members only)."""
    message = await repo.get_message(db, message_id)
    if message is None or message.is_deleted:
        raise not_found("message_not_found", "Message not found")
    await channels.require_readable(db, actor, message.channel_id)
    return message


async def messages_out(
    db: AsyncSession, rows: list[Message], viewer: uuid.UUID | None = None
) -> list[MessageOut]:
    """Response shapes with reactions and attachments filled in (DATA_MODEL.md); `viewer` as in
    to_message_out."""
    live = [m.id for m in rows if not m.is_deleted]
    reactions = await repo.reactions_for(db, live)
    files = await attachments.for_messages(db, live)
    votes = await repo.poll_votes_for(db, [m.id for m in rows if m.poll and not m.is_deleted])
    comments = await repo.comments_for(
        db, [m.id for m in rows if _is_schedule(m) and not m.is_deleted]
    )
    acks = await repo.acks_for(db, [m.id for m in rows if m.ack_requested and not m.is_deleted])
    # L6: only top-level posts can collect (a page costs two more queries when one does).
    collections = await repo.collections_for(
        db, [m.id for m in rows if m.parent_id is None and not m.is_deleted]
    )
    repliers = await repo.repliers_for(db, list(collections))
    tasks = await repo.tasks_for(db, [m for m in rows if not m.is_deleted])
    if tasks and viewer is not None:
        # A shared task is for its conversation's members (SECURITY.md §3.2): someone reading a
        # public channel they have not joined (preview, search) does not see its chips. Events
        # (viewer None) only go to members.
        channel_of = {m.id: m.channel_id for m in rows}
        member_of = await repo.member_channel_ids(db, viewer, {channel_of[mid] for mid in tasks})
        tasks = {mid: ts for mid, ts in tasks.items() if channel_of[mid] in member_of}
    return [
        to_message_out(
            m,
            reactions.get(m.id, []),
            files.get(m.id, []),
            votes.get(m.id, []),
            acks.get(m.id, []),
            viewer,
            comments.get(m.id, []),
            _collection_of(collections.get(m.id), repliers.get(m.id, set())),
            [
                MessageTaskOut(
                    id=t.id,
                    kind=t.kind,  # type: ignore[arg-type]
                    status=t.status,  # type: ignore[arg-type]
                    assignee_ids=people,
                    due_on=t.due_on,
                    owner_id=t.owner_id,
                    due_at=t.due_at,
                )
                for t, people in tasks.get(m.id, [])
            ],
        )
        for m in rows
    ]


def _collection_of(row: Collection | None, repliers: set[uuid.UUID]) -> CollectionOut | None:
    if row is None:
        return None
    return collection_out(row.target_user_ids, row.due_at, row.reminded_at, repliers)


async def _collection_reply_changed_in_tx(
    db: AsyncSession, parent: Message, author_id: uuid.UUID, reply_id: uuid.UUID
) -> None:
    """L6 (RECURRING.md §3): a reply came or went in a collecting post's thread. When that changes
    who has submitted (a target's first live reply, or their last one gone), the parent takes a
    new seq and message.updated (change collection) carries the new count, like any change of
    the parent's own fields."""
    row = (await repo.collections_for(db, [parent.id])).get(parent.id)
    if row is None or author_id not in row.target_user_ids:
        return
    if await repo.has_live_reply(db, parent.id, author_id, excluding=reply_id):
        return
    await _bump_and_announce(db, parent, "collection", commit=False)


async def announce_change_by_id_in_tx(
    db: AsyncSession, message_id: uuid.UUID, change: str
) -> MessageOut | None:
    """Like announce_change_in_tx for a message another module only knows by id (L9: a task's
    source). The seq is taken first (the channel row lock waits for any edit or delete in flight),
    then the row is read again, so the event carries the body as it is now; a message deleted in
    the meantime is left alone (None)."""
    message = await repo.get_message(db, message_id)
    if message is None or message.is_deleted:
        return None
    seq = await repo.allocate_seq(db, message.channel_id, touch_last_message=False)
    await db.refresh(message)
    if message.deleted_at is not None:  # deleted while we waited for the lock
        return None
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
    return out


async def announce_change_in_tx(db: AsyncSession, message: Message, change: str) -> MessageOut:
    """A change another module made to what a message shows (L6: a collection was attached):
    new updated_seq and message.updated; the caller commits."""
    return await _bump_and_announce(db, message, change, commit=False)


async def has_live_reply(db: AsyncSession, parent_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    return await repo.has_live_reply(db, parent_id, user_id)


def _is_schedule(message: Message) -> bool:
    return bool(message.poll) and message.poll.get("kind") == "schedule"  # type: ignore[union-attr]


# M49: the preview's length (MOBILE_UI.md §7.1); the row cuts it to one line anyway.
PREVIEW_LENGTH = 140


async def last_messages(
    db: AsyncSession, channel_ids: list[uuid.UUID], visible: set[uuid.UUID] | None = None
) -> dict[uuid.UUID, LastMessageOut]:
    """M49: each channel's newest timeline message as one line (the push body's rule: mention
    names, then the attachments' words). Callers pass only channels the viewer is a member of.
    A constant number of queries whatever the number of channels (at most four). `visible`: the
    people a guest may see (M13e); other mentions read 「@メンバー」, as on its own client."""
    rows = await repo.last_in_timelines(db, channel_ids)
    if not rows:
        return {}
    files = await attachments.for_messages(db, [m.id for m in rows])
    user_ids = {uuid.UUID(raw) for m in rows for raw in MENTION_USER.findall(m.body)}
    if visible is not None:
        user_ids &= visible
    names: dict[uuid.UUID, str] = {}
    if user_ids:
        found = await users.get_users(db, list(user_ids))
        names.update({user_id: user.display_name for user_id, user in found.items()})
    group_ids = list({g for m in rows for g in extract_group_mentions(m.body)})
    if group_ids:
        names.update(await groups.names_for(db, group_ids))
    return {
        m.channel_id: LastMessageOut(
            id=m.id,
            sender_id=m.sender_id,
            type=m.type,
            seq=m.seq,
            excerpt=notification_text(m.body, names, PREVIEW_LENGTH)
            or attachment_text(files.get(m.id, [])),
            has_attachments=bool(files.get(m.id)),
            created_at=m.created_at,
        )
        for m in rows
    }


async def find_message(db: AsyncSession, message_id: uuid.UUID) -> Message | None:
    """A live message row or None, for modules that own the access decision (M55 tasks)."""
    message = await repo.get_message(db, message_id)
    return message if message is not None and not message.is_deleted else None


async def one_line(
    db: AsyncSession, message: Message, visible: set[uuid.UUID] | None = None
) -> str:
    """A message as one line, like last_messages (M55: a task's source excerpt)."""
    user_ids = {uuid.UUID(raw) for raw in MENTION_USER.findall(message.body)}
    if visible is not None:
        user_ids &= visible
    names: dict[uuid.UUID, str] = {}
    if user_ids:
        found = await users.get_users(db, list(user_ids))
        names.update({user_id: user.display_name for user_id, user in found.items()})
    names.update(await groups.names_for(db, extract_group_mentions(message.body)))
    files = await attachments.for_messages(db, [message.id])
    return notification_text(message.body, names, PREVIEW_LENGTH) or attachment_text(
        files.get(message.id, [])
    )


async def live_bodies(db: AsyncSession, message_ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    """Bodies of the messages that still exist (reminder previews); deleted ones are absent."""
    return await repo.live_bodies(db, message_ids)


async def message_out(
    db: AsyncSession, message: Message, viewer: uuid.UUID | None = None
) -> MessageOut:
    return (await messages_out(db, [message], viewer))[0]


async def _require_live_message(db: AsyncSession, actor: User, message_id: uuid.UUID) -> Message:
    message = await get_message(db, actor, message_id)
    channel = await channels.require_channel(db, message.channel_id)
    channels.require_writable(channel)
    return message


def _require_user_message(message: Message) -> None:
    """M88 (docs/MEMBERSHIP.md §1): a system message is never edited, reacted to, pinned or
    replied to (only an administrator deletes one)."""
    if message.type != "user":
        raise bad_request("system_message_readonly", "System messages cannot be changed")


async def edit_message(
    db: AsyncSession, actor: User, message_id: uuid.UUID, data: MessageEdit
) -> MessageOut:
    """Only the author edits; the edit consumes a seq so delta sync picks it up (§8)."""
    message = await _require_live_message(db, actor, message_id)
    _require_user_message(message)
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
    if message.type != "user" and actor.role != "admin":  # M88: the actor of a join line too
        raise forbidden("not_message_owner", "Only an admin can delete a system message")
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
    parent: Message | None = None
    if message.parent_id is not None:
        parent = await repo.get_message(db, message.parent_id)
        if parent is not None:
            parent.reply_count = max(0, parent.reply_count - 1)
            # C3: the deleted reply's author may have no other live reply (or move down).
            parent.reply_user_ids = await repo.reply_user_ids(db, parent.id)
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
    if parent_thread is not None and parent is not None:
        await _collection_reply_changed_in_tx(db, parent, message.sender_id, message.id)
    await db.commit()
    return out


async def list_mentions(
    db: AsyncSession, actor: User, *, cursor: datetime | None, limit: int
) -> MentionListOut:
    rows = await repo.list_mentions(db, actor.id, before=cursor, limit=limit)
    return MentionListOut(
        items=await messages_out(db, rows, actor.id),
        next_cursor=rows[-1].created_at if rows else None,
    )


async def set_pin(
    db: AsyncSession, actor: User, message_id: uuid.UUID, *, pinned: bool
) -> tuple[MessageOut, bool]:
    """Any member pins / unpins (Slack, Mattermost): (message, changed). A change consumes a seq so
    delta sync carries the pin state (DATA_MODEL.md 各操作と seq)."""
    message = await _require_live_message(db, actor, message_id)
    _require_user_message(message)
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
    return await messages_out(db, await repo.list_pinned(db, channel_id, limit=limit), actor.id)


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


async def _bump_and_announce(
    db: AsyncSession, message: Message, change: str, *, commit: bool = True
) -> MessageOut:
    """A change that keeps the row alive: new updated_seq, message.updated for the channel.
    `commit=False` leaves the transaction open for more writes (M53: deciding a poll)."""
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
    if commit:
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
    if index < 0 or index >= len(poll.get("options", [])):
        raise bad_request("poll_option_invalid", "No such option")
    # Two devices voting at once must see each other's vote (a single-choice poll would keep
    # both). The channel row is the lock, as for every write, so a vote and a reply to the same
    # message never wait for each other in opposite orders.
    await repo.lock_channel(db, message.channel_id)
    await db.refresh(message)  # a close or a decision committed meanwhile
    poll = _open_poll(message)
    if poll.get("kind") == "schedule":
        # M53: the vote of an app before M53 is ○ for that slot; taking it back unanswers it.
        answers = await repo.user_answers(db, message.id, actor.id)
        if present:
            if answers.get(index) == "yes":
                return await message_out(db, message, actor.id), False
            await repo.set_answer(db, message.id, actor.id, index, "yes")
        else:
            if index not in answers:
                return await message_out(db, message, actor.id), False
            await repo.remove_votes(db, message.id, actor.id, index)
        await _bump_and_announce(db, message, "poll")
        return await message_out(db, message, actor.id), True
    current = await repo.user_votes(db, message.id, actor.id)
    if present:
        if index in current:
            return await message_out(db, message, actor.id), False
        if not poll.get("multiple") and current:
            await repo.remove_votes(db, message.id, actor.id)
        await repo.add_vote(db, message.id, actor.id, index)
    else:
        if index not in current:
            return await message_out(db, message, actor.id), False
        await repo.remove_votes(db, message.id, actor.id, index)
    await _bump_and_announce(db, message, "poll")
    # The event left out the voter's own votes (every member gets the same one); the response
    # has them.
    return await message_out(db, message, actor.id), True


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


async def ack_pending(db: AsyncSession, actor: User, message_id: uuid.UUID) -> list[uuid.UUID]:
    """L4: who has not acknowledged yet (any member may look, as they see who has)."""
    message = await _require_live_message(db, actor, message_id)
    if not message.ack_requested:
        raise conflict("ack_not_requested", "This message does not ask for acknowledgements")
    return await repo.ack_pending_user_ids(db, message)


async def has_acked(db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    return await repo.has_ack(db, message_id, user_id)


async def ack_pending_ids_in_tx(db: AsyncSession, message: Message) -> list[uuid.UUID]:
    return await repo.ack_pending_user_ids(db, message)


async def require_ack_message(db: AsyncSession, actor: User, message_id: uuid.UUID) -> Message:
    """A live message asking for acknowledgements that the actor can see (for the reminders)."""
    message = await _require_live_message(db, actor, message_id)
    if not message.ack_requested:
        raise conflict("ack_not_requested", "This message does not ask for acknowledgements")
    return message


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
        return await message_out(db, message, actor.id)
    message.poll = {**poll, "closed_at": utcnow().isoformat()}
    await _bump_and_announce(db, message, "poll")
    return await message_out(db, message, actor.id)


# --- scheduling polls (M53, SCHEDULING.md) ------------------------------------------------------


def _open_poll(message: Message) -> dict[str, Any]:
    """The poll if it still takes answers: 409 once decided or closed."""
    poll = message.poll or {}
    if poll.get("decided"):
        raise conflict("poll_decided", "The date has been decided")
    if poll.get("closed_at"):
        raise conflict("poll_closed", "The poll is closed")
    return poll


async def _schedule_message(db: AsyncSession, actor: User, message_id: uuid.UUID) -> Message:
    message = await _require_live_message(db, actor, message_id)
    if not message.poll:
        raise not_found("poll_not_found", "This message has no poll")
    if not _is_schedule(message):
        raise bad_request("poll_not_schedule", "This poll is not a scheduling poll")
    return message


async def set_answers(
    db: AsyncSession, actor: User, message_id: uuid.UUID, data: PollAnswersIn
) -> tuple[MessageOut, bool]:
    """PUT /messages/{id}/poll/answers: my answers replace the ones I had (slots left out become
    unanswered); `comment` as PollAnswersIn says. (message, changed); only a change takes a seq."""
    message = await _schedule_message(db, actor, message_id)
    await repo.lock_channel(db, message.channel_id)  # as set_vote: see the others' answers
    await db.refresh(message)
    poll = _open_poll(message)
    count = len(poll.get("slots", []))
    wanted = {a.index: a.answer for a in data.answers}
    if any(index >= count for index in wanted):
        raise bad_request("poll_option_invalid", "No such slot")
    current = await repo.user_answers(db, message.id, actor.id)
    changed = False
    for index in current.keys() - wanted.keys():
        await repo.remove_votes(db, message.id, actor.id, index)
        changed = True
    for index, answer in wanted.items():
        if current.get(index) != answer:
            await repo.set_answer(db, message.id, actor.id, index, answer)
            changed = True
    if "comment" in data.model_fields_set:
        if await repo.user_comment(db, message.id, actor.id) != data.comment:
            await repo.set_comment(db, message.id, actor.id, data.comment)
            changed = True
    if not changed:
        return await message_out(db, message, actor.id), False
    await _bump_and_announce(db, message, "poll")
    return await message_out(db, message, actor.id), True


async def _require_decider(db: AsyncSession, actor: User, message: Message) -> None:
    """The poll's author, the channel's owners and administrators (SCHEDULING.md §1)."""
    if message.sender_id == actor.id or actor.is_admin:
        return
    membership = await channels.membership_of(db, actor.id, message.channel_id)
    if membership is None or membership.role != "owner":
        raise forbidden(
            "poll_decide_restricted",
            "Only the poll's author, the channel's owners and administrators decide the date",
        )


def _event_title(poll: dict[str, Any]) -> str:
    return " ".join(str(poll.get("question", "")).split()) or "日程調整"


def _event_for_slot(
    channel_id: uuid.UUID, title: str, slot: dict[str, str], description: str
) -> CalendarEventCreate:
    if "date" in slot:
        day = date.fromisoformat(slot["date"])
        return CalendarEventCreate(
            channel_id=channel_id,
            title=title,
            all_day=True,
            start_date=day,
            end_date=day,
            description=description,
        )
    return CalendarEventCreate(
        channel_id=channel_id,
        title=title,
        starts_at=datetime.fromisoformat(slot["starts_at"]),
        ends_at=datetime.fromisoformat(slot["ends_at"]),
        description=description,
    )


async def decide_poll(
    db: AsyncSession,
    actor: User,
    message_id: uuid.UUID,
    data: PollDecideIn,
    *,
    base_url: str,
) -> tuple[MessageOut, bool]:
    """POST /messages/{id}/poll/decide (SCHEDULING.md §3, §4), in one transaction: the poll is
    decided and closed (message.updated, change poll); the event goes into the channel's calendar
    (not in a DM, nor with create_event false); a thread reply by the decider says so and mentions
    those who answered (not in an anonymous poll). Deciding the same slot again changes nothing
    (a retry); another slot is 409 until the decision is taken back. `base_url`: the server's
    public address, for the message's link in the event."""
    message = await _schedule_message(db, actor, message_id)
    await _require_decider(db, actor, message)
    channel = await channels.require_channel(db, message.channel_id)
    await repo.lock_channel(db, message.channel_id)
    await db.refresh(message)
    poll = dict(message.poll or {})
    slots: list[dict[str, str]] = list(poll.get("slots", []))
    if data.index >= len(slots):
        raise bad_request("poll_option_invalid", "No such slot")
    decided = poll.get("decided")
    if decided:
        if decided.get("index") == data.index:
            return await message_out(db, message, actor.id), False
        raise conflict("poll_decided", "The date has been decided; take the decision back first")

    event_id: uuid.UUID | None = None
    if data.create_event and not channel.is_dm:
        link = f"{base_url.rstrip('/')}/m/{message.id}" if base_url else ""
        description = "日程調整で決定" + (f"\n{link}" if link else "")
        event_id = await calendar.create_channel_event_in_tx(
            db,
            actor,
            _event_for_slot(channel.id, _event_title(poll), slots[data.index], description),
        )
    now = utcnow()
    message.poll = {
        **poll,
        "decided": {
            "index": data.index,
            "event_id": str(event_id) if event_id else None,
            "by": str(actor.id),
            "at": now.isoformat(),
        },
        "closed_at": poll.get("closed_at") or now.isoformat(),
    }
    await _bump_and_announce(db, message, "poll", commit=False)

    votes = (await repo.poll_votes_for(db, [message.id])).get(message.id, [])
    chosen = [v for v in votes if v.option_index == data.index]
    label = list(poll.get("options", []))[data.index]
    body = decided_text(
        label,
        sum(1 for v in chosen if v.answer == "yes"),
        sum(1 for v in chosen if v.answer == "maybe"),
    )
    if not poll.get("anonymous"):
        members = set(
            (await channel_repo.member_ids_for_channels(db, [channel.id])).get(channel.id, [])
        )
        comments = (await repo.comments_for(db, [message.id])).get(message.id, [])
        mentioned: list[uuid.UUID] = []
        for user_id in [v.user_id for v in votes] + [c.user_id for c in comments]:
            if user_id != actor.id and user_id in members and user_id not in mentioned:
                mentioned.append(user_id)
        if mentioned:
            body += "\n" + " ".join(f"<@{user_id}>" for user_id in mentioned)
    await create_message(
        db,
        actor,
        channel.id,
        MessageCreate(
            client_msg_id=uuid.uuid4(),
            body=body,
            parent_id=message.parent_id or message.id,
        ),
        commit=False,
    )
    await db.commit()
    return await message_out(db, message, actor.id), True


async def undecide_poll(db: AsyncSession, actor: User, message_id: uuid.UUID) -> MessageOut:
    """DELETE /messages/{id}/poll/decide: answers open again; the event stays (its creator or the
    channel's owners delete it in the calendar). Idempotent."""
    message = await _schedule_message(db, actor, message_id)
    await _require_decider(db, actor, message)
    await repo.lock_channel(db, message.channel_id)
    await db.refresh(message)
    poll = message.poll or {}
    if not poll.get("decided"):
        return await message_out(db, message, actor.id)
    message.poll = {**poll, "decided": None, "closed_at": None}
    await _bump_and_announce(db, message, "poll")
    return await message_out(db, message, actor.id)


async def set_reaction(
    db: AsyncSession, actor: User, message_id: uuid.UUID, emoji: str, *, present: bool
) -> tuple[MessageOut, bool]:
    """Add (present=True) or remove a reaction: (message, changed). Only changes consume a seq."""
    message = await _require_live_message(db, actor, message_id)
    _require_user_message(message)
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
    # M39: news to the author (the activity badge, and a push if they asked for reaction banners).
    author = reaction_audience(message.sender_id, actor.id)
    if present and author is not None:
        await write_outbox(
            db,
            event_type=REACTION_ADDED,
            audience_type="user",
            audience_id=author,
            channel_id=message.channel_id,
            payload=ReactionAddedData(
                channel_id=message.channel_id,
                message_id=message.id,
                user_id=actor.id,
                emoji=emoji,
                at=utcnow(),
            ).model_dump(mode="json"),
        )
    await db.commit()
    return out, True


async def list_replies(db: AsyncSession, actor: User, parent_id: uuid.UUID) -> list[MessageOut]:
    """GET /messages/{id}/replies: a thread is small enough to return whole, oldest first."""
    parent = await get_readable_message(db, actor, parent_id)
    return await messages_out(db, await repo.list_replies(db, parent.id), actor.id)


async def export_rows(db: AsyncSession, channel_id: uuid.UUID) -> list[MessageOut]:
    """For the export-channel CLI (M10): the channel's live messages with reactions and files."""
    return await messages_out(db, await repo.list_all(db, channel_id))


# --- system messages (M88, docs/MEMBERSHIP.md) ---------------------------------------------------


# M90: a line naming more people than this lists the first ones and 「ほか N 人」 (「今いる人も
# 全員入れる」 adds everyone at once). system_event keeps every id.
MEMBERSHIP_NAMES_SHOWN = 10


def membership_names(names: list[str]) -> str:
    """「A、B」, or 「A、B … J ほか 5 人」 past MEMBERSHIP_NAMES_SHOWN."""
    if len(names) <= MEMBERSHIP_NAMES_SHOWN:
        return "、".join(names)
    shown = "、".join(names[:MEMBERSHIP_NAMES_SHOWN])
    return f"{shown} ほか {len(names) - MEMBERSHIP_NAMES_SHOWN} 人"


def membership_text(kind: str, actor: str, others: list[str]) -> str:
    """The plain-text fallback of a join / leave line (clients before M88, exports). Clients that
    know `system_event` write the line themselves with today's names."""
    names = membership_names(others)
    if kind == "member_joined":
        return f"{actor} が参加しました"
    if kind == "member_left":
        return f"{actor} が退出しました"
    if kind == "members_added":
        return f"{actor} が {names} を追加しました"
    if kind == "member_removed":
        return f"{actor} が {names} を外しました"
    raise ValueError(f"unknown membership event {kind!r}")


async def post_membership_in_tx(
    db: AsyncSession,
    channel_id: uuid.UUID,
    actor_id: uuid.UUID,
    kind: str,
    user_ids: list[uuid.UUID],
) -> int:
    """A join / leave line in the channel's timeline (`type = "system"`): it takes a seq like any
    message, so sync carries it, but the unread counts, pushes, mentions and search leave it out
    (they count `type = "user"` only). The sender is the actor (clients before M88 show the
    fallback body under their name). Returns the seq; the caller commits. Registered with
    channels below (channels does not depend on messages)."""
    seq = await repo.allocate_seq(db, channel_id, touch_last_message=False)
    people = await users.get_users(db, [actor_id, *user_ids])

    def name(user_id: uuid.UUID) -> str:
        person = people.get(user_id)
        return person.display_name if person is not None else "(不明なユーザー)"

    message = Message(
        channel_id=channel_id,
        sender_id=actor_id,
        seq=seq,
        updated_seq=seq,
        type="system",
        body=membership_text(kind, name(actor_id), [name(uid) for uid in user_ids]),
        system_event={
            "kind": kind,
            "actor_id": str(actor_id),
            "user_ids": [str(uid) for uid in user_ids],
        },
    )
    db.add(message)
    await db.flush()
    await write_outbox(
        db,
        event_type=MESSAGE_CREATED,
        audience_type="channel",
        channel_id=channel_id,
        seq=seq,
        payload=MessageCreatedData(message=to_message_out(message)).model_dump(mode="json"),
    )
    return seq


channels.set_membership_writer(post_membership_in_tx)
