"""The text inside drive files, for the full-text search (docs/DRIVE.md §29).

What is read (the current version of a file outside the trash, only):
- a PDF: its own bytes (up to DRIVE_TEXT_MAX_INPUT_BYTES), in a child process (pdf_text.py);
- a Word / Excel / PowerPoint (OOXML: docx, xlsx, pptx and their macro / template forms) or
  OpenDocument file: straight from the package (office_text.py, §29.6), whatever its size, in a
  worker thread through ranged reads of the object (the central directory and the text parts
  only); slides and sheets are its pages;
- a legacy Office file (doc / xls / ppt / rtf): the PDF its preview made (PREVIEWS.md); it waits
  until the preview is ready (the preview loop or `generate-previews --drive` makes it), and is
  skipped when the preview failed (`no_preview`) or cannot be made (`too_large` for the
  converter, `no_preview` with previews off);
- a plain text, Markdown, CSV or TSV file: its first bytes, decoded in the app (UTF-8, UTF-16
  with a BOM, else Shift_JIS / CP932, the encoding of Japanese CSVs from Excel).
Nothing is read from images, videos, archives and the rest. There is no OCR: a scanned PDF (no
text layer) is recorded as skipped (`no_text`), an encrypted one (`encrypted`).

The work is the drive media loop's when it has no media to do (main._drive_media_loop), one
file at a time, and only while no chat attachment waits for its preview (the preview loop is
separate; this never holds it up). `app.cli drive-index` runs the same steps for the files stored
before (resumable, idempotent).

Rows (drive_texts): a claim inserts `working` with a lease (next_at) and counts the try;
another worker skips a leased row; a try cut off by a restart is taken again when the lease runs
out, at most MAX_ATTEMPTS times. A try writes its result only while the row is still its own
(`working`, the same try number); a new version of the file removes the old version's row
(forget_replaced_in_tx), so a slow try for a replaced version writes nothing.
"""

import asyncio
import codecs
import concurrent.futures
import json
import logging
import sys
import tempfile
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import previews, videos
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.models import Attachment
from app.modules.attachments.pdf_text import clean, cut
from app.modules.attachments.preview_kinds import (
    CONTAINER_TYPES,
    OFFICE_EXTENSIONS,
    OFFICE_TYPES,
    PDF_TYPE,
    source_kind,
)
from app.modules.drive import office_text
from app.modules.drive.models import DriveFileVersion, DriveItem, DriveText

log = logging.getLogger("app.drive.texts")

MAX_ATTEMPTS = 3
RETRY = timedelta(minutes=5)
# The child's JSON line: a page count and where each page begins (a 5,000-page PDF fits).
CHILD_MAX_OUTPUT = 256 * 1024
# A PDF with fewer readable characters than this per page has no text layer worth indexing
# (a scan; page numbers alone); no OCR (§29).
MIN_CHARS_PER_PAGE = 2
MIN_CHARS = 4
TEXT_EXTENSIONS = frozenset({"txt", "text", "md", "markdown", "csv", "tsv"})
OCTET = "application/octet-stream"
# §29.6: read straight from the package (office_text.py). Lower case (kind_of compares so).
PACKAGE_TYPES = frozenset(
    {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
        "application/vnd.ms-word.document.macroenabled.12",
        "application/vnd.ms-word.template.macroenabled.12",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
        "application/vnd.ms-excel.sheet.macroenabled.12",
        "application/vnd.ms-excel.template.macroenabled.12",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.openxmlformats-officedocument.presentationml.template",
        "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
        "application/vnd.ms-powerpoint.presentation.macroenabled.12",
        "application/vnd.ms-powerpoint.template.macroenabled.12",
        "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
        "application/vnd.oasis.opendocument.text",
        "application/vnd.oasis.opendocument.text-template",
        "application/vnd.oasis.opendocument.spreadsheet",
        "application/vnd.oasis.opendocument.spreadsheet-template",
        "application/vnd.oasis.opendocument.presentation",
        "application/vnd.oasis.opendocument.presentation-template",
    }
)
PACKAGE_EXTENSIONS = frozenset(
    {
        *("docx", "docm", "dotx", "dotm"),
        *("xlsx", "xlsm", "xltx", "xltm"),
        *("pptx", "pptm", "potx", "potm", "ppsx", "ppsm"),
        *("odt", "ott", "ods", "ots", "odp", "otp"),
    }
)
# §29: through the PDF preview (the converter reads them; nothing here does).
LEGACY_TYPES = frozenset(t for t in OFFICE_TYPES if t not in PACKAGE_TYPES)
LEGACY_EXTENSIONS = frozenset(OFFICE_EXTENSIONS - PACKAGE_EXTENSIONS)


def kind_of(content_type: str, name: str) -> str | None:
    """'pdf', 'package' (OOXML / ODF, read directly), 'office' (legacy, through the preview),
    'text' or None (nothing to read in this file). By the sniffed type; when the sniffer could
    only say "a ZIP / OLE container" (a pptx whose first members are large is stored as
    application/zip), by the name's extension. Which kind of package it is, the package itself
    tells (office_text.extract)."""
    content_type = content_type.lower()
    _, dot, ext = name.rpartition(".")
    if content_type in PACKAGE_TYPES or (
        content_type in CONTAINER_TYPES and dot and ext.lower() in PACKAGE_EXTENSIONS
    ):
        return "package"
    kind = source_kind(content_type, name)
    if kind == "pdf":
        return "pdf"
    if kind is not None:
        return "office"
    if (
        dot
        and ext.lower() in TEXT_EXTENSIONS
        and (content_type == OCTET or content_type.startswith("text/"))
    ):
        return "text"
    return None


def _quoted(values: frozenset[str] | set[str]) -> str:
    return ", ".join(f"'{value}'" for value in sorted(values))


def _extensions(values: frozenset[str] | set[str]) -> str:
    return "|".join(sorted(values))


# Written in SQL with kind_of's rules (kind_of decides again for the row it took).
_PACKAGE = f"""
    (lower(a.content_type) IN ({_quoted(PACKAGE_TYPES)})
     OR (a.content_type IN ({_quoted(CONTAINER_TYPES)})
         AND lower(i.name) ~ '\\.({_extensions(PACKAGE_EXTENSIONS)})$'))
"""
_LEGACY = f"""
    (a.content_type IN ({_quoted(LEGACY_TYPES)})
     OR (a.content_type IN ({_quoted(CONTAINER_TYPES)})
         AND lower(i.name) ~ '\\.({_extensions(LEGACY_EXTENSIONS)})$'))
"""
# A legacy Office file can still get its preview: previews are on with a converter
# (:can_preview) and the file is within the converter's limit (:preview_max). One that cannot
# (2026-10-25: 126 presentations of up to 1.7 GB waited "for their preview" for ever) is not
# waited for: it is taken and recorded as skipped.
_PREVIEW_COMING = """
    (a.preview_status IN ('none', 'pending')
     AND CAST(:can_preview AS boolean) AND a.size_bytes <= :preview_max)
"""
# The current versions of files outside the trash that are ready to be read and have no row
# yet: PDFs, OOXML / ODF packages, legacy Office files whose preview is ready, failed or will
# not come (recorded as skipped), plain text files.
_READABLE = f"""
    (a.content_type = '{PDF_TYPE}'
     OR (a.content_type = '{OCTET}' AND lower(i.name) LIKE '%.pdf')
     OR {_PACKAGE}
     OR ({_LEGACY} AND NOT {_PREVIEW_COMING})
     OR ((a.content_type = '{OCTET}' OR a.content_type LIKE 'text/%')
         AND lower(i.name) ~ '\\.({_extensions(TEXT_EXTENSIONS)})$'))
"""
_CANDIDATE = text(
    f"""
    SELECT v.id AS version_id, i.id AS item_id
    FROM drive_items i
    JOIN drive_file_versions v ON v.id = i.current_version_id
    JOIN attachments a ON a.id = v.attachment_id
    WHERE i.kind = 'file' AND i.trashed_at IS NULL AND a.status <> 'deleted'
      AND NOT EXISTS (SELECT 1 FROM drive_texts t WHERE t.version_id = v.id)
      AND {_READABLE}
    ORDER BY v.id
    LIMIT 1
    FOR UPDATE OF v SKIP LOCKED
    """
)
# Legacy Office files that wait for a preview that can still come (none yet: an import; or
# still being made). OOXML / ODF files never wait (§29.6), nor do the ones too large for the
# converter.
_WAITING_FOR_PREVIEWS = text(
    f"""
    SELECT count(*)
    FROM drive_items i
    JOIN drive_file_versions v ON v.id = i.current_version_id
    JOIN attachments a ON a.id = v.attachment_id
    WHERE i.kind = 'file' AND i.trashed_at IS NULL AND a.status <> 'deleted'
      AND NOT EXISTS (SELECT 1 FROM drive_texts t WHERE t.version_id = v.id)
      AND {_LEGACY} AND {_PREVIEW_COMING}
    """
)


def _preview_params(settings: Settings) -> dict[str, Any]:
    return {
        "can_preview": settings.previews_enabled and bool(settings.preview_converter_url),
        "preview_max": settings.preview_max_input_bytes,
    }


def _lease(settings: Settings) -> timedelta:
    return timedelta(seconds=settings.drive_text_timeout_seconds) + timedelta(minutes=5)


@dataclass(frozen=True)
class Claimed:
    version_id: uuid.UUID
    attempt: int


async def claim(db: AsyncSession, settings: Settings) -> Claimed | None:
    """A row to work on, leased and committed: a try whose lease ran out (or a retry that is
    due) first, else the next current version without a row."""
    now = utcnow()
    due = (
        await db.execute(
            select(DriveText)
            .where(DriveText.status == "working", DriveText.next_at <= now)
            .order_by(DriveText.next_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
    ).scalar_one_or_none()
    if due is not None:
        if due.attempts >= MAX_ATTEMPTS:
            log.warning("giving up on the text of drive version %s", due.version_id)
            due.status = "failed"
            due.reason = due.reason or "gave_up"
            due.next_at = None
            await db.commit()
            return await claim(db, settings)
        due.attempts += 1
        due.next_at = now + _lease(settings)
        claimed = Claimed(due.version_id, due.attempts)
        await db.commit()
        return claimed
    found = (await db.execute(_CANDIDATE, _preview_params(settings))).first()
    if found is None:
        await db.rollback()
        return None
    db.add(
        DriveText(
            version_id=found.version_id,
            item_id=found.item_id,
            status="working",
            attempts=1,
            next_at=now + _lease(settings),
        )
    )
    await db.commit()
    return Claimed(found.version_id, 1)


@dataclass(frozen=True)
class Extracted:
    status: str  # ready | skipped | failed
    reason: str | None = None
    body: str = ""
    page_starts: list[int] | None = None
    pages: int | None = None
    truncated: bool = False
    page_unit: str | None = None  # slide | sheet; None: PDF pages (or no pages)


class Retry(Exception):
    """A temporary failure (the object store): the row is tried again after RETRY."""


async def _download(blobs: BlobStore, key: str, dest: Path) -> None:
    try:
        with dest.open("wb") as file:
            async for chunk in blobs.stream(key):
                file.write(chunk)
    except Exception as exc:
        raise Retry(f"could not read the file: {exc}") from exc


async def read_pdf(path: Path, settings: Settings) -> Extracted:
    """The text of a PDF on disk, from the child process (pdf_text.py)."""
    out = path.with_suffix(".txt")
    stdout = await videos.run_bounded(
        [
            sys.executable,
            "-m",
            "app.modules.attachments.pdf_text",
            str(path),
            str(out),
            str(settings.drive_text_max_bytes),
        ],
        settings.drive_text_timeout_seconds,
        CHILD_MAX_OUTPUT,
        cwd=previews.SERVER_DIR,
    )
    if stdout is None:
        # Killed (too slow) or crashed: the same file does the same next time.
        return Extracted("failed", "unreadable")
    try:
        info: dict[str, Any] = json.loads(stdout)
        status = str(info["status"])
        if status == "encrypted":
            return Extracted("skipped", "encrypted")
        if status != "ok":
            return Extracted("failed", "unreadable")
        pages = int(info["pages"])
        starts = [int(start) for start in info["page_starts"]]
        chars = int(info["chars"])
        truncated = bool(info["truncated"])
        body = out.read_text(encoding="utf-8")
    except (ValueError, KeyError, TypeError, OSError):
        log.warning("the PDF text reader answered nonsense", exc_info=True)
        return Extracted("failed", "unreadable")
    if chars < max(MIN_CHARS, MIN_CHARS_PER_PAGE * min(pages, 50)):
        return Extracted("skipped", "no_text", pages=pages)
    return Extracted("ready", body=body, page_starts=starts, pages=pages, truncated=truncated)


def decode_text(data: bytes, *, complete: bool) -> str | None:
    """A plain text file's bytes as text, or None when it is not text. `complete`: false when
    only the start of the file was read (a character cut at the end is dropped)."""
    if data.startswith(codecs.BOM_UTF8):
        return data[len(codecs.BOM_UTF8) :].decode("utf-8", errors="ignore")
    for bom, codec in ((codecs.BOM_UTF16_LE, "utf-16-le"), (codecs.BOM_UTF16_BE, "utf-16-be")):
        if data.startswith(bom):
            body = data[len(bom) :]
            if not complete:
                body = body[: len(body) - len(body) % 2]
            return body.decode(codec, errors="ignore")
    if b"\x00" in data[:8192]:
        return None  # binary
    for codec in ("utf-8", "cp932"):
        decoder = codecs.getincrementaldecoder(codec)(errors="strict")
        try:
            return decoder.decode(data, final=complete)
        except UnicodeDecodeError:
            continue
    return None


async def read_text_file(blobs: BlobStore, key: str, size: int, settings: Settings) -> Extracted:
    # A few bytes over the cap: a character the cap cuts in half decodes up to its start.
    take = min(size, settings.drive_text_max_bytes + 3)
    data = bytearray()
    try:
        if take > 0:
            async for chunk in blobs.stream(key, 0, take - 1):
                data.extend(chunk)
    except Exception as exc:
        raise Retry(f"could not read the file: {exc}") from exc
    decoded = decode_text(bytes(data), complete=take >= size)
    if decoded is None:
        return Extracted("skipped", "not_text")
    body = clean(decoded, join_lines=False)
    capped = cut(body, settings.drive_text_max_bytes)
    truncated = take < size or len(capped) < len(body)
    if not capped.strip():
        return Extracted("skipped", "no_text")
    return Extracted("ready", body=capped, truncated=truncated)


async def _range(blobs: BlobStore, key: str, start: int, end: int) -> bytes:
    data = bytearray()
    async for chunk in blobs.stream(key, start, end):
        data.extend(chunk)
    return bytes(data)


@dataclass(frozen=True)
class PackageRead:
    extracted: Extracted
    fetched: int  # bytes of the object read
    requests: int  # ranged reads


async def read_package(
    blobs: BlobStore, key: str, settings: Settings, *, size: int | None = None
) -> PackageRead:
    """§29.6: an OOXML / ODF file's text, straight from the package, in a worker thread. The
    thread reads the object through ranged reads run on this event loop (the BlobStore is
    async); zipfile asks only for the end of the file, the central directory and the members
    it opens. The whole read is bounded by DRIVE_TEXT_TIMEOUT_SECONDS (checked between reads)."""
    try:
        if size is None:
            size = await blobs.head(key)
    except Exception as exc:
        raise Retry(f"could not read the file: {exc}") from exc
    if size is None:
        raise Retry("the object is missing")
    loop = asyncio.get_running_loop()
    deadline = time.monotonic() + settings.drive_text_timeout_seconds

    def fetch(start: int, end: int) -> bytes:
        left = deadline - time.monotonic()
        if left <= 0:
            raise office_text.Stop("timeout")
        future = asyncio.run_coroutine_threadsafe(_range(blobs, key, start, end), loop)
        try:
            return future.result(timeout=left)
        except concurrent.futures.TimeoutError as exc:
            future.cancel()
            raise office_text.Stop("timeout") from exc
        except Exception as exc:
            raise office_text.StoreError(str(exc)) from exc

    reader = office_text.RangedReader(
        fetch, size, max_fetch=2 * settings.drive_text_max_xml_bytes, deadline=deadline
    )

    def work() -> office_text.PackageText:
        try:
            return office_text.extract(
                reader,
                max_bytes=settings.drive_text_max_bytes,
                max_xml_bytes=settings.drive_text_max_xml_bytes,
                deadline=deadline,
            )
        except office_text.Stop as stop:  # a read outside a member (the end of the zip)
            return office_text.PackageText("failed", stop.reason)

    try:
        found = await asyncio.to_thread(work)
    except office_text.StoreError as exc:
        raise Retry(f"could not read the file: {exc}") from exc
    if found.status == "failed":
        log.warning("the text of the package %s: %s", key, found.reason)
    return PackageRead(
        Extracted(
            found.status,
            found.reason,
            body=found.body,
            page_starts=found.page_starts,
            pages=found.pages,
            truncated=found.truncated,
            page_unit=found.page_unit,
        ),
        fetched=reader.fetched,
        requests=reader.requests,
    )


async def extract(
    blobs: BlobStore, settings: Settings, kind: str, attachment: Attachment
) -> Extracted:
    if kind == "text":
        # Only the start is read (the cap), whatever the file's size.
        return await read_text_file(blobs, attachment.storage_key, attachment.size_bytes, settings)
    if kind == "package":
        read = await read_package(
            blobs, attachment.storage_key, settings, size=attachment.size_bytes
        )
        return read.extracted
    if kind == "office":
        if attachment.preview_status != "ready" or not attachment.preview_pdf_key:
            # Too large for the converter, a preview that failed, or previews are off.
            if attachment.size_bytes > settings.preview_max_input_bytes:
                return Extracted("skipped", "too_large")
            return Extracted("skipped", "no_preview")
        key = attachment.preview_pdf_key
    else:
        if attachment.size_bytes > settings.drive_text_max_input_bytes:
            return Extracted("skipped", "too_large")
        key = attachment.storage_key
    with tempfile.TemporaryDirectory(prefix="taylis-drive-text-") as tmp:
        source = Path(tmp) / "source.pdf"
        await _download(blobs, key, source)
        if source.stat().st_size > settings.drive_text_max_input_bytes:
            return Extracted("skipped", "too_large")
        return await read_pdf(source, settings)


async def process_one(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    blobs: BlobStore,
    claimed: Claimed,
) -> str:
    """Reads the claimed version; returns the row's status afterwards ('gone' when the version
    is no longer current or the row was taken over)."""
    async with session_factory() as db:
        version = await db.get(DriveFileVersion, claimed.version_id)
        item = await db.get(DriveItem, version.item_id) if version is not None else None
        attachment = (
            await db.get(Attachment, version.attachment_id) if version is not None else None
        )
        if (
            version is None
            or item is None
            or attachment is None
            or item.current_version_id != version.id
            or attachment.status == "deleted"
        ):
            await db.execute(delete(DriveText).where(DriveText.version_id == claimed.version_id))
            await db.commit()
            return "gone"
        kind = kind_of(attachment.content_type, item.name)
        db.expunge(attachment)
        await db.rollback()
    try:
        if kind is None:
            result = Extracted("skipped", "unsupported")
        else:
            result = await extract(blobs, settings, kind, attachment)
    except Retry as exc:
        log.warning("reading the text of drive version %s: %s", claimed.version_id, exc)
        async with session_factory() as db:
            row = await db.get(DriveText, claimed.version_id, with_for_update=True)
            if row is not None and row.status == "working" and row.attempts == claimed.attempt:
                row.reason = "read_failed"
                if row.attempts >= MAX_ATTEMPTS:
                    row.status = "failed"
                    row.next_at = None
                else:
                    row.next_at = utcnow() + RETRY
            await db.commit()
            return row.status if row is not None else "gone"
    async with session_factory() as db:
        row = await db.get(DriveText, claimed.version_id, with_for_update=True)
        if row is None or row.status != "working" or row.attempts != claimed.attempt:
            await db.rollback()
            return "gone"
        row.status = result.status
        row.reason = result.reason
        row.body = result.body
        row.page_starts = result.page_starts
        row.pages = result.pages
        row.page_unit = result.page_unit
        row.truncated = result.truncated
        row.next_at = None
        row.extracted_at = utcnow()
        await db.commit()
        return result.status


async def process_due(
    session_factory: async_sessionmaker[AsyncSession], settings: Settings, blobs: BlobStore
) -> int:
    """One file, if one is due and no chat attachment waits for its preview: 1, else 0."""
    if not settings.drive_text_enabled:
        return 0
    async with session_factory() as db:
        if await previews.chat_waiting(db):
            return 0
        claimed = await claim(db, settings)
    if claimed is None:
        return 0
    await process_one(session_factory, settings, blobs, claimed)
    return 1


async def forget_replaced_in_tx(db: AsyncSession, item_id: uuid.UUID, current: uuid.UUID) -> None:
    """A new current version of the item: the text of the others goes (only the current version
    is searched; the new one is read by the loop)."""
    await db.execute(
        delete(DriveText).where(DriveText.item_id == item_id, DriveText.version_id != current)
    )


# --- the backfill (`app.cli drive-index`) -------------------------------------------------------


@dataclass
class IndexResult:
    tried: int = 0
    ready: int = 0
    skipped: int = 0
    failed: int = 0
    retrying: int = 0
    remaining: bool = False
    waiting_for_previews: int = 0
    waited_seconds: float = 0.0


async def retry_failed(db: AsyncSession) -> int:
    """Rows that failed, or were skipped for want of a preview or for their size (a limit may
    have been raised since), are read again (their rows go)."""
    result = await db.execute(
        delete(DriveText).where(
            (DriveText.status == "failed")
            | ((DriveText.status == "skipped") & DriveText.reason.in_(("no_preview", "too_large")))
        )
    )
    await db.commit()
    return int(getattr(result, "rowcount", 0) or 0)


async def index_stored(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    blobs: BlobStore,
    *,
    limit: int,
    chat_wait_seconds: float = 600.0,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> IndexResult:
    """At most `limit` files, one at a time, each committed on its own: a run again only does
    what is left, and the loop of a running server never reads the same file at the same time
    (the rows are leased). Before each file it lets the chat's previews go first."""
    result = IndexResult()
    while result.tried < limit:
        async with session_factory() as db:
            result.waited_seconds += await previews.let_the_chat_go_first(
                db, chat_wait_seconds, sleep
            )
            claimed = await claim(db, settings)
        if claimed is None:
            break
        result.tried += 1
        status = await process_one(session_factory, settings, blobs, claimed)
        if status == "ready":
            result.ready += 1
        elif status == "skipped":
            result.skipped += 1
        elif status == "failed":
            result.failed += 1
        elif status == "working":
            result.retrying += 1
    async with session_factory() as db:
        params = _preview_params(settings)
        result.remaining = (await db.execute(_CANDIDATE, params)).first() is not None
        await db.rollback()
        result.waiting_for_previews = int(
            (await db.execute(_WAITING_FOR_PREVIEWS, params)).scalar_one()
        )
        await db.rollback()
    return result


async def counts(db: AsyncSession) -> dict[str, int]:
    """Rows by status (the backfill's report)."""
    rows = (
        await db.execute(select(DriveText.status, func.count()).group_by(DriveText.status))
    ).all()
    return {str(status): int(n) for status, n in rows}
