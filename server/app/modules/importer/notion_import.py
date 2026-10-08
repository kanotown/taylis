"""Importing a Notion export into Docs (M125, docs/WIKI.md §6).

``python -m app.cli import-notion EXPORT.zip --actor ADMIN [--parent PAGE] [--access …]``:

- pages, the tree, databases (columns typed by guessing, §6.3; rows with their bodies; relations
  between imported rows, two-way when both sides have them; a calendar view when there is a date),
  images and files (attachments through the BlobStore, checked like an upload), links between
  pages (``page:``) and to files (``attachment:``), callouts and toggles as quotes and lists;
- the export has no people and no sharing: the importing administrator is the author, the
  imported top pages get ``--access`` (shared with the workspace at edit by default) and the rest
  inherit;
- every page, row and file is recorded in import_refs (source ``notion``), so running it again
  adds what is new, overwrites what nobody changed in Taylis since the last import (a new version
  of kind ``import``) and leaves (and reports) what someone changed;
- ``--dry-run`` reads everything and writes nothing: the report says what would happen;
- M145 (docs/WIKI.md §22.3, decided 2026-10-08): a database's row pages no CSV row has (Notion's
  templates and the like) become row templates. Running it again turns such a row imported
  before M145 into a template while nobody has changed it in Taylis (reported); once turned (an
  ``import_refs`` entry of kind ``template``), a row someone made a row again stays a row.
  ``convert_notion_templates`` (``app.cli wiki-notion-templates``) does only that step.

No notification is sent for imported mentions or pages; the tree's change feed, the open
tables and pages are told as for any change.
"""

import base64
import binascii
import functools
import hashlib
import json
import logging
import posixpath
import re
import shutil
import tempfile
import uuid
from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import filetype
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.doctext import body as doc
from app.core.ids import uuid7
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import service as attachments
from app.modules.attachments import videos
from app.modules.attachments.blobstore import BlobStore, MemoryBlobStore
from app.modules.attachments.images import IMAGE_TYPES, ImageTooLarge, make_thumbnail
from app.modules.attachments.models import Attachment
from app.modules.attachments.preview_kinds import queue_on_upload
from app.modules.audit import service as audit
from app.modules.importer.core import ImportFailed, active_admin
from app.modules.importer.models import ImportRef
from app.modules.importer.notion_export import (
    ITEM,
    NOTION_URL,
    ExportError,
    ExportFiles,
    Guess,
    Item,
    Link,
    Tree,
    convert_markdown,
    display_name,
    guess_type,
    label_text,
    match_rows,
    name_key,
    notion_id_of,
    parse_date,
    parse_relation,
    read_csv,
    read_tree,
    resolve_path,
    split_long,
    split_multi,
    split_page,
    split_properties,
)
from app.modules.users.models import User
from app.modules.wiki import access, events, ordering
from app.modules.wiki import dbschema as ds
from app.modules.wiki import repository as repo
from app.modules.wiki.models import WikiDatabase, WikiPage, WikiPageRevision
from app.modules.wiki.schemas import MAX_DEPTH
from app.modules.wiki.service import MAX_BODY_LENGTH

log = logging.getLogger("app.importer")

SOURCE = "notion"
BATCH = 100  # pages per transaction
BODY_PIECE = MAX_BODY_LENGTH - 5_000  # a longer body goes on in 「（続き n）」 pages
ACCESS_CHOICES = ("workspace-edit", "workspace-view", "private")
TYPES = ("text", "number", "select", "multi_select", "date", "person", "checkbox", "url")
_DATA_URI = re.compile(r"^data:(?P<type>[\w.+-]+/[\w.+-]+)?(?:;[\w=.+-]+)*;base64,(?P<data>.*)$")


@dataclass
class Options:
    parent_id: uuid.UUID | None = None
    # None: workspace-edit at the top level, nothing of their own (inherit) under --parent.
    access: str | None = None
    user_map: dict[str, str] = field(default_factory=dict)  # a Notion name → a username
    # "column" or "database / column" (a title or a Notion id) → a type (--column-types).
    column_types: dict[str, str] = field(default_factory=dict)
    timezone: str = "Asia/Tokyo"
    progress: Callable[[str], None] | None = None


@dataclass
class ColumnLine:
    name: str
    type: str
    note: str = ""


@dataclass
class DatabaseLine:
    title: str
    rows: int = 0
    extra_rows: int = 0  # row pages no CSV row has: row templates (M145)
    csv_only: int = 0  # CSV rows without a page
    columns: list[ColumnLine] = field(default_factory=list)
    calendar: bool = False


@dataclass
class NotionReport:
    dry_run: bool
    counts: Counter[str] = field(default_factory=Counter)
    databases: list[DatabaseLine] = field(default_factory=list)
    unresolved_links: list[str] = field(default_factory=list)
    unsupported: Counter[str] = field(default_factory=Counter)
    failed_files: list[str] = field(default_factory=list)
    edited: list[str] = field(default_factory=list)  # left as they are (changed in Taylis)
    # M145: rows imported before that became row templates now / were changed so stay rows.
    templates: list[str] = field(default_factory=list)
    templates_left: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    roots: list[uuid.UUID] = field(default_factory=list)

    def warn(self, message: str) -> None:
        self.warnings.append(message)
        log.warning("notion import: %s", message)


@dataclass
class Plan:
    """One page of the import: what it should be and what it is in Taylis now."""

    key: str  # import_refs.source_id
    ref_kind: str  # page | row
    kind: str  # page | database | row
    title: str
    parent: "Plan | None"
    item: Item | None = None
    raw: str = ""  # the Notion Markdown of its body (title and property lines taken off)
    base_dir: str = ""  # where its relative links start
    values: dict[str, str] = field(default_factory=dict)  # a row's cells by column
    database: "DatabasePlan | None" = None  # a row's database
    template: bool = False  # M145: a row page no CSV row has → a row template
    target: uuid.UUID = field(default_factory=uuid7)
    state: str = "new"  # new | same | update | edited | trashed | gone | skipped
    body: str = ""
    props: dict[str, Any] = field(default_factory=dict)
    files: list["FilePlan"] = field(default_factory=list)
    children: list["Plan"] = field(default_factory=list)
    path: list[uuid.UUID] = field(default_factory=list)
    position: str = ""
    label: str = ""  # its place in the export, for the report
    # What the page is in Taylis now (imported before): its title, body and values.
    current: tuple[str, str, dict[str, Any] | None] | None = None

    @property
    def writes(self) -> bool:
        return self.state in ("new", "update", "same")

    @property
    def live(self) -> bool:
        """There in Taylis after the import (written now, or left as someone changed it)."""
        return self.state in ("new", "update", "same", "edited")


@dataclass
class FilePlan:
    key: str
    name: str
    source: str | None  # a path in the export
    data: bytes | None  # a data: URI's bytes
    target: uuid.UUID
    image: bool  # written as an image line
    existing: bool = False
    content_type: str = "application/octet-stream"
    ok: bool = True


@dataclass
class Column:
    name: str
    guess: Guess
    prop: dict[str, Any] | None = None  # the property in the schema (None: not imported)


@dataclass
class DatabasePlan:
    plan: Plan
    header: list[str]
    view_header: list[str]
    columns: list[Column] = field(default_factory=list)
    rows: list[Plan] = field(default_factory=list)
    schema: dict[str, Any] = field(default_factory=dict)
    views: list[dict[str, Any]] = field(default_factory=list)
    existing: bool = False
    schema_changed: bool = False
    line: DatabaseLine | None = None


def _sha(text_: str | bytes, n: int = 24) -> str:
    data = text_.encode() if isinstance(text_, str) else text_
    return hashlib.sha1(data).hexdigest()[:n]


def _thumbnail(path: Path, max_px: int) -> tuple[bytes, int, int]:
    with path.open("rb") as fh:
        return make_thumbnail(fh, max_px)


def _sha256(path: Path) -> bytes:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


class NotionImport:
    def __init__(
        self,
        db: AsyncSession,
        tree: Tree,
        *,
        actor: User,
        blobs: BlobStore,
        settings: Settings,
        options: Options,
        dry_run: bool,
    ) -> None:
        self.db = db
        self.tree = tree
        self.actor = actor
        self.blobs = blobs
        self.settings = settings
        self.options = options
        self.dry_run = dry_run
        self.report = NotionReport(dry_run=dry_run)
        try:
            self.zone = ZoneInfo(options.timezone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ImportFailed(f"--timezone {options.timezone}: unknown") from exc
        self.plans: list[Plan] = []
        self.by_nid: dict[str, Plan] = {}
        self.databases: dict[str, DatabasePlan] = {}  # by the database's plan key
        self.refs: dict[tuple[str, str], uuid.UUID] = {}
        self.people: dict[str, str] = {}
        self.names: dict[str, str] = {}  # user id → display name (the search text of rows)
        self._existing_schema: dict[uuid.UUID, dict[str, Any]] = {}
        self._existing_views: dict[uuid.UUID, list[dict[str, Any]]] = {}
        self.mention = re.compile(r"(?!)")
        self.linked_files: set[str] = set()
        self.parent: WikiPage | None = None
        self._tmp: tempfile.TemporaryDirectory[str] | None = None

    # ---- the steps ---------------------------------------------------------------------------

    def _progress(self, message: str) -> None:
        if self.options.progress is not None:
            self.options.progress(message)

    async def _load_parent(self) -> None:
        if self.options.parent_id is None:
            if self.actor.is_guest:
                raise ImportFailed("guests cannot make top-level pages")
            return
        page = await access.load_page(self.db, self.options.parent_id)
        rank = await access.level_of(self.db, self.actor, self.options.parent_id)
        if page is None or page.is_deleted or rank < access.LEVELS["edit"]:
            raise ImportFailed(f"--parent {self.options.parent_id}: no page you can edit")
        if page.kind != "page":
            raise ImportFailed("--parent: pages go under a page (not a database or a row)")
        self.parent = page

    async def _load_people(self) -> None:
        rows = await self.db.execute(
            select(User.id, User.display_name, User.username, User.deactivated_at).where(
                User.role != "bot"
            )
        )
        by_name: dict[str, set[str]] = {}
        by_username: dict[str, str] = {}
        for uid, display, username, gone in rows.all():
            self.names[str(uid)] = display
            if gone is not None:
                continue
            by_username[username.casefold()] = str(uid)
            for name in (display, username):
                if name:
                    by_name.setdefault(name_key(name), set()).add(str(uid))
        people = {k: next(iter(v)) for k, v in by_name.items() if len(v) == 1}
        for source, username in self.options.user_map.items():
            mapped = by_username.get(username.casefold().lstrip("@"))
            if mapped is None:
                raise ImportFailed(f"--user {source}={username}: no active user {username}")
            people[name_key(source)] = mapped
        self.people = people
        names = sorted(
            {n for n in people if n}, key=lambda n: (-len(n), n)
        )  # the longest name first
        if names:
            self.mention = re.compile(
                r"(?<![\w.@/])@(" + "|".join(re.escape(n) for n in names) + ")", re.IGNORECASE
            )

    async def _load_refs(self) -> None:
        rows = await self.db.execute(
            select(ImportRef.kind, ImportRef.source_id, ImportRef.target_id).where(
                ImportRef.source == SOURCE
            )
        )
        self.refs = {(kind, sid): tid for kind, sid, tid in rows.all()}

    def _ref(self, kind: str, key: str) -> uuid.UUID | None:
        return self.refs.get((kind, key))

    # ---- planning ----------------------------------------------------------------------------

    def _new_plan(self, **kwargs: Any) -> Plan:
        plan = Plan(**kwargs)
        existing = self._ref(plan.ref_kind, plan.key)
        if existing is not None:
            plan.target = existing
            plan.state = "same"  # until _load_state looks
        self.plans.append(plan)
        if plan.parent is not None:
            plan.parent.children.append(plan)
        return plan

    def _plan_tree(self) -> None:
        tree = self.tree
        for warning in tree.warnings:
            self.report.warn(warning)
        for path in tree.orphan_files:
            self.report.warn(f"どのページのものか分からないファイル：{path}")

        def visit(nid: str, parent: Plan | None) -> None:
            item = tree.items[nid]
            if item.kind == "row":
                return  # with its database
            if item.moved_up:
                self.report.warn(
                    f"{item.path}: 行の下のページ・データベースの中のデータベースは上のページの下へ"
                )
            if item.kind == "database":
                plan = self._new_plan(
                    key=nid,
                    ref_kind="page",
                    kind="database",
                    title=item.title,
                    parent=parent,
                    item=item,
                    base_dir=item.dir,
                    label=item.path,
                )
                if item.md:
                    _, plan.raw = split_page(item.raw)
                self.by_nid[nid] = plan
                self._plan_rows(plan, item)
            else:
                title, rest = split_page(item.raw)
                plan = self._new_plan(
                    key=nid,
                    ref_kind="page",
                    kind="page",
                    title=title if title is not None else item.title,
                    parent=parent,
                    item=item,
                    raw=rest,
                    base_dir=item.dir,
                    label=item.path,
                )
                self.by_nid[nid] = plan
            for child in item.children:
                visit(child, plan)

        for root in tree.roots:
            visit(root, None)

    def _plan_rows(self, plan: Plan, item: Item) -> None:
        assert item.csv is not None
        header, rows = read_csv(self.tree.files, item.csv)
        view_header = header
        if item.view_csv:
            view_header, _ = read_csv(self.tree.files, item.view_csv)
        if not header:
            header, view_header = ["Name"], ["Name"]
        dbp = DatabasePlan(plan, header, view_header)
        dbp.line = DatabaseLine(title=plan.title or item.title)
        self.databases[plan.key] = dbp
        pages = [self.tree.items[c] for c in item.children if self.tree.items[c].kind == "row"]
        matched, extra = match_rows(header, rows, pages)
        columns = set(header[1:])
        for n, match in enumerate([*matched, *extra]):
            if len(dbp.rows) >= ds.MAX_ROWS:
                self.report.warn(
                    f"{plan.title}: {ds.MAX_ROWS} 行を超えた分 "
                    f"({len(matched) + len(extra) - n} 行) は取り込まない"
                )
                break
            row_item = self.tree.items[match.nid] if match.nid else None
            raw = ""
            base_dir = item.dir
            if row_item is not None:
                _, rest = split_page(row_item.raw)
                _, raw = split_properties(rest, columns)
                base_dir = row_item.dir
            if match.nid:
                key, ref_kind = match.nid, "page"
            else:
                key = f"{item.nid}:csv:{_sha(match.values[0], 16)}:{match.index}"
                ref_kind = "row"
                assert dbp.line is not None
                dbp.line.csv_only += 1
            if not match.from_csv:
                assert dbp.line is not None
                dbp.line.extra_rows += 1
            row = self._new_plan(
                key=key,
                ref_kind=ref_kind,
                kind="row",
                title=" ".join(match.values[0].split())[:200],
                parent=plan,
                item=row_item,
                raw=raw,
                base_dir=base_dir,
                values=dict(zip(header, match.values, strict=True)),
                database=dbp,
                label=row_item.path if row_item else f"{item.csv} の行 {match.values[0][:40]}",
            )
            row.template = not match.from_csv
            dbp.rows.append(row)
            if match.nid:
                self.by_nid[match.nid] = row
            if row_item is not None:
                for child in row_item.children:  # moved up by read_tree; never here
                    self.report.warn(f"{child}: 行の下のページ")
        assert dbp.line is not None
        dbp.line.rows = len(dbp.rows)

    async def _load_state(self, *, only_new_keys: bool = False) -> None:
        """What each planned page that was imported before is now: unchanged since the import
        (overwrite), changed in Taylis (leave), in the trash or gone (leave, and nothing new
        under it)."""
        plans = [p for p in self.plans if p.state == "same"]
        if only_new_keys:
            plans = [p for p in plans if not p.path]
        if not plans:
            return
        ids = [p.target for p in plans]
        pages = {
            p.id: p
            for p in (await self.db.execute(select(WikiPage).where(WikiPage.id.in_(ids)))).scalars()
        }
        latest = await self.db.execute(
            text(
                "SELECT DISTINCT ON (page_id) page_id, id, kind, title FROM wiki_page_revisions "
                "WHERE page_id = ANY(CAST(:ids AS uuid[])) AND kind <> 'side' "
                "ORDER BY page_id, created_at DESC, id DESC"
            ),
            {"ids": ids},
        )
        last = {row[0]: row for row in latest.all()}
        for plan in plans:
            page = pages.get(plan.target)
            if page is None:
                plan.state = "gone"
                continue
            plan.path = [*page.path, page.id]  # marks it loaded
            plan.current = (page.title, page.body, dict(page.props) if page.props else None)
            if page.is_deleted:
                plan.state = "trashed"
                continue
            rev = last.get(page.id)
            unchanged = (
                rev is not None
                and rev[2] == "import"
                and rev[1] == page.head_rev_id
                and rev[3] == page.title
            )
            plan.state = "same" if unchanged else "edited"
        for plan in self.plans:  # nothing new under a page that is not there
            if plan.state == "new" and plan.parent is not None:
                if plan.parent.state in ("trashed", "gone", "skipped"):
                    plan.state = "skipped"

    def _plan_databases(self) -> None:
        row_db: dict[str, str] = {}
        for dbp in self.databases.values():
            for row in dbp.rows:
                if row.item is not None:
                    row_db[row.item.nid] = dbp.plan.key
        for dbp in self.databases.values():
            assert dbp.line is not None
            for n, name in enumerate(dbp.header):
                if n == 0:
                    continue
                values = [row.values.get(name, "") for row in dbp.rows]
                guess = guess_type(
                    values, name=name, people=self.people, zone=self.zone, row_db=row_db
                )
                forced = self._forced_type(dbp, name)
                if forced is not None and forced != guess.type:
                    guess = Guess(forced, "--column-types")
                    if forced == "number":
                        guess.number_format = "number"
                dbp.columns.append(Column(name, guess))
        self._pair_relations()

    def _forced_type(self, dbp: DatabasePlan, column: str) -> str | None:
        for key in (f"{dbp.plan.title} / {column}", f"{dbp.plan.key} / {column}", column):
            if key in self.options.column_types:
                return self.options.column_types[key]
        return None

    def _relation_pairs(self, dbp: DatabasePlan, column: Column) -> set[tuple[str, str]]:
        out = set()
        for row in dbp.rows:
            if row.item is None:
                continue
            for _, nid in parse_relation(row.values.get(column.name, "")) or []:
                out.add((row.item.nid, nid))
        return out

    def _pair_relations(self) -> None:
        """A relation column whose links are exactly another relation column's, the other way
        round, is one two-way relation (Notion writes both sides)."""
        columns = [
            (dbp, c)
            for dbp in self.databases.values()
            for c in dbp.columns
            if c.guess.type == "relation"
        ]
        links = {id(c): self._relation_pairs(dbp, c) for dbp, c in columns}
        paired: set[int] = set()
        for dbp, c in columns:
            if id(c) in paired:
                continue
            mine = links[id(c)]
            for other_dbp, other in columns:
                if other is c or id(other) in paired:
                    continue
                if c.guess.target != other_dbp.plan.key or other.guess.target != dbp.plan.key:
                    continue
                if mine and {(b, a) for a, b in links[id(other)]} == mine:
                    c.guess.note = f"双方向（{other_dbp.plan.title} / {other.name}）"
                    other.guess.note = f"双方向の逆側（{dbp.plan.title} / {c.name}）"
                    other.guess.target = f"pair:{id(c)}"
                    paired |= {id(c), id(other)}
                    break

    # ---- bodies ------------------------------------------------------------------------------

    def _convert_bodies(self) -> None:
        for item in self.tree.items.values():
            self.linked_files.update(item.links)
        for plan in self.plans:
            if plan.state not in ("new", "same"):
                continue
            converted = convert_markdown(
                plan.raw,
                link_fn=functools.partial(self._link, plan),
                bare_fn=functools.partial(self._bare_urls, plan),
                mention_fn=self._mentions,
            )
            self.report.unsupported.update(converted.unsupported)
            body = converted.body
            if plan.item is not None:
                leftovers = [f for f in plan.item.files if f not in self.linked_files]
                lines = []
                for path in leftovers:
                    fp = self._file(plan, path, image=False)
                    if fp is not None:
                        lines.append(f"[{label_text(fp.name)}](attachment:{fp.target})")
                if lines:
                    body = (body.rstrip("\n") + "\n\n" if body else "") + "\n".join(lines) + "\n"
                    self.report.counts["files: not linked from the page (put at its end)"] += len(
                        lines
                    )
            plan.body = body

    def _page_link(self, label: str, target: Plan) -> str:
        return f"[{label_text(label) or label_text(target.title) or '…'}](page:{target.target})"

    def _link(self, plan: Plan, link: Link, original: str) -> str | None:
        url = link.url
        if url.startswith("data:"):
            fp = self._data_file(plan, url, link)
            return original if fp is None else self._file_line(fp, link)
        path = resolve_path(plan.base_dir, url)
        if path is not None:
            nid = self.tree.by_path.get(path)
            if nid is None and path not in self.tree.files.entries:
                # a page or database by its id (e.g. the view .csv of a database whose
                # _all.csv alone is there, or a page in another part of the export)
                m = ITEM.match(posixpath.basename(path))
                nid = m["id"].lower() if m else None
            if nid is not None and nid in self.by_nid:
                target = self.by_nid[nid]
                if target.state in ("gone", "skipped"):
                    self.report.unresolved_links.append(f"{plan.label} → {path}（Taylis に無い）")
                    return label_text(link.label)
                return self._page_link(link.label, target)
            if path in self.tree.files.entries:
                fp = self._file(plan, path, image=link.image)
                if fp is None:
                    return label_text(link.label) or display_name(path)
                return self._file_line(fp, link)
            self.report.unresolved_links.append(f"{plan.label} → {url}")
            return label_text(link.label) or display_name(url)
        if NOTION_URL.match(url):
            nid = notion_id_of(url)
            if nid is not None and nid in self.by_nid:
                return self._page_link(link.label, self.by_nid[nid])
            self.report.unresolved_links.append(f"{plan.label} → {url}（取り込んでいない Notion）")
        return None

    def _bare_urls(self, plan: Plan, piece: str) -> str:
        if "notion." not in piece:
            return piece

        def swap(m: re.Match[str]) -> str:
            nid = notion_id_of(m.group(0))
            if nid is not None and nid in self.by_nid:
                return self._page_link("", self.by_nid[nid])
            self.report.unresolved_links.append(
                f"{plan.label} → {m.group(0)}（取り込んでいない Notion）"
            )
            return m.group(0)

        return NOTION_URL.sub(swap, piece)

    def _mentions(self, piece: str) -> str:
        if "@" not in piece:
            return piece

        def swap(m: re.Match[str]) -> str:
            name = m.group(1)
            after = m.string[m.end() : m.end() + 1]
            if name[-1:].isascii() and (after.isascii() and (after.isalnum() or after == "_")):
                return m.group(0)
            uid = self.people.get(name_key(name))
            if uid is None:
                return m.group(0)
            self.report.counts["mentions"] += 1
            return f"<@{uid}>"

        return self.mention.sub(swap, piece)

    def _file_line(self, fp: FilePlan, link: Link) -> str:
        label = label_text(link.label) if link.label else ""
        if fp.image and fp.content_type in IMAGE_TYPES:
            return f"![{label}](attachment:{fp.target})"
        return f"[{label or label_text(fp.name)}](attachment:{fp.target})"

    def _file(self, plan: Plan, path: str, *, image: bool) -> FilePlan | None:
        key = f"{plan.key}:{_sha(path)}"
        for fp in plan.files:
            if fp.key == key:
                return fp
        name = attachments.sanitize_filename(display_name(path))
        size = self.tree.files.size(path)
        reason = ""
        if size == 0:
            reason = "空のファイル"
        elif size > self.settings.attachment_max_bytes:
            reason = f"添付の上限 ({self.settings.attachment_max_bytes} バイト) を超える"
        elif len(plan.files) >= attachments.MAX_ATTACHMENTS_PER_PAGE:
            reason = f"1 ページの添付の上限 ({attachments.MAX_ATTACHMENTS_PER_PAGE}) を超える"
        if reason:
            self.report.failed_files.append(f"{plan.label}: {name} ({size} バイト): {reason}")
            self.report.counts["files failed"] += 1
            return None
        existing = self._ref("file", key)
        fp = FilePlan(key, name, path, None, existing or uuid7(), image, existing is not None)
        if image:
            fp.content_type = self._sniff_type(path)
        plan.files.append(fp)
        return fp

    def _sniff_type(self, path: str) -> str:
        with self.tree.files.open_file(path) as fh:
            head = fh.read(attachments.SNIFF_BYTES)
        kind = filetype.guess(head)
        return kind.mime if kind is not None else "application/octet-stream"

    def _data_file(self, plan: Plan, url: str, link: Link) -> FilePlan | None:
        m = _DATA_URI.match(url)
        if m is None:
            self.report.unsupported["data: の URL（base64 でない）"] += 1
            return None
        try:
            data = base64.b64decode(m["data"], validate=False)
        except (binascii.Error, ValueError):
            self.report.unsupported["data: の URL（読めない）"] += 1
            return None
        key = f"{plan.key}:data:{_sha(data)}"
        if not data or len(data) > self.settings.attachment_max_bytes:
            self.report.failed_files.append(
                f"{plan.label}: 本文に埋め込まれた画像 ({len(data)} バイト)"
            )
            self.report.counts["files failed"] += 1
            return None
        kind = filetype.guess(data[: attachments.SNIFF_BYTES])
        mime = kind.mime if kind is not None else "application/octet-stream"
        ext = kind.extension if kind is not None else "bin"
        existing = self._ref("file", key)
        fp = FilePlan(
            key,
            f"image.{ext}",
            None,
            data,
            existing or uuid7(),
            link.image,
            existing is not None,
            mime,
        )
        plan.files.append(fp)
        return fp

    def _split_long_bodies(self) -> None:
        for plan in list(self.plans):
            if len(plan.body) <= BODY_PIECE or plan.kind == "database":
                continue
            pieces = split_long(plan.body, BODY_PIECE)
            plan.body = pieces[0].rstrip("\n") + "\n"
            parent: Plan | None = plan
            while parent is not None and parent.kind != "page":
                parent = parent.parent  # rows and databases hold no pages
            self.report.warn(
                f"{plan.label}: 本文が長い（{sum(map(len, pieces))} 字）→ 「（続き n）」の "
                f"{len(pieces) - 1} ページに分けた"
            )
            for n, piece in enumerate(pieces[1:], start=2):
                cont = self._new_plan(
                    key=f"{plan.key}:cont:{n}",
                    ref_kind="page",
                    kind="page",
                    title=f"{plan.title}（続き {n}）"[:200],
                    parent=parent,
                    label=f"{plan.label}（続き {n}）",
                )
                cont.body = piece.rstrip("\n") + "\n"
                cont.files = [f for f in plan.files if str(f.target) in piece]
                plan.files = [f for f in plan.files if f not in cont.files]
                if cont.state == "new" and parent is not None and not parent.writes:
                    cont.state = "skipped"

    # ---- schema, values, places --------------------------------------------------------------

    def _plan_places_and_values(self) -> None:
        for dbp in self.databases.values():
            self._schema(dbp)
        for dbp in self.databases.values():
            self._views(dbp)
            for row in dbp.rows:
                row.props = self._values(dbp, row)
        for plan in self.plans:
            if plan.state == "same" and plan.current is not None:
                title, body, props = plan.current
                if (
                    title != plan.title[:200]
                    or body != plan.body
                    or (plan.kind == "row" and (props or {}) != plan.props)
                ):
                    plan.state = "update"

    def _schema(self, dbp: DatabasePlan) -> None:
        """New: the columns as properties. Again: the existing schema, with the columns it does
        not have (by name and type) added and new select choices appended."""
        assert dbp.line is not None
        existing: dict[str, Any] | None = None
        if dbp.plan.state in ("same", "edited") and dbp.plan.path:
            existing = self._existing_schema.get(dbp.plan.target)
        dbp.existing = existing is not None
        props: list[dict[str, Any]] = (
            json.loads(json.dumps(existing["properties"])) if existing else []
        )
        if not props:
            props = [{"id": ds.TITLE_ID, "name": dbp.header[0][:100], "type": "title"}]
        taken = {p["id"] for p in props}
        for column in dbp.columns:
            guess = column.guess
            kind = guess.type
            if kind == "relation" and guess.target and guess.target.startswith("pair:"):
                continue  # made with its primary side below
            found = next(
                (p for p in props if p.get("name") == column.name[:100] and p["type"] == kind),
                None,
            )
            if found is None:
                if len(props) >= ds.MAX_PROPERTIES:
                    self.report.warn(
                        f"{dbp.plan.title}: プロパティが {ds.MAX_PROPERTIES} を超える："
                        f"列「{column.name}」は取り込まない"
                    )
                    dbp.line.columns.append(ColumnLine(column.name, "—", "上限を超えた"))
                    continue
                found = {"id": ds.new_id(taken), "name": column.name[:100], "type": kind}
                taken.add(found["id"])
                if kind in ("select", "multi_select"):
                    found["options"] = []
                if kind == "number":
                    found["number_format"] = guess.number_format or "number"
                if kind == "relation":
                    target_dbp = self.databases.get(guess.target or "")
                    if target_dbp is None:
                        continue
                    found["relation"] = {
                        "database_id": str(target_dbp.plan.target),
                        "pair_id": None,
                        "primary": True,
                    }
                props.append(found)
                dbp.schema_changed = True
            column.prop = found
            if kind in ("select", "multi_select"):
                self._options(dbp, column)
            dbp.line.columns.append(ColumnLine(column.name, kind, guess.note))
        dbp.schema = {"properties": props}
        # two-way: the reverse side's property, in the other database's schema
        for column in dbp.columns:
            if column.guess.type != "relation" or column.prop is None:
                continue
            for other_dbp in self.databases.values():
                for other in other_dbp.columns:
                    if other.guess.target == f"pair:{id(column)}":
                        other.prop = {"pending_pair": column}

    def _options(self, dbp: DatabasePlan, column: Column) -> None:
        assert column.prop is not None
        options: list[dict[str, Any]] = column.prop.setdefault("options", [])
        names = {o["name"] for o in options}
        multi = column.guess.type == "multi_select"
        for row in dbp.rows:
            raw = row.values.get(column.name, "").strip()
            for name in split_multi(raw) if multi else ([raw] if raw else []):
                name = name[:100]
                if name in names:
                    continue
                if len(options) >= ds.MAX_OPTIONS:
                    break
                options.append(
                    {
                        "id": ds.new_id(o["id"] for o in options),
                        "name": name,
                        "color": ds.COLORS[len(options) % len(ds.COLORS)],
                    }
                )
                names.add(name)
                dbp.schema_changed = True

    def _views(self, dbp: DatabasePlan) -> None:
        assert dbp.line is not None
        props = dbp.schema["properties"]
        # reverse sides of two-way relations made by another database
        for column in dbp.columns:
            pending = (column.prop or {}).get("pending_pair")
            if pending is None:
                continue
            primary: Column = pending
            assert primary.prop is not None
            source_dbp = next(d for d in self.databases.values() if primary in d.columns)
            found = next(
                (
                    p
                    for p in props
                    if p["type"] == "relation"
                    and (p.get("relation") or {}).get("pair_id") == primary.prop["id"]
                ),
                None,
            )
            if found is None and primary.prop["relation"].get("pair_id") is None:
                found = {
                    "id": ds.new_id(p["id"] for p in props),
                    "name": column.name[:100],
                    "type": "relation",
                    "relation": {
                        "database_id": str(source_dbp.plan.target),
                        "pair_id": primary.prop["id"],
                        "primary": False,
                    },
                }
                props.append(found)
                primary.prop["relation"]["pair_id"] = found["id"]
                dbp.schema_changed = source_dbp.schema_changed = True
            column.prop = found
            dbp.line.columns.append(ColumnLine(column.name, "relation", column.guess.note))
        if dbp.existing:
            dbp.views = self._existing_views.get(dbp.plan.target, [])
            return
        by_name = {c.name: c.prop for c in dbp.columns if c.prop}
        shown = [h for h in dbp.view_header[1:] if h in by_name]
        columns = [{"prop_id": by_name[h]["id"], "width": None, "hidden": False} for h in shown]
        columns += [
            {"prop_id": p["id"], "width": None, "hidden": True}
            for name, p in by_name.items()
            if name not in shown
        ]
        views = [ds.view_doc(ds.new_id(), {"columns": columns})]
        dates = [p for p in props if p["type"] == "date"]
        if dates:
            # Notion's calendar views are not in the export; one for the (first) date.
            preferred = next(
                (p for p in dates if p["name"].casefold() in ("日付", "date", "日時", "期間")),
                dates[0],
            )
            views.append(
                ds.view_doc(
                    ds.new_id([views[0]["id"]]),
                    {"type": "calendar", "date_prop_id": preferred["id"]},
                )
            )
            dbp.line.calendar = True
        dbp.views = views

    def _values(self, dbp: DatabasePlan, row: Plan) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for column in dbp.columns:
            prop = column.prop
            raw = row.values.get(column.name, "").strip()
            if prop is None or not raw or prop["type"] == "relation":
                continue
            kind = prop["type"]
            value: Any = None
            if kind == "text":
                value = raw[: ds.MAX_TEXT]
                if len(raw) > ds.MAX_TEXT:
                    self.report.warn(
                        f"{row.label}: 「{column.name}」が {ds.MAX_TEXT} 字を超える（切った）"
                    )
            elif kind == "number":
                value = ds.number_from_text(raw)
            elif kind == "checkbox":
                value = raw.casefold() in ("yes", "true", "✓", "✔", "はい") or None
            elif kind == "date":
                value = parse_date(raw, self.zone)
            elif kind == "url":
                value = raw if ds.is_url(raw) else None
            elif kind == "person":
                ids = [self.people.get(name_key(n)) for n in split_multi(raw)]
                value = [i for i in ids if i] or None
            elif kind == "select":
                value = next(
                    (o["id"] for o in prop.get("options", []) if o["name"] == raw[:100]), None
                )
            elif kind == "multi_select":
                names = [n[:100] for n in split_multi(raw)]
                value = [
                    o["id"] for n in names for o in prop.get("options", []) if o["name"] == n
                ] or None
            if value is None:
                self.report.counts["cells not fitting their type (left empty)"] += 1
                continue
            try:
                out[prop["id"]] = ds.normalize_value(prop, value, known_users=None)
            except ds.InvalidValue:
                self.report.counts["cells not fitting their type (left empty)"] += 1
        return {k: v for k, v in out.items() if v is not None}

    def _count(self) -> None:
        counts = self.report.counts
        for plan in self.plans:
            counts[f"{plan.kind}s: {plan.state}"] += 1
            if plan.state == "edited":
                self.report.edited.append(f"{plan.label}（{plan.title}）")
            if plan.state in ("trashed", "gone"):
                where = "ゴミ箱にある" if plan.state == "trashed" else "削除された"
                self.report.warn(f"{plan.label}: Taylis で{where}（触らない）")
            if plan.template and plan.state == "new":
                counts["row templates: new"] += 1
            if plan.writes:
                for fp in plan.files:
                    counts["files: already imported" if fp.existing else "files: new"] += 1
                    if not fp.existing and fp.source:
                        counts["file bytes: new"] += self.tree.files.size(fp.source)
        for dbp in self.databases.values():
            if dbp.line is not None:
                self.report.databases.append(dbp.line)
        self._plan_templates()

    def _plan_templates(self) -> list[Plan]:
        """M145: rows imported before as rows that are row templates now: turned while nobody has
        changed them in Taylis (else reported and left), once (an import_refs entry)."""
        self.report.templates.clear()
        self.report.templates_left.clear()
        out: list[Plan] = []
        for plan in self.plans:
            if not plan.template or plan.kind != "row" or self._ref("template", plan.key):
                continue
            if plan.state in ("same", "update"):
                out.append(plan)
                self.report.templates.append(f"{plan.label}（{plan.title}）")
            elif plan.state == "edited":
                self.report.templates_left.append(f"{plan.label}（{plan.title}）")
        if out:
            self.report.counts["row templates: turned"] = len(out)
        return out

    async def _convert_templates(self) -> int:
        """Turn the rows _plan_templates found into row templates (one transaction)."""
        plans = self._plan_templates()
        if not plans:
            return 0
        await access.lock_tree(self.db)
        databases: set[uuid.UUID] = set()
        turned = 0
        for plan in plans:
            page = await access.load_page(self.db, plan.target, lock=True)
            if page is None or page.is_deleted or page.kind != "row":
                continue
            if not page.is_template:
                page.is_template = True
                page.version += 1
                page.updated_at = utcnow()
                turned += 1
                if page.parent_id is not None:
                    databases.add(page.parent_id)
            self.db.add(
                ImportRef(source=SOURCE, kind="template", source_id=plan.key, target_id=plan.target)
            )
        await self.db.flush()
        if turned:
            await audit.record_in_tx(
                self.db,
                actor_id=self.actor.id,
                action="wiki.import_templates",
                target_type="wiki_page",
                target_id=None,
                details={"rows": turned},
            )
        await events.emit_rows_changed(self.db, databases)
        await self.db.commit()
        return turned

    # ---- writing -----------------------------------------------------------------------------

    async def load_databases(self) -> None:
        ids = [d.plan.target for d in self.databases.values() if d.plan.path]
        if not ids:
            return
        for record in (
            await self.db.execute(select(WikiDatabase).where(WikiDatabase.page_id.in_(ids)))
        ).scalars():
            self._existing_schema[record.page_id] = record.schema_doc
            self._existing_views[record.page_id] = record.views

    async def _write_pages(self) -> None:
        order = [p for p in self.plans if p.writes]
        siblings: dict[uuid.UUID | None, str | None] = {}
        total_files = sum(len(p.files) for p in order)
        files_done = 0
        for start in range(0, len(order), BATCH):
            batch = order[start : start + BATCH]
            await access.lock_tree(self.db)
            seq = await repo.next_seq(self.db)
            made: set[uuid.UUID] = set()
            for plan in batch:
                if plan.state == "new":
                    if await self._insert(plan, seq, siblings):
                        made.add(plan.target)
                elif plan.state == "update":
                    await self._overwrite(plan)
            await self.db.flush()
            for plan in batch:
                if not plan.writes:
                    continue
                if plan.kind == "database":
                    await self._write_database(plan)
                for fp in plan.files:
                    await self._store_file(plan, fp)
                    files_done += 1
                    if files_done % 20 == 0:
                        self._progress(f"files {files_done}/{total_files}")
            await self.db.flush()
            for plan in batch:
                if plan.target in made and (plan.parent is None or plan.parent.target not in made):
                    await access.recompute_subtree(self.db, plan.target)
            if made:
                await events.emit_changed(self.db, seq)
            await self.db.commit()
            self._progress(f"pages {min(start + BATCH, len(order))}/{len(order)}")
        # A database renamed in Taylis keeps its name; its new columns and choices still come.
        for dbp in self.databases.values():
            if dbp.plan.state == "edited":
                await self._write_database(dbp.plan)
        await self.db.commit()

    def _parent_place(self, plan: Plan) -> tuple[uuid.UUID | None, list[uuid.UUID]]:
        if plan.parent is not None:
            return plan.parent.target, plan.parent.path
        if self.parent is not None:
            return self.parent.id, [*self.parent.path, self.parent.id]
        return None, []

    async def _insert(
        self, plan: Plan, seq: int, siblings: dict[uuid.UUID | None, str | None]
    ) -> bool:
        parent_id, parent_path = self._parent_place(plan)
        if len(parent_path) + 1 > MAX_DEPTH:
            self.report.warn(f"{plan.label}: 深すぎる（{MAX_DEPTH} 段まで）→ 取り込まない")
            plan.state = "skipped"
            for child in plan.children:
                child.state = "skipped"
            return False
        if parent_id not in siblings:
            where = (
                WikiPage.parent_id == parent_id
                if parent_id is not None
                else WikiPage.parent_id.is_(None)
            )
            siblings[parent_id] = await self.db.scalar(
                select(func.max(WikiPage.position)).where(where, WikiPage.deleted_at.is_(None))
            )
        plan.position = ordering.key_between(siblings[parent_id], None)
        siblings[parent_id] = plan.position
        revision_id = uuid7()
        total, done = doc.count_tasks(plan.body)
        row = plan.kind == "row" and plan.database is not None
        # Rows only: an explicit None would be JSON null, not SQL NULL (the kind's CHECK).
        values: dict[str, Any] = (
            {"props": plan.props, "props_text": self._props_text(plan)} if row else {}
        )
        self.db.add(
            WikiPage(
                **values,
                id=plan.target,
                parent_id=parent_id,
                path=list(parent_path),
                position=plan.position,
                kind=plan.kind,
                title=plan.title[:200],
                body=plan.body,
                version=1,
                head_rev_id=revision_id,
                meta_seq=seq,
                vis_seq=seq,
                created_seq=seq,
                inherit_access=True,
                task_total=total,
                task_done=done,
                is_template=plan.template,
                created_by=self.actor.id,
                updated_by=self.actor.id,
            )
        )
        await self.db.flush()
        plan.path = [*parent_path, plan.target]
        self.db.add(self._revision(plan, revision_id, version=1, before=""))
        self.db.add(
            ImportRef(source=SOURCE, kind=plan.ref_kind, source_id=plan.key, target_id=plan.target)
        )
        if plan.template:
            self.db.add(
                ImportRef(source=SOURCE, kind="template", source_id=plan.key, target_id=plan.target)
            )
        if plan.parent is None:
            self.report.roots.append(plan.target)
            grants = self._root_grants()
            if grants:
                await repo.replace_own_grants(self.db, plan.target, grants, self.actor.id)
        return True

    def _props_text(self, plan: Plan) -> str:
        assert plan.database is not None
        return ds.search_text(plan.database.schema, plan.props, self.names)

    def _root_grants(self) -> list[tuple[str, uuid.UUID | None, str]]:
        """WIKI.md §6.4: the imported top pages get --access, the rest inherit. At the top
        level the importing administrator manages them (like a page made in 「共有」)."""
        choice = self.options.access
        if self.parent is not None and choice is None:
            return []  # inherit the chosen parent's
        choice = choice or "workspace-edit"
        grants: list[tuple[str, uuid.UUID | None, str]] = []
        if choice == "workspace-edit":
            grants.append(("workspace", None, "edit"))
        elif choice == "workspace-view":
            grants.append(("workspace", None, "view"))
        if self.parent is None:
            grants.append(("user", self.actor.id, "full"))
        return grants

    def _revision(
        self,
        plan: Plan,
        revision_id: uuid.UUID,
        *,
        version: int,
        before: str,
        parent: uuid.UUID | None = None,
    ) -> WikiPageRevision:
        added, removed = doc.line_changes(before, plan.body)
        return WikiPageRevision(
            id=revision_id,
            page_id=plan.target,
            version=version,
            kind="import",
            parent_rev_id=parent,
            author_id=self.actor.id,
            title=plan.title[:200],
            body=plan.body,
            lines_added=added,
            lines_removed=removed,
        )

    async def _overwrite(self, plan: Plan) -> None:
        """A page nobody changed since the last import, which the export now says differently:
        a new version of kind import (the history keeps the old one)."""
        page = await access.load_page(self.db, plan.target, lock=True)
        if page is None:
            return
        revision_id = uuid7()
        before = page.body
        page.version += 1
        self.db.add(
            self._revision(
                plan, revision_id, version=page.version, before=before, parent=page.head_rev_id
            )
        )
        await self.db.flush()
        page.title = plan.title[:200]
        page.body = plan.body
        page.head_rev_id = revision_id
        page.task_total, page.task_done = doc.count_tasks(plan.body)
        page.updated_by = self.actor.id
        page.updated_at = utcnow()
        if plan.kind == "row" and plan.database is not None:
            page.props = plan.props
            page.props_text = self._props_text(plan)
        await events.emit_page_updated(self.db, page, "props" if plan.kind == "row" else "content")

    async def _write_database(self, plan: Plan) -> None:
        dbp = self.databases[plan.key]
        record = await self.db.get(WikiDatabase, plan.target, with_for_update=True)
        if record is None:
            self.db.add(WikiDatabase(page_id=plan.target, schema_doc=dbp.schema, views=dbp.views))
        elif dbp.schema_changed:
            record.schema_doc = dbp.schema
            record.schema_version += 1
        await self.db.flush()

    async def _store_file(self, plan: Plan, fp: FilePlan) -> None:
        if fp.existing:
            return
        assert self._tmp is not None
        local = Path(self._tmp.name) / str(fp.target)
        source = fp.source
        if source is not None:
            size = self.tree.files.size(source)

            def copy() -> None:
                with self.tree.files.open_file(source) as src, local.open("wb") as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)

            await run_in_threadpool(copy)
        else:
            size = len(fp.data or b"")
            await run_in_threadpool(local.write_bytes, fp.data or b"")
        try:
            await self._attach(plan, fp, local, size)
        finally:
            local.unlink(missing_ok=True)

    async def _attach(self, plan: Plan, fp: FilePlan, path: Path, size: int) -> None:
        with path.open("rb") as fh:
            head = fh.read(attachments.SNIFF_BYTES)
        kind = filetype.guess(head)
        content_type = kind.mime if kind is not None else "application/octet-stream"
        now = utcnow()
        attachment = Attachment(
            id=fp.target,
            uploader_id=self.actor.id,
            page_id=plan.target,
            status="attached",
            filename=fp.name,
            content_type=content_type,
            size_bytes=size,
            storage_key=attachments.storage_key(fp.target),
            created_at=now,
            attached_at=now,
        )
        attachment.sha256 = await run_in_threadpool(_sha256, path)
        if content_type in IMAGE_TYPES:
            try:
                thumb, width, height = await run_in_threadpool(
                    _thumbnail, path, self.settings.attachment_thumbnail_px
                )
            except ImageTooLarge:
                self.report.failed_files.append(f"{plan.label}: {fp.name}: 画像の画素数が多すぎる")
                self.report.counts["files failed"] += 1
                return
            except Exception as exc:  # stays a plain file, as an upload would
                self.report.warn(f"{plan.label}: {fp.name}: サムネイルを作れない ({exc})")
            else:
                await self.blobs.put(attachments.thumbnail_key(fp.target), thumb, "image/jpeg")
                attachment.width, attachment.height = width, height
                attachment.thumbnail_key = attachments.thumbnail_key(fp.target)
        elif videos.is_video(content_type):
            try:
                info = await videos.probe_video(str(path), self.settings)
                if info is not None:
                    await attachments.apply_video_info(attachment, info, self.blobs)
            except Exception as exc:  # never fails the import, as it never fails an upload
                self.report.warn(f"{plan.label}: {fp.name}: 動画を調べられない ({exc})")
        with path.open("rb") as fh:
            await self.blobs.put(attachment.storage_key, fh, content_type)
        queue_on_upload(attachment, self.settings)
        self.db.add(attachment)
        self.db.add(ImportRef(source=SOURCE, kind="file", source_id=fp.key, target_id=fp.target))
        self.report.counts["file bytes written"] += size

    async def _write_links_and_relations(self) -> None:
        """After every page is there: the links between pages (backlinks) and the relation
        cells, then what the clients are told."""
        await access.lock_tree(self.db)
        live = [p for p in self.plans if p.writes]
        for plan in live:
            await repo.replace_links(self.db, plan.target, doc.page_refs(plan.body))
        touched: set[uuid.UUID] = set()
        for dbp in self.databases.values():
            if dbp.plan.live and (
                dbp.schema_changed or any(r.state in ("new", "update") for r in dbp.rows)
            ):
                touched.add(dbp.plan.target)
            for column in dbp.columns:
                prop = column.prop
                if (
                    prop is None
                    or prop.get("type") != "relation"
                    or not (prop.get("relation") or {}).get("primary", True)
                ):
                    continue
                for row in dbp.rows:
                    if not row.writes or row.item is None:
                        continue
                    wanted = []
                    for _, nid in parse_relation(row.values.get(column.name, "")) or []:
                        target = self.by_nid.get(nid)
                        if target is not None and target.kind == "row" and target.live:
                            wanted.append(target.target)
                    if await self._set_links(dbp.plan.target, prop["id"], row.target, wanted):
                        touched.add(dbp.plan.target)
                        self.report.counts["relation links written"] += len(wanted)
        await events.emit_rows_changed(self.db, touched)
        await audit.record_in_tx(
            self.db,
            actor_id=self.actor.id,
            action="wiki.imported",
            target_type="wiki_page",
            target_id=self.parent.id if self.parent is not None else None,
            details={
                "source": SOURCE,
                "pages": sum(1 for p in self.plans if p.kind == "page" and p.state == "new"),
                "databases": sum(
                    1 for p in self.plans if p.kind == "database" and p.state == "new"
                ),
                "rows": sum(1 for p in self.plans if p.kind == "row" and p.state == "new"),
                "updated": sum(1 for p in self.plans if p.state == "update"),
                "left_edited": len(self.report.edited),
                "files": self.report.counts.get("files: new", 0),
            },
        )
        await self.db.commit()

    async def _set_links(
        self, database_id: uuid.UUID, prop_id: str, row_id: uuid.UUID, wanted: list[uuid.UUID]
    ) -> bool:
        current = [
            r[0]
            for r in (
                await self.db.execute(
                    text(
                        "SELECT dst_page_id FROM wiki_relations WHERE src_page_id = :row "
                        "AND prop_id = :prop ORDER BY position, seq"
                    ),
                    {"row": row_id, "prop": prop_id},
                )
            ).all()
        ]
        wanted = list(dict.fromkeys(wanted))
        if current == wanted:
            return False
        await self.db.execute(
            text("DELETE FROM wiki_relations WHERE src_page_id = :row AND prop_id = :prop"),
            {"row": row_id, "prop": prop_id},
        )
        for n, target in enumerate(wanted, start=1):
            await self.db.execute(
                text(
                    "INSERT INTO wiki_relations (src_page_id, prop_id, dst_page_id, "
                    "src_database_id, position) VALUES (:row, :prop, :dst, :db, :n)"
                ),
                {"row": row_id, "prop": prop_id, "dst": target, "db": database_id, "n": n},
            )
        return True


async def import_notion(
    db: AsyncSession,
    export_path: Path,
    *,
    actor_username: str,
    blobs: BlobStore,
    settings: Settings,
    options: Options,
    dry_run: bool,
) -> NotionReport:
    actor = await active_admin(db, actor_username)
    if options.access is not None and options.access not in ACCESS_CHOICES:
        raise ImportFailed(f"--access {options.access}: one of {', '.join(ACCESS_CHOICES)}")
    for key, kind in options.column_types.items():
        if kind not in (*TYPES, "relation"):
            raise ImportFailed(f"--column-types {key}={kind}: one of {', '.join(TYPES)}")
    try:
        files = await run_in_threadpool(ExportFiles.open, export_path)
    except ExportError as exc:
        raise ImportFailed(str(exc)) from exc
    try:
        try:
            tree = await run_in_threadpool(read_tree, files)
        except ExportError as exc:
            raise ImportFailed(str(exc)) from exc
        if not tree.items:
            raise ImportFailed(f"{export_path}: no Notion page or database in it")
        job = NotionImport(
            db, tree, actor=actor, blobs=blobs, settings=settings, options=options, dry_run=dry_run
        )
        job._existing_schema = {}
        job._existing_views = {}
        return await _run(job)
    finally:
        files.close()


async def _run(job: NotionImport) -> NotionReport:
    await job._load_parent()
    await job._load_people()
    await job._load_refs()
    job._plan_tree()
    await job._load_state()
    await job.load_databases()
    job._plan_databases()
    job._convert_bodies()
    job._split_long_bodies()
    await job._load_state(only_new_keys=True)
    job._plan_places_and_values()
    job._count()
    if job.dry_run:
        await job.db.rollback()
        return job.report
    await job.blobs.ensure_bucket()
    job._tmp = tempfile.TemporaryDirectory(prefix="notion-files-")
    try:
        await job._write_pages()
        await job._write_links_and_relations()
        await job._convert_templates()
    except BaseException:
        await job.db.rollback()
        raise
    finally:
        job._tmp.cleanup()
    return job.report


async def convert_notion_templates(
    db: AsyncSession,
    export_path: Path,
    *,
    actor_username: str,
    settings: Settings,
    dry_run: bool,
) -> NotionReport:
    """M145 (``app.cli wiki-notion-templates``): only the step that turns the rows imported
    before as rows, which the export has as row pages no CSV row has, into row templates (rows
    nobody has changed since the import; the others are reported). Nothing else is written.
    Running it again changes nothing (an import_refs entry of kind ``template`` per row)."""
    actor = await active_admin(db, actor_username)
    try:
        files = await run_in_threadpool(ExportFiles.open, export_path)
    except ExportError as exc:
        raise ImportFailed(str(exc)) from exc
    try:
        try:
            tree = await run_in_threadpool(read_tree, files)
        except ExportError as exc:
            raise ImportFailed(str(exc)) from exc
        if not tree.items:
            raise ImportFailed(f"{export_path}: no Notion page or database in it")
        job = NotionImport(
            db,
            tree,
            actor=actor,
            blobs=MemoryBlobStore(),
            settings=settings,
            options=Options(),
            dry_run=dry_run,
        )
        await job._load_refs()
        job._plan_tree()
        await job._load_state()
        job.report.warnings.clear()  # the import's own warnings are not this step's
        if dry_run:
            job._plan_templates()
            await db.rollback()
        else:
            await job._convert_templates()
        return job.report
    finally:
        files.close()


def parse_column_types(lines: Iterable[str]) -> dict[str, str]:
    """``列 = 型`` or ``データベース / 列 = 型`` per line (# comments)."""
    out: dict[str, str] = {}
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f"{line!r}: COLUMN = TYPE or DATABASE / COLUMN = TYPE")
        left, kind = line.rsplit("=", 1)
        parts = [p.strip() for p in left.split(" / ", 1)]
        key = " / ".join(parts) if len(parts) == 2 else parts[0]
        out[key] = kind.strip()
    return out
