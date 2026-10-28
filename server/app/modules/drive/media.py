"""The drive's media loop (docs/DRIVE.md §6.4): after a completion, one version at a time, the
object's SHA-256 and an image's thumbnail or a video's poster (the existing thumbnail and
ffprobe / ffmpeg steps, SECURITY.md §4); AL1 (docs/ALBUMS.md §4.2): a photo's or a video's capture
time and location mark, and an image's display-size copy (photos.py). The completion answers
without waiting for it.

A claim sets a lease (process_next_at) and counts a try; a try cut off by a restart is taken again
when the lease runs out, at most MAX_ATTEMPTS times. A failure never fails the upload: the file
stays a plain file, like an attachment whose thumbnail could not be made.
"""

import hashlib
import logging
import tempfile
import uuid
from datetime import timedelta
from typing import IO

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.concurrency import run_in_threadpool

from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import service as attachments
from app.modules.attachments import videos
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import IMAGE_TYPES, ImageTooLarge, make_thumbnail
from app.modules.attachments.models import Attachment
from app.modules.drive import events, photos
from app.modules.drive.models import DriveFileVersion, DriveItem

log = logging.getLogger("app.drive.media")

MAX_ATTEMPTS = 3
LEASE = timedelta(minutes=30)
RETRY = timedelta(minutes=5)


async def _claim(db: AsyncSession) -> tuple[uuid.UUID, int] | None:
    now = utcnow()
    stmt = (
        select(DriveFileVersion)
        .where(
            DriveFileVersion.processed_at.is_(None),
            or_(
                DriveFileVersion.process_next_at.is_(None),
                DriveFileVersion.process_next_at <= now,
            ),
        )
        .order_by(DriveFileVersion.process_next_at.asc().nulls_first())
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    version = (await db.execute(stmt)).scalar_one_or_none()
    if version is None:
        await db.rollback()
        return None
    version.process_attempts += 1
    version.process_next_at = now + LEASE
    claimed = (version.id, version.process_attempts)
    await db.commit()
    return claimed


async def process_due(
    session_factory: async_sessionmaker[AsyncSession], settings: Settings, blobs: BlobStore
) -> int:
    """One version, if any is due: 1, else 0."""
    async with session_factory() as db:
        claimed = await _claim(db)
        if claimed is None:
            return 0
        version_id, attempt = claimed
        version = await db.get(DriveFileVersion, version_id)
        attachment = await db.get(Attachment, version.attachment_id) if version else None
        if version is None or attachment is None or attachment.status == "deleted":
            await _done(db, version_id, None)
            return 1
        if attempt > MAX_ATTEMPTS:
            log.warning("giving up on the media of drive version %s", version_id)
            await _done(db, version_id, None)
            return 1
        key, content_type, size = (
            attachment.storage_key,
            attachment.content_type,
            attachment.size_bytes,
        )
        await db.commit()
        try:
            digest, thumb, video, photo = await _read(blobs, settings, key, content_type, size)
        except Exception:
            log.warning("reading drive version %s failed", version_id, exc_info=True)
            async with session_factory() as retry:
                row = await retry.get(DriveFileVersion, version_id, with_for_update=True)
                if row is not None and row.processed_at is None:
                    row.process_next_at = utcnow() + RETRY
                await retry.commit()
            return 1
        await _done(db, version_id, digest, thumb=thumb, video=video, photo=photo, blobs=blobs)
        return 1


async def _read(
    blobs: BlobStore, settings: Settings, key: str, content_type: str, size: int
) -> tuple[
    bytes,
    tuple[bytes, int, int] | None,
    videos.VideoInfo | None,
    photos.PhotoResult | None,
]:
    """Streams the object once: its SHA-256, and (an image or a video within the limits) a
    temporary copy for the thumbnail or the probe and the photo's information, removed
    afterwards. The photo result is None when nothing was tried (a video without ffmpeg)."""
    image = content_type in IMAGE_TYPES and size <= settings.drive_image_thumb_max_bytes
    video = (
        videos.is_video(content_type)
        and size <= settings.drive_video_probe_max_bytes
        and videos.tools(settings) is not None
    )
    digest = hashlib.sha256()
    with tempfile.NamedTemporaryFile(prefix="taylis-drive-") as copy:
        async for chunk in blobs.stream(key):
            digest.update(chunk)
            if image or video:
                await run_in_threadpool(copy.write, chunk)
        await run_in_threadpool(copy.flush)
        thumb: tuple[bytes, int, int] | None = None
        info: videos.VideoInfo | None = None
        photo: photos.PhotoResult | None = None
        if image:
            thumb = await _thumbnail(copy, settings)
            photo = await photos.read_image(copy, settings)
        elif video:
            try:
                info = await videos.probe_video(copy.name, settings)
            except Exception:
                log.warning("probing a drive video failed", exc_info=True)
            if info is not None:
                photo = photos.from_video(info)
        elif content_type in IMAGE_TYPES:
            # Larger than DRIVE_IMAGE_THUMB_MAX_BYTES: read, nothing made.
            photo = photos.PhotoResult(taken=None, has_location=False)
    return digest.digest(), thumb, info, photo


async def _thumbnail(source: IO[bytes], settings: Settings) -> tuple[bytes, int, int] | None:
    source.seek(0)
    try:
        return await run_in_threadpool(make_thumbnail, source, settings.attachment_thumbnail_px)
    except ImageTooLarge:
        return None
    except Exception:  # a broken or hostile image stays a plain file
        log.warning("a drive thumbnail failed", exc_info=True)
        return None


async def _done(
    db: AsyncSession,
    version_id: uuid.UUID,
    digest: bytes | None,
    *,
    thumb: tuple[bytes, int, int] | None = None,
    video: videos.VideoInfo | None = None,
    photo: photos.PhotoResult | None = None,
    blobs: BlobStore | None = None,
) -> None:
    version = await db.get(
        DriveFileVersion, version_id, with_for_update=True, populate_existing=True
    )
    if version is None:
        await db.rollback()
        return
    attachment = await db.get(
        Attachment, version.attachment_id, with_for_update=True, populate_existing=True
    )
    changed = False
    if attachment is not None and attachment.status != "deleted":
        if digest is not None:
            version.sha256 = digest
            attachment.sha256 = digest
        if thumb is not None and blobs is not None:
            data, width, height = thumb
            key = attachments.thumbnail_key(attachment.id)
            await blobs.put(key, data, "image/jpeg")
            changed = attachment.thumbnail_key is None
            attachment.thumbnail_key = key
            attachment.width, attachment.height = width, height
        if video is not None and blobs is not None:
            changed = await attachments.apply_video_info(attachment, video, blobs) or changed
        elif videos.is_video(attachment.content_type):
            attachment.video_probed_at = utcnow()
        if photo is not None and blobs is not None:
            changed = await photos.apply_in_tx(attachment, photo, blobs) or changed
    version.processed_at = utcnow()
    version.process_next_at = None
    await db.flush()
    item_id = version.item_id
    photo_of = attachment.id if photo is not None and attachment is not None else None
    if changed:
        item = await db.get(DriveItem, item_id)
        if item is not None and item.current_version_id == version.id:
            await events.emit_changed(db, item.location_id, [item.parent_id])
    await db.commit()
    if photo_of is not None:
        # The item's copy of the capture time, on its own (photos.py: never an item after an
        # attachment in one transaction).
        await photos.sync_item(db, photo_of, announce=False)
        await db.commit()
