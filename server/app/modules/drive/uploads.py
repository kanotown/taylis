"""Resumable uploads (docs/DRIVE.md §6): a session per (user, client_upload_id), its parts in an S3
multipart upload of attachments/{attachment_id}, a completion that joins them outside the request.

States: active → completing → completed; active → aborted (DELETE) or expired (no part for
DRIVE_UPLOAD_TTL_HOURS). A completion that cannot place the file (the name is taken with `fail`,
the quota, the folder went away, the person lost access) goes back to active with `error` set.

Parts and completions are ordered by an advisory lock per session: a part holds it shared while it
writes to the store, the switch to `completing` takes it exclusively, so no part is replaced while
the parts are being joined. Nothing waits on a database transaction while a body streams in.
"""

import asyncio
import hashlib
import logging
import math
import tempfile
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import filetype
from sqlalchemy import delete, func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.errors import AppError, conflict, not_found
from app.core.ids import uuid7
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.models import Attachment
from app.modules.attachments.preview_kinds import queue_on_upload
from app.modules.drive import access as acl
from app.modules.drive import events, names, service
from app.modules.drive import repository as repo
from app.modules.drive.models import (
    DriveFileVersion,
    DriveItem,
    DriveUpload,
    DriveUploadPart,
)
from app.modules.drive.schemas import (
    DriveItemOut,
    DriveUploadCompleteOut,
    DriveUploadCreate,
    DriveUploadListOut,
    DriveUploadOut,
    DriveUploadPartOut,
    DriveUploadPatch,
)
from app.modules.users.models import User

log = logging.getLogger("app.drive.uploads")

SPOOL_MAX_BYTES = 8 * 1024 * 1024
SNIFF_BYTES = 8192
MISSING_SHOWN = 100
# The earliest and latest a file's own modification time may be (§6.2), else it is dropped.
EARLIEST_MODIFIED = datetime(1980, 1, 1, tzinfo=UTC)
FINISHED_KEPT = timedelta(days=7)
# The HTTP status of each error a completion may leave on a session.
ERROR_STATUS = {
    "drive_item_not_found": 404,
    "drive_read_only": 403,
    "guest_restricted": 403,
    "drive_name_taken": 409,
    "drive_quota_exceeded": 409,
    "drive_folder_full": 409,
    "drive_depth_exceeded": 422,
    "drive_name_invalid": 422,
    "drive_upload_failed": 502,
}


@dataclass
class DriveRuntime:
    """The completions under way in this process and the loops' wake-ups (app.state.drive)."""

    session_factory: async_sessionmaker[AsyncSession]
    media_wake: asyncio.Event = field(default_factory=asyncio.Event)
    preview_wake: asyncio.Event | None = None
    tasks: dict[uuid.UUID, "asyncio.Task[None]"] = field(default_factory=dict)
    last_orphan_sweep: datetime | None = None

    def finalize(
        self, settings: Settings, blobs: BlobStore, upload_id: uuid.UUID
    ) -> "asyncio.Task[None]":
        task = self.tasks.get(upload_id)
        if task is not None and not task.done():
            return task

        async def run() -> None:
            try:
                await finalize(self, settings, blobs, upload_id)
            except Exception:
                log.exception("completing drive upload %s failed", upload_id)
            finally:
                self.tasks.pop(upload_id, None)

        task = asyncio.create_task(run(), name=f"drive-complete-{upload_id}")
        self.tasks[upload_id] = task
        return task


def upload_not_found() -> AppError:
    return not_found("drive_upload_not_found", "Upload not found")


def upload_expired() -> AppError:
    return AppError(410, "drive_upload_expired", "This upload has expired or was cancelled")


def not_active() -> AppError:
    return conflict("drive_upload_not_active", "This upload is being completed or is complete")


def part_invalid(message: str, details: dict[str, object] | None = None) -> AppError:
    return AppError(422, "drive_part_invalid", message, details=details)


def parts_total(size: int, part_size: int) -> int:
    return math.ceil(size / part_size) if size else 0


def expected_part_size(upload: DriveUpload, number: int) -> int:
    total = parts_total(upload.size_bytes, upload.part_size)
    if number < 1 or number > total:
        raise part_invalid(f"Part numbers go from 1 to {total}")
    if number < total:
        return upload.part_size
    return upload.size_bytes - upload.part_size * (total - 1)


def _modified(ms: int | None) -> datetime | None:
    if ms is None:
        return None
    try:
        at = datetime.fromtimestamp(ms / 1000, tz=UTC)
    except (OverflowError, OSError, ValueError):
        return None
    if at < EARLIEST_MODIFIED or at > utcnow() + timedelta(days=1):
        return None
    return at


def _lock_key(upload_id: uuid.UUID) -> int:
    return int.from_bytes(upload_id.bytes[:8], "big", signed=True)


async def upload_out(db: AsyncSession, upload: DriveUpload) -> DriveUploadOut:
    received = (
        await db.execute(
            select(DriveUploadPart.part_number)
            .where(DriveUploadPart.upload_id == upload.id)
            .order_by(DriveUploadPart.part_number)
        )
    ).scalars()
    return DriveUploadOut(
        id=upload.id,
        client_upload_id=upload.client_upload_id,
        status=upload.status,  # type: ignore[arg-type]
        location_id=upload.location_id,
        parent_id=upload.parent_id,
        relative_dir=upload.relative_dir,
        name=upload.name,
        on_conflict=upload.on_conflict,  # type: ignore[arg-type]
        target_item_id=upload.target_item_id,
        part_size=upload.part_size,
        parts_total=parts_total(upload.size_bytes, upload.part_size),
        received_parts=list(received),
        size_bytes=upload.size_bytes,
        expires_at=upload.expires_at,
        created_at=upload.created_at,
        item_id=upload.item_id,
        version_id=upload.version_id,
        error=upload.error,
    )


async def _own(db: AsyncSession, actor: User, upload_id: uuid.UUID) -> DriveUpload:
    upload = await db.get(DriveUpload, upload_id, populate_existing=True)
    if upload is None or upload.user_id != actor.id:
        raise upload_not_found()
    return upload


async def _existing(
    db: AsyncSession, actor: User, client_upload_id: uuid.UUID
) -> DriveUpload | None:
    stmt = select(DriveUpload).where(
        DriveUpload.user_id == actor.id, DriveUpload.client_upload_id == client_upload_id
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def create(
    db: AsyncSession, actor: User, settings: Settings, blobs: BlobStore, data: DriveUploadCreate
) -> tuple[DriveUploadOut, bool]:
    """A session (201), or the one this client_upload_id already made (200): the permissions,
    the name, the size and the quota (with the sessions under way reserved) are checked first."""
    found = await _existing(db, actor, data.client_upload_id)
    if found is not None:
        return await upload_out(db, found), False
    if data.size_bytes > settings.drive_max_file_bytes:
        raise AppError(
            413,
            "drive_file_too_large",
            f"Files are limited to {settings.drive_max_file_bytes} bytes",
            details={"limit_bytes": settings.drive_max_file_bytes},
        )
    name = names.normalize(data.name)
    segments = names.split_path(data.relative_dir) if data.relative_dir else []
    target_id: uuid.UUID | None
    target_name: str | None
    if data.target_item_id is not None:
        target, rights = await service.readable_item(db, actor, data.target_item_id)
        rights.require_write()
        if target.kind != "file":
            raise acl.item_not_found()
        assert target.parent_id is not None
        parent_id, location_id = target.parent_id, rights.location.id
        target_id, target_name = target.id, target.name
        segments = []
    else:
        parent, rights = await service.readable_item(db, actor, data.parent_id)
        rights.require_write()
        if parent.kind != "folder":
            raise acl.item_not_found()
        parent_id, location_id = parent.id, rights.location.id
        target_id, target_name = None, None
        if await service.depth_of(db, parent.id) + len(segments) + 1 > names.MAX_DEPTH:
            raise service.depth_exceeded()
        if data.on_conflict == "fail":
            folder_id: uuid.UUID | None = parent.id
            for segment in segments:
                step = await repo.child_by_key(db, folder_id, names.key(segment))  # type: ignore[arg-type]
                folder_id = step.id if step is not None and step.kind == "folder" else None
                if folder_id is None:
                    break
            if folder_id is not None:
                existing = await repo.child_by_key(db, folder_id, names.key(name))
                if existing is not None:
                    raise service.name_taken(existing)
    active = await db.execute(
        select(func.count())
        .select_from(DriveUpload)
        .where(DriveUpload.user_id == actor.id, DriveUpload.status.in_(("active", "completing")))
    )
    if int(active.scalar_one()) >= settings.drive_max_active_uploads:
        raise conflict("drive_too_many_uploads", "Too many uploads under way")
    actor_id = actor.id
    # A commit, not a rollback, ends the read-only transaction here and below: a rollback expires
    # the actor (loaded in this session), and a lazy load afterwards fails under asyncio.
    await db.commit()

    attachment_id = uuid7()
    key = attachments.storage_key(attachment_id)
    s3_upload_id = (
        await blobs.create_multipart(key, "application/octet-stream") if data.size_bytes else ""
    )
    try:
        locked = await service.lock_location(db, location_id)
        await service.check_quota_in_tx(
            db, settings, locked, data.size_bytes, with_reservations=True
        )
        now = utcnow()
        upload = DriveUpload(
            id=uuid7(),
            user_id=actor_id,
            client_upload_id=data.client_upload_id,
            location_id=location_id,
            parent_id=parent_id,
            relative_dir="/".join(segments) or None,
            name=target_name or name,
            target_item_id=target_id,
            on_conflict=data.on_conflict,
            size_bytes=data.size_bytes,
            part_size=settings.drive_part_bytes,
            attachment_id=attachment_id,
            s3_upload_id=s3_upload_id,
            content_modified_at=_modified(data.content_modified_ms),
            status="active",
            expires_at=now + timedelta(hours=settings.drive_upload_ttl_hours),
            created_at=now,
            updated_at=now,
        )
        db.add(upload)
        await db.flush()
        out = await upload_out(db, upload)
        await db.commit()
    except BaseException as exc:
        await db.rollback()
        if s3_upload_id:
            try:
                await blobs.abort_multipart(key, s3_upload_id)
            except Exception:
                log.warning("could not abort the multipart upload of %s", key, exc_info=True)
        if isinstance(exc, IntegrityError):
            # The same client_upload_id from a request that was faster.
            await db.refresh(actor)
            found = await _existing(db, actor, data.client_upload_id)
            if found is not None:
                return await upload_out(db, found), False
        raise
    return out, True


async def get(db: AsyncSession, actor: User, upload_id: uuid.UUID) -> DriveUploadOut:
    return await upload_out(db, await _own(db, actor, upload_id))


async def list_mine(db: AsyncSession, actor: User, status: str | None) -> DriveUploadListOut:
    stmt = select(DriveUpload).where(DriveUpload.user_id == actor.id)
    if status is not None:
        stmt = stmt.where(DriveUpload.status == status)
    stmt = stmt.order_by(DriveUpload.created_at.desc()).limit(1000)
    rows = list((await db.execute(stmt)).scalars().all())
    return DriveUploadListOut(uploads=[await upload_out(db, row) for row in rows])


async def patch(
    db: AsyncSession, actor: User, upload_id: uuid.UUID, data: DriveUploadPatch
) -> DriveUploadOut:
    """After a completion answered 409 drive_name_taken: another name or another way to settle
    the clash, then complete again."""
    upload = await _own(db, actor, upload_id)
    _require_active(upload)
    if data.name is not None:
        if upload.target_item_id is not None:
            raise conflict("drive_upload_not_active", "A new version keeps the file's name")
        upload.name = names.normalize(data.name)
    if data.on_conflict is not None:
        upload.on_conflict = data.on_conflict
    upload.error = None
    upload.updated_at = utcnow()
    await db.flush()
    out = await upload_out(db, upload)
    await db.commit()
    return out


def _require_active(upload: DriveUpload) -> None:
    if upload.status in ("expired", "aborted"):
        raise upload_expired()
    if upload.status != "active":
        raise not_active()


async def receive_part(
    db: AsyncSession,
    actor: User,
    settings: Settings,
    blobs: BlobStore,
    upload_id: uuid.UUID,
    number: int,
    sha256_hex: str | None,
    body: AsyncIterator[bytes],
) -> DriveUploadPartOut:
    """PUT …/parts/{n}: the body streams to a temporary file (size and SHA-256 checked) before
    anything is stored; the same number again replaces the part (idempotent)."""
    upload = await _own(db, actor, upload_id)
    _require_active(upload)
    expected = expected_part_size(upload, number)
    try:
        claimed = bytes.fromhex(sha256_hex or "")
    except ValueError:
        claimed = b""
    if len(claimed) != 32:
        raise part_invalid("X-Content-SHA256 must be the part's SHA-256 in hex")
    await db.commit()  # no transaction while the body streams in
    digest = hashlib.sha256()
    size = 0
    with tempfile.SpooledTemporaryFile(max_size=SPOOL_MAX_BYTES) as spool:
        async for chunk in body:
            size += len(chunk)
            if size > expected:
                raise part_invalid(
                    "The part is larger than expected",
                    {"expected_bytes": expected},
                )
            digest.update(chunk)
            spool.write(chunk)
        if size != expected:
            raise part_invalid(
                "The part is smaller than expected",
                {"expected_bytes": expected, "received_bytes": size},
            )
        if digest.digest() != claimed:
            raise part_invalid("The part does not match its SHA-256")
        spool.seek(0)
        await db.execute(
            text("SELECT pg_advisory_xact_lock_shared(:key)"), {"key": _lock_key(upload_id)}
        )
        upload = await _own(db, actor, upload_id)
        _require_active(upload)
        etag = await blobs.upload_part(
            attachments.storage_key(upload.attachment_id), upload.s3_upload_id, number, spool, size
        )
    now = utcnow()
    await db.execute(
        insert(DriveUploadPart)
        .values(
            upload_id=upload_id,
            part_number=number,
            size_bytes=size,
            sha256=claimed,
            etag=etag,
            received_at=now,
        )
        .on_conflict_do_update(
            index_elements=["upload_id", "part_number"],
            set_={"size_bytes": size, "sha256": claimed, "etag": etag, "received_at": now},
        )
    )
    upload.expires_at = now + timedelta(hours=settings.drive_upload_ttl_hours)
    upload.updated_at = now
    await db.commit()
    return DriveUploadPartOut(part_number=number, size_bytes=size)


async def _completed_out(db: AsyncSession, upload: DriveUpload) -> DriveUploadCompleteOut:
    item: DriveItemOut | None = None
    if upload.item_id is not None:
        row = await repo.item(db, upload.item_id)
        if row is not None:
            item = await service.item_out(db, row)
    return DriveUploadCompleteOut(status="completed", item=item, version_id=upload.version_id)


def _raise_error(code: str) -> None:
    raise AppError(ERROR_STATUS.get(code, 409), code, f"The upload could not be completed ({code})")


async def complete(
    runtime: DriveRuntime,
    db: AsyncSession,
    actor: User,
    settings: Settings,
    blobs: BlobStore,
    upload_id: uuid.UUID,
) -> tuple[int, DriveUploadCompleteOut]:
    """(200 completed, the item) or (202 completing): idempotent. The parts are joined by a task
    of the process (the request waits up to DRIVE_COMPLETE_WAIT_SECONDS for it); a completion a
    restart cut off is taken over by the housekeeping."""
    upload = await _own(db, actor, upload_id)
    if upload.status == "completed":
        return 200, await _completed_out(db, upload)
    if upload.status in ("expired", "aborted"):
        raise upload_expired()
    if upload.status == "active":
        await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _lock_key(upload_id)})
        upload = await _own(db, actor, upload_id)
        if upload.status == "active":
            await _start_completing(db, actor, upload)
        await db.commit()
    upload = await _own(db, actor, upload_id)
    if upload.status == "completing":
        task = runtime.finalize(settings, blobs, upload_id)
        await db.commit()
        await asyncio.wait({task}, timeout=settings.drive_complete_wait_seconds)
        upload = await _own(db, actor, upload_id)
    if upload.status == "completed":
        return 200, await _completed_out(db, upload)
    if upload.status == "completing":
        return 202, DriveUploadCompleteOut(status="completing")
    if upload.status in ("expired", "aborted"):
        raise upload_expired()
    _raise_error(upload.error or "drive_upload_failed")
    raise AssertionError  # unreachable


async def _start_completing(db: AsyncSession, actor: User, upload: DriveUpload) -> None:
    """active → completing, after the checks that need no object: every part is there, the
    actor may still write, the folder is still there, and (with `fail`) the name is free."""
    total = parts_total(upload.size_bytes, upload.part_size)
    have = set(
        (
            await db.execute(
                select(DriveUploadPart.part_number).where(DriveUploadPart.upload_id == upload.id)
            )
        ).scalars()
    )
    missing = [n for n in range(1, total + 1) if n not in have]
    if missing:
        raise conflict(
            "drive_upload_incomplete",
            "Some parts have not been received",
            {"missing": missing[:MISSING_SHOWN], "missing_count": len(missing)},
        )
    location = await repo.location(db, upload.location_id)
    if location is None:
        raise acl.item_not_found()
    (await acl.access(db, actor, location)).require_write()
    parent = await repo.item(db, upload.parent_id)
    if parent is None or parent.trashed_at is not None:
        raise acl.item_not_found()
    if upload.target_item_id is None and upload.on_conflict == "fail":
        folder: DriveItem | None = parent
        for segment in (upload.relative_dir or "").split("/") if upload.relative_dir else []:
            assert folder is not None
            folder = await repo.child_by_key(db, folder.id, names.key(segment))
            if folder is None or folder.kind != "folder":
                folder = None
                break
        if folder is not None:
            existing = await repo.child_by_key(db, folder.id, names.key(upload.name))
            if existing is not None:
                raise service.name_taken(existing)
    upload.status = "completing"
    upload.error = None
    upload.updated_at = utcnow()


async def _parts(db: AsyncSession, upload_id: uuid.UUID) -> list[tuple[int, str]]:
    rows = await db.execute(
        select(DriveUploadPart.part_number, DriveUploadPart.etag)
        .where(DriveUploadPart.upload_id == upload_id)
        .order_by(DriveUploadPart.part_number)
    )
    return [(int(n), str(e)) for n, e in rows.all()]


async def _assemble(blobs: BlobStore, upload: DriveUpload, parts: list[tuple[int, str]]) -> bool:
    """The object, joined (or found joined by an earlier try): whether it is there whole."""
    key = attachments.storage_key(upload.attachment_id)
    if await blobs.head(key) == upload.size_bytes:
        return True
    if upload.size_bytes == 0:
        await blobs.put(key, b"", "application/octet-stream")
    else:
        try:
            await blobs.complete_multipart(key, upload.s3_upload_id, parts)
        except Exception:
            # Joined meanwhile by another try (the store answers "no such upload")?
            if await blobs.head(key) != upload.size_bytes:
                raise
    return await blobs.head(key) == upload.size_bytes


async def _sniff(blobs: BlobStore, key: str, size: int) -> str:
    if size == 0:
        return "application/octet-stream"
    head = b""
    async for chunk in blobs.stream(key, 0, min(size, SNIFF_BYTES) - 1):
        head += chunk
    kind = filetype.guess(head[:SNIFF_BYTES])
    return kind.mime if kind is not None else "application/octet-stream"


async def finalize(
    runtime: DriveRuntime, settings: Settings, blobs: BlobStore, upload_id: uuid.UUID
) -> None:
    """completing → completed (or back to active with the error): join the parts, check the
    size, sniff the type, then one transaction places the file (§6.1)."""
    async with runtime.session_factory() as db:
        upload = await db.get(DriveUpload, upload_id)
        if upload is None or upload.status != "completing":
            return
        parts = await _parts(db, upload_id)
        await db.commit()  # no transaction while the store joins the parts
        key = attachments.storage_key(upload.attachment_id)
        try:
            whole = await _assemble(blobs, upload, parts)
        except Exception:
            # Left completing: the housekeeping tries again (the parts are still in the store).
            log.warning("joining the parts of %s failed", upload_id, exc_info=True)
            return
        if not whole:
            await _fail(db, upload_id, "drive_upload_failed")
            return
        content_type = await _sniff(blobs, key, upload.size_bytes)
        placed = await _place(runtime, db, settings, upload_id, content_type)
        if placed is None:
            return
        if placed:
            runtime.media_wake.set()
            if runtime.preview_wake is not None:
                runtime.preview_wake.set()
        else:
            gone = await db.get(DriveUpload, upload_id)
            if gone is None:
                # The session went with its folder (a purge) while the parts were joined.
                await blobs.delete(key)


async def _fail(db: AsyncSession, upload_id: uuid.UUID, code: str) -> None:
    upload = await db.get(DriveUpload, upload_id, with_for_update=True, populate_existing=True)
    if upload is None or upload.status != "completing":
        await db.rollback()
        return
    upload.status = "active"
    upload.error = code
    upload.updated_at = utcnow()
    await db.flush()
    await events.emit_upload_updated(db, upload.user_id, await upload_out(db, upload))
    await db.commit()


async def _place(
    runtime: DriveRuntime,
    db: AsyncSession,
    settings: Settings,
    upload_id: uuid.UUID,
    content_type: str,
) -> bool | None:
    """True: placed. False: the session is gone or no longer completing. None: it went back to
    active with an error."""
    upload = await db.get(DriveUpload, upload_id, with_for_update=True, populate_existing=True)
    if upload is None or upload.status != "completing":
        await db.rollback()
        return False
    user = await db.get(User, upload.user_id)
    try:
        async with db.begin_nested():
            if user is None:
                raise acl.item_not_found()
            item, version, folders = await _place_in_tx(db, settings, user, upload, content_type)
    except AppError as exc:
        upload.status = "active"
        upload.error = exc.code
        upload.updated_at = utcnow()
        await db.flush()
        await events.emit_upload_updated(db, upload.user_id, await upload_out(db, upload))
        await db.commit()
        return None
    upload.status = "completed"
    upload.item_id = item.id
    upload.version_id = version.id
    upload.error = None
    upload.updated_at = utcnow()
    await db.execute(delete(DriveUploadPart).where(DriveUploadPart.upload_id == upload.id))
    await db.flush()
    await events.emit_changed(db, item.location_id, folders)
    await events.emit_upload_updated(db, upload.user_id, await upload_out(db, upload))
    await db.commit()
    return True


async def _place_in_tx(
    db: AsyncSession, settings: Settings, user: User, upload: DriveUpload, content_type: str
) -> tuple[DriveItem, DriveFileVersion, list[uuid.UUID]]:
    location = await repo.location(db, upload.location_id)
    if location is None:
        raise acl.item_not_found()
    (await acl.access(db, user, location)).require_write()
    now = utcnow()
    folders: list[uuid.UUID] = []
    folders_made = 0
    item: DriveItem | None = None
    name = upload.name
    if upload.target_item_id is not None:
        target = (await repo.lock_items(db, [upload.target_item_id])).get(upload.target_item_id)
        if (
            target is None
            or target.kind != "file"
            or target.trashed_at is not None
            or target.location_id != location.id
        ):
            raise acl.item_not_found()
        item = target
        folders.append(target.parent_id)  # type: ignore[arg-type]
    else:
        parent = (await repo.lock_items(db, [upload.parent_id])).get(upload.parent_id)
        if parent is None or parent.kind != "folder" or parent.trashed_at is not None:
            raise acl.item_not_found()
        folder = parent
        if upload.relative_dir:
            folder, made = await service.ensure_path_in_tx(
                db, user, parent, names.split_path(upload.relative_dir)
            )
            folders += made
            folders_made = len(made)
        folders.append(folder.id)
        existing = await repo.child_by_key(db, folder.id, names.key(name))
        if existing is not None:
            if upload.on_conflict == "version" and existing.kind == "file":
                item = (await repo.lock_items(db, [existing.id]))[existing.id]
            elif upload.on_conflict == "rename":
                name = await service.free_name(db, folder.id, name, is_file=True)
            else:
                raise service.name_taken(existing)
        if item is None:
            if await service.depth_of(db, folder.id) + 1 > names.MAX_DEPTH:
                raise service.depth_exceeded()
            await service.require_room(db, folder.id)
            item = DriveItem(
                id=uuid7(),
                location_id=location.id,
                parent_id=folder.id,
                kind="file",
                created_by=user.id,
                created_at=now,
                change_seq=0,
            )
            service._set_name(item, name)
    locked_location = await service.lock_location(db, location.id)
    await service.check_quota_in_tx(
        db, settings, locked_location, upload.size_bytes, with_reservations=False
    )
    version_id = uuid7()
    new_item = item.current_version_id is None
    item.current_version_id = version_id
    item.size_bytes = upload.size_bytes
    item.content_type = content_type
    item.content_modified_at = upload.content_modified_at
    item.updated_by = user.id
    item.updated_at = now
    item.change_seq = await events.next_seq(db)
    if new_item:
        db.add(item)
    await db.flush()
    attachment = Attachment(
        id=upload.attachment_id,
        uploader_id=user.id,
        drive_item_id=item.id,
        status="attached",
        filename=item.name,
        content_type=content_type,
        size_bytes=upload.size_bytes,
        storage_key=attachments.storage_key(upload.attachment_id),
        created_at=now,
        attached_at=now,
    )
    # §8: the preview of the current version (PDF and Office files within the preview limit).
    queue_on_upload(attachment, settings)
    db.add(attachment)
    await db.flush()
    version = DriveFileVersion(
        id=version_id,
        item_id=item.id,
        number=await repo.next_version_number(db, item.id),
        attachment_id=attachment.id,
        size_bytes=upload.size_bytes,
        content_modified_at=upload.content_modified_at,
        uploaded_by=user.id,
        created_at=now,
        source="upload",
        process_next_at=now,
    )
    db.add(version)
    await db.flush()
    locked_location.used_bytes += upload.size_bytes
    locked_location.item_count += folders_made + (1 if new_item else 0)
    locked_location.updated_at = now
    await db.flush()
    return item, version, folders


async def abort(db: AsyncSession, actor: User, blobs: BlobStore, upload_id: uuid.UUID) -> None:
    """DELETE: an active session is dropped with its parts (an expired or cancelled one: 204)."""
    upload = await _own(db, actor, upload_id)
    if upload.status in ("expired", "aborted"):
        return
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _lock_key(upload_id)})
    upload = await _own(db, actor, upload_id)
    if upload.status != "active":
        if upload.status in ("expired", "aborted"):
            return
        raise not_active()
    upload.status = "aborted"
    upload.updated_at = utcnow()
    await db.execute(delete(DriveUploadPart).where(DriveUploadPart.upload_id == upload.id))
    await db.commit()
    await _drop_objects(blobs, upload)


async def _drop_objects(blobs: BlobStore, upload: DriveUpload) -> None:
    """The store's side of a session that will not complete: its multipart upload and any object
    an earlier completion joined but could not place. Failures are left to the orphan sweep."""
    key = attachments.storage_key(upload.attachment_id)
    try:
        if upload.s3_upload_id:
            await blobs.abort_multipart(key, upload.s3_upload_id)
        await blobs.delete(key)
    except Exception:
        log.warning("could not drop the objects of upload %s", upload.id, exc_info=True)


# --- housekeeping (§6.2) -----------------------------------------------------------------------


async def expire_due(db: AsyncSession, blobs: BlobStore, *, now: datetime) -> int:
    """Active sessions without a part for DRIVE_UPLOAD_TTL_HOURS: expired, their parts dropped."""
    stmt = (
        select(DriveUpload.id)
        .where(DriveUpload.status == "active", DriveUpload.expires_at < now)
        .order_by(DriveUpload.expires_at)
        .limit(200)
    )
    ids = list((await db.execute(stmt)).scalars().all())
    await db.rollback()
    done = 0
    for upload_id in ids:
        await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _lock_key(upload_id)})
        upload = await db.get(DriveUpload, upload_id, with_for_update=True, populate_existing=True)
        if upload is None or upload.status != "active" or upload.expires_at >= now:
            await db.rollback()
            continue
        upload.status = "expired"
        upload.updated_at = now
        await db.execute(delete(DriveUploadPart).where(DriveUploadPart.upload_id == upload.id))
        await db.flush()
        await events.emit_upload_updated(db, upload.user_id, await upload_out(db, upload))
        await db.commit()
        await _drop_objects(blobs, upload)
        done += 1
    return done


async def recover_stale(
    runtime: DriveRuntime, db: AsyncSession, settings: Settings, blobs: BlobStore, *, now: datetime
) -> int:
    """Completions left `completing` (a restart, a failed join) for more than
    DRIVE_COMPLETING_STALE_MINUTES: finished now (§6.2)."""
    stmt = select(DriveUpload.id).where(
        DriveUpload.status == "completing",
        DriveUpload.updated_at < now - timedelta(minutes=settings.drive_completing_stale_minutes),
    )
    ids = list((await db.execute(stmt)).scalars().all())
    await db.rollback()
    for upload_id in ids:
        if upload_id in runtime.tasks:
            continue
        await runtime.finalize(settings, blobs, upload_id)
    return len(ids)


async def sweep_orphans(
    db: AsyncSession, blobs: BlobStore, settings: Settings, *, now: datetime
) -> int:
    """Multipart uploads under attachments/ that no session under way knows (the app stopped
    between CreateMultipartUpload and the session's row, a session purged with its folder, a
    failed abort), once older than DRIVE_UPLOAD_TTL_HOURS: aborted."""
    cutoff = now - timedelta(hours=settings.drive_upload_ttl_hours)
    known = set(
        (
            await db.execute(
                select(DriveUpload.s3_upload_id).where(
                    DriveUpload.status.in_(("active", "completing"))
                )
            )
        ).scalars()
    )
    await db.rollback()
    aborted = 0
    async for key, s3_id, initiated in blobs.list_multipart_uploads("attachments/"):
        stamp = initiated if initiated.tzinfo else initiated.replace(tzinfo=UTC)
        if s3_id in known or stamp >= cutoff:
            continue
        try:
            await blobs.abort_multipart(key, s3_id)
            aborted += 1
        except Exception:
            log.warning("could not abort the orphan upload %s of %s", s3_id, key, exc_info=True)
    return aborted


async def purge_finished(db: AsyncSession, *, now: datetime) -> int:
    """Finished sessions are kept a week (a client asking again gets the same answer)."""
    result = await db.execute(
        delete(DriveUpload)
        .where(
            DriveUpload.status.in_(("completed", "aborted", "expired")),
            DriveUpload.updated_at < now - FINISHED_KEPT,
        )
        .returning(DriveUpload.id)
    )
    count = len(result.all())
    await db.commit()
    return count
