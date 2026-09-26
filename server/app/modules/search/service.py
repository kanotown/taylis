"""GET /search/messages: full-text search limited to the caller's channels (SECURITY.md §3)."""

import logging
import uuid

from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.channels import service as channels
from app.modules.messages import service as messages
from app.modules.messages.models import Message
from app.modules.search import repository as repo
from app.modules.search.schemas import SearchHit, SearchOut, SearchQuery
from app.modules.users.models import User

log = logging.getLogger("app.search")


async def search(db: AsyncSession, actor: User, params: SearchQuery) -> SearchOut:
    if params.channel_id is not None:
        await channels.require_member(db, actor.id, params.channel_id)
        channel_ids = [params.channel_id]
    else:
        channel_ids = [
            uuid.UUID(str(c.id))
            for c in await channels.list_channels(db, actor, include_public=False)
        ]
    query = params.q.strip()
    try:
        rows, keywords = await _run(db, query, channel_ids, params, escaped=False)
    except DBAPIError as exc:
        # Groonga rejected the syntax (unbalanced quotes / parentheses): search it literally.
        log.info("search query fell back to escaped form: %s", exc.orig)
        await db.rollback()
        rows, keywords = await _run(db, query, channel_ids, params, escaped=True)
    has_more = len(rows) > params.limit
    rows = rows[: params.limit]
    outs = await messages.messages_out(db, [m for m, _ in rows])
    hits = [SearchHit(message=out, score=score) for out, (_, score) in zip(outs, rows, strict=True)]
    return SearchOut(
        hits=hits, keywords=keywords, limit=params.limit, offset=params.offset, has_more=has_more
    )


async def _run(
    db: AsyncSession,
    query: str,
    channel_ids: list[uuid.UUID],
    params: SearchQuery,
    *,
    escaped: bool,
) -> tuple[list[tuple[Message, float]], list[str]]:
    rows = await repo.search_messages(
        db,
        query=query,
        channel_ids=channel_ids,
        from_user_id=params.from_user_id,
        after=params.after,
        before=params.before,
        limit=params.limit + 1,
        offset=params.offset,
        escaped=escaped,
    )
    keywords = await repo.extract_keywords(db, query, escaped=escaped)
    return [(m, s) for m, s in rows], keywords
