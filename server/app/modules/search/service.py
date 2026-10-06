"""GET /search/messages and (M42) /search/canvases: full-text search limited to the caller's
channels (SECURITY.md §3)."""

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass, replace

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, bad_request
from app.modules.canvases import markers as canvas_markers
from app.modules.canvases.models import Canvas
from app.modules.canvases.schemas import to_meta as to_canvas_meta
from app.modules.channels import service as channels
from app.modules.channels.schemas import ChannelOut
from app.modules.messages import service as messages
from app.modules.messages.models import Message
from app.modules.search import repository as repo
from app.modules.search.query import max_dt, min_dt, parse_query
from app.modules.search.schemas import (
    CanvasSearchHit,
    CanvasSearchOut,
    CanvasSearchQuery,
    PageSearchHit,
    PageSearchOut,
    PageSearchQuery,
    SearchFilters,
    SearchHit,
    SearchOut,
    SearchQuery,
)
from app.modules.search.snippet import make_snippet
from app.modules.users import repository as users_repo
from app.modules.users.models import User
from app.modules.wiki import service as wiki
from app.modules.wiki.models import WikiPage

log = logging.getLogger("app.search")


async def _gated[T](
    run: Callable[[], Awaitable[T]], *, timeout_ms: int | None, gate: asyncio.Semaphore | None
) -> T:
    """At most `gate`'s count of searches at once, each cancelled after `timeout_ms` (M19): a slow
    search returns a temporary error instead of holding a database connection while posts and
    syncs wait. Message and canvas searches share the gate."""
    if gate is None:
        return await run()
    try:
        await asyncio.wait_for(gate.acquire(), timeout=(timeout_ms or 5000) / 1000)
    except TimeoutError as exc:
        raise AppError(503, "search_busy", "Search is busy, try again in a moment") from exc
    try:
        return await run()
    finally:
        gate.release()


async def search(
    db: AsyncSession,
    actor: User,
    params: SearchQuery,
    *,
    timeout_ms: int | None = None,
    gate: asyncio.Semaphore | None = None,
) -> SearchOut:
    return await _gated(
        lambda: _search(db, actor, params, timeout_ms), timeout_ms=timeout_ms, gate=gate
    )


async def _limit_time(db: AsyncSession, timeout_ms: int | None) -> None:
    """For the rest of this transaction: PostgreSQL cancels a statement running longer than
    `timeout_ms`, and reads messages through the indexes. PGroonga scores only what its index
    finds: on a small table the planner preferred reading it whole, and every hit scored 0."""
    await db.execute(text("SET LOCAL enable_seqscan = off"))
    if timeout_ms:
        await db.execute(text(f"SET LOCAL statement_timeout = {int(timeout_ms)}"))


def _cancelled(exc: DBAPIError) -> bool:
    """The statement ran past statement_timeout (SQLSTATE 57014, query_canceled)."""
    for error in (exc.orig, getattr(exc.orig, "__cause__", None)):
        if getattr(error, "sqlstate", None) == "57014" or getattr(error, "pgcode", None) == "57014":
            return True
    return False


async def _search(
    db: AsyncSession, actor: User, params: SearchQuery, timeout_ms: int | None
) -> SearchOut:
    return await _in_time(db, lambda: _search_in_time(db, actor, params, timeout_ms), timeout_ms)


async def _in_time[T](
    db: AsyncSession, run: Callable[[], Awaitable[T]], timeout_ms: int | None
) -> T:
    try:
        return await run()
    except DBAPIError as exc:
        if not _cancelled(exc):
            raise
        await db.rollback()
        log.warning("search cancelled after %s ms", timeout_ms)
        raise AppError(
            503, "search_timeout", "The search took too long, try fewer or more specific words"
        ) from exc


@dataclass
class Resolved:
    """What a message search covers once its query is understood (SECURITY.md §3): the words,
    the filters said back, the scope, and the channels in reach. Shared by the search and by
    「AI に聞く」 (docs/AI.md §13), so both read exactly the same messages."""

    text: str
    filters: SearchFilters
    scope: repo.Scope
    # Every conversation in reach: the caller's own, and (is:times) the public times they have
    # not joined, by id.
    channels: dict[uuid.UUID, ChannelOut]
    # The public times found by is:times that the caller is not a member of.
    others: list[ChannelOut]
    # The one conversation the search was narrowed to (channel_id or in:#), else None.
    narrowed_to: uuid.UUID | None
    # Whether anything besides the words says what to look for.
    has_conditions: bool


async def resolve(db: AsyncSession, actor: User, params: SearchQuery) -> Resolved:
    """The scope of a message search for `actor` (403 not_a_member for a `channel_id` they may
    not search). Modifiers that name nothing they can see are listed in `filters.unresolved`."""
    mine = await channels.list_channels(db, actor, include_public=False)
    parsed = parse_query(params.q, tz_offset_minutes=params.tz_offset_minutes)
    is_times = parsed.is_times or params.is_times
    # L8 is:times (TIMES_FEED.md §6): my times plus the public times I have not joined (archived
    # ones too: a graduate's log is kept for those who come after). Not for guests (M13e).
    others: list[ChannelOut] = []
    if is_times:
        others = await channels.list_public_times_not_member(db, actor)
        mine = [c for c in mine if c.times_owner_id is not None]
    pool = [*mine, *others]
    narrowed_to: uuid.UUID | None = None
    if params.channel_id is not None:
        if not any(c.id == params.channel_id for c in others):
            await channels.require_member(db, actor.id, params.channel_id)
        # A channel outside is:times' range (not a times) finds nothing.
        channel_ids = (
            [params.channel_id]
            if any(c.id == params.channel_id for c in pool) or not is_times
            else []
        )
        narrowed_to = params.channel_id
    else:
        channel_ids = [uuid.UUID(str(c.id)) for c in pool]

    filters = SearchFilters(
        text=parsed.text,
        after=max_dt(params.after, parsed.after),
        before=min_dt(params.before, parsed.before),
        has=list(dict.fromkeys([*parsed.has, *params.has])),
        is_thread=parsed.is_thread or params.is_thread,
        is_times=is_times,
        unresolved=list(parsed.unresolved),
    )
    from_user_id = params.from_user_id
    for username in parsed.from_users:
        user = await users_repo.get_by_username(db, username)
        if user is None:
            filters.unresolved.append(f"from:@{username}")
        else:
            filters.from_username = user.username
            from_user_id = uuid.UUID(str(user.id))
    for name in parsed.in_channels:
        match = next((c for c in pool if (c.name or "").lower() == name.lower()), None)
        if match is None:
            filters.unresolved.append(f"in:#{name}")
        else:
            filters.in_channel = match.name
            channel_ids = [uuid.UUID(str(match.id))]
            narrowed_to = channel_ids[0]
    structured = bool(
        params.channel_id
        or params.from_user_id
        or params.after
        or params.before
        or params.has
        or params.is_thread
        or params.is_times
    )
    scope = repo.Scope(
        channel_ids=channel_ids,
        from_user_id=from_user_id,
        after=filters.after,
        before=filters.before,
        has=filters.has,
        is_thread=filters.is_thread,
    )
    return Resolved(
        text=parsed.text,
        filters=filters,
        scope=scope,
        channels={uuid.UUID(str(c.id)): c for c in pool},
        others=others,
        narrowed_to=narrowed_to,
        has_conditions=parsed.has_modifiers or structured,
    )


async def _search_in_time(
    db: AsyncSession, actor: User, params: SearchQuery, timeout_ms: int | None
) -> SearchOut:
    await _limit_time(db, timeout_ms)
    resolved = await resolve(db, actor, params)
    filters, scope, others = resolved.filters, resolved.scope, resolved.others
    if not resolved.text and not resolved.has_conditions and not filters.unresolved:
        raise bad_request("empty_query", "Enter words to search or a modifier such as from:@name")

    empty = SearchOut(
        hits=[],
        keywords=[],
        filters=filters,
        limit=params.limit,
        offset=params.offset,
        has_more=False,
    )
    if filters.unresolved:
        return empty  # a modifier named nothing the caller can see: no guessing

    if resolved.text:
        try:
            rows, keywords, total = await _run(db, resolved.text, scope, params, escaped=False)
        except DBAPIError as exc:
            if _cancelled(exc):
                raise
            # Groonga rejected the syntax (unbalanced quotes / parentheses): search it literally.
            log.info("search query fell back to escaped form: %s", exc.orig)
            await db.rollback()
            await _limit_time(db, timeout_ms)  # the rollback ended the transaction, and its limit
            rows, keywords, total = await _run(db, resolved.text, scope, params, escaped=True)
    else:
        # Modifiers only (e.g. from:@alice on:2026-09-26): newest first, no ranking.
        rows = [
            (m, 0.0)
            for m in await repo.list_filtered(
                db, scope=scope, limit=params.limit + 1, offset=params.offset
            )
        ]
        keywords = []
        total = await repo.count(db, query=None, scope=scope, escaped=False)
    has_more = len(rows) > params.limit
    rows = rows[: params.limit]
    outs = await messages.messages_out(db, [m for m, _ in rows], actor.id)
    hits = [SearchHit(message=out, score=score) for out, (_, score) in zip(outs, rows, strict=True)]
    hit_channels = {m.channel_id for m, _ in rows}
    return SearchOut(
        channels=[c for c in others if c.id in hit_channels],
        hits=hits,
        keywords=keywords,
        filters=filters,
        limit=params.limit,
        offset=params.offset,
        has_more=has_more,
        total=min(total, repo.TOTAL_CAP),
        total_capped=total > repo.TOTAL_CAP,
    )


# --- top hits for 「AI に聞く」 (docs/AI.md §13) ------------------------------------------------


@dataclass
class TopHits:
    """The best matches of a resolved search: most relevant first (ties: newest first)."""

    messages: list[Message]
    # What PGroonga matched on (for the excerpts).
    keywords: list[str]
    # Matches in the conversations left out (`leave_out`), counted to TOTAL_CAP.
    left_out: int = 0


async def _unlimit_time(db: AsyncSession) -> None:
    """Undoes _limit_time for the rest of the transaction (the caller goes on writing)."""
    await db.execute(text("SET LOCAL enable_seqscan TO DEFAULT"))
    await db.execute(text("SET LOCAL statement_timeout TO DEFAULT"))


async def top_hits(
    db: AsyncSession,
    resolved: Resolved,
    *,
    words: str,
    limit: int,
    leave_out: Collection[uuid.UUID] = (),
    timeout_ms: int | None = None,
    gate: asyncio.Semaphore | None = None,
) -> TopHits:
    """The `limit` best matches of `words` (Groonga query syntax) within `resolved`, with the
    search's own rules, indexes, time limit and gate. Without words, the newest messages the
    modifiers select. The conversations in `leave_out` are not searched; how many of their
    messages would have matched is counted instead. Unresolved modifiers find nothing, as in the
    search. Afterwards the transaction runs without the search's limits again."""
    if resolved.filters.unresolved or (not words and not resolved.has_conditions):
        return TopHits(messages=[], keywords=[])
    excluded = set(leave_out)
    inside = replace(
        resolved.scope, channel_ids=[c for c in resolved.scope.channel_ids if c not in excluded]
    )
    outside = replace(
        resolved.scope, channel_ids=[c for c in resolved.scope.channel_ids if c in excluded]
    )

    async def find(escaped: bool) -> TopHits:
        if not words:
            found = await repo.list_filtered(db, scope=inside, limit=limit, offset=0)
            left = await repo.count(db, query=None, scope=outside, escaped=False)
            return TopHits(messages=found, keywords=[], left_out=left)
        rows = await repo.search_messages(
            db, query=words, scope=inside, sort="relevance", limit=limit, offset=0, escaped=escaped
        )
        keywords = await repo.extract_keywords(db, words, escaped=escaped)
        left = await repo.count(db, query=words, scope=outside, escaped=escaped)
        return TopHits(messages=[m for m, _ in rows], keywords=keywords, left_out=left)

    async def in_time() -> TopHits:
        await _limit_time(db, timeout_ms)
        try:
            return await find(False)
        except DBAPIError as exc:
            if _cancelled(exc):
                raise
            log.info("AI search query fell back to escaped form: %s", exc.orig)
            await db.rollback()
            await _limit_time(db, timeout_ms)
            return await find(True)

    found = await _gated(
        lambda: _in_time(db, in_time, timeout_ms), timeout_ms=timeout_ms, gate=gate
    )
    await _unlimit_time(db)
    return found


# --- canvases (M42, CANVAS.md §4.8) ---------------------------------------------------------------


async def search_canvases(
    db: AsyncSession,
    actor: User,
    params: CanvasSearchQuery,
    *,
    timeout_ms: int | None = None,
    gate: asyncio.Semaphore | None = None,
) -> CanvasSearchOut:
    """GET /search/canvases: the live canvases of the conversations the caller belongs to (a
    canvas is read by members only, guests included, CANVAS.md §4.7: public channels the caller
    has not joined are not searched, unlike messages)."""

    async def run() -> CanvasSearchOut:
        return await _in_time(
            db, lambda: _search_canvases_in_time(db, actor, params, timeout_ms), timeout_ms
        )

    return await _gated(run, timeout_ms=timeout_ms, gate=gate)


async def _search_canvases_in_time(
    db: AsyncSession, actor: User, params: CanvasSearchQuery, timeout_ms: int | None
) -> CanvasSearchOut:
    await _limit_time(db, timeout_ms)
    mine = await channels.list_channels(db, actor, include_public=False)
    if params.channel_id is not None:
        await channels.require_member(db, actor.id, params.channel_id)
        channel_ids = [params.channel_id]
    else:
        channel_ids = [uuid.UUID(str(c.id)) for c in mine]

    parsed = parse_query(params.q, tz_offset_minutes=params.tz_offset_minutes)
    filters = SearchFilters(
        text=parsed.text,
        after=max_dt(params.after, parsed.after),
        before=min_dt(params.before, parsed.before),
        unresolved=list(parsed.unresolved),
    )
    # has: / is: are about messages: said back as not understood rather than ignored.
    filters.unresolved.extend(f"has:{flag}" for flag in parsed.has)
    if parsed.is_thread:
        filters.unresolved.append("is:thread")
    if parsed.is_times:
        filters.unresolved.append("is:times")
    from_user_id = params.from_user_id
    for username in parsed.from_users:
        user = await users_repo.get_by_username(db, username)
        if user is None:
            filters.unresolved.append(f"from:@{username}")
        else:
            filters.from_username = user.username
            from_user_id = uuid.UUID(str(user.id))
    for name in parsed.in_channels:
        match = next((c for c in mine if (c.name or "").lower() == name.lower()), None)
        if match is None:
            filters.unresolved.append(f"in:#{name}")
        else:
            filters.in_channel = match.name
            channel_ids = [uuid.UUID(str(match.id))]
    structured = bool(params.channel_id or params.from_user_id or params.after or params.before)
    if not parsed.text and not parsed.has_modifiers and not structured and not filters.unresolved:
        raise bad_request("empty_query", "Enter words to search or a modifier such as from:@name")

    empty = CanvasSearchOut(
        hits=[],
        keywords=[],
        filters=filters,
        limit=params.limit,
        offset=params.offset,
        has_more=False,
    )
    if filters.unresolved:
        return empty

    scope = repo.CanvasScope(
        channel_ids=channel_ids,
        from_user_id=from_user_id,
        after=filters.after,
        before=filters.before,
    )
    keywords: list[str] = []
    if parsed.text:

        async def ranked(escaped: bool) -> tuple[list[tuple[Canvas, float]], list[str], int]:
            rows = await repo.search_canvases(
                db,
                query=parsed.text,
                scope=scope,
                sort=params.sort,
                limit=params.limit + 1,
                offset=params.offset,
                escaped=escaped,
            )
            words = await repo.extract_keywords(db, parsed.text, escaped=escaped)
            total = await repo.count_canvases(db, query=parsed.text, scope=scope, escaped=escaped)
            return rows, words, total

        try:
            rows, keywords, total = await ranked(False)
        except DBAPIError as exc:
            if _cancelled(exc):
                raise
            log.info("canvas search query fell back to escaped form: %s", exc.orig)
            await db.rollback()
            await _limit_time(db, timeout_ms)
            rows, keywords, total = await ranked(True)
    else:
        rows = [
            (c, 0.0)
            for c in await repo.list_canvases(
                db, scope=scope, limit=params.limit + 1, offset=params.offset
            )
        ]
        total = await repo.count_canvases(db, query=None, scope=scope, escaped=False)
    has_more = len(rows) > params.limit
    rows = rows[: params.limit]
    # The excerpts after the LIMIT: only for the page returned (CANVAS.md §7).
    hits = [
        CanvasSearchHit(
            canvas=to_canvas_meta(canvas),
            snippet=make_snippet(canvas_markers.strip(canvas.body), keywords),
            score=score,
        )
        for canvas, score in rows
    ]
    return CanvasSearchOut(
        hits=hits,
        keywords=keywords,
        filters=filters,
        limit=params.limit,
        offset=params.offset,
        has_more=has_more,
        total=min(total, repo.TOTAL_CAP),
        total_capped=total > repo.TOTAL_CAP,
    )


# --- wiki pages (M120, docs/WIKI.md §8.1) ---------------------------------------------------------


async def search_pages(
    db: AsyncSession,
    actor: User,
    params: PageSearchQuery,
    *,
    timeout_ms: int | None = None,
    gate: asyncio.Semaphore | None = None,
) -> PageSearchOut:
    """GET /search/pages: live pages the caller can read (the effective access, in the query
    itself) whose title, body or properties match."""

    async def run() -> PageSearchOut:
        return await _in_time(
            db, lambda: _search_pages_in_time(db, actor, params, timeout_ms), timeout_ms
        )

    return await _gated(run, timeout_ms=timeout_ms, gate=gate)


async def _search_pages_in_time(
    db: AsyncSession, actor: User, params: PageSearchQuery, timeout_ms: int | None
) -> PageSearchOut:
    await _limit_time(db, timeout_ms)
    parsed = parse_query(params.q, tz_offset_minutes=params.tz_offset_minutes)
    filters = SearchFilters(
        text=parsed.text,
        after=max_dt(params.after, parsed.after),
        before=min_dt(params.before, parsed.before),
        unresolved=list(parsed.unresolved),
    )
    filters.unresolved.extend(f"has:{flag}" for flag in parsed.has)
    if parsed.is_thread:
        filters.unresolved.append("is:thread")
    if parsed.is_times:
        filters.unresolved.append("is:times")
    from_user_id = params.from_user_id
    for username in parsed.from_users:
        user = await users_repo.get_by_username(db, username)
        if user is None:
            filters.unresolved.append(f"from:@{username}")
        else:
            filters.from_username = user.username
            from_user_id = uuid.UUID(str(user.id))
    in_page = params.in_page
    if in_page is not None and not await wiki.can_read(db, actor, in_page):
        # A page the caller cannot read narrows to nothing, said back like an unknown name.
        filters.unresolved.append("in_page")
    for title in parsed.in_channels:
        found = await wiki.find_by_title(db, actor, title)
        if found is None:
            filters.unresolved.append(f"in:{title}")
        else:
            filters.in_page = found.title
            in_page = found.id
    structured = bool(params.in_page or params.from_user_id or params.after or params.before)
    if not parsed.text and not parsed.has_modifiers and not structured and not filters.unresolved:
        raise bad_request("empty_query", "Enter words to search or a modifier such as from:@name")
    empty = PageSearchOut(
        hits=[],
        keywords=[],
        filters=filters,
        limit=params.limit,
        offset=params.offset,
        has_more=False,
    )
    if filters.unresolved:
        return empty
    scope = repo.PageScope(
        actor=actor,
        in_page=in_page,
        from_user_id=from_user_id,
        after=filters.after,
        before=filters.before,
        kind=params.kind,
    )
    keywords: list[str] = []
    if parsed.text:

        async def ranked(escaped: bool) -> tuple[list[tuple[WikiPage, float]], list[str], int]:
            rows = await repo.search_pages(
                db,
                query=parsed.text,
                scope=scope,
                sort=params.sort,
                limit=params.limit + 1,
                offset=params.offset,
                escaped=escaped,
            )
            words = await repo.extract_keywords(db, parsed.text, escaped=escaped)
            total = await repo.count_pages(db, query=parsed.text, scope=scope, escaped=escaped)
            return rows, words, total

        try:
            rows, keywords, total = await ranked(False)
        except DBAPIError as exc:
            if _cancelled(exc):
                raise
            log.info("page search query fell back to escaped form: %s", exc.orig)
            await db.rollback()
            await _limit_time(db, timeout_ms)
            rows, keywords, total = await ranked(True)
    else:
        rows = [
            (p, 0.0)
            for p in await repo.list_pages(
                db, scope=scope, limit=params.limit + 1, offset=params.offset
            )
        ]
        total = await repo.count_pages(db, query=None, scope=scope, escaped=False)
    has_more = len(rows) > params.limit
    rows = rows[: params.limit]
    items = await wiki.items_for(db, actor, [p for p, _ in rows])
    hits = [
        PageSearchHit(
            page=items[page.id],
            snippet=make_snippet(canvas_markers.strip(page.body), keywords),
            score=score,
        )
        for page, score in rows
        if page.id in items
    ]
    return PageSearchOut(
        hits=hits,
        keywords=keywords,
        filters=filters,
        limit=params.limit,
        offset=params.offset,
        has_more=has_more,
        total=min(total, repo.TOTAL_CAP),
        total_capped=total > repo.TOTAL_CAP,
    )


async def _run(
    db: AsyncSession, query: str, scope: repo.Scope, params: SearchQuery, *, escaped: bool
) -> tuple[list[tuple[Message, float]], list[str], int]:
    rows = await repo.search_messages(
        db,
        query=query,
        scope=scope,
        sort=params.sort,
        limit=params.limit + 1,
        offset=params.offset,
        escaped=escaped,
    )
    keywords = await repo.extract_keywords(db, query, escaped=escaped)
    total = await repo.count(db, query=query, scope=scope, escaped=escaped)
    return [(m, s) for m, s in rows], keywords, total
