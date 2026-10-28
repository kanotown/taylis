"""A drive photo's capture time, location mark and display-size image (AL1, docs/ALBUMS.md §4.2,
§6, §14).

The drive's media loop (media.py) reads them for every new version that is an image or a video
(posted files too, CHANNEL_FILES.md); the versions stored before AL1 are read by
`app.cli drive-photos --limit N` (`backfill`: the current versions whose photo_probed_at is NULL,
one at a time, resumable), and an image opened in the viewer before that is queued again for the
media loop (`requeue_in_tx`, the lazy path of GET /attachments/{id}/display). Nothing runs at
deploy time.

The display image is a derived object like the thumbnail: under attachments/{id}.display.webp,
removed with its attachment by the GC, checked by `verify-attachments`, not counted by any quota.
drive_items.taken_at follows the current version's attachments.taken_at (`sync_item`, its own
short transaction after the attachment's, so the media loop never holds an attachment and then
waits for an item that a tree change holds).
"""

import logging
import tempfile
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import IO, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.concurrency import run_in_threadpool

from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import photos, videos
from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import IMAGE_TYPES, ImageTooLarge
from app.modules.attachments.models import Attachment
from app.modules.attachments.photo_kinds import is_image, photo_kind
from app.modules.drive import events
from app.modules.drive.models import DriveFileVersion, DriveItem

log = logging.getLogger("app.drive.photos")


@dataclass(frozen=True)
class PhotoResult:
    taken: photos.CaptureTime | None
    has_location: bool
    display: photos.DisplayImage | None = None


def zone(settings: Settings) -> ZoneInfo:
    """The workspace's zone (CHANNEL_FILES_TZ): a capture time without an offset is read in it."""
    try:
        return ZoneInfo(settings.channel_files_tz)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("Asia/Tokyo")


async def read_image(source: IO[bytes], settings: Settings) -> PhotoResult:
    """An image file's metadata and display-size copy. Past the pixel limit: the metadata only. A
    broken image: nothing found (an empty result, still marked as read)."""
    now = utcnow()
    where = zone(settings)
    source.seek(0)
    try:
        meta, display = await run_in_threadpool(photos.read_image, source, where, now=now)
    except ImageTooLarge:
        source.seek(0)
        try:
            meta = await run_in_threadpool(photos.read_image_meta_only, source, where, now=now)
        except Exception:
            return PhotoResult(taken=None, has_location=False)
        return PhotoResult(taken=meta.taken, has_location=meta.has_location)
    except Exception:  # a broken or hostile image stays a plain file
        log.warning("reading a drive photo failed", exc_info=True)
        return PhotoResult(taken=None, has_location=False)
    return PhotoResult(taken=meta.taken, has_location=meta.has_location, display=display)


def from_video(info: videos.VideoInfo) -> PhotoResult:
    taken = photos.CaptureTime(at=info.taken_at, local=False) if info.taken_at else None
    return PhotoResult(taken=taken, has_location=info.has_location)


async def apply_in_tx(attachment: Attachment, result: PhotoResult, blobs: BlobStore) -> bool:
    """Records what was read (the display image goes to the store first). True when the file now
    shows something new (a capture time, a location mark, a display image)."""
    changed = False
    if result.display is not None:
        key = attachments.display_key(attachment.id)
        await blobs.put(key, result.display.data, "image/webp")
        changed = changed or attachment.display_key is None
        attachment.display_key = key
        attachment.display_width = result.display.width
        attachment.display_height = result.display.height
        attachment.display_bytes = len(result.display.data)
    taken_at = result.taken.at if result.taken else None
    changed = changed or attachment.taken_at != taken_at
    changed = changed or bool(attachment.has_location) != result.has_location
    attachment.taken_at = taken_at
    attachment.taken_at_local = result.taken.local if result.taken else None
    attachment.has_location = result.has_location
    attachment.photo_probed_at = utcnow()
    return changed


async def sync_item(db: AsyncSession, attachment_id: uuid.UUID, *, announce: bool) -> None:
    """drive_items.taken_at from the attachment, when it is still its item's current version
    (one statement on the item row, committed by the caller); `announce`: drive.changed for the
    item's folder."""
    row = (
        await db.execute(
            select(DriveItem.id, DriveItem.location_id, DriveItem.parent_id, Attachment.taken_at)
            .join(DriveFileVersion, DriveFileVersion.id == DriveItem.current_version_id)
            .join(Attachment, Attachment.id == DriveFileVersion.attachment_id)
            .where(Attachment.id == attachment_id)
        )
    ).first()
    if row is None:
        return
    item_id, location_id, parent_id, taken_at = row
    await db.execute(
        update(DriveItem)
        .where(DriveItem.id == item_id)
        .values(taken_at=taken_at)
        .execution_options(synchronize_session=False)
    )
    if announce:
        await events.emit_changed(db, location_id, [parent_id])


# --- the lazy path (the viewer asks for a display image not made yet) -----------------------------


async def requeue_in_tx(db: AsyncSession, attachment: Attachment) -> bool:
    """A drive image read before AL1 (no display image, never read as a photo): its version goes
    back to the media loop (once: only a processed version moves). True when queued."""
    if (
        attachment.drive_item_id is None
        or attachment.photo_probed_at is not None
        or attachment.display_key is not None
        or not is_image(attachment.content_type)
    ):
        return False
    moved = await db.execute(
        update(DriveFileVersion)
        .where(
            DriveFileVersion.attachment_id == attachment.id,
            DriveFileVersion.processed_at.is_not(None),
        )
        .values(processed_at=None, process_next_at=utcnow(), process_attempts=0)
        .returning(DriveFileVersion.id)
        .execution_options(synchronize_session=False)
    )
    return moved.first() is not None


# --- app.cli drive-photos ------------------------------------------------------------------------


@dataclass
class BackfillResult:
    read: int = 0  # looked at (found something or not)
    dated: int = 0  # now have a capture time
    located: int = 0  # hold a location
    displays: int = 0  # display images made
    skipped_videos: int = 0  # videos left for later (no ffmpeg)
    remaining: bool = False  # the limit stopped the run: run it again
    # --dry-run: how many there are to read.
    pending: int = 0
    pending_bytes: int = 0
    errors: list[str] = field(default_factory=list)


def _wanted(rebuild: bool, with_videos: bool) -> list[Any]:
    kinds = [Attachment.content_type.in_(sorted(IMAGE_TYPES))]
    if with_videos:
        kinds.append(Attachment.content_type.like("video/%"))
    todo: Any = Attachment.photo_probed_at.is_(None)
    if rebuild:
        # Also every image read before: those whose display image is missing (never made, or
        # lost in a restore) are read again (`_backfill_one`).
        todo = or_(todo, kinds[0])
    return [
        Attachment.status == "attached",
        Attachment.drive_item_id.is_not(None),
        or_(*kinds),
        todo,
    ]


def _current_versions() -> Any:
    return select(DriveFileVersion.attachment_id).join(
        DriveItem, DriveItem.current_version_id == DriveFileVersion.id
    )


async def _batch(
    db: AsyncSession, after: uuid.UUID | None, size: int, *, rebuild: bool, with_videos: bool
) -> list[uuid.UUID]:
    stmt = (
        select(Attachment.id)
        .where(*_wanted(rebuild, with_videos), Attachment.id.in_(_current_versions()))
        .order_by(Attachment.id)
        .limit(size)
    )
    if after is not None:
        stmt = stmt.where(Attachment.id > after)
    return list((await db.execute(stmt)).scalars().all())


async def _download(blobs: BlobStore, key: str, path: str) -> None:
    with open(path, "wb") as file:  # noqa: ASYNC230 - local temp file, chunked
        async for chunk in blobs.stream(key):
            file.write(chunk)


async def read_stored(
    blobs: BlobStore, settings: Settings, key: str, content_type: str, size: int
) -> PhotoResult | None:
    """The object's photo information, or None when it cannot be read now (a video without
    ffmpeg; the caller leaves it for later). A file beyond the limits reads as nothing found."""
    if is_image(content_type):
        if size > settings.drive_image_thumb_max_bytes:
            return PhotoResult(taken=None, has_location=False)
        with tempfile.NamedTemporaryFile(prefix="taylis-photo-") as copy:
            await _download(blobs, key, copy.name)
            return await read_image(copy, settings)
    if videos.is_video(content_type):
        if videos.tools(settings) is None:
            return None
        if size > settings.drive_video_probe_max_bytes:
            return PhotoResult(taken=None, has_location=False)
        with tempfile.NamedTemporaryFile(prefix="taylis-photo-") as copy:
            await _download(blobs, key, copy.name)
            info = await videos.probe_video(copy.name, settings)
        return from_video(info) if info is not None else None
    return None


async def backfill(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    blobs: BlobStore,
    *,
    limit: int,
    dry_run: bool = False,
    rebuild: bool = False,
) -> BackfillResult:
    """At most `limit` current drive versions that are photos or videos not read yet (and with
    `rebuild`, images whose display image is missing from the store), one transaction each; run
    it again for the rest. `dry_run`: only counts the files not read yet."""
    result = BackfillResult()
    with_videos = videos.tools(settings) is not None
    async with session_factory() as db:
        if dry_run:
            row = (
                await db.execute(
                    select(func.count(), func.coalesce(func.sum(Attachment.size_bytes), 0)).where(
                        *_wanted(False, True),
                        Attachment.id.in_(_current_versions()),
                    )
                )
            ).one()
            result.pending, result.pending_bytes = int(row[0]), int(row[1])
            return result
        if not with_videos:
            result.skipped_videos = int(
                (
                    await db.execute(
                        select(func.count()).where(
                            *_wanted(rebuild, True),
                            Attachment.content_type.like("video/%"),
                            Attachment.id.in_(_current_versions()),
                        )
                    )
                ).scalar_one()
            )
        after: uuid.UUID | None = None
        while result.read < limit:
            ids = await _batch(
                db, after, min(20, limit - result.read), rebuild=rebuild, with_videos=with_videos
            )
            await db.rollback()
            if not ids:
                return result
            for attachment_id in ids:
                after = attachment_id
                if await _backfill_one(db, settings, blobs, attachment_id, result, rebuild):
                    result.read += 1
        result.remaining = bool(
            await _batch(db, after, 1, rebuild=rebuild, with_videos=with_videos)
        )
        await db.rollback()
    return result


async def _backfill_one(
    db: AsyncSession,
    settings: Settings,
    blobs: BlobStore,
    attachment_id: uuid.UUID,
    result: BackfillResult,
    rebuild: bool,
) -> bool:
    """Whether the file was read (a rebuild skips an image whose display image is there)."""
    attachment = await db.get(Attachment, attachment_id)
    if (
        attachment is None
        or attachment.status != "attached"
        or not photo_kind(attachment.content_type)
    ):
        await db.rollback()
        return False
    key, content_type, size = attachment.storage_key, attachment.content_type, attachment.size_bytes
    if rebuild and attachment.photo_probed_at is not None:
        shown = attachment.display_key
        if shown is not None and await blobs.exists(shown):
            await db.rollback()
            return False
    await db.rollback()
    try:
        found = await read_stored(blobs, settings, key, content_type, size)
    except Exception as exc:  # the bytes are missing or unreadable: read, nothing found
        log.warning("drive photo %s could not be read: %s", attachment_id, exc)
        result.errors.append(f"{attachment_id}: {exc}")
        found = PhotoResult(taken=None, has_location=False)
    if found is None:
        return False
    row = await db.get(Attachment, attachment_id, with_for_update=True, populate_existing=True)
    if row is None or row.status != "attached":
        await db.rollback()
        return True
    changed = await apply_in_tx(row, found, blobs)
    await db.commit()
    await sync_item(db, attachment_id, announce=changed)
    await db.commit()
    result.dated += int(found.taken is not None)
    result.located += int(found.has_location)
    result.displays += int(found.display is not None)
    return True


def taken_key(item: DriveItem) -> datetime:
    """The order of 「撮影日」 (docs/ALBUMS.md §4.1): the capture time, else the file's own time,
    else when it was put in the drive."""
    return item.taken_at or item.content_modified_at or item.created_at
