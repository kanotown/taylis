import uuid
from datetime import datetime

from sqlalchemy import ColumnElement, and_, exists, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.time import utcnow
from app.modules.channels.models import ChannelMember  # read-only: follows need membership
from app.modules.messages.models import (  # read-only (ARCHITECTURE.md §5 exception)
    Message,
    mentions_of,
)
from app.modules.threads.models import ThreadFollow


async def get(db: AsyncSession, parent_id: uuid.UUID, user_id: uuid.UUID) -> ThreadFollow | None:
    return await db.get(ThreadFollow, (parent_id, user_id))


def _member_of_thread_channel() -> ColumnElement[bool]:
    """The follow row's user is (still) a member of the thread's channel. Follows of people who
    were never members (a mention of an outsider) or who left must not see the thread."""
    parent = aliased(Message)
    return exists(
        select(ChannelMember.user_id)
        .join(parent, parent.channel_id == ChannelMember.channel_id)
        .where(parent.id == ThreadFollow.parent_id, ChannelMember.user_id == ThreadFollow.user_id)
    )


async def member_ids(
    db: AsyncSession, channel_id: uuid.UUID, candidates: list[uuid.UUID]
) -> list[uuid.UUID]:
    if not candidates:
        return []
    stmt = select(ChannelMember.user_id).where(
        ChannelMember.channel_id == channel_id, ChannelMember.user_id.in_(candidates)
    )
    return list((await db.execute(stmt)).scalars().all())


async def auto_follow(db: AsyncSession, parent_id: uuid.UUID, user_ids: list[uuid.UUID]) -> None:
    """Follow for users without a row yet, or who only read the thread; an explicit unfollow
    (unfollowed_at) is kept."""
    if not user_ids:
        return
    insert = pg_insert(ThreadFollow).values(
        [{"parent_id": parent_id, "user_id": uid} for uid in dict.fromkeys(user_ids)]
    )
    stmt = insert.on_conflict_do_update(
        index_elements=["parent_id", "user_id"],
        set_={"following": True, "updated_at": utcnow()},
        where=and_(ThreadFollow.following.is_(False), ThreadFollow.unfollowed_at.is_(None)),
    )
    await db.execute(stmt)


async def unfollowed(db: AsyncSession, parent_id: uuid.UUID) -> list[uuid.UUID]:
    """Users who unfollowed the thread by hand (no pushes for its replies, THREADS.md §4)."""
    stmt = select(ThreadFollow.user_id).where(
        ThreadFollow.parent_id == parent_id, ThreadFollow.unfollowed_at.is_not(None)
    )
    return list((await db.execute(stmt)).scalars().all())


async def followers(db: AsyncSession, parent_id: uuid.UUID) -> list[uuid.UUID]:
    stmt = (
        select(ThreadFollow.user_id)
        .where(
            ThreadFollow.parent_id == parent_id,
            ThreadFollow.following.is_(True),
            _member_of_thread_channel(),
        )
        .order_by(ThreadFollow.created_at)
    )
    return list((await db.execute(stmt)).scalars().all())


async def followers_of(
    db: AsyncSession, parent_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[uuid.UUID]]:
    if not parent_ids:
        return {}
    stmt = (
        select(ThreadFollow.parent_id, ThreadFollow.user_id)
        .where(
            ThreadFollow.parent_id.in_(parent_ids),
            ThreadFollow.following.is_(True),
            _member_of_thread_channel(),
        )
        .order_by(ThreadFollow.created_at)
    )
    out: dict[uuid.UUID, list[uuid.UUID]] = {}
    for parent_id, user_id in (await db.execute(stmt)).all():
        out.setdefault(parent_id, []).append(user_id)
    return out


async def newest_reply_seq(db: AsyncSession, parent_id: uuid.UUID) -> int:
    stmt = select(func.coalesce(func.max(Message.seq), 0)).where(
        Message.parent_id == parent_id, Message.deleted_at.is_(None)
    )
    return int((await db.execute(stmt)).scalar_one())


async def advance_read(
    db: AsyncSession, parent_id: uuid.UUID, user_id: uuid.UUID, seq: int
) -> tuple[int, bool]:
    """Monotonic; a missing row is created without following (reading is not following)."""
    row = await db.get(ThreadFollow, (parent_id, user_id), with_for_update=True)
    if row is None:
        db.add(
            ThreadFollow(parent_id=parent_id, user_id=user_id, following=False, last_read_seq=seq)
        )
        await db.flush()
        return seq, True
    if seq <= row.last_read_seq:
        return row.last_read_seq, False
    row.last_read_seq = seq
    row.updated_at = utcnow()
    await db.flush()
    return seq, True


async def set_following(
    db: AsyncSession, parent_id: uuid.UUID, user_id: uuid.UUID, following: bool
) -> tuple[ThreadFollow, bool]:
    row = await db.get(ThreadFollow, (parent_id, user_id), with_for_update=True)
    unfollowed_at = None if following else utcnow()
    if row is None:
        row = ThreadFollow(
            parent_id=parent_id, user_id=user_id, following=following, unfollowed_at=unfollowed_at
        )
        db.add(row)
        await db.flush()
        return row, True
    if row.following == following and (following or row.unfollowed_at is not None):
        return row, False
    row.following = following
    row.unfollowed_at = unfollowed_at  # an explicit choice either way
    row.updated_at = utcnow()
    await db.flush()
    return row, True


def _unread_filter(user_id: uuid.UUID, last_read_seq: int) -> ColumnElement[bool]:
    return and_(
        Message.seq > last_read_seq,
        Message.sender_id != user_id,
        Message.deleted_at.is_(None),
    )


def _mentioned(user_id: uuid.UUID) -> ColumnElement[bool]:
    return mentions_of(Message, user_id)


async def counts(
    db: AsyncSession, parent_id: uuid.UUID, user_id: uuid.UUID, last_read_seq: int
) -> tuple[int, int]:
    """(unread replies, unread replies that mention the user)."""
    stmt = select(func.count(), func.count().filter(_mentioned(user_id))).where(
        Message.parent_id == parent_id, _unread_filter(user_id, last_read_seq)
    )
    unread, mentions = (await db.execute(stmt)).one()
    return int(unread), int(mentions)


async def counts_for_user(
    db: AsyncSession, user_id: uuid.UUID, parent_ids: list[uuid.UUID]
) -> dict[uuid.UUID, tuple[int, int]]:
    """Per-thread unread / mention counts for the user's follow rows, in one query."""
    if not parent_ids:
        return {}
    reply = aliased(Message)
    mentioned = mentions_of(reply, user_id)
    stmt = (
        select(ThreadFollow.parent_id, func.count(), func.count().filter(mentioned))
        .select_from(ThreadFollow)
        .join(
            reply,
            and_(
                reply.parent_id == ThreadFollow.parent_id,
                reply.seq > ThreadFollow.last_read_seq,
                reply.sender_id != user_id,
                reply.deleted_at.is_(None),
            ),
        )
        .where(ThreadFollow.user_id == user_id, ThreadFollow.parent_id.in_(parent_ids))
        .group_by(ThreadFollow.parent_id)
    )
    return {row[0]: (int(row[1]), int(row[2])) for row in (await db.execute(stmt)).all()}


def _unread_reply_exists(user_id: uuid.UUID, *, mentioned: bool) -> ColumnElement[bool]:
    """EXISTS over the replies of the follow row's thread (aliased: the outer query joins the
    parent through `Message` too, and auto-correlation would otherwise drop the FROM)."""
    reply = aliased(Message)
    conditions = [
        reply.parent_id == ThreadFollow.parent_id,
        reply.seq > ThreadFollow.last_read_seq,
        reply.sender_id != user_id,
        reply.deleted_at.is_(None),
    ]
    if mentioned:
        conditions.append(mentions_of(reply, user_id))
    return exists(select(reply.id).where(*conditions))


async def list_followed(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    unread_only: bool,
    before: datetime | None,
    limit: int,
) -> list[tuple[Message, ThreadFollow]]:
    """Followed thread parents newest reply first (THREADS.md §3); deleted parents are skipped."""
    stmt = (
        select(Message, ThreadFollow)
        .join(ThreadFollow, ThreadFollow.parent_id == Message.id)
        .where(
            ThreadFollow.user_id == user_id,
            ThreadFollow.following.is_(True),
            Message.deleted_at.is_(None),
            Message.reply_count > 0,
            _member_of_thread_channel(),
        )
        .order_by(Message.last_reply_at.desc().nulls_last(), Message.seq.desc())
        .limit(limit)
    )
    if before is not None:
        stmt = stmt.where(Message.last_reply_at < before)
    if unread_only:
        stmt = stmt.where(_unread_reply_exists(user_id, mentioned=False))
    return [(row[0], row[1]) for row in (await db.execute(stmt)).all()]


async def summary(db: AsyncSession, user_id: uuid.UUID) -> tuple[int, int]:
    """(followed threads with unread replies, of which with unread mentions)."""
    base = (
        select(func.count())
        .select_from(ThreadFollow)
        .join(Message, Message.id == ThreadFollow.parent_id)
        .where(
            ThreadFollow.user_id == user_id,
            ThreadFollow.following.is_(True),
            Message.deleted_at.is_(None),
            _member_of_thread_channel(),
        )
    )
    unread = base.where(_unread_reply_exists(user_id, mentioned=False))
    mentions = base.where(_unread_reply_exists(user_id, mentioned=True))
    return int((await db.execute(unread)).scalar_one()), int(
        (await db.execute(mentions)).scalar_one()
    )
