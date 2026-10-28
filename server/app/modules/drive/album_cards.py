"""What an album shows of itself (AL1, docs/ALBUMS.md §4.1, §5, §10.4): counts, the range of
capture times, the cover and four thumbnails for a card, computed from the folder's direct
children when asked (an album holds at most names.MAX_CHILDREN items; drive_items_taken_idx).

The album's photos are the images and videos directly in its folder, outside the trash. Their
order (`order_by`): 「撮影日」 COALESCE(taken_at, content_modified_at, created_at), the name (the
sidebar's order) or when they were put there; the id breaks ties. The capture time is the photo's
own claim: it orders and labels, nothing else.
"""

import uuid
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attachments.models import Attachment
from app.modules.drive.models import DriveAlbum, DriveFileVersion, DriveItem
from app.modules.drive.schemas import AlbumCoverOut, AlbumOut, SharedAlbumOut

PREVIEWS = 4


def is_media() -> Any:
    """A file that an album shows as a photo or a video."""
    return and_(
        DriveItem.kind == "file",
        or_(DriveItem.content_type.like("image/%"), DriveItem.content_type.like("video/%")),
    )


def taken_column() -> Any:
    return func.coalesce(DriveItem.taken_at, DriveItem.content_modified_at, DriveItem.created_at)


def sort_column(sort: str) -> Any:
    if sort == "name":
        return DriveItem.name_sort
    if sort == "added":
        return DriveItem.created_at
    return taken_column()


def order_by(sort: str, order: str) -> list[Any]:
    column = sort_column(sort)
    if order == "desc":
        return [column.desc(), DriveItem.id.desc()]
    return [column.asc(), DriveItem.id.asc()]


async def album_rows(db: AsyncSession, folder_ids: list[uuid.UUID]) -> dict[uuid.UUID, DriveAlbum]:
    if not folder_ids:
        return {}
    rows = (
        await db.execute(select(DriveAlbum).where(DriveAlbum.folder_id.in_(folder_ids)))
    ).scalars()
    return {row.folder_id: row for row in rows}


async def _stats(db: AsyncSession, folder_ids: list[uuid.UUID]) -> dict[uuid.UUID, Any]:
    taken = taken_column()
    stmt = (
        select(
            DriveItem.parent_id,
            func.count().filter(DriveItem.content_type.like("image/%")),
            func.count().filter(DriveItem.content_type.like("video/%")),
            func.coalesce(func.sum(DriveItem.size_bytes), 0),
            func.min(taken),
            func.max(taken),
        )
        .where(DriveItem.parent_id.in_(folder_ids), DriveItem.trashed_at.is_(None), is_media())
        .group_by(DriveItem.parent_id)
    )
    return {row[0]: row for row in (await db.execute(stmt)).all()}


async def _firsts(
    db: AsyncSession, album: DriveAlbum, count: int
) -> list[tuple[uuid.UUID, uuid.UUID, bool]]:
    """(item, attachment, has a thumbnail) of the first `count` photos in the album's order."""
    stmt = (
        select(DriveItem.id, Attachment.id, Attachment.thumbnail_key.is_not(None))
        .join(DriveFileVersion, DriveFileVersion.id == DriveItem.current_version_id)
        .join(Attachment, Attachment.id == DriveFileVersion.attachment_id)
        .where(
            DriveItem.parent_id == album.folder_id,
            DriveItem.trashed_at.is_(None),
            is_media(),
        )
        .order_by(*order_by(album.sort, album.sort_order))
        .limit(count)
    )
    return [(row[0], row[1], bool(row[2])) for row in (await db.execute(stmt)).all()]


async def _chosen_cover(
    db: AsyncSession, album: DriveAlbum
) -> tuple[uuid.UUID, uuid.UUID, bool] | None:
    """The chosen cover while it is a live photo directly in the album."""
    if album.cover_item_id is None:
        return None
    row = (
        await db.execute(
            select(DriveItem.id, Attachment.id, Attachment.thumbnail_key.is_not(None))
            .join(DriveFileVersion, DriveFileVersion.id == DriveItem.current_version_id)
            .join(Attachment, Attachment.id == DriveFileVersion.attachment_id)
            .where(
                DriveItem.id == album.cover_item_id,
                DriveItem.parent_id == album.folder_id,
                DriveItem.trashed_at.is_(None),
                is_media(),
            )
        )
    ).first()
    return (row[0], row[1], bool(row[2])) if row is not None else None


async def outs(db: AsyncSession, rows: list[DriveAlbum]) -> dict[uuid.UUID, AlbumOut]:
    stats = await _stats(db, [row.folder_id for row in rows])
    out: dict[uuid.UUID, AlbumOut] = {}
    for album in rows:
        found = stats.get(album.folder_id)
        photos, videos, size, first, last = (
            (int(found[1]), int(found[2]), int(found[3]), found[4], found[5])
            if found is not None
            else (0, 0, 0, None, None)
        )
        firsts = await _firsts(db, album, PREVIEWS + 1) if found is not None else []
        cover = await _chosen_cover(db, album) or (firsts[0] if firsts else None)
        previews: list[uuid.UUID] = []
        for _, attachment_id, thumb in ([cover] if cover else []) + firsts:
            if thumb and attachment_id not in previews and len(previews) < PREVIEWS:
                previews.append(attachment_id)
        out[album.folder_id] = AlbumOut(
            folder_id=album.folder_id,
            description=album.description,
            cover=AlbumCoverOut(item_id=cover[0], attachment_id=cover[1]) if cover else None,
            cover_item_id=album.cover_item_id,
            sort=album.sort,  # type: ignore[arg-type]
            sort_order=album.sort_order,  # type: ignore[arg-type]
            starts_on=album.starts_on,
            ends_on=album.ends_on,
            taken_from=first,
            taken_to=last,
            photo_count=photos,
            video_count=videos,
            size_bytes=size,
            preview_attachment_ids=previews,
            created_by=album.created_by,
            created_at=album.created_at,
            updated_at=album.updated_at,
        )
    return out


async def for_folders(db: AsyncSession, folders: list[DriveItem]) -> dict[uuid.UUID, AlbumOut]:
    """The albums among these folders (DriveItemOut.album)."""
    rows = await album_rows(db, [row.id for row in folders if row.kind == "folder"])
    return await outs(db, list(rows.values())) if rows else {}


def shared(album: AlbumOut) -> SharedAlbumOut:
    return SharedAlbumOut(
        description=album.description,
        cover_item_id=album.cover.item_id if album.cover else None,
        sort=album.sort,
        sort_order=album.sort_order,
        starts_on=album.starts_on,
        ends_on=album.ends_on,
        taken_from=album.taken_from,
        taken_to=album.taken_to,
        photo_count=album.photo_count,
        video_count=album.video_count,
    )
