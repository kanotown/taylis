import uuid
from datetime import datetime

from sqlalchemy import and_, func, not_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.channels.models import ChannelMember
from app.modules.messages.models import Message, Reaction, mentions_of
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
            Message.sender_id == user_id, Message.deleted_at.is_(None), Reaction.user_id != user_id
        )
        .group_by(Reaction.message_id)
    ), at


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


async def unread(db: AsyncSession, user_id: uuid.UUID, since: datetime) -> tuple[int, bool]:
    """(items after `since`, capped; whether a mention is among them)."""
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
    total = (mention_count or 0) + (reply_count or 0) + (reaction_count or 0)
    return min(total, UNREAD_CAP), (mention_count or 0) > 0
