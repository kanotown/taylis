"""Photo albums (AL1, M180, docs/ALBUMS.md): a drive folder plus a little metadata.

- Who sees and changes an album is the folder's location's rule (DRIVE.md §3.2): reading the
  location reads the album; writing in it makes a folder an album, changes its description, cover,
  order and dates, or makes it a plain folder again (its files stay). An album goes with its
  folder: into the trash and back, to another location, away for good (CASCADE).
- `POST /drive/albums` makes the folder and the album in one transaction, in a given folder or in
  the location's 「アルバム」 folder (made when missing, §17 Q2), idempotent by `client_op_id` as
  POST /drive/folders.
- `GET /drive/albums` lists the albums of every location the caller can read, newest first;
  `GET /drive/albums/{id}` an album with a page of its photos and videos in its order.
- `POST /drive/albums/{id}/add` (§9): a posted file whose item is in the album's location (its
  channel's drive) is moved there, not copied (the message keeps showing the same version and its
  drive_state stays `available`); a posted file elsewhere and an ordinary attachment are copied;
  drive items are moved within the location and copied from another. `mode` overrides it (an
  ordinary attachment is always copied). A name taken in the album keeps both.
- No new event: every change is a drive.changed of the folder and its parent.
"""

import base64
import json
import re
import unicodedata
import uuid
from datetime import date
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, bad_request, not_found
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import BlobStore
from app.modules.drive import access as acl
from app.modules.drive import (
    album_cards,
    conversation,
    copying,
    events,
    names,
    posted,
    service,
    shares,
)
from app.modules.drive import repository as repo
from app.modules.drive.access import item_not_found
from app.modules.drive.models import ALBUMS_ROLE, DriveAlbum, DriveItem
from app.modules.drive.photos import zone
from app.modules.drive.schemas import (
    MAX_ALBUM_DESCRIPTION,
    AlbumAddIn,
    AlbumAddOut,
    AlbumAddResult,
    AlbumCreate,
    AlbumCreatedOut,
    AlbumDetailOut,
    AlbumListEntryOut,
    AlbumListOut,
    AlbumOut,
    AlbumPut,
    DriveCopyIn,
    DriveSaveAttachmentIn,
)
from app.modules.users.models import User

# The folder 「新しいアルバム」 makes albums in when started from a location (§17 Q2): an ordinary
# folder, stored in Japanese like 「投稿のファイル」 and marked system_role 'albums' (§23) so
# clients name it in their language while it keeps this name.
ALBUMS_FOLDER = "アルバム"
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def album_invalid(message: str) -> AppError:
    return AppError(422, "drive_album_invalid", message)


def album_not_found() -> AppError:
    return not_found("drive_album_not_found", "Album not found")


def _description(raw: str) -> str:
    text = _CONTROL.sub("", unicodedata.normalize("NFC", raw)).strip()
    if len(text) > MAX_ALBUM_DESCRIPTION:
        raise album_invalid(f"A description has at most {MAX_ALBUM_DESCRIPTION} characters")
    return text


def _dates(starts_on: date | None, ends_on: date | None) -> None:
    if starts_on is not None and ends_on is not None and ends_on < starts_on:
        raise album_invalid("The album ends before it starts")


def _albumable(folder: DriveItem) -> None:
    if folder.kind != "folder":
        raise album_invalid("Only a folder can be an album")
    if folder.parent_id is None:
        raise album_invalid("A drive's top folder cannot be an album")
    if folder.system_role is not None:
        raise album_invalid("A folder kept by the server cannot be an album")


async def out(db: AsyncSession, album: DriveAlbum) -> AlbumOut:
    return (await album_cards.outs(db, [album]))[album.folder_id]


async def _writable_folder(
    db: AsyncSession, actor: User, folder_id: uuid.UUID
) -> tuple[DriveItem, acl.Access]:
    folder, rights = await service.readable_item(db, actor, folder_id)
    rights.require_write()
    _albumable(folder)
    locked = (await repo.lock_items(db, [folder.id])).get(folder.id)
    if locked is None or locked.trashed_at is not None:
        raise item_not_found()
    return locked, rights


async def _albums_folder_in_tx(
    db: AsyncSession, actor: User, root: DriveItem
) -> tuple[DriveItem, list[uuid.UUID], list[uuid.UUID]]:
    """The location's 「アルバム」 folder below its locked root, locked: (it, the folders that got
    a new child, the folders whose child changed role).

    The folder with system_role 'albums' wherever it is now in the location (renamed or moved
    inside it, §23); else a live folder named 「アルバム」 right under the top (made by a person, by
    AL1 before the role, or restored from the trash) gets the role; else a new one is made. A file
    of that name is 409 drive_name_taken, as before."""
    stmt = select(DriveItem.id).where(
        DriveItem.location_id == root.location_id,
        DriveItem.system_role == ALBUMS_ROLE,
        DriveItem.trashed_at.is_(None),
    )
    found_id = (await db.execute(stmt)).scalar_one_or_none()
    if found_id is not None:
        found = (await repo.lock_items(db, [found_id])).get(found_id)
        # The root is locked, so no other album made it meanwhile; a rename, move or trash may
        # have run between the lookup and the lock.
        if (
            found is not None
            and found.trashed_at is None
            and found.location_id == root.location_id
            and found.system_role == ALBUMS_ROLE
        ):
            return found, [], []
    existing = await repo.child_by_key(db, root.id, names.key(ALBUMS_FOLDER))
    if existing is not None:
        if existing.kind != "folder":
            raise service.name_taken(existing)
        found = (await repo.lock_items(db, [existing.id])).get(existing.id)
        if (
            found is None
            or found.parent_id != root.id
            or found.trashed_at is not None
            or found.location_id != root.location_id
        ):
            raise item_not_found()
        if found.system_role is not None:
            raise album_invalid("Albums cannot be made in a folder kept by the server")
        found.system_role = ALBUMS_ROLE
        found.change_seq = await events.next_seq(db)
        await db.flush()
        return found, [], [root.id]
    folder = await service.new_folder_in_tx(db, actor, root, ALBUMS_FOLDER)
    folder.system_role = ALBUMS_ROLE
    await db.flush()
    return folder, [root.id], []


# --- making, changing, unmaking ------------------------------------------------------------------


async def create(db: AsyncSession, actor: User, data: AlbumCreate) -> tuple[AlbumCreatedOut, bool]:
    """(the folder and its album, whether they were made now)."""
    name = names.normalize(data.name)
    description = _description(data.description) if data.description is not None else ""
    _dates(data.starts_on, data.ends_on)
    if data.client_op_id is not None:
        # The same request again (after the folder was renamed or moved too): the same album.
        found = (
            await db.execute(
                select(DriveItem).where(
                    DriveItem.created_by == actor.id, DriveItem.client_op_id == data.client_op_id
                )
            )
        ).scalar_one_or_none()
        if found is not None:
            album = await db.get(DriveAlbum, found.id)
            if found.kind != "folder" or album is None:
                raise album_invalid("This client_op_id made something else")
            await db.commit()
            return AlbumCreatedOut(
                folder=await service.item_out(db, found), album=await out(db, album)
            ), False
    made: list[uuid.UUID] = []
    adopted: list[uuid.UUID] = []
    if data.location_id is not None:
        location, rights = await service.require_location(db, actor, data.location_id)
        rights.require_write()
        root = (await repo.lock_items(db, [location.root_id])).get(location.root_id)
        if root is None:
            raise item_not_found()
        parent, made, adopted = await _albums_folder_in_tx(db, actor, root)
    else:
        assert data.parent_id is not None
        parent, _ = await service._writable_folder(db, actor, data.parent_id)
    if parent.system_role == posted.SYSTEM_ROLE:
        raise album_invalid("Albums cannot be made in a folder kept by the server")
    existing = await repo.child_by_key(db, parent.id, names.key(name))
    if existing is not None:
        raise service.name_taken(existing)
    if await service.depth_of(db, parent.id) + 1 > names.MAX_DEPTH:
        raise service.depth_exceeded()
    folder = await service.new_folder_in_tx(db, actor, parent, name, client_op_id=data.client_op_id)
    now = utcnow()
    album = DriveAlbum(
        folder_id=folder.id,
        description=description,
        sort=data.sort or "taken",
        sort_order=data.sort_order or "asc",
        starts_on=data.starts_on,
        ends_on=data.ends_on,
        created_by=actor.id,
        created_at=now,
        updated_by=actor.id,
        updated_at=now,
    )
    db.add(album)
    await db.flush()
    location_row = await service.lock_location(db, parent.location_id)
    location_row.item_count += 1 + len(made)
    location_row.updated_at = now
    await events.emit_changed(db, parent.location_id, [parent.id, *made, *adopted])
    await db.commit()
    return AlbumCreatedOut(
        folder=await service.item_out(db, folder), album=await out(db, album)
    ), True


async def _cover_ok(db: AsyncSession, folder: DriveItem, item_id: uuid.UUID) -> None:
    item = await repo.item(db, item_id)
    if (
        item is None
        or item.parent_id != folder.id
        or item.trashed_at is not None
        or item.kind != "file"
        or not (item.content_type or "").startswith(("image/", "video/"))
    ):
        raise album_invalid("The cover must be a photo or a video directly in the album")


async def put(db: AsyncSession, actor: User, folder_id: uuid.UUID, data: AlbumPut) -> AlbumOut:
    """Makes the folder an album (the fields not sent take their defaults) or changes it."""
    folder, rights = await _writable_folder(db, actor, folder_id)
    sent = data.model_fields_set
    album = await db.get(DriveAlbum, folder.id, with_for_update=True)
    now = utcnow()
    if album is None:
        album = DriveAlbum(
            folder_id=folder.id,
            description="",
            sort="taken",
            sort_order="asc",
            created_by=actor.id,
            created_at=now,
        )
        db.add(album)
    if "description" in sent and data.description is not None:
        album.description = _description(data.description)
    if "cover_item_id" in sent:
        if data.cover_item_id is not None:
            await _cover_ok(db, folder, data.cover_item_id)
        album.cover_item_id = data.cover_item_id
    if "sort" in sent and data.sort is not None:
        album.sort = data.sort
    if "sort_order" in sent and data.sort_order is not None:
        album.sort_order = data.sort_order
    if "starts_on" in sent:
        album.starts_on = data.starts_on
    if "ends_on" in sent:
        album.ends_on = data.ends_on
    _dates(album.starts_on, album.ends_on)
    album.updated_by = actor.id
    album.updated_at = now
    await db.flush()
    await events.emit_changed(db, rights.location.id, [folder.id, folder.parent_id])
    await db.commit()
    return await out(db, album)


async def remove(db: AsyncSession, actor: User, folder_id: uuid.UUID) -> None:
    """A plain folder again (its files stay where they are). Nothing to do for one that is not an
    album."""
    folder, rights = await _writable_folder(db, actor, folder_id)
    album = await db.get(DriveAlbum, folder.id, with_for_update=True)
    if album is not None:
        await db.delete(album)
        await db.flush()
        await events.emit_changed(db, rights.location.id, [folder.id, folder.parent_id])
    await db.commit()


# --- reading -------------------------------------------------------------------------------------


def _list_key(settings: Settings) -> Any:
    """An album's date in the list: its first day, else the day it was made (the workspace's
    zone)."""
    return func.coalesce(
        DriveAlbum.starts_on, func.date(func.timezone(zone(settings).key, DriveAlbum.created_at))
    )


def _encode(values: list[Any]) -> str:
    raw = json.dumps(values)
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode(cursor: str) -> list[Any]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        values = json.loads(base64.urlsafe_b64decode(padded))
        if not isinstance(values, list):
            raise ValueError(values)
        return values
    except (ValueError, TypeError) as exc:
        raise bad_request("invalid_cursor", "Malformed cursor") from exc


async def list_albums(
    db: AsyncSession,
    actor: User,
    settings: Settings,
    *,
    location_id: uuid.UUID | None,
    cursor: str | None,
    limit: int,
) -> AlbumListOut:
    readable = await service.readable_location_ids(db, actor)
    if location_id is not None:
        readable = [loc for loc in readable if loc == location_id]
    if not readable:
        return AlbumListOut(items=[], next_cursor=None)
    key = _list_key(settings)
    stmt = (
        select(DriveAlbum, DriveItem, key.label("day"))
        .join(DriveItem, DriveItem.id == DriveAlbum.folder_id)
        .where(DriveItem.location_id.in_(readable), DriveItem.trashed_at.is_(None))
    )
    if cursor is not None:
        values = _decode(cursor)
        try:
            day, last = date.fromisoformat(values[0]), uuid.UUID(values[1])
        except (ValueError, TypeError, IndexError) as exc:
            raise bad_request("invalid_cursor", "Malformed cursor") from exc
        stmt = stmt.where(or_(key < day, and_(key == day, DriveAlbum.folder_id < last)))
    stmt = stmt.order_by(key.desc(), DriveAlbum.folder_id.desc()).limit(limit + 1)
    rows = list((await db.execute(stmt)).all())
    more = len(rows) > limit
    rows = rows[:limit]
    folders = [row[1] for row in rows]
    shown = await service.items_out(db, folders)
    hits = await service.search_hits(db, folders)
    items: list[AlbumListEntryOut] = []
    for folder_out, hit in zip(shown, hits, strict=True):
        assert folder_out.album is not None
        items.append(
            AlbumListEntryOut(
                folder=folder_out,
                album=folder_out.album,
                path=hit.path,
                location_kind=hit.location_kind,
            )
        )
    next_cursor = None
    if more and rows:
        day, album = rows[-1][2], rows[-1][0]
        next_cursor = _encode([day.isoformat(), str(album.folder_id)])
    return AlbumListOut(items=items, next_cursor=next_cursor)


async def detail(
    db: AsyncSession,
    actor: User,
    folder_id: uuid.UUID,
    *,
    sort: str | None,
    order: str | None,
    cursor: str | None,
    limit: int,
) -> AlbumDetailOut:
    folder, rights = await service.readable_item(db, actor, folder_id)
    album = await db.get(DriveAlbum, folder.id) if folder.kind == "folder" else None
    if album is None:
        raise album_not_found()
    rows, next_cursor = await service.children_page(
        db,
        folder.id,
        sort=(sort or album.sort),  # type: ignore[arg-type]
        order=(order or album.sort_order),  # type: ignore[arg-type]
        cursor=cursor,
        limit=limit,
        where=album_cards.is_media(),
    )
    counts = (
        await db.execute(
            select(
                func.count().filter(DriveItem.kind == "folder"),
                func.count().filter(and_(DriveItem.kind == "file", ~album_cards.is_media())),
            ).where(DriveItem.parent_id == folder.id, DriveItem.trashed_at.is_(None))
        )
    ).one()
    chain = await repo.ancestor_ids(db, folder.id)
    folder_out = await service.item_out(db, folder)
    assert folder_out.album is not None
    return AlbumDetailOut(
        folder=folder_out,
        album=folder_out.album,
        path=await service.crumbs(db, chain[:-1], rights.location),
        location_kind=rights.location.kind,  # type: ignore[arg-type]
        can_write=rights.can_write,
        items=await service.items_out(db, rows),
        next_cursor=next_cursor,
        folder_count=int(counts[0]),
        other_count=int(counts[1]),
        shared_above=await shares.shared_above(db, chain),
    )


# --- adding photos (§9) --------------------------------------------------------------------------


async def add(
    db: AsyncSession,
    actor: User,
    settings: Settings,
    blobs: BlobStore,
    folder_id: uuid.UUID,
    data: AlbumAddIn,
) -> tuple[AlbumAddOut, bool]:
    """(one result per source, attachments first, then items; whether any file was copied: the
    caller wakes the media and preview loops)."""
    actor_id = actor.id
    folder, rights = await service.readable_item(db, actor, folder_id)
    rights.require_write()
    if folder.kind != "folder" or await db.get(DriveAlbum, folder.id) is None:
        raise album_not_found()
    target_id, target_location = folder.id, folder.location_id
    results: dict[uuid.UUID, AlbumAddResult] = {}
    moves: list[uuid.UUID] = []  # items
    # item → its source ids (an attachment and the item itself may both name it)
    moved_from: dict[uuid.UUID, list[uuid.UUID]] = {}
    item_copies: list[uuid.UUID] = []
    copied_from: dict[uuid.UUID, list[uuid.UUID]] = {}
    attachment_copies: list[uuid.UUID] = []
    sources: list[uuid.UUID] = []

    for attachment_id in dict.fromkeys(data.attachment_ids):
        sources.append(attachment_id)
        try:
            source = await attachments.get_for_access(db, actor, attachment_id)
        except AppError as exc:
            code = "attachment_not_found" if exc.status in (403, 404) else exc.code
            results[attachment_id] = AlbumAddResult(source_id=attachment_id, ok=False, error=code)
            continue
        if source.status != "attached" or (
            source.drive_item_id is not None and source.drive_state is None
        ):
            # A pending upload, or a drive version itself (added by its item_id).
            results[attachment_id] = AlbumAddResult(
                source_id=attachment_id, ok=False, error="attachment_not_found"
            )
            continue
        posted_item = (
            await repo.item(db, source.drive_item_id)
            if source.drive_state == "available" and source.drive_item_id is not None
            else None
        )
        if posted_item is not None and posted_item.trashed_at is None:
            same = posted_item.location_id == target_location
            if data.mode == "move" or (data.mode == "auto" and same):
                moves.append(posted_item.id)
                moved_from.setdefault(posted_item.id, []).append(attachment_id)
                continue
        attachment_copies.append(attachment_id)

    for item_id in dict.fromkeys(data.item_ids):
        sources.append(item_id)
        try:
            item, _ = await service.readable_item(db, actor, item_id)
        except AppError as exc:
            results[item_id] = AlbumAddResult(source_id=item_id, ok=False, error=exc.code)
            continue
        same = item.location_id == target_location
        if data.mode == "move" or (data.mode == "auto" and same):
            moves.append(item.id)
            moved_from.setdefault(item.id, []).append(item_id)
        else:
            item_copies.append(item.id)
            copied_from.setdefault(item.id, []).append(item_id)
    await db.commit()

    woke = False
    if moves:
        actor = await _actor(db, actor_id)
        moved = await service.move(
            db, actor, settings, list(dict.fromkeys(moves)), target_id, "rename"
        )
        for result in moved.results:
            for source_id in moved_from[result.id]:
                results[source_id] = AlbumAddResult(
                    source_id=source_id,
                    ok=result.ok,
                    error=result.error,
                    item_id=result.id if result.ok else None,
                    action="moved" if result.ok else None,
                )
    if item_copies:
        actor = await _actor(db, actor_id)
        copied, any_copied = await copying.copy(
            db,
            actor,
            settings,
            blobs,
            DriveCopyIn(
                item_ids=item_copies,
                target_folder_id=target_id,
                on_conflict="rename",
                client_op_id=data.client_op_id,
            ),
        )
        woke = woke or any_copied
        for copy_result in copied.results:
            for source_id in copied_from[copy_result.id]:
                results[source_id] = AlbumAddResult(
                    source_id=source_id,
                    ok=copy_result.ok,
                    error=copy_result.error,
                    item_id=copy_result.new_id,
                    action="copied" if copy_result.ok else None,
                )
    for attachment_id in attachment_copies:
        actor = await _actor(db, actor_id)
        try:
            saved, created = await conversation.save_attachment(
                db,
                actor,
                settings,
                blobs,
                DriveSaveAttachmentIn(
                    attachment_id=attachment_id,
                    folder_id=target_id,
                    on_conflict="rename",
                    client_op_id=data.client_op_id,
                ),
            )
        except AppError as exc:
            await db.rollback()
            results[attachment_id] = AlbumAddResult(
                source_id=attachment_id, ok=False, error=exc.code
            )
            continue
        woke = woke or created
        results[attachment_id] = AlbumAddResult(
            source_id=attachment_id, ok=True, item_id=saved.id, action="copied"
        )
    return AlbumAddOut(results=[results[source] for source in sources]), woke


async def _actor(db: AsyncSession, actor_id: uuid.UUID) -> User:
    """The actor again after a commit or a rollback of an earlier step (reloaded if expired)."""
    found = await db.get(User, actor_id)
    if found is None:
        raise item_not_found()
    return found
