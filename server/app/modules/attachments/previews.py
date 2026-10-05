"""Document previews (M108, docs/PREVIEWS.md): a background loop, never the upload request.

An upload that preview_kinds.wants_preview accepts is stored with preview_status 'pending'. The
preview loop (main._preview_loop, one at a time) claims the oldest due row, downloads the bytes to
a temporary directory, has the converter service (Gotenberg's LibreOffice route) turn an Office
file into a PDF, renders the PDF's first page to a WebP thumbnail in a child process
(pdf_render.py, pypdfium2) and stores both in the object store next to the original
(`attachments/{id}.preview.pdf`, `attachments/{id}.preview.webp`: our names, never the user's).

Reliability (SECURITY.md §4 「文書のプレビュー」):
- A claim takes the row with FOR UPDATE SKIP LOCKED, counts the attempt and leases it
  (preview_next_at = now + lease), then commits; a server that stops mid-way leaves a lease that
  runs out, and the row is tried again. After preview_max_attempts the row is 'failed'.
- A temporary failure (the converter unreachable, busy or timing out, the object store) waits
  BACKOFF before the next try; a permanent one (the converter refused the file, a PDF PDFium
  cannot read, too large) fails at once. Failures are recorded (preview_error), never retried
  forever.
- The result is written only while the row is still 'pending' and not deleted; the stored keys
  are deterministic, so a repeated try overwrites the same objects (idempotent).
- A preview of a file already in a message moves the message's updated_seq with message.updated
  (change "attachments"), so devices get it through the delta (SYNC_PROTOCOL.md §7.3) or the
  event; the channel row is locked before the attachment row, as a send or a delete does. A send
  reads the uploads it binds FOR UPDATE (service.bind_in_tx), so it waits for a preview being
  recorded and carries it, or the loop sees the row bound and announces it.
"""

import json
import logging
import sys
import tempfile
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Protocol

import httpx
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

import app as app_package
from app.core.db import Database
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import videos
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.models import Attachment
from app.modules.attachments.preview_kinds import (
    CONTAINER_TYPES,
    PREVIEW_TYPES,
    source_kind,
    wants,
)
from app.modules.channels.models import Channel
from app.modules.messages import service as messages

log = logging.getLogger("app.attachments.previews")

# Waits before the 2nd, 3rd, ... try after a temporary failure.
BACKOFF = (timedelta(minutes=1), timedelta(minutes=10), timedelta(hours=1))
MAX_ERROR_CHARS = 300
RENDER_MAX_OUTPUT = 4 * 1024  # the child's JSON line
CHUNK = 256 * 1024
# Where `python -m app.modules...` finds the app package (the child's working directory).
SERVER_DIR = str(Path(app_package.__file__).resolve().parent.parent)


class PreviewError(Exception):
    """Why a try failed; permanent errors are not tried again."""

    def __init__(self, reason: str, *, permanent: bool) -> None:
        super().__init__(reason)
        self.reason = reason[:MAX_ERROR_CHARS]
        self.permanent = permanent


class PreviewConverter(Protocol):
    async def to_pdf(self, source: Path, kind: str, dest: Path) -> None:
        """Write the PDF of `source` (an Office file of extension `kind`) to `dest`, or raise
        PreviewError."""
        ...


class GotenbergConverter:
    """POST /forms/libreoffice/convert of a Gotenberg container (compose service `converter`, on
    an internal network without a way out). The file goes as "document.<kind>"."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float,
        max_output: int,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.url = base_url.rstrip("/") + "/forms/libreoffice/convert"
        self.timeout = timeout
        self.max_output = max_output
        self.transport = transport  # tests

    async def to_pdf(self, source: Path, kind: str, dest: Path) -> None:
        timeout = httpx.Timeout(self.timeout, connect=10.0)
        try:
            async with httpx.AsyncClient(timeout=timeout, transport=self.transport) as client:
                with source.open("rb") as file:
                    files = {"files": (f"document.{kind}", file, "application/octet-stream")}
                    async with client.stream("POST", self.url, files=files) as response:
                        if response.status_code != 200:
                            status = response.status_code
                            detail = (await response.aread())[:200].decode(errors="replace")
                            raise PreviewError(
                                f"converter answered {status}: {detail.strip()}",
                                # 4xx: the file itself (unsupported, broken, too large); a busy
                                # queue (429/503) or a timeout (503/504) is worth another try.
                                permanent=400 <= status < 500 and status not in (408, 429),
                            )
                        await _write_capped(response, dest, self.max_output)
        except httpx.TimeoutException as exc:
            raise PreviewError("converter timed out", permanent=False) from exc
        except httpx.HTTPError as exc:
            raise PreviewError(f"converter unreachable: {exc}", permanent=False) from exc


async def _write_capped(response: httpx.Response, dest: Path, max_bytes: int) -> None:
    size = 0
    with dest.open("wb") as out:
        async for chunk in response.aiter_bytes(CHUNK):
            size += len(chunk)
            if size > max_bytes:
                raise PreviewError("the converted PDF is too large", permanent=True)
            out.write(chunk)


def build_converter(settings: Settings) -> PreviewConverter | None:
    if not settings.previews_enabled or not settings.preview_converter_url:
        return None
    return GotenbergConverter(
        settings.preview_converter_url,
        timeout=settings.preview_convert_timeout_seconds,
        max_output=settings.preview_max_output_bytes,
    )


def pdf_key(attachment_id: uuid.UUID) -> str:
    # Sibling keys like the thumbnail's (service.thumbnail_key): a posix-backed store cannot hold
    # an object "attachments/{id}" and a directory of the same name.
    return f"attachments/{attachment_id}.preview.pdf"


def thumb_key(attachment_id: uuid.UUID) -> str:
    return f"attachments/{attachment_id}.preview.webp"


@dataclass(frozen=True)
class Rendered:
    pages: int
    width: int
    height: int
    thumbnail: bytes


async def render_pdf(pdf: Path, workdir: Path, settings: Settings) -> Rendered:
    """Page count and first-page WebP, from the child process (pdf_render.py)."""
    out = workdir / "thumbnail.webp"
    width = settings.preview_thumbnail_width
    stdout = await videos.run_bounded(
        [
            sys.executable,
            "-m",
            "app.modules.attachments.pdf_render",
            str(pdf),
            str(out),
            str(width),
            str(width * 2),  # a very tall page is shrunk to fit twice the width
        ],
        settings.preview_render_timeout_seconds,
        RENDER_MAX_OUTPUT,
        cwd=SERVER_DIR,
    )
    if stdout is None:
        # Broken, encrypted, too slow: the same file fails the same way next time.
        raise PreviewError("the PDF could not be rendered", permanent=True)
    try:
        info = json.loads(stdout)
        pages, w, h = int(info["pages"]), int(info["width"]), int(info["height"])
        thumbnail = out.read_bytes()
    except (ValueError, KeyError, TypeError, OSError) as exc:
        raise PreviewError(f"the renderer answered nonsense: {exc}", permanent=True) from exc
    if pages < 1 or not (0 < w <= 4 * width and 0 < h <= 4 * width) or not thumbnail:
        raise PreviewError("the renderer answered nonsense", permanent=True)
    return Rendered(pages=pages, width=w, height=h, thumbnail=thumbnail)


@dataclass(frozen=True)
class Ready:
    rendered: Rendered
    converted: bool


async def _download(blobs: BlobStore, key: str, dest: Path) -> None:
    try:
        with dest.open("wb") as file:
            async for chunk in blobs.stream(key):
                file.write(chunk)
    except Exception as exc:
        raise PreviewError(f"could not read the file: {exc}", permanent=False) from exc


async def _produce(
    attachment_id: uuid.UUID,
    storage_key: str,
    kind: str,
    blobs: BlobStore,
    converter: PreviewConverter | None,
    settings: Settings,
) -> Ready:
    with tempfile.TemporaryDirectory(prefix="chikuwa-preview-") as tmp:
        workdir = Path(tmp)
        source = workdir / f"source.{kind}"
        await _download(blobs, storage_key, source)
        pdf = source
        if kind != "pdf":
            if converter is None:
                raise PreviewError("no converter is configured", permanent=False)
            pdf = workdir / "preview.pdf"
            await converter.to_pdf(source, kind, pdf)
        rendered = await render_pdf(pdf, workdir, settings)
        try:
            if kind != "pdf":
                with pdf.open("rb") as file:
                    await blobs.put(pdf_key(attachment_id), file, "application/pdf")
            await blobs.put(thumb_key(attachment_id), rendered.thumbnail, "image/webp")
        except Exception as exc:
            raise PreviewError(f"could not store the preview: {exc}", permanent=False) from exc
    return Ready(rendered=rendered, converted=kind != "pdf")


def _still_queued(row: Attachment | None) -> bool:
    return row is not None and row.status != "deleted" and row.preview_status == "pending"


def _in_message(row: Attachment) -> bool:
    return row.status == "attached" and row.message_id is not None and row.canvas_id is None


async def _finish(
    db: AsyncSession,
    blobs: BlobStore,
    attachment_id: uuid.UUID,
    apply: Callable[[Attachment], bool],
    stored: list[str],
) -> str | None:
    """Write the outcome (apply returns whether clients see a change) while the row is still
    queued; announce it when the file is in a message. Returns the preview_status written."""
    for _ in range(2):
        await db.rollback()
        row = await db.get(Attachment, attachment_id, populate_existing=True)
        if row is None or row.status == "deleted":
            # Deleted (or purged by the GC) while we worked: what we stored has no owner.
            await db.rollback()
            for key in stored:
                await blobs.delete(key)
            return None
        if not _still_queued(row):
            await db.rollback()
            return None
        if _in_message(row):
            assert row.channel_id is not None and row.message_id is not None
            # The channel first, like a send or a delete, then the attachment.
            await db.execute(
                select(Channel.id).where(Channel.id == row.channel_id).with_for_update()
            )
            row = await db.get(
                Attachment, attachment_id, populate_existing=True, with_for_update=True
            )
            if row is None or not _still_queued(row) or not _in_message(row):
                continue
            message_id = row.message_id
            assert message_id is not None
            changed = apply(row)
            await db.flush()
            if changed:
                await messages.announce_change_by_id_in_tx(db, message_id, "attachments")
            status = row.preview_status
            await db.commit()
            return status
        row = await db.get(Attachment, attachment_id, populate_existing=True, with_for_update=True)
        if row is None or not _still_queued(row):
            continue
        if _in_message(row):  # bound meanwhile: go round and take the channel first
            continue
        apply(row)
        status = row.preview_status
        await db.commit()
        return status
    await db.rollback()
    return None


async def process_one(
    db: AsyncSession,
    blobs: BlobStore,
    converter: PreviewConverter | None,
    settings: Settings,
    attachment_id: uuid.UUID,
    *,
    give_up: bool = False,
) -> str | None:
    """Make (or fail) the preview of a claimed row. Returns the preview_status written ('ready',
    'failed', or 'pending' when it waits for another try), None when the row went away."""
    row = await db.get(Attachment, attachment_id, populate_existing=True)
    if not _still_queued(row):
        await db.rollback()
        return None
    assert row is not None
    attempts = row.preview_attempts
    kind = source_kind(row.content_type, row.filename)
    storage_key, size = row.storage_key, row.size_bytes
    await db.rollback()  # no transaction held while the converter works

    stored: list[str] = []
    outcome: Ready | PreviewError
    if give_up:
        outcome = PreviewError(
            f"gave up after {attempts} tries (the last one never finished)", permanent=True
        )
    elif kind is None:
        outcome = PreviewError("not a previewable file", permanent=True)
    elif size > settings.preview_max_input_bytes:
        outcome = PreviewError("the file is too large for a preview", permanent=True)
    else:
        try:
            outcome = await _produce(attachment_id, storage_key, kind, blobs, converter, settings)
            stored = [thumb_key(attachment_id)]
            if outcome.converted:
                stored.append(pdf_key(attachment_id))
        except PreviewError as exc:
            outcome = exc
        except Exception as exc:  # a bug or the unexpected: recorded and retried, never lost
            log.exception("preview of %s failed", attachment_id)
            outcome = PreviewError(f"unexpected error: {type(exc).__name__}", permanent=False)

    if isinstance(outcome, Ready):
        ready = outcome

        def apply(row: Attachment) -> bool:
            row.preview_status = "ready"
            row.preview_pages = ready.rendered.pages
            row.preview_width = ready.rendered.width
            row.preview_height = ready.rendered.height
            row.preview_thumb_key = thumb_key(row.id)
            row.preview_pdf_key = pdf_key(row.id) if ready.converted else None
            row.preview_next_at = None
            row.preview_error = None
            return True

    else:
        error = outcome
        final = error.permanent or attempts >= settings.preview_max_attempts
        log.info(
            "preview of %s failed (try %d%s): %s",
            attachment_id,
            attempts,
            ", giving up" if final else "",
            error.reason,
        )

        def apply(row: Attachment) -> bool:
            row.preview_error = error.reason
            if final:
                row.preview_status = "failed"
                row.preview_next_at = None
                return True
            wait = BACKOFF[min(max(attempts, 1), len(BACKOFF)) - 1]
            row.preview_next_at = utcnow() + wait
            return False

    return await _finish(db, blobs, attachment_id, apply, stored)


def _lease(settings: Settings) -> timedelta:
    return timedelta(
        seconds=settings.preview_convert_timeout_seconds
        + settings.preview_render_timeout_seconds
        + 300
    )


async def claim_next(
    db: AsyncSession, settings: Settings, now: datetime | None = None
) -> tuple[uuid.UUID, bool] | None:
    """(id, give_up) of the oldest due row, now leased to us; None when nothing is due."""
    now = now or utcnow()
    stmt = (
        select(Attachment)
        .where(
            Attachment.preview_status == "pending",
            Attachment.preview_next_at <= now,
            Attachment.status != "deleted",
        )
        .order_by(Attachment.preview_next_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    row = (await db.execute(stmt)).scalar_one_or_none()
    if row is None:
        await db.rollback()
        return None
    give_up = row.preview_attempts >= settings.preview_max_attempts
    if not give_up:
        row.preview_attempts += 1
    row.preview_next_at = now + _lease(settings)
    attachment_id = row.id
    await db.commit()
    return attachment_id, give_up


async def process_due(
    database: Database,
    blobs: BlobStore,
    converter: PreviewConverter | None,
    settings: Settings,
) -> int:
    """One due preview, if any (the loop calls again at once while there was one)."""
    async with database.session_factory() as db:
        claimed = await claim_next(db, settings)
        if claimed is None:
            return 0
        attachment_id, give_up = claimed
        await process_one(db, blobs, converter, settings, attachment_id, give_up=give_up)
        return 1


@dataclass
class BackfillResult:
    tried: int = 0
    ready: int = 0
    failed: int = 0
    retrying: int = 0  # left pending for the preview loop (a temporary failure)
    remaining: bool = False


BATCH = 50


async def _candidates(
    db: AsyncSession,
    settings: Settings,
    statuses: tuple[str, ...],
    after: uuid.UUID | None,
) -> tuple[list[uuid.UUID], uuid.UUID | None]:
    """(ids that want a preview, the last id looked at) of the next batch in id order."""
    stmt = (
        select(Attachment)
        .where(
            Attachment.preview_status.in_(statuses),
            Attachment.status != "deleted",
            Attachment.size_bytes <= settings.preview_max_input_bytes,
            or_(
                Attachment.content_type.in_(PREVIEW_TYPES),
                Attachment.content_type.in_(CONTAINER_TYPES),
            ),
        )
        .order_by(Attachment.id)
        .limit(BATCH)
    )
    if after is not None:
        stmt = stmt.where(Attachment.id > after)
    rows = list((await db.execute(stmt)).scalars().all())
    last = rows[-1].id if rows else None
    ids = [row.id for row in rows if wants(row, settings)]
    await db.rollback()
    return ids, last


async def generate_stored(
    db: AsyncSession,
    blobs: BlobStore,
    converter: PreviewConverter | None,
    settings: Settings,
    *,
    limit: int = 200,
    retry_failed: bool = False,
) -> BackfillResult:
    """`app.cli generate-previews`: previews of files stored before M108 (or while previews were
    off), at most `limit` a run, one at a time, each committed on its own (resumable, and a run
    again only does what is left). A row is leased like the loop's claim, so the two never work
    on the same file; a temporary failure leaves it to the loop's retries."""
    if not settings.previews_enabled:
        raise RuntimeError("previews are off (PREVIEWS_ENABLED=false)")
    statuses = ("none", "failed") if retry_failed else ("none",)
    result = BackfillResult()
    after: uuid.UUID | None = None
    while result.tried < limit:
        ids, last = await _candidates(db, settings, statuses, after)
        if last is None:
            return result
        after = last
        for attachment_id in ids:
            if result.tried >= limit:
                result.remaining = True
                return result
            row = (
                await db.execute(
                    select(Attachment)
                    .where(Attachment.id == attachment_id)
                    .with_for_update(skip_locked=True)
                )
            ).scalar_one_or_none()
            if row is None or row.preview_status not in statuses or row.status == "deleted":
                await db.rollback()
                continue
            row.preview_status = "pending"
            row.preview_attempts = 1
            row.preview_error = None
            row.preview_next_at = utcnow() + _lease(settings)
            await db.commit()
            result.tried += 1
            status = await process_one(db, blobs, converter, settings, attachment_id)
            if status == "ready":
                result.ready += 1
            elif status == "failed":
                result.failed += 1
            elif status == "pending":
                result.retrying += 1
    ids, last = await _candidates(db, settings, statuses, after)
    result.remaining = last is not None
    return result
