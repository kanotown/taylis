"""The drive's use cases (docs/DRIVE.md): locations, folders, names, moves, the trash, purges, the
takeover of a My Drive, quotas. Uploads are in uploads.py, the media loop in media.py.

Every change of the tree (create, rename, move, trash, restore) locks the parent folders FOR
UPDATE in id order first, then the location rows (used_bytes, item_count), in that order
everywhere (§4.2).
"""

import base64
import json
import logging
import uuid
from datetime import datetime, timedelta
from typing import Any, Literal

from sqlalchemy import and_, delete, func, or_, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.ids import uuid7
from app.core.roles import has_capability
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import preview_kinds
from app.modules.attachments import service as attachments
from app.modules.attachments.models import Attachment
from app.modules.attachments.schemas import preview_out, to_attachment_out
from app.modules.audit import service as audit
from app.modules.channels import service as channels
from app.modules.drive import access as acl
from app.modules.drive import events, names, posted, shares
from app.modules.drive import repository as repo
from app.modules.drive.access import Access, item_not_found
from app.modules.drive.models import (
    DriveFileVersion,
    DriveItem,
    DriveLocation,
    DriveUpload,
)
from app.modules.drive.schemas import (
    DriveChildrenOut,
    DriveCrumb,
    DriveFileOut,
    DriveFolderCreate,
    DriveItemDetailOut,
    DriveItemOut,
    DriveItemResult,
    DriveLocationOut,
    DriveLocationResolve,
    DrivePreviewOut,
    DriveResultsOut,
    DriveSearchHitOut,
    DriveTrashEntryOut,
    DriveTrashOut,
)
from app.modules.users.models import User

log = logging.getLogger("app.drive")

# pg_advisory_xact_lock key of the whole drive's quota (DRIVE_TOTAL_QUOTA_BYTES).
QUOTA_LOCK = 0x44524956


# --- locations ---------------------------------------------------------------------------------


def _new_root(location_id: uuid.UUID, root_id: uuid.UUID) -> DriveItem:
    return DriveItem(
        id=root_id,
        location_id=location_id,
        parent_id=None,
        kind="folder",
        name="",
        name_key="",
        name_sort=b"",
        change_seq=0,
    )


async def _create_location(
    db: AsyncSession,
    kind: str,
    *,
    channel_id: uuid.UUID | None = None,
    user_id: uuid.UUID | None = None,
) -> DriveLocation:
    """Both rows at once (they refer to each other; the foreign keys are deferred). A concurrent
    create of the same location loses on the unique index and reads the winner's."""
    location_id, root_id = uuid7(), uuid7()
    savepoint = await db.begin_nested()
    try:
        db.add(
            DriveLocation(
                id=location_id, kind=kind, channel_id=channel_id, user_id=user_id, root_id=root_id
            )
        )
        await db.flush()
        root = _new_root(location_id, root_id)
        root.change_seq = await events.next_seq(db)
        db.add(root)
        await db.flush()
        await savepoint.commit()
    except IntegrityError:
        await savepoint.rollback()
        if kind == "workspace":
            found = await repo.workspace_location(db)
        elif channel_id is not None:
            found = await repo.location_of_channel(db, channel_id)
        else:
            assert user_id is not None
            found = await repo.location_of_user(db, user_id)
        if found is None:
            raise
        return found
    location = await repo.location(db, location_id)
    assert location is not None
    return location


async def workspace_location(db: AsyncSession) -> DriveLocation:
    """研究室ドライブ (made by migration 0118; again here after a restore of an older backup)."""
    found = await repo.workspace_location(db)
    if found is not None:
        return found
    created = await _create_location(db, "workspace")
    await db.commit()
    return created


async def ensure_location(
    db: AsyncSession,
    kind: str,
    *,
    channel_id: uuid.UUID | None = None,
    user_id: uuid.UUID | None = None,
) -> DriveLocation:
    """Phase D5 (§15.2): the import's way to a channel's drive or a person's My Drive, made when
    missing, in the caller's transaction (no permission check: the caller is an administrator's
    command)."""
    if kind == "workspace":
        found = await repo.workspace_location(db)
    elif channel_id is not None:
        found = await repo.location_of_channel(db, channel_id)
    else:
        assert user_id is not None
        found = await repo.location_of_user(db, user_id)
    if found is not None:
        return found
    return await _create_location(db, kind, channel_id=channel_id, user_id=user_id)


async def location_out(db: AsyncSession, actor: User, location: DriveLocation) -> DriveLocationOut:
    rights = await acl.access(db, actor, location)
    return DriveLocationOut(
        id=location.id,
        kind=location.kind,  # type: ignore[arg-type]
        channel_id=location.channel_id,
        user_id=location.user_id,
        root_id=location.root_id,
        name=await acl.location_name(db, location),
        can_write=rights.can_write,
        can_manage=rights.can_manage,
        can_share=shares.may_share(await shares.policy(db), location, actor, rights),
        external_links=location.external_links,
        quota_bytes=location.quota_bytes,
        used_bytes=location.used_bytes,
        item_count=location.item_count,
    )


async def list_locations(db: AsyncSession, actor: User) -> list[DriveLocationOut]:
    """研究室ドライブ (not for guests), my My Drive (once made), and the drives of the channels I
    am a member of that have one."""
    out: list[DriveLocationOut] = []
    if acl.is_person(actor):
        out.append(await location_out(db, actor, await workspace_location(db)))
        mine = await repo.location_of_user(db, actor.id)
        if mine is not None and mine.deleted_at is None:
            out.append(await location_out(db, actor, mine))
    member_of = await channels.member_channel_ids(db, actor.id)
    for location in await repo.channel_locations(db, member_of):
        rights = await acl.access(db, actor, location)
        if rights.can_read:
            out.append(await location_out(db, actor, location))
    return out


async def resolve(db: AsyncSession, actor: User, data: DriveLocationResolve) -> DriveLocationOut:
    """A channel's drive or my My Drive, made on first use (idempotent)."""
    if data.kind == "me":
        if not acl.is_person(actor):
            raise forbidden("guest_restricted", "Guests have no My Drive")
        location = await repo.location_of_user(db, actor.id)
        if location is None:
            location = await _create_location(db, "user", user_id=actor.id)
            await db.commit()
        if location.deleted_at is not None:
            raise item_not_found()
        return await location_out(db, actor, location)
    assert data.channel_id is not None
    channel = await channels.find_channel(db, data.channel_id)
    if channel is None or await channels.membership_of(db, actor.id, channel.id) is None:
        raise item_not_found()
    if channel.is_dm:
        raise AppError(422, "drive_not_available", "Direct messages have no drive")
    location = await repo.location_of_channel(db, channel.id)
    if location is None:
        location = await _create_location(db, "channel", channel_id=channel.id)
        await db.commit()
    return await location_out(db, actor, location)


async def require_location(
    db: AsyncSession, actor: User, location_id: uuid.UUID
) -> tuple[DriveLocation, Access]:
    location = await repo.location(db, location_id)
    if location is None:
        raise item_not_found()
    rights = (await acl.access(db, actor, location)).require_read()
    return location, rights


# --- items: reading ----------------------------------------------------------------------------


async def readable_item(
    db: AsyncSession, actor: User, item_id: uuid.UUID, *, trashed_ok: bool = False
) -> tuple[DriveItem, Access]:
    item = await repo.item(db, item_id)
    if item is None or (item.trashed_at is not None and not trashed_ok):
        raise item_not_found()
    location = await repo.location(db, item.location_id)
    if location is None:
        raise item_not_found()
    return item, (await acl.access(db, actor, location)).require_read()


async def items_out(db: AsyncSession, rows: list[DriveItem]) -> list[DriveItemOut]:
    files = await repo.current_files(
        db, [r.current_version_id for r in rows if r.current_version_id is not None]
    )
    counts = await repo.version_counts(db, [r.id for r in rows if r.kind == "file"])
    links = await shares.link_counts(db, [r.id for r in rows])
    in_posts = await posted.posted_items(db, [r.id for r in rows if r.kind == "file"])
    out: list[DriveItemOut] = []
    for row in rows:
        file: DriveFileOut | None = None
        found = files.get(row.current_version_id) if row.current_version_id else None
        if found is not None:
            version, attachment = found
            shown = to_attachment_out(attachment)
            file = DriveFileOut(
                attachment_id=attachment.id,
                version_id=version.id,
                width=shown.width,
                height=shown.height,
                has_thumbnail=shown.has_thumbnail,
                has_poster=shown.has_poster,
                duration_ms=shown.duration_ms,
                preview=shown.preview,
            )
        out.append(
            DriveItemOut(
                id=row.id,
                location_id=row.location_id,
                parent_id=row.parent_id,
                kind=row.kind,  # type: ignore[arg-type]
                name=row.name,
                size_bytes=row.size_bytes,
                content_type=row.content_type,
                content_modified_at=row.content_modified_at,
                created_by=row.created_by,
                created_at=row.created_at,
                updated_by=row.updated_by,
                updated_at=row.updated_at,
                version_count=counts.get(row.id, 0),
                file=file,
                link_count=links.get(row.id, 0),
                trashed_at=row.trashed_at,
                trashed_by=row.trashed_by,
                system_role=row.system_role,  # type: ignore[arg-type]
                posted=row.id in in_posts,
            )
        )
    return out


async def item_out(db: AsyncSession, row: DriveItem) -> DriveItemOut:
    return (await items_out(db, [row]))[0]


async def crumbs(
    db: AsyncSession, item_ids: list[uuid.UUID], location: DriveLocation
) -> list[DriveCrumb]:
    """The chain as crumbs; the root is named after the location."""
    rows = await repo.items(db, item_ids)
    out: list[DriveCrumb] = []
    for item_id in item_ids:
        row = rows.get(item_id)
        if row is None:
            continue
        name = await acl.location_name(db, location) if row.parent_id is None else row.name
        out.append(DriveCrumb(id=row.id, name=name))
    return out


async def get_item(db: AsyncSession, actor: User, item_id: uuid.UUID) -> DriveItemDetailOut:
    """An item and its path (an item in the trash too, for the trash view)."""
    item, rights = await readable_item(db, actor, item_id, trashed_ok=True)
    chain = await repo.ancestor_ids(db, item.id)
    shown = await item_out(db, item)
    if item.kind == "file":
        # CF1 (docs/CHANNEL_FILES.md §12.2): the messages that show it (those I can read).
        shown.posts = await posted.posts_of(db, actor, item.id)
    return DriveItemDetailOut(
        item=shown,
        path=await crumbs(db, chain[:-1], rights.location),
        location_kind=rights.location.kind,  # type: ignore[arg-type]
    )


async def request_preview(
    db: AsyncSession, actor: User, settings: Settings, item_id: uuid.UUID
) -> tuple[DrivePreviewOut, bool]:
    """2026-10-22 (§27): the preview of a file's current version, queued now when it was never
    made (a Nextcloud import stores files without one, §24; files stored while previews were
    off). Anyone who can read the file may ask; only 'none' moves (to 'pending'), so asking
    again, or for a file whose preview failed, queues nothing. Returns the preview and whether
    the preview loop should be woken."""
    item, _ = await readable_item(db, actor, item_id)
    if item.kind != "file" or item.current_version_id is None:
        raise item_not_found()
    version = await db.get(DriveFileVersion, item.current_version_id)
    if version is None:
        raise item_not_found()
    row = (
        await db.execute(
            select(Attachment).where(Attachment.id == version.attachment_id).with_for_update()
        )
    ).scalar_one_or_none()
    if row is None or row.status == "deleted":
        raise item_not_found()
    queued = False
    if row.preview_status == "none" and preview_kinds.wants(row, settings):
        row.preview_status = "pending"
        row.preview_attempts = 0
        row.preview_error = None
        row.preview_next_at = utcnow()
        queued = True
    out = DrivePreviewOut(preview=preview_out(row))
    await db.commit()
    return out, queued


async def readable_location_ids(db: AsyncSession, actor: User) -> list[uuid.UUID]:
    """The locations the actor can read now, without making any (the search, §12): 研究室ドライブ
    and my My Drive for people, the drives of my channels."""
    out: list[uuid.UUID] = []
    if acl.is_person(actor):
        workspace = await repo.workspace_location(db)
        if workspace is not None:
            out.append(workspace.id)
        mine = await repo.location_of_user(db, actor.id)
        if mine is not None and mine.deleted_at is None:
            out.append(mine.id)
    member_of = await channels.member_channel_ids(db, actor.id)
    for location in await repo.channel_locations(db, member_of):
        if (await acl.access(db, actor, location)).can_read:
            out.append(location.id)
    return out


async def search_hits(db: AsyncSession, rows: list[DriveItem]) -> list[DriveSearchHitOut]:
    """Found items with their paths (the location's name, then the folders above each)."""
    shown = await items_out(db, rows)
    locations: dict[uuid.UUID, DriveLocation] = {}
    out: list[DriveSearchHitOut] = []
    for row, item in zip(rows, shown, strict=True):
        location = locations.get(row.location_id)
        if location is None:
            location = await repo.location(db, row.location_id)
            if location is None:
                continue
            locations[row.location_id] = location
        chain = await repo.ancestor_ids(db, row.id)
        out.append(
            DriveSearchHitOut(
                item=item,
                path=await crumbs(db, chain[:-1], location),
                location_kind=location.kind,  # type: ignore[arg-type]
            )
        )
    return out


Sort = Literal["name", "modified", "size"]
Order = Literal["asc", "desc"]


def _sort_column(sort: Sort) -> Any:
    if sort == "modified":
        return func.coalesce(DriveItem.content_modified_at, DriveItem.updated_at)
    if sort == "size":
        return func.coalesce(DriveItem.size_bytes, 0)
    return DriveItem.name_sort


def _cursor_value(row: DriveItem, sort: Sort) -> Any:
    if sort == "modified":
        return (row.content_modified_at or row.updated_at).isoformat()
    if sort == "size":
        return row.size_bytes or 0
    return row.name_sort.hex()


def _encode_cursor(row: DriveItem, sort: Sort) -> str:
    raw = json.dumps([row.kind, _cursor_value(row, sort), str(row.id)])
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_cursor(cursor: str, sort: Sort) -> tuple[str, Any, uuid.UUID]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        kind, value, raw_id = json.loads(base64.urlsafe_b64decode(padded))
        if kind not in ("folder", "file"):
            raise ValueError(kind)
        if sort == "modified":
            value = datetime.fromisoformat(value)
        elif sort == "size":
            value = int(value)
        else:
            value = bytes.fromhex(value)
        return kind, value, uuid.UUID(raw_id)
    except (ValueError, TypeError) as exc:
        raise bad_request("invalid_cursor", "Malformed cursor") from exc


async def list_children(
    db: AsyncSession,
    actor: User,
    folder_id: uuid.UUID,
    *,
    sort: Sort,
    order: Order,
    cursor: str | None,
    limit: int,
) -> DriveChildrenOut:
    """Folders first, then files, by name (the sidebar's Japanese order), modified or size."""
    folder, rights = await readable_item(db, actor, folder_id)
    if folder.kind != "folder":
        raise item_not_found()
    column = _sort_column(sort)
    ascending = order == "asc"
    stmt = select(DriveItem).where(DriveItem.parent_id == folder.id, DriveItem.trashed_at.is_(None))
    if cursor is not None:
        kind, value, last_id = _decode_cursor(cursor, sort)
        later = (column > value) if ascending else (column < value)
        after_id = (DriveItem.id > last_id) if ascending else (DriveItem.id < last_id)
        stmt = stmt.where(
            or_(
                DriveItem.kind < kind,  # 'folder' > 'file': the folders come first (kind DESC)
                and_(DriveItem.kind == kind, or_(later, and_(column == value, after_id))),
            )
        )
    stmt = stmt.order_by(
        DriveItem.kind.desc(),
        column.asc() if ascending else column.desc(),
        DriveItem.id.asc() if ascending else DriveItem.id.desc(),
    ).limit(limit + 1)
    rows = list((await db.execute(stmt)).scalars().all())
    more = len(rows) > limit
    rows = rows[:limit]
    chain = await repo.ancestor_ids(db, folder.id)
    return DriveChildrenOut(
        folder=await item_out(db, folder),
        path=await crumbs(db, chain, rights.location),
        items=await items_out(db, rows),
        next_cursor=_encode_cursor(rows[-1], sort) if more and rows else None,
        shared_above=await shares.shared_above(db, chain),
    )


# --- items: tree changes -----------------------------------------------------------------------


def name_taken(existing: DriveItem) -> AppError:
    return conflict(
        "drive_name_taken",
        "An item with this name already exists here",
        {"existing_id": str(existing.id), "existing_kind": existing.kind},
    )


def depth_exceeded() -> AppError:
    return AppError(
        422, "drive_depth_exceeded", f"Folders nest at most {names.MAX_DEPTH} levels deep"
    )


async def depth_of(db: AsyncSession, item_id: uuid.UUID) -> int:
    """Steps from the root (the root: 0)."""
    return len(await repo.ancestor_ids(db, item_id)) - 1


async def require_room(db: AsyncSession, folder_id: uuid.UUID, adding: int = 1) -> None:
    if await repo.count_children(db, folder_id) + adding > names.MAX_CHILDREN:
        raise conflict("drive_folder_full", f"A folder holds at most {names.MAX_CHILDREN} items")


async def free_name(db: AsyncSession, parent_id: uuid.UUID, name: str, *, is_file: bool) -> str:
    """`name`, or 「名前 (n).ext」 with the smallest n free in the folder."""
    if await repo.child_by_key(db, parent_id, names.key(name)) is None:
        return name
    stem = names.numbered(name, 1, is_file=is_file).rsplit(" (1)", 1)[0]
    taken = await repo.child_keys(db, parent_id, names.key(stem))
    for n in range(1, names.MAX_CHILDREN + 2):
        candidate = names.numbered(name, n, is_file=is_file)
        if names.key(candidate) not in taken:
            return candidate
    raise conflict("drive_folder_full", f"A folder holds at most {names.MAX_CHILDREN} items")


def set_name(item: DriveItem, name: str) -> None:
    item.name = name
    item.name_key = names.key(name)
    item.name_sort = names.sort_key(name)


async def lock_location(db: AsyncSession, location_id: uuid.UUID) -> DriveLocation:
    location = await repo.location(db, location_id, for_update=True)
    if location is None:
        raise item_not_found()
    return location


async def new_folder_in_tx(
    db: AsyncSession,
    actor: User,
    parent: DriveItem,
    name: str,
    *,
    client_op_id: uuid.UUID | None = None,
) -> DriveItem:
    """A folder in a locked, live parent whose name is free (checked by the caller)."""
    await require_room(db, parent.id)
    now = utcnow()
    folder = DriveItem(
        id=uuid7(),
        location_id=parent.location_id,
        parent_id=parent.id,
        kind="folder",
        created_by=actor.id,
        created_at=now,
        updated_by=actor.id,
        updated_at=now,
        change_seq=await events.next_seq(db),
        client_op_id=client_op_id,
    )
    set_name(folder, name)
    db.add(folder)
    await db.flush()
    return folder


async def ensure_path_in_tx(
    db: AsyncSession, actor: User, parent: DriveItem, segments: list[str]
) -> tuple[DriveItem, list[uuid.UUID]]:
    """mkdir -p below a locked parent: the last folder, and the folders that got a new child
    (one per folder made: the caller adds them to the location's item_count when it locks the
    location, after the folders). A file in the way is 409 drive_name_taken; deeper than 32 is
    422."""
    if await depth_of(db, parent.id) + len(segments) > names.MAX_DEPTH:
        raise depth_exceeded()
    current = parent
    changed: list[uuid.UUID] = []
    for segment in segments:
        existing = await repo.child_by_key(db, current.id, names.key(segment))
        if existing is not None:
            if existing.kind != "folder":
                raise name_taken(existing)
            found = (await repo.lock_items(db, [existing.id])).get(existing.id)
            # Moved or trashed between the lookup and the lock (REVIEW-v0.1.70 #1).
            if (
                found is None
                or found.parent_id != current.id
                or found.trashed_at is not None
                or found.location_id != current.location_id
            ):
                raise item_not_found()
            current = found
            continue
        folder = await new_folder_in_tx(db, actor, current, segment)
        changed.append(current.id)
        current = folder
    return current, changed


async def _writable_folder(
    db: AsyncSession, actor: User, folder_id: uuid.UUID
) -> tuple[DriveItem, Access]:
    """A live folder the actor can write in, locked."""
    folder, rights = await readable_item(db, actor, folder_id)
    rights.require_write()
    if folder.kind != "folder":
        raise item_not_found()
    locked = (await repo.lock_items(db, [folder.id])).get(folder.id)
    if locked is None or locked.trashed_at is not None:
        raise item_not_found()
    return locked, rights


async def create_folder(
    db: AsyncSession, actor: User, data: DriveFolderCreate
) -> tuple[DriveItemOut, bool]:
    """(the folder, whether it was made now)."""
    parent, _ = await _writable_folder(db, actor, data.parent_id)
    if data.path is not None:
        segments = names.split_path(data.path)
        folder, changed = await ensure_path_in_tx(db, actor, parent, segments)
        if changed:
            location = await lock_location(db, parent.location_id)
            location.item_count += len(changed)
            location.updated_at = utcnow()
            await events.emit_changed(db, parent.location_id, changed)
        await db.commit()
        return await item_out(db, folder), bool(changed)
    assert data.name is not None
    name = names.normalize(data.name)
    existing = await repo.child_by_key(db, parent.id, names.key(name))
    if existing is not None:
        if (
            data.client_op_id is not None
            and existing.client_op_id == data.client_op_id
            and existing.created_by == actor.id
        ):
            await db.commit()
            return await item_out(db, existing), False
        raise name_taken(existing)
    if data.client_op_id is not None:
        # The same request again after the folder was renamed or moved: the same folder.
        found = (
            await db.execute(
                select(DriveItem).where(
                    DriveItem.created_by == actor.id, DriveItem.client_op_id == data.client_op_id
                )
            )
        ).scalar_one_or_none()
        if found is not None:
            await db.commit()
            return await item_out(db, found), False
    if await depth_of(db, parent.id) + 1 > names.MAX_DEPTH:
        raise depth_exceeded()
    folder = await new_folder_in_tx(db, actor, parent, name, client_op_id=data.client_op_id)
    location = await lock_location(db, parent.location_id)
    location.item_count += 1
    location.updated_at = utcnow()
    await events.emit_changed(db, parent.location_id, [parent.id])
    await db.commit()
    return await item_out(db, folder), True


async def rename(db: AsyncSession, actor: User, item_id: uuid.UUID, raw: str) -> DriveItemOut:
    item, rights = await readable_item(db, actor, item_id)
    rights.require_write()
    if item.parent_id is None:
        raise root_immutable()
    if item.system_role is not None:
        raise posted.folder_system()
    name = names.normalize(raw)
    locked = await repo.lock_items(db, [item.parent_id, item.id])
    item = locked[item.id]
    if item.trashed_at is not None:
        raise item_not_found()
    if item.name == name:
        await db.commit()
        return await item_out(db, item)
    existing = await repo.child_by_key(db, item.parent_id, names.key(name))  # type: ignore[arg-type]
    if existing is not None and existing.id != item.id:
        raise name_taken(existing)
    set_name(item, name)
    item.updated_by = actor.id
    item.updated_at = utcnow()
    item.change_seq = await events.next_seq(db)
    if item.current_version_id is not None:
        # The preview PDF's file name follows the item's (attachments' Content-Disposition).
        # CF1 (docs/CHANNEL_FILES.md §4.3): not a posted file's: its message keeps the name it
        # was posted under (no event would tell the devices; a later name must not leak there).
        version = await db.get(DriveFileVersion, item.current_version_id)
        if version is not None:
            for attachment in await attachments.get_many(db, [version.attachment_id]):
                if attachment.message_id is None:
                    attachment.filename = name
    await events.emit_changed(db, item.location_id, [item.parent_id])
    await db.commit()
    return await item_out(db, item)


def root_immutable() -> AppError:
    return conflict("drive_root_immutable", "The root of a drive cannot be changed")


async def check_quota_in_tx(
    db: AsyncSession,
    settings: Settings,
    location: DriveLocation,
    adding: int,
    *,
    with_reservations: bool,
    workspace: bool = True,
) -> None:
    """409 drive_quota_exceeded when `adding` more bytes do not fit the location's quota (a My
    Drive without one: DRIVE_USER_DEFAULT_QUOTA_BYTES) or the whole drive's
    (DRIVE_TOTAL_QUOTA_BYTES). The location row must be locked; the whole drive's check takes an
    advisory lock. `with_reservations`: the sessions under way count too (a new session)."""
    if adding <= 0:
        return
    quota = location.quota_bytes
    if quota is None and location.kind == "user":
        quota = settings.drive_user_default_quota_bytes
    pending = await repo.reserved_bytes(db, location.id) if with_reservations else 0
    if quota is not None and location.used_bytes + pending + adding > quota:
        raise conflict(
            "drive_quota_exceeded",
            "This drive is full",
            {
                "quota_bytes": quota,
                "used_bytes": location.used_bytes,
                "location_id": str(location.id),
                "scope": "location",
            },
        )
    total = settings.drive_total_quota_bytes
    if total is not None and workspace:
        await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": QUOTA_LOCK})
        used = await repo.total_used(db)
        pending_all = await repo.reserved_bytes(db, None) if with_reservations else 0
        if used + pending_all + adding > total:
            raise conflict(
                "drive_quota_exceeded",
                "The drive is full",
                {"quota_bytes": total, "used_bytes": used, "scope": "workspace"},
            )


def _error_code(exc: AppError) -> str:
    return exc.code


async def move(
    db: AsyncSession,
    actor: User,
    settings: Settings,
    item_ids: list[uuid.UUID],
    target_folder_id: uuid.UUID,
    on_conflict: Literal["fail", "rename"],
) -> DriveResultsOut:
    """Each item on its own (a savepoint each), into a live folder the actor can write in. Across
    locations the actor must write in both and the bytes move with the items (the target's quota
    is checked)."""
    target, target_rights = await readable_item(db, actor, target_folder_id)
    target_rights.require_write()
    if target.kind != "folder":
        raise item_not_found()
    wanted = list(dict.fromkeys(item_ids))
    found = await repo.items(db, wanted)
    parents = {row.parent_id for row in found.values() if row.parent_id is not None}
    locked = await repo.lock_items(db, [target.id, *parents, *found.keys()])
    target = locked[target.id]
    if target.trashed_at is not None:
        raise item_not_found()
    target_chain = set(await repo.ancestor_ids(db, target.id))
    target_depth = len(target_chain) - 1
    results: list[DriveItemResult] = []
    changed: dict[uuid.UUID, set[uuid.UUID]] = {}
    across: list[uuid.UUID] = []
    for item_id in wanted:
        item = locked.get(item_id)
        try:
            async with db.begin_nested():
                across += await _move_one(
                    db,
                    actor,
                    settings,
                    item,
                    target,
                    target_chain,
                    target_depth,
                    on_conflict,
                    changed,
                )
            results.append(DriveItemResult(id=item_id, ok=True))
        except AppError as exc:
            results.append(DriveItemResult(id=item_id, ok=False, error=_error_code(exc)))
    # CF1 (docs/CHANNEL_FILES.md §6.4): posted files that left their channel's drive (or came
    # back to it) change in their messages.
    await posted.restate_in_tx(db, across)
    for location_id, folders in changed.items():
        await events.emit_changed(db, location_id, folders)
    await db.commit()
    return DriveResultsOut(results=results)


async def _move_one(
    db: AsyncSession,
    actor: User,
    settings: Settings,
    item: DriveItem | None,
    target: DriveItem,
    target_chain: set[uuid.UUID],
    target_depth: int,
    on_conflict: str,
    changed: dict[uuid.UUID, set[uuid.UUID]],
) -> list[uuid.UUID]:
    """Returns the ids that changed location (the subtree, when it moved across)."""
    if item is None or item.trashed_at is not None:
        raise item_not_found()
    source = await repo.location(db, item.location_id)
    if source is None:
        raise item_not_found()
    (await acl.access(db, actor, source)).require_write()
    if item.parent_id is None:
        raise root_immutable()
    if item.system_role is not None:
        raise posted.folder_system()
    if item.id in target_chain:
        raise conflict("drive_cycle", "A folder cannot go inside itself")
    if item.parent_id == target.id:
        return []
    tree = await repo.subtree(db, item.id)
    height = max(steps for _, steps in tree)
    if target_depth + 1 + height > names.MAX_DEPTH:
        raise depth_exceeded()
    await require_room(db, target.id)
    name = item.name
    existing = await repo.child_by_key(db, target.id, item.name_key)
    if existing is not None:
        if on_conflict != "rename":
            raise name_taken(existing)
        name = await free_name(db, target.id, item.name, is_file=item.kind == "file")
    old_parent = item.parent_id
    across: list[uuid.UUID] = []
    if item.location_id != target.location_id:
        across = [i for i, _ in tree]
        await move_across_in_tx(
            db, settings, across, item.location_id, target.location_id, check=True
        )
    item.parent_id = target.id
    if name != item.name:
        set_name(item, name)
    item.updated_by = actor.id
    item.updated_at = utcnow()
    item.change_seq = await events.next_seq(db)
    await db.flush()
    changed.setdefault(source.id, set()).add(old_parent)
    changed.setdefault(target.location_id, set()).add(target.id)
    return across


async def move_across_in_tx(
    db: AsyncSession,
    settings: Settings,
    ids: list[uuid.UUID],
    source_id: uuid.UUID,
    target_id: uuid.UUID,
    *,
    check: bool,
) -> None:
    """A subtree (its trash too) changes location: its rows, its bytes and its count. The two
    location rows are locked in id order."""
    size = await repo.versions_bytes(db, ids)
    rows = {}
    for location_id in sorted({source_id, target_id}):
        rows[location_id] = await lock_location(db, location_id)
    if check:
        # Within the workspace the whole drive does not grow.
        await check_quota_in_tx(
            db, settings, rows[target_id], size, with_reservations=False, workspace=False
        )
    await db.execute(
        update(DriveItem)
        .where(DriveItem.id.in_(ids))
        .values(location_id=target_id, change_seq=text("nextval('drive_change_seq')"))
        .execution_options(synchronize_session="fetch")
    )
    now = utcnow()
    rows[source_id].used_bytes -= size
    rows[source_id].item_count -= len(ids)
    rows[source_id].updated_at = now
    rows[target_id].used_bytes += size
    rows[target_id].item_count += len(ids)
    rows[target_id].updated_at = now
    await db.flush()


async def _trash_group_in_tx(
    db: AsyncSession, item: DriveItem, actor_id: uuid.UUID, now: datetime
) -> list[uuid.UUID]:
    """The item and what is under it outside the trash, as one group (its root the item);
    returns the subtree's ids."""
    ids = [i for i, _ in await repo.subtree(db, item.id)]
    await db.execute(
        update(DriveItem)
        .where(DriveItem.id.in_(ids), DriveItem.trashed_at.is_(None))
        .values(
            trashed_at=now,
            trashed_by=actor_id,
            trash_root_id=item.id,
            change_seq=text("nextval('drive_change_seq')"),
        )
        .execution_options(synchronize_session=False)
    )
    await db.execute(
        update(DriveItem)
        .where(DriveItem.id == item.id)
        .values(trash_parent_id=item.parent_id)
        .execution_options(synchronize_session=False)
    )
    return ids


async def _audit_posted_trash(
    db: AsyncSession,
    actor_id: uuid.UUID,
    groups: dict[uuid.UUID, tuple[DriveItem, set[uuid.UUID]]],
    hidden: list[tuple[uuid.UUID, uuid.UUID]],
) -> None:
    """CF1 (docs/CHANNEL_FILES.md §6.5, §14): a trash that hides posted files from their
    messages is audited (drive.trash, via drive), one record per group."""
    for root_id, (root, ids) in groups.items():
        messages = {m for item_id, m in hidden if item_id in ids}
        if not messages:
            continue
        await audit.record_in_tx(
            db,
            actor_id=actor_id,
            action="drive.trash",
            target_type="drive_item",
            target_id=root_id,
            details={
                "via": "drive",
                "location_id": str(root.location_id),
                "name": root.name,
                "messages": len(messages),
            },
        )


async def trash(db: AsyncSession, actor: User, item_ids: list[uuid.UUID]) -> DriveResultsOut:
    """Each item and everything under it that is not in the trash yet: one group, its root the
    item (§10.1). In 研究室ドライブ anyone may trash anyone's file (restorable for 30 days)."""
    wanted = list(dict.fromkeys(item_ids))
    found = await repo.items(db, wanted)
    parents = {row.parent_id for row in found.values() if row.parent_id is not None}
    locked = await repo.lock_items(db, [*parents, *found.keys()])
    results: list[DriveItemResult] = []
    changed: dict[uuid.UUID, set[uuid.UUID]] = {}
    groups: dict[uuid.UUID, tuple[DriveItem, set[uuid.UUID]]] = {}
    now = utcnow()
    for item_id in wanted:
        item = locked.get(item_id)
        try:
            async with db.begin_nested():
                if item is None:
                    raise item_not_found()
                await db.refresh(item)  # an earlier item of the request may have trashed it
                location = await repo.location(db, item.location_id)
                if location is None:
                    raise item_not_found()
                (await acl.access(db, actor, location)).require_write()
                if item.trashed_at is not None:
                    raise item_not_found()
                if item.parent_id is None:
                    raise root_immutable()
                if item.system_role is not None:
                    raise posted.folder_system()
                ids = await _trash_group_in_tx(db, item, actor.id, now)
                groups[item.id] = (item, set(ids))
                changed.setdefault(item.location_id, set()).add(item.parent_id)
            results.append(DriveItemResult(id=item_id, ok=True))
        except AppError as exc:
            results.append(DriveItemResult(id=item_id, ok=False, error=_error_code(exc)))
    # CF1 (docs/CHANNEL_FILES.md §6.5): their messages show 「削除されたファイル」.
    hidden = await posted.restate_in_tx(db, [i for _, ids in groups.values() for i in ids])
    await _audit_posted_trash(db, actor.id, groups, hidden)
    for location_id, folders in changed.items():
        await events.emit_changed(db, location_id, folders)
    await db.commit()
    return DriveResultsOut(results=results)


async def trash_posted_in_tx(
    db: AsyncSession,
    actor_id: uuid.UUID,
    item_ids: list[uuid.UUID],
    *,
    message_id: uuid.UUID,
) -> list[uuid.UUID]:
    """CF1 (docs/CHANNEL_FILES.md §7.3): the files of a message being deleted that its rule puts
    in the trash (the caller decided which; no drive permission is checked: whoever may delete
    the message takes back what was posted with it). The folders are locked first, before the
    message's channel; the message's own rows are left to the delete. Audited as drive.trash
    (via message_delete). Returns the items trashed (one in the trash already or gone is
    skipped)."""
    wanted = list(dict.fromkeys(item_ids))
    if not wanted:
        return []
    found = await repo.items(db, wanted)
    parents = {row.parent_id for row in found.values() if row.parent_id is not None}
    locked = await repo.lock_items(db, [*parents, *found.keys()])
    now = utcnow()
    done: list[uuid.UUID] = []
    changed: dict[uuid.UUID, set[uuid.UUID]] = {}
    for item_id in wanted:
        item = locked.get(item_id)
        if item is None or item.trashed_at is not None or item.parent_id is None:
            continue
        if item.kind != "file":
            continue
        await _trash_group_in_tx(db, item, actor_id, now)
        changed.setdefault(item.location_id, set()).add(item.parent_id)
        done.append(item.id)
        await audit.record_in_tx(
            db,
            actor_id=actor_id,
            action="drive.trash",
            target_type="drive_item",
            target_id=item.id,
            details={
                "via": "message_delete",
                "message_id": str(message_id),
                "location_id": str(item.location_id),
                "name": item.name,
            },
        )
    await db.flush()
    await posted.restate_in_tx(db, done, skip_message_id=message_id)
    for location_id, folders in changed.items():
        await events.emit_changed(db, location_id, folders)
    return done


def not_trash_root() -> AppError:
    return conflict("drive_not_in_trash", "Only a group in the trash can be restored or deleted")


async def restore(
    db: AsyncSession, actor: User, item_id: uuid.UUID, on_conflict: Literal["rename", "fail"]
) -> DriveItemOut:
    """A group back where it was, or to the root when that folder is in the trash or gone."""
    item, rights = await readable_item(db, actor, item_id, trashed_ok=True)
    rights.require_write()
    if item.trashed_at is None or item.trash_root_id != item.id:
        raise not_trash_root()
    location = rights.location
    target_id = location.root_id
    if item.trash_parent_id is not None:
        previous = await repo.item(db, item.trash_parent_id)
        if (
            previous is not None
            and previous.trashed_at is None
            and previous.location_id == item.location_id
        ):
            target_id = previous.id
    locked = await repo.lock_items(db, [target_id, item.id])
    item, target = locked[item.id], locked.get(target_id)
    if target is None or target.trashed_at is not None:
        target = (await repo.lock_items(db, [location.root_id]))[location.root_id]
    if item.trash_root_id != item.id:
        raise not_trash_root()
    await require_room(db, target.id)
    name = item.name
    existing = await repo.child_by_key(db, target.id, item.name_key)
    if existing is not None:
        if on_conflict == "fail":
            raise name_taken(existing)
        name = await free_name(db, target.id, item.name, is_file=item.kind == "file")
    if target.id != item.parent_id:
        depth = await depth_of(db, target.id)
        height = max(steps for _, steps in await repo.subtree(db, item.id))
        if depth + 1 + height > names.MAX_DEPTH:
            raise depth_exceeded()
    # The root first, under its free name (the unique index counts it once it is live), then the
    # rest of the group below it.
    item.trashed_at = None
    item.trashed_by = None
    item.trash_root_id = None
    item.trash_parent_id = None
    item.parent_id = target.id
    if name != item.name:
        set_name(item, name)
    item.updated_by = actor.id
    item.updated_at = utcnow()
    item.change_seq = await events.next_seq(db)
    await db.flush()
    group = list(
        (await db.execute(select(DriveItem.id).where(DriveItem.trash_root_id == item.id))).scalars()
    )
    await db.execute(
        update(DriveItem)
        .where(DriveItem.trash_root_id == item.id)
        .values(
            trashed_at=None,
            trashed_by=None,
            trash_root_id=None,
            change_seq=text("nextval('drive_change_seq')"),
        )
        .execution_options(synchronize_session=False)
    )
    # CF1 (docs/CHANNEL_FILES.md §6.5): posted files come back in their messages.
    await posted.restate_in_tx(db, [item.id, *group])
    await events.emit_changed(db, item.location_id, [target.id])
    await db.commit()
    return await item_out(db, item)


async def list_trash(
    db: AsyncSession, actor: User, location_id: uuid.UUID, *, cursor: str | None, limit: int
) -> DriveTrashOut:
    """The groups in the location's trash, newest first."""
    location, _ = await require_location(db, actor, location_id)
    stmt = select(DriveItem).where(
        DriveItem.location_id == location.id,
        DriveItem.trashed_at.is_not(None),
        DriveItem.trash_root_id == DriveItem.id,
    )
    if cursor is not None:
        try:
            raw_at, raw_id = cursor.split("|", 1)
            at, last = datetime.fromisoformat(raw_at), uuid.UUID(raw_id)
        except ValueError as exc:
            raise bad_request("invalid_cursor", "Malformed cursor") from exc
        stmt = stmt.where(
            or_(
                DriveItem.trashed_at < at,
                and_(DriveItem.trashed_at == at, DriveItem.id < last),
            )
        )
    stmt = stmt.order_by(DriveItem.trashed_at.desc(), DriveItem.id.desc()).limit(limit + 1)
    roots = list((await db.execute(stmt)).scalars().all())
    more = len(roots) > limit
    roots = roots[:limit]
    entries: list[DriveTrashEntryOut] = []
    for root, out in zip(roots, await items_out(db, roots), strict=True):
        members = list(
            (
                await db.execute(select(DriveItem.id).where(DriveItem.trash_root_id == root.id))
            ).scalars()
        )
        assert root.trashed_at is not None
        entries.append(
            DriveTrashEntryOut(
                item=out,
                trashed_at=root.trashed_at,
                trashed_by=root.trashed_by,
                item_count=len(members),
                size_bytes=await repo.versions_bytes(db, members),
            )
        )
    next_cursor = None
    if more and roots and roots[-1].trashed_at is not None:
        next_cursor = f"{roots[-1].trashed_at.isoformat()}|{roots[-1].id}"
    return DriveTrashOut(entries=entries, next_cursor=next_cursor)


async def purge_in_tx(
    db: AsyncSession, root: DriveItem, *, actor_id: uuid.UUID | None, action: str
) -> tuple[int, int]:
    """An item and everything under it, for good: the versions' attachments become `deleted`
    (the attachment GC removes the bytes and their thumbnails and previews), the rows go, the
    location gives the bytes back. Upload sessions into the subtree go with it (CASCADE; their
    S3 parts are dropped by the orphan sweep). (items, bytes)."""
    ids = [i for i, _ in await repo.subtree(db, root.id)]
    versions = await repo.versions_of(db, ids)
    size = sum(v.size_bytes for v in versions)
    # The location before the channels and the attachments (CF1: a send's order, posted.py).
    location = await lock_location(db, root.location_id)
    # CF1 (docs/CHANNEL_FILES.md §7.5): posted files stay in their messages as tombstones.
    tombstoned = await posted.purge_posted_in_tx(db, [v.attachment_id for v in versions])
    await attachments.mark_ids_deleted_in_tx(db, [v.attachment_id for v in versions])
    # One statement: the rows' references to each other (parent, trash group) are checked at its
    # end, the versions go by CASCADE (the current-version key is deferred).
    await db.execute(
        delete(DriveItem).where(DriveItem.id.in_(ids)).execution_options(synchronize_session=False)
    )
    location.used_bytes -= size
    location.item_count -= len(ids)
    location.updated_at = utcnow()
    await audit.record_in_tx(
        db,
        actor_id=actor_id,
        action=action,
        target_type="drive_item",
        target_id=root.id,
        details={
            "location_id": str(root.location_id),
            "location_kind": location.kind,
            "name": root.name,
            "items": len(ids),
            "bytes": size,
            **({"posted_messages": len(set(tombstoned))} if tombstoned else {}),
        },
    )
    await db.flush()
    # The rows are gone: the session must not keep (or flush) its copies of them.
    gone = set(ids)
    for row in list(db.identity_map.values()):
        if (isinstance(row, DriveItem) and row.id in gone) or (
            isinstance(row, DriveFileVersion) and row.item_id in gone
        ):
            db.expunge(row)
        elif isinstance(row, Attachment) and row.drive_item_id in gone:
            row.drive_item_id = None  # ON DELETE SET NULL did the same in the database
    await posted.announce(db, tombstoned)
    return len(ids), size


async def delete_permanently(db: AsyncSession, actor: User, item_id: uuid.UUID) -> None:
    """A group in the trash, for good (§3.2: 研究室ドライブ admins, a channel's owners, My Drive's
    owner)."""
    item, rights = await readable_item(db, actor, item_id, trashed_ok=True)
    rights.require_manage()
    locked = (await repo.lock_items(db, [item.id])).get(item.id)
    if locked is None or locked.trashed_at is None or locked.trash_root_id != locked.id:
        raise not_trash_root()
    location_id = locked.location_id
    await purge_in_tx(db, locked, actor_id=actor.id, action="drive.delete")
    await events.emit_changed(db, location_id, [])
    await db.commit()


# --- the takeover of a My Drive (§3.3) ---------------------------------------------------------

TAKEOVER_FOLDER = "引き取り"


async def takeover(
    db: AsyncSession,
    actor: User,
    settings: Settings,
    user_id: uuid.UUID,
    target_folder_name: str | None,
) -> DriveItemOut:
    """An administrator moves a deactivated person's My Drive, without looking into it, into a
    folder of 研究室ドライブ (「引き取り/<表示名>」 by default). Always audited."""
    if not has_capability(actor, "drive.admin"):
        raise forbidden("admin_required", "Administrator role required")
    owner = await db.get(User, user_id)
    if owner is None:
        raise not_found("user_not_found", "User not found")
    if owner.is_active:
        raise conflict(
            "drive_takeover_active_user", "Only a deactivated person's My Drive can be taken over"
        )
    source = await repo.location_of_user(db, owner.id)
    if source is None or source.deleted_at is not None:
        raise item_not_found()
    workspace = await workspace_location(db)
    root = (await repo.lock_items(db, [workspace.root_id]))[workspace.root_id]
    base = [names.normalize(target_folder_name)] if target_folder_name else [TAKEOVER_FOLDER]
    holder, changed = await ensure_path_in_tx(db, actor, root, base)
    leaf = await free_name(
        db, holder.id, names.normalize(owner.display_name or owner.username), is_file=False
    )
    folder = await new_folder_in_tx(db, actor, holder, leaf)
    location = await lock_location(db, workspace.id)
    location.item_count += 1 + len(changed)
    children = list(
        (
            await db.execute(
                select(DriveItem).where(
                    DriveItem.parent_id == source.root_id, DriveItem.trashed_at.is_(None)
                )
            )
        ).scalars()
    )
    await require_room(db, folder.id, len(children))
    moved = 0
    for child in sorted(children, key=lambda c: c.id):
        tree = [i for i, _ in await repo.subtree(db, child.id)]
        await move_across_in_tx(db, settings, tree, source.id, workspace.id, check=False)
        await db.refresh(child)
        child.parent_id = folder.id
        child.updated_at = utcnow()
        moved += len(tree)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="drive.takeover",
        target_type="user",
        target_id=owner.id,
        details={"folder_id": str(folder.id), "items": moved},
    )
    await events.emit_changed(db, workspace.id, [*changed, holder.id])
    await events.emit_changed(db, source.id, [source.root_id])
    await db.commit()
    return await item_out(db, folder)


# --- people who leave (§3.3) ----------------------------------------------------------------


async def forget_user_in_tx(db: AsyncSession, user_id: uuid.UUID) -> None:
    """Anonymisation (M104, admin.anonymize_in_tx): the person's My Drive goes for good (the
    housekeeping purges it, no trash), their unfinished uploads are dropped and their external
    links revoked (phase D4, §3.3)."""
    await shares.revoke_created_by_in_tx(db, user_id)
    location = await repo.location_of_user(db, user_id)
    if location is not None and location.deleted_at is None:
        location.deleted_at = utcnow()
    await db.execute(
        update(DriveUpload)
        .where(DriveUpload.user_id == user_id, DriveUpload.status.in_(("active", "completing")))
        .values(status="active", expires_at=utcnow() - timedelta(seconds=1))
        .execution_options(synchronize_session=False)
    )
    await db.flush()


async def purge_deleted_locations(db: AsyncSession) -> int:
    """The My Drives of anonymised people: everything in them, then the location."""
    rows = list(
        (
            await db.execute(
                select(DriveLocation).where(DriveLocation.deleted_at.is_not(None)).limit(20)
            )
        ).scalars()
    )
    done = 0
    for location in rows:
        root = await repo.item(db, location.root_id)
        uploads = await db.execute(
            select(func.count())
            .select_from(DriveUpload)
            .where(
                DriveUpload.location_id == location.id,
                DriveUpload.status.in_(("active", "completing")),
            )
        )
        if int(uploads.scalar_one()):
            continue  # the upload housekeeping drops them first (it aborts their S3 parts)
        location_id = location.id
        if root is not None:
            await purge_in_tx(db, root, actor_id=None, action="drive.purge")
        await db.execute(delete(DriveUpload).where(DriveUpload.location_id == location_id))
        await db.execute(delete(DriveLocation).where(DriveLocation.id == location_id))
        await db.commit()
        done += 1
    return done


async def purge_old_trash(db: AsyncSession, *, days: int, now: datetime, limit: int = 100) -> int:
    """§10.1: groups in the trash for more than DRIVE_TRASH_DAYS, one transaction each."""
    stmt = (
        select(DriveItem.id)
        .where(
            DriveItem.trashed_at.is_not(None),
            DriveItem.trash_root_id == DriveItem.id,
            DriveItem.trashed_at < now - timedelta(days=days),
        )
        .order_by(DriveItem.trashed_at)
        .limit(limit)
    )
    ids = list((await db.execute(stmt)).scalars().all())
    await db.rollback()
    purged = 0
    for item_id in ids:
        locked = (await repo.lock_items(db, [item_id])).get(item_id)
        if locked is None or locked.trashed_at is None or locked.trash_root_id != locked.id:
            await db.rollback()
            continue
        location_id = locked.location_id
        await purge_in_tx(db, locked, actor_id=None, action="drive.purge")
        await events.emit_changed(db, location_id, [])
        await db.commit()
        purged += 1
    return purged
