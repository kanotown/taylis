"""Templates and copies of pages (docs/WIKI.md §22.3, M145).

A template is a page itself (`wiki_pages.is_template`): a page template is a top-level page kept
out of the tree, search and backlinks (GET /wiki/templates lists the ones someone can read); a row
template is a row of a database kept out of its query (GET /wiki/databases/{id} `templates`).
Making a page from one (POST /wiki/pages `template_page_id`, POST …/rows `template_id`) is in
service.create / databases.create_row; this module lists them and duplicates pages and rows
(「複製」 and 「テンプレートとして保存」), which needs both.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.doctext import body as doc
from app.core.errors import bad_request, conflict, forbidden
from app.core.ids import uuid7
from app.modules.canvases import repository as canvas_templates
from app.modules.canvases.schemas import to_template_out
from app.modules.users.models import User
from app.modules.wiki import access, databases, events
from app.modules.wiki import repository as repo
from app.modules.wiki import service as pages
from app.modules.wiki.access import LEVELS
from app.modules.wiki.db_schemas import RowWithRefs
from app.modules.wiki.models import WikiPage, WikiPageRevision
from app.modules.wiki.schemas import (
    MAX_DEPTH,
    PageDuplicate,
    PageOut,
    TemplateApply,
    TemplatesOut,
)

# 「（コピー）」 in the reader's language (the clients may send their own title).
_COPY = {"ja": "{}（コピー）", "en": "{} (copy)", "zh-Hans": "{}（副本）"}


def copy_title(title: str, locale: str) -> str:
    return _COPY.get(locale, _COPY["ja"]).format(title or "")[:200]


async def list_templates(db: AsyncSession, actor: User) -> TemplatesOut:
    """The page templates the actor can read, newest first, and the built-in ones."""
    stmt = (
        repo.visible_pages(actor)
        .where(
            WikiPage.deleted_at.is_(None),
            WikiPage.is_template.is_(True),
            WikiPage.kind == "page",
        )
        .order_by(WikiPage.created_at.desc(), WikiPage.id)
    )
    rows = [(p, int(r), bool(pv)) for p, r, pv in (await db.execute(stmt)).all()]
    builtins = await canvas_templates.list_templates(db, include_hidden=False)
    return TemplatesOut(
        pages=pages._items(rows, set()),
        builtins=[to_template_out(t) for t in builtins],
    )


async def apply_template(
    db: AsyncSession,
    actor: User,
    page_id: uuid.UUID,
    data: TemplateApply,
    *,
    files: pages.FileStore | None,
) -> PageOut:
    """「テンプレートから始める」 (M145): an empty page (edit) takes a template's body with its
    placeholders put in and its files copied, and its title and icon when it has none. A new
    version of kind save; 409 wiki_page_not_empty when the page has a body already."""
    await access.lock_tree(db)
    page, rank = await access.require_level(db, actor, page_id, "edit", lock=True)
    done = await repo.revision_by_save_id(db, actor.id, data.client_save_id)
    if done is not None:
        if done.page_id != page.id:
            raise conflict(
                "idempotency_conflict", "client_save_id was already used for another page"
            )
        out = await pages._page_out(db, actor, page, rank)
        await db.commit()
        return out
    if page.kind != "page":
        raise pages.template_invalid()
    if page.body.strip():
        raise conflict("wiki_page_not_empty", "Only an empty page starts from a template")
    parent = await access.load_page(db, page.parent_id) if page.parent_id else None
    found = await pages.resolve_template(
        db,
        actor,
        template_key=data.template_key,
        template_page_id=data.template_page_id,
        tz=data.tz,
        parent=parent,
        keep_placeholders=page.is_template,
    )
    assert found is not None
    meta = False
    if not page.title.strip() and found.title:
        page.title, meta = found.title, True
    if page.icon is None and found.icon is not None:
        page.icon, meta = found.icon, True
    body = found.body
    if found.source is not None:
        copies = await pages.copy_files(db, files, actor, source=found.source, target=page)
        body = pages.rewrite_files(body, copies)
    await pages._set_body(
        db,
        page,
        actor,
        pages.clean_body(body),
        kind="save",
        parent=page.head_rev_id,
        client_save_id=data.client_save_id,
        change="content",
    )
    if meta:
        page.meta_seq = await repo.next_seq(db)
        await db.flush()
        await events.emit_page_updated(db, page, "meta")
        await events.emit_changed(db, page.meta_seq)
    out = await pages._page_out(db, actor, page, rank)
    await db.commit()
    return out


async def duplicate(
    db: AsyncSession,
    actor: User,
    page_id: uuid.UUID,
    data: PageDuplicate,
    *,
    files: pages.FileStore | None,
    locale: str,
) -> tuple[PageOut, RowWithRefs | None, bool]:
    """(the copy as a page, the copy as a row for a row, created). A retry with the same
    client_save_id returns the first copy.

    - who: read the original; edit where the copy goes (a row: its database); a page template
      is made by someone who is not a guest (WIKI.md §22.3: anyone may make templates);
    - where: beside the original (after it, under the same parent) unless `parent_id` is given;
      a page template at the top level; a row in its database;
    - what: the title (「（コピー）」 for a copy of the same kind), the icon, the body with its
      placeholders as they are, the files (copied in the object store), a row's values; not the
      subpages, not the versions;
    - access: under a page, that page's (inherited); at the top level `access` (left out: private
      when only the actor can read the original, else workspace)."""
    await access.lock_tree(db)
    done = await repo.revision_by_save_id(db, actor.id, data.client_save_id)
    if done is not None:
        if done.kind != "create":
            raise conflict(
                "idempotency_conflict", "client_save_id was already used for another save"
            )
        out = await pages.get_page(db, actor, done.page_id)
        row = await databases.get_row(db, actor, out.id) if out.kind == "row" else None
        return out, RowWithRefs(row=row.row, refs=row.refs) if row else None, False
    source, _ = await access.require_level(db, actor, page_id, "view")
    if source.kind == "database":
        raise bad_request("wiki_cannot_duplicate", "A database cannot be duplicated yet")
    as_template = source.is_template if data.as_template is None else data.as_template
    title = data.title
    if title is None:
        same_kind = as_template == source.is_template
        title = copy_title(source.title, locale) if same_kind else source.title
    if source.kind == "row":
        if "parent_id" in data.model_fields_set and data.parent_id != source.parent_id:
            raise bad_request("invalid_page_parent", "A row stays in its database")
        out_row = await databases.duplicate_row(
            db,
            actor,
            source,
            as_template=as_template,
            title=title,
            client_save_id=data.client_save_id,
            files=files,
        )
        page = await pages.get_page(db, actor, out_row.row.id)
        return page, out_row, True
    return await _duplicate_page(db, actor, source, data, as_template, title, files), None, True


async def _duplicate_page(
    db: AsyncSession,
    actor: User,
    source: WikiPage,
    data: PageDuplicate,
    as_template: bool,
    title: str,
    files: pages.FileStore | None,
) -> PageOut:
    explicit = "parent_id" in data.model_fields_set
    before_id, after_id = data.before_id, data.after_id
    parent: WikiPage | None = None
    if as_template:
        if explicit and data.parent_id is not None:
            raise pages.template_invalid()
        parent_id = None
    elif explicit:
        parent_id = data.parent_id
    else:
        parent_id = None if source.is_template else source.parent_id
        if before_id is None and after_id is None and not source.is_template:
            after_id = source.id
        if parent_id is not None and await access.level_of(db, actor, parent_id) < LEVELS["edit"]:
            # Beside the original is not mine to change: the client asks for another place.
            raise forbidden("page_edit_restricted", "You cannot add a page beside this one")
    if parent_id is not None:
        parent = await pages._require_parent(db, actor, parent_id)
        if len(parent.path) + 2 > MAX_DEPTH:
            raise conflict("wiki_too_deep", f"Pages nest at most {MAX_DEPTH} deep")
    else:
        pages._require_member(actor)
    position = await pages._position(db, parent_id, before_id=before_id, after_id=after_id)
    seq = await repo.next_seq(db)
    revision_id = uuid7()
    total, done = doc.count_tasks(source.body)
    page = WikiPage(
        id=uuid7(),
        parent_id=parent_id,
        path=[*parent.path, parent.id] if parent is not None else [],
        position=position,
        kind="page",
        title=title,
        icon=source.icon,
        body=source.body,
        version=1,
        head_rev_id=revision_id,
        meta_seq=seq,
        vis_seq=seq,
        created_seq=seq,
        inherit_access=True,
        task_total=total,
        task_done=done,
        is_template=as_template,
        created_by=actor.id,
        updated_by=actor.id,
    )
    db.add(page)
    await db.flush()
    copies = await pages.copy_files(db, files, actor, source=source, target=page)
    page.body = pages.rewrite_files(page.body, copies)
    db.add(
        WikiPageRevision(
            id=revision_id,
            page_id=page.id,
            version=1,
            kind="create",
            author_id=actor.id,
            title=title,
            body=page.body,
            client_save_id=data.client_save_id,
            lines_added=len(page.body.split("\n")) if page.body else 0,
        )
    )
    if parent is None:
        choice = data.access
        if choice is None:
            private = (await pages._private_of(db, actor, [source.id])).get(source.id, False)
            choice = "private" if private else "workspace"
        await repo.replace_own_grants(
            db, page.id, pages._top_grants(actor, choice, template=as_template), actor.id
        )
    await db.flush()
    await access.recompute_subtree(db, page.id)
    # The people the original mentions were told then; a copy tells nobody again.
    await pages._after_body_change(
        db, actor, page, before="", revision_id=revision_id, notify=False
    )
    await events.emit_changed(db, seq)
    rank = await access.level_of(db, actor, page.id)
    out = await pages._page_out(db, actor, page, rank)
    await db.commit()
    return out
