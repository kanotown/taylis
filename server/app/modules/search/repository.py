"""PGroonga queries. Read-only access to messages / attachments / canvases (ARCHITECTURE.md §5
exception)."""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import (
    Select,
    Subquery,
    Text,
    cast,
    exists,
    func,
    literal,
    literal_column,
    or_,
    select,
    union_all,
)
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.doctext import blocks as doc_blocks
from app.modules.attachments.models import Attachment
from app.modules.canvases.models import Canvas
from app.modules.messages.models import Message, Reaction
from app.modules.users.models import User
from app.modules.wiki.access import readable_ids
from app.modules.wiki.models import WikiPage

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


def _within(stmt: Select[Any], scope: Scope, row: Any) -> Select[Any]:
    """The scope's own columns, on `row`: the messages, or the body hits that carry them (_hits)."""
    stmt = stmt.where(
        row.channel_id.in_(scope.channel_ids),
        row.deleted_at.is_(None),
        row.type == "user",
    )
    if scope.from_user_id is not None:
        stmt = stmt.where(row.sender_id == scope.from_user_id)
    if scope.after is not None:
        stmt = stmt.where(row.created_at >= scope.after)
    if scope.before is not None:
        stmt = stmt.where(row.created_at < scope.before)
    return stmt


def _flagged(scope: Scope) -> bool:
    return bool(scope.has) or scope.is_thread


def _scoped(stmt: Select[Any], scope: Scope) -> Select[Any]:
    return _apply_flags(_within(stmt, scope, Message), scope.has, scope.is_thread)


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

    def branch(score: Any, stmt: Select[Any], row: Any) -> Select[Any]:
        """`stmt` selects the id; `row` has the scope's columns (and joins messages for flags)."""
        stmt = _within(
            stmt.add_columns(score.label("score"), row.created_at.label("created_at")), scope, row
        )
        if _flagged(scope):
            if row is not Message:
                stmt = stmt.join(Message, Message.id == row.id)
            stmt = _apply_flags(stmt, scope.has, scope.is_thread)
        # Sorted by an expression, not the column: with messages_created_idx the planner would walk
        # the messages newest first and test each one, instead of taking the hits and sorting them
        # (174 ms and scores of 0 for a rare word on 465k messages, and worse the rarer the word).
        newest = (row.created_at + literal_column("interval '0'")).desc()
        if sort == "relevance":
            stmt = stmt.order_by(score.desc(), newest)
        elif sort == "newest":
            stmt = stmt.order_by(newest)
        return stmt.limit(take)

    # Each branch starts from a materialized step whose only condition is the words, so the only
    # way in is the PGroonga index (seq scans are off, search/service.py) and every hit gets its
    # score. With the scope beside the words, a small table could be read through another index
    # (the channel's, the sender's) with the words as a mere filter: every score 0, and 「関連度順」
    # was 「新しい順」 again (seen in CI on a near-empty database, as a new workspace would be). The
    # body hits carry the scope's columns: reading each hit again by its id doubled the time of a
    # common word (50k hits); messages are joined again only for the has: / is: flags.
    matched = (
        select(
            Message.id.label("id"),
            Message.channel_id.label("channel_id"),
            Message.sender_id.label("sender_id"),
            Message.created_at.label("created_at"),
            Message.deleted_at.label("deleted_at"),
            Message.type.label("type"),
            func.pgroonga_score(
                literal_column("messages.tableoid"), literal_column("messages.ctid")
            ).label("score"),
        )
        .where(Message.body.op("&@~")(needle))
        .cte("body_hits")
        .prefix_with("MATERIALIZED")
    )
    body = branch(matched.c.score, select(matched.c.id.label("id")), matched.c)
    # The file names the same way: joined to messages, or with the status beside it, the planner
    # tested each attachment's name instead of asking the attachments' PGroonga index.
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
        Message,
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


# --- canvases (M42, CANVAS.md §4.8): read-only access to canvases -------------------------------


@dataclass(frozen=True)
class CanvasScope:
    """Where to look: the caller's conversations, and who / when (on the last update)."""

    channel_ids: list[uuid.UUID]
    from_user_id: uuid.UUID | None = None
    after: datetime | None = None
    before: datetime | None = None


def canvas_document() -> Any:
    """`ARRAY[title::text, body without the task markers and container lines]`: the expression
    canvases_search_idx is built on (migration 0047; 0068 took the M80 markers out, so 「task」
    finds no linked item; 0109 the M149 `::: callout` / `::: toggle` / `:::` lines, keeping the
    icon and the title).
    One expression, one index: `title &@~ q OR body &@~ q` used no index at all (1,374 ms on 5,000
    canvases, CANVAS.md §7). The pattern is written as a constant, as in the index: a bound
    parameter would not match the index's expression."""
    body = func.regexp_replace(
        Canvas.body,
        literal_column(f"'{doc_blocks.BODY_SQL}'"),
        literal_column("''"),
        literal_column("'gn'"),
        type_=Text,
    )
    return postgresql.array([cast(Canvas.title, Text), body])


def _text_needle(query: str, escaped: bool) -> Any:
    needle = literal(query, type_=Text)
    return func.pgroonga_query_escape(needle, type_=Text) if escaped else needle


def _canvas_within(stmt: Select[Any], scope: CanvasScope, row: Any) -> Select[Any]:
    stmt = stmt.where(row.channel_id.in_(scope.channel_ids), row.deleted_at.is_(None))
    if scope.from_user_id is not None:
        stmt = stmt.where(
            or_(row.created_by == scope.from_user_id, row.updated_by == scope.from_user_id)
        )
    if scope.after is not None:
        stmt = stmt.where(row.updated_at >= scope.after)
    if scope.before is not None:
        stmt = stmt.where(row.updated_at < scope.before)
    return stmt


def _canvas_hits(query: str, scope: CanvasScope, escaped: bool) -> Subquery:
    """Canvases whose title or body matches, with their PGroonga score. As for messages (_hits),
    the words alone go into a materialized step, so the index is the only way in and every hit
    is scored; the scope is applied to what it found."""
    matched = (
        select(
            Canvas.id.label("id"),
            Canvas.channel_id.label("channel_id"),
            Canvas.created_by.label("created_by"),
            Canvas.updated_by.label("updated_by"),
            Canvas.updated_at.label("updated_at"),
            Canvas.deleted_at.label("deleted_at"),
            func.pgroonga_score(
                literal_column("canvases.tableoid"), literal_column("canvases.ctid")
            ).label("score"),
        )
        # The needle typed as text: next to an array, SQLAlchemy would bind it as one.
        .where(canvas_document().op("&@~")(_text_needle(query, escaped)))
        .cte("canvas_hits")
        .prefix_with("MATERIALIZED")
    )
    stmt = _canvas_within(select(matched.c.id, matched.c.score), scope, matched.c)
    return stmt.subquery("canvas_scored")


async def search_canvases(
    db: AsyncSession,
    *,
    query: str,
    scope: CanvasScope,
    sort: Sort,
    limit: int,
    offset: int,
    escaped: bool,
) -> list[tuple[Canvas, float]]:
    """Ranked (score, then the most recently updated), or the most recently updated first."""
    if not scope.channel_ids:
        return []
    stmt = canvas_search_statement(
        query, scope, sort=sort, limit=limit, offset=offset, escaped=escaped
    )
    rows = (await db.execute(stmt)).all()
    return [(row[0], float(row[1] or 0.0)) for row in rows]


def canvas_search_statement(
    query: str, scope: CanvasScope, *, sort: Sort, limit: int, offset: int, escaped: bool
) -> Select[Any]:
    """The query search_canvases runs (the tests EXPLAIN it: canvases_search_idx must be used)."""
    hits = _canvas_hits(query, scope, escaped)
    order = (
        (hits.c.score.desc(), Canvas.updated_at.desc())
        if sort == "relevance"
        else (Canvas.updated_at.desc(),)
    )
    stmt = select(Canvas, hits.c.score).join(hits, hits.c.id == Canvas.id)
    return stmt.order_by(*order, Canvas.id).limit(limit).offset(offset)


async def list_canvases(
    db: AsyncSession, *, scope: CanvasScope, limit: int, offset: int
) -> list[Canvas]:
    """Modifier-only searches: the most recently updated canvases in scope."""
    if not scope.channel_ids:
        return []
    stmt = _canvas_within(select(Canvas), scope, Canvas).order_by(
        Canvas.updated_at.desc(), Canvas.id
    )
    return list((await db.execute(stmt.limit(limit).offset(offset))).scalars().all())


async def count_canvases(
    db: AsyncSession, *, query: str | None, scope: CanvasScope, escaped: bool
) -> int:
    """How many canvases match, counting at most TOTAL_CAP + 1 of them."""
    if not scope.channel_ids:
        return 0
    if query:
        stmt = select(_canvas_hits(query, scope, escaped).c.id).limit(TOTAL_CAP + 1)
    else:
        stmt = _canvas_within(select(Canvas.id), scope, Canvas).limit(TOTAL_CAP + 1)
    return int((await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one())


# --- wiki pages (M120, docs/WIKI.md §8.1): read-only access to wiki_pages ------------------------


@dataclass(frozen=True)
class PageScope:
    """Who searches (only the pages they can read), where (a subtree) and who / when."""

    actor: User
    in_page: uuid.UUID | None = None
    from_user_id: uuid.UUID | None = None
    after: datetime | None = None
    before: datetime | None = None
    kind: str | None = None


def page_document() -> Any:
    """`ARRAY[title::text, body without task markers and container lines, props_text]`: the
    expression of wiki_pages_search_idx (migrations 0095, 0109), written the same way (see
    canvas_document)."""
    body = func.regexp_replace(
        WikiPage.body,
        literal_column(f"'{doc_blocks.BODY_SQL}'"),
        literal_column("''"),
        literal_column("'gn'"),
        type_=Text,
    )
    props = func.coalesce(WikiPage.props_text, literal_column("''"), type_=Text)
    return postgresql.array([cast(WikiPage.title, Text), body, props])


def _page_within(stmt: Select[Any], scope: PageScope, row: Any) -> Select[Any]:
    """Always: live pages the actor can read (the effective access, docs/WIKI.md §8.1), never a
    template (M145, §22.3)."""
    stmt = stmt.where(
        row.id.in_(readable_ids(scope.actor)),
        row.deleted_at.is_(None),
        row.is_template.is_(False),
    )
    if scope.in_page is not None:
        stmt = stmt.where(or_(row.id == scope.in_page, row.path.contains([scope.in_page])))
    if scope.kind is not None:
        stmt = stmt.where(row.kind == scope.kind)
    if scope.from_user_id is not None:
        stmt = stmt.where(
            or_(row.created_by == scope.from_user_id, row.updated_by == scope.from_user_id)
        )
    if scope.after is not None:
        stmt = stmt.where(row.updated_at >= scope.after)
    if scope.before is not None:
        stmt = stmt.where(row.updated_at < scope.before)
    return stmt


def _page_hits(query: str, scope: PageScope, escaped: bool) -> Subquery:
    """Pages whose title, body or properties match, scored; the words alone go through the index
    (a materialized step), the access and the rest are applied to what it found."""
    matched = (
        select(
            WikiPage.id.label("id"),
            WikiPage.path.label("path"),
            WikiPage.kind.label("kind"),
            WikiPage.created_by.label("created_by"),
            WikiPage.updated_by.label("updated_by"),
            WikiPage.updated_at.label("updated_at"),
            WikiPage.deleted_at.label("deleted_at"),
            WikiPage.is_template.label("is_template"),
            func.pgroonga_score(
                literal_column("wiki_pages.tableoid"), literal_column("wiki_pages.ctid")
            ).label("score"),
        )
        .where(page_document().op("&@~")(_text_needle(query, escaped)))
        .cte("page_hits")
        .prefix_with("MATERIALIZED")
    )
    stmt = _page_within(select(matched.c.id, matched.c.score), scope, matched.c)
    return stmt.subquery("page_scored")


def page_search_statement(
    query: str, scope: PageScope, *, sort: Sort, limit: int, offset: int, escaped: bool
) -> Select[Any]:
    """The query search_pages runs (the tests EXPLAIN it: wiki_pages_search_idx must be used)."""
    hits = _page_hits(query, scope, escaped)
    order = (
        (hits.c.score.desc(), WikiPage.updated_at.desc())
        if sort == "relevance"
        else (WikiPage.updated_at.desc(),)
    )
    return (
        select(WikiPage, hits.c.score)
        .join(hits, hits.c.id == WikiPage.id)
        .order_by(*order, WikiPage.id)
        .limit(limit)
        .offset(offset)
    )


async def search_pages(
    db: AsyncSession,
    *,
    query: str,
    scope: PageScope,
    sort: Sort,
    limit: int,
    offset: int,
    escaped: bool,
) -> list[tuple[WikiPage, float]]:
    stmt = page_search_statement(
        query, scope, sort=sort, limit=limit, offset=offset, escaped=escaped
    )
    rows = (await db.execute(stmt)).all()
    return [(row[0], float(row[1] or 0.0)) for row in rows]


async def list_pages(
    db: AsyncSession, *, scope: PageScope, limit: int, offset: int
) -> list[WikiPage]:
    """Modifier-only searches: the most recently updated pages in scope."""
    stmt = _page_within(select(WikiPage), scope, WikiPage).order_by(
        WikiPage.updated_at.desc(), WikiPage.id
    )
    return list((await db.execute(stmt.limit(limit).offset(offset))).scalars().all())


async def count_pages(
    db: AsyncSession, *, query: str | None, scope: PageScope, escaped: bool
) -> int:
    if query:
        stmt = select(_page_hits(query, scope, escaped).c.id).limit(TOTAL_CAP + 1)
    else:
        stmt = _page_within(select(WikiPage.id), scope, WikiPage).limit(TOTAL_CAP + 1)
    return int((await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one())
