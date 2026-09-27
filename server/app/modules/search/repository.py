"""PGroonga queries. Read-only access to messages / attachments (ARCHITECTURE.md §5 exception)."""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import Select, exists, func, literal_column, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attachments.models import Attachment
from app.modules.messages.models import Message, Reaction

_LINK = r"https?://"
# Counting stops here: past it the clients show "1000 件以上" (a count is cheap below that).
TOTAL_CAP = 1000

Sort = Literal["relevance", "newest"]


@dataclass(frozen=True)
class Scope:
    """Everything but the words: where and what to look for."""

    channel_ids: list[uuid.UUID]
    from_user_id: uuid.UUID | None = None
    after: datetime | None = None
    before: datetime | None = None
    has: Sequence[str] = ()
    is_thread: bool = False


def _apply_flags(stmt: Select[Any], has: Sequence[str], is_thread: bool) -> Select[Any]:
    """M15h: has:file / link / pin / reaction / poll; is:thread = replies and their parents."""
    if "file" in has:
        stmt = stmt.where(
            exists(
                select(Attachment.id).where(
                    Attachment.message_id == Message.id, Attachment.status == "attached"
                )
            )
        )
    if "link" in has:
        stmt = stmt.where(Message.body.op("~*")(_LINK))
    if "pin" in has:
        stmt = stmt.where(Message.pinned_at.is_not(None))
    if "reaction" in has:
        stmt = stmt.where(exists(select(Reaction.user_id).where(Reaction.message_id == Message.id)))
    if "poll" in has:
        # A message without a poll stores JSON null (not SQL NULL): ask for an object.
        stmt = stmt.where(func.jsonb_typeof(Message.poll) == "object")
    if is_thread:
        stmt = stmt.where(or_(Message.parent_id.is_not(None), Message.reply_count > 0))
    return stmt


def _scoped(stmt: Select[Any], scope: Scope) -> Select[Any]:
    stmt = stmt.where(
        Message.channel_id.in_(scope.channel_ids),
        Message.deleted_at.is_(None),
        Message.type == "user",
    )
    if scope.from_user_id is not None:
        stmt = stmt.where(Message.sender_id == scope.from_user_id)
    if scope.after is not None:
        stmt = stmt.where(Message.created_at >= scope.after)
    if scope.before is not None:
        stmt = stmt.where(Message.created_at < scope.before)
    return _apply_flags(stmt, scope.has, scope.is_thread)


def _matching(stmt: Select[Any], query: str | None, escaped: bool) -> Select[Any]:
    """Body or attachment file name. `&@~` takes Groonga query syntax (AND, OR, -, quotes)."""
    if not query:
        return stmt
    needle = func.pgroonga_query_escape(query) if escaped else query
    filename_match = exists(
        select(Attachment.id).where(
            Attachment.message_id == Message.id,
            Attachment.status == "attached",
            Attachment.filename.op("&@~")(needle),
        )
    )
    return stmt.where(or_(Message.body.op("&@~")(needle), filename_match))


async def search_messages(
    db: AsyncSession,
    *,
    query: str,
    scope: Scope,
    sort: Sort,
    limit: int,
    offset: int,
    escaped: bool,
) -> list[tuple[Message, float]]:
    """Ranked hits (DATA_MODEL.md "検索"), or newest first when `sort` asks for it."""
    if not scope.channel_ids:
        return []
    score = func.pgroonga_score(
        literal_column("messages.tableoid"), literal_column("messages.ctid")
    ).label("score")
    order = (
        (score.desc(), Message.created_at.desc())
        if sort == "relevance"
        else (Message.created_at.desc(),)
    )
    stmt = _matching(_scoped(select(Message, score), scope), query, escaped)
    rows = (await db.execute(stmt.order_by(*order).limit(limit).offset(offset))).all()
    return [(row[0], float(row[1] or 0.0)) for row in rows]


async def list_filtered(
    db: AsyncSession, *, scope: Scope, limit: int, offset: int
) -> list[Message]:
    """Modifier-only searches (no words): the newest matching messages, no ranking."""
    if not scope.channel_ids:
        return []
    stmt = _scoped(select(Message), scope).order_by(Message.created_at.desc())
    return list((await db.execute(stmt.limit(limit).offset(offset))).scalars().all())


async def count(db: AsyncSession, *, query: str | None, scope: Scope, escaped: bool) -> int:
    """How many messages match, counting at most TOTAL_CAP + 1 of them."""
    if not scope.channel_ids:
        return 0
    stmt = _matching(_scoped(select(Message.id), scope), query, escaped).limit(TOTAL_CAP + 1)
    return int((await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one())


async def extract_keywords(db: AsyncSession, query: str, *, escaped: bool) -> list[str]:
    needle = func.pgroonga_query_escape(query) if escaped else query
    result = await db.execute(select(func.pgroonga_query_extract_keywords(needle)))
    keywords: list[str] | None = result.scalar_one()
    return [str(k) for k in (keywords or [])]
