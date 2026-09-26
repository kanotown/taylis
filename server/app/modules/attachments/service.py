"""Upload / bind / download / GC (SECURITY.md §4, DATA_MODEL.md "attachments")."""

import hashlib
import logging
import re
import uuid
from collections.abc import AsyncIterator
from datetime import datetime, timedelta
from urllib.parse import quote

import filetype
from fastapi import UploadFile
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.errors import AppError, bad_request, forbidden, not_found
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import repository as repo
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import IMAGE_TYPES, make_thumbnail
from app.modules.attachments.models import Attachment
from app.modules.attachments.schemas import (
    AttachmentOut,
    FileItem,
    FileListOut,
    to_attachment_out,
)
from app.modules.channels import service as channels
from app.modules.users.models import User

log = logging.getLogger("app.attachments")

MAX_ATTACHMENTS_PER_MESSAGE = 10
INLINE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
READ_CHUNK = 1024 * 1024
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
    """Stream the multipart body, sniff its type, store it as pending (bound by the send)."""
    digest = hashlib.sha256()
    chunks: list[bytes] = []
    size = 0
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
        chunks.append(chunk)
    if size == 0:
        raise bad_request("attachment_empty", "The file is empty")
    data = b"".join(chunks)
    kind = filetype.guess(data[:8192])
    content_type = kind.mime if kind is not None else "application/octet-stream"

    attachment_id = uuid.uuid4()
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
        try:
            thumb, width, height = await run_in_threadpool(
                make_thumbnail, data, settings.attachment_thumbnail_px
            )
            await blobs.put(thumbnail_key(attachment_id), thumb, "image/jpeg")
            attachment.width, attachment.height = width, height
            attachment.thumbnail_key = thumbnail_key(attachment_id)
        except Exception as exc:  # a broken or hostile image still uploads as a plain file
            log.warning("thumbnail failed for %s: %s", attachment_id, exc)
    await blobs.put(attachment.storage_key, data, content_type)
    db.add(attachment)
    await db.commit()
    await db.refresh(attachment)
    return to_attachment_out(attachment)


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
    rows = {a.id: a for a in await repo.get_many(db, attachment_ids)}
    bound: list[Attachment] = []
    now = utcnow()
    for attachment_id in dict.fromkeys(attachment_ids):
        attachment = rows.get(attachment_id)
        if (
            attachment is None
            or attachment.uploader_id != actor_id
            or attachment.status != "pending"
        ):
            raise bad_request("attachment_invalid", f"Attachment {attachment_id} cannot be used")
        attachment.message_id = message_id
        attachment.channel_id = channel_id
        attachment.status = "attached"
        attachment.attached_at = now
        bound.append(attachment)
    await db.flush()
    return bound


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
    """SECURITY.md §4: attached → channel members, pending → uploader only, deleted → 404."""
    attachment = await repo.get(db, attachment_id)
    if attachment is None or attachment.status == "deleted":
        raise not_found("attachment_not_found", "Attachment not found")
    if attachment.status == "pending":
        if attachment.uploader_id != actor.id:
            raise forbidden("not_uploader", "Only the uploader can access a pending attachment")
        return attachment
    if attachment.channel_id is None:
        raise not_found("attachment_not_found", "Attachment not found")
    await channels.require_member(db, actor.id, attachment.channel_id)
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
    if attachment.thumbnail_key:
        await blobs.delete(attachment.thumbnail_key)


async def verify(db: AsyncSession, blobs: BlobStore) -> list[tuple[uuid.UUID, str]]:
    """After a restore: metadata rows whose bytes are missing (ARCHITECTURE.md §8)."""
    missing: list[tuple[uuid.UUID, str]] = []
    for attachment in await repo.all_live(db):
        if not await blobs.exists(attachment.storage_key):
            missing.append((attachment.id, attachment.storage_key))
        if attachment.thumbnail_key and not await blobs.exists(attachment.thumbnail_key):
            missing.append((attachment.id, attachment.thumbnail_key))
    return missing
