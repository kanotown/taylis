import uuid
from datetime import datetime

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.channels.models import Channel, ChannelMember
from app.modules.messages.models import Message, MessageRevision, PollVote, Reaction


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
        Message.channel_id == channel_id, Message.deleted_at.is_(None), Message.parent_id.is_(None)
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
            or_(Message.mentioned_user_ids.contains([user_id]), Message.mention_all.is_(True)),
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


async def list_context(db: AsyncSession, message: Message, limit: int) -> list[Message]:
    """A bounded window around a top-level message, independent of the sync cursor."""
    base = select(Message).where(
        Message.channel_id == message.channel_id,
        Message.parent_id.is_(None),
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
