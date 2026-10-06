"""Queries of the wiki that several services share (docs/WIKI.md §11)."""

import uuid
from collections.abc import Iterable
from datetime import datetime
from typing import Any

from sqlalchemy import Select, and_, delete, func, insert, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.doctext.revisions import thin_statement
from app.modules.users.models import User
from app.modules.wiki import access
from app.modules.wiki.models import (
    WikiEffectiveGrant,
    WikiGrant,
    WikiLink,
    WikiPage,
    WikiPageRevision,
)


async def next_seq(db: AsyncSession) -> int:
    """A new change-feed number (the caller holds access.lock_tree, so numbers commit in order)."""
    return int((await db.execute(text("SELECT nextval('wiki_change_seq')"))).scalar_one())


async def feed_position(db: AsyncSession) -> int:
    """The highest change-feed number visible now: the live pages', the tombstones' and the
    purged horizon."""
    row = await db.execute(
        text(
            "SELECT greatest("
            "(SELECT coalesce(max(meta_seq), 0) FROM wiki_pages), "
            "(SELECT coalesce(max(seq), 0) FROM wiki_tombstones), "
            "(SELECT coalesce(max(purged_through), 0) FROM wiki_feed_state))"
        )
    )
    return int(row.scalar_one())


async def purged_through(db: AsyncSession) -> int:
    row = await db.execute(text("SELECT coalesce(max(purged_through), 0) FROM wiki_feed_state"))
    return int(row.scalar_one())


async def bump(
    db: AsyncSession, page_ids: Iterable[uuid.UUID], seq: int, *, visibility: bool = False
) -> None:
    """These pages changed in the tree (and, `visibility`, maybe in who sees them) at `seq`."""
    ids = list(dict.fromkeys(page_ids))
    if not ids:
        return
    values: dict[str, Any] = {"meta_seq": seq}
    if visibility:
        values["vis_seq"] = seq
    await db.execute(
        update(WikiPage)
        .where(WikiPage.id.in_(ids))
        .values(**values)
        .execution_options(synchronize_session="fetch")
    )


async def subtree_ids(
    db: AsyncSession, root: uuid.UUID, *, live_only: bool = False
) -> list[uuid.UUID]:
    stmt = select(WikiPage.id).where(or_(WikiPage.id == root, WikiPage.path.contains([root])))
    if live_only:
        stmt = stmt.where(WikiPage.deleted_at.is_(None))
    return list((await db.execute(stmt)).scalars().all())


def my_levels(actor: User) -> Any:
    """(page_id, rank): the pages `actor` reaches, with their level (a subquery)."""
    E = WikiEffectiveGrant
    return (
        select(E.page_id.label("page_id"), func.max(E.level_rank).label("rank"))
        .where(access.principal_clause(actor))
        .group_by(E.page_id)
        .subquery("mine")
    )


def private_flags(actor: User) -> Any:
    """(page_id, private): whether a page's effective access is `actor` alone."""
    E = WikiEffectiveGrant
    alone = func.bool_and(and_(E.principal_type == "user", E.principal_id == actor.id))
    return (
        select(E.page_id.label("page_id"), and_(func.count() == 1, alone).label("private"))
        .group_by(E.page_id)
        .subquery("alone")
    )


def visible_pages(actor: User) -> Select[Any]:
    """(WikiPage, rank, private) for the pages `actor` can read (in the trash too: filter)."""
    mine = my_levels(actor)
    alone = private_flags(actor)
    return (
        select(WikiPage, mine.c.rank, func.coalesce(alone.c.private, False))
        .join(mine, mine.c.page_id == WikiPage.id)
        .outerjoin(alone, alone.c.page_id == WikiPage.id)
    )


async def siblings(
    db: AsyncSession, parent_id: uuid.UUID | None, *, exclude: uuid.UUID | None = None
) -> list[WikiPage]:
    """The live pages under a parent (or top-level), in order."""
    stmt = select(WikiPage).where(
        WikiPage.deleted_at.is_(None),
        WikiPage.parent_id.is_(None) if parent_id is None else WikiPage.parent_id == parent_id,
    )
    if exclude is not None:
        stmt = stmt.where(WikiPage.id != exclude)
    return list((await db.execute(stmt.order_by(WikiPage.position, WikiPage.id))).scalars().all())


async def own_grants(db: AsyncSession, page_id: uuid.UUID) -> list[WikiGrant]:
    stmt = (
        select(WikiGrant)
        .where(WikiGrant.page_id == page_id)
        .order_by(WikiGrant.principal_type, WikiGrant.principal_id)
    )
    return list((await db.execute(stmt)).scalars().all())


async def replace_own_grants(
    db: AsyncSession,
    page_id: uuid.UUID,
    grants: list[tuple[str, uuid.UUID | None, str]],
    actor_id: uuid.UUID,
) -> None:
    await db.execute(delete(WikiGrant).where(WikiGrant.page_id == page_id))
    if grants:
        await db.execute(
            insert(WikiGrant),
            [
                {
                    "id": uuid.uuid4(),
                    "page_id": page_id,
                    "principal_type": ptype,
                    "principal_id": pid,
                    "level": level,
                    "created_by": actor_id,
                }
                for ptype, pid, level in grants
            ],
        )


async def replace_links(db: AsyncSession, src: uuid.UUID, dsts: list[uuid.UUID]) -> None:
    """The page's links, as its body has them now (only to pages that exist)."""
    await db.execute(delete(WikiLink).where(WikiLink.src_page_id == src))
    targets = [d for d in dict.fromkeys(dsts) if d != src]
    if not targets:
        return
    existing = (
        (await db.execute(select(WikiPage.id).where(WikiPage.id.in_(targets)))).scalars().all()
    )
    if existing:
        await db.execute(
            insert(WikiLink), [{"src_page_id": src, "dst_page_id": d} for d in existing]
        )


async def revision_by_save_id(
    db: AsyncSession, author_id: uuid.UUID, client_save_id: uuid.UUID
) -> WikiPageRevision | None:
    stmt = select(WikiPageRevision).where(
        WikiPageRevision.author_id == author_id,
        WikiPageRevision.client_save_id == client_save_id,
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_revision(db: AsyncSession, revision_id: uuid.UUID) -> WikiPageRevision | None:
    return await db.get(WikiPageRevision, revision_id)


async def list_revisions(
    db: AsyncSession,
    page_id: uuid.UUID,
    *,
    before: tuple[datetime, uuid.UUID] | None,
    limit: int,
) -> list[WikiPageRevision]:
    stmt = select(WikiPageRevision).where(
        WikiPageRevision.page_id == page_id, WikiPageRevision.kind != "side"
    )
    if before is not None:
        at, last_id = before
        stmt = stmt.where(
            or_(
                WikiPageRevision.created_at < at,
                and_(WikiPageRevision.created_at == at, WikiPageRevision.id < last_id),
            )
        )
    stmt = stmt.order_by(WikiPageRevision.created_at.desc(), WikiPageRevision.id.desc())
    return list((await db.execute(stmt.limit(limit))).scalars().all())


# --- housekeeping --------------------------------------------------------------------------------

THIN = thin_statement(
    revisions="wiki_page_revisions",
    documents="wiki_pages",
    fk="page_id",
    thinnable=("save", "merge", "props"),
)


async def delete_side_revisions(db: AsyncSession, before: datetime) -> int:
    result = await db.execute(
        delete(WikiPageRevision).where(
            WikiPageRevision.kind == "side", WikiPageRevision.created_at < before
        )
    )
    return int(getattr(result, "rowcount", 0) or 0)


_UNREFERENCED = text(
    """
    SELECT a.id FROM attachments a
    WHERE a.page_id IS NOT NULL AND a.status = 'attached' AND a.attached_at < :bound_before
      AND NOT EXISTS (
          SELECT 1 FROM wiki_pages p WHERE p.id = a.page_id
             AND (strpos(p.body, a.id::text) > 0 OR strpos(p.body, upper(a.id::text)) > 0))
      AND NOT EXISTS (
          SELECT 1 FROM wiki_page_revisions r WHERE r.page_id = a.page_id
             AND (strpos(r.body, a.id::text) > 0 OR strpos(r.body, upper(a.id::text)) > 0))
    ORDER BY a.attached_at
    LIMIT :limit
    """
)


async def unreferenced_files(
    db: AsyncSession, *, bound_before: datetime, limit: int
) -> list[uuid.UUID]:
    rows = await db.execute(_UNREFERENCED, {"bound_before": bound_before, "limit": limit})
    return [row[0] for row in rows.all()]


async def linked_databases(db: AsyncSession, row_id: uuid.UUID) -> set[uuid.UUID]:
    """M123: the databases whose relation cells show this row (its title, or that it is there):
    those linking to it, and (for their reverse cells) those of the rows it links to."""
    rows = await db.execute(
        text(
            "SELECT src_database_id FROM wiki_relations WHERE dst_page_id = :row "
            "UNION SELECT p.parent_id FROM wiki_relations r JOIN wiki_pages p "
            "ON p.id = r.dst_page_id WHERE r.src_page_id = :row AND p.parent_id IS NOT NULL"
        ),
        {"row": row_id},
    )
    return {r[0] for r in rows.all()}


async def purge_props_legacy(db: AsyncSession, before: datetime) -> int:
    """M123: values a type change could not convert, after 30 days."""
    result = await db.execute(
        text("DELETE FROM wiki_props_legacy WHERE created_at < :before"), {"before": before}
    )
    return int(getattr(result, "rowcount", 0) or 0)
