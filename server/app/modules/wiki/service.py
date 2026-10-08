"""Wiki pages (docs/WIKI.md, M120): the tree, the body and its versions, access, the trash.

Every check of who may do what goes through access.py (require_level): a page someone cannot
read is 404 page_not_found everywhere. Changes of the tree's shape or of access take one advisory
lock (access.lock_tree) and rewrite the effective access of the subtree in the same transaction;
each such change takes one number of the change feed (wiki_change_seq) for every page it touched
and writes wiki.changed. Body saves lock the page's row only and follow the canvases' save flow
(app/core/doctext), writing wiki.page.updated to whoever can read the page when it is sent.
"""

import io
import re
import uuid
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import NoReturn
from zoneinfo import ZoneInfo

from sqlalchemy import and_, delete, func, or_, select, text
from sqlalchemy import update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.doctext import body as doc
from app.core.doctext import markers, merge
from app.core.doctext import revisions as doc_revisions
from app.core.doctext import save as doc_save
from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.ids import uuid7
from app.core.roles import PERSON_ROLES, ensure_capability
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.activity import canvas_mentions as mention_text
from app.modules.activity.models import item_read
from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import BlobStore
from app.modules.audit import service as audit
from app.modules.canvases import repository as canvas_templates
from app.modules.canvases import templates as tpl
from app.modules.groups import service as groups
from app.modules.groups.models import UserGroup, UserGroupMember
from app.modules.users import service as users
from app.modules.users.models import User
from app.modules.wiki import access, events, ordering
from app.modules.wiki import dbschema as ds
from app.modules.wiki import repository as repo
from app.modules.wiki.access import LEVELS, Effective, Entry
from app.modules.wiki.models import (
    WikiDatabase,
    WikiEffectiveGrant,
    WikiGrant,
    WikiLink,
    WikiNotice,
    WikiPage,
    WikiPageRevision,
    WikiTombstone,
)
from app.modules.wiki.schemas import (
    MAX_DEPTH,
    AccessChange,
    AccessOut,
    AccessUpdate,
    AdminEffective,
    AdminPageOut,
    ChangesOut,
    Crumb,
    EffectiveOut,
    GrantOut,
    MoveOut,
    PageChange,
    PageConflictDetails,
    PageConflictOut,
    PageContent,
    PageContentSave,
    PageCreate,
    PageItem,
    PageMeta,
    PageMove,
    PageOut,
    PageRef,
    PageRevisionMeta,
    PageRevisionOut,
    PageRevisionPage,
    PageRevisionRestore,
    PageRevisionUpdate,
    PageSaveOut,
    PageUpdate,
    TreeOut,
    WikiBootstrap,
    WikiMentionedData,
    WikiSharedData,
    level_name,
    to_content,
    to_item,
    to_meta,
    to_revision_meta,
    to_revision_out,
)

DEFAULT_TITLE = ""
MAX_BODY_LENGTH = doc.MAX_BODY_LENGTH
MAX_REVISION_PAGE = 100
MAX_MENTIONS = 50
MAX_LOOKUP = 20
# GET /wiki/changes: past this many changed pages the client reads the tree again (reset).
MAX_CHANGES = 5000
PURGE_BATCH = 50
TOMBSTONE_DAYS = 30
_CUSTOM_ICON = re.compile(r"^:[a-z0-9][a-z0-9_+-]{1,31}:$")


def clean_body(body: str) -> str:
    return doc.clean_body(body, max_length=MAX_BODY_LENGTH, code="page_too_large", what="A page")


def _clean_icon(icon: str | None) -> str | None:
    if icon is None:
        return None
    icon = icon.strip()
    if not icon:
        return None
    if icon.startswith(":"):
        if not _CUSTOM_ICON.match(icon):
            raise bad_request("invalid_page_icon", "An icon is one emoji or a :custom: emoji")
        return icon
    if len(icon) > 16 or any(ch.isspace() or ord(ch) < 32 for ch in icon):
        raise bad_request("invalid_page_icon", "An icon is one emoji or a :custom: emoji")
    return icon


def permalink(base_url: str, page_id: uuid.UUID) -> str:
    """`<server>/p/<page_id>` (WIKI.md §9.3), like a canvas's `<server>/c/<id>`."""
    return f"{base_url.rstrip('/')}/p/{page_id}"


def _parse_cursor(cursor: str | None) -> tuple[datetime, uuid.UUID] | None:
    if cursor is None:
        return None
    try:
        raw_at, raw_id = cursor.split("|", 1)
        return datetime.fromisoformat(raw_at), uuid.UUID(raw_id)
    except ValueError as exc:
        raise bad_request("invalid_cursor", "Malformed cursor") from exc


def _require_member(actor: User) -> None:
    """Guests (and bots) do not share pages or make top-level ones (WIKI.md §4.4, §4.8)."""
    if access.only_named(actor):
        raise forbidden("guest_restricted", "Guests cannot do this")


# --- reading -------------------------------------------------------------------------------------


async def _private_of(db: AsyncSession, actor: User, ids: list[uuid.UUID]) -> dict[uuid.UUID, bool]:
    if not ids:
        return {}
    E = WikiEffectiveGrant
    alone = func.bool_and(and_(E.principal_type == "user", E.principal_id == actor.id))
    rows = await db.execute(
        select(E.page_id, and_(func.count() == 1, alone))
        .where(E.page_id.in_(ids))
        .group_by(E.page_id)
    )
    return {row[0]: bool(row[1]) for row in rows.all()}


async def _hidden_parents(
    db: AsyncSession, actor: User, pages: Iterable[WikiPage]
) -> set[uuid.UUID]:
    """The parents of these pages the actor cannot read: such a page shows at the top level for
    them, without its parent's id (WIKI.md §4.6)."""
    parents = {p.parent_id for p in pages if p.parent_id is not None}
    levels = await access.levels_of(db, actor, parents)
    return {pid for pid in parents if levels.get(pid, 0) < 1}


def _items(rows: Iterable[tuple[WikiPage, int, bool]], hidden: set[uuid.UUID]) -> list[PageItem]:
    return [
        to_item(p, int(r), bool(pv), parent_visible=p.parent_id not in hidden) for p, r, pv in rows
    ]


async def _item(db: AsyncSession, actor: User, page: WikiPage, rank: int) -> PageItem:
    private = (await _private_of(db, actor, [page.id])).get(page.id, False)
    hidden = await _hidden_parents(db, actor, [page])
    return to_item(page, rank, private, parent_visible=page.parent_id not in hidden)


async def _content(db: AsyncSession, actor: User, page: WikiPage, rank: int) -> PageContent:
    private = (await _private_of(db, actor, [page.id])).get(page.id, False)
    hidden = await _hidden_parents(db, actor, [page])
    return to_content(page, rank, private, parent_visible=page.parent_id not in hidden)


async def tree(db: AsyncSession, actor: User) -> TreeOut:
    """Every live page the actor can read (not database rows or templates), parents before
    children."""
    cursor = await repo.feed_position(db)
    stmt = repo.visible_pages(actor).where(
        WikiPage.deleted_at.is_(None), WikiPage.kind != "row", WikiPage.is_template.is_(False)
    )
    stmt = stmt.order_by(func.cardinality(WikiPage.path), WikiPage.position, WikiPage.id)
    rows = [(p, int(r), bool(pv)) for p, r, pv in (await db.execute(stmt)).all()]
    hidden = await _hidden_parents(db, actor, [p for p, _, _ in rows])
    return TreeOut(pages=_items(rows, hidden), cursor=cursor)


async def bootstrap(db: AsyncSession) -> WikiBootstrap:
    return WikiBootstrap(change_seq=await repo.feed_position(db))


async def changes(db: AsyncSession, actor: User, since: int) -> ChangesOut:
    """WIKI.md §10. The position is read first: a change that commits while this runs comes
    again next time rather than never."""
    cursor = await repo.feed_position(db)
    if since > cursor or since < await repo.purged_through(db):
        return ChangesOut(pages=[], removed=[], cursor=cursor, reset=True)
    mine = repo.my_levels(actor)
    stmt = (
        select(WikiPage, mine.c.rank)
        .outerjoin(mine, mine.c.page_id == WikiPage.id)
        .where(WikiPage.meta_seq > since, WikiPage.kind != "row")
        .order_by(WikiPage.meta_seq, WikiPage.id)
        .limit(MAX_CHANGES + 1)
    )
    rows = (await db.execute(stmt)).all()
    if len(rows) > MAX_CHANGES:
        return ChangesOut(pages=[], removed=[], cursor=cursor, reset=True)
    readable: list[tuple[WikiPage, int]] = []
    removed: list[uuid.UUID] = []
    for page, rank in rows:
        rank = int(rank or 0)
        if page.deleted_at is None and rank >= 1:
            if page.is_template:
                # M145: templates are not in the tree (GET /wiki/templates); one that was a page
                # until now leaves it.
                removed.append(page.id)
            else:
                readable.append((page, rank))
        elif page.deleted_at is not None:
            # In the trash: only for someone who could read it (the entries stay in the trash).
            if rank >= 1 and page.vis_seq > since:
                removed.append(page.id)
        elif page.vis_seq > since and not (
            page.created_seq > since and page.vis_seq == page.created_seq
        ):
            # Who sees it changed since: perhaps it was mine. An id, never a title.
            removed.append(page.id)
    tomb = await db.execute(select(WikiTombstone.page_id).where(WikiTombstone.seq > since))
    removed.extend(tomb.scalars().all())
    private = await _private_of(db, actor, [p.id for p, _ in readable])
    hidden = await _hidden_parents(db, actor, [p for p, _ in readable])
    return ChangesOut(
        pages=_items([(p, r, private.get(p.id, False)) for p, r in readable], hidden),
        removed=list(dict.fromkeys(removed)),
        cursor=max(cursor, since),
        reset=False,
    )


async def _crumbs(db: AsyncSession, actor: User, page: WikiPage) -> list[Crumb]:
    path = list(page.path or [])
    if not path:
        return []
    rows = {
        p.id: p for p in (await db.execute(select(WikiPage).where(WikiPage.id.in_(path)))).scalars()
    }
    levels = await access.levels_of(db, actor, path)
    out: list[Crumb] = []
    for ancestor_id in path:
        row = rows.get(ancestor_id)
        if row is not None and row.deleted_at is None and levels.get(ancestor_id, 0) >= 1:
            out.append(Crumb(id=row.id, title=row.title, icon=row.icon, readable=True))
        else:
            out.append(Crumb(id=None, title=None, icon=None, readable=False))
    return out


async def _children(db: AsyncSession, actor: User, page_id: uuid.UUID) -> list[PageItem]:
    stmt = (
        repo.visible_pages(actor)
        .where(
            WikiPage.parent_id == page_id,
            WikiPage.deleted_at.is_(None),
            WikiPage.kind != "row",
            WikiPage.is_template.is_(False),
        )
        .order_by(WikiPage.position, WikiPage.id)
    )
    return _items(((p, int(r), bool(pv)) for p, r, pv in (await db.execute(stmt)).all()), set())


async def _page_out(db: AsyncSession, actor: User, page: WikiPage, rank: int) -> PageOut:
    content = await _content(db, actor, page, rank)
    return PageOut(
        **content.model_dump(),
        breadcrumbs=await _crumbs(db, actor, page),
        children=await _children(db, actor, page.id),
    )


async def get_page(db: AsyncSession, actor: User, page_id: uuid.UUID) -> PageOut:
    page, rank = await access.require_level(db, actor, page_id, "view")
    return await _page_out(db, actor, page, rank)


async def load(db: AsyncSession, page_id: uuid.UUID) -> WikiPage | None:
    """The page row, without any check (the push planner checks can_read first)."""
    return await access.load_page(db, page_id)


async def can_read(db: AsyncSession, actor: User, page_id: uuid.UUID) -> bool:
    """For attachments (a page's files): a live page the actor can read."""
    page = await access.load_page(db, page_id)
    if page is None or page.is_deleted:
        return False
    return await access.level_of(db, actor, page_id) >= 1


async def items_for(
    db: AsyncSession, actor: User, pages: list[WikiPage]
) -> dict[uuid.UUID, PageItem]:
    """These pages as the actor sees them (those they cannot read are left out): search hits."""
    ids = [p.id for p in pages]
    levels = await access.levels_of(db, actor, ids)
    readable = [p for p in pages if levels.get(p.id, 0) >= 1]
    private = await _private_of(db, actor, [p.id for p in readable])
    hidden = await _hidden_parents(db, actor, readable)
    return {
        p.id: to_item(
            p, levels[p.id], private.get(p.id, False), parent_visible=p.parent_id not in hidden
        )
        for p in readable
    }


async def find_by_title(db: AsyncSession, actor: User, title: str) -> WikiPage | None:
    """A live page the actor can read with this title (any case): search's in:<title>."""
    stmt = (
        repo.visible_pages(actor)
        .where(
            WikiPage.deleted_at.is_(None),
            WikiPage.is_template.is_(False),
            func.lower(WikiPage.title) == title.lower(),
        )
        .order_by(func.cardinality(WikiPage.path), WikiPage.updated_at.desc())
        .limit(1)
    )
    row = (await db.execute(stmt)).first()
    return row[0] if row is not None else None


async def backlinks(db: AsyncSession, actor: User, page_id: uuid.UUID) -> list[PageItem]:
    """WIKI.md §3.3: the live pages linking here that the actor can read (no other title; not
    templates, M145)."""
    await access.require_level(db, actor, page_id, "view")
    stmt = (
        repo.visible_pages(actor)
        .join(WikiLink, WikiLink.src_page_id == WikiPage.id)
        .where(
            WikiLink.dst_page_id == page_id,
            WikiPage.deleted_at.is_(None),
            WikiPage.is_template.is_(False),
        )
        .order_by(WikiPage.title, WikiPage.id)
    )
    rows = [(p, int(r), bool(pv)) for p, r, pv in (await db.execute(stmt)).all()]
    return _items(rows, await _hidden_parents(db, actor, [p for p, _, _ in rows]))


async def resolve_refs(db: AsyncSession, actor: User, ids: list[uuid.UUID]) -> list[PageRef]:
    """The titles of linked pages the actor can read; the others are left out."""
    wanted = list(dict.fromkeys(ids))
    if not wanted:
        return []
    stmt = (
        repo.visible_pages(actor)
        .where(WikiPage.id.in_(wanted), WikiPage.deleted_at.is_(None))
        .order_by(WikiPage.id)
    )
    return [
        PageRef(id=p.id, title=p.title, icon=p.icon, kind=p.kind)
        for p, _, _ in (await db.execute(stmt)).all()
    ]


def _like(q: str) -> str:
    return q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def lookup(db: AsyncSession, actor: User, q: str, limit: int = MAX_LOOKUP) -> list[PageRef]:
    """The `[[` suggestions (WIKI.md §3.3): readable live pages whose title contains `q`, those
    starting with it first, then the most recently updated."""
    words = " ".join(q.split())
    stmt = repo.visible_pages(actor).where(
        WikiPage.deleted_at.is_(None), WikiPage.kind != "row", WikiPage.is_template.is_(False)
    )
    if words:
        stmt = stmt.where(WikiPage.title.ilike(f"%{_like(words)}%", escape="\\"))
        starts = WikiPage.title.ilike(f"{_like(words)}%", escape="\\")
        stmt = stmt.order_by(starts.desc(), WikiPage.updated_at.desc(), WikiPage.id)
    else:
        stmt = stmt.order_by(WikiPage.updated_at.desc(), WikiPage.id)
    rows = (await db.execute(stmt.limit(limit))).all()
    return [PageRef(id=p.id, title=p.title, icon=p.icon, kind=p.kind) for p, _, _ in rows]


# --- placing pages -------------------------------------------------------------------------------


async def _position(
    db: AsyncSession,
    parent_id: uuid.UUID | None,
    *,
    before_id: uuid.UUID | None,
    after_id: uuid.UUID | None,
    exclude: uuid.UUID | None = None,
) -> str:
    """The fractional key for a page placed among its new siblings (the caller holds the lock)."""
    siblings = await repo.siblings(db, parent_id, exclude=exclude)
    keys = [s.position for s in siblings]
    ids = [s.id for s in siblings]
    neighbour = before_id or after_id
    if neighbour is None:
        return ordering.key_between(keys[-1] if keys else None, None)
    if neighbour not in ids:
        raise bad_request("invalid_page_position", "before_id / after_id is not a sibling here")
    index = ids.index(neighbour)
    if before_id is not None:
        low = keys[index - 1] if index > 0 else None
        high: str | None = keys[index]
    else:
        low = keys[index]
        high = keys[index + 1] if index + 1 < len(keys) else None
    if low is not None and high is not None and not low < high:
        # Two siblings share a key (written at once before the lock, or by hand): place after.
        high = None
    return ordering.key_between(low, high)


async def _require_parent(db: AsyncSession, actor: User, parent_id: uuid.UUID) -> WikiPage:
    parent, _ = await access.require_level(db, actor, parent_id, "edit")
    if parent.kind != "page" or parent.is_template:
        # M145: a template has no subpages (they would not be copied, WIKI.md §22.3).
        raise bad_request("invalid_page_parent", "Pages go under pages (not under a template)")
    return parent


# --- creating ------------------------------------------------------------------------------------


def _revision(
    page: WikiPage,
    actor: User,
    *,
    kind: str,
    body: str,
    parent: uuid.UUID | None,
    parent_body: str,
    version: int | None,
    client_save_id: uuid.UUID | None = None,
) -> WikiPageRevision:
    added, removed = doc.line_changes(parent_body, body)
    return WikiPageRevision(
        id=uuid7(),
        page_id=page.id,
        version=version,
        kind=kind,
        parent_rev_id=parent,
        author_id=actor.id,
        title=page.title,
        body=body,
        client_save_id=client_save_id,
        lines_added=added,
        lines_removed=removed,
    )


async def _existing_create(
    db: AsyncSession, actor: User, client_save_id: uuid.UUID
) -> PageOut | None:
    revision = await repo.revision_by_save_id(db, actor.id, client_save_id)
    if revision is None:
        return None
    if revision.kind != "create":
        raise conflict("idempotency_conflict", "client_save_id was already used for another save")
    return await get_page(db, actor, revision.page_id)


@dataclass(frozen=True)
class FileStore:
    """Where a template's or a duplicated page's files are copied (M145): the app's BlobStore
    and settings (the router hands them over)."""

    blobs: BlobStore
    settings: Settings


def _now_in(tz: str | None) -> datetime:
    return utcnow().astimezone(ZoneInfo(tz or "UTC"))


def template_context(
    actor: User, *, tz: str | None, parent: WikiPage | None, channel: str | None = None
) -> tpl.Context:
    """The placeholders of a Docs template (WIKI.md §22.3): {{date}} / {{week}} / {{time}} in the
    client's zone, {{me}} / {{me_name}}, {{parent}} (and a built-in's {{channel}}: the parent's
    title too)."""
    now = _now_in(tz)
    parent_title = parent.title if parent is not None else ""
    return tpl.Context(
        today=now.date(),
        me_id=actor.id,
        me_name=actor.display_name,
        channel=parent_title if channel is None else channel,
        time=now.strftime("%H:%M"),
        parent=parent_title,
    )


def expand_title(text_: str, ctx: tpl.Context) -> str:
    return " ".join(tpl.expand(text_, ctx, title=True).split())[:200]


def rewrite_files(body: str, copies: dict[uuid.UUID, uuid.UUID]) -> str:
    """The body with each copied file's `attachment:<id>` pointing to the copy."""
    if not copies:
        return body

    def swap(match: re.Match[str]) -> str:
        new = copies.get(uuid.UUID(match.group(1)))
        return f"attachment:{new}" if new is not None else match.group(0)

    return doc.ATTACHMENT_REF.sub(swap, body)


async def copy_files(
    db: AsyncSession,
    files: FileStore | None,
    actor: User,
    *,
    source: WikiPage,
    target: WikiPage,
) -> dict[uuid.UUID, uuid.UUID]:
    """M145: the source's own files its body refers to, copied for the target (already flushed)."""
    refs = doc.attachment_refs(source.body)
    if not refs:
        return {}
    if files is None:
        raise RuntimeError("copying a page's files needs the BlobStore")
    return await attachments.copy_page_files_in_tx(
        db,
        files.blobs,
        files.settings,
        actor.id,
        source_page_id=source.id,
        attachment_ids=refs,
        page_id=target.id,
    )


async def _page_template(db: AsyncSession, actor: User, template_id: uuid.UUID) -> WikiPage:
    """A page template the actor can read (404 template_not_found otherwise, the same for one
    they cannot read)."""
    page = await access.load_page(db, template_id)
    if (
        page is None
        or page.is_deleted
        or not page.is_template
        or page.kind != "page"
        or await access.level_of(db, actor, page.id) < LEVELS["view"]
    ):
        raise not_found("template_not_found", "Template not found")
    return page


@dataclass(frozen=True)
class Resolved:
    """A template's title, body and icon as a new page gets them, and the page template whose
    files the body refers to (None for a built-in one)."""

    title: str
    body: str
    icon: str | None
    source: WikiPage | None


async def resolve_template(
    db: AsyncSession,
    actor: User,
    *,
    template_key: str | None,
    template_page_id: uuid.UUID | None,
    tz: str | None,
    parent: WikiPage | None,
    keep_placeholders: bool,
) -> Resolved | None:
    """A built-in template (`template_key`) or a page template the actor can read, with its
    placeholders put in (unless `keep_placeholders`: a template made from a template, WIKI.md
    §22.3). None when neither is given; 404 template_not_found."""
    source: WikiPage | None = None
    if template_page_id is not None:
        source = await _page_template(db, actor, template_page_id)
        title, body, icon = source.title, source.body, source.icon
    elif template_key is not None:
        template = await canvas_templates.template_by_key(db, template_key)
        if template is None or template.hidden:
            raise not_found("template_not_found", "Template not found")
        title, body, icon = template.title, template.body, None
    else:
        return None
    if not keep_placeholders:
        ctx = template_context(actor, tz=tz, parent=parent)
        title, body = expand_title(title, ctx), tpl.expand(body, ctx, title=False)
    return Resolved(title=title, body=body, icon=icon, source=source)


async def _template(
    db: AsyncSession, actor: User, data: PageCreate, parent: WikiPage | None
) -> tuple[str | None, str | None, str | None, WikiPage | None]:
    """(title, body, icon, the page template whose files to copy): what is given wins."""
    found = await resolve_template(
        db,
        actor,
        template_key=data.template_key,
        template_page_id=data.template_page_id,
        tz=data.tz,
        parent=parent,
        keep_placeholders=data.is_template,
    )
    if found is None:
        return data.title, data.body, data.icon, None
    title = data.title if data.title is not None else found.title
    body = data.body if data.body is not None else found.body
    icon = data.icon if "icon" in data.model_fields_set else found.icon
    return title, body, icon, found.source if data.body is None else None


def _top_grants(
    actor: User, choice: str, *, template: bool
) -> list[tuple[str, uuid.UUID | None, str]]:
    """A new top-level page's own entries (WIKI.md §4.2 / §13): 「共有」 → everyone edits (a
    template: reads, §22.3) and I manage it; 「プライベート」 → me only."""
    grants: list[tuple[str, uuid.UUID | None, str]] = [("user", actor.id, "full")]
    if choice == "workspace":
        grants.insert(0, ("workspace", None, "view" if template else "edit"))
    return grants


async def create(
    db: AsyncSession, actor: User, data: PageCreate, *, files: FileStore | None = None
) -> tuple[PageOut, bool]:
    """(page, created). A retry with the same client_save_id returns the first one."""
    await access.lock_tree(db)
    existing = await _existing_create(db, actor, data.client_save_id)
    if existing is not None:
        return existing, False
    parent: WikiPage | None = None
    if data.parent_id is not None:
        parent = await _require_parent(db, actor, data.parent_id)
        if len(parent.path) + 2 > MAX_DEPTH:
            raise conflict("wiki_too_deep", f"Pages nest at most {MAX_DEPTH} deep")
    else:
        _require_member(actor)
    title, body, icon, source = await _template(db, actor, data, parent)
    title = (title if title is not None else DEFAULT_TITLE)[:200]
    body = clean_body(body or "")
    position = await _position(db, data.parent_id, before_id=data.before_id, after_id=data.after_id)
    seq = await repo.next_seq(db)
    total, done = doc.count_tasks(body)
    revision_id = uuid7()
    page = WikiPage(
        id=uuid7(),
        parent_id=parent.id if parent is not None else None,
        path=[*parent.path, parent.id] if parent is not None else [],
        position=position,
        kind=data.kind,
        title=title,
        icon=_clean_icon(icon),
        body=body,
        version=1,
        head_rev_id=revision_id,
        meta_seq=seq,
        vis_seq=seq,
        created_seq=seq,
        inherit_access=True,
        task_total=total,
        task_done=done,
        is_template=data.is_template,
        created_by=actor.id,
        updated_by=actor.id,
    )
    db.add(page)
    await db.flush()
    if source is not None:
        # M145 (WIKI.md §22.3): the template's images and files, copied in the object store.
        page.body = rewrite_files(
            page.body, await copy_files(db, files, actor, source=source, target=page)
        )
        body = page.body
    if data.kind == "database":
        # M123 (WIKI.md §5.1): the title property and one table view.
        db.add(
            WikiDatabase(page_id=page.id, schema_doc=ds.default_schema(), views=ds.default_views())
        )
    db.add(
        WikiPageRevision(
            id=revision_id,
            page_id=page.id,
            version=1,
            kind="create",
            author_id=actor.id,
            title=title,
            body=body,
            client_save_id=data.client_save_id,
            lines_added=len(body.split("\n")) if body else 0,
        )
    )
    if parent is None:
        await repo.replace_own_grants(
            db, page.id, _top_grants(actor, data.access, template=data.is_template), actor.id
        )
    elif data.kind == "database" and await access.level_of(db, actor, parent.id) < 3:
        # M144 (WIKI.md §22.2): whoever makes a database manages it (deletes and retypes its
        # properties), added on top of what it inherits (nothing narrows, so the rule of the
        # effective table is unchanged). Not when they already have full access from above, so
        # the share dialog does not list them twice; not for pages (§22.2: an own entry outlives
        # a change to guest, §4.4).
        await repo.replace_own_grants(db, page.id, [("user", actor.id, "full")], actor.id)
    await db.flush()
    await access.recompute_subtree(db, page.id)
    await _after_body_change(db, actor, page, before="", revision_id=revision_id, notify=True)
    await events.emit_changed(db, seq)
    rank = await access.level_of(db, actor, page.id)
    out = await _page_out(db, actor, page, rank)
    await db.commit()
    return out, True


# --- the body ------------------------------------------------------------------------------------


async def _after_body_change(
    db: AsyncSession,
    actor: User,
    page: WikiPage,
    *,
    before: str,
    revision_id: uuid.UUID,
    notify: bool,
) -> None:
    """In the transaction of a new head: files bound, links kept, mentions told."""
    refs = doc.attachment_refs(page.body)
    if refs:
        await attachments.bind_to_page_in_tx(db, actor.id, page_id=page.id, attachment_ids=refs)
    await repo.replace_links(db, page.id, doc.page_refs(page.body))
    if notify:
        await _notify_mentions(db, page, actor, before, revision_id)


async def _set_body(
    db: AsyncSession,
    page: WikiPage,
    actor: User,
    body: str,
    *,
    kind: str,
    parent: uuid.UUID,
    client_save_id: uuid.UUID | None,
    change: PageChange,
    notify: bool = True,
) -> WikiPageRevision:
    before = page.body
    revision = _revision(
        page,
        actor,
        kind=kind,
        body=body,
        parent=parent,
        parent_body=page.body,
        version=page.version + 1,
        client_save_id=client_save_id,
    )
    db.add(revision)
    await db.flush()
    _touch(page, actor)
    page.body = body
    page.head_rev_id = revision.id
    page.task_total, page.task_done = doc.count_tasks(body)
    await db.flush()
    await _after_body_change(db, actor, page, before=before, revision_id=revision.id, notify=notify)
    await events.emit_page_updated(db, page, change)
    return revision


async def _rows_changed(db: AsyncSession, row: WikiPage) -> None:
    """M123: a row was added, renamed, trashed or restored: its database's table and the
    relation cells that show it."""
    ids = await repo.linked_databases(db, row.id)
    if row.parent_id is not None:
        ids.add(row.parent_id)
    await events.emit_rows_changed(db, ids)


def _rows_level(page: WikiPage) -> str:
    """Rows go to the trash and back with edit (WIKI.md §4.1: adding and changing rows), pages
    with full."""
    return "edit" if page.kind == "row" else "full"


def _touch(page: WikiPage, actor: User) -> None:
    page.version += 1
    page.updated_by = actor.id
    page.updated_at = utcnow()


async def _conflict_details(
    db: AsyncSession,
    actor: User,
    page: WikiPage,
    rank: int,
    conflicts: tuple[merge.Conflict, ...] = (),
    *,
    timed_out: bool = False,
) -> dict[str, object]:
    details = PageConflictDetails(
        head=await _content(db, actor, page, rank),
        conflicts=[
            PageConflictOut(
                base=c.base,
                ours=c.ours,
                theirs=c.theirs,
                ours_line=c.ours_line,
                theirs_line=c.theirs_line,
            )
            for c in conflicts
        ],
        timed_out=timed_out,
    )
    return details.model_dump(mode="json")


async def save_content(
    db: AsyncSession, actor: User, page_id: uuid.UUID, data: PageContentSave
) -> PageSaveOut:
    """CANVAS.md §4.4 for a page (WIKI.md §7.1): edit level; view changes nothing, not even a
    box."""
    body = clean_body(data.body)
    page, rank = await access.require_level(db, actor, page_id, "view", lock=True)
    done = await repo.revision_by_save_id(db, actor.id, data.client_save_id)
    if done is not None:
        if done.page_id != page.id:
            raise conflict(
                "idempotency_conflict", "client_save_id was already used for another page"
            )
        out = await _content(db, actor, page, rank)
        await db.commit()
        return PageSaveOut(page=out, submitted_rev_id=done.id, merged=done.kind == "side")
    if rank < LEVELS["edit"]:
        raise forbidden("page_edit_restricted", "You can read this page but not change it")
    base = await repo.get_revision(db, data.base_rev_id)
    if base is None or base.page_id != page.id or base.kind == "erased":
        raise conflict(
            "page_base_expired",
            "The version this was written on is gone; compare with the current one",
            await _conflict_details(db, actor, page, rank),
        )

    async def write_head(
        text_: str, kind: str, parent: uuid.UUID, save_id: uuid.UUID | None
    ) -> uuid.UUID:
        revision = await _set_body(
            db,
            page,
            actor,
            text_,
            kind=kind,
            parent=parent,
            client_save_id=save_id,
            change="content",
        )
        return revision.id

    async def write_side(
        text_: str, parent: uuid.UUID, parent_body: str, save_id: uuid.UUID
    ) -> uuid.UUID:
        side = _revision(
            page,
            actor,
            kind="side",
            body=text_,
            parent=parent,
            parent_body=parent_body,
            version=None,
            client_save_id=save_id,
        )
        db.add(side)
        await db.flush()
        return side.id

    async def refuse(conflicts: tuple[merge.Conflict, ...], timed_out: bool) -> NoReturn:
        details = await _conflict_details(db, actor, page, rank, conflicts, timed_out=timed_out)
        await db.rollback()
        raise conflict("page_conflict", "Someone changed the same words", details)

    outcome = await doc_save.save_flow(
        head_body=page.body,
        head_rev_id=page.head_rev_id,
        base_rev_id=base.id,
        base_body=base.body,
        body=body,
        client_save_id=data.client_save_id,
        on_conflict=data.on_conflict,
        write_head=write_head,
        write_side=write_side,
        refuse=refuse,
        clean=clean_body,
    )
    out = await _content(db, actor, page, rank)
    await db.commit()
    return PageSaveOut(
        page=out, submitted_rev_id=outcome.submitted_rev_id, merged=outcome.kind == "merged"
    )


async def update(db: AsyncSession, actor: User, page_id: uuid.UUID, data: PageUpdate) -> PageOut:
    """Title, icon and (M145) whether it is a template (edit)."""
    await access.lock_tree(db)
    page, rank = await access.require_level(db, actor, page_id, "edit", lock=True)
    changed = False
    if data.is_template is not None and data.is_template != page.is_template:
        await _check_template_place(db, page, data.is_template)
        if not data.is_template and page.kind == "row" and page.parent_id is not None:
            await _forget_default(db, page.parent_id, page.id)
        page.is_template = data.is_template
        changed = True
    if data.title is not None and data.title != page.title:
        page.title = data.title
        changed = True
    if "icon" in data.model_fields_set:
        icon = _clean_icon(data.icon)
        if icon != page.icon:
            page.icon = icon
            changed = True
    if changed:
        _touch(page, actor)
        seq = await repo.next_seq(db)
        page.meta_seq = seq
        await db.flush()
        await events.emit_page_updated(db, page, "meta")
        if page.kind == "row":
            # Rows are not in the tree: their database's table (and the cells linking here).
            await _rows_changed(db, page)
        else:
            await events.emit_changed(db, seq)
    out = await _page_out(db, actor, page, rank)
    await db.commit()
    return out


def template_invalid() -> AppError:
    return bad_request(
        "wiki_template_invalid",
        "A template is a top-level page without subpages, or a row of a database",
    )


async def _check_template_place(db: AsyncSession, page: WikiPage, making: bool) -> None:
    """M145 (WIKI.md §22.3): a page template is a top-level page without subpages (they would
    not be copied); a row template stays in its database. A database is never one."""
    if page.kind == "database":
        raise template_invalid()
    if not making or page.kind == "row":
        return
    if page.parent_id is not None:
        raise template_invalid()
    child = await db.scalar(
        select(WikiPage.id)
        .where(WikiPage.parent_id == page.id, WikiPage.deleted_at.is_(None))
        .limit(1)
    )
    if child is not None:
        raise template_invalid()


async def _forget_default(db: AsyncSession, database_id: uuid.UUID, row_id: uuid.UUID) -> None:
    """A row that is no longer a template is no longer the database's default."""
    await db.execute(
        sql_update(WikiDatabase)
        .where(WikiDatabase.page_id == database_id, WikiDatabase.default_template_id == row_id)
        .values(default_template_id=None)
        .execution_options(synchronize_session=False)
    )


# --- mentions and sharing: notices, events (WIKI.md §4.8, §9.3) ---------------------------------


async def _mentioned_people(db: AsyncSession, body: str) -> set[uuid.UUID]:
    user_ids, group_ids = doc.mention_tokens(body)
    if group_ids:
        user_ids |= set(await groups.expand(db, sorted(group_ids)))
    return user_ids


async def _record_notice(
    db: AsyncSession,
    *,
    person: User,
    page: WikiPage,
    kind: str,
    actor: User,
    rev_id: uuid.UUID | None,
    excerpt: str = "",
    level: str | None = None,
    at: datetime,
) -> None:
    """The person's activity item: an unread one of the same kind for the page moves (one per
    page while unread, like canvas mentions), else a new one."""
    unread = await db.scalar(
        select(WikiNotice)
        .where(
            WikiNotice.user_id == person.id,
            WikiNotice.page_id == page.id,
            WikiNotice.kind == kind,
            WikiNotice.at > person.activity_read_at,
            ~item_read(person.id, WikiNotice.id, WikiNotice.at),
        )
        .order_by(WikiNotice.at.desc())
        .limit(1)
    )
    if unread is None:
        db.add(
            WikiNotice(
                user_id=person.id,
                page_id=page.id,
                kind=kind,
                rev_id=rev_id,
                actor_id=actor.id,
                excerpt=excerpt[:200],
                level=level,
                at=at,
            )
        )
    else:
        unread.rev_id, unread.actor_id, unread.at = rev_id, actor.id, at
        unread.excerpt, unread.level = excerpt[:200], level
    await db.flush()


async def _excerpt(
    db: AsyncSession, page: WikiPage, person: User, after_groups: set[uuid.UUID]
) -> str:
    groups_with_person: list[uuid.UUID] = []
    if f"<@{person.id}>" not in page.body:
        for gid in sorted(after_groups):
            if person.id in set(await groups.expand(db, [gid])):
                groups_with_person.append(gid)
    found = mention_text.find_mention(markers.strip(page.body), person.id, groups_with_person)
    if found is None:
        return ""
    line, position = found
    names: dict[uuid.UUID, str] = {}
    if not access.only_named(person):
        # A guest's client names only the people it may see: the excerpt names nobody for them.
        user_ids, group_ids = doc.mention_tokens(line)
        names = {
            uid: u.display_name for uid, u in (await users.get_users(db, sorted(user_ids))).items()
        }
        names.update(await groups.names_for(db, sorted(group_ids)))
    return mention_text.excerpt_around(line, position, names)


async def _notify_mentions(
    db: AsyncSession, page: WikiPage, actor: User, before: str, revision_id: uuid.UUID
) -> None:
    """wiki.mentioned and an activity item to whom this version newly mentions, among those who
    can read the page (WIKI.md §4.7; the actor and bots are left out). Not in a template (M145):
    the mention is told in the page made from it."""
    if page.is_template:
        return
    after_users, after_groups = doc.mention_tokens(page.body)
    before_users, before_groups = doc.mention_tokens(before)
    if after_users <= before_users and after_groups <= before_groups:
        return
    added = await _mentioned_people(db, page.body) - await _mentioned_people(db, before)
    added.discard(actor.id)
    if not added:
        return
    allowed = await events.readers(db, page.id, sorted(added))
    people = await users.get_users(db, allowed)
    now = utcnow()
    for user_id in sorted(people)[:MAX_MENTIONS]:
        person = people[user_id]
        if person.role == "bot":
            continue
        await _record_notice(
            db,
            person=person,
            page=page,
            kind="mention",
            actor=actor,
            rev_id=revision_id,
            excerpt=await _excerpt(db, page, person, after_groups),
            at=now,
        )
        await events.emit_personal(
            db,
            user_id,
            WikiMentionedData(
                page_id=page.id, rev_id=revision_id, title=page.title, by_user_id=actor.id
            ),
        )


async def _notify_shared(
    db: AsyncSession,
    page: WikiPage,
    actor: User,
    before: dict[uuid.UUID, str],
    after: dict[uuid.UUID, str],
) -> None:
    """WIKI.md §4.8: people newly named in the page's own entries (not groups or everyone)."""
    named = [uid for uid in after if uid not in before and uid != actor.id]
    if not named:
        return
    allowed = await events.readers(db, page.id, named)
    people = await users.get_users(db, allowed)
    now = utcnow()
    for user_id in sorted(people):
        person = people[user_id]
        if person.role == "bot":
            continue
        level = after[user_id]
        await _record_notice(
            db,
            person=person,
            page=page,
            kind="shared",
            actor=actor,
            rev_id=None,
            level=level,
            at=now,
        )
        await events.emit_personal(
            db,
            user_id,
            WikiSharedData(
                page_id=page.id,
                title=page.title,
                level=level,  # type: ignore[arg-type]
                by_user_id=actor.id,
            ),
        )


# --- access (WIKI.md §4) -------------------------------------------------------------------------


async def _source_titles(
    db: AsyncSession, actor: User, effective: Effective, page_id: uuid.UUID
) -> dict[uuid.UUID, str]:
    sources = {e.source for e in effective.values() if e.source != page_id}
    if not sources:
        return {}
    levels = await access.levels_of(db, actor, sources)
    readable = [s for s in sources if levels.get(s, 0) >= 1]
    if not readable:
        return {}
    rows = await db.execute(
        select(WikiPage.id, WikiPage.title).where(
            WikiPage.id.in_(readable), WikiPage.deleted_at.is_(None)
        )
    )
    return {row[0]: row[1] for row in rows.all()}


def _sorted_entries(entries: Iterable[Entry]) -> list[Entry]:
    order = {"workspace": 0, "group": 1, "user": 2}
    return sorted(entries, key=lambda e: (order[e.principal_type], str(e.principal_id or "")))


async def get_access(db: AsyncSession, actor: User, page_id: uuid.UUID) -> AccessOut:
    page, rank = await access.require_level(db, actor, page_id, "view")
    return await _access_out(db, actor, page, rank)


async def _access_out(db: AsyncSession, actor: User, page: WikiPage, rank: int) -> AccessOut:
    own = await repo.own_grants(db, page.id)
    effective = (await access.load_effective(db, [page.id]))[page.id]
    titles = await _source_titles(db, actor, effective, page.id)
    return AccessOut(
        page_id=page.id,
        inherit_access=page.inherit_access,
        own=[
            GrantOut(
                principal_type=g.principal_type,  # type: ignore[arg-type]
                principal_id=g.principal_id,
                level=g.level,  # type: ignore[arg-type]
            )
            for g in own
        ],
        effective=[
            EffectiveOut(
                principal_type=e.principal_type,  # type: ignore[arg-type]
                principal_id=e.principal_id,
                level=level_name(e.rank),
                source_page_id=e.source if e.source == page.id or e.source in titles else None,
                inherited=e.source != page.id,
                source_title=titles.get(e.source),
            )
            for e in _sorted_entries(effective.values())
        ],
        my_level=level_name(rank),
    )


async def _active_members(db: AsyncSession) -> set[uuid.UUID]:
    """Active people who can manage a page through an entry: admins and members."""
    rows = await db.execute(
        select(User.id).where(User.deactivated_at.is_(None), User.role.in_(PERSON_ROLES))
    )
    return set(rows.scalars().all())


async def _groups_with_members(db: AsyncSession, group_ids: Iterable[uuid.UUID]) -> set[uuid.UUID]:
    ids = list(dict.fromkeys(group_ids))
    if not ids:
        return set()
    rows = await db.execute(
        select(UserGroupMember.group_id)
        .join(User, User.id == UserGroupMember.user_id)
        .where(
            UserGroupMember.group_id.in_(ids),
            User.deactivated_at.is_(None),
            User.role.in_(PERSON_ROLES),
        )
        .distinct()
    )
    return set(rows.scalars().all())


async def _has_manager(db: AsyncSession, effective: Effective) -> bool:
    """WIKI.md §4.8: someone (not a guest, active) has full access."""
    fulls = [e for e in effective.values() if e.rank >= LEVELS["full"]]
    if any(e.principal_type == "workspace" for e in fulls):
        return True
    members = await _active_members(db)
    if any(e.principal_type == "user" and e.principal_id in members for e in fulls):
        return True
    group_ids = [e.principal_id for e in fulls if e.principal_type == "group" and e.principal_id]
    return bool(await _groups_with_members(db, group_ids))


async def _validate_grants(
    db: AsyncSession, data: AccessUpdate
) -> list[tuple[str, uuid.UUID | None, str]]:
    seen: set[tuple[str, uuid.UUID | None]] = set()
    out: list[tuple[str, uuid.UUID | None, str]] = []
    user_ids: list[uuid.UUID] = []
    group_ids: list[uuid.UUID] = []
    for grant in data.grants:
        key = (grant.principal_type, grant.principal_id)
        if key in seen:
            raise bad_request("duplicate_page_grant", "Each principal appears once")
        seen.add(key)
        out.append((grant.principal_type, grant.principal_id, grant.level))
        if grant.principal_type == "user" and grant.principal_id is not None:
            user_ids.append(grant.principal_id)
        if grant.principal_type == "group" and grant.principal_id is not None:
            group_ids.append(grant.principal_id)
    if user_ids:
        found = await users.get_users(db, user_ids)
        if any(uid not in found or found[uid].deactivated_at is not None for uid in user_ids):
            raise not_found("user_not_found", "User not found")
    if group_ids:
        rows = await db.execute(select(UserGroup.id).where(UserGroup.id.in_(group_ids)))
        if len(set(rows.scalars().all())) != len(set(group_ids)):
            raise not_found("group_not_found", "Group not found")
    return out


def _named(grants: Iterable[tuple[str, uuid.UUID | None, str]]) -> dict[uuid.UUID, str]:
    return {pid: level for ptype, pid, level in grants if ptype == "user" and pid is not None}


def _grant_dump(
    inherit: bool, grants: Iterable[tuple[str, uuid.UUID | None, str]]
) -> dict[str, object]:
    return {
        "inherit_access": inherit,
        "grants": [
            {"principal_type": t, "principal_id": str(p) if p else None, "level": lv}
            for t, p, lv in grants
        ],
    }


def _refuse_row_access(page: WikiPage) -> None:
    if page.kind == "row":
        raise bad_request("wiki_row_access", "A database row takes its database's access")


async def set_access(
    db: AsyncSession, actor: User, page_id: uuid.UUID, data: AccessUpdate
) -> AccessOut:
    """Replace the page's own entries and whether it takes its parent's (full, not a guest).
    Refused (409 page_last_manager) when nobody could manage the page afterwards. Audited."""
    await access.lock_tree(db)
    page, rank = await access.require_level(db, actor, page_id, "full", lock=True)
    _require_member(actor)
    _refuse_row_access(page)
    grants = await _validate_grants(db, data)
    before = [
        (g.principal_type, g.principal_id, g.level) for g in await repo.own_grants(db, page.id)
    ]
    nodes = await access.subtree_nodes(db, page.id)
    nodes[page.id] = access.Node(page.id, page.parent_id, data.inherit_access)
    own = dict(await access.load_own(db, nodes))
    own[page.id] = [(t, p, LEVELS[lv]) for t, p, lv in grants]
    computed = await access.compute_subtree(
        db, page.id, parent_id=page.parent_id, nodes=nodes, own=own
    )
    if not await _has_manager(db, computed[page.id]):
        raise conflict(
            "page_last_manager", "Someone who is not a guest must keep full access to this page"
        )
    inherit_before = page.inherit_access
    await repo.replace_own_grants(db, page.id, grants, actor.id)
    page.inherit_access = data.inherit_access
    _touch(page, actor)
    await db.flush()
    await access.write_effective(db, computed)
    seq = await repo.next_seq(db)
    await repo.bump(db, computed, seq, visibility=True)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="wiki.access_changed",
        target_type="wiki_page",
        target_id=page.id,
        details={
            "before": _grant_dump(inherit_before, before),
            "after": _grant_dump(data.inherit_access, grants),
        },
    )
    await _notify_shared(db, page, actor, _named(before), _named(grants))
    await events.emit_changed(db, seq)
    await db.refresh(page)
    rank = await access.level_of(db, actor, page.id)
    out = await _access_out(db, actor, page, rank) if rank >= 1 else None
    await db.commit()
    if out is None:  # the actor took themselves out (someone else manages it now)
        raise access.page_not_found()
    return out


# --- moving, the trash ---------------------------------------------------------------------------


def _diff(before: Effective, after: Effective) -> list[AccessChange]:
    out: list[AccessChange] = []
    for key in sorted(set(before) | set(after), key=lambda k: (k[0], str(k[1] or ""))):
        old, new = before.get(key), after.get(key)
        old_rank, new_rank = (old.rank if old else 0), (new.rank if new else 0)
        if old_rank != new_rank:
            out.append(
                AccessChange(
                    principal_type=key[0],  # type: ignore[arg-type]
                    principal_id=key[1],
                    before=level_name(old_rank) if old_rank else None,
                    after=level_name(new_rank) if new_rank else None,
                )
            )
    return out


def _as_own(effective: Effective) -> list[tuple[str, uuid.UUID | None, str]]:
    return [
        (e.principal_type, e.principal_id, level_name(e.rank))
        for e in _sorted_entries(effective.values())
    ]


async def _subtree_height(db: AsyncSession, page: WikiPage) -> int:
    deepest = await db.scalar(
        select(func.max(func.cardinality(WikiPage.path))).where(WikiPage.path.contains([page.id]))
    )
    return 0 if deepest is None else int(deepest) - len(page.path)


async def _rewrite_paths(db: AsyncSession, page: WikiPage, prefix: list[uuid.UUID]) -> None:
    """The page and its subtree hang under `prefix` now (descendants keep the rest of theirs)."""
    start = len(page.path) + 1  # the page's own place in its descendants' paths (1-based)
    await db.execute(
        text(
            "UPDATE wiki_pages SET path = CAST(:prefix AS uuid[]) || path[CAST(:start AS int):] "
            "WHERE path @> ARRAY[CAST(:page AS uuid)]"
        ),
        {"prefix": prefix, "start": start, "page": page.id},
    )
    page.path = prefix


async def move(db: AsyncSession, actor: User, page_id: uuid.UUID, data: PageMove) -> MoveOut:
    """WIKI.md §3.2 / §4.5: full on the page and edit on the new parent. A page that takes its
    parent's access gets the new parent's; `keep_access` keeps who sees it now (the entries
    become its own). `dry_run` only says who would gain or lose access."""
    await access.lock_tree(db)
    page, _ = await access.require_level(db, actor, page_id, "full", lock=True)
    if page.kind == "row":
        raise bad_request("invalid_page_parent", "A row stays in its database")
    if page.is_template and data.parent_id is not None:
        raise template_invalid()  # M145: a page template stays at the top level
    parent: WikiPage | None = None
    if data.parent_id is not None:
        if data.parent_id == page.id:
            raise conflict("wiki_move_cycle", "A page cannot go under itself")
        parent = await _require_parent(db, actor, data.parent_id)
        if page.id in parent.path:
            raise conflict("wiki_move_cycle", "A page cannot go under itself")
        if len(parent.path) + 2 + await _subtree_height(db, page) > MAX_DEPTH:
            raise conflict("wiki_too_deep", f"Pages nest at most {MAX_DEPTH} deep")
    else:
        _require_member(actor)
    nodes = await access.subtree_nodes(db, page.id)
    own = dict(await access.load_own(db, nodes))
    current = (await access.load_effective(db, [page.id]))[page.id]
    inherit = page.inherit_access and not data.keep_access
    nodes[page.id] = access.Node(page.id, data.parent_id, inherit)
    if data.keep_access:
        own[page.id] = [(t, p, LEVELS[lv]) for t, p, lv in _as_own(current)]
    computed = await access.compute_subtree(
        db, page.id, parent_id=data.parent_id, nodes=nodes, own=own
    )
    changes = _diff(current, computed[page.id])
    manager_lost = not await _has_manager(db, computed[page.id])
    if data.dry_run:
        await db.rollback()
        return MoveOut(dry_run=True, page=None, changes=changes, manager_lost=manager_lost)
    if manager_lost:
        raise conflict(
            "page_last_manager",
            "Nobody could manage the page there: keep its access (keep_access) instead",
        )
    position = await _position(
        db, data.parent_id, before_id=data.before_id, after_id=data.after_id, exclude=page.id
    )
    from_parent = page.parent_id
    if data.keep_access and page.inherit_access:
        await repo.replace_own_grants(db, page.id, _as_own(current), actor.id)
        page.inherit_access = False
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="wiki.access_changed",
            target_type="wiki_page",
            target_id=page.id,
            details={"keep_access": True, "after": _grant_dump(False, _as_own(current))},
        )
    elif data.keep_access:
        page.inherit_access = False
    await _rewrite_paths(db, page, [*parent.path, parent.id] if parent is not None else [])
    page.parent_id = data.parent_id
    page.position = position
    _touch(page, actor)
    await db.flush()
    await access.write_effective(db, computed)
    seq = await repo.next_seq(db)
    # Below the page nothing changes unless its access did (then the whole subtree's may have).
    await repo.bump(db, computed if changes else [page.id], seq, visibility=bool(changes))
    if from_parent != data.parent_id:
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="wiki.move",
            target_type="wiki_page",
            target_id=page.id,
            details={
                "from": str(from_parent) if from_parent else None,
                "to": str(data.parent_id) if data.parent_id else None,
                "access_changes": len(changes),
            },
        )
    await events.emit_changed(db, seq)
    await db.refresh(page)
    rank = await access.level_of(db, actor, page.id)
    item = await _item(db, actor, page, rank) if rank >= 1 else None
    await db.commit()
    return MoveOut(dry_run=False, page=item, changes=changes, manager_lost=False)


async def trash(db: AsyncSession, actor: User, page_id: uuid.UUID) -> None:
    """The page and everything below it to the trash, together (restored and purged together;
    30 days)."""
    await access.lock_tree(db)
    found = await access.load_page(db, page_id)
    level = _rows_level(found) if found is not None else "full"
    page, _ = await access.require_level(db, actor, page_id, level, lock=True)
    now = utcnow()
    seq = await repo.next_seq(db)
    result = await db.execute(
        sql_update(WikiPage)
        .where(
            or_(WikiPage.id == page.id, WikiPage.path.contains([page.id])),
            WikiPage.deleted_at.is_(None),
        )
        .values(
            deleted_at=now, deleted_by=actor.id, trash_root_id=page.id, meta_seq=seq, vis_seq=seq
        )
        .returning(WikiPage.id)
        .execution_options(synchronize_session=False)
    )
    count = len(result.all())
    await db.refresh(page)
    _touch(page, actor)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="wiki.trash",
        target_type="wiki_page",
        target_id=page.id,
        details={"title": page.title, "pages": count},
    )
    if page.kind == "row":
        await _rows_changed(db, page)
    else:
        await events.emit_changed(db, seq)
    await db.commit()


async def _detach_to_top(db: AsyncSession, page: WikiPage, actor_id: uuid.UUID) -> None:
    """The page goes to the top level keeping who sees it: its effective entries become its own
    and it stops inheriting (a restore whose parent is gone, a purge of its parent)."""
    current = (await access.load_effective(db, [page.id]))[page.id]
    await repo.replace_own_grants(db, page.id, _as_own(current), actor_id)
    page.inherit_access = False
    page.position = await _position(db, None, before_id=None, after_id=None)
    await _rewrite_paths(db, page, [])
    page.parent_id = None
    await db.flush()


async def restore(db: AsyncSession, actor: User, page_id: uuid.UUID) -> PageOut:
    """Back from the trash with what went with it. Under its parent when that is still there
    (taking the parent's access now, if it inherits); else at the top level keeping who sees it
    (WIKI.md §4.5)."""
    await access.lock_tree(db)
    found = await access.load_page(db, page_id)
    level = _rows_level(found) if found is not None else "full"
    page, _ = await access.require_level(db, actor, page_id, level, lock=True, trashed=True)
    if page.trash_root_id != page.id:
        raise conflict("page_trashed_with_parent", "Restore the page it went to the trash with")
    parent = await access.load_page(db, page.parent_id) if page.parent_id else None
    orphan = (parent is None and bool(page.path)) or (parent is not None and parent.is_deleted)
    if orphan:
        await _detach_to_top(db, page, actor.id)
    seq = await repo.next_seq(db)
    await db.execute(
        sql_update(WikiPage)
        .where(WikiPage.trash_root_id == page.id)
        .values(deleted_at=None, deleted_by=None, trash_root_id=None, meta_seq=seq, vis_seq=seq)
        .execution_options(synchronize_session=False)
    )
    await db.flush()
    await access.recompute_subtree(db, page.id)
    await db.refresh(page)
    _touch(page, actor)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="wiki.restore",
        target_type="wiki_page",
        target_id=page.id,
        details={"title": page.title, "to_top_level": orphan},
    )
    await db.flush()
    await events.emit_page_updated(db, page, "restore")
    if page.kind == "row":
        await _rows_changed(db, page)
    else:
        await events.emit_changed(db, seq)
    rank = await access.level_of(db, actor, page.id)
    if rank < 1:
        await db.commit()
        raise access.page_not_found()
    out = await _page_out(db, actor, page, rank)
    await db.commit()
    return out


async def list_trash(db: AsyncSession, actor: User) -> list[PageMeta]:
    """The pages that went to the trash as a subtree's root, where I have full access."""
    mine = repo.my_levels(actor)
    stmt = (
        select(WikiPage)
        .join(mine, mine.c.page_id == WikiPage.id)
        .where(
            WikiPage.deleted_at.is_not(None),
            WikiPage.trash_root_id == WikiPage.id,
            or_(
                mine.c.rank >= LEVELS["full"],
                and_(WikiPage.kind == "row", mine.c.rank >= LEVELS["edit"]),
            ),
        )
        .order_by(WikiPage.deleted_at.desc(), WikiPage.id)
    )
    return [to_meta(p, trashed=True) for p in (await db.execute(stmt)).scalars().all()]


# --- history (CANVAS.md §4.9) --------------------------------------------------------------------


async def _load_revision(
    db: AsyncSession, page: WikiPage, revision_id: uuid.UUID
) -> WikiPageRevision:
    revision = await repo.get_revision(db, revision_id)
    if revision is None or revision.page_id != page.id:
        raise not_found("page_revision_not_found", "Version not found")
    return revision


async def list_revisions(
    db: AsyncSession, actor: User, page_id: uuid.UUID, *, cursor: str | None, limit: int
) -> PageRevisionPage:
    page, _ = await access.require_level(db, actor, page_id, "view")
    limit = min(limit, MAX_REVISION_PAGE)
    rows = await repo.list_revisions(db, page.id, before=_parse_cursor(cursor), limit=limit + 1)
    more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = f"{rows[-1].created_at.isoformat()}|{rows[-1].id}" if more and rows else None
    return PageRevisionPage(items=[to_revision_meta(r) for r in rows], next_cursor=next_cursor)


async def get_revision(
    db: AsyncSession, actor: User, page_id: uuid.UUID, revision_id: uuid.UUID
) -> PageRevisionOut:
    page, _ = await access.require_level(db, actor, page_id, "view")
    return to_revision_out(await _load_revision(db, page, revision_id))


async def restore_revision(
    db: AsyncSession,
    actor: User,
    page_id: uuid.UUID,
    revision_id: uuid.UUID,
    data: PageRevisionRestore,
) -> PageOut:
    page, rank = await access.require_level(db, actor, page_id, "edit", lock=True)
    done = await repo.revision_by_save_id(db, actor.id, data.client_save_id)
    if done is not None:
        if done.page_id != page.id:
            raise conflict(
                "idempotency_conflict", "client_save_id was already used for another page"
            )
        out = await _page_out(db, actor, page, rank)
        await db.commit()
        return out
    revision = await _load_revision(db, page, revision_id)
    if revision.kind == "erased":
        raise conflict("page_revision_erased", "This version was erased")
    if revision.body != page.body:
        await _set_body(
            db,
            page,
            actor,
            revision.body,
            kind="restore",
            parent=page.head_rev_id,
            client_save_id=data.client_save_id,
            change="restore",
            notify=False,
        )
    out = await _page_out(db, actor, page, rank)
    await db.commit()
    return out


async def label_revision(
    db: AsyncSession,
    actor: User,
    page_id: uuid.UUID,
    revision_id: uuid.UUID,
    data: PageRevisionUpdate,
) -> PageRevisionMeta:
    page, _ = await access.require_level(db, actor, page_id, "edit")
    revision = await _load_revision(db, page, revision_id)
    if revision.kind == "side":
        raise not_found("page_revision_not_found", "Version not found")
    label = " ".join((data.label or "").split())
    revision.label = label or None
    await db.flush()
    out = to_revision_meta(revision)
    await db.commit()
    return out


async def erase_revision(
    db: AsyncSession, actor: User, page_id: uuid.UUID, revision_id: uuid.UUID
) -> PageRevisionMeta:
    """Erase a version's body (full access), audited. Not the current version."""
    page, _ = await access.require_level(db, actor, page_id, "full", lock=True)
    revision = await _load_revision(db, page, revision_id)
    if revision.id == page.head_rev_id:
        raise conflict(
            "page_revision_is_head", "The current version cannot be erased; edit the body first"
        )
    if revision.kind != "erased":
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="wiki.revision_erased",
            target_type="wiki_page",
            target_id=page.id,
            details={"revision_id": str(revision.id), "kind": revision.kind},
        )
        revision.kind = "erased"
        revision.body = ""
        await db.flush()
    await db.execute(
        sql_update(WikiNotice)
        .where(WikiNotice.page_id == page.id, WikiNotice.rev_id == revision.id)
        .values(excerpt="")
        .execution_options(synchronize_session=False)
    )
    out = to_revision_meta(revision)
    await db.commit()
    return out


# --- export (WIKI.md §4.7) -----------------------------------------------------------------------


def _markdown(page: WikiPage) -> str:
    title = page.title or "無題"
    return f"# {title}\n\n{markers.strip(page.body)}".rstrip() + "\n"


def _file_name(page: WikiPage) -> str:
    title = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", page.title or "無題").strip() or "無題"
    return f"{title[:80]} {page.id.hex}"


async def export(
    db: AsyncSession, actor: User, page_id: uuid.UUID, *, subtree: bool
) -> tuple[bytes, str, str]:
    """(content, media type, file name): the page as Markdown, or with `subtree` a ZIP of it and
    the pages below it the actor can read (a page under one they cannot read is left out)."""
    page, _ = await access.require_level(db, actor, page_id, "view")
    if not subtree:
        return _markdown(page).encode(), "text/markdown; charset=utf-8", f"{_file_name(page)}.md"
    stmt = repo.visible_pages(actor).where(
        WikiPage.path.contains([page.id]), WikiPage.deleted_at.is_(None), WikiPage.kind != "row"
    )
    below = {p.id: p for p, _, _ in (await db.execute(stmt)).all()}
    folders: dict[uuid.UUID, str] = {page.id: _file_name(page)}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(f"{folders[page.id]}.md", _markdown(page))
        for child in sorted(below.values(), key=lambda p: (len(p.path), p.position, p.id)):
            parent_folder = folders.get(child.parent_id) if child.parent_id else None
            if parent_folder is None:
                continue  # under a page the actor cannot read
            folders[child.id] = f"{parent_folder}/{_file_name(child)}"
            archive.writestr(f"{folders[child.id]}.md", _markdown(child))
    return buffer.getvalue(), "application/zip", f"{_file_name(page)}.zip"


# --- administrators (WIKI.md §4.3) ---------------------------------------------------------------


def _require_admin(actor: User) -> None:
    """The Docs administration (titles of every page, takeover, purge): docs.admin, which only
    administrators have (docs/ROLES.md §4.4)."""
    ensure_capability(actor, "docs.admin")


async def admin_list(db: AsyncSession, actor: User) -> list[AdminPageOut]:
    """Every page's title and who has access (never bodies), for taking pages over."""
    _require_admin(actor)
    pages = list(
        (
            await db.execute(
                select(WikiPage)
                .where(WikiPage.kind != "row")
                .order_by(func.cardinality(WikiPage.path), WikiPage.position, WikiPage.id)
            )
        ).scalars()
    )
    effective = await access.load_effective(db, [p.id for p in pages])
    members = await _active_members(db)
    group_ids = {
        e.principal_id
        for entries in effective.values()
        for e in entries.values()
        if e.principal_type == "group" and e.principal_id is not None
    }
    staffed = await _groups_with_members(db, group_ids)
    out: list[AdminPageOut] = []
    for page in pages:
        entries = effective.get(page.id, {})
        fulls = [e for e in entries.values() if e.rank >= LEVELS["full"]]
        has_manager = any(
            e.principal_type == "workspace"
            or (e.principal_type == "user" and e.principal_id in members)
            or (e.principal_type == "group" and e.principal_id in staffed)
            for e in fulls
        )
        out.append(
            AdminPageOut(
                id=page.id,
                parent_id=page.parent_id,
                kind=page.kind,  # type: ignore[arg-type]
                title=page.title,
                icon=page.icon,
                inherit_access=page.inherit_access,
                effective=[
                    AdminEffective(
                        principal_type=e.principal_type,  # type: ignore[arg-type]
                        principal_id=e.principal_id,
                        level=level_name(e.rank),
                    )
                    for e in _sorted_entries(entries.values())
                ],
                has_manager=has_manager,
                updated_at=page.updated_at,
                deleted_at=page.deleted_at,
            )
        )
    return out


async def takeover(db: AsyncSession, actor: User, page_id: uuid.UUID) -> PageOut | None:
    """The administrator gets full access to the page (an own entry; it keeps inheriting),
    always audited as wiki.access_takeover. Returns the page (None when it is in the trash)."""
    _require_admin(actor)
    await access.lock_tree(db)
    page = await access.load_page(db, page_id, lock=True)
    if page is None:
        raise access.page_not_found()
    _refuse_row_access(page)
    before = [
        (g.principal_type, g.principal_id, g.level) for g in await repo.own_grants(db, page.id)
    ]
    after = [g for g in before if not (g[0] == "user" and g[1] == actor.id)]
    after.append(("user", actor.id, "full"))
    await repo.replace_own_grants(db, page.id, after, actor.id)
    await db.flush()
    computed = await access.recompute_subtree(db, page.id)
    seq = await repo.next_seq(db)
    await repo.bump(db, computed, seq, visibility=True)
    _touch(page, actor)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="wiki.access_takeover",
        target_type="wiki_page",
        target_id=page.id,
        details={
            "title": page.title,
            "before": _grant_dump(page.inherit_access, before),
            "after": _grant_dump(page.inherit_access, after),
        },
    )
    await events.emit_changed(db, seq)
    await db.flush()
    await db.refresh(page)
    out = None if page.is_deleted else await _page_out(db, actor, page, LEVELS["full"])
    await db.commit()
    return out


async def admin_purge(db: AsyncSession, actor: User, page_id: uuid.UUID) -> None:
    """Empty a page (and what went with it) from the trash now, audited (wiki.purge)."""
    _require_admin(actor)
    await access.lock_tree(db)
    page = await access.load_page(db, page_id, lock=True)
    if page is None or not page.is_deleted or page.trash_root_id != page.id:
        raise access.page_not_found()
    await _purge_group(db, page, actor_id=actor.id)
    await db.commit()


async def remove_user_grants_in_tx(db: AsyncSession, user_id: uuid.UUID) -> int:
    """An anonymised user's own entries go (WIKI.md §4.5); the subtrees are computed again."""
    rows = await db.execute(
        select(WikiGrant.page_id).where(
            WikiGrant.principal_type == "user", WikiGrant.principal_id == user_id
        )
    )
    page_ids = list(dict.fromkeys(rows.scalars().all()))
    if not page_ids:
        return 0
    await access.lock_tree(db)
    await db.execute(
        delete(WikiGrant).where(
            WikiGrant.principal_type == "user", WikiGrant.principal_id == user_id
        )
    )
    seq = await repo.next_seq(db)
    for page_id in page_ids:
        computed = await access.recompute_subtree(db, page_id)
        await repo.bump(db, computed, seq, visibility=True)
    await events.emit_changed(db, seq)
    return len(page_ids)


# --- housekeeping (the hourly purge loop) --------------------------------------------------------


async def _purge_group(db: AsyncSession, root: WikiPage, *, actor_id: uuid.UUID | None) -> int:
    """The trash root and what went with it, for good: versions, grants, links, notices with
    them; files marked deleted; tombstones for the change feed (the caller holds the lock)."""
    ids = list(
        (
            await db.execute(
                select(WikiPage.id).where(
                    WikiPage.trash_root_id == root.id, WikiPage.deleted_at.is_not(None)
                )
            )
        ).scalars()
    )
    if not ids:
        return 0
    await audit.record_in_tx(
        db,
        actor_id=actor_id,
        action="wiki.purge",
        target_type="wiki_page",
        target_id=root.id,
        details={
            "title": root.title,
            "pages": len(ids),
            "deleted_at": root.deleted_at.isoformat() if root.deleted_at else None,
            "deleted_by": str(root.deleted_by) if root.deleted_by else None,
        },
    )
    # Pages below that went to the trash on their own before (another group) stay there, at the
    # top level and keeping who sees them, so the tree and its access stay whole.
    orphans = list(
        (
            await db.execute(
                select(WikiPage).where(WikiPage.parent_id.in_(ids), WikiPage.id.not_in(ids))
            )
        ).scalars()
    )
    for orphan in orphans:
        await _detach_to_top(db, orphan, root.deleted_by or root.created_by)
    for orphan in orphans:
        await access.recompute_subtree(db, orphan.id)
    await attachments.mark_pages_deleted_in_tx(db, ids)
    seq = await repo.next_seq(db)
    now = utcnow()
    await db.execute(
        text(
            "INSERT INTO wiki_tombstones (page_id, seq, purged_at) "
            "SELECT unnest(CAST(:ids AS uuid[])), :seq, :now ON CONFLICT (page_id) DO NOTHING"
        ),
        {"ids": ids, "seq": seq, "now": now},
    )
    await db.execute(delete(WikiPage).where(WikiPage.id.in_(ids)))
    await events.emit_changed(db, seq)
    return len(ids)


async def prune_revisions(db: AsyncSession, *, now: datetime) -> int:
    cutoff = now - doc_revisions.KEEP_ALL_REVISIONS
    removed = await repo.delete_side_revisions(db, cutoff)
    result = await db.execute(
        repo.THIN,
        {
            "before": cutoff,
            "since": cutoff - doc_revisions.THIN_LOOKBACK,
            "bucket": doc_revisions.THIN_BUCKET,
        },
    )
    removed += int(getattr(result, "rowcount", 0) or 0)
    await db.commit()
    return removed


async def purge_trash(db: AsyncSession, *, now: datetime, trash_days: int) -> int:
    purged = 0
    while True:
        roots = list(
            (
                await db.execute(
                    select(WikiPage)
                    .where(
                        WikiPage.deleted_at.is_not(None),
                        WikiPage.trash_root_id == WikiPage.id,
                        WikiPage.deleted_at < now - timedelta(days=trash_days),
                    )
                    .order_by(WikiPage.deleted_at, WikiPage.id)
                    .limit(PURGE_BATCH)
                )
            ).scalars()
        )
        if not roots:
            break
        await access.lock_tree(db)
        for root in roots:
            purged += await _purge_group(db, root, actor_id=None)
        await db.commit()
        db.expunge_all()
        if len(roots) < PURGE_BATCH:
            break
    return purged


async def purge_tombstones(db: AsyncSession, *, now: datetime) -> int:
    """Tombstones older than 30 days go; a change feed older than them resets (purged_through)."""
    cutoff = now - timedelta(days=TOMBSTONE_DAYS)
    newest = await db.scalar(
        select(func.max(WikiTombstone.seq)).where(WikiTombstone.purged_at < cutoff)
    )
    if newest is None:
        return 0
    await db.execute(
        text(
            "INSERT INTO wiki_feed_state (id, purged_through) VALUES (1, :seq) "
            "ON CONFLICT (id) DO UPDATE SET purged_through = "
            "greatest(wiki_feed_state.purged_through, EXCLUDED.purged_through)"
        ),
        {"seq": int(newest)},
    )
    result = await db.execute(delete(WikiTombstone).where(WikiTombstone.seq <= newest))
    await db.commit()
    return int(getattr(result, "rowcount", 0) or 0)


async def release_unreferenced_files(db: AsyncSession, *, now: datetime) -> int:
    released = 0
    while True:
        ids = await repo.unreferenced_files(
            db, bound_before=now - doc_revisions.IMAGE_GRACE, limit=500
        )
        if not ids:
            break
        released += await attachments.mark_ids_deleted_in_tx(db, ids)
        await db.commit()
        if len(ids) < 500:
            break
    return released


async def housekeeping(db: AsyncSession, *, now: datetime, trash_days: int) -> tuple[int, int, int]:
    """(versions pruned, pages purged, files released), each step committed on its own."""
    pruned = await prune_revisions(db, now=now)
    purged = await purge_trash(db, now=now, trash_days=trash_days)
    await purge_tombstones(db, now=now)
    await repo.purge_props_legacy(db, now - timedelta(days=TOMBSTONE_DAYS))
    await db.commit()
    released = await release_unreferenced_files(db, now=now)
    return pruned, purged, released
