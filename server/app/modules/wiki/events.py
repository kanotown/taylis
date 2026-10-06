"""Events of the wiki (docs/WIKI.md §10, SYNC_PROTOCOL.md §17) and the outbox audience `page`.

wiki.changed goes to everyone with only the change feed's number (what changed differs per
person). wiki.page.updated has the audience `page`: the relay resolves it when it sends, from the
effective access at that moment, so someone who can no longer read the page never gets it.
wiki.mentioned and wiki.shared go to one person each and are checked the same way when sent.
"""

import uuid
from collections.abc import Iterable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.envelope import Audience
from app.events.models import OutboxEvent
from app.events.outbox import AudienceResolver, write_outbox
from app.modules.wiki.models import WikiPage
from app.modules.wiki.schemas import (
    PageChange,
    WikiChangedData,
    WikiMentionedData,
    WikiPageUpdatedData,
    WikiSharedData,
    to_meta,
)

WIKI_CHANGED = "wiki.changed"
WIKI_PAGE_UPDATED = "wiki.page.updated"
WIKI_MENTIONED = "wiki.mentioned"
WIKI_SHARED = "wiki.shared"
# Events for one person that name a page: delivered only while they can still read it.
_PERSONAL = (WIKI_MENTIONED, WIKI_SHARED)

__all__ = [
    "WIKI_CHANGED",
    "WIKI_MENTIONED",
    "WIKI_PAGE_UPDATED",
    "WIKI_SHARED",
    "WikiChangedData",
    "WikiMentionedData",
    "WikiPageUpdatedData",
    "WikiSharedData",
]

# The active people who can read a live page now (the SQL of access.principal_clause, for every
# user at once): named users (guests and bots too), and for admins and members the workspace and
# their groups.
_READERS = """
SELECT u.id FROM users u
WHERE u.deactivated_at IS NULL {only}
  AND EXISTS (SELECT 1 FROM wiki_pages p WHERE p.id = :page AND p.deleted_at IS NULL)
  AND EXISTS (
    SELECT 1 FROM wiki_effective_grants e
    WHERE e.page_id = :page AND (
      (e.principal_type = 'user' AND e.principal_id = u.id)
      OR (u.role NOT IN ('guest', 'bot') AND (
            e.principal_type = 'workspace'
            OR (e.principal_type = 'group' AND e.principal_id IN (
                  SELECT m.group_id FROM user_group_members m WHERE m.user_id = u.id))))))
ORDER BY u.id
"""


async def readers(
    db: AsyncSession, page_id: uuid.UUID, among: Iterable[uuid.UUID] | None = None
) -> list[uuid.UUID]:
    """Who can read the page now (of `among`, when given)."""
    params: dict[str, object] = {"page": page_id}
    only = ""
    if among is not None:
        ids = list(dict.fromkeys(among))
        if not ids:
            return []
        only = "AND u.id = ANY(CAST(:ids AS uuid[]))"
        params["ids"] = ids
    rows = await db.execute(text(_READERS.format(only=only)), params)
    return [row[0] for row in rows.all()]


async def emit_changed(db: AsyncSession, seq: int) -> None:
    await write_outbox(
        db,
        event_type=WIKI_CHANGED,
        audience_type="all",
        payload=WikiChangedData(seq=seq).model_dump(mode="json"),
    )


async def emit_page_updated(db: AsyncSession, page: WikiPage, change: PageChange) -> None:
    await write_outbox(
        db,
        event_type=WIKI_PAGE_UPDATED,
        audience_type="page",
        audience_id=page.id,
        payload=WikiPageUpdatedData(
            page=to_meta(page).model_copy(update={"parent_id": None}), change=change
        ).model_dump(mode="json"),
    )


async def emit_personal(
    db: AsyncSession, user_id: uuid.UUID, data: WikiMentionedData | WikiSharedData
) -> None:
    await write_outbox(
        db,
        event_type=WIKI_MENTIONED if isinstance(data, WikiMentionedData) else WIKI_SHARED,
        audience_type="user",
        audience_id=user_id,
        payload=data.model_dump(mode="json"),
    )


async def resolve_page_audience(db: AsyncSession, event: OutboxEvent) -> Audience | None:
    """The audience of a wiki event, or None when it is not one (the caller resolves it)."""
    if event.audience_type == "page" and event.audience_id is not None:
        return Audience(kind="users", ids=tuple(await readers(db, event.audience_id)))
    if (
        event.event_type in _PERSONAL
        and event.audience_type == "user"
        and event.audience_id is not None
    ):
        page_id = uuid.UUID(str(event.payload["page_id"]))
        allowed = await readers(db, page_id, [event.audience_id])
        return Audience(kind="users", ids=tuple(allowed))
    return None


def audience_resolver(fallback: AudienceResolver) -> AudienceResolver:
    """The relay's resolver: wiki events here, everything else as before (channels)."""

    async def resolve(db: AsyncSession, event: OutboxEvent) -> Audience:
        audience = await resolve_page_audience(db, event)
        if audience is not None:
            return audience
        return await fallback(db, event)

    return resolve
