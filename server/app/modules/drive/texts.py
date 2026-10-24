"""The text inside drive files, for the full-text search (docs/DRIVE.md §29).

What is read (the current version of a file outside the trash, only):
- a PDF: its own bytes (up to DRIVE_TEXT_MAX_INPUT_BYTES), in a child process (pdf_text.py);
- an Office file: the PDF its preview made (PREVIEWS.md); it waits until the preview is ready
  (the preview loop or `generate-previews --drive` makes it), and is skipped when the preview
  failed;
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
import json
import logging
import sys
import tempfile
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


def kind_of(content_type: str, name: str) -> str | None:
    """'pdf', 'office', 'text' or None (nothing to read in this file)."""
    kind = source_kind(content_type, name)
    if kind == "pdf":
        return "pdf"
    if kind is not None:
        return "office"
    _, dot, ext = name.rpartition(".")
    content_type = content_type.lower()
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


# The current versions of files outside the trash that are ready to be read and have no row
# yet: PDFs, Office files whose preview is ready (or failed: recorded as skipped), plain text
# files. Written in SQL with kind_of's rules (kind_of decides again for the row it took).
_READABLE = f"""
    (a.content_type = '{PDF_TYPE}'
     OR (a.content_type = '{OCTET}' AND lower(i.name) LIKE '%.pdf')
     OR (a.preview_status IN ('ready', 'failed')
         AND (a.content_type IN ({_quoted(set(OFFICE_TYPES))})
              OR (a.content_type IN ({_quoted(CONTAINER_TYPES)})
                  AND lower(i.name) ~ '\\.({_extensions(OFFICE_EXTENSIONS)})$')))
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
# Office files that wait for their preview (none yet: an import; or still being made).
_WAITING_FOR_PREVIEWS = text(
    f"""
    SELECT count(*)
    FROM drive_items i
    JOIN drive_file_versions v ON v.id = i.current_version_id
    JOIN attachments a ON a.id = v.attachment_id
    WHERE i.kind = 'file' AND i.trashed_at IS NULL AND a.status <> 'deleted'
      AND NOT EXISTS (SELECT 1 FROM drive_texts t WHERE t.version_id = v.id)
      AND a.preview_status IN ('none', 'pending')
      AND (a.content_type IN ({_quoted(set(OFFICE_TYPES))})
           OR (a.content_type IN ({_quoted(CONTAINER_TYPES)})
               AND lower(i.name) ~ '\\.({_extensions(OFFICE_EXTENSIONS)})$'))
    """
)


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
    found = (await db.execute(_CANDIDATE)).first()
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


async def extract(
    blobs: BlobStore, settings: Settings, kind: str, attachment: Attachment
) -> Extracted:
    if kind == "text":
        # Only the start is read (the cap), whatever the file's size.
        return await read_text_file(blobs, attachment.storage_key, attachment.size_bytes, settings)
    if kind == "office":
        if attachment.preview_status != "ready" or not attachment.preview_pdf_key:
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
    """Rows that failed, or were skipped for want of a preview, are read again (their rows go)."""
    result = await db.execute(
        delete(DriveText).where(
            (DriveText.status == "failed")
            | ((DriveText.status == "skipped") & (DriveText.reason == "no_preview"))
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
        result.remaining = (await db.execute(_CANDIDATE)).first() is not None
        await db.rollback()
        result.waiting_for_previews = int((await db.execute(_WAITING_FOR_PREVIEWS)).scalar_one())
        await db.rollback()
    return result


async def counts(db: AsyncSession) -> dict[str, int]:
    """Rows by status (the backfill's report)."""
    rows = (
        await db.execute(select(DriveText.status, func.count()).group_by(DriveText.status))
    ).all()
    return {str(status): int(n) for status, n in rows}
