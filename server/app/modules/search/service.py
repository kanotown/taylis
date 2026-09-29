"""GET /search/messages: full-text search limited to the caller's channels (SECURITY.md §3)."""

import asyncio
import logging
import uuid

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, bad_request
from app.modules.channels import service as channels
from app.modules.messages import service as messages
from app.modules.messages.models import Message
from app.modules.search import repository as repo
from app.modules.search.query import max_dt, min_dt, parse_query
from app.modules.search.schemas import SearchFilters, SearchHit, SearchOut, SearchQuery
from app.modules.users import repository as users_repo
from app.modules.users.models import User

log = logging.getLogger("app.search")


async def search(
    db: AsyncSession,
    actor: User,
    params: SearchQuery,
    *,
    timeout_ms: int | None = None,
    gate: asyncio.Semaphore | None = None,
) -> SearchOut:
    """At most `gate`'s count of searches at once, each cancelled after `timeout_ms` (M19): a slow
    search returns a temporary error instead of holding a database connection while posts and
    syncs wait."""
    if gate is None:
        return await _search(db, actor, params, timeout_ms)
    try:
        await asyncio.wait_for(gate.acquire(), timeout=(timeout_ms or 5000) / 1000)
    except TimeoutError as exc:
        raise AppError(503, "search_busy", "Search is busy, try again in a moment") from exc
    try:
        return await _search(db, actor, params, timeout_ms)
    finally:
        gate.release()


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
    try:
        return await _search_in_time(db, actor, params, timeout_ms)
    except DBAPIError as exc:
        if not _cancelled(exc):
            raise
        await db.rollback()
        log.warning("search cancelled after %s ms", timeout_ms)
        raise AppError(
            503, "search_timeout", "The search took too long, try fewer or more specific words"
        ) from exc


async def _search_in_time(
    db: AsyncSession, actor: User, params: SearchQuery, timeout_ms: int | None
) -> SearchOut:
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
        has=list(dict.fromkeys([*parsed.has, *params.has])),
        is_thread=parsed.is_thread or params.is_thread,
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
        match = next((c for c in mine if (c.name or "").lower() == name.lower()), None)
        if match is None:
            filters.unresolved.append(f"in:#{name}")
        else:
            filters.in_channel = match.name
            channel_ids = [uuid.UUID(str(match.id))]
    structured = bool(
        params.channel_id
        or params.from_user_id
        or params.after
        or params.before
        or params.has
        or params.is_thread
    )
    if not parsed.text and not parsed.has_modifiers and not structured and not filters.unresolved:
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

    scope = repo.Scope(
        channel_ids=channel_ids,
        from_user_id=from_user_id,
        after=filters.after,
        before=filters.before,
        has=filters.has,
        is_thread=filters.is_thread,
    )
    if parsed.text:
        try:
            rows, keywords, total = await _run(db, parsed.text, scope, params, escaped=False)
        except DBAPIError as exc:
            if _cancelled(exc):
                raise
            # Groonga rejected the syntax (unbalanced quotes / parentheses): search it literally.
            log.info("search query fell back to escaped form: %s", exc.orig)
            await db.rollback()
            await _limit_time(db, timeout_ms)  # the rollback ended the transaction, and its limit
            rows, keywords, total = await _run(db, parsed.text, scope, params, escaped=True)
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
    return SearchOut(
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
