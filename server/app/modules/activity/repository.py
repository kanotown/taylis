import uuid
from datetime import datetime

from sqlalchemy import and_, func, not_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.activity.models import CanvasMention
from app.modules.canvases.models import Canvas
from app.modules.channels.models import ChannelMember
from app.modules.messages.models import Message, Reaction, mentions_of
from app.modules.moderation.blocks import not_blocked_by
from app.modules.reservations.repository import unread_notices
from app.modules.threads.models import ThreadFollow

# Unread items counted up to this many (the badge shows 99+).
UNREAD_CAP = 99


def _member(user_id: uuid.UUID):  # type: ignore[no-untyped-def]
    return and_(ChannelMember.channel_id == Message.channel_id, ChannelMember.user_id == user_id)


def _mentions(user_id: uuid.UUID):  # type: ignore[no-untyped-def]
    return (
        select(Message)
        .join(ChannelMember, _member(user_id))
        .where(
            mentions_of(Message, user_id),
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
    """(items after `since`, capped; whether a mention is among them). `canvas`: canvas mention
    items count too (M76), as mentions. `reservation`: reservation notices not done (M112), as
    mentions too (they are addressed to me)."""
    mention_count = await db.scalar(
        select(func.count()).select_from(
            _mentions(user_id).where(Message.created_at > since).limit(UNREAD_CAP).subquery()
        )
    )
    reply_count = await db.scalar(
        select(func.count()).select_from(
            _replies(user_id).where(Message.created_at > since).limit(UNREAD_CAP).subquery()
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
