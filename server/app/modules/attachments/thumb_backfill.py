"""Thumbnails of see-through images made before 2026-11-14 (`app.cli rebuild-thumbnails`,
docs/PREVIEWS.md §17).

Those were flattened into JPEGs: the see-through pixels showed the colour they kept under the
transparency, mostly black, else leftover noise. Only PNG, WebP and GIF files can be
see-through, and the fixed thumbnail is a WebP, so a file whose thumbnail is already a WebP is
skipped (a run that stops halfway, or is run again, only reads the rest). The thumbnail keeps its
key, its width and its height: no row and no message changes, and the clients show the new one
when they next load it.
Bounded (at most `limit` files read a run); `after` goes on from the id the last run printed.
"""

import logging
import tempfile
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.settings import Settings
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import ImageTooLarge, make_thumbnail, thumbnail_type
from app.modules.attachments.models import Attachment

log = logging.getLogger("app.attachments.thumbnails")

BATCH = 50
# The image types that can be see-through (a JPEG cannot).
SEE_THROUGH_TYPES = ("image/png", "image/webp", "image/gif")


@dataclass
class RebuildResult:
    checked: int = 0  # thumbnails looked at
    read: int = 0  # originals read (the thumbnail was still a JPEG)
    rebuilt: int = 0  # now a see-through WebP
    failed: list[str] = field(default_factory=list)
    last: uuid.UUID | None = None  # the last id looked at: `after` for the next run
    remaining: bool = False  # the limit stopped the run
    # dry run: the files that may need it, and their size
    pending: int = 0
    pending_bytes: int = 0


def _wanted() -> list[Any]:
    return [
        Attachment.content_type.in_(SEE_THROUGH_TYPES),
        Attachment.thumbnail_key.is_not(None),
        Attachment.status != "deleted",
    ]


async def _next_batch(
    db: AsyncSession, after: uuid.UUID | None, size: int
) -> list[tuple[uuid.UUID, str, str, int]]:
    stmt = (
        select(
            Attachment.id, Attachment.storage_key, Attachment.thumbnail_key, Attachment.size_bytes
        )
        .where(*_wanted())
        .order_by(Attachment.id)
        .limit(size)
    )
    if after is not None:
        stmt = stmt.where(Attachment.id > after)
    rows = (await db.execute(stmt)).all()
    return [(row[0], row[1], row[2] or "", row[3]) for row in rows]


async def _head(blobs: BlobStore, key: str) -> bytes:
    head = b""
    async for chunk in blobs.stream(key, 0, 11):
        head += chunk
    return head


async def _download(blobs: BlobStore, key: str, path: str) -> None:
    with open(path, "wb") as file:  # noqa: ASYNC230 - local temp file, chunked
        async for chunk in blobs.stream(key):
            file.write(chunk)


async def rebuild_see_through_thumbnails(
    db: AsyncSession,
    blobs: BlobStore,
    settings: Settings,
    *,
    limit: int = 1000,
    after: uuid.UUID | None = None,
    dry_run: bool = False,
) -> RebuildResult:
    result = RebuildResult()
    if dry_run:
        count, size = (
            await db.execute(
                select(func.count(), func.coalesce(func.sum(Attachment.size_bytes), 0)).where(
                    *_wanted()
                )
            )
        ).one()
        result.pending, result.pending_bytes = int(count), int(size)
        return result
    result.last = after
    while True:
        rows = await _next_batch(db, result.last, BATCH)
        if not rows:
            return result
        for attachment_id, storage_key, thumb_key, size in rows:
            if result.read >= limit:
                result.remaining = True
                return result
            result.last = attachment_id
            result.checked += 1
            try:
                if thumbnail_type(await _head(blobs, thumb_key)) == "image/webp":
                    continue  # made the new way already
                if size > settings.drive_image_thumb_max_bytes:
                    continue  # never had a thumbnail made from it this way either
                result.read += 1
                with tempfile.NamedTemporaryFile(prefix="taylis-thumb-") as copy:
                    await _download(blobs, storage_key, copy.name)
                    copy.seek(0)
                    thumb, _, _ = await run_in_threadpool(
                        make_thumbnail, copy, settings.attachment_thumbnail_px
                    )
                media_type = thumbnail_type(thumb)
                if media_type == "image/webp":
                    await blobs.put(thumb_key, thumb, media_type)
                    result.rebuilt += 1
            except ImageTooLarge:
                continue
            except Exception as exc:  # one unreadable file does not stop the others
                log.warning("thumbnail rebuild failed for %s: %s", attachment_id, exc)
                result.failed.append(f"{attachment_id}: {exc}")
