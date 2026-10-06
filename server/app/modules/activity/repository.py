import uuid
from datetime import datetime

from sqlalchemy import ColumnElement, and_, exists, func, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.modules.activity.models import CanvasMention
from app.modules.canvases.models import Canvas
from app.modules.channels.models import ChannelMember
from app.modules.messages.models import Message, Reaction, mentions_of, timeline_filter
from app.modules.moderation.blocks import not_blocked_by
from app.modules.reads.models import ReadState
from app.modules.reservations.repository import unread_notices
from app.modules.threads.models import ThreadFollow
from app.modules.users.models import User
from app.modules.wiki.access import readable_clause
from app.modules.wiki.models import WikiNotice, WikiPage

# Unread items counted up to this many (the badge shows 99+).
UNREAD_CAP = 99


def _member(user_id: uuid.UUID):  # type: ignore[no-untyped-def]
    return and_(ChannelMember.channel_id == Message.channel_id, ChannelMember.user_id == user_id)


def read_by(user_id: uuid.UUID) -> ColumnElement[bool]:
    """The message (`Message`) is read by the user in its conversation (MOBILE_UI.md §6.4):
    a timeline row (top-level, or a reply also sent to the channel) up to the channel's read
    position (read_states), a reply up to the thread's (thread_follows.last_read_seq, kept for
    readers who do not follow too). One primary-key probe each, for the few rows after the
    activity read position."""
    rs = aliased(ReadState)
    tf = aliased(ThreadFollow)
    channel_read = exists().where(
        rs.user_id == user_id, rs.channel_id == Message.channel_id, rs.last_read_seq >= Message.seq
    )
    thread_read = exists().where(
        tf.parent_id == Message.parent_id, tf.user_id == user_id, tf.last_read_seq >= Message.seq
    )
    return or_(
        and_(timeline_filter(), channel_read),
        and_(Message.parent_id.is_not(None), thread_read),
    )


def _mentioning(user_id: uuid.UUID) -> ColumnElement[bool]:
    """`mentions_of`, spelled so that each arm has an index (the GIN ones and the partial
    messages_mention_all_idx, whose predicate is `mention_all AND deleted_at IS NULL`): the
    unread count reads my mentions through them instead of every message after the read
    position (2026-10-06: 2 ms instead of 230 ms for 400k messages and a read position 200 days
    old)."""
    return or_(
        Message.mentioned_user_ids.contains([user_id]),
        Message.keyword_user_ids.contains([user_id]),
        and_(Message.mention_all, Message.deleted_at.is_(None)),
    )


def _mentions(user_id: uuid.UUID):  # type: ignore[no-untyped-def]
    return (
        select(Message)
        .join(ChannelMember, _member(user_id))
        .where(
            _mentioning(user_id),
            Message.deleted_at.is_(None),
            Message.sender_id != user_id,
            not_blocked_by(user_id, Message.sender_id),  # M104
        )
    )


def _replies(user_id: uuid.UUID):  # type: ignore[no-untyped-def]
    """Replies by others in the threads I follow, less those mentioning me (a mention item
    already)."""
    return (
        select(Message)
        .join(ChannelMember, _member(user_id))
        .join(
            ThreadFollow,
            and_(
                ThreadFollow.parent_id == Message.parent_id,
                ThreadFollow.user_id == user_id,
                ThreadFollow.following.is_(True),
            ),
        )
        .where(
            Message.parent_id.is_not(None),
            Message.deleted_at.is_(None),
            Message.sender_id != user_id,
            not_(mentions_of(Message, user_id)),
            not_blocked_by(user_id, Message.sender_id),  # M104
        )
    )


def _reactions(user_id: uuid.UUID):  # type: ignore[no-untyped-def]
    """Per message of mine: the newest reaction by others, who and which emoji."""
    at = func.max(Reaction.created_at).label("at")
    return (
        select(
            Reaction.message_id,
            at,
            func.array_agg(func.distinct(Reaction.user_id)).label("actors"),
            func.array_agg(func.distinct(Reaction.emoji)).label("emojis"),
        )
        .join(Message, Message.id == Reaction.message_id)
        .join(ChannelMember, _member(user_id))
        .where(
            Message.sender_id == user_id,
            Message.deleted_at.is_(None),
            Reaction.user_id != user_id,
            not_blocked_by(user_id, Reaction.user_id),  # M104
        )
        .group_by(Reaction.message_id)
    ), at


def _canvas_mentions(user_id: uuid.UUID):  # type: ignore[no-untyped-def]
    """M76: my canvas mention items, of canvases I can read (not in the trash, a conversation
    I am in)."""
    return (
        select(CanvasMention, Canvas)
        .join(Canvas, Canvas.id == CanvasMention.canvas_id)
        .join(
            ChannelMember,
            and_(ChannelMember.channel_id == Canvas.channel_id, ChannelMember.user_id == user_id),
        )
        .where(CanvasMention.user_id == user_id, Canvas.deleted_at.is_(None))
    )


async def canvas_mentions(
    db: AsyncSession, user_id: uuid.UUID, *, before: datetime | None, limit: int
) -> list[tuple[CanvasMention, Canvas]]:
    stmt = _canvas_mentions(user_id).order_by(CanvasMention.at.desc()).limit(limit)
    if before is not None:
        stmt = stmt.where(CanvasMention.at < before)
    return [(row[0], row[1]) for row in (await db.execute(stmt)).all()]


def _page_notices(actor: User, kinds: list[str]):  # type: ignore[no-untyped-def]
    """M120 (docs/WIKI.md §9.3): my wiki notices of these kinds, of live pages I can still read
    (one taken away since is not listed: its title stays hidden)."""
    return (
        select(WikiNotice, WikiPage)
        .join(WikiPage, WikiPage.id == WikiNotice.page_id)
        .where(
            WikiNotice.user_id == actor.id,
            WikiNotice.kind.in_(kinds),
            WikiPage.deleted_at.is_(None),
            readable_clause(actor, WikiPage.id),
        )
    )


async def page_notices(
    db: AsyncSession, actor: User, kinds: list[str], *, before: datetime | None, limit: int
) -> list[tuple[WikiNotice, WikiPage]]:
    if not kinds:
        return []
    stmt = _page_notices(actor, kinds).order_by(WikiNotice.at.desc()).limit(limit)
    if before is not None:
        stmt = stmt.where(WikiNotice.at < before)
    return [(row[0], row[1]) for row in (await db.execute(stmt)).all()]


async def unread_page_notices(
    db: AsyncSession, actor: User, kinds: list[str], since: datetime
) -> int:
    if not kinds:
        return 0
    count = await db.scalar(
        select(func.count()).select_from(
            _page_notices(actor, kinds)
            .with_only_columns(WikiNotice.id)
            .where(WikiNotice.at > since)
            .limit(UNREAD_CAP)
            .subquery()
        )
    )
    return int(count or 0)


async def mentions(
    db: AsyncSession, user_id: uuid.UUID, *, before: datetime | None, limit: int
) -> list[Message]:
    stmt = _mentions(user_id).order_by(Message.created_at.desc()).limit(limit)
    if before is not None:
        stmt = stmt.where(Message.created_at < before)
    return list((await db.execute(stmt)).scalars().all())


async def replies(
    db: AsyncSession, user_id: uuid.UUID, *, before: datetime | None, limit: int
) -> list[Message]:
    stmt = _replies(user_id).order_by(Message.created_at.desc()).limit(limit)
    if before is not None:
        stmt = stmt.where(Message.created_at < before)
    return list((await db.execute(stmt)).scalars().all())


async def reactions(
    db: AsyncSession, user_id: uuid.UUID, *, before: datetime | None, limit: int
) -> list[tuple[uuid.UUID, datetime, list[uuid.UUID], list[str]]]:
    stmt, at = _reactions(user_id)
    if before is not None:
        stmt = stmt.having(at < before)
    rows = (await db.execute(stmt.order_by(at.desc()).limit(limit))).all()
    return [(row.message_id, row.at, list(row.actors), sorted(row.emojis)) for row in rows]


async def read_ids(db: AsyncSession, user_id: uuid.UUID, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    """Which of these messages the user has read in their conversation (`read_by`), one query."""
    if not ids:
        return set()
    stmt = select(Message.id).where(Message.id.in_(ids), read_by(user_id))
    return set((await db.execute(stmt)).scalars().all())


async def messages_by_ids(db: AsyncSession, ids: list[uuid.UUID]) -> list[Message]:
    if not ids:
        return []
    return list((await db.execute(select(Message).where(Message.id.in_(ids)))).scalars().all())


async def unread(
    db: AsyncSession,
    user_id: uuid.UUID,
    since: datetime,
    *,
    canvas: bool = False,
    reservation: bool = False,
) -> tuple[int, bool]:
    """(items after `since`, capped; whether a mention is among them). Mentions and thread replies
    count only while their message is unread in its conversation too (`read_by`, 2026-10-06).
    `canvas`: canvas mention
    items count too (M76), as mentions. `reservation`: reservation notices not done (M112), as
    mentions too (they are addressed to me)."""
    mention_count = await db.scalar(
        select(func.count()).select_from(
            _mentions(user_id)
            .with_only_columns(Message.id)
            .where(Message.created_at > since, not_(read_by(user_id)))
            .limit(UNREAD_CAP)
            .subquery()
        )
    )
    reply_count = await db.scalar(
        select(func.count()).select_from(
            _replies(user_id)
            .with_only_columns(Message.id)
            # The thread's position as a range on the joined follow row (messages_parent_idx),
            # so a read position long ago does not walk every reply since; `read_by` is left
            # for a reply also sent to the channel and read there.
            .where(
                Message.created_at > since,
                Message.seq > ThreadFollow.last_read_seq,
                not_(read_by(user_id)),
            )
            .limit(UNREAD_CAP)
            .subquery()
        )
    )
    stmt, at = _reactions(user_id)
    reaction_count = await db.scalar(
        select(func.count()).select_from(stmt.having(at > since).limit(UNREAD_CAP).subquery())
    )
    canvas_count = 0
    if canvas:
        canvas_count = (
            await db.scalar(
                select(func.count()).select_from(
                    _canvas_mentions(user_id)
                    .with_only_columns(CanvasMention.id)
                    .where(CanvasMention.at > since)
                    .limit(UNREAD_CAP)
                    .subquery()
                )
            )
            or 0
        )
    reservation_count = 0
    if reservation:
        reservation_count = (
            await db.scalar(
                select(func.count()).select_from(
                    unread_notices(user_id, since).limit(UNREAD_CAP).subquery()
                )
            )
            or 0
        )
    mentioned = (mention_count or 0) + canvas_count + reservation_count
    total = mentioned + (reply_count or 0) + (reaction_count or 0)
    return min(total, UNREAD_CAP), mentioned > 0
