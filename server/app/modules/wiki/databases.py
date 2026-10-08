"""Wiki databases (docs/WIKI.md §5, M123): schema and views, rows and their values, relations,
the query (sort, filter, calendar range), CSV.

A database is a page of kind `database`; its rows are pages of kind `row` below it and always take
its access (no own entries), so the database's level is every row's. Rows stay out of the tree
and its change feed; their changes go out as wiki.rows.changed to whoever can read the database.

Relations (§5.7): a link is a wiki_relations row (source row, property, linked row). A two-way
relation has a reverse property on the linked database (`primary: false`, `pair_id` the source
property) that reads the same links from the other end. Whoever reads a cell sees only the
linked rows they can read; the others are one 「アクセスできないページ」 (`hidden_relations`),
never their ids, titles or how many, and writing the cell keeps them.

Locks: a schema or view change takes the tree lock and its databases' rows FOR UPDATE (sorted);
a row's values are written under FOR SHARE on its database (and the linked databases, sorted) and
the row's own FOR UPDATE, so a type change never meets a write of the old type.
"""

import copy
import csv
import io
import json
import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, insert, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.doctext import body as doc_body
from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.ids import uuid7
from app.core.time import utcnow
from app.modules.audit import service as audit
from app.modules.canvases import templates as tpl
from app.modules.users.models import User
from app.modules.wiki import access, events, ordering
from app.modules.wiki import dbschema as ds
from app.modules.wiki import repository as repo
from app.modules.wiki import service as pages
from app.modules.wiki.db_schemas import (
    DatabaseLimits,
    DatabaseOut,
    DefaultTemplateIn,
    PropertyOut,
    ReferencedBy,
    RelationIn,
    RelationOut,
    RowCreate,
    RowDetailOut,
    RowOut,
    RowPropsUpdate,
    RowQuery,
    RowQueryOut,
    RowRef,
    RowWithRefs,
    SchemaChange,
    SelectOption,
    TemplateRef,
    ViewIn,
    ViewOut,
)
from app.modules.wiki.models import WikiDatabase, WikiPage, WikiPageRevision, WikiPropLegacy
from app.modules.wiki.schemas import level_name

MAX_CANDIDATES = 50

LIMITS = DatabaseLimits(
    rows=ds.MAX_ROWS, properties=ds.MAX_PROPERTIES, options=ds.MAX_OPTIONS, views=ds.MAX_VIEWS
)

# CSV (WIKI.md §5.6): the words a header or a cell needs in the reader's language.
_CSV_WORDS = {
    "ja": {"title": "名前", "hidden": "アクセスできないページ"},
    "en": {"title": "Name", "hidden": "No access"},
    "zh-Hans": {"title": "名称", "hidden": "无法访问的页面"},
}


def invalid_value(message: str) -> AppError:
    return AppError(422, "wiki_invalid_property_value", message)


def invalid_view(message: str) -> AppError:
    return bad_request("wiki_invalid_view", message)


# --- loading -------------------------------------------------------------------------------------


async def _record(db: AsyncSession, page_id: uuid.UUID) -> WikiDatabase:
    record = await db.get(WikiDatabase, page_id)
    if record is None:
        raise access.page_not_found()
    return record


async def _lock_records(
    db: AsyncSession, ids: Iterable[uuid.UUID], *, share: bool
) -> dict[uuid.UUID, WikiDatabase]:
    """The databases' records, locked in id order (FOR SHARE for a row's values, FOR UPDATE for
    the schema), read again after the lock."""
    wanted = sorted(set(ids))
    if not wanted:
        return {}
    stmt = (
        select(WikiDatabase)
        .where(WikiDatabase.page_id.in_(wanted))
        .order_by(WikiDatabase.page_id)
        .execution_options(populate_existing=True)
    )
    stmt = stmt.with_for_update(read=share)
    return {r.page_id: r for r in (await db.execute(stmt)).scalars().all()}


async def _load_database(
    db: AsyncSession, actor: User, database_id: uuid.UUID, level: str
) -> tuple[WikiPage, WikiDatabase, int]:
    page, rank = await access.require_level(db, actor, database_id, level)
    if page.kind != "database":
        raise access.page_not_found()
    return page, await _record(db, page.id), rank


async def _load_row(
    db: AsyncSession, actor: User, row_id: uuid.UUID, level: str
) -> tuple[WikiPage, int]:
    row, rank = await access.require_level(db, actor, row_id, level)
    if row.kind != "row" or row.parent_id is None:
        raise access.page_not_found()
    return row, rank


async def _names(db: AsyncSession) -> dict[str, str]:
    rows = await db.execute(select(User.id, User.display_name))
    return {str(uid): name for uid, name in rows.all()}


async def _people(db: AsyncSession) -> tuple[set[str], dict[str, str]]:
    """Ids a person cell may name (people, deactivated ones too: their names still show), and
    active people's names → ids for conversions."""
    rows = await db.execute(
        select(User.id, User.display_name, User.username, User.deactivated_at).where(
            User.role != "bot"
        )
    )
    known: set[str] = set()
    by_name: dict[str, str] = {}
    for uid, display, username, gone in rows.all():
        known.add(str(uid))
        for name in (display, username):
            if name and gone is None:
                by_name.setdefault(name.casefold(), str(uid))
    return known, by_name


_ROW_COLUMNS = (
    WikiPage.id,
    WikiPage.title,
    WikiPage.icon,
    WikiPage.props,
    WikiPage.position,
    WikiPage.version,
    WikiPage.head_rev_id,
    WikiPage.created_at,
    WikiPage.created_by,
    WikiPage.updated_at,
    WikiPage.updated_by,
)


async def _rows(
    db: AsyncSession, database_id: uuid.UUID, *, trashed_too: bool = False
) -> list[ds.Row]:
    """The database's rows in their own order (no bodies). `trashed_too`: every row there is,
    in the trash and (M145) the row templates too (a schema change rewrites them all); else the
    live rows only (a template is not a row of the table, the calendar or the CSV)."""
    stmt = select(*_ROW_COLUMNS).where(WikiPage.parent_id == database_id, WikiPage.kind == "row")
    if not trashed_too:
        stmt = stmt.where(WikiPage.deleted_at.is_(None), WikiPage.is_template.is_(False))
    stmt = stmt.order_by(WikiPage.position, WikiPage.id)
    return [ds.Row(*r) for r in (await db.execute(stmt)).all()]


async def _row_count(
    db: AsyncSession, database_id: uuid.UUID, *, templates_too: bool = False
) -> int:
    stmt = select(func.count()).where(
        WikiPage.parent_id == database_id, WikiPage.kind == "row", WikiPage.deleted_at.is_(None)
    )
    if not templates_too:
        stmt = stmt.where(WikiPage.is_template.is_(False))
    return int((await db.execute(stmt)).scalar_one())


async def _templates(
    db: AsyncSession, record: WikiDatabase
) -> tuple[list[TemplateRef], uuid.UUID | None]:
    """M145: the database's live row templates (oldest first) and its default among them."""
    rows = await db.execute(
        select(WikiPage.id, WikiPage.title, WikiPage.icon)
        .where(
            WikiPage.parent_id == record.page_id,
            WikiPage.kind == "row",
            WikiPage.is_template.is_(True),
            WikiPage.deleted_at.is_(None),
        )
        .order_by(WikiPage.created_at, WikiPage.id)
    )
    refs = [TemplateRef(id=i, title=t, icon=c) for i, t, c in rows.all()]
    default = record.default_template_id
    if default is not None and all(r.id != default for r in refs):
        default = None  # in the trash (or no longer a template)
    return refs, default


def _storage(database_id: uuid.UUID, prop: Mapping[str, Any]) -> tuple[uuid.UUID, str, bool] | None:
    """Where a relation property's links are kept: (source database, property, forward). A
    reverse property reads its pair's links from the other end."""
    cfg = prop.get("relation") or {}
    if cfg.get("primary", True):
        return database_id, prop["id"], True
    if not cfg.get("database_id") or not cfg.get("pair_id"):
        return None
    return uuid.UUID(str(cfg["database_id"])), str(cfg["pair_id"]), False


# --- relation cells ------------------------------------------------------------------------------


class Cells:
    """Relation cells as one person reads them."""

    def __init__(self) -> None:
        self.links: dict[str, dict[uuid.UUID, list[uuid.UUID]]] = defaultdict(dict)
        self.hidden: dict[str, set[uuid.UUID]] = defaultdict(set)
        self.refs: dict[uuid.UUID, RowRef] = {}

    def ctx(self, names: Mapping[str, str], actor: User) -> ds.Ctx:
        return ds.Ctx(
            names=names,
            actor_id=str(actor.id),
            relations=self.links,
            hidden=self.hidden,
            titles={k: v.title for k, v in self.refs.items()},
        )


async def _raw_links(
    db: AsyncSession,
    database_id: uuid.UUID,
    prop: Mapping[str, Any],
    row_ids: Sequence[uuid.UUID],
) -> dict[uuid.UUID, list[uuid.UUID]]:
    """Every link of the property for these rows (readable or not), in the cell's order."""
    where = _storage(database_id, prop)
    if where is None or not row_ids:
        return {}
    source_db, prop_id, forward = where
    if forward:
        sql = (
            "SELECT src_page_id, dst_page_id FROM wiki_relations "
            "WHERE src_database_id = :db AND prop_id = :prop "
            "AND src_page_id = ANY(CAST(:rows AS uuid[])) ORDER BY position, seq"
        )
    else:
        sql = (
            "SELECT dst_page_id, src_page_id FROM wiki_relations "
            "WHERE src_database_id = :db AND prop_id = :prop "
            "AND dst_page_id = ANY(CAST(:rows AS uuid[])) ORDER BY seq"
        )
    found: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    rows = await db.execute(text(sql), {"db": source_db, "prop": prop_id, "rows": list(row_ids)})
    for row_id, target in rows.all():
        found[row_id].append(target)
    return found


async def _visibility(
    db: AsyncSession, actor: User, targets: Iterable[uuid.UUID]
) -> tuple[dict[uuid.UUID, RowRef], set[uuid.UUID]]:
    """(the live rows the actor can read, as refs; the live rows they cannot). Rows in the
    trash and (M145) row templates are neither (they are not shown at all, nor linked to)."""
    ids = list(dict.fromkeys(targets))
    if not ids:
        return {}, set()
    rows = (
        await db.execute(
            select(WikiPage.id, WikiPage.parent_id, WikiPage.title, WikiPage.icon).where(
                WikiPage.id.in_(ids),
                WikiPage.kind == "row",
                WikiPage.deleted_at.is_(None),
                WikiPage.is_template.is_(False),
            )
        )
    ).all()
    levels = await access.levels_of(db, actor, [r[0] for r in rows])
    readable: dict[uuid.UUID, RowRef] = {}
    unreadable: set[uuid.UUID] = set()
    for row_id, parent_id, title, icon in rows:
        if levels.get(row_id, 0) >= 1 and parent_id is not None:
            readable[row_id] = RowRef(id=row_id, database_id=parent_id, title=title, icon=icon)
        else:
            unreadable.add(row_id)
    return readable, unreadable


async def _cells(
    db: AsyncSession,
    actor: User,
    database_id: uuid.UUID,
    schema: Mapping[str, Any],
    row_ids: Sequence[uuid.UUID],
    only: set[str] | None = None,
) -> Cells:
    out = Cells()
    raw: dict[str, dict[uuid.UUID, list[uuid.UUID]]] = {}
    for prop in schema.get("properties", []):
        if prop["type"] == "relation" and (only is None or prop["id"] in only):
            raw[prop["id"]] = await _raw_links(db, database_id, prop, row_ids)
    targets = {t for cells in raw.values() for links in cells.values() for t in links}
    readable, unreadable = await _visibility(db, actor, targets)
    out.refs = readable
    for prop_id, cells in raw.items():
        for row_id, links in cells.items():
            seen = [t for t in links if t in readable]
            if seen:
                out.links[prop_id][row_id] = seen
            if any(t in unreadable for t in links):
                out.hidden[prop_id].add(row_id)
    return out


def _row_out(row: ds.Row, database_id: uuid.UUID, cells: Cells) -> RowOut:
    relations = {
        prop_id: list(links[row.id]) for prop_id, links in cells.links.items() if row.id in links
    }
    hidden = sorted(prop_id for prop_id, rows in cells.hidden.items() if row.id in rows)
    return RowOut(
        id=row.id,
        database_id=database_id,
        title=row.title,
        icon=row.icon,
        position=row.position,
        version=row.version,
        head_rev_id=row.head_rev_id,
        props={k: v for k, v in (row.props or {}).items() if v is not None},
        relations=relations,
        hidden_relations=hidden,
        created_at=row.created_at,
        created_by=row.created_by,
        updated_at=row.updated_at,
        updated_by=row.updated_by,
    )


def _refs_for(rows: Iterable[RowOut], cells: Cells) -> list[RowRef]:
    wanted = {t for r in rows for links in r.relations.values() for t in links}
    return [cells.refs[t] for t in sorted(wanted) if t in cells.refs]


# --- the database --------------------------------------------------------------------------------


def _relation_values(
    record: WikiDatabase,
) -> list[tuple[dict[str, Any], int, uuid.UUID]]:
    """(view, condition index, row id) of every saved relation condition naming a row."""
    props = ds.props_by_id(record.schema_doc)
    found: list[tuple[dict[str, Any], int, uuid.UUID]] = []
    for view in record.views:
        for index, cond in enumerate((view.get("filter") or {}).get("conditions") or []):
            if props.get(cond.get("prop_id"), {}).get("type") != "relation":
                continue
            try:
                found.append((view, index, uuid.UUID(str(cond.get("value")))))
            except ValueError:
                continue
    return found


async def _views_out(db: AsyncSession, actor: User, record: WikiDatabase) -> list[ViewOut]:
    """The saved views as this person reads them (REVIEW-v0.1.43 #2, WIKI.md §5.7): a relation
    condition on a row they cannot read (or one in the trash, or gone) shows the marker
    "restricted:<index>" instead of the row's id. The stored view keeps the id (the condition
    still applies, and a re-save with the marker keeps it: put_view)."""
    values = _relation_values(record)
    readable, _ = await _visibility(db, actor, (row_id for _, _, row_id in values))
    masked: dict[tuple[str, int], str] = {
        (view["id"], index): f"{ds.RESTRICTED}{index}"
        for view, index, row_id in values
        if row_id not in readable
    }
    out: list[ViewOut] = []
    for view in record.views:
        doc = view
        if any(key[0] == view["id"] for key in masked):
            doc = copy.deepcopy(view)
            for index, cond in enumerate(doc["filter"]["conditions"]):
                marker = masked.get((view["id"], index))
                if marker is not None:
                    cond["value"] = marker
        out.append(ViewOut(**doc))
    return out


def _keep_restricted(doc: dict[str, Any], stored: Mapping[str, Any] | None) -> None:
    """A saved view comes back with the markers its saver was shown: each takes the row id of
    the stored view's condition it names (same property), so a re-save by someone who cannot
    read that row keeps the condition as it was. A marker that names nothing is refused."""
    stored_conditions = ((stored or {}).get("filter") or {}).get("conditions") or []
    for cond in (doc.get("filter") or {}).get("conditions") or []:
        value = cond.get("value")
        if not ds.is_restricted(value):
            continue
        index = ds.restricted_index(value)
        if index is None or index >= len(stored_conditions):
            raise invalid_view("A restricted filter value names no saved condition")
        original = stored_conditions[index]
        if original.get("prop_id") != cond.get("prop_id") or ds.is_restricted(
            original.get("value")
        ):
            raise invalid_view("A restricted filter value names no saved condition")
        cond["value"] = original.get("value")


async def _database_out(
    db: AsyncSession, actor: User, record: WikiDatabase, rank: int
) -> DatabaseOut:
    props = record.schema_doc.get("properties", [])
    targets: set[uuid.UUID] = set()
    for prop in props:
        target = (prop.get("relation") or {}).get("database_id")
        if prop["type"] == "relation" and target:
            targets.add(uuid.UUID(str(target)))
    levels = await access.levels_of(db, actor, targets)
    titles: dict[uuid.UUID, str] = {}
    if targets:
        rows = await db.execute(
            select(WikiPage.id, WikiPage.title).where(
                WikiPage.id.in_(targets),
                WikiPage.kind == "database",
                WikiPage.deleted_at.is_(None),
            )
        )
        titles = {pid: title for pid, title in rows.all() if levels.get(pid, 0) >= 1}
    out: list[PropertyOut] = []
    for prop in props:
        relation = None
        if prop["type"] == "relation":
            cfg = prop.get("relation") or {}
            target = uuid.UUID(str(cfg["database_id"])) if cfg.get("database_id") else None
            known = target is not None and target in titles
            relation = RelationOut(
                database_id=target if known else None,
                database_title=titles.get(target) if target is not None else None,
                pair_id=cfg.get("pair_id") if known else None,
                primary=bool(cfg.get("primary", True)),
            )
        out.append(
            PropertyOut(
                id=prop["id"],
                name=prop.get("name", ""),
                type=prop["type"],
                options=[SelectOption(**o) for o in prop.get("options", [])],
                number_format=prop.get("number_format"),
                relation=relation,
            )
        )
    templates, default = await _templates(db, record)
    return DatabaseOut(
        page_id=record.page_id,
        schema_version=record.schema_version,
        properties=out,
        views=await _views_out(db, actor, record),
        my_level=level_name(rank),
        row_count=await _row_count(db, record.page_id),
        limits=LIMITS,
        templates=templates,
        default_template_id=default,
    )


async def get_database(db: AsyncSession, actor: User, database_id: uuid.UUID) -> DatabaseOut:
    _, record, rank = await _load_database(db, actor, database_id, "view")
    return await _database_out(db, actor, record, rank)


# --- the query -----------------------------------------------------------------------------------


def _offset(cursor: str | None) -> int:
    if cursor is None:
        return 0
    try:
        kind, raw = cursor.split(":", 1)
        value = int(raw)
    except ValueError as exc:
        raise bad_request("invalid_cursor", "Malformed cursor") from exc
    if kind != "o" or value < 0:
        raise bad_request("invalid_cursor", "Malformed cursor")
    return value


def _view(record: WikiDatabase, view_id: str | None) -> dict[str, Any] | None:
    if view_id is None:
        return None
    for view in record.views:
        if view["id"] == view_id:
            return view
    raise bad_request("wiki_view_not_found", "No such view")


def _relation_props_in(schema: Mapping[str, Any], group: Mapping[str, Any] | None) -> set[str]:
    props = ds.props_by_id(schema)
    if not group:
        return set()
    return {
        c["prop_id"]
        for c in group.get("conditions", [])
        if props.get(c["prop_id"], {}).get("type") == "relation"
    }


async def _select(
    db: AsyncSession,
    actor: User,
    record: WikiDatabase,
    *,
    sort: Sequence[Mapping[str, Any]],
    group: Mapping[str, Any] | None,
    date_range: Mapping[str, Any] | None,
    names: Mapping[str, str],
) -> list[ds.Row]:
    """The rows that match, in order (WIKI.md §5.4: the server sorts and filters)."""
    schema = record.schema_doc
    rows = await _rows(db, record.page_id)
    needed = _relation_props_in(schema, group)
    cells = (
        await _cells(db, actor, record.page_id, schema, [r.id for r in rows], needed)
        if needed
        else Cells()
    )
    ctx = cells.ctx(names, actor)
    try:
        test = ds.compile_filter(schema, group, ctx)
        if test is not None:
            rows = [r for r in rows if test(r)]
        if date_range is not None:
            prop = ds.props_by_id(schema).get(date_range["prop_id"])
            if prop is None or prop["type"] not in ds.DATEISH:
                raise ds.InvalidView("The range needs a date property")
            first = ds.day_of(date_range["start"])
            last = ds.day_of(date_range["end"])
            span = ds.in_range(prop, first, last)
            rows = [r for r in rows if span(r)]
        return ds.sort_rows(rows, schema, sort, ctx)
    except ds.InvalidView as exc:
        raise invalid_view(str(exc)) from exc


async def query(db: AsyncSession, actor: User, database_id: uuid.UUID, q: RowQuery) -> RowQueryOut:
    _, record, _ = await _load_database(db, actor, database_id, "view")
    view = _view(record, q.view_id)
    sort = (
        [s.model_dump() for s in q.sort]
        if q.sort is not None
        else list((view or {}).get("sort") or [])
    )
    group = q.filter.model_dump(mode="json") if q.filter is not None else (view or {}).get("filter")
    names = await _names(db)
    matched = await _select(
        db,
        actor,
        record,
        sort=sort,
        group=group,
        date_range=q.range.model_dump() if q.range is not None else None,
        names=names,
    )
    start = _offset(q.cursor)
    page = matched[start : start + q.limit]
    cells = await _cells(db, actor, record.page_id, record.schema_doc, [r.id for r in page])
    rows = [_row_out(r, record.page_id, cells) for r in page]
    more = start + q.limit < len(matched)
    return RowQueryOut(
        rows=rows,
        refs=_refs_for(rows, cells),
        total=len(matched),
        next_cursor=f"o:{start + q.limit}" if more else None,
        schema_version=record.schema_version,
    )


async def export_csv(
    db: AsyncSession, actor: User, database_id: uuid.UUID, view_id: str | None, locale: str
) -> tuple[bytes, str]:
    """(UTF-8 CSV with a BOM, file name): the view's rows, columns, sort and filter (all
    properties in schema order without a view). People by name, options by name, dates ISO 8601,
    relations by the titles the reader can read (WIKI.md §5.6)."""
    page, record, _ = await _load_database(db, actor, database_id, "view")
    words = _CSV_WORDS.get(locale, _CSV_WORDS["ja"])
    view = _view(record, view_id) or (record.views[0] if record.views else {})
    names = await _names(db)
    rows = await _select(
        db,
        actor,
        record,
        sort=view.get("sort") or [],
        group=view.get("filter"),
        date_range=None,
        names=names,
    )
    props = record.schema_doc.get("properties", [])
    by_id = {p["id"]: p for p in props}
    columns: list[dict[str, Any]] = []
    listed = set()
    for column in view.get("columns") or []:
        prop = by_id.get(column["prop_id"])
        listed.add(column["prop_id"])
        if prop is not None and not column.get("hidden"):
            columns.append(prop)
    columns.extend(p for p in props if p["id"] not in listed)
    if not any(p["type"] == "title" for p in columns):
        columns.insert(0, by_id[ds.TITLE_ID])
    cells = await _cells(db, actor, record.page_id, record.schema_doc, [r.id for r in rows])
    ctx = cells.ctx(names, actor)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [p.get("name") or (words["title"] if p["type"] == "title" else p["id"]) for p in columns]
    )
    for row in rows:
        line = []
        for prop in columns:
            if prop["type"] == "relation":
                line.append(ds.relation_text(prop["id"], row.id, ctx, words["hidden"]))
            else:
                line.append(ds.value_text(prop, ds.cell_value(prop, row), ctx))
        writer.writerow(line)
    name = pages._file_name(page)
    return ("﻿" + buffer.getvalue()).encode("utf-8"), f"{name}.csv"


async def candidates(
    db: AsyncSession,
    actor: User,
    database_id: uuid.UUID,
    prop_id: str,
    q: str,
    limit: int,
) -> list[RowRef]:
    """Rows a relation cell may link to: live rows of the linked database the actor can read
    (none when they cannot read it), titles containing `q`, those starting with it first."""
    _, record, _ = await _load_database(db, actor, database_id, "view")
    prop = ds.props_by_id(record.schema_doc).get(prop_id)
    if prop is None or prop["type"] != "relation":
        raise invalid_view("Not a relation property")
    target = (prop.get("relation") or {}).get("database_id")
    if not target:
        return []
    target_id = uuid.UUID(str(target))
    stmt = select(WikiPage.id, WikiPage.parent_id, WikiPage.title, WikiPage.icon).where(
        WikiPage.parent_id == target_id,
        WikiPage.kind == "row",
        WikiPage.deleted_at.is_(None),
        WikiPage.is_template.is_(False),
        access.readable_clause(actor, WikiPage.id),
    )
    words = " ".join(q.split())
    if words:
        like = pages._like(words)
        stmt = stmt.where(WikiPage.title.ilike(f"%{like}%", escape="\\")).order_by(
            WikiPage.title.ilike(f"{like}%", escape="\\").desc(),
            WikiPage.updated_at.desc(),
            WikiPage.id,
        )
    else:
        stmt = stmt.order_by(WikiPage.updated_at.desc(), WikiPage.id)
    rows = (await db.execute(stmt.limit(min(limit, MAX_CANDIDATES)))).all()
    return [RowRef(id=i, database_id=target_id, title=t, icon=c) for i, _, t, c in rows]


# --- rows ----------------------------------------------------------------------------------------


def _settable(prop: Mapping[str, Any] | None) -> bool:
    return prop is not None and (prop["type"] in ds.STORED or prop["type"] in ("title", "relation"))


def _relation_targets(schema: Mapping[str, Any], keys: Iterable[str]) -> set[uuid.UUID]:
    props = ds.props_by_id(schema)
    out = set()
    for key in keys:
        cfg = (props.get(key) or {}).get("relation") or {}
        if props.get(key, {}).get("type") == "relation" and cfg.get("database_id"):
            out.add(uuid.UUID(str(cfg["database_id"])))
    return out


async def _check_links(
    db: AsyncSession, actor: User, target_db: uuid.UUID, raw: Any
) -> list[uuid.UUID]:
    """A relation value: live rows of `target_db` the actor can read, in order. Any other id
    (missing, in the trash, elsewhere or unreadable) is the same 422."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > 200:
        raise invalid_value("A relation is a list of up to 200 row ids")
    try:
        ids = list(dict.fromkeys(uuid.UUID(str(v)) for v in raw))
    except ValueError as exc:
        raise invalid_value("Not a row id") from exc
    if not ids:
        return []
    readable, _ = await _visibility(db, actor, ids)
    if any(i not in readable or readable[i].database_id != target_db for i in ids):
        raise invalid_value("Link to rows of the related database that you can read")
    return ids


async def _write_links(
    db: AsyncSession,
    actor: User,
    database_id: uuid.UUID,
    prop: Mapping[str, Any],
    row_id: uuid.UUID,
    wanted: list[uuid.UUID],
) -> tuple[list[str], list[str]]:
    """Set a relation cell to `wanted` (rows the actor can read), keeping the links to rows they
    cannot read. Returns (before, after) as the ids the actor can see, for the version."""
    where = _storage(database_id, prop)
    if where is None:
        raise invalid_value("This relation's other side is gone")
    source_db, prop_id, forward = where
    current = (await _raw_links(db, database_id, prop, [row_id])).get(row_id, [])
    readable, _ = await _visibility(db, actor, current)
    before = [t for t in current if t in readable]
    removed = [t for t in before if t not in wanted]
    added = [t for t in wanted if t not in current]
    if forward:
        if removed:
            await db.execute(
                text(
                    "DELETE FROM wiki_relations WHERE src_page_id = :row AND prop_id = :prop "
                    "AND dst_page_id = ANY(CAST(:ids AS uuid[]))"
                ),
                {"row": row_id, "prop": prop_id, "ids": removed},
            )
        kept_hidden = [t for t in current if t not in readable]
        order = [*wanted, *kept_hidden]
        for target in added:
            await db.execute(
                text(
                    "INSERT INTO wiki_relations (src_page_id, prop_id, dst_page_id, "
                    "src_database_id, position) VALUES (:row, :prop, :dst, :db, 0)"
                ),
                {"row": row_id, "prop": prop_id, "dst": target, "db": source_db},
            )
        if order:
            await db.execute(
                text(
                    "UPDATE wiki_relations r SET position = o.n FROM unnest(CAST(:ids AS uuid[])) "
                    "WITH ORDINALITY AS o(id, n) "
                    "WHERE r.src_page_id = :row AND r.prop_id = :prop AND r.dst_page_id = o.id"
                ),
                {"row": row_id, "prop": prop_id, "ids": order},
            )
    else:
        if removed:
            await db.execute(
                text(
                    "DELETE FROM wiki_relations WHERE dst_page_id = :row AND prop_id = :prop "
                    "AND src_database_id = :db AND src_page_id = ANY(CAST(:ids AS uuid[]))"
                ),
                {"row": row_id, "prop": prop_id, "db": source_db, "ids": removed},
            )
        for source in added:
            await db.execute(
                text(
                    "INSERT INTO wiki_relations (src_page_id, prop_id, dst_page_id, "
                    "src_database_id, position) SELECT :src, CAST(:prop AS varchar), :row, :db, "
                    "coalesce(max(position), 0) + 1 FROM wiki_relations "
                    "WHERE src_page_id = :src AND prop_id = :prop"
                ),
                {"src": source, "prop": prop_id, "row": row_id, "db": source_db},
            )
    return [str(t) for t in before], [str(t) for t in wanted]


async def _apply_values(
    db: AsyncSession,
    actor: User,
    database_id: uuid.UUID,
    schema: Mapping[str, Any],
    row: WikiPage,
    values: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], set[uuid.UUID]]:
    """Validate and write the cells (title, stored values, relations). Returns (before, after)
    of the cells that changed and the other databases whose cells changed (two-way)."""
    props = ds.props_by_id(schema)
    known, _ = await _people(db)
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    touched: set[uuid.UUID] = set()
    stored = dict(row.props or {})
    for key, raw in values.items():
        prop = props.get(key)
        if not _settable(prop):
            raise invalid_value(f"No property {key} to set")
        assert prop is not None
        if prop["type"] == "title":
            if raw is not None and not isinstance(raw, str):
                raise invalid_value("A title is text")
            title = " ".join((raw or "").split())[:200]
            if title != row.title:
                before[key], after[key] = row.title, title
                row.title = title
            continue
        if prop["type"] == "relation":
            target = (prop.get("relation") or {}).get("database_id")
            if not target:
                raise invalid_value("This relation's database is gone")
            target_id = uuid.UUID(str(target))
            ids = await _check_links(db, actor, target_id, raw)
            old, new = await _write_links(db, actor, database_id, prop, row.id, ids)
            if old != new:
                before[key], after[key] = old, new
                if target_id != database_id:
                    touched.add(target_id)
            continue
        # M145: a row template may hold 「今日」 and 「自分」 (put in when a row is made from it).
        normalize = ds.normalize_template_value if row.is_template else ds.normalize_value
        try:
            value = normalize(prop, raw, known_users=known)
        except ds.InvalidValue as exc:
            raise invalid_value(f"{prop.get('name') or key}: {exc}") from exc
        if stored.get(key) != value:
            before[key], after[key] = stored.get(key), value
            if value is None:
                stored.pop(key, None)
            else:
                stored[key] = value
    row.props = stored
    return before, after, touched


async def _props_text(db: AsyncSession, schema: Mapping[str, Any], props: Mapping[str, Any]) -> str:
    return ds.search_text(schema, props, await _names(db))


async def _row_with_refs(
    db: AsyncSession, actor: User, row: WikiPage, schema: Mapping[str, Any]
) -> RowWithRefs:
    assert row.parent_id is not None
    data = _as_row(row)
    cells = await _cells(db, actor, row.parent_id, schema, [row.id])
    out = _row_out(data, row.parent_id, cells)
    return RowWithRefs(row=out, refs=_refs_for([out], cells))


def _as_row(page: WikiPage) -> ds.Row:
    return ds.Row(
        page.id,
        page.title,
        page.icon,
        dict(page.props or {}),
        page.position,
        page.version,
        page.head_rev_id,
        page.created_at,
        page.created_by,
        page.updated_at,
        page.updated_by,
    )


async def _row_template(
    db: AsyncSession, database_id: uuid.UUID, template_id: uuid.UUID
) -> WikiPage | None:
    """A live row template of this database (M145), else None."""
    page = await access.load_page(db, template_id)
    if (
        page is None
        or page.is_deleted
        or not page.is_template
        or page.kind != "row"
        or page.parent_id != database_id
    ):
        return None
    return page


async def _template_values(
    db: AsyncSession,
    actor: User,
    database_id: uuid.UUID,
    schema: Mapping[str, Any],
    source: WikiPage,
    *,
    expand: bool,
    today: Any,
) -> dict[str, Any]:
    """A row's (a template's) cells to start another row with: its stored values (「今日」 and
    「自分」 put in when `expand`) and its relation cells as far as the actor can read them (the
    links they cannot read are not copied: they could not have made them)."""
    values = dict(source.props or {})
    if expand:
        values = ds.expand_dynamic(values, today=today, me=str(actor.id))
    primary = [
        p
        for p in schema.get("properties", [])
        if p["type"] == "relation" and (p.get("relation") or {}).get("primary", True)
    ]
    if primary:
        cells = await _cells(
            db, actor, database_id, schema, [source.id], {p["id"] for p in primary}
        )
        for prop in primary:
            links = cells.links.get(prop["id"], {}).get(source.id)
            if links:
                values[prop["id"]] = [str(t) for t in links]
    return values


async def _insert_row(
    db: AsyncSession,
    actor: User,
    database: WikiPage,
    record: WikiDatabase,
    *,
    title: str,
    icon: str | None,
    body: str,
    values: Mapping[str, Any],
    position: str,
    is_template: bool,
    client_save_id: uuid.UUID,
    files_from: WikiPage | None,
    files: pages.FileStore | None,
    notify: bool,
) -> tuple[WikiPage, set[uuid.UUID]]:
    """A new row (a template when `is_template`) with its first version; `files_from`: whose
    files the body refers to (copied, M145). Returns the row and the other databases whose
    cells changed (two-way relations)."""
    seq = await repo.next_seq(db)
    revision_id = uuid7()
    total, done_tasks = doc_body.count_tasks(body)
    row = WikiPage(
        id=uuid7(),
        parent_id=database.id,
        path=[*database.path, database.id],
        position=position,
        kind="row",
        title=title,
        icon=pages._clean_icon(icon),
        body=body,
        version=1,
        head_rev_id=revision_id,
        meta_seq=seq,
        vis_seq=seq,
        created_seq=seq,
        inherit_access=True,
        props={},
        props_text="",
        task_total=total,
        task_done=done_tasks,
        is_template=is_template,
        created_by=actor.id,
        updated_by=actor.id,
    )
    db.add(row)
    await db.flush()
    if files_from is not None:
        copies = await pages.copy_files(db, files, actor, source=files_from, target=row)
        row.body = pages.rewrite_files(row.body, copies)
    db.add(
        WikiPageRevision(
            id=revision_id,
            page_id=row.id,
            version=1,
            kind="create",
            author_id=actor.id,
            title=row.title,
            body=row.body,
            client_save_id=client_save_id,
            lines_added=len(row.body.split("\n")) if row.body else 0,
        )
    )
    await db.flush()
    await access.recompute_subtree(db, row.id)
    _, _, touched = await _apply_values(db, actor, database.id, record.schema_doc, row, values)
    row.props_text = await _props_text(db, record.schema_doc, row.props or {})
    await db.flush()
    await pages._after_body_change(
        db, actor, row, before="", revision_id=revision_id, notify=notify
    )
    return row, touched


async def _existing_row(
    db: AsyncSession, actor: User, client_save_id: uuid.UUID
) -> RowWithRefs | None:
    done = await repo.revision_by_save_id(db, actor.id, client_save_id)
    if done is None:
        return None
    if done.kind != "create":
        raise conflict("idempotency_conflict", "client_save_id was already used")
    row, _ = await _load_row(db, actor, done.page_id, "view")
    assert row.parent_id is not None
    schema = (await _record(db, row.parent_id)).schema_doc
    return await _row_with_refs(db, actor, row, schema)


async def create_row(
    db: AsyncSession,
    actor: User,
    database_id: uuid.UUID,
    data: RowCreate,
    *,
    files: pages.FileStore | None = None,
) -> tuple[RowWithRefs, bool]:
    """A new row at the end (edit). A retry with the same client_save_id returns the first.
    M145 (WIKI.md §22.3): from `template_id`, else (not `blank`, not a template) from the
    database's default template; the given values win over the template's."""
    await access.lock_tree(db)
    existing = await _existing_row(db, actor, data.client_save_id)
    if existing is not None:
        return existing, False
    page, _, _ = await _load_database(db, actor, database_id, "edit")
    current = await _record(db, page.id)
    template: WikiPage | None = None
    if data.template_id is not None:
        template = await _row_template(db, page.id, data.template_id)
        if template is None:
            raise not_found("template_not_found", "Template not found")
    elif not data.blank and not data.is_template and current.default_template_id is not None:
        template = await _row_template(db, page.id, current.default_template_id)
    now = utcnow().astimezone(ZoneInfo(data.tz or "UTC"))
    values: dict[str, Any] = {}
    title, icon, body = data.title, data.icon, data.body
    expand = not data.is_template
    if template is not None:
        values = await _template_values(
            db, actor, page.id, current.schema_doc, template, expand=expand, today=now.date()
        )
        ctx = pages.template_context(actor, tz=data.tz, parent=page)
        if not title:
            title = pages.expand_title(template.title, ctx) if expand else template.title
        if "icon" not in data.model_fields_set:
            icon = template.icon
        if body is None:
            body = tpl.expand(template.body, ctx, title=False) if expand else template.body
    values.update(data.props)
    targets = _relation_targets(current.schema_doc, values)
    record = (await _lock_records(db, {page.id, *targets}, share=True))[page.id]
    if await _row_count(db, page.id, templates_too=True) >= ds.MAX_ROWS:
        raise conflict("wiki_too_many_rows", f"A database holds at most {ds.MAX_ROWS} rows")
    last = await db.scalar(
        select(func.max(WikiPage.position)).where(
            WikiPage.parent_id == page.id, WikiPage.kind == "row"
        )
    )
    row, touched = await _insert_row(
        db,
        actor,
        page,
        record,
        title=title,
        icon=icon,
        body=pages.clean_body(body or ""),
        values=values,
        position=ordering.key_between(last, None),
        is_template=data.is_template,
        client_save_id=data.client_save_id,
        files_from=template if template is not None and data.body is None else None,
        files=files,
        notify=True,
    )
    await events.emit_rows_changed(db, {page.id, *touched})
    out = await _row_with_refs(db, actor, row, record.schema_doc)
    await db.commit()
    return out, True


async def duplicate_row(
    db: AsyncSession,
    actor: User,
    source: WikiPage,
    *,
    as_template: bool,
    title: str,
    client_save_id: uuid.UUID,
    files: pages.FileStore | None,
) -> RowWithRefs:
    """M145 (WIKI.md §22.3): a copy of a row just after it in its database (edit): title, icon,
    body, files, values and the relation links the actor can read. A row made from a template's
    copy gets 「今日」 and 「自分」 put in; a template keeps them."""
    assert source.parent_id is not None
    page, _, _ = await _load_database(db, actor, source.parent_id, "edit")
    current = await _record(db, page.id)
    values = await _template_values(
        db,
        actor,
        page.id,
        current.schema_doc,
        source,
        expand=source.is_template and not as_template,
        today=utcnow().date(),
    )
    targets = _relation_targets(current.schema_doc, values)
    record = (await _lock_records(db, {page.id, *targets}, share=True))[page.id]
    if await _row_count(db, page.id, templates_too=True) >= ds.MAX_ROWS:
        raise conflict("wiki_too_many_rows", f"A database holds at most {ds.MAX_ROWS} rows")
    after = await db.scalar(
        select(func.min(WikiPage.position)).where(
            WikiPage.parent_id == page.id,
            WikiPage.kind == "row",
            WikiPage.position > source.position,
        )
    )
    row, touched = await _insert_row(
        db,
        actor,
        page,
        record,
        title=title,
        icon=source.icon,
        body=source.body,
        values=values,
        position=ordering.key_between(source.position, after),
        is_template=as_template,
        client_save_id=client_save_id,
        files_from=source,
        files=files,
        notify=False,
    )
    await events.emit_rows_changed(db, {page.id, *touched})
    out = await _row_with_refs(db, actor, row, record.schema_doc)
    await db.commit()
    return out


async def set_default_template(
    db: AsyncSession, actor: User, database_id: uuid.UUID, data: DefaultTemplateIn
) -> DatabaseOut:
    """M145: the row template 「新規」 starts from (edit; null: none). 404 template_not_found
    for one that is not a live row template of this database."""
    page, _, rank = await _load_database(db, actor, database_id, "edit")
    record = (await _lock_records(db, [page.id], share=False))[page.id]
    if data.template_id is not None and await _row_template(db, page.id, data.template_id) is None:
        raise not_found("template_not_found", "Template not found")
    if record.default_template_id != data.template_id:
        record.default_template_id = data.template_id
        await db.flush()
        await events.emit_rows_changed(db, [page.id])
    out = await _database_out(db, actor, record, rank)
    await db.commit()
    return out


async def get_row(db: AsyncSession, actor: User, row_id: uuid.UUID) -> RowDetailOut:
    row, _ = await _load_row(db, actor, row_id, "view")
    assert row.parent_id is not None
    page, record, rank = await _load_database(db, actor, row.parent_id, "view")
    detail = await _row_with_refs(db, actor, row, record.schema_doc)
    return RowDetailOut(
        row=detail.row,
        database=await _database_out(db, actor, record, rank),
        database_title=page.title,
        refs=detail.refs,
        referenced_by=await _referenced_by(db, actor, row.id),
    )


async def _referenced_by(db: AsyncSession, actor: User, row_id: uuid.UUID) -> list[ReferencedBy]:
    """Readable rows linking here through one-way relations (two-way ones are the reverse
    property's cells)."""
    rows = (
        await db.execute(
            text(
                "SELECT src_database_id, prop_id, src_page_id FROM wiki_relations "
                "WHERE dst_page_id = :row ORDER BY src_database_id, prop_id, seq"
            ),
            {"row": row_id},
        )
    ).all()
    if not rows:
        return []
    readable, _ = await _visibility(db, actor, [r[2] for r in rows])
    grouped: dict[tuple[uuid.UUID, str], list[RowRef]] = defaultdict(list)
    for source_db, prop_id, src in rows:
        if src in readable:
            grouped[(source_db, prop_id)].append(readable[src])
    out: list[ReferencedBy] = []
    for (source_db, prop_id), refs in grouped.items():
        source = await db.get(WikiPage, source_db)
        record = await db.get(WikiDatabase, source_db)
        if source is None or record is None:
            continue
        prop = ds.props_by_id(record.schema_doc).get(prop_id)
        if prop is None or (prop.get("relation") or {}).get("pair_id"):
            continue
        out.append(
            ReferencedBy(
                database_id=source_db,
                database_title=source.title,
                prop_id=prop_id,
                prop_name=prop.get("name", ""),
                rows=refs,
            )
        )
    return out


async def update_props(
    db: AsyncSession, actor: User, row_id: uuid.UUID, data: RowPropsUpdate
) -> RowWithRefs:
    """Replace the given cells; the last write wins per cell (WIKI.md §5.3). A change is a
    version of kind props (the before and after of the cells, relations as the ids the writer
    could see). A retry of the same client_op_id changes nothing again."""
    row, _ = await _load_row(db, actor, row_id, "edit")
    database_id = row.parent_id
    assert database_id is not None
    done = await repo.revision_by_save_id(db, actor.id, data.client_op_id)
    if done is not None:
        if done.page_id != row.id:
            raise conflict("idempotency_conflict", "client_op_id was already used for another row")
        out = await _row_with_refs(db, actor, row, (await _record(db, database_id)).schema_doc)
        await db.commit()
        return out
    targets = _relation_targets((await _record(db, database_id)).schema_doc, data.set)
    record = (await _lock_records(db, {database_id, *targets}, share=True)).get(database_id)
    if record is None:
        raise access.page_not_found()
    locked = await access.load_page(db, row.id, lock=True)
    if locked is None or locked.is_deleted:
        raise access.page_not_found()
    row = locked
    before, after, touched = await _apply_values(
        db, actor, database_id, record.schema_doc, row, data.set
    )
    if before or after:
        row.props_text = await _props_text(db, record.schema_doc, row.props or {})
        row.version += 1
        row.updated_by = actor.id
        row.updated_at = utcnow()
        db.add(
            WikiPageRevision(
                id=uuid7(),
                page_id=row.id,
                version=None,
                kind="props",
                parent_rev_id=row.head_rev_id,
                author_id=actor.id,
                title=row.title,
                body=row.body,
                props={"before": before, "after": after},
                client_save_id=data.client_op_id,
            )
        )
        await db.flush()
        if "title" in after:
            touched |= await repo.linked_databases(db, row.id)
        await events.emit_rows_changed(db, {database_id, *touched})
        await events.emit_page_updated(db, row, "props")
    out = await _row_with_refs(db, actor, row, record.schema_doc)
    await db.commit()
    return out


# --- schema changes ------------------------------------------------------------------------------


class _Change:
    """One PATCH /schema: the schemas it changes (this database and, for two-way relations,
    others), the rows it rewrote and what to tell."""

    def __init__(self, db: AsyncSession, actor: User, records: dict[uuid.UUID, WikiDatabase]):
        self.db = db
        self.actor = actor
        self.records = records
        self.schemas = {k: copy.deepcopy(v.schema_doc) for k, v in records.items()}
        self.views = {k: copy.deepcopy(v.views) for k, v in records.items()}
        self.changed: set[uuid.UUID] = set()

    def props(self, database_id: uuid.UUID) -> list[dict[str, Any]]:
        return self.schemas[database_id]["properties"]  # type: ignore[no-any-return]

    def find(self, database_id: uuid.UUID, prop_id: str) -> dict[str, Any]:
        for prop in self.props(database_id):
            if prop["id"] == prop_id:
                return prop
        raise bad_request("wiki_property_not_found", "No such property")

    def ids(self, database_id: uuid.UUID) -> set[str]:
        return {p["id"] for p in self.props(database_id)}


def _clean_name(name: str | None) -> str:
    return " ".join((name or "").split())[:100]


def _options(given: Sequence[Any], old: Sequence[Mapping[str, Any]] = ()) -> list[dict[str, Any]]:
    if len(given) > ds.MAX_OPTIONS:
        raise bad_request("wiki_too_many_options", f"At most {ds.MAX_OPTIONS} options")
    known = {o["id"] for o in old}
    out: list[dict[str, Any]] = []
    for option in given:
        oid = option.id if option.id in known else None
        out.append(
            {
                "id": oid or ds.new_id([o["id"] for o in out] + list(known)),
                "name": option.name,
                "color": option.color,
            }
        )
    if len({o["id"] for o in out}) != len(out):
        raise bad_request("validation_error", "Each option once")
    return out


async def _relation_target(
    change: _Change, database_id: uuid.UUID, relation: RelationIn | None
) -> uuid.UUID:
    """The database a new relation points to: one the actor can read (full for two-way, as it
    gets a property too)."""
    if relation is None:
        raise bad_request("validation_error", "A relation property needs `relation`")
    level = "full" if relation.two_way else "view"
    target, _ = await access.require_level(change.db, change.actor, relation.database_id, level)
    if target.kind != "database" or target.id not in change.records:
        raise access.page_not_found()
    return target.id


def _place(props: list[dict[str, Any]], prop: dict[str, Any], after_id: str | None) -> None:
    if after_id is not None:
        for index, existing in enumerate(props):
            if existing["id"] == after_id:
                props.insert(index + 1, prop)
                return
    props.append(prop)


def _check_count(change: _Change, database_id: uuid.UUID, adding: int = 1) -> None:
    if len(change.props(database_id)) + adding > ds.MAX_PROPERTIES:
        raise conflict("wiki_too_many_properties", f"At most {ds.MAX_PROPERTIES} properties")


def _link_relation(
    change: _Change,
    database_id: uuid.UUID,
    prop: dict[str, Any],
    target: uuid.UUID,
    relation: RelationIn,
) -> None:
    prop["relation"] = {"database_id": str(target), "pair_id": None, "primary": True}
    if relation.two_way:
        _check_count(change, target)
        taken = change.ids(target) | ({prop["id"]} if target == database_id else set())
        pair = {
            "id": ds.new_id(taken),
            "name": _clean_name(relation.pair_name),
            "type": "relation",
            "relation": {"database_id": str(database_id), "pair_id": prop["id"], "primary": False},
        }
        prop["relation"]["pair_id"] = pair["id"]
        change.props(target).append(pair)
        change.changed.add(target)


async def _unlink_relation(change: _Change, database_id: uuid.UUID, prop: dict[str, Any]) -> None:
    """A relation property goes (deleted or retyped): its links go with it; a two-way pair's
    reverse property goes too, or (deleting the reverse side) the source becomes one-way."""
    cfg = prop.get("relation") or {}
    other = uuid.UUID(str(cfg["database_id"])) if cfg.get("database_id") else None
    pair_id = cfg.get("pair_id")
    if cfg.get("primary", True):
        await change.db.execute(
            text("DELETE FROM wiki_relations WHERE src_database_id = :db AND prop_id = :prop"),
            {"db": database_id, "prop": prop["id"]},
        )
        if other is not None and pair_id and other in change.records:
            if other != database_id and await access.level_of(change.db, change.actor, other) < 3:
                raise conflict(
                    "wiki_relation_pair_restricted",
                    "The other side of this relation is in a database you cannot manage",
                )
            change.schemas[other]["properties"] = [
                p for p in change.props(other) if p["id"] != pair_id
            ]
            _forget_in_views(change.views[other], pair_id)
            change.changed.add(other)
    elif other is not None and pair_id and other in change.records:
        for source in change.props(other):
            if source["id"] == pair_id:
                source["relation"]["pair_id"] = None
                change.changed.add(other)


def _forget_in_views(views: list[dict[str, Any]], prop_id: str, *, keep_sort: bool = False) -> None:
    for view in views:
        view["columns"] = [c for c in view.get("columns") or [] if c["prop_id"] != prop_id]
        if not keep_sort:
            view["sort"] = [s for s in view.get("sort") or [] if s["prop_id"] != prop_id]
        group = view.get("filter")
        if group:
            group["conditions"] = [
                c for c in group.get("conditions", []) if c["prop_id"] != prop_id
            ]
        if view.get("date_prop_id") == prop_id:
            view["date_prop_id"] = None


async def _legacy(db: AsyncSession, rows: Iterable[tuple[uuid.UUID, str, str, Any]]) -> None:
    items = [
        {"id": uuid7(), "page_id": r, "prop_id": p, "prop_type": t, "value": v}
        for r, p, t, v in rows
    ]
    if items:
        await db.execute(insert(WikiPropLegacy), items)


async def _write_rows(db: AsyncSession, schema: Mapping[str, Any], rows: Sequence[ds.Row]) -> None:
    """Rows whose values a schema change rewrote, with their search text."""
    if not rows:
        return
    names = await _names(db)
    await db.execute(
        text(
            "UPDATE wiki_pages SET props = CAST(:props AS jsonb), props_text = :props_text "
            "WHERE id = :id"
        ),
        [
            {
                "id": r.id,
                "props": _json(r.props),
                "props_text": ds.search_text(schema, r.props, names),
            }
            for r in rows
        ],
    )


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


async def _retype(
    change: _Change,
    database_id: uuid.UUID,
    prop: dict[str, Any],
    new_type: str,
    number_format: str | None,
    relation: RelationIn | None,
) -> None:
    db = change.db
    if prop["type"] == "title":
        raise bad_request("wiki_title_property", "The title property keeps its type")
    if prop["type"] == new_type and new_type != "relation":
        if number_format is not None and new_type == "number":
            prop["number_format"] = number_format
        return
    old = copy.deepcopy(prop)
    target = None
    if new_type == "relation":
        target = await _relation_target(change, database_id, relation)
    if old["type"] == "relation":
        await _unlink_relation(change, database_id, old)
    new: dict[str, Any] = {"id": prop["id"], "name": prop.get("name", ""), "type": new_type}
    if new_type == "number":
        new["number_format"] = number_format or "number"
    rows = await _rows(db, database_id, trashed_too=True)
    names = await _names(db)
    _, people = await _people(db)
    conversion = ds.Conversion(old=old, new=new, ctx=ds.Ctx(names=names), people=people)
    values = {r.id: ds.cell_value(old, r) for r in rows}
    conversion.prepare(values.values())
    legacy = await db.execute(
        select(WikiPropLegacy)
        .where(
            WikiPropLegacy.page_id.in_([r.id for r in rows]),
            WikiPropLegacy.prop_id == prop["id"],
            WikiPropLegacy.prop_type == new_type,
        )
        .order_by(WikiPropLegacy.created_at)
    )
    earlier = {item.page_id: item for item in legacy.scalars().all()}
    lost: list[tuple[uuid.UUID, str, str, Any]] = []
    restored: list[uuid.UUID] = []
    changed_rows: list[ds.Row] = []
    for row in rows:
        value, dropped = conversion.convert(values[row.id])
        if dropped and old["type"] != "relation" and old["type"] not in ds.COMPUTED:
            lost.append((row.id, prop["id"], old["type"], values[row.id]))
        if value is None and row.id in earlier and new_type in ds.STORED:
            value = earlier[row.id].value
            restored.append(earlier[row.id].id)
        props = dict(row.props or {})
        props.pop(prop["id"], None)
        if value is not None and new_type in ds.STORED:
            props[prop["id"]] = value
        if props != (row.props or {}):
            row.props = props
            changed_rows.append(row)
    prop.clear()
    prop.update(new)
    if target is not None:
        assert relation is not None
        _link_relation(change, database_id, prop, target, relation)
    await _legacy(db, lost)
    if restored:
        await db.execute(
            text("DELETE FROM wiki_props_legacy WHERE id = ANY(CAST(:ids AS uuid[]))"),
            {"ids": restored},
        )
    await _write_rows(db, change.schemas[database_id], changed_rows)
    for view in change.views[database_id]:
        group = view.get("filter")
        if group:
            group["conditions"] = [
                c for c in group.get("conditions", []) if c["prop_id"] != prop["id"]
            ]
        if new_type == "relation":
            view["sort"] = [s for s in view.get("sort") or [] if s["prop_id"] != prop["id"]]
        if view.get("date_prop_id") == prop["id"] and new_type not in ds.DATEISH:
            view["date_prop_id"] = None


async def _delete(change: _Change, database_id: uuid.UUID, prop: dict[str, Any]) -> None:
    db = change.db
    if prop["type"] == "title":
        raise bad_request("wiki_title_property", "The title property cannot be deleted")
    if prop["type"] == "relation":
        await _unlink_relation(change, database_id, prop)
    elif prop["type"] in ds.STORED:
        rows = await _rows(db, database_id, trashed_too=True)
        holding = [r for r in rows if (r.props or {}).get(prop["id"]) is not None]
        await _legacy(db, [(r.id, prop["id"], prop["type"], r.props[prop["id"]]) for r in holding])
        for row in holding:
            row.props = {k: v for k, v in row.props.items() if k != prop["id"]}
        change.schemas[database_id]["properties"] = [
            p for p in change.props(database_id) if p["id"] != prop["id"]
        ]
        await _write_rows(db, change.schemas[database_id], holding)
    change.schemas[database_id]["properties"] = [
        p for p in change.props(database_id) if p["id"] != prop["id"]
    ]
    _forget_in_views(change.views[database_id], prop["id"])


async def _clear_options(
    change: _Change, database_id: uuid.UUID, prop: dict[str, Any], removed: set[str]
) -> None:
    if not removed:
        return
    rows = await _rows(change.db, database_id, trashed_too=True)
    changed: list[ds.Row] = []
    for row in rows:
        value = (row.props or {}).get(prop["id"])
        if value is None:
            continue
        if prop["type"] == "select" and value in removed:
            row.props = {k: v for k, v in row.props.items() if k != prop["id"]}
            changed.append(row)
        elif prop["type"] == "multi_select" and set(value) & removed:
            kept = [v for v in value if v not in removed]
            row.props = (
                {**row.props, prop["id"]: kept}
                if kept
                else {k: v for k, v in row.props.items() if k != prop["id"]}
            )
            changed.append(row)
    await _write_rows(change.db, change.schemas[database_id], changed)
    for view in change.views[database_id]:
        group = view.get("filter")
        if group:
            group["conditions"] = [
                c
                for c in group.get("conditions", [])
                if not (c["prop_id"] == prop["id"] and c.get("value") in removed)
            ]


def _involved(record: WikiDatabase, data: SchemaChange) -> set[uuid.UUID]:
    """The databases a change may touch (locked together, in order)."""
    out = {record.page_id}
    props = ds.props_by_id(record.schema_doc)
    for op in data.ops:
        relation = getattr(op, "relation", None)
        if relation is not None:
            out.add(relation.database_id)
        prop_id = getattr(op, "id", None)
        if prop_id is not None and props.get(prop_id, {}).get("type") == "relation":
            target = (props[prop_id].get("relation") or {}).get("database_id")
            if target:
                out.add(uuid.UUID(str(target)))
    return out


def _needs_full(rank: int) -> None:
    """M144 (WIKI.md §22.2): what loses data or changes another database stays with full access."""
    if rank < access.LEVELS["full"]:
        raise forbidden("page_manage_restricted", "Only people with full access can do this")


async def change_schema(
    db: AsyncSession, actor: User, database_id: uuid.UUID, data: SchemaChange
) -> DatabaseOut:
    """Add, rename, retype (converting every row), reorder and delete properties.
    M144 (WIKI.md §22.2): edit access adds, renames and reorders properties, adds options and
    changes their names and colours and a number's format; deleting a property or an option,
    changing a type and a two-way relation stay with full access (403 page_manage_restricted).
    409 wiki_schema_conflict when written on an older schema."""
    await access.lock_tree(db)
    page, record, rank = await _load_database(db, actor, database_id, "edit")
    records = await _lock_records(db, _involved(record, data), share=False)
    record = records[page.id]
    if record.schema_version != data.base_schema_version:
        raise conflict(
            "wiki_schema_conflict",
            "The properties changed meanwhile; read them again",
            {"schema_version": record.schema_version},
        )
    change = _Change(db, actor, records)
    change.changed.add(page.id)
    for op in data.ops:
        if op.op == "add":
            _check_count(change, page.id)
            prop: dict[str, Any] = {
                "id": ds.new_id(change.ids(page.id)),
                "name": _clean_name(op.name),
                "type": op.type,
            }
            if op.type in ("select", "multi_select"):
                prop["options"] = _options(op.options)
            if op.type == "number":
                prop["number_format"] = op.number_format or "number"
            if op.type == "relation":
                if op.relation is not None and op.relation.two_way:
                    _needs_full(rank)
                target = await _relation_target(change, page.id, op.relation)
                assert op.relation is not None
                _link_relation(change, page.id, prop, target, op.relation)
            _place(change.props(page.id), prop, op.after_id)
        elif op.op == "update":
            prop = change.find(page.id, op.id)
            if op.name is not None:
                prop["name"] = _clean_name(op.name)
            if op.options is not None:
                if prop["type"] not in ("select", "multi_select"):
                    raise bad_request("validation_error", "Only selects have options")
                old_options = prop.get("options", [])
                prop["options"] = _options(op.options, old_options)
                removed = {o["id"] for o in old_options} - {o["id"] for o in prop["options"]}
                if removed:
                    _needs_full(rank)  # the rows holding them lose the value
                await _clear_options(change, page.id, prop, removed)
            if op.number_format is not None and prop["type"] == "number":
                prop["number_format"] = op.number_format
        elif op.op == "retype":
            prop = change.find(page.id, op.id)
            if prop["type"] != op.type or op.type == "relation":
                _needs_full(rank)  # values convert, some go to wiki_props_legacy
            await _retype(change, page.id, prop, op.type, op.number_format, op.relation)
        elif op.op == "delete":
            _needs_full(rank)
            prop = change.find(page.id, op.id)
            await _delete(change, page.id, prop)
        else:
            current = change.props(page.id)
            if sorted(op.ids) != sorted(p["id"] for p in current):
                raise bad_request("validation_error", "Give every property id once")
            by_id = {p["id"]: p for p in current}
            ordered = [by_id[i] for i in op.ids]
            ordered.sort(key=lambda p: p["type"] != "title")
            change.schemas[page.id]["properties"] = ordered
    for database in sorted(change.changed):
        target_record = records[database]
        target_record.schema_doc = change.schemas[database]
        target_record.views = change.views[database]
        target_record.schema_version += 1
    await db.flush()
    # M144: now that editors shape databases, who changed what is kept (WIKI.md §22.2).
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="wiki.schema_changed",
        target_type="wiki_page",
        target_id=page.id,
        details={
            "ops": [
                {k: v for k, v in op.model_dump(mode="json").items() if k in ("op", "id", "type")}
                for op in data.ops
            ]
        },
    )
    await events.emit_rows_changed(db, change.changed)
    out = await _database_out(db, actor, record, rank)
    await db.commit()
    return out


# --- views ---------------------------------------------------------------------------------------


def _check_view_id(view_id: str) -> None:
    if not view_id or len(view_id) > 24 or not all(c.isalnum() or c == "_" for c in view_id):
        raise bad_request("validation_error", "A view id is up to 24 letters, digits or _")


async def put_view(
    db: AsyncSession, actor: User, database_id: uuid.UUID, view_id: str, data: ViewIn
) -> DatabaseOut:
    """Save a view (create or replace; edit access since M144, WIKI.md §22.2). Everyone who reads
    the database sees it."""
    _check_view_id(view_id)
    page, _, rank = await _load_database(db, actor, database_id, "edit")
    record = (await _lock_records(db, [page.id], share=False))[page.id]
    doc = ds.view_doc(view_id.lower(), data.model_dump(mode="json"))
    _keep_restricted(doc, next((v for v in record.views if v["id"] == doc["id"]), None))
    try:
        ds.check_view(record.schema_doc, doc)
    except ds.InvalidView as exc:
        raise invalid_view(str(exc)) from exc
    views = [dict(v) for v in record.views]
    for index, existing in enumerate(views):
        if existing["id"] == doc["id"]:
            views[index] = doc
            break
    else:
        if len(views) >= ds.MAX_VIEWS:
            raise conflict("wiki_too_many_views", f"At most {ds.MAX_VIEWS} views")
        views.append(doc)
    record.views = views
    record.schema_version += 1
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="wiki.view_saved",
        target_type="wiki_page",
        target_id=page.id,
        details={"view_id": doc["id"], "type": doc.get("type")},
    )
    await events.emit_rows_changed(db, [page.id])
    out = await _database_out(db, actor, record, rank)
    await db.commit()
    return out


async def delete_view(
    db: AsyncSession, actor: User, database_id: uuid.UUID, view_id: str
) -> DatabaseOut:
    """Delete a view (edit access since M144); the last one stays (409 wiki_last_view)."""
    page, _, rank = await _load_database(db, actor, database_id, "edit")
    record = (await _lock_records(db, [page.id], share=False))[page.id]
    views = [v for v in record.views if v["id"] != view_id]
    if len(views) == len(record.views):
        raise bad_request("wiki_view_not_found", "No such view")
    if not views:
        raise conflict("wiki_last_view", "A database keeps at least one view")
    record.views = views
    record.schema_version += 1
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="wiki.view_deleted",
        target_type="wiki_page",
        target_id=page.id,
        details={"view_id": view_id},
    )
    await events.emit_rows_changed(db, [page.id])
    out = await _database_out(db, actor, record, rank)
    await db.commit()
    return out
