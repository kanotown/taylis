"""A drive file's versions (docs/DRIVE.md §10.2, phase D3): the list, a version brought back as the
new current one, an older version deleted, and the retention job.

Bringing a version back copies its object inside the store (S3 CopyObject) to a new attachment and
a new version (`source = 'restore'`): one attachment is never shared by two versions, so nothing
needs a reference count. The copy is made outside any transaction (a large file takes a while),
then one transaction checks everything again (the file is still there and writable, the quota)
and places the version; when that fails, the copied objects are removed.

Retention: the newest DRIVE_VERSIONS_MAX versions of a file are kept, and an older version at most
DRIVE_VERSIONS_DAYS after a newer one replaced it (the time it stopped being the current one,
not its own upload time: a file uploaded a year ago and replaced today keeps its old version for
30 days). The current version is never removed. A removed version's attachment becomes `deleted`
(the attachment GC removes the bytes and their thumbnail and preview).
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import delete, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, conflict
from app.core.ids import uuid7
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.models import Attachment
from app.modules.attachments.preview_kinds import pdf_key, queue_on_upload, thumb_key
from app.modules.audit import service as audit
from app.modules.channels import service as channels
from app.modules.drive import access as acl
from app.modules.drive import events, posted, service, texts
from app.modules.drive import repository as repo
from app.modules.drive.access import item_not_found
from app.modules.drive.models import DriveFileVersion, DriveItem, DriveLocation
from app.modules.drive.schemas import DriveItemOut, DriveVersionListOut, DriveVersionOut
from app.modules.users.models import User

log = logging.getLogger("app.drive.versions")


def version_current() -> AppError:
    return conflict("drive_version_current", "This is the file's current version")


# --- copying a version's object (restore, copy) -------------------------------------------------


@dataclass
class ClonedObject:
    """A version's bytes (and its thumbnail and preview) copied to a new attachment's keys, the
    attachment row not written yet."""

    attachment: Attachment
    keys: list[str]
    # The source version had been read by the media loop (SHA-256, thumbnail, poster).
    processed: bool


async def clone_object(
    blobs: BlobStore,
    settings: Settings,
    source: Attachment,
    *,
    sha256: bytes | None,
    processed: bool,
    uploader_id: uuid.UUID,
    filename: str,
) -> ClonedObject:
    """CopyObject of the bytes, the thumbnail and a ready preview (no new conversion). On a
    failure the objects copied so far are removed and the error passed on."""
    new_id = uuid7()
    now = utcnow()
    copy = Attachment(
        id=new_id,
        uploader_id=uploader_id,
        status="attached",
        filename=filename,
        content_type=source.content_type,
        size_bytes=source.size_bytes,
        sha256=sha256 or source.sha256,
        storage_key=attachments.storage_key(new_id),
        width=source.width,
        height=source.height,
        duration_ms=source.duration_ms,
        video_probed_at=source.video_probed_at,
        created_at=now,
        attached_at=now,
    )
    keys: list[str] = []
    try:
        await blobs.copy(source.storage_key, copy.storage_key)
        keys.append(copy.storage_key)
        if source.thumbnail_key:
            copy.thumbnail_key = attachments.thumbnail_key(new_id)
            await blobs.copy(source.thumbnail_key, copy.thumbnail_key)
            keys.append(copy.thumbnail_key)
        if source.preview_status == "ready" and source.preview_thumb_key:
            copy.preview_thumb_key = thumb_key(new_id, 0)
            await blobs.copy(source.preview_thumb_key, copy.preview_thumb_key)
            keys.append(copy.preview_thumb_key)
            if source.preview_pdf_key:
                copy.preview_pdf_key = pdf_key(new_id, 0)
                await blobs.copy(source.preview_pdf_key, copy.preview_pdf_key)
                keys.append(copy.preview_pdf_key)
            copy.preview_status = "ready"
            copy.preview_pages = source.preview_pages
            copy.preview_width = source.preview_width
            copy.preview_height = source.preview_height
        else:
            queue_on_upload(copy, settings)
    except BaseException:
        await drop_objects(blobs, keys)
        raise
    return ClonedObject(attachment=copy, keys=keys, processed=processed and sha256 is not None)


async def drop_objects(blobs: BlobStore, keys: list[str]) -> None:
    for key in keys:
        try:
            await blobs.delete(key)
        except Exception:
            log.warning("could not remove the copied object %s", key, exc_info=True)


def version_for(
    cloned: ClonedObject,
    item_id: uuid.UUID,
    number: int,
    *,
    source: str,
    uploaded_by: uuid.UUID,
    content_modified_at: datetime | None,
    version_id: uuid.UUID | None = None,
) -> DriveFileVersion:
    now = utcnow()
    attachment = cloned.attachment
    return DriveFileVersion(
        id=version_id or uuid7(),
        item_id=item_id,
        number=number,
        attachment_id=attachment.id,
        size_bytes=attachment.size_bytes,
        sha256=attachment.sha256,
        content_modified_at=content_modified_at,
        uploaded_by=uploaded_by,
        created_at=now,
        source=source,
        processed_at=now if cloned.processed else None,
        process_next_at=None if cloned.processed else now,
    )


# --- the list -----------------------------------------------------------------------------------


async def list_versions(
    db: AsyncSession, actor: User, settings: Settings, item_id: uuid.UUID
) -> DriveVersionListOut:
    item, _ = await service.readable_item(db, actor, item_id)
    if item.kind != "file":
        raise item_not_found()
    rows = sorted(await repo.versions_of(db, [item.id]), key=lambda v: v.number, reverse=True)
    return DriveVersionListOut(
        versions=[
            DriveVersionOut(
                id=v.id,
                number=v.number,
                size_bytes=v.size_bytes,
                source=v.source,
                uploaded_by=v.uploaded_by,
                created_at=v.created_at,
                content_modified_at=v.content_modified_at,
                current=v.id == item.current_version_id,
                sha256=v.sha256.hex() if v.sha256 else None,
            )
            for v in rows
        ],
        keep_versions=settings.drive_versions_max,
        keep_days=settings.drive_versions_days,
    )


# --- bringing one back --------------------------------------------------------------------------


async def restore_version(
    db: AsyncSession,
    actor: User,
    settings: Settings,
    blobs: BlobStore,
    item_id: uuid.UUID,
    version_id: uuid.UUID,
) -> DriveItemOut:
    """The version, copied as the file's new current version (§10.2). The caller wakes the media
    loop and the preview loop."""
    item, rights = await service.readable_item(db, actor, item_id)
    rights.require_write()
    if item.kind != "file":
        raise item_not_found()
    version = await db.get(DriveFileVersion, version_id)
    if version is None or version.item_id != item.id:
        raise item_not_found()
    if version.id == item.current_version_id:
        raise version_current()
    source = await db.get(Attachment, version.attachment_id)
    if source is None or source.status == "deleted":
        raise item_not_found()
    # A first look at the quota before copying anything (checked again when placing it).
    location = await service.lock_location(db, item.location_id)
    await service.check_quota_in_tx(
        db, settings, location, version.size_bytes, with_reservations=True
    )
    actor_id = actor.id
    name = item.name
    cloned_from = (version.sha256, version.processed_at is not None, version.content_modified_at)
    await db.commit()

    cloned = await clone_object(
        blobs,
        settings,
        source,
        sha256=cloned_from[0],
        processed=cloned_from[1],
        uploader_id=actor_id,
        filename=name,
    )
    try:
        return await _place_restored(
            db, settings, actor_id, item_id, version_id, cloned, cloned_from[2]
        )
    except BaseException:
        await db.rollback()
        await drop_objects(blobs, cloned.keys)
        raise


async def _place_restored(
    db: AsyncSession,
    settings: Settings,
    actor_id: uuid.UUID,
    item_id: uuid.UUID,
    version_id: uuid.UUID,
    cloned: ClonedObject,
    content_modified_at: datetime | None,
) -> DriveItemOut:
    item = await repo.item(db, item_id)
    if item is None or item.trashed_at is not None or item.parent_id is None:
        raise item_not_found()
    locked = await repo.lock_items(db, [item.parent_id, item.id])
    item = locked[item.id]
    if item.trashed_at is not None:
        raise item_not_found()
    location = await repo.location(db, item.location_id)
    user = await db.get(User, actor_id)
    if location is None or user is None:
        raise item_not_found()
    (await acl.access(db, user, location)).require_write()
    source = await db.get(DriveFileVersion, version_id)
    if source is None or source.item_id != item.id:
        raise item_not_found()
    if source.id == item.current_version_id:
        raise version_current()
    locked_location = await service.lock_location(db, item.location_id)
    await service.check_quota_in_tx(
        db, settings, locked_location, cloned.attachment.size_bytes, with_reservations=False
    )
    attachment = cloned.attachment
    attachment.drive_item_id = item.id
    attachment.filename = item.name
    db.add(attachment)
    await db.flush()
    version = version_for(
        cloned,
        item.id,
        await repo.next_version_number(db, item.id),
        source="restore",
        uploaded_by=actor_id,
        content_modified_at=content_modified_at,
    )
    db.add(version)
    await db.flush()
    now = utcnow()
    item.current_version_id = version.id
    # §29: the replaced version's text is no longer searched (the loop reads the restored one).
    await texts.forget_replaced_in_tx(db, item.id, version.id)
    item.size_bytes = attachment.size_bytes
    item.content_type = attachment.content_type
    item.content_modified_at = content_modified_at
    item.updated_by = actor_id
    item.updated_at = now
    item.change_seq = await events.next_seq(db)
    locked_location.used_bytes += attachment.size_bytes
    locked_location.updated_at = now
    await audit.record_in_tx(
        db,
        actor_id=actor_id,
        action="drive.version_restored",
        target_type="drive_item",
        target_id=item.id,
        details={"from_version": source.number, "version": version.number},
    )
    await events.emit_changed(db, item.location_id, [item.parent_id])
    await db.commit()
    return await service.item_out(db, item)


# --- deleting an older one ----------------------------------------------------------------------


async def delete_version(
    db: AsyncSession, actor: User, item_id: uuid.UUID, version_id: uuid.UUID
) -> None:
    """An older version, for good (§3.2: who may delete for good). The current one: 409."""
    item, rights = await service.readable_item(db, actor, item_id)
    rights.require_manage()
    if item.kind != "file" or item.parent_id is None:
        raise item_not_found()
    locked = await repo.lock_items(db, [item.parent_id, item.id])
    item = locked[item.id]
    if item.trashed_at is not None:
        raise item_not_found()
    version = await db.get(DriveFileVersion, version_id, populate_existing=True)
    if version is None or version.item_id != item.id:
        raise item_not_found()
    if version.id == item.current_version_id:
        raise version_current()
    shown = (await posted.posted_versions(db, [version.id])).get(version.id)
    if shown is not None:
        # CF1 (docs/CHANNEL_FILES.md §7.4): a message shows it; delete the message first. Its
        # channel is named only to someone who can read it.
        message_id, channel_id = shown
        try:
            await channels.require_readable(db, actor, channel_id)
        except AppError:
            raise posted.version_posted(message_id, None) from None
        raise posted.version_posted(message_id, channel_id)
    location = await service.lock_location(db, item.location_id)
    await _remove_in_tx(db, [version], {location.id: location})
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="drive.version_deleted",
        target_type="drive_item",
        target_id=item.id,
        details={"version": version.number, "bytes": version.size_bytes},
    )
    await events.emit_changed(db, item.location_id, [item.parent_id])
    await db.commit()


async def _remove_in_tx(
    db: AsyncSession,
    versions: list[DriveFileVersion],
    locations: dict[uuid.UUID, DriveLocation],
) -> None:
    """The versions' attachments `deleted`, their rows gone, their bytes given back to the
    locked locations ({location id: row}); each version's item must be locked."""
    items = await repo.items(db, list({v.item_id for v in versions}))
    await attachments.mark_ids_deleted_in_tx(db, [v.attachment_id for v in versions])
    await db.execute(
        delete(DriveFileVersion)
        .where(DriveFileVersion.id.in_([v.id for v in versions]))
        .execution_options(synchronize_session=False)
    )
    now = utcnow()
    for v in versions:
        location = locations[items[v.item_id].location_id]
        location.used_bytes -= v.size_bytes
        location.updated_at = now
        db.expunge(v)
    await db.flush()


# --- retention (the housekeeping) ---------------------------------------------------------------

# CF1 (docs/CHANNEL_FILES.md §4.2): a version a message shows (its attachment has a live
# drive_state) is never due and does not count among the newest :keep.
_DUE = text(
    """
    SELECT id FROM (
        SELECT id, current_version_id, replaced_at,
               row_number() OVER (PARTITION BY item_id ORDER BY number DESC) AS rank
        FROM (
            SELECT v.id, v.item_id, v.number, i.current_version_id, a.drive_state,
                   lead(v.created_at) OVER (PARTITION BY v.item_id ORDER BY v.number)
                       AS replaced_at
            FROM drive_file_versions v
            JOIN drive_items i ON i.id = v.item_id
            JOIN attachments a ON a.id = v.attachment_id
            WHERE i.kind = 'file'
        ) every_version
        WHERE drive_state IS NULL OR drive_state NOT IN ('available', 'moved', 'trashed')
    ) ranked
    WHERE id <> current_version_id AND (rank > :keep OR replaced_at < :cutoff)
    ORDER BY id
    LIMIT :limit
    """
)


async def due_versions(
    db: AsyncSession, *, keep: int, days: int, now: datetime, limit: int = 200
) -> list[uuid.UUID]:
    rows = await db.execute(
        _DUE, {"keep": keep, "cutoff": now - timedelta(days=days), "limit": limit}
    )
    return [row[0] for row in rows.all()]


async def prune(db: AsyncSession, settings: Settings, *, now: datetime) -> int:
    """§10.2: older versions past DRIVE_VERSIONS_MAX or DRIVE_VERSIONS_DAYS, a batch per
    transaction (the items, then the locations locked in id order)."""
    removed = 0
    for _ in range(50):
        ids = await due_versions(
            db, keep=settings.drive_versions_max, days=settings.drive_versions_days, now=now
        )
        if not ids:
            await db.rollback()
            break
        items = await repo.lock_items(db, await repo.version_item_ids(db, ids))
        # Again under the items' locks: still there and still not the current one (a newer
        # version only makes the older ones more due).
        found = await repo.versions_by_id(db, ids)
        shown = await posted.posted_versions(db, [v.id for v in found])
        versions = [
            v
            for v in found
            if v.item_id in items
            and items[v.item_id].current_version_id != v.id
            and v.id not in shown
        ]
        locations: dict[uuid.UUID, DriveLocation] = {}
        for location_id in sorted({items[v.item_id].location_id for v in versions}):
            locations[location_id] = await service.lock_location(db, location_id)
        if versions:
            await _remove_in_tx(db, versions, locations)
            folders: dict[uuid.UUID, set[uuid.UUID]] = {}
            for v in versions:
                item: DriveItem = items[v.item_id]
                if item.parent_id is not None and item.trashed_at is None:
                    folders.setdefault(item.location_id, set()).add(item.parent_id)
            for location_id, changed in folders.items():
                await events.emit_changed(db, location_id, changed)
        await db.commit()
        removed += len(versions)
        if len(ids) < 200 or not versions:
            break
    return removed
