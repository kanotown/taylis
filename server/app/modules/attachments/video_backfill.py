"""M79 backfill: shape, length and poster of the videos stored before M79 (`app.cli probe-videos`).

Bounded (at most `limit` a run), resumable and idempotent: a video is taken while its
video_probed_at is NULL, and each one commits on its own, so a run that stops halfway (or is run
again) only does what is left. A video already bound to a message moves the message's updated_seq
with message.updated (change "attachments") in the same transaction, so a device that already
holds the message gets the new size and poster through the delta (SYNC_PROTOCOL.md §7.3) or the
event; a pending, scheduled or canvas one is read fresh by whoever asks for it.
"""

import logging
import tempfile
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.exc import StaleDataError

from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import service as attachments
from app.modules.attachments import videos
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.models import Attachment
from app.modules.messages import service as messages

log = logging.getLogger("app.attachments.backfill")

BATCH = 20


@dataclass
class BackfillResult:
    probed: int = 0  # looked at (found something or not)
    found: int = 0  # now have a shape, a length or a poster
    announced: int = 0  # messages that took a new updated_seq
    remaining: bool = False  # the limit stopped the run; run it again


async def _next_batch(db: AsyncSession, after: uuid.UUID | None, size: int) -> list[uuid.UUID]:
    stmt = (
        select(Attachment.id)
        .where(
            Attachment.content_type.like("video/%"),
            Attachment.status != "deleted",
            Attachment.video_probed_at.is_(None),
        )
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


async def probe_stored_videos(
    db: AsyncSession, blobs: BlobStore, settings: Settings, *, limit: int = 1000
) -> BackfillResult:
    """Probe up to `limit` stored videos that were never probed. Raises when ffmpeg is missing
    (the CLI says so) rather than marking everything as looked at."""
    if videos.tools(settings) is None:
        raise RuntimeError("ffprobe / ffmpeg not found (or VIDEO_PROBE_ENABLED is false)")
    result = BackfillResult()
    after: uuid.UUID | None = None
    while result.probed < limit:
        ids = await _next_batch(db, after, min(BATCH, limit - result.probed))
        if not ids:
            return result
        for attachment_id in ids:
            after = attachment_id
            await _probe_one(db, blobs, settings, attachment_id, result)
            result.probed += 1
    result.remaining = bool(await _next_batch(db, after, 1))
    return result


async def _probe_one(
    db: AsyncSession,
    blobs: BlobStore,
    settings: Settings,
    attachment_id: uuid.UUID,
    result: BackfillResult,
) -> None:
    attachment = await db.get(Attachment, attachment_id)
    if attachment is None or attachment.status == "deleted" or attachment.video_probed_at:
        await db.rollback()
        return
    info: videos.VideoInfo | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix="chikuwa-video-") as named:
            await _download(blobs, attachment.storage_key, named.name)
            info = await videos.probe_video(named.name, settings)
    except Exception as exc:  # the bytes are missing or unreadable: looked at, nothing found
        log.warning("video %s could not be read: %s", attachment_id, exc)
    # The row as it is now: it may have been deleted or bound while ffmpeg ran. No row lock: a
    # send or delete locks the channel before the attachment, and so does the announcement below.
    await db.rollback()
    attachment = await db.get(Attachment, attachment_id, populate_existing=True)
    if attachment is None or attachment.status == "deleted" or attachment.video_probed_at:
        await db.rollback()
        return
    try:
        changed = False
        if info is not None:
            changed = await attachments.apply_video_info(attachment, info, blobs)
        else:
            attachment.video_probed_at = utcnow()
        await db.flush()
        if changed:
            result.found += 1
            if attachment.status == "attached" and attachment.message_id is not None:
                out = await messages.announce_change_by_id_in_tx(
                    db, attachment.message_id, "attachments"
                )
                result.announced += int(out is not None)
        await db.commit()
    except StaleDataError:  # purged by the GC meanwhile
        await db.rollback()
