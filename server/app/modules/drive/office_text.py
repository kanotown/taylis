"""The text of Word / Excel / PowerPoint (OOXML) and OpenDocument files, read straight from the
package for the drive's full-text search (docs/DRIVE.md §29.6, 2026-10-25).

Standard library only: zipfile for the package, expat (pyexpat) as a stream for the XML, so no
tree is built and a part is never held whole. The package is read through `RangedReader`, a
seekable file over ranged reads of the object (a block cache in front): zipfile reads the end of
the file, the central directory and only the members asked for, so a 1.7 GB presentation full of
videos costs its slides' XML and a few blocks, never its media.

What is read:
- pptx / pptm / potx / ppsx: the slides in the presentation's order (p:sldIdLst through
  ppt/_rels/presentation.xml.rels; else slideN.xml in numeric order), each slide's a:t runs then
  its notes slide's; one page a slide (page_unit "slide"). Fields (a:fld: slide numbers, dates)
  are left out.
- docx / docm / dotx: word/document.xml (or the main part the package's rels name), w:t runs,
  a line a paragraph; tabs and breaks as spaces / lines. One body, no pages (a Word file's pages
  exist only once it is laid out).
- xlsx / xlsm / xltx: the shared strings (without the phonetic runs, rPh: the furigana) and each
  worksheet in the workbook's order, string cells and inline / formula strings (numbers, dates and
  booleans are not text), a cell a word, a row a line; one page a sheet (page_unit "sheet").
- odt / ods / odp (and the templates): content.xml, text:p / text:h; a page a draw:page for a
  presentation ("slide"), a table:table for a spreadsheet ("sheet").

Guards: a package that is a CFB (OLE) file is an encrypted OOXML file (Office wraps the encrypted
package in one) and is skipped `encrypted`; a zip member encrypted the zip way likewise; at most
`max_xml_bytes` of uncompressed XML are parsed in all (whatever the members declare: a zip bomb
stops there), the central directory may be at most MAX_SINGLE_READ, at most twice that of bytes
are fetched, a DOCTYPE (never in OOXML / ODF; entity expansion) fails the file, and the deadline
is checked between reads. The text is normalised as the PDFs' (pdf_text.clean) and capped at
`max_bytes` of UTF-8.

Runs in a worker thread (texts.read_package): every call here is blocking.
"""

import logging
import posixpath
import re
import time
import zipfile
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from io import RawIOBase
from typing import IO, Any
from xml.parsers import expat

from app.modules.attachments.pdf_text import clean, cut

CFB_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
BLOCK = 32 * 1024
CACHE_BLOCKS = 128  # 4 MiB of blocks at most
# One read() of the package: zipfile reads the whole central directory at once. A larger one is
# a package of hundreds of thousands of members (or a lie): not read.
MAX_SINGLE_READ = 8 * 1024 * 1024
CHUNK = 256 * 1024  # uncompressed bytes fed to the parser at a time
# Shared strings kept for the cells (characters): enough for any workbook a person reads.
MAX_SHARED_CHARS = 8 * 1024 * 1024

PRESENTATION = "presentation"
DOCUMENT = "document"
WORKBOOK = "workbook"

_REL_OFFICE_DOCUMENT = "/officeDocument"
_ODF_TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
_ODF_TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
_ODF_DRAW = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
log = logging.getLogger("app.drive.texts")
_SLIDE_NAME = re.compile(r"^ppt/slides/slide(\d+)\.xml$")


class Stop(Exception):
    """The package cannot be read further: `reason` (too_large, timeout, unreadable)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class StoreError(Exception):
    """The object store failed (a temporary failure: the caller retries later)."""


def local(name: str) -> str:
    """The local part of an expat name ("namespace local", as namespace_separator=" ")."""
    return name.rpartition(" ")[2]


# --- reading the object -------------------------------------------------------------------------


class RangedReader(RawIOBase):
    """A read-only, seekable file over `fetch(start, end)` (bytes start..end, both inclusive: a
    ranged GET), in BLOCK-sized blocks kept in a small LRU cache. Only what is read is fetched;
    `fetched` and `requests` say how much."""

    def __init__(
        self,
        fetch: Callable[[int, int], bytes],
        size: int,
        *,
        max_fetch: int,
        deadline: float | None = None,
    ) -> None:
        super().__init__()
        self._fetch = fetch
        self.size = size
        self.max_fetch = max_fetch
        self.deadline = deadline
        self.pos = 0
        self.fetched = 0
        self.requests = 0
        self._blocks: OrderedDict[int, bytes] = OrderedDict()

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = 0) -> int:
        if whence == 0:
            pos = offset
        elif whence == 1:
            pos = self.pos + offset
        elif whence == 2:
            pos = self.size + offset
        else:
            raise ValueError(f"bad whence {whence}")
        if pos < 0:
            raise OSError("negative seek position")
        self.pos = pos
        return pos

    def readinto(self, buffer: Any) -> int:
        view = memoryview(buffer).cast("B")
        want = len(view)
        if want > MAX_SINGLE_READ:
            raise Stop("too_large")
        end = min(self.pos + want, self.size)
        if end <= self.pos:
            return 0
        first, last = self.pos // BLOCK, (end - 1) // BLOCK
        self._load(first, last)
        done = 0
        for number in range(first, last + 1):
            block = self._blocks[number]
            self._blocks.move_to_end(number)
            lo = max(self.pos, number * BLOCK) - number * BLOCK
            hi = min(end, (number + 1) * BLOCK) - number * BLOCK
            view[done : done + hi - lo] = block[lo:hi]
            done += hi - lo
        self.pos = end
        return done

    def _load(self, first: int, last: int) -> None:
        """Fetches the missing blocks first..last, each run of them in one ranged read."""
        number = first
        while number <= last:
            if number in self._blocks:
                number += 1
                continue
            run_end = number
            while run_end + 1 <= last and run_end + 1 not in self._blocks:
                run_end += 1
            start = number * BLOCK
            stop = min((run_end + 1) * BLOCK, self.size) - 1
            if self.deadline is not None and time.monotonic() > self.deadline:
                raise Stop("timeout")
            if self.fetched + stop - start + 1 > self.max_fetch:
                raise Stop("too_large")
            data = self._fetch(start, stop)
            if len(data) != stop - start + 1:
                raise StoreError(f"asked for {stop - start + 1} bytes, got {len(data)}")
            self.fetched += len(data)
            self.requests += 1
            for at in range(number, run_end + 1):
                offset = (at - number) * BLOCK
                self._blocks[at] = data[offset : offset + BLOCK]
            while len(self._blocks) > max(CACHE_BLOCKS, last - first + 1):
                self._blocks.popitem(last=False)
            number = run_end + 1


# --- the text, page by page -------------------------------------------------------------------


class Body:
    """The text as pdf_text writes a PDF's: each page cleaned, a line between pages, where each
    page begins (characters), cut at `max_bytes` of UTF-8."""

    def __init__(self, max_bytes: int) -> None:
        self.max_bytes = max_bytes
        self.parts: list[str] = []
        self.starts: list[int] = []
        self.length = 0
        self.size = 0
        self.truncated = False
        self._raw: list[str] = []
        self._raw_chars = 0
        self._open = False

    @property
    def full(self) -> bool:
        return self.truncated

    def begin(self) -> None:
        self.end()
        if not self.full:
            self._open = True
            self.starts.append(self.length)

    def add(self, text: str) -> None:
        if not self._open or self.full:
            return
        self._raw.append(text)
        self._raw_chars += len(text)
        # NFKC rarely lengthens text much: twice what is left (and a margin) is enough to fill
        # the cap; more would only be cut.
        if self._raw_chars > 2 * (self.max_bytes - self.size) + 4096:
            self.end()
            self.truncated = True

    def end(self) -> None:
        if not self._open:
            return
        self._open = False
        text = clean("".join(self._raw), join_lines=False)
        self._raw, self._raw_chars = [], 0
        piece = text + "\n"
        piece_size = len(piece.encode("utf-8"))
        if self.size + piece_size > self.max_bytes:
            piece = cut(piece, self.max_bytes - self.size)
            self.truncated = True
        self.parts.append(piece)
        self.length += len(piece)
        self.size += len(piece.encode("utf-8"))

    def text(self) -> str:
        self.end()
        return "".join(self.parts).rstrip("\n")


@dataclass
class PackageText:
    status: str  # ready | skipped | failed
    reason: str | None = None
    body: str = ""
    page_starts: list[int] | None = None
    pages: int | None = None
    page_unit: str | None = None  # slide | sheet (None: no pages)
    truncated: bool = False
    members: list[str] = field(default_factory=list)  # the members parsed (for the tests)


# --- the XML, as a stream ----------------------------------------------------------------------


class Handler:
    def start(self, name: str, attrs: dict[str, str]) -> None:
        return None

    def end(self, name: str) -> None:
        return None

    def chars(self, data: str) -> None:
        return None


class Budget:
    """The uncompressed XML left to parse in this file, and the deadline."""

    def __init__(self, max_xml_bytes: int, deadline: float | None) -> None:
        self.left = max_xml_bytes
        self.deadline = deadline
        self.exhausted = False


def _no_dtd(*_: Any) -> None:
    raise Stop("unreadable")


def parse(member: IO[bytes], handler: Handler, budget: Budget, body: Body | None = None) -> None:
    """Feeds the member to expat in CHUNKs until it ends, the budget is spent (budget.exhausted)
    or the text is full."""
    parser = expat.ParserCreate(namespace_separator=" ")
    parser.buffer_text = True
    parser.StartElementHandler = handler.start
    parser.EndElementHandler = handler.end
    parser.CharacterDataHandler = handler.chars
    # Never in OOXML or ODF: no DTD, so no entity can expand.
    parser.StartDoctypeDeclHandler = _no_dtd
    parser.EntityDeclHandler = _no_dtd
    while True:
        if budget.deadline is not None and time.monotonic() > budget.deadline:
            raise Stop("timeout")
        if budget.left <= 0:
            budget.exhausted = True
            return
        chunk = member.read(min(CHUNK, budget.left))
        if not chunk:
            break
        budget.left -= len(chunk)
        try:
            parser.Parse(chunk, False)
        except expat.ExpatError as exc:
            raise Stop("unreadable") from exc
        if body is not None and body.full:
            return
    try:
        parser.Parse(b"", True)
    except expat.ExpatError as exc:
        raise Stop("unreadable") from exc


class Runs(Handler):
    """DrawingML (a:t in a:p) and WordprocessingML (w:t in w:p) text: the t elements' text, a
    line a paragraph. Fields (a:fld) and the fallback copies of drawings (mc:Fallback) are left
    out."""

    SKIP = frozenset({"fld", "Fallback"})

    def __init__(self, body: Body) -> None:
        self.body = body
        self.in_t = False
        self.skip = 0

    def start(self, name: str, attrs: dict[str, str]) -> None:
        if self.skip:
            self.skip += 1
            return
        tag = local(name)
        if tag in self.SKIP:
            self.skip = 1
        elif tag == "t":
            self.in_t = True
        elif tag in ("br", "cr"):
            self.body.add("\n")
        elif tag == "tab":
            self.body.add(" ")

    def end(self, name: str) -> None:
        if self.skip:
            self.skip -= 1
            return
        tag = local(name)
        if tag == "t":
            self.in_t = False
        elif tag == "p":
            self.body.add("\n")

    def chars(self, data: str) -> None:
        if self.in_t and not self.skip:
            self.body.add(data)


class Rels(Handler):
    """A part's relationships: [(id, type, target)] (external ones left out)."""

    def __init__(self) -> None:
        self.found: list[tuple[str, str, str]] = []

    def start(self, name: str, attrs: dict[str, str]) -> None:
        if local(name) == "Relationship" and attrs.get("TargetMode") != "External":
            self.found.append((attrs.get("Id", ""), attrs.get("Type", ""), attrs.get("Target", "")))


class SlideIds(Handler):
    """presentation.xml's p:sldIdLst: the slides' relationship ids in order."""

    def __init__(self) -> None:
        self.ids: list[str] = []

    def start(self, name: str, attrs: dict[str, str]) -> None:
        if local(name) == "sldId":
            for key, value in attrs.items():
                # r:id: the relationships namespace (transitional or strict), local name "id".
                if " " in key and local(key) == "id":
                    self.ids.append(value)


class Sheets(Handler):
    """workbook.xml's sheets: their relationship ids in the workbook's order."""

    def __init__(self) -> None:
        self.ids: list[str] = []

    def start(self, name: str, attrs: dict[str, str]) -> None:
        if local(name) == "sheet":
            for key, value in attrs.items():
                if " " in key and local(key) == "id":
                    self.ids.append(value)


class SharedStrings(Handler):
    """xl/sharedStrings.xml: each si's text (rich text runs joined, phonetic runs left out)."""

    def __init__(self) -> None:
        self.strings: list[str] = []
        self.chars_kept = 0
        self.dropped = False
        self._buf: list[str] = []
        self._in_t = False
        self._skip = 0

    def start(self, name: str, attrs: dict[str, str]) -> None:
        if self._skip:
            self._skip += 1
            return
        tag = local(name)
        if tag == "rPh":
            self._skip = 1
        elif tag == "si":
            self._buf = []
        elif tag == "t":
            self._in_t = True

    def end(self, name: str) -> None:
        if self._skip:
            self._skip -= 1
            return
        tag = local(name)
        if tag == "t":
            self._in_t = False
        elif tag == "si":
            text = "".join(self._buf)
            if self.chars_kept + len(text) > MAX_SHARED_CHARS:
                text, self.dropped = "", True
            self.chars_kept += len(text)
            self.strings.append(text)

    def chars(self, data: str) -> None:
        if self._in_t and not self._skip:
            self._buf.append(data)


class Cells(Handler):
    """A worksheet's text cells: shared strings (t="s"), inline strings, formula strings; a cell
    a word, a row a line."""

    def __init__(self, body: Body, strings: list[str]) -> None:
        self.body = body
        self.strings = strings
        self._type: str | None = None
        self._buf: list[str] = []
        self._collect = False
        self._in_is = False
        self._skip = 0

    def start(self, name: str, attrs: dict[str, str]) -> None:
        if self._skip:
            self._skip += 1
            return
        tag = local(name)
        if tag == "c":
            self._type, self._buf = attrs.get("t"), []
        elif tag == "is":
            self._in_is = True
        elif tag == "rPh":
            self._skip = 1
        elif tag == "v" or (tag == "t" and self._in_is):
            self._collect = True

    def end(self, name: str) -> None:
        if self._skip:
            self._skip -= 1
            return
        tag = local(name)
        if tag in ("v", "t"):
            self._collect = False
        elif tag == "is":
            self._in_is = False
        elif tag == "c":
            value = "".join(self._buf).strip()
            text = ""
            if self._type == "s":
                try:
                    index = int(value)
                except ValueError:
                    index = -1
                if 0 <= index < len(self.strings):
                    text = self.strings[index]
            elif self._type in ("inlineStr", "str"):
                text = value
            if text:
                self.body.add(text + " ")
        elif tag == "row":
            self.body.add("\n")

    def chars(self, data: str) -> None:
        if self._collect:
            self._buf.append(data)


class OdfText(Handler):
    """content.xml of an OpenDocument file: text:p / text:h, a line each (a cell a word in a
    spreadsheet); a new page at each draw:page (`page_tag` "draw") or table:table ("table")."""

    def __init__(self, body: Body, page_tag: str | None) -> None:
        self.body = body
        self.page_tag = page_tag
        self.pages = 0
        self._depth = 0  # open text:p / text:h

    def start(self, name: str, attrs: dict[str, str]) -> None:
        namespace, _, tag = name.rpartition(" ")
        if (self.page_tag == "draw" and namespace == _ODF_DRAW and tag == "page") or (
            self.page_tag == "table" and namespace == _ODF_TABLE and tag == "table"
        ):
            self.pages += 1
            self.body.begin()
        elif namespace == _ODF_TEXT:
            if tag in ("p", "h"):
                self._depth += 1
            elif tag == "s":
                self.body.add(" ")
            elif tag == "tab":
                self.body.add(" ")
            elif tag == "line-break":
                self.body.add("\n")

    def end(self, name: str) -> None:
        namespace, _, tag = name.rpartition(" ")
        if namespace == _ODF_TEXT and tag in ("p", "h"):
            self._depth -= 1
            self.body.add(" " if self.page_tag == "table" else "\n")
        elif self.page_tag == "table" and namespace == _ODF_TABLE and tag == "table-row":
            self.body.add("\n")

    def chars(self, data: str) -> None:
        if self._depth > 0:
            self.body.add(data)


# --- the package ---------------------------------------------------------------------------------


class Package:
    def __init__(self, zf: zipfile.ZipFile, budget: Budget) -> None:
        self.zf = zf
        self.budget = budget
        # OPC part names are case-insensitive.
        self.infos = {info.filename.lower(): info for info in zf.infolist() if not info.is_dir()}
        self.parsed: list[str] = []

    def has(self, name: str) -> bool:
        return name.lower() in self.infos

    def parse(self, name: str, handler: Handler, body: Body | None = None) -> bool:
        """Parses the member through `handler`; False when there is no such member."""
        info = self.infos.get(name.lower())
        if info is None:
            return False
        if info.flag_bits & 0x1:
            raise Stop("encrypted")
        self.parsed.append(info.filename)
        with self.zf.open(info) as member:
            parse(member, handler, self.budget, body)
        return True

    def rels(self, part: str) -> list[tuple[str, str, str]]:
        """The relationships of `part` (targets resolved to member names)."""
        folder, _, base = part.rpartition("/")
        handler = Rels()
        self.parse(posixpath.join(folder, "_rels", base + ".rels"), handler)
        return [(rid, kind, resolve(folder, target)) for rid, kind, target in handler.found]

    def read_small(self, name: str, most: int = 256) -> bytes:
        info = self.infos.get(name.lower())
        if info is None:
            return b""
        with self.zf.open(info) as member:
            return member.read(most)


def resolve(folder: str, target: str) -> str:
    if target.startswith("/"):
        return posixpath.normpath(target.lstrip("/"))
    return posixpath.normpath(posixpath.join(folder, target))


def _main_part(package: Package) -> str | None:
    for _, kind, target in package.rels(""):
        if kind.endswith(_REL_OFFICE_DOCUMENT):
            return target
    for name in ("ppt/presentation.xml", "word/document.xml", "xl/workbook.xml"):
        if package.has(name):
            return name
    return None


def _pptx(package: Package, main: str, body: Body) -> tuple[int, str]:
    rels = package.rels(main)
    targets = {rid: target for rid, _, target in rels}
    ids = SlideIds()
    package.parse(main, ids)
    slides = [targets[rid] for rid in ids.ids if rid in targets]
    if not slides:
        numbered = sorted(
            (int(found.group(1)), info.filename)
            for info in package.zf.infolist()
            if (found := _SLIDE_NAME.match(info.filename))
        )
        slides = [name for _, name in numbered]
    for slide in slides:
        if body.full or package.budget.exhausted:
            break
        body.begin()
        package.parse(slide, Runs(body), body)
        for _, kind, target in package.rels(slide):
            if kind.endswith("/notesSlide") and not body.full:
                body.add("\n")
                package.parse(target, Runs(body), body)
    return len(slides), "slide"


def _xlsx(package: Package, main: str, body: Body) -> tuple[int, str]:
    rels = package.rels(main)
    targets = {rid: target for rid, _, target in rels}
    strings = SharedStrings()
    for _, kind, target in rels:
        if kind.endswith("/sharedStrings"):
            package.parse(target, strings)
            break
    sheets = Sheets()
    package.parse(main, sheets)
    order = [targets[rid] for rid in sheets.ids if rid in targets]
    for sheet in order:
        if body.full or package.budget.exhausted:
            break
        body.begin()
        package.parse(sheet, Cells(body, strings.strings), body)
    if strings.dropped:
        body.truncated = True
    return len(order), "sheet"


def _docx(package: Package, main: str, body: Body) -> None:
    body.begin()
    package.parse(main, Runs(body), body)


def _odf(package: Package, body: Body) -> tuple[int | None, str | None]:
    mimetype = package.read_small("mimetype").decode("ascii", errors="ignore").strip()
    if mimetype.startswith("application/vnd.oasis.opendocument.presentation"):
        handler = OdfText(body, "draw")
        unit: str | None = "slide"
    elif mimetype.startswith("application/vnd.oasis.opendocument.spreadsheet"):
        handler, unit = OdfText(body, "table"), "sheet"
    else:
        handler, unit = OdfText(body, None), None
        body.begin()
    package.parse("content.xml", handler, body)
    return (handler.pages, unit) if unit else (None, None)


def extract(
    raw: RangedReader, *, max_bytes: int, max_xml_bytes: int, deadline: float | None = None
) -> PackageText:
    """The text of the OOXML / ODF package `raw` (a seekable file: RangedReader)."""
    head = raw.read(8)
    raw.seek(0)
    if head == CFB_MAGIC:
        return PackageText("skipped", "encrypted")
    if not head.startswith(b"PK"):
        return PackageText("failed", "unreadable")
    budget = Budget(max_xml_bytes, deadline)
    body = Body(max_bytes)
    try:
        with zipfile.ZipFile(raw) as zf:
            package = Package(zf, budget)
            pages: int | None = None
            unit: str | None = None
            if package.has("[Content_Types].xml"):
                main = _main_part(package)
                flavour = posixpath.basename(main or "").lower()
                if main is None or not package.has(main):
                    return PackageText("skipped", "unsupported")
                if flavour.startswith(PRESENTATION):
                    pages, unit = _pptx(package, main, body)
                elif flavour.startswith(WORKBOOK):
                    pages, unit = _xlsx(package, main, body)
                elif flavour.startswith(DOCUMENT):
                    _docx(package, main, body)
                else:
                    return PackageText("skipped", "unsupported")
            elif package.has("content.xml"):
                pages, unit = _odf(package, body)
            else:
                return PackageText("skipped", "unsupported")
            parsed = package.parsed
    except Stop as stop:
        if stop.reason == "encrypted":
            return PackageText("skipped", "encrypted")
        return PackageText("failed", stop.reason)
    except (zipfile.BadZipFile, zipfile.LargeZipFile, NotImplementedError, EOFError) as exc:
        # Broken, or compressed in a way zipfile cannot read.
        log.info("an unreadable package: %s", exc)
        return PackageText("failed", "unreadable")
    except RuntimeError as exc:  # zipfile: "File ... is encrypted, password required"
        if "encrypted" in str(exc):
            return PackageText("skipped", "encrypted")
        raise
    text = body.text()
    truncated = body.truncated or budget.exhausted
    if not any(not ch.isspace() for ch in text):
        return PackageText("skipped", "no_text", pages=pages, page_unit=unit, members=parsed)
    starts = body.starts if unit is not None else None
    return PackageText(
        "ready",
        body=text,
        page_starts=starts,
        pages=pages,
        page_unit=unit,
        truncated=truncated,
        members=parsed,
    )
