"""Upload / bind / download / GC (SECURITY.md §4, DATA_MODEL.md "attachments")."""

import hashlib
import logging
import re
import shutil
import tempfile
import uuid
from collections.abc import AsyncIterator
from datetime import datetime, timedelta
from typing import IO
from urllib.parse import quote

import filetype
from fastapi import UploadFile
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.errors import AppError, bad_request, forbidden, not_found
from app.core.ids import uuid7
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import repository as repo
from app.modules.attachments import videos
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import IMAGE_TYPES, ImageTooLarge, make_thumbnail
from app.modules.attachments.models import Attachment
from app.modules.attachments.preview_kinds import possible_preview_keys, queue_on_upload
from app.modules.attachments.schemas import (
    AttachmentOut,
    FileItem,
    FileListOut,
    to_attachment_out,
)
from app.modules.attachments.videos import is_video
from app.modules.channels import service as channels
from app.modules.users.models import User

log = logging.getLogger("app.attachments")

MAX_ATTACHMENTS_PER_MESSAGE = 10
# CANVAS.md §4.3: images (and files) bound to one canvas.
MAX_ATTACHMENTS_PER_CANVAS = 100
INLINE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
READ_CHUNK = 1024 * 1024
# An upload larger than this is spooled to a temporary file rather than held in memory.
SPOOL_MAX_BYTES = 8 * 1024 * 1024
SNIFF_BYTES = 8192
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def sanitize_filename(name: str | None) -> str:
    """Display name only: no path separators or control characters (SECURITY.md §4)."""
    base = (name or "").replace("\\", "/").split("/")[-1]
    cleaned = _CONTROL.sub("", base).strip()[:255]
    return cleaned or "file"


def storage_key(attachment_id: uuid.UUID) -> str:
    return f"attachments/{attachment_id}"


def thumbnail_key(attachment_id: uuid.UUID) -> str:
    # A sibling key, not "attachments/{id}/thumb.jpg": on a posix-backed store the object
    # "attachments/{id}" and a directory of the same name cannot coexist.
    return f"attachments/{attachment_id}.thumb.jpg"


async def upload(
    db: AsyncSession, actor: User, file: UploadFile, settings: Settings, blobs: BlobStore
) -> AttachmentOut:
    """Stream the multipart body, sniff its type, store it as pending (bound by the send).

    The bytes go through a spooled temporary file (memory up to SPOOL_MAX_BYTES, disk beyond), so
    a 100 MB upload never sits in memory, let alone twice; the thumbnail and the store read the
    same file.
    """
    digest = hashlib.sha256()
    head = b""
    size = 0
    with tempfile.SpooledTemporaryFile(max_size=SPOOL_MAX_BYTES) as spool:
        while True:
            chunk = await file.read(READ_CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if size > settings.attachment_max_bytes:
                raise AppError(
                    413,
                    "attachment_too_large",
                    f"Attachments are limited to {settings.attachment_max_bytes} bytes",
                )
            digest.update(chunk)
            if len(head) < SNIFF_BYTES:
                head += chunk[: SNIFF_BYTES - len(head)]
            spool.write(chunk)
        if size == 0:
            raise bad_request("attachment_empty", "The file is empty")
        kind = filetype.guess(head)
        content_type = kind.mime if kind is not None else "application/octet-stream"

        # UUIDv7 like every other id (DATA_MODEL.md): generated here because the storage key
        # needs it.
        attachment_id = uuid7()
        attachment = Attachment(
            id=attachment_id,
            uploader_id=actor.id,
            filename=sanitize_filename(file.filename),
            content_type=content_type,
            size_bytes=size,
            sha256=digest.digest(),
            storage_key=storage_key(attachment_id),
        )
        if content_type in IMAGE_TYPES:
            spool.seek(0)
            try:
                thumb, width, height = await run_in_threadpool(
                    make_thumbnail, spool, settings.attachment_thumbnail_px
                )
            except ImageTooLarge as exc:
                # Refused rather than stored as a plain file: the clients would try to show it.
                raise AppError(
                    422, "image_too_large", "The image has too many pixels to be shown"
                ) from exc
            except Exception as exc:  # a broken or hostile image still uploads as a plain file
                log.warning("thumbnail failed for %s: %s", attachment_id, exc)
            else:
                await blobs.put(thumbnail_key(attachment_id), thumb, "image/jpeg")
                attachment.width, attachment.height = width, height
                attachment.thumbnail_key = thumbnail_key(attachment_id)
        elif is_video(content_type):
            await _probe_spooled_video(attachment, spool, settings, blobs)
        spool.seek(0)
        await blobs.put(attachment.storage_key, spool, content_type)
    # M108: a PDF or Office file is queued for its preview (made by the preview loop, not here).
    queue_on_upload(attachment, settings)
    db.add(attachment)
    await db.commit()
    await db.refresh(attachment)
    return to_attachment_out(attachment)


async def _probe_spooled_video(
    attachment: Attachment, spool: IO[bytes], settings: Settings, blobs: BlobStore
) -> None:
    """M79: the shape, length and poster of an uploaded video, before the upload answers (it is
    still pending, so no device holds it yet and nothing has to be announced). ffprobe needs a
    named, seekable file (an MP4 may keep its index at the end), so the spool is copied to one.
    Never fails the upload."""
    if videos.tools(settings) is None:
        return
    try:
        with tempfile.NamedTemporaryFile(prefix="chikuwa-video-") as named:
            spool.seek(0)
            await run_in_threadpool(shutil.copyfileobj, spool, named, READ_CHUNK)
            await run_in_threadpool(named.flush)
            info = await videos.probe_video(named.name, settings)
        if info is not None:
            await apply_video_info(attachment, info, blobs)
    except Exception as exc:
        log.warning("video probe failed for %s: %s", attachment.id, exc)


async def apply_video_info(
    attachment: Attachment, info: videos.VideoInfo, blobs: BlobStore
) -> bool:
    """Record what the probe found (the poster goes to the store first). True when the attachment
    now shows anything new (a shape, a length or a poster)."""
    changed = False
    if info.poster is not None:
        await blobs.put(thumbnail_key(attachment.id), info.poster, "image/jpeg")
        changed = changed or attachment.thumbnail_key is None
        attachment.thumbnail_key = thumbnail_key(attachment.id)
    if info.width is not None and info.height is not None:
        changed = changed or (attachment.width, attachment.height) != (info.width, info.height)
        attachment.width, attachment.height = info.width, info.height
    if info.duration_ms is not None:
        changed = changed or attachment.duration_ms != info.duration_ms
        attachment.duration_ms = info.duration_ms
    attachment.video_probed_at = utcnow()
    return changed


async def bind_in_tx(
    db: AsyncSession,
    actor_id: uuid.UUID,
    channel_id: uuid.UUID,
    message_id: uuid.UUID,
    attachment_ids: list[uuid.UUID],
) -> list[Attachment]:
    """Attach pending uploads of the sender to a new message (same transaction)."""
    if not attachment_ids:
        return []
    if len(attachment_ids) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise bad_request(
            "too_many_attachments", f"At most {MAX_ATTACHMENTS_PER_MESSAGE} attachments"
        )
    # FOR UPDATE (M108): a document preview being recorded meanwhile is waited for and carried by
    # the message.created this send writes (previews._finish).
    rows = {a.id: a for a in await repo.get_many(db, attachment_ids, for_update=True)}
    bound: list[Attachment] = []
    now = utcnow()
    for attachment_id in dict.fromkeys(attachment_ids):
        attachment = rows.get(attachment_id)
        if (
            attachment is None
            or attachment.uploader_id != actor_id
            or attachment.status not in ("pending", "scheduled")
        ):
            raise bad_request("attachment_invalid", f"Attachment {attachment_id} cannot be used")
        attachment.message_id = message_id
        attachment.channel_id = channel_id
        attachment.status = "attached"
        attachment.attached_at = now
        bound.append(attachment)
    await db.flush()
    return bound


async def bind_to_canvas_in_tx(
    db: AsyncSession,
    actor_id: uuid.UUID,
    *,
    canvas_id: uuid.UUID,
    channel_id: uuid.UUID,
    attachment_ids: list[uuid.UUID],
) -> list[Attachment]:
    """Bind the actor's own pending uploads that a canvas's body now refers to (CANVAS.md §4.10).

    Unlike a message, the ids come from the body (`attachment:<uuid>`), so ids that are not the
    actor's pending uploads (someone else's, already bound elsewhere, gone) are skipped, not
    refused: the body keeps them and the clients show 「表示できない画像」. Past
    MAX_ATTACHMENTS_PER_CANVAS the save is refused (400 too_many_canvas_images)."""
    if not attachment_ids:
        return []
    rows = [
        a
        for a in await repo.get_many(db, list(dict.fromkeys(attachment_ids)))
        if a.uploader_id == actor_id and a.status == "pending"
    ]
    if not rows:
        return []
    if await repo.count_for_canvas(db, canvas_id) + len(rows) > MAX_ATTACHMENTS_PER_CANVAS:
        raise bad_request(
            "too_many_canvas_images",
            f"A canvas holds at most {MAX_ATTACHMENTS_PER_CANVAS} images and files",
        )
    now = utcnow()
    for attachment in rows:
        attachment.canvas_id = canvas_id
        attachment.channel_id = channel_id
        attachment.status = "attached"
        attachment.attached_at = now
    await db.flush()
    return rows


async def mark_ids_deleted_in_tx(db: AsyncSession, attachment_ids: list[uuid.UUID]) -> int:
    """Gone at once (404); the GC loop removes the bytes and then the rows."""
    now = utcnow()
    count = 0
    for attachment in await repo.get_many(db, attachment_ids):
        if attachment.status != "deleted":
            attachment.status = "deleted"
            attachment.deleted_at = now
            count += 1
    await db.flush()
    return count


async def mark_canvases_deleted_in_tx(db: AsyncSession, canvas_ids: list[uuid.UUID]) -> int:
    """The canvases are purged (CANVAS.md §4.14): their images go with them."""
    rows = await repo.for_canvases(db, canvas_ids)
    return await mark_ids_deleted_in_tx(db, [a.id for a in rows])


async def reserve_in_tx(
    db: AsyncSession, actor_id: uuid.UUID, attachment_ids: list[uuid.UUID]
) -> list[Attachment]:
    """Hold pending uploads for a scheduled message (M12d): the pending GC leaves them alone."""
    if len(attachment_ids) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise bad_request(
            "too_many_attachments", f"At most {MAX_ATTACHMENTS_PER_MESSAGE} attachments"
        )
    rows = {a.id: a for a in await repo.get_many(db, attachment_ids)}
    reserved: list[Attachment] = []
    for attachment_id in dict.fromkeys(attachment_ids):
        attachment = rows.get(attachment_id)
        if (
            attachment is None
            or attachment.uploader_id != actor_id
            or attachment.status != "pending"
        ):
            raise bad_request("attachment_invalid", f"Attachment {attachment_id} cannot be used")
        attachment.status = "scheduled"
        reserved.append(attachment)
    await db.flush()
    return reserved


async def release_in_tx(db: AsyncSession, attachment_ids: list[uuid.UUID]) -> None:
    """A cancelled or failed scheduled message drops its unsent uploads; GC removes the bytes."""
    now = utcnow()
    for attachment in await repo.get_many(db, attachment_ids):
        if attachment.status == "scheduled":
            attachment.status = "deleted"
            attachment.deleted_at = now
    await db.flush()


async def get_many(db: AsyncSession, attachment_ids: list[uuid.UUID]) -> list[Attachment]:
    if not attachment_ids:
        return []
    rows = {a.id: a for a in await repo.get_many(db, attachment_ids)}
    return [rows[i] for i in attachment_ids if i in rows]


async def mark_deleted_in_tx(db: AsyncSession, message_id: uuid.UUID) -> None:
    """The message was deleted: its attachments vanish at once; GC removes the bytes later."""
    now = utcnow()
    for attachment in await repo.for_message(db, message_id):
        attachment.status = "deleted"
        attachment.deleted_at = now
    await db.flush()


async def for_messages(
    db: AsyncSession, message_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[AttachmentOut]]:
    grouped: dict[uuid.UUID, list[AttachmentOut]] = {}
    for attachment in await repo.for_messages(db, message_ids):
        if attachment.message_id is not None:
            grouped.setdefault(attachment.message_id, []).append(to_attachment_out(attachment))
    return grouped


def _parse_cursor(cursor: str | None) -> tuple[datetime, uuid.UUID] | None:
    if cursor is None:
        return None
    try:
        raw_at, raw_id = cursor.split("|", 1)
        return datetime.fromisoformat(raw_at), uuid.UUID(raw_id)
    except ValueError as exc:
        raise bad_request("invalid_cursor", "Malformed cursor") from exc


async def list_files(
    db: AsyncSession,
    actor: User,
    *,
    channel_id: uuid.UUID | None,
    query: str | None,
    cursor: str | None,
    limit: int,
) -> FileListOut:
    """Files in the channels the actor belongs to, newest first (M11i).

    A channel the actor is not a member of yields nothing rather than an error.
    """
    rows = await repo.list_attached(
        db,
        actor.id,
        channel_id=channel_id,
        query=(query or "").strip() or None,
        before=_parse_cursor(cursor),
        limit=limit,
    )
    items = [
        FileItem(
            attachment=to_attachment_out(row),
            message_id=row.message_id,
            channel_id=row.channel_id,
            parent_id=parent_id,
            uploader_id=row.uploader_id,
            attached_at=row.attached_at,
        )
        for row, parent_id in rows
        if row.message_id is not None and row.channel_id is not None and row.attached_at
    ]
    next_cursor = None
    if len(rows) == limit and items:
        last = items[-1]
        next_cursor = f"{last.attached_at.isoformat()}|{last.attachment.id}"
    return FileListOut(items=items, next_cursor=next_cursor)


async def get_for_access(db: AsyncSession, actor: User, attachment_id: uuid.UUID) -> Attachment:
    """SECURITY.md §4: attached → channel members (and in a public channel anyone but a guest,
    who reads it before joining: M27), pending → uploader only, deleted → 404. A canvas's image
    (M42) → the conversation's members only, like the canvas itself (CANVAS.md §4.7)."""
    attachment = await repo.get(db, attachment_id)
    if attachment is None or attachment.status == "deleted":
        raise not_found("attachment_not_found", "Attachment not found")
    if attachment.status == "pending":
        if attachment.uploader_id != actor.id:
            raise forbidden("not_uploader", "Only the uploader can access a pending attachment")
        return attachment
    if attachment.channel_id is None:
        raise not_found("attachment_not_found", "Attachment not found")
    if attachment.canvas_id is not None:
        await channels.require_member(db, actor.id, attachment.channel_id)
        return attachment
    await channels.require_readable(db, actor, attachment.channel_id)
    return attachment


def content_headers(attachment: Attachment, *, inline: bool) -> dict[str, str]:
    disposition = "inline" if inline and attachment.content_type in INLINE_TYPES else "attachment"
    ascii_name = re.sub(r"[^A-Za-z0-9._-]", "_", attachment.filename) or "download"
    return {
        "Content-Disposition": f'{disposition}; filename="{ascii_name}"; '
        f"filename*=UTF-8''{quote(attachment.filename)}",
        "Content-Type": attachment.content_type,
        "Content-Length": str(attachment.size_bytes),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
    }


def preview_pdf_headers(attachment: Attachment) -> dict[str, str]:
    """M108: the preview PDF is shown inline (a PDF upload's preview is the upload itself, the
    only file served inline that is not an image). The CSP sandbox gives a browser that opens it
    directly no scripts, forms or same-origin access; nosniff keeps it a PDF."""
    stem = attachment.filename.rsplit(".", 1)[0]
    name = f"{stem or 'preview'}.pdf"
    ascii_name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    headers = {
        "Content-Type": "application/pdf",
        "Content-Disposition": f"inline; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}",
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
    }
    if attachment.preview_pdf_key is None:
        headers["Content-Length"] = str(attachment.size_bytes)
    return headers


def stream(blobs: BlobStore, key: str) -> AsyncIterator[bytes]:
    return blobs.stream(key)


async def gc(
    db: AsyncSession, blobs: BlobStore, *, now: datetime | None = None, pending_ttl_hours: int = 24
) -> tuple[int, int]:
    """(expired pending removed, deleted purged). Bytes first, then the row; both are idempotent."""
    now = now or utcnow()
    removed = purged = 0
    for attachment in await repo.expired_pending(db, now - timedelta(hours=pending_ttl_hours), 500):
        await _delete_blobs(blobs, attachment)
        await db.delete(attachment)
        removed += 1
    for attachment in await repo.deleted(db, 500):
        await _delete_blobs(blobs, attachment)
        await db.delete(attachment)
        purged += 1
    await db.commit()
    return removed, purged


async def _delete_blobs(blobs: BlobStore, attachment: Attachment) -> None:
    await blobs.delete(attachment.storage_key)
    keys = _derived_keys(attachment)
    if attachment.preview_status != "none" or attachment.preview_generation:
        # Review v0.1.37 #9: also what a preview try stored but never recorded (a try that failed
        # or stopped after the PDF was written); the keys are predictable from the claim number.
        possible = possible_preview_keys(attachment.id, attachment.preview_generation)
        keys += [key for key in possible if key not in keys]
    for key in keys:
        await blobs.delete(key)


def _derived_keys(attachment: Attachment) -> list[str]:
    """The thumbnail or poster, and (M108) the preview's PDF and thumbnail."""
    keys = (attachment.thumbnail_key, attachment.preview_pdf_key, attachment.preview_thumb_key)
    return [key for key in keys if key]


async def verify(db: AsyncSession, blobs: BlobStore) -> list[tuple[uuid.UUID, str]]:
    """After a restore: metadata rows whose bytes are missing (ARCHITECTURE.md §8)."""
    missing: list[tuple[uuid.UUID, str]] = []
    for attachment in await repo.all_live(db):
        if not await blobs.exists(attachment.storage_key):
            missing.append((attachment.id, attachment.storage_key))
        for key in _derived_keys(attachment):
            if not await blobs.exists(key):
                missing.append((attachment.id, key))
    return missing
