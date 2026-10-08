"""Reading a Notion export, "Markdown & CSV" with subpages (M125, docs/WIKI.md §6).

Pure functions and plain records, no database: the import (notion_import.py) turns them into
pages, and the tests feed small synthetic exports through them. The format, as checked on a
real export (2026-10-07, §6.1):

- A ZIP whose names are UTF-8 (the flag may be missing: names decoded as cp437 are re-read as
  UTF-8, then Shift-JIS). A large workspace comes as a ZIP of ZIPs (``Export-…-Part-1.zip``):
  when the outer ZIP holds no page at all, every ZIP in it is a part of the same tree.
- A page is ``<title> <32 hex id>.md``; a database is ``<title> <id>.csv`` (the columns of its
  default view) and ``<title> <id>_all.csv`` (every column). Their subpages, rows and files are in
  a folder named ``<title>`` next to them, or ``<title> <first 4>-<last 4 of the id>`` when two
  siblings have the same title. A folder may still be shared by a page and a database of the same
  title: what is linked from a page's body is that page's, a row whose title is in a CSV is that
  database's.
- A page begins with ``# <title>``; a row's page then has a line ``<column>: <value>`` for each
  non-empty value. CSV rows carry no id: they are matched to the row pages by title (and the
  values when titles repeat). Templates of a database are pages in its folder that no CSV row has.
- Links between pages are relative, URL-encoded paths (``[t](Folder/Page%20<id>.md)``, a
  database ``….csv``); files the same (``![](Page/image.png)``, ``[a.pdf](Page/a.pdf)``; a file
  name may itself be percent-encoded, and parentheses in names are not encoded).
- Callouts are ``<aside>`` blocks (the first line starts with its icon), toggles are list items
  (or ``<details>``), equations ``$$``. Mentions of people are plain ``@name`` text. Since M149
  (§22.5) a callout becomes ``::: callout <icon>`` … ``:::`` and a ``<details>`` toggle
  ``::: toggle <summary>`` … ``:::`` (the M125 import wrote them as a quote and a list item;
  rewrite_quote_callouts turns those quotes, app.cli wiki-rewrite-callouts).
"""

import csv
import functools
import io
import posixpath
import re
import shutil
import tempfile
import unicodedata
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone, tzinfo
from pathlib import Path
from typing import IO, Any
from urllib.parse import unquote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.modules.wiki import dbschema as ds

ITEM = re.compile(r"^(?P<title>.*?) ?(?P<id>[0-9a-f]{32})(?P<all>_all)?\.(?P<ext>md|csv)$", re.I)
NOTION_ID = re.compile(r"([0-9a-f]{32})(?![0-9a-f])", re.I)
NOTION_URL = re.compile(r"https?://(?:www\.)?notion\.(?:so|site)/[^\s<>()\[\]]*", re.I)
UNTITLED = {"", "無題", "untitled", "無題のページ", "新規ページ", "new page"}
MAX_UNPACKED_BYTES = 20 * 1024**3
MAX_PAGES = 20_000


class ExportError(ValueError):
    """The file is not a Notion export we can read (nothing was written)."""


# --- the files of the export ---------------------------------------------------------------------


def decode_name(info: zipfile.ZipInfo) -> str:
    """The entry's name as Notion wrote it (UTF-8, Windows' zips sometimes Shift-JIS)."""
    name = info.filename
    if not info.flag_bits & 0x800:
        raw = name.encode("cp437", errors="replace")
        for encoding in ("utf-8", "cp932"):
            try:
                name = raw.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
    return normalize_path(name)


def normalize_path(name: str) -> str:
    """NFC (macOS writes NFD), forward slashes, no leading ./ or /."""
    name = unicodedata.normalize("NFC", name.replace("\\", "/"))
    while name.startswith(("./", "/")):
        name = name[1:] if name.startswith("/") else name[2:]
    return name


@dataclass
class _Entry:
    size: int
    opener: Callable[[], IO[bytes]]


def _opener(path: Path) -> Callable[[], IO[bytes]]:
    def open_() -> IO[bytes]:
        return path.open("rb")

    return open_


class ExportFiles:
    """Every file of the export by its path (a ZIP, a ZIP of ZIPs, or an unpacked folder)."""

    def __init__(self) -> None:
        self.entries: dict[str, _Entry] = {}
        self._zips: list[zipfile.ZipFile] = []
        self._tmp: tempfile.TemporaryDirectory[str] | None = None
        self.parts = 0

    @classmethod
    def open(cls, path: Path) -> "ExportFiles":
        files = cls()
        try:
            if path.is_dir():
                files._add_dir(path)
            elif zipfile.is_zipfile(path):
                files._add_zip(zipfile.ZipFile(path), nested=True)
            else:
                raise ExportError(f"{path}: not a ZIP file or a folder")
        except (zipfile.BadZipFile, OSError) as exc:
            files.close()
            raise ExportError(f"{path}: {exc}") from exc
        return files

    def _add_dir(self, root: Path) -> None:
        for p in sorted(root.rglob("*")):
            if p.is_file():
                rel = normalize_path(p.relative_to(root).as_posix())
                self.entries[rel] = _Entry(p.stat().st_size, _opener(p))
        self.parts = 1

    def _add_zip(self, zf: zipfile.ZipFile, *, nested: bool) -> None:
        self._zips.append(zf)
        infos = [i for i in zf.infolist() if not i.is_dir()]
        names = [decode_name(i) for i in infos]
        has_pages = any(ITEM.match(posixpath.basename(n)) for n in names)
        inner = [(i, n) for i, n in zip(infos, names, strict=True) if n.lower().endswith(".zip")]
        if nested and not has_pages and inner:
            # A ZIP of ZIPs (Export-…-Part-1.zip, …): every part is a piece of one tree.
            if self._tmp is None:
                self._tmp = tempfile.TemporaryDirectory(prefix="notion-export-")
            for n, (info, _) in enumerate(inner):
                target = Path(self._tmp.name) / f"part-{n}.zip"
                with zf.open(info) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
                self._add_zip(zipfile.ZipFile(target), nested=False)
            return
        for info, name in zip(infos, names, strict=True):
            self.entries[name] = _Entry(info.file_size, functools.partial(zf.open, info))
        self.parts += 1

    @property
    def total_bytes(self) -> int:
        return sum(e.size for e in self.entries.values())

    def size(self, path: str) -> int:
        return self.entries[path].size

    def open_file(self, path: str) -> IO[bytes]:
        return self.entries[path].opener()

    def read_text(self, path: str) -> str:
        with self.open_file(path) as fh:
            data = fh.read()
        return data.decode("utf-8-sig", errors="replace").replace("\r\n", "\n").replace("\r", "\n")

    def close(self) -> None:
        for zf in self._zips:
            zf.close()
        self._zips.clear()
        if self._tmp is not None:
            self._tmp.cleanup()
            self._tmp = None


# --- links ---------------------------------------------------------------------------------------


@dataclass
class Link:
    image: bool
    label: str
    url: str
    start: int
    end: int


def _close_bracket(text: str, start: int) -> int:
    depth = 0
    for i in range(start, len(text)):
        c = text[i]
        if c == "\\":
            continue
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return i
    return -1


def _close_paren(text: str, start: int) -> int:
    """The ')' closing the '(' at `start`; parentheses inside are balanced (file names keep
    them unencoded). -1 at a line end or the text end."""
    depth = 0
    for i in range(start, len(text)):
        c = text[i]
        if c == "\n":
            return -1
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i
    return -1


def find_links(text: str) -> list[Link]:
    """Markdown links and images of one piece of text (no code), outermost only."""
    out: list[Link] = []
    i = 0
    while True:
        j = text.find("[", i)
        if j < 0:
            return out
        close = _close_bracket(text, j)
        if close < 0 or close + 1 >= len(text) or text[close + 1] != "(":
            i = j + 1
            continue
        end = _close_paren(text, close + 1)
        if end < 0:
            i = j + 1
            continue
        image = j > 0 and text[j - 1] == "!"
        url = text[close + 2 : end].strip()
        if url.startswith("<") and url.endswith(">"):
            url = url[1:-1]
        out.append(Link(image, text[j + 1 : close], url, j - 1 if image else j, end + 1))
        i = end + 1


def resolve_path(base_dir: str, url: str) -> str | None:
    """A relative link's target path in the export (None: not a relative file link)."""
    if not url or re.match(r"^[a-z][a-z0-9+.-]*:", url, re.I) or url.startswith(("#", "/")):
        return None
    target = url.split("#", 1)[0]  # Notion encodes a # in a name (%23); a raw one is an anchor
    if not target:
        return None
    joined = posixpath.normpath(posixpath.join(base_dir, unquote(target)))
    if joined.startswith(".."):
        return None
    return normalize_path(joined)


def notion_id_of(url: str) -> str | None:
    found = NOTION_ID.findall(url)
    return found[-1].lower() if found else None


# --- the tree ------------------------------------------------------------------------------------


@dataclass
class Item:
    """A page, a database or a row of the export (by its Notion id)."""

    nid: str
    kind: str  # page | database | row
    title: str  # from the file name (a page's "# " line replaces it)
    md: str | None = None
    csv: str | None = None  # the database's _all.csv (or .csv)
    view_csv: str | None = None  # the default view's columns (the .csv beside an _all.csv)
    parent: str | None = None
    children: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)  # non-page files in its folder
    links: list[str] = field(default_factory=list)  # paths its body links to, in order
    raw: str = ""
    moved_up: bool = False  # a page under a row (rows hold no pages): placed higher

    @property
    def path(self) -> str:
        return self.md or self.csv or ""

    @property
    def dir(self) -> str:
        return posixpath.dirname(self.path)


@dataclass
class Tree:
    items: dict[str, Item]
    roots: list[str]
    by_path: dict[str, str]  # .md / .csv path → nid
    files: ExportFiles
    warnings: list[str] = field(default_factory=list)
    orphan_files: list[str] = field(default_factory=list)

    def walk(self) -> Iterator[Item]:
        """Parents before children, in order."""
        stack = list(reversed(self.roots))
        while stack:
            item = self.items[stack.pop()]
            yield item
            stack.extend(reversed(item.children))


def _title_key(title: str) -> str:
    """Titles as Notion's file names and CSV cells write them: width, spaces and the
    characters a file name cannot hold do not count."""
    t = unicodedata.normalize("NFKC", title).casefold()
    t = re.sub(r"[\s/\\:*?\"<>|]+", "", t)
    return "" if t in {unicodedata.normalize("NFKC", u).casefold() for u in UNTITLED} else t


def read_tree(files: ExportFiles) -> Tree:
    items: dict[str, Item] = {}
    by_path: dict[str, str] = {}
    for path in sorted(files.entries):
        m = ITEM.match(posixpath.basename(path))
        if not m:
            continue
        nid = m["id"].lower()
        item = items.get(nid)
        if item is None:
            item = items[nid] = Item(nid, "page", m["title"].strip())
        by_path[path] = nid
        if m["ext"].lower() == "md":
            item.md = path
        elif m["all"]:
            if item.csv is not None and item.view_csv is None:
                item.view_csv = item.csv
            item.csv = path
            item.kind = "database"
        else:
            if item.csv is None:
                item.csv = path
            else:
                item.view_csv = path
            item.kind = "database"
    if len(items) > MAX_PAGES:
        raise ExportError(f"{len(items)} pages: at most {MAX_PAGES} at once")
    if files.total_bytes > MAX_UNPACKED_BYTES:
        raise ExportError(f"{files.total_bytes} bytes unpacked: at most {MAX_UNPACKED_BYTES}")
    tree = Tree(items, [], by_path, files)
    for item in items.values():
        if item.md:
            item.raw = files.read_text(item.md)
            item.links = [
                p
                for link in find_links(strip_code(item.raw))
                if (p := resolve_path(item.dir, link.url)) is not None
            ]
    _place(tree)
    return tree


def _place(tree: Tree) -> None:
    items = tree.items
    folders: set[str] = set()
    for path in tree.files.entries:
        d = posixpath.dirname(path)
        while d and d not in folders:
            folders.add(d)
            d = posixpath.dirname(d)
    owners: dict[str, list[str]] = {}
    for item in items.values():
        base = posixpath.join(item.dir, item.title) if item.dir else item.title
        for candidate in (f"{base} {item.nid[:4]}-{item.nid[-4:]}", base):
            if candidate in folders:
                owners.setdefault(candidate, []).append(item.nid)
                break
    csv_titles: dict[str, set[str]] = {}

    def titles_of(db: Item) -> set[str]:
        if db.nid not in csv_titles:
            header, rows = read_csv(tree.files, db.csv) if db.csv else ([], [])
            csv_titles[db.nid] = {_title_key(r[0]) for r in rows if r} if header else set()
        return csv_titles[db.nid]

    def pick(candidates: list[str], path: str, nid: str | None) -> str:
        if len(candidates) == 1:
            return candidates[0]
        for c in candidates:
            if path in items[c].links:
                return c
        if nid is not None and items[nid].md and not items[nid].csv:
            for c in candidates:
                if items[c].kind == "database" and _title_key(items[nid].title) in titles_of(
                    items[c]
                ):
                    return c
        pages = [c for c in candidates if items[c].kind == "page"]
        return (pages or candidates)[0]

    warned: set[str] = set()

    def owner_of(path: str, nid: str | None) -> str | None:
        d = posixpath.dirname(path)
        while d:
            found = owners.get(d)
            if found:
                own = [c for c in found if c != nid]
                if own:
                    return pick(own, path, nid)
            elif d not in warned:
                warned.add(d)
                tree.warnings.append(f"フォルダ {d}/ のページが見つからない（中身は上のページへ）")
            d = posixpath.dirname(d)
        return None

    for item in items.values():
        item.parent = owner_of(item.path, item.nid)
    for path in sorted(tree.files.entries):
        if path in tree.by_path:
            continue
        if ITEM.match(posixpath.basename(path)):
            continue
        owner = owner_of(path, None)
        if owner is None:
            tree.orphan_files.append(path)
        else:
            items[owner].files.append(path)
    # Kinds: what a database's folder holds is its rows; rows and databases hold no pages.
    for item in items.values():
        parent = items.get(item.parent) if item.parent else None
        if parent is not None and parent.kind == "database" and item.kind == "page" and item.md:
            item.kind = "row"
    for item in items.values():
        parent = items.get(item.parent) if item.parent else None
        if parent is None:
            continue
        if parent.kind == "row" or (parent.kind == "database" and item.kind != "row"):
            while parent is not None and parent.kind != "page":
                parent = items.get(parent.parent) if parent.parent else None
            item.parent = parent.nid if parent is not None else None
            item.moved_up = True
    # A cycle cannot come from folders, but never loop on a broken export.
    for item in items.values():
        seen = {item.nid}
        p = item.parent
        while p is not None:
            if p in seen:
                item.parent = None
                break
            seen.add(p)
            p = items[p].parent
    for item in items.values():
        if item.parent is None:
            tree.roots.append(item.nid)
        else:
            items[item.parent].children.append(item.nid)

    def order(parent: Item | None, ids: list[str]) -> list[str]:
        links = parent.links if parent is not None else []
        index = {}
        for n, p in enumerate(links):
            nid = tree.by_path.get(p)
            if nid is not None and nid not in index:
                index[nid] = n
        return sorted(
            ids,
            key=lambda c: (index.get(c, len(links)), _title_key(items[c].title), c),
        )

    tree.roots = order(None, tree.roots)
    for item in items.values():
        if item.kind != "database":  # rows keep the CSV's order (set by the import)
            item.children = order(item, item.children)


# --- CSV -----------------------------------------------------------------------------------------


def read_csv(files: ExportFiles, path: str) -> tuple[list[str], list[list[str]]]:
    text = files.read_text(path)
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return [], []
    header = [h.strip() for h in rows[0]]
    width = len(header)
    body = [(r + [""] * width)[:width] for r in rows[1:] if r]
    return header, body


def split_page(raw: str) -> tuple[str | None, str]:
    """(the "# " title or None, the rest)."""
    lines = raw.split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines and lines[0].startswith("# "):
        title = lines[0][2:].strip()
        rest = lines[1:]
        while rest and not rest[0].strip():
            rest.pop(0)
        return title, "\n".join(rest)
    return None, "\n".join(lines)


_PROP_LINE = re.compile(r"^(?P<key>[^:\n]{1,100}): ?(?P<value>.*)$")


def split_properties(body: str, columns: set[str]) -> tuple[dict[str, str], str]:
    """A row page's leading ``column: value`` lines (taken off) and the rest."""
    lines = body.split("\n")
    props: dict[str, str] = {}
    n = 0
    while n < len(lines):
        m = _PROP_LINE.match(lines[n])
        if not m or m["key"].strip() not in columns:
            break
        props[m["key"].strip()] = m["value"].strip()
        n += 1
    if not props:
        return {}, body
    rest = lines[n:]
    while rest and not rest[0].strip():
        rest.pop(0)
    return props, "\n".join(rest)


@dataclass
class RowMatch:
    values: list[str]  # the CSV cells (or the page's property lines)
    nid: str | None  # its row page, if any
    index: int  # the n-th CSV row with this title (the id of a row without a page)
    from_csv: bool = True


def match_rows(
    header: list[str], rows: list[list[str]], pages: list[Item]
) -> tuple[list[RowMatch], list[RowMatch]]:
    """CSV rows matched to their row pages by title, repeated titles by their values.
    Returns (rows in CSV order, row pages no CSV row has: templates and the like)."""
    columns = set(header[1:])
    by_key: dict[str, list[Item]] = {}
    page_props: dict[str, dict[str, str]] = {}
    for page in pages:
        title, rest = split_page(page.raw)
        page_props[page.nid], _ = split_properties(rest, columns)
        by_key.setdefault(_title_key(title if title is not None else page.title), []).append(page)
        if title is not None and _title_key(page.title) != _title_key(title):
            by_key.setdefault(_title_key(page.title), []).append(page)
    used: set[str] = set()
    out: list[RowMatch] = []
    seen: dict[str, int] = {}
    for values in rows:
        key = _title_key(values[0])
        seen[key] = seen.get(key, 0) + 1
        candidates = [p for p in by_key.get(key, []) if p.nid not in used]
        best: Item | None = None
        best_score = -1
        for page in candidates:
            props = page_props[page.nid]
            score = sum(
                1
                for col, value in zip(header[1:], values[1:], strict=True)
                if value.strip() and props.get(col, "").strip() == value.strip()
            ) - sum(1 for col in props if not values[header.index(col)].strip())
            if score > best_score:
                best, best_score = page, score
        if best is not None:
            used.add(best.nid)
        out.append(RowMatch(values, best.nid if best else None, seen[key]))
    extra: list[RowMatch] = []
    for page in pages:
        if page.nid in used:
            continue
        title, _ = split_page(page.raw)
        props = page_props[page.nid]
        values = [title if title is not None else page.title] + [
            props.get(c, "") for c in header[1:]
        ]
        extra.append(RowMatch(values, page.nid, 0, from_csv=False))
    return out, extra


# --- values in CSV cells -------------------------------------------------------------------------

_MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
    )
}
_TIME = r"(?:\s+(?P<h>\d{1,2}):(?P<mi>\d{2})(?:\s*(?P<ap>[AaPp][Mm]))?)?"
_TZ = r"(?:\s*\((?P<tz>[^()]{1,40})\))?"
_JP = re.compile(
    r"^(?P<y>\d{4})\s*年\s*(?P<m>\d{1,2})\s*月\s*(?P<d>\d{1,2})\s*日" + _TIME + _TZ + "$"
)
_EN = re.compile(r"^(?P<mon>[A-Za-z]{3,9})\.?\s+(?P<d>\d{1,2}),\s*(?P<y>\d{4})" + _TIME + _TZ + "$")
_NUM = re.compile(r"^(?P<y>\d{4})[/.-](?P<m>\d{1,2})[/.-](?P<d>\d{1,2})" + _TIME + _TZ + "$")
_DMY = re.compile(r"^(?P<d>\d{1,2})/(?P<m>\d{1,2})/(?P<y>\d{4})" + _TIME + _TZ + "$")
_ONLY_TIME = re.compile(r"^(?P<h>\d{1,2}):(?P<mi>\d{2})(?:\s*(?P<ap>[AaPp][Mm]))?" + _TZ + "$")
_TZ_OFFSET = re.compile(r"^(?:GMT|UTC)\s*(?P<sign>[+-])(?P<h>\d{1,2})(?::?(?P<m>\d{2}))?$", re.I)
_TRAILING_ZONE = re.compile(r"\(([^()]{1,40})\)\s*$")
_TZ_NAMES = {"JST": "Asia/Tokyo", "UTC": "UTC", "GMT": "UTC", "KST": "Asia/Seoul"}


def _zone(name: str | None, default: tzinfo) -> tzinfo:
    if not name:
        return default
    name = name.strip()
    m = _TZ_OFFSET.match(name)
    if m:
        delta = timedelta(hours=int(m["h"]), minutes=int(m["m"] or 0))
        return timezone(-delta if m["sign"] == "-" else delta)
    try:
        return ZoneInfo(_TZ_NAMES.get(name.upper(), name))
    except (ZoneInfoNotFoundError, ValueError):
        return default


def _moment(m: re.Match[str], day: date, zone: tzinfo) -> datetime | None:
    if m["h"] is None:
        return None
    hour, minute = int(m["h"]), int(m["mi"])
    ap = (m["ap"] or "").lower()
    if ap == "pm" and hour < 12:
        hour += 12
    elif ap == "am" and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        raise ValueError
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=_zone(m["tz"], zone))


def _one(text: str, zone: tzinfo) -> tuple[date, datetime | None] | None:
    text = text.strip().lstrip("@").strip()
    for pattern in (_JP, _NUM, _EN, _DMY):
        m = pattern.match(text)
        if not m:
            continue
        try:
            if pattern is _EN:
                month = _MONTHS.get(m["mon"][:3].lower())
                if month is None:
                    return None
            else:
                month = int(m["m"])
            day = date(int(m["y"]), month, int(m["d"]))
            return day, _moment(m, day, zone)
        except ValueError:
            return None
    return None


def parse_date(text: str, zone: tzinfo) -> dict[str, Any] | None:
    """A date as Notion writes it in CSV (its language decides the form: ``2026年10月7日``,
    ``October 7, 2026``, ``2026/10/07``), with a time (``10:00``, ``10:00 AM``), a zone
    (``(JST)``, ``(GMT+9)``) and a range (``… → …``, the end may be a time alone). A time
    without a zone is in `zone`. The stored form of a date property (dbschema), or None."""
    parts = [p.strip() for p in text.split("→")]
    if not parts[0] or len(parts) > 2:
        return None
    trailing = _TRAILING_ZONE.search(text)
    if trailing and len(parts) == 2 and not _TRAILING_ZONE.search(parts[0]):
        zone = _zone(trailing.group(1), zone)  # "3:30 PM → 5:00 PM (GMT+2)": both in it
    first = _one(parts[0], zone)
    if first is None:
        return None
    end: tuple[date, datetime | None] | None = None
    if len(parts) == 2:
        # "3:30 PM (GMT+2) → 5:00 PM": the end is in the start's zone
        end_zone = first[1].tzinfo if first[1] is not None and first[1].tzinfo else zone
        end = _one(parts[1], end_zone)
        if end is None:
            m = _ONLY_TIME.match(parts[1])
            if m is None:
                return None
            try:
                end = first[0], _moment(m, first[0], end_zone)
            except ValueError:
                return None
    start_day, start_at = first
    if start_at is not None or (end is not None and end[1] is not None):
        start = start_at or datetime(start_day.year, start_day.month, start_day.day, tzinfo=zone)
        finish = None
        if end is not None:
            finish = end[1] or datetime(end[0].year, end[0].month, end[0].day, tzinfo=zone)
            if finish < start:
                return None
        return {
            "start": start.isoformat(),
            "end": finish.isoformat() if finish else None,
            "time": True,
        }
    if end is not None and end[0] < start_day:
        return None
    return {
        "start": start_day.isoformat(),
        "end": end[0].isoformat() if end is not None else None,
        "time": False,
    }


_REL_ITEM = re.compile(
    r"\s*(?P<title>[^,]*?)\s*\((?P<link>[^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:,|$)"
)


def parse_relation(text: str) -> list[tuple[str, str]] | None:
    """``Title (path%20<id>.md), Other (https://www.notion.so/Other-<id>)`` → [(title, id)];
    None when the cell is not such a list."""
    out: list[tuple[str, str]] = []
    pos = 0
    text = text.strip()
    while pos < len(text):
        m = _REL_ITEM.match(text, pos)
        if not m or m.end() == pos:
            return None
        nid = notion_id_of(m["link"])
        if nid is None:
            return None
        out.append((m["title"], nid))
        pos = m.end()
    return out or None


YES = {"yes", "true", "✓", "✔", "はい"}
NO = {"no", "false", "いいえ"}
MAX_CHOICES = 50
MAX_OPTION_NAME = 100


def split_multi(text: str) -> list[str]:
    return [p.strip() for p in text.split(",") if p.strip()]


@dataclass
class Guess:
    type: str
    note: str = ""
    number_format: str | None = None
    target: str | None = None  # relation: the database's Notion id


DATE_NAMES = {
    "date",
    "dates",
    "日付",
    "日時",
    "期日",
    "期限",
    "期間",
    "締切",
    "締め切り",
    "due",
    "when",
}


def guess_type(
    values: list[str],
    *,
    name: str = "",
    people: dict[str, str],
    zone: ZoneInfo,
    row_db: dict[str, str],
) -> Guess:
    """WIKI.md §6.3, in a fixed order over the column's non-empty cells. `people`: a name →
    user id; `row_db`: a row's Notion id → its database's Notion id (relations)."""
    cells = [v.strip() for v in values if v.strip()]
    if not cells:
        # Nothing to go by: a column called like a date is one (a calendar can use it).
        if unicodedata.normalize("NFKC", name).strip().casefold() in DATE_NAMES:
            return Guess("date", "空の列（名前から）")
        return Guess("text", "空の列")
    relations = [parse_relation(c) for c in cells]
    if all(r is not None for r in relations):
        targets = {row_db.get(nid) for r in relations if r for _, nid in r}
        if len(targets) == 1 and None not in targets:
            return Guess("relation", target=targets.pop())
        return Guess("text", "関係（取り込んだ 1 つのデータベースの行ではない）→ 題名の文字")
    if all(c.casefold() in YES | NO for c in cells):
        return Guess("checkbox")
    numbers = [ds.number_from_text(c) for c in cells]
    if all(n is not None for n in numbers):
        fmt = "number"
        if all(c.endswith("%") for c in cells):
            fmt = "percent"
        elif all(c.startswith(("¥", "￥")) or c.endswith("円") for c in cells):
            fmt = "yen"
        return Guess("number", number_format=fmt)
    if all(parse_date(c, zone) is not None for c in cells):
        return Guess("date")
    if all(ds.is_url(c) and len(c) <= ds.MAX_URL for c in cells):
        return Guess("url")
    if people and all(
        all(_name_key(n) in people for n in split_multi(c)) and split_multi(c) for c in cells
    ):
        return Guess("person")
    long_or_lines = any(len(c) > MAX_OPTION_NAME or "\n" in c for c in cells)
    if not long_or_lines:
        items = [i for c in cells for i in split_multi(c)]
        distinct = set(items)
        if (
            any(len(split_multi(c)) > 1 for c in cells)
            and len(distinct) <= MAX_CHOICES
            and len(items) > len(distinct)
            and all(len(i) <= MAX_OPTION_NAME for i in items)
        ):
            return Guess("multi_select")
        if len(set(cells)) <= MAX_CHOICES and len(cells) > len(set(cells)):
            return Guess("select")
    return Guess("text")


def _name_key(name: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", name).casefold().split())


def name_key(name: str) -> str:
    return _name_key(name)


# --- Markdown ------------------------------------------------------------------------------------

_FENCE = re.compile(r"^(?:>\s?)*\s*(```|~~~)")


def strip_code(text: str) -> str:
    """The text with fenced blocks and inline code blanked (for finding links)."""
    out = []
    fence: str | None = None
    for line in text.split("\n"):
        m = _FENCE.match(line)
        if fence is not None:
            if m and m.group(1) == fence:
                fence = None
            out.append("")
            continue
        if m:
            fence = m.group(1)
            out.append("")
            continue
        out.append(re.sub(r"(`+)(?:(?!\1).)+?\1", lambda x: " " * len(x.group(0)), line))
    return "\n".join(out)


_ASIDE_OPEN = re.compile(r"^\s*<aside>\s*$")
_ASIDE_CLOSE = re.compile(r"^\s*</aside>\s*$")
_DETAILS_OPEN = re.compile(r"^\s*<details>\s*$")
_DETAILS_CLOSE = re.compile(r"^\s*</details>\s*$")
_SUMMARY = re.compile(r"^\s*<summary>(?P<text>.*?)</summary>\s*$")
_STRIP_TAGS = re.compile(
    r"</?(?:span|u|mark|font|div|p|sup|sub|b|i|em|strong|s|del|ins|small|big|center|figure|"
    r"figcaption|summary|details|aside|code|kbd|table|thead|tbody|tr|td|th|colgroup|col)"
    r"(?:\s[^<>]*)?/?>",
    re.I,
)
_BR = re.compile(r"<br\s*/?>", re.I)
_IMG = re.compile(r"<img\s[^<>]*?src=\"(?P<src>[^\"]+)\"[^<>]*>", re.I)


@dataclass
class Converted:
    body: str
    unsupported: dict[str, int] = field(default_factory=dict)

    def count(self, what: str, n: int = 1) -> None:
        self.unsupported[what] = self.unsupported.get(what, 0) + n


_BLOCK_START = re.compile(r"^\s*(?:[-*+] |\d+[.)] |#|>|\||```|~~~|\$\$|!\[)")
# Characters that are icons although Unicode does not call them symbols (So).
_ICON_EXTRA = frozenset("\u203c\u2049\u2139\u303d")  # double exclamation, ⁉, information, 〽
# M149 (WIKI.md §22.5): at most two containers deep (a toggle in a callout).
MAX_CONTAINER_DEPTH = 2


def is_icon(text: str) -> bool:
    """A callout's icon as Notion writes it: an emoji of at most 4 characters (U+FE0F
    included). No ASCII (no word, no Markdown block start) and at least one symbol, so a short
    Japanese word or 「…」 is not taken for an icon."""
    if not text or len(text) > 4 or any(c.isascii() for c in text):
        return False
    return any(unicodedata.category(c) == "So" or c in _ICON_EXTRA for c in text)


def _icon_first(inner: list[str]) -> list[str]:
    """A callout's icon (Notion writes it alone on the first line) in front of its first line
    of text, as ``> 💡 text`` (a callout written as a quote: deeper than MAX_CONTAINER_DEPTH)."""
    if len(inner) < 2:
        return inner
    icon = inner[0].strip()
    if not is_icon(icon):
        return inner
    k = 1
    while k < len(inner) and not inner[k].strip():
        k += 1
    if k >= len(inner) or _BLOCK_START.match(inner[k]):
        return inner
    return [f"{icon} {inner[k].strip()}", *inner[k + 1 :]]


def _code_lines(lines: list[str]) -> list[bool]:
    """Which lines are fenced code (the fences too)."""
    out: list[bool] = []
    fence: str | None = None
    for line in lines:
        m = _FENCE.match(line)
        if fence is not None:
            out.append(True)
            if m and m.group(1) == fence:
                fence = None
        elif m:
            fence = m.group(1)
            out.append(True)
        else:
            out.append(False)
    return out


def _trim(lines: list[str]) -> list[str]:
    """Without the empty lines at the start and the end."""
    start, end = 0, len(lines)
    while start < end and not lines[start].strip():
        start += 1
    while end > start and not lines[end - 1].strip():
        end -= 1
    return lines[start:end]


def _closing(lines: list[str], code: list[bool], i: int, opener: re.Pattern[str]) -> int:
    """The index of the line that closes the block opened at `i` (or len(lines))."""
    close = _ASIDE_CLOSE if opener is _ASIDE_OPEN else _DETAILS_CLOSE
    j = i + 1
    depth = 1
    while j < len(lines):
        if code[j]:
            pass
        elif opener.match(lines[j]):
            depth += 1
        elif close.match(lines[j]):
            depth -= 1
            if depth == 0:
                break
        j += 1
    return j


def _blocks(lines: list[str], out: Converted, depth: int = 0) -> list[str]:
    """``<aside>`` → ``::: callout <icon>`` … ``:::``, ``<details>`` with its ``<summary>`` →
    ``::: toggle <summary>`` … ``:::`` (M149, WIKI.md §22.5). `depth` is the number of
    containers around: a third one is written the old way (M125), a callout as a quote, a
    toggle as a list item with its content one level down, so the body always reads as meant."""
    result: list[str] = []
    code = _code_lines(lines)
    i = 0
    while i < len(lines):
        line = lines[i]
        if code[i]:
            result.append(line)
            i += 1
            continue
        if _ASIDE_OPEN.match(line):
            j = _closing(lines, code, i, _ASIDE_OPEN)
            nested = depth < MAX_CONTAINER_DEPTH
            inner = _trim(_blocks(lines[i + 1 : j], out, depth + 1 if nested else depth))
            if nested:
                icon = inner[0].strip() if inner else ""
                if is_icon(icon):
                    inner = _trim(inner[1:])
                else:
                    icon = ""
                result.append(f"::: callout {icon}".rstrip())
                result.extend(inner)
                result.append(":::")
            else:
                inner = _icon_first(inner)
                result.extend(f"> {x}" if x.strip() else ">" for x in inner)
                out.count("コールアウト（3 段目の入れ子）→ 引用")
            i = j + 1
            continue
        if _DETAILS_OPEN.match(line):
            j = _closing(lines, code, i, _DETAILS_OPEN)
            inner = lines[i + 1 : j]
            summary = ""
            if inner and _SUMMARY.match(inner[0]):
                summary = _SUMMARY.match(inner[0])["text"]  # type: ignore[index]
                inner = inner[1:]
            summary = " ".join(summary.split())
            nested = depth < MAX_CONTAINER_DEPTH
            inner = _trim(_blocks(inner, out, depth + 1 if nested else depth))
            if nested:
                result.append(f"::: toggle {summary}".rstrip())
                result.extend(inner)
                result.append(":::")
            else:
                result.append(f"- {summary or '…'}")
                result.extend(f"    {x}" if x.strip() else "" for x in inner)
                out.count("トグル（3 段目の入れ子）→ 箇条書き")
            i = j + 1
            continue
        result.append(line)
        i += 1
    return result


# --- callouts the M125 import wrote as quotes (M149, app.cli wiki-rewrite-callouts) ---------------

_TOP_FENCE = re.compile(r"^\s*(```|~~~)")
_QUOTE = re.compile(r"^>[ ]?")
_CONTAINER_OPEN = re.compile(r"^:::[ \t]*(?:callout|toggle)(?:[ \t]|$)")
_CONTAINER_CLOSE = re.compile(r"^:::[ \t]*$")


def _quote_callout_head(line: str) -> tuple[str, str] | None:
    """(icon, text) when a quote line begins with a callout's icon (``> 💡`` / ``> 💡 text``)."""
    m = _QUOTE.match(line)
    if m is None:
        return None
    content = line[m.end() :].strip()
    if not content or _BLOCK_START.match(content):
        return None
    icon, _, rest = content.partition(" ")
    if not is_icon(icon):
        return None
    return icon, rest.strip()


def rewrite_quote_callouts(body: str, depth: int = 0) -> str:
    """The callouts the M125 import wrote as quotes (``> 💡 text`` and the quote lines after it)
    as ``::: callout 💡`` … ``:::`` (WIKI.md §22.5). A run of quote lines is a callout when its
    first line begins with an icon (is_icon, as the import decided); the run, unquoted, is its
    content, where a nested ``> 💡`` run is a nested callout (two deep at most: deeper stays a
    quote). Fenced code, quotes without an icon and the containers already there stay as they
    are; a body without such callouts comes back unchanged (so running it again changes
    nothing). `depth`: the containers around `body`."""
    lines = body.split("\n")
    out: list[str] = []
    fence: str | None = None
    open_containers = 0
    i = 0
    while i < len(lines):
        line = lines[i]
        m = _TOP_FENCE.match(line)
        if fence is not None:
            if m and m.group(1) == fence:
                fence = None
            out.append(line)
            i += 1
            continue
        if m:
            fence = m.group(1)
            out.append(line)
            i += 1
            continue
        if _CONTAINER_OPEN.match(line):
            open_containers += 1
        elif _CONTAINER_CLOSE.match(line) and open_containers:
            open_containers -= 1
        if not line.startswith(">"):
            out.append(line)
            i += 1
            continue
        j = i
        while j < len(lines) and lines[j].startswith(">"):
            j += 1
        head = _quote_callout_head(line)
        if head is None or depth + open_containers >= MAX_CONTAINER_DEPTH:
            out.extend(lines[i:j])  # a quote (or too deep): as it is, nested quotes included
            i = j
            continue
        icon, text = head
        inner = [_QUOTE.sub("", x, count=1) for x in lines[i + 1 : j]]
        inner = _trim([text, *inner] if text else inner)
        content = rewrite_quote_callouts("\n".join(inner), depth + open_containers + 1)
        out.append(f"::: callout {icon}")
        if content:
            out.extend(content.split("\n"))
        out.append(":::")
        i = j
    return "\n".join(out)


LinkFn = Callable[[Link, str], str | None]


def _rewrite_text(text: str, link_fn: LinkFn, bare_fn: Callable[[str], str], out: Converted) -> str:
    """Links (through link_fn), bare notion.so URLs and HTML in a piece of text (no code)."""
    if "<" in text:
        text = _IMG.sub(lambda m: f"![]({m['src']})", text)
        text, n = _BR.subn(" ", text) if text.lstrip().startswith("|") else _BR.subn("\n", text)
        if n:
            out.count("HTML の改行", n)
        text, n = _STRIP_TAGS.subn("", text)
        if n:
            out.count("HTML のタグ（文字だけ残す）", n)
    pieces: list[str] = []
    pos = 0
    for link in find_links(text):
        pieces.append(bare_fn(text[pos : link.start]))
        replaced = link_fn(link, text[link.start : link.end])
        pieces.append(text[link.start : link.end] if replaced is None else replaced)
        pos = link.end
    pieces.append(bare_fn(text[pos:]))
    return "".join(pieces)


def convert_markdown(
    body: str,
    *,
    link_fn: LinkFn,
    bare_fn: Callable[[str], str],
    mention_fn: Callable[[str], str],
) -> Converted:
    """A Notion page's Markdown in the canvas dialect (WIKI.md §6.2). Code is left alone."""
    out = Converted("")
    lines = _blocks(body.replace("\r\n", "\n").split("\n"), out)
    result: list[str] = []
    fence: str | None = None
    for line in lines:
        m = _FENCE.match(line)
        if fence is not None:
            if m and m.group(1) == fence:
                fence = None
            result.append(line)
            continue
        if m:
            fence = m.group(1)
            result.append(line)
            continue
        parts = re.split(r"((`+)(?:(?!\2).)+?\2)", line)
        rebuilt: list[str] = []
        k = 0
        while k < len(parts):
            piece = parts[k]
            if k % 3 == 0:
                rebuilt.append(mention_fn(_rewrite_text(piece, link_fn, bare_fn, out)))
                k += 1
            else:
                rebuilt.append(piece)
                k += 2
        result.append("".join(rebuilt))
    text = "\n".join(result)
    text = re.sub(r"\n{4,}", "\n\n\n", text).strip("\n")
    out.body = text + "\n" if text else ""
    return out


def split_long(body: str, limit: int) -> list[str]:
    """A body longer than `limit` in pieces at line ends (WIKI.md §6.2: the rest goes to
    「（続き n）」 pages)."""
    if len(body) <= limit:
        return [body]
    pieces: list[str] = []
    current: list[str] = []
    size = 0
    for line in body.split("\n"):
        while len(line) > limit:
            if current:
                pieces.append("\n".join(current))
                current, size = [], 0
            pieces.append(line[:limit])
            line = line[limit:]
        if size + len(line) + 1 > limit and current:
            pieces.append("\n".join(current))
            current, size = [], 0
        current.append(line)
        size += len(line) + 1
    if current:
        pieces.append("\n".join(current))
    return pieces


def label_text(text: str) -> str:
    """A link label without the brackets that would end it."""
    return " ".join(text.replace("[", "\uff3b").replace("]", "\uff3d").split())


def display_name(path: str) -> str:
    name = posixpath.basename(path)
    decoded = unquote(name)
    return unicodedata.normalize("NFC", decoded if decoded != name else name)
