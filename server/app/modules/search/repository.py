"""PGroonga queries. Read-only access to messages / attachments (ARCHITECTURE.md §5 exception)."""

import uuid
from datetime import datetime

from sqlalchemy import exists, func, literal_column, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attachments.models import Attachment
from app.modules.messages.models import Message


async def search_messages(
    db: AsyncSession,
    *,
    query: str,
    channel_ids: list[uuid.UUID],
    from_user_id: uuid.UUID | None,
    after: datetime | None,
    before: datetime | None,
    limit: int,
    offset: int,
    escaped: bool,
) -> list[tuple[Message, float]]:
    """Ranked hits (DATA_MODEL.md "検索"). `&@~` takes Groonga query syntax (AND, OR, -, quotes)."""
    if not channel_ids:
        return []
    needle = func.pgroonga_query_escape(query) if escaped else query
    filename_match = exists(
        select(Attachment.id).where(
            Attachment.message_id == Message.id,
            Attachment.status == "attached",
            Attachment.filename.op("&@~")(needle),
        )
    )
    score = func.pgroonga_score(
        literal_column("messages.tableoid"), literal_column("messages.ctid")
    ).label("score")
    stmt = (
        select(Message, score)
        .where(
            or_(Message.body.op("&@~")(needle), filename_match),
            Message.channel_id.in_(channel_ids),
            Message.deleted_at.is_(None),
            Message.type == "user",
        )
        .order_by(score.desc(), Message.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if from_user_id is not None:
        stmt = stmt.where(Message.sender_id == from_user_id)
    if after is not None:
        stmt = stmt.where(Message.created_at >= after)
    if before is not None:
        stmt = stmt.where(Message.created_at < before)
    rows = (await db.execute(stmt)).all()
    return [(row[0], float(row[1] or 0.0)) for row in rows]


async def list_filtered(
    db: AsyncSession,
    *,
    channel_ids: list[uuid.UUID],
    from_user_id: uuid.UUID | None,
    after: datetime | None,
    before: datetime | None,
    limit: int,
    offset: int,
) -> list[Message]:
    """Modifier-only searches (no words): the newest matching messages, no ranking."""
    if not channel_ids:
        return []
    stmt = (
        select(Message)
        .where(
            Message.channel_id.in_(channel_ids),
            Message.deleted_at.is_(None),
            Message.type == "user",
        )
        .order_by(Message.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if from_user_id is not None:
        stmt = stmt.where(Message.sender_id == from_user_id)
    if after is not None:
        stmt = stmt.where(Message.created_at >= after)
    if before is not None:
        stmt = stmt.where(Message.created_at < before)
    return list((await db.execute(stmt)).scalars().all())


async def extract_keywords(db: AsyncSession, query: str, *, escaped: bool) -> list[str]:
    needle = func.pgroonga_query_escape(query) if escaped else query
    result = await db.execute(select(func.pgroonga_query_extract_keywords(needle)))
    keywords: list[str] | None = result.scalar_one()
    return [str(k) for k in (keywords or [])]
