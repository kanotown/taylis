"""Upload / bind / download / GC (SECURITY.md §4, DATA_MODEL.md "attachments")."""

import hashlib
import logging
import re
import shutil
import tempfile
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import IO
from urllib.parse import quote

import filetype
from fastapi import UploadFile
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.errors import AppError, bad_request, forbidden, not_found
from app.core.ids import uuid7
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import heif, videos
from app.modules.attachments import repository as repo
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import IMAGE_TYPES, ImageTooLarge, make_thumbnail
from app.modules.attachments.models import Attachment
from app.modules.attachments.preview_kinds import possible_preview_keys, queue_on_upload
from app.modules.attachments.schemas import (
    AttachmentDriveOut,
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
# docs/WIKI.md §4.7: images and files bound to one wiki page (an imported Notion page may have
# many).
MAX_ATTACHMENTS_PER_PAGE = 200

# M120: whether someone can read a wiki page (wiki.access, handed over by main.py: the wiki
# depends on attachments, not the other way round). Unset: a page's file is never served.
PageReadable = Callable[[AsyncSession, User, uuid.UUID], Awaitable[bool]]
_page_readable: PageReadable | None = None


def set_page_access_check(check: PageReadable | None) -> None:
    global _page_readable
    _page_readable = check


# M160 (docs/DRIVE.md §4.1): whether someone can read a drive item (drive.access.can_read_item,
# handed over by main.py: the drive depends on attachments). Unset: a drive file is never served.
DriveReadable = Callable[[AsyncSession, User, uuid.UUID], Awaitable[bool]]
_drive_readable: DriveReadable | None = None


def set_drive_access_check(check: DriveReadable | None) -> None:
    global _drive_readable
    _drive_readable = check


# CF1 (docs/CHANNEL_FILES.md §5.2): whether someone reads a posted file through its message (the
# message is alive and readable, the item is in that channel's drive and not in the trash):
# drive.channel_files.posted_readable, handed over by main.py. Unset: only the drive's rule.
PostedReadable = Callable[[AsyncSession, User, Attachment], Awaitable[bool]]
_posted_readable: PostedReadable | None = None


def set_posted_access_check(check: PostedReadable | None) -> None:
    global _posted_readable
    _posted_readable = check


# M167 (docs/LENDING.md §4.3): whether someone can see an equipment item's photo
# (lending.access.can_read_photo, handed over by main.py). Unset: such a photo is never served.
LendingReadable = Callable[[AsyncSession, User, uuid.UUID], Awaitable[bool]]
_lending_readable: LendingReadable | None = None


def set_lending_access_check(check: LendingReadable | None) -> None:
    global _lending_readable
    _lending_readable = check


INLINE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
# The registered name a file's bytes are served under where the sniffer (`filetype`) answers an
# old one (docs/PREVIEWS.md §13): the macOS WKWebView refuses a FLAC served as audio/x-flac
# (MediaError 4) and plays it as audio/flac (measured 2026-10-28, macOS 26.6). The stored
# content_type (and the API's) stays as sniffed.
SERVED_TYPES = {"audio/x-flac": "audio/flac"}


def served_type(content_type: str) -> str:
    return SERVED_TYPES.get(content_type.lower(), content_type)


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


def display_key(attachment_id: uuid.UUID) -> str:
    """AL1 (docs/ALBUMS.md §6): a drive image's display-size copy (WebP, no metadata)."""
    return f"attachments/{attachment_id}.display.webp"


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
        elif heif.is_heif(content_type):
            await _heif_spooled(attachment, spool, settings, blobs)
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


async def _heif_spooled(
    attachment: Attachment, spool: IO[bytes], settings: Settings, blobs: BlobStore
) -> None:
    """AL5 (docs/ALBUMS.md §19): a HEIC's thumbnail and upright size before the upload answers,
    as an image's, decoded by ffmpeg from a named copy of the spool (heif.py). Never fails the
    upload: a HEIC ffmpeg cannot read, or one past the pixel limit, stays a plain file (HEICs were
    accepted as files before AL5, so the limit does not refuse them as it refuses an image)."""
    if videos.tools(settings) is None:
        return
    try:
        with tempfile.NamedTemporaryFile(prefix="chikuwa-heif-") as named:
            spool.seek(0)
            await run_in_threadpool(shutil.copyfileobj, spool, named, READ_CHUNK)
            await run_in_threadpool(named.flush)
            found = await heif.read(named.name, settings, UTC, now=utcnow(), display=False)
    except Exception as exc:
        log.warning("HEIF thumbnail failed for %s: %s", attachment.id, exc)
        return
    if found is None or found.thumbnail is None:
        return
    thumb, width, height = found.thumbnail
    await blobs.put(thumbnail_key(attachment.id), thumb, "image/jpeg")
    attachment.width, attachment.height = width, height
    attachment.thumbnail_key = thumbnail_key(attachment.id)


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


async def bind_to_lending_item_in_tx(
    db: AsyncSession,
    actor_id: uuid.UUID,
    attachment_id: uuid.UUID,
    *,
    lending_item_id: uuid.UUID,
    content_types: frozenset[str],
) -> Attachment | None:
    """M167 (docs/LENDING.md §4.3): an equipment item's photo, the actor's own pending upload of
    one of `content_types`. None when it cannot be used (someone else's, already bound to
    something, not such an image): the caller answers 400 lending_photo_invalid."""
    rows = await repo.get_many(db, [attachment_id], for_update=True)
    attachment = rows[0] if rows else None
    if (
        attachment is None
        or attachment.uploader_id != actor_id
        or attachment.status != "pending"
        or attachment.content_type not in content_types
    ):
        return None
    attachment.lending_item_id = lending_item_id
    attachment.status = "attached"
    attachment.attached_at = utcnow()
    await db.flush()
    return attachment


async def bind_to_page_in_tx(
    db: AsyncSession, actor_id: uuid.UUID, *, page_id: uuid.UUID, attachment_ids: list[uuid.UUID]
) -> list[Attachment]:
    """Bind the actor's own pending uploads that a wiki page's body now refers to (M120, as for
    a canvas: ids that are not the actor's pending uploads are skipped). Past
    MAX_ATTACHMENTS_PER_PAGE the save is refused (400 too_many_page_files)."""
    if not attachment_ids:
        return []
    rows = [
        a
        for a in await repo.get_many(db, list(dict.fromkeys(attachment_ids)))
        if a.uploader_id == actor_id and a.status == "pending"
    ]
    if not rows:
        return []
    if await repo.count_for_page(db, page_id) + len(rows) > MAX_ATTACHMENTS_PER_PAGE:
        raise bad_request(
            "too_many_page_files",
            f"A page holds at most {MAX_ATTACHMENTS_PER_PAGE} images and files",
        )
    now = utcnow()
    for attachment in rows:
        attachment.page_id = page_id
        attachment.status = "attached"
        attachment.attached_at = now
    await db.flush()
    return rows


async def copy_page_files_in_tx(
    db: AsyncSession,
    blobs: BlobStore,
    settings: Settings,
    actor_id: uuid.UUID,
    *,
    source_page_id: uuid.UUID,
    attachment_ids: list[uuid.UUID],
    page_id: uuid.UUID,
) -> dict[uuid.UUID, uuid.UUID]:
    """M145 (docs/WIKI.md §22.3): a page made from a template or duplicated gets its own copy of
    the files the original's body refers to (bound to the original), so trashing or editing one
    never takes the other's files. The bytes are copied inside the object store (CopyObject);
    the copy is attached to the new page at once and its uploader is the actor. A preview is made
    again for the copy. Returns {original id: copy id} for rewriting the body. Files that are not
    the original's (someone else's page, a message's) are left as they are.

    The objects are written before the transaction commits: a rollback leaves unreferenced
    objects behind, never a row without its bytes."""
    wanted = list(dict.fromkeys(attachment_ids))
    if not wanted:
        return {}
    rows = [
        a
        for a in await repo.get_many(db, wanted)
        if a.page_id == source_page_id and a.status == "attached"
    ]
    copies: dict[uuid.UUID, uuid.UUID] = {}
    now = utcnow()
    for original in sorted(rows, key=lambda a: a.id):
        new_id = uuid7()
        copy = Attachment(
            id=new_id,
            uploader_id=actor_id,
            page_id=page_id,
            status="attached",
            filename=original.filename,
            content_type=original.content_type,
            size_bytes=original.size_bytes,
            sha256=original.sha256,
            storage_key=storage_key(new_id),
            width=original.width,
            height=original.height,
            duration_ms=original.duration_ms,
            video_probed_at=original.video_probed_at,
            created_at=now,
            attached_at=now,
        )
        await blobs.copy(original.storage_key, copy.storage_key)
        if original.thumbnail_key:
            copy.thumbnail_key = thumbnail_key(new_id)
            await blobs.copy(original.thumbnail_key, copy.thumbnail_key)
        queue_on_upload(copy, settings)
        db.add(copy)
        copies[original.id] = new_id
    await db.flush()
    return copies


async def mark_pages_deleted_in_tx(db: AsyncSession, page_ids: list[uuid.UUID]) -> int:
    """The wiki pages are purged: their images and files go with them."""
    rows = await repo.for_pages(db, page_ids)
    return await mark_ids_deleted_in_tx(db, [a.id for a in rows])


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
    """The message was deleted: its attachments vanish at once; GC removes the bytes later.

    CF1 (docs/CHANNEL_FILES.md §7.3): a posted file that is still a drive version is only taken
    off the message (message_id, channel_id and drive_state NULL): it stays in the drive as an
    ordinary version (or was put in the trash just before, by the delete's drive_files rule). A
    tombstone goes like any deleted attachment. The rows are locked (after the channel, like a
    send): a drive move or trash in flight is waited for."""
    now = utcnow()
    for attachment in await repo.for_message(db, message_id, for_update=True):
        if attachment.drive_state is not None and attachment.drive_state != "deleted":
            attachment.message_id = None
            attachment.channel_id = None
            attachment.drive_state = None
            continue
        attachment.drive_state = None
        attachment.status = "deleted"
        attachment.deleted_at = attachment.deleted_at or now
    await db.flush()


async def drive_outs(
    db: AsyncSession, rows: list[Attachment]
) -> dict[uuid.UUID, AttachmentDriveOut]:
    """CF1: `AttachmentOut.drive` of the posted files among `rows`."""
    posted = [a for a in rows if a.drive_state is not None]
    versions = await repo.drive_versions(db, [a.id for a in posted if a.drive_item_id])
    out: dict[uuid.UUID, AttachmentDriveOut] = {}
    for attachment in posted:
        version = versions.get(attachment.id)
        deleted = attachment.drive_state == "deleted"
        out[attachment.id] = AttachmentDriveOut(
            item_id=None if deleted else attachment.drive_item_id,
            version_id=version[0] if version and not deleted else None,
            version_number=version[1] if version and not deleted else None,
            state=attachment.drive_state,  # type: ignore[arg-type]
        )
    return out


async def attachments_out(db: AsyncSession, rows: list[Attachment]) -> list[AttachmentOut]:
    drive = await drive_outs(db, rows)
    return [to_attachment_out(a, drive.get(a.id)) for a in rows]


async def for_messages(
    db: AsyncSession, message_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[AttachmentOut]]:
    rows = await repo.for_messages(db, message_ids)
    drive = await drive_outs(db, rows)
    grouped: dict[uuid.UUID, list[AttachmentOut]] = {}
    for attachment in rows:
        if attachment.message_id is not None:
            grouped.setdefault(attachment.message_id, []).append(
                to_attachment_out(attachment, drive.get(attachment.id))
            )
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
    drive = await drive_outs(db, [row for row, _ in rows])
    items = [
        FileItem(
            attachment=to_attachment_out(row, drive.get(row.id)),
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
    (M42) → the conversation's members only, like the canvas itself (CANVAS.md §4.7). A wiki page's
    file (M120) → whoever can read the page. A drive file's version (M160) → whoever can read the
    drive item. An equipment item's photo (M167) → every person while the 備品 feature is on."""
    attachment = await repo.get(db, attachment_id)
    if attachment is None or attachment.status == "deleted":
        raise not_found("attachment_not_found", "Attachment not found")
    if attachment.status == "pending":
        if attachment.uploader_id != actor.id:
            raise forbidden("not_uploader", "Only the uploader can access a pending attachment")
        return attachment
    if attachment.drive_state is not None:
        # CF1 (docs/CHANNEL_FILES.md §5): a posted file. Whoever can read the drive item now,
        # or whoever reads its (live) message while the item is in that channel's drive and not
        # in the trash (the channel's 403 as for any attachment); recomputed here every time
        # (drive_state is for display only). Moved, trashed or a tombstone: 404 for the others.
        if attachment.drive_item_id is None or attachment.status != "attached":
            raise not_found("attachment_not_found", "Attachment not found")
        if _drive_readable is not None and await _drive_readable(
            db, actor, attachment.drive_item_id
        ):
            return attachment
        if _posted_readable is not None and await _posted_readable(db, actor, attachment):
            return attachment
        raise not_found("attachment_not_found", "Attachment not found")
    if attachment.drive_item_id is not None:
        # M160 (docs/DRIVE.md §4.1): a drive file's version, an old one too: whoever can read the
        # item (not in the trash); for anyone else it does not exist.
        if _drive_readable is None or not await _drive_readable(
            db, actor, attachment.drive_item_id
        ):
            raise not_found("attachment_not_found", "Attachment not found")
        return attachment
    if attachment.lending_item_id is not None:
        # M167 (docs/LENDING.md §4.3): an equipment item's photo, read like the ledger (every
        # person while the feature is on); for anyone else it does not exist.
        if _lending_readable is None or not await _lending_readable(
            db, actor, attachment.lending_item_id
        ):
            raise not_found("attachment_not_found", "Attachment not found")
        return attachment
    if attachment.page_id is not None:
        # M120 (docs/WIKI.md §4.7): whoever can read the page (and it is not in the trash); for
        # anyone else the file does not exist, like the page.
        if _page_readable is None or not await _page_readable(db, actor, attachment.page_id):
            raise not_found("attachment_not_found", "Attachment not found")
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
        "Content-Type": served_type(attachment.content_type),
        "Content-Length": str(attachment.size_bytes),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
        # M160: an attachment's bytes never change, so its id is its ETag (If-Range).
        "Accept-Ranges": "bytes",
        "ETag": f'"{attachment.id}"',
    }


def disposition(name: str, *, inline: bool) -> str:
    """Content-Disposition for a name someone chose (M160: a drive file's current name)."""
    ascii_name = re.sub(r"[^A-Za-z0-9._-]", "_", name) or "download"
    kind = "inline" if inline else "attachment"
    return f"{kind}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"


def requested_range(
    range_header: str | None, if_range: str | None, etag: str, size: int
) -> tuple[int, int] | None:
    """M160 (docs/DRIVE.md §7.1): the one byte range a request asks for, (first, last) both
    inclusive, or None for the whole body: no Range, several ranges, a malformed one, or an
    If-Range that is not this ETag. A range that starts past the end is 416."""
    if not range_header or size <= 0:
        return None
    if if_range is not None and if_range.strip() != etag:
        return None
    unit, _, spec = range_header.partition("=")
    if unit.strip().lower() != "bytes" or "," in spec:
        return None
    first_raw, dash, last_raw = spec.strip().partition("-")
    if not dash:
        return None
    try:
        if first_raw == "":
            suffix = int(last_raw)
            if suffix <= 0:
                return None
            return max(size - suffix, 0), size - 1
        first = int(first_raw)
        last = int(last_raw) if last_raw else size - 1
    except ValueError:
        return None
    if first < 0 or last < first:
        return None if first < size else _unsatisfiable(size)
    if first >= size:
        raise AppError(
            416,
            "range_not_satisfiable",
            "The requested range is outside the file",
            headers={"Content-Range": f"bytes */{size}"},
        )
    return first, min(last, size - 1)


def _unsatisfiable(size: int) -> tuple[int, int]:
    raise AppError(
        416,
        "range_not_satisfiable",
        "The requested range is outside the file",
        headers={"Content-Range": f"bytes */{size}"},
    )


def ranged_response(
    blobs: BlobStore,
    key: str,
    size: int,
    headers: dict[str, str],
    *,
    range_header: str | None,
    if_range: str | None,
    head: bool = False,
) -> Response:
    """The whole object (200) or the one range asked for (206 with Content-Range). `head` (a HEAD
    request, 2026-10-27): the same status and headers (Content-Length of what a GET would send)
    without a body, and without reading the store."""
    span = requested_range(range_header, if_range, headers.get("ETag", ""), size)
    status = 200
    if span is not None:
        first, last = span
        status = 206
        headers = {
            **headers,
            "Content-Length": str(last - first + 1),
            "Content-Range": f"bytes {first}-{last}/{size}",
        }
    if head:
        return Response(status_code=status, headers=headers)
    if span is None:
        return StreamingResponse(blobs.stream(key), headers=headers)
    return StreamingResponse(blobs.stream(key, span[0], span[1]), status_code=206, headers=headers)


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
    for attachment, tombstone in await repo.deleted(db, 500):
        await _delete_blobs(blobs, attachment)
        if tombstone:
            # CF1 (docs/CHANNEL_FILES.md §7.5): the message still shows 「削除されたファイル」 where
            # the file was; the row stays without its bytes and derived objects.
            attachment.status = "purged"
            attachment.thumbnail_key = None
            attachment.display_key = None
            attachment.preview_status = "none"
            attachment.preview_pdf_key = None
            attachment.preview_thumb_key = None
            attachment.preview_next_at = None
        else:
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
    """The thumbnail or poster, (M108) the preview's PDF and thumbnail, and (AL1) the display-size
    image."""
    keys = (
        attachment.thumbnail_key,
        attachment.preview_pdf_key,
        attachment.preview_thumb_key,
        attachment.display_key,
    )
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
