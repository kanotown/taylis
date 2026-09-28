"""PGroonga queries. Read-only access to messages / attachments (ARCHITECTURE.md §5 exception)."""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import Select, Subquery, exists, func, literal_column, or_, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

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
        # Its own alias: in the file-name branch (M19) the outer query reads attachments too.
        attached = aliased(Attachment)
        stmt = stmt.where(
            exists(
                select(attached.id).where(
                    attached.message_id == Message.id, attached.status == "attached"
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


def _needle(query: str, escaped: bool) -> Any:
    return func.pgroonga_query_escape(query) if escaped else query


def _hits(query: str, scope: Scope, escaped: bool, *, sort: Sort | None, take: int) -> Subquery:
    """Messages whose body or an attached file's name matches, with their best PGroonga score.

    Two branches in a UNION, each on its own PGroonga index (M19): one condition `body &@~ q OR
    EXISTS (filename &@~ q)` could use neither, read every message in scope (1.4-6 s on 465k
    messages, even with no hit) and left every score at 0, so 「関連度順」 was really 「新しい順」.
    `&@~` takes Groonga query syntax (AND, OR, -, quotes). Each branch keeps only its first `take`
    rows in `sort` order (any rows when counting): a common word matches tens of thousands of
    messages, and only a page (or TOTAL_CAP + 1) of them is ever needed.
    """
    needle = _needle(query, escaped)
    # Sorted by an expression, not the column: with messages_created_idx the planner would walk the
    # messages newest first and test each against the words, instead of asking PGroonga for the hits
    # (174 ms and scores of 0 for a rare word on 465k messages, and worse the rarer the word). The
    # hits are found by the index, then sorted.
    newest = (Message.created_at + literal_column("interval '0'")).desc()

    def branch(score: Any, stmt: Select[Any]) -> Select[Any]:
        stmt = _scoped(
            stmt.add_columns(score.label("score"), Message.created_at.label("created_at")), scope
        )
        if sort == "relevance":
            stmt = stmt.order_by(score.desc(), newest)
        elif sort == "newest":
            stmt = stmt.order_by(newest)
        return stmt.limit(take)

    body = branch(
        func.pgroonga_score(literal_column("messages.tableoid"), literal_column("messages.ctid")),
        select(Message.id.label("id")).where(Message.body.op("&@~")(needle)),
    )
    # The file names on their own, as a materialized step with the name as its only condition:
    # joined to messages, or with the status beside it, the planner tested each attachment's name
    # instead of asking the attachments' PGroonga index, and scored every file 0.
    named = (
        select(
            Attachment.message_id.label("message_id"),
            Attachment.status.label("status"),
            func.pgroonga_score(
                literal_column("attachments.tableoid"), literal_column("attachments.ctid")
            ).label("score"),
        )
        .where(Attachment.filename.op("&@~")(needle))
        .cte("named_files")
        .prefix_with("MATERIALIZED")
    )
    files = branch(
        func.max(named.c.score),
        select(Message.id.label("id"))
        .select_from(named)
        .join(Message, Message.id == named.c.message_id)
        .where(named.c.status == "attached")
        .group_by(Message.id, Message.created_at),
    )
    both = union_all(body, files).subquery("both_hits")
    return (
        select(both.c.id, func.max(both.c.score).label("score"))
        .group_by(both.c.id)
        .subquery("hits")
    )


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
    hits = _hits(query, scope, escaped, sort=sort, take=offset + limit)
    order = (
        (hits.c.score.desc(), Message.created_at.desc())
        if sort == "relevance"
        else (Message.created_at.desc(),)
    )
    stmt = select(Message, hits.c.score).join(hits, hits.c.id == Message.id)
    rows = (await db.execute(stmt.order_by(*order, Message.id).limit(limit).offset(offset))).all()
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
    if query:
        stmt = select(_hits(query, scope, escaped, sort=None, take=TOTAL_CAP + 1).c.id).limit(
            TOTAL_CAP + 1
        )
    else:
        stmt = _scoped(select(Message.id), scope).limit(TOTAL_CAP + 1)
    return int((await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one())


async def extract_keywords(db: AsyncSession, query: str, *, escaped: bool) -> list[str]:
    result = await db.execute(select(func.pgroonga_query_extract_keywords(_needle(query, escaped))))
    keywords: list[str] | None = result.scalar_one()
    return [str(k) for k in (keywords or [])]
