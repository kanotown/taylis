import uuid
from datetime import datetime

from sqlalchemy import and_, delete, func, select, text, true, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.modules.channels.models import Channel, ChannelMember
from app.modules.messages.models import (
    REPLY_USERS_MAX,
    Message,
    MessageAck,
    MessageRevision,
    PollComment,
    PollVote,
    Reaction,
    mentions_of,
    timeline_filter,
)
from app.modules.users.models import User  # read-only


async def allocate_seq(
    db: AsyncSession, channel_id: uuid.UUID, *, touch_last_message: bool = True
) -> int:
    """Take the next channel sequence number. The row lock serialises writers until commit.

    Edits, deletes and reactions consume a seq too (DATA_MODEL.md "各操作と seq") but do not
    move ``last_message_at``.
    """
    values: dict[str, object] = {"last_seq": Channel.last_seq + 1}
    if touch_last_message:
        values["last_message_at"] = func.now()
    stmt = (
        update(Channel)
        .where(Channel.id == channel_id)
        .values(**values)
        .returning(Channel.last_seq)
        .execution_options(synchronize_session=False)
    )
    return int((await db.execute(stmt)).scalar_one())


async def lock_channel(db: AsyncSession, channel_id: uuid.UUID) -> None:
    """Hold the channel row (the lock every write to the channel takes through allocate_seq)
    without consuming a seq: for a change that must see the others' committed state first."""
    await db.execute(select(Channel.id).where(Channel.id == channel_id).with_for_update())


async def get_channel_last_seq(db: AsyncSession, channel_id: uuid.UUID) -> int:
    result = await db.execute(select(Channel.last_seq).where(Channel.id == channel_id))
    return int(result.scalar_one())


async def get_message(db: AsyncSession, message_id: uuid.UUID) -> Message | None:
    return await db.get(Message, message_id)


async def get_by_client_msg_id(
    db: AsyncSession, sender_id: uuid.UUID, client_msg_id: uuid.UUID
) -> Message | None:
    stmt = select(Message).where(
        Message.sender_id == sender_id, Message.client_msg_id == client_msg_id
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def list_history(
    db: AsyncSession, channel_id: uuid.UUID, *, before_seq: int | None, limit: int
) -> list[Message]:
    stmt = select(Message).where(
        Message.channel_id == channel_id, Message.deleted_at.is_(None), timeline_filter()
    )
    if before_seq is not None:
        stmt = stmt.where(Message.seq < before_seq)
    stmt = stmt.order_by(Message.seq.desc()).limit(limit)
    return list((await db.execute(stmt)).scalars().all())


async def list_mentions(
    db: AsyncSession, user_id: uuid.UUID, *, before: datetime | None, limit: int
) -> list[Message]:
    """Messages mentioning the user (or everyone) in their channels, newest first (M11h)."""
    stmt = (
        select(Message)
        .join(
            ChannelMember,
            and_(ChannelMember.channel_id == Message.channel_id, ChannelMember.user_id == user_id),
        )
        .where(
            mentions_of(Message, user_id),
            Message.deleted_at.is_(None),
            Message.sender_id != user_id,
        )
        .order_by(Message.created_at.desc())
        .limit(limit)
    )
    if before is not None:
        stmt = stmt.where(Message.created_at < before)
    return list((await db.execute(stmt)).scalars().all())


async def list_pinned(db: AsyncSession, channel_id: uuid.UUID, *, limit: int) -> list[Message]:
    """Pinned messages of a channel, most recently pinned first (M11c)."""
    stmt = (
        select(Message)
        .where(
            Message.channel_id == channel_id,
            Message.deleted_at.is_(None),
            Message.pinned_at.is_not(None),
        )
        .order_by(Message.pinned_at.desc())
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


async def list_delta(
    db: AsyncSession, channel_id: uuid.UUID, *, since_seq: int, limit: int
) -> list[Message]:
    """Current state of every message changed after ``since_seq`` (tombstones included)."""
    stmt = (
        select(Message)
        .where(Message.channel_id == channel_id, Message.updated_seq > since_seq)
        .order_by(Message.updated_seq.asc())
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


async def last_in_timelines(db: AsyncSession, channel_ids: list[uuid.UUID]) -> list[Message]:
    """The newest live timeline row of each channel (M49, the DM list's preview), in one query:
    per channel a LATERAL walk down the (channel_id, seq) unique index that stops at the first
    row neither deleted nor a thread-only reply. Channels without one are absent."""
    if not channel_ids:
        return []
    latest = (
        select(Message)
        .where(Message.channel_id == Channel.id, Message.deleted_at.is_(None), timeline_filter())
        .order_by(Message.seq.desc())
        .limit(1)
        .lateral("latest")
    )
    row = aliased(Message, latest)
    stmt = select(row).select_from(Channel).join(latest, true()).where(Channel.id.in_(channel_ids))
    return list((await db.execute(stmt)).scalars().all())


async def live_bodies(db: AsyncSession, message_ids: list[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not message_ids:
        return {}
    stmt = select(Message.id, Message.body).where(
        Message.id.in_(message_ids), Message.deleted_at.is_(None)
    )
    return {row[0]: row[1] for row in (await db.execute(stmt)).all()}


async def list_at_updated_seq(
    db: AsyncSession, channel_id: uuid.UUID, updated_seq: int
) -> list[Message]:
    """Every row changed by one seq (a reply and its parent share it)."""
    stmt = (
        select(Message)
        .where(Message.channel_id == channel_id, Message.updated_seq == updated_seq)
        .order_by(Message.id)
    )
    return list((await db.execute(stmt)).scalars().all())


async def list_context(db: AsyncSession, message: Message, limit: int) -> list[Message]:
    """A bounded window around a top-level message, independent of the sync cursor."""
    base = select(Message).where(
        Message.channel_id == message.channel_id,
        timeline_filter(),
        Message.deleted_at.is_(None),
    )
    before = await db.scalars(
        base.where(Message.seq < message.seq).order_by(Message.seq.desc()).limit(limit)
    )
    after = await db.scalars(
        base.where(Message.seq >= message.seq).order_by(Message.seq).limit(limit + 1)
    )
    return list(reversed(before.all())) + list(after.all())


async def reactions_for(
    db: AsyncSession, message_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[Reaction]]:
    if not message_ids:
        return {}
    stmt = (
        select(Reaction)
        .where(Reaction.message_id.in_(message_ids))
        .order_by(Reaction.created_at.asc(), Reaction.emoji.asc())
    )
    grouped: dict[uuid.UUID, list[Reaction]] = {}
    for reaction in (await db.execute(stmt)).scalars().all():
        grouped.setdefault(reaction.message_id, []).append(reaction)
    return grouped


async def add_reaction(
    db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID, emoji: str
) -> bool:
    """True when the reaction was new (INSERT ... ON CONFLICT DO NOTHING)."""
    stmt = (
        pg_insert(Reaction)
        .values(message_id=message_id, user_id=user_id, emoji=emoji)
        .on_conflict_do_nothing(index_elements=["message_id", "user_id", "emoji"])
        .returning(Reaction.message_id)
    )
    return (await db.execute(stmt)).first() is not None


async def remove_reaction(
    db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID, emoji: str
) -> bool:
    stmt = (
        delete(Reaction)
        .where(
            Reaction.message_id == message_id,
            Reaction.user_id == user_id,
            Reaction.emoji == emoji,
        )
        .returning(Reaction.message_id)
    )
    return (await db.execute(stmt)).first() is not None


async def list_replies(db: AsyncSession, parent_id: uuid.UUID) -> list[Message]:
    stmt = (
        select(Message)
        .where(Message.parent_id == parent_id, Message.deleted_at.is_(None))
        .order_by(Message.seq.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def reply_user_ids(db: AsyncSession, parent_id: uuid.UUID) -> list[uuid.UUID]:
    """C3: the thread's repliers, most recent reply first (live replies only, as reply_count)."""
    stmt = (
        select(Message.sender_id)
        .where(Message.parent_id == parent_id, Message.deleted_at.is_(None))
        .group_by(Message.sender_id)
        .order_by(func.max(Message.seq).desc())
        .limit(REPLY_USERS_MAX)
    )
    return list((await db.execute(stmt)).scalars().all())


# The same rule as reply_user_ids, for many parents in one statement (migration 0049 has a copy).
_REFRESH_REPLY_USERS = text(
    """
    UPDATE messages AS p SET reply_user_ids = ARRAY(
        SELECT r.sender_id FROM messages AS r
        WHERE r.parent_id = p.id AND r.deleted_at IS NULL
        GROUP BY r.sender_id
        ORDER BY max(r.seq) DESC
        LIMIT :max
    )
    WHERE p.id = ANY(:ids)
    """
)


async def refresh_reply_user_ids(db: AsyncSession, parent_ids: list[uuid.UUID]) -> None:
    """Recompute reply_user_ids for these parents (bulk writers: the Mattermost import)."""
    if parent_ids:
        await db.execute(_REFRESH_REPLY_USERS, {"max": REPLY_USERS_MAX, "ids": parent_ids})


async def list_all(db: AsyncSession, channel_id: uuid.UUID) -> list[Message]:
    """Every live message of a channel (replies included), oldest first: exports."""
    stmt = (
        select(Message)
        .where(Message.channel_id == channel_id, Message.deleted_at.is_(None))
        .order_by(Message.seq.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


# --- polls (M14b) ---------------------------------------------------------------------------


async def poll_votes_for(
    db: AsyncSession, message_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[PollVote]]:
    if not message_ids:
        return {}
    stmt = (
        select(PollVote)
        .where(PollVote.message_id.in_(message_ids))
        .order_by(PollVote.created_at.asc(), PollVote.option_index.asc())
    )
    grouped: dict[uuid.UUID, list[PollVote]] = {}
    for vote in (await db.execute(stmt)).scalars().all():
        grouped.setdefault(vote.message_id, []).append(vote)
    return grouped


async def add_vote(db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID, index: int) -> bool:
    stmt = (
        pg_insert(PollVote)
        .values(message_id=message_id, user_id=user_id, option_index=index)
        .on_conflict_do_nothing(index_elements=["message_id", "user_id", "option_index"])
        .returning(PollVote.message_id)
    )
    return (await db.execute(stmt)).first() is not None


async def remove_votes(
    db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID, index: int | None = None
) -> int:
    """Drop one option's vote, or every vote of the user on the poll (index None)."""
    stmt = delete(PollVote).where(PollVote.message_id == message_id, PollVote.user_id == user_id)
    if index is not None:
        stmt = stmt.where(PollVote.option_index == index)
    result = await db.execute(stmt.returning(PollVote.option_index))
    return len(result.all())


async def user_votes(db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID) -> set[int]:
    stmt = select(PollVote.option_index).where(
        PollVote.message_id == message_id, PollVote.user_id == user_id
    )
    return set((await db.execute(stmt)).scalars().all())


# --- edit history (M14c) ----------------------------------------------------------------------


async def add_revision(
    db: AsyncSession,
    message_id: uuid.UUID,
    body: str,
    written_at: datetime,
    replaced_at: datetime,
) -> None:
    db.add(
        MessageRevision(
            message_id=message_id, body=body, written_at=written_at, replaced_at=replaced_at
        )
    )
    await db.flush()


async def revisions_for(db: AsyncSession, message_id: uuid.UUID) -> list[MessageRevision]:
    stmt = (
        select(MessageRevision)
        .where(MessageRevision.message_id == message_id)
        .order_by(MessageRevision.replaced_at.asc(), MessageRevision.id.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def delete_revisions(db: AsyncSession, message_id: uuid.UUID) -> None:
    await db.execute(delete(MessageRevision).where(MessageRevision.message_id == message_id))


async def acks_for(
    db: AsyncSession, message_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[MessageAck]]:
    """M15e: acknowledgements per message, oldest first."""
    if not message_ids:
        return {}
    stmt = (
        select(MessageAck)
        .where(MessageAck.message_id.in_(message_ids))
        .order_by(MessageAck.acked_at, MessageAck.user_id)
    )
    grouped: dict[uuid.UUID, list[MessageAck]] = {}
    for row in (await db.execute(stmt)).scalars().all():
        grouped.setdefault(row.message_id, []).append(row)
    return grouped


async def has_ack(db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    stmt = select(MessageAck.user_id).where(
        MessageAck.message_id == message_id, MessageAck.user_id == user_id
    )
    return (await db.execute(stmt)).first() is not None


async def ack_pending_user_ids(db: AsyncSession, message: Message) -> list[uuid.UUID]:
    """L4: the channel's members who have not acknowledged: not the author, bots or deactivated
    people. By display name, for the list the clients show."""
    acked = select(MessageAck.user_id).where(MessageAck.message_id == message.id)
    stmt = (
        select(User.id)
        .join(ChannelMember, ChannelMember.user_id == User.id)
        .where(
            ChannelMember.channel_id == message.channel_id,
            User.id != message.sender_id,
            User.role != "bot",
            User.deactivated_at.is_(None),
            User.id.not_in(acked),
        )
        .order_by(User.display_name, User.id)
    )
    return list((await db.execute(stmt)).scalars().all())


async def add_ack(db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID) -> None:
    await db.execute(
        pg_insert(MessageAck)
        .values(message_id=message_id, user_id=user_id)
        .on_conflict_do_nothing()
    )


async def remove_ack(db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID) -> None:
    await db.execute(
        delete(MessageAck).where(MessageAck.message_id == message_id, MessageAck.user_id == user_id)
    )


async def delete_acks(db: AsyncSession, message_id: uuid.UUID) -> None:
    await db.execute(delete(MessageAck).where(MessageAck.message_id == message_id))


# --- scheduling polls (M53) --------------------------------------------------------------------


async def user_answers(
    db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID
) -> dict[int, str]:
    """One person's answers on a poll: slot index → 'yes' / 'maybe' / 'no'."""
    stmt = select(PollVote.option_index, PollVote.answer).where(
        PollVote.message_id == message_id, PollVote.user_id == user_id
    )
    return {int(row[0]): str(row[1]) for row in (await db.execute(stmt)).all()}


async def set_answer(
    db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID, index: int, answer: str
) -> None:
    """Insert the answer, or change it in place (the row keeps its created_at: the order of the
    people in the table stays)."""
    stmt = (
        pg_insert(PollVote)
        .values(message_id=message_id, user_id=user_id, option_index=index, answer=answer)
        .on_conflict_do_update(
            index_elements=["message_id", "user_id", "option_index"],
            set_={"answer": answer},
        )
    )
    await db.execute(stmt)


async def comments_for(
    db: AsyncSession, message_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[PollComment]]:
    """Comments per poll, the oldest change first."""
    if not message_ids:
        return {}
    stmt = (
        select(PollComment)
        .where(PollComment.message_id.in_(message_ids))
        .order_by(PollComment.updated_at.asc(), PollComment.user_id.asc())
    )
    grouped: dict[uuid.UUID, list[PollComment]] = {}
    for row in (await db.execute(stmt)).scalars().all():
        grouped.setdefault(row.message_id, []).append(row)
    return grouped


async def user_comment(db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID) -> str | None:
    stmt = select(PollComment.text).where(
        PollComment.message_id == message_id, PollComment.user_id == user_id
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def set_comment(
    db: AsyncSession, message_id: uuid.UUID, user_id: uuid.UUID, text: str | None
) -> None:
    """Set my comment, or remove it (None)."""
    if text is None:
        await db.execute(
            delete(PollComment).where(
                PollComment.message_id == message_id, PollComment.user_id == user_id
            )
        )
        return
    stmt = (
        pg_insert(PollComment)
        .values(message_id=message_id, user_id=user_id, text=text, updated_at=func.now())
        .on_conflict_do_update(
            index_elements=["message_id", "user_id"],
            set_={"text": text, "updated_at": func.now()},
        )
    )
    await db.execute(stmt)
