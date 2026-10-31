"""The drive and the conversations (docs/DRIVE.md §13, phase D6).

- **A copy as an attachment** (`POST /drive/items/{id}/attach-copy`): the current version of a file
  I can read, copied inside the store (its thumbnail and a ready preview too) to a new *pending*
  attachment of mine, sent with a message like any upload. The message's readers read it then, as
  any attachment; the drive item is not involved any more (a later version, a rename or the trash
  do not change it). At most ATTACHMENT_MAX_BYTES (413 attachment_too_large).
- **Saving an attachment** (`POST /drive/save-attachment`): an attachment I can read
  (`attachments.get_for_access`: a message's in a channel I can read, a canvas's, a page's) copied
  into a folder I can write, as a new file (`source = 'attachment'`). Independent of the message
  from then on. Pending uploads and the drive's own versions are not attachments to save here (404
  attachment_not_found; a drive file is copied with POST /drive/items/copy).
- **Reach** (`GET /drive/items/{id}/reach?channel_id=`): how many of a conversation's members can
  and cannot read an item, for the composer's warning before a link `<server>/d/<id>` is sent. A
  link changes no permission: whoever cannot read the item sees 「表示できないファイル」.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, not_found
from app.core.ids import uuid7
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.models import Attachment
from app.modules.attachments.schemas import AttachmentOut, to_attachment_out
from app.modules.channels import service as channels
from app.modules.drive import access as acl
from app.modules.drive import events, names, service
from app.modules.drive import repository as repo
from app.modules.drive.access import item_not_found
from app.modules.drive.copying import op_id
from app.modules.drive.models import DriveFileVersion, DriveItem
from app.modules.drive.schemas import DriveItemOut, DriveReachOut, DriveSaveAttachmentIn
from app.modules.drive.versions import ClonedObject, clone_object, drop_objects, version_for
from app.modules.users.models import User


def _attachment_not_found() -> AppError:
    return not_found("attachment_not_found", "Attachment not found")


# --- a copy for the composer ----------------------------------------------------------------------


async def attach_copy(
    db: AsyncSession, actor: User, settings: Settings, blobs: BlobStore, item_id: uuid.UUID
) -> AttachmentOut:
    """A pending attachment of mine holding the file's current version (named as the item now)."""
    item, _ = await service.readable_item(db, actor, item_id)
    if item.kind != "file" or item.current_version_id is None:
        raise item_not_found()
    version = await db.get(DriveFileVersion, item.current_version_id)
    source = await db.get(Attachment, version.attachment_id) if version is not None else None
    if version is None or source is None or source.status == "deleted":
        raise item_not_found()
    if source.size_bytes > settings.attachment_max_bytes:
        raise AppError(
            413,
            "attachment_too_large",
            f"Attachments are limited to {settings.attachment_max_bytes} bytes",
            details={"limit_bytes": settings.attachment_max_bytes},
        )
    actor_id, name = actor.id, item.name
    await db.commit()
    clone = await clone_object(
        blobs,
        settings,
        source,
        sha256=version.sha256,
        processed=True,
        uploader_id=actor_id,
        filename=attachments.sanitize_filename(name),
    )
    copy = clone.attachment
    copy.status = "pending"
    copy.attached_at = None
    try:
        db.add(copy)
        await db.commit()
    except BaseException:
        await db.rollback()
        await drop_objects(blobs, clone.keys)
        raise
    await db.refresh(copy)
    return to_attachment_out(copy)


# --- saving an attachment -------------------------------------------------------------------------


async def save_attachment(
    db: AsyncSession,
    actor: User,
    settings: Settings,
    blobs: BlobStore,
    data: DriveSaveAttachmentIn,
) -> tuple[DriveItemOut, bool]:
    """(the new file, whether it was made now: false for the same `client_op_id` again)."""
    try:
        source = await attachments.get_for_access(db, actor, data.attachment_id)
    except AppError as exc:
        # Not a member of its channel (403 there): here it does not exist either way.
        if exc.status == 403:
            raise _attachment_not_found() from None
        raise
    # A drive version is copied with POST /drive/items/copy; CF1: a posted file is a message's
    # attachment too, and an older client's 「ドライブに保存」 copies it (§11.2).
    if source.status != "attached" or (
        source.drive_item_id is not None and source.drive_state is None
    ):
        raise _attachment_not_found()
    folder, rights = await service.readable_item(db, actor, data.folder_id)
    rights.require_write()
    if folder.kind != "folder":
        raise item_not_found()
    name = names.normalize(data.name if data.name is not None else source.filename)
    actor_id = actor.id
    derived = op_id(data.client_op_id, source.id) if data.client_op_id else None
    if derived is not None:
        # The same request again: the file it made, while the actor can still read it
        # (REVIEW-v0.1.82 #3, as POST /drive/albums).
        done = await service.made_before(db, actor, derived)
        if done is not None:
            return await service.item_out(db, done, viewer=actor), False
    # A first look at the quota (and the name, when it must be free) before copying any byte.
    try:
        location = await service.lock_location(db, folder.location_id)
        await service.check_quota_in_tx(
            db, settings, location, source.size_bytes, with_reservations=True
        )
        if data.on_conflict == "fail":
            existing = await repo.child_by_key(db, folder.id, names.key(name))
            if existing is not None:
                raise service.name_taken(existing)
    except AppError:
        # REVIEW-v0.1.84 #6: the same request, faster, may have just made the file (its name
        # and bytes are what this one finds in the way): its answer, not the refusal.
        if derived is None:
            raise
        done = await service.made_before(db, actor, derived)
        if done is None:
            raise
        out = await service.item_out(db, done, viewer=actor)
        await db.commit()
        return out, False
    folder_id = folder.id
    await db.commit()

    clone = await clone_object(
        blobs,
        settings,
        source,
        sha256=source.sha256,
        # The media loop reads it again (the SHA-256 checked, a thumbnail or poster made).
        processed=False,
        uploader_id=actor_id,
        filename=name,
    )
    try:
        item, made = await _place(
            db, settings, actor_id, folder_id, name, data.on_conflict, derived, clone
        )
    except IntegrityError:
        await db.rollback()
        await drop_objects(blobs, clone.keys)
        # The rollback expired the actor: read again.
        user = await db.get(User, actor_id)
        found = (
            await service.made_before(db, user, derived)
            if derived is not None and user is not None
            else None
        )
        if user is None or found is None:
            raise
        return await service.item_out(db, found, viewer=user), False
    except BaseException:
        await db.rollback()
        await drop_objects(blobs, clone.keys)
        raise
    if not made:
        # The same request made it meanwhile: this one's copied objects are not needed.
        await drop_objects(blobs, clone.keys)
        user = await db.get(User, actor_id)
        if user is None:
            raise item_not_found()
        return await service.item_out(db, item, viewer=user), False
    return await service.item_out(db, item, viewer=actor), True


async def _place(
    db: AsyncSession,
    settings: Settings,
    actor_id: uuid.UUID,
    folder_id: uuid.UUID,
    name: str,
    on_conflict: str,
    derived: uuid.UUID | None,
    clone: ClonedObject,
) -> tuple[DriveItem, bool]:
    """One transaction: the folder locked (and still writable), the name settled, the depth, the
    folder's room and the quota checked, then the item, its attachment and version 1. (the item,
    whether it was made now: false when the same `derived` op made it meanwhile)."""
    actor = await db.get(User, actor_id)
    folder = (await repo.lock_items(db, [folder_id])).get(folder_id)
    if actor is None or folder is None or folder.trashed_at is not None:
        raise item_not_found()
    if derived is not None:
        # REVIEW-v0.1.84 #6: a request with the same client_op_id may have placed it while this
        # one copied the bytes (it held the folder's lock): its file, checked as a GET would be,
        # before the name, the room and the quota could refuse this one.
        done = await service.made_before(db, actor, derived)
        if done is not None:
            await db.commit()
            return done, False
    location = await repo.location(db, folder.location_id)
    if location is None:
        raise item_not_found()
    (await acl.access(db, actor, location)).require_write()
    existing = await repo.child_by_key(db, folder.id, names.key(name))
    if existing is not None:
        if on_conflict != "rename":
            raise service.name_taken(existing)
        name = await service.free_name(db, folder.id, name, is_file=True)
    if await service.depth_of(db, folder.id) + 1 > names.MAX_DEPTH:
        raise service.depth_exceeded()
    await service.require_room(db, folder.id)
    locked = await service.lock_location(db, location.id)
    size = clone.attachment.size_bytes
    await service.check_quota_in_tx(db, settings, locked, size, with_reservations=False)
    now = utcnow()
    version_id = uuid7()
    item = DriveItem(
        id=uuid7(),
        location_id=location.id,
        parent_id=folder.id,
        kind="file",
        current_version_id=version_id,
        size_bytes=size,
        content_type=clone.attachment.content_type,
        taken_at=clone.attachment.taken_at,
        created_by=actor_id,
        created_at=now,
        updated_by=actor_id,
        updated_at=now,
        change_seq=await events.next_seq(db),
        client_op_id=derived,
    )
    service.set_name(item, name)
    db.add(item)
    await db.flush()
    attachment = clone.attachment
    attachment.drive_item_id = item.id
    attachment.filename = name
    db.add(attachment)
    await db.flush()
    db.add(
        version_for(
            clone,
            item.id,
            1,
            source="attachment",
            uploaded_by=actor_id,
            content_modified_at=None,
            version_id=version_id,
        )
    )
    locked.used_bytes += size
    locked.item_count += 1
    locked.updated_at = now
    await db.flush()
    await events.emit_changed(db, location.id, [folder.id])
    await db.commit()
    return item, True


# --- reach ----------------------------------------------------------------------------------------


async def reach(
    db: AsyncSession, actor: User, item_id: uuid.UUID, channel_id: uuid.UUID
) -> DriveReachOut:
    """Of the conversation's members who can sign in (bots and deactivated accounts aside): how
    many can read the item now. Its own channel's drive: all of them; 研究室ドライブ: all but the
    guests; another channel's: those in both; a My Drive: its owner only. The item must be
    readable by me and the conversation one I am in."""
    _, rights = await service.readable_item(db, actor, item_id)
    await channels.require_member(db, actor.id, channel_id)
    member_ids = await channels.member_ids_of(db, channel_id)
    rows = await db.execute(
        select(User.id).where(
            User.id.in_(member_ids), User.role != "bot", User.deactivated_at.is_(None)
        )
    )
    members = set(rows.scalars().all())
    readers = set(await acl.readers(db, rights.location))
    readable = len(members & readers)
    return DriveReachOut(readable=readable, unreadable=len(members) - readable)
