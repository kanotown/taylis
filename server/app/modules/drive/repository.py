"""The drive's SQL (docs/DRIVE.md §4.2): trees by recursive CTE (at most 32 levels), locks in id
order, the children's keyset pages."""

import uuid
from collections.abc import Sequence

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attachments.models import Attachment
from app.modules.drive.models import (
    DriveFileVersion,
    DriveItem,
    DriveLocation,
    DriveUpload,
)

# Deeper than MAX_DEPTH on purpose: a walk that went past it found a broken tree, not a deep one.
_WALK_LIMIT = 40

_ANCESTORS = text(
    """
    WITH RECURSIVE up(id, parent_id, steps) AS (
        SELECT id, parent_id, 0 FROM drive_items WHERE id = :id
        UNION ALL
        SELECT i.id, i.parent_id, up.steps + 1
        FROM drive_items i JOIN up ON i.id = up.parent_id
        WHERE up.steps < :limit
    )
    SELECT id FROM up ORDER BY steps DESC
    """
)

_SUBTREE = text(
    """
    WITH RECURSIVE down(id, steps) AS (
        SELECT id, 0 FROM drive_items WHERE id = :id
        UNION ALL
        SELECT i.id, down.steps + 1
        FROM drive_items i JOIN down ON i.parent_id = down.id
        WHERE down.steps < :limit
    )
    SELECT id, steps FROM down
    """
)


async def location(
    db: AsyncSession, location_id: uuid.UUID, *, for_update: bool = False
) -> DriveLocation | None:
    if for_update:
        return await db.get(
            DriveLocation, location_id, with_for_update=True, populate_existing=True
        )
    return await db.get(DriveLocation, location_id)


async def workspace_location(db: AsyncSession) -> DriveLocation | None:
    stmt = select(DriveLocation).where(DriveLocation.kind == "workspace")
    return (await db.execute(stmt)).scalar_one_or_none()


async def location_of_channel(db: AsyncSession, channel_id: uuid.UUID) -> DriveLocation | None:
    stmt = select(DriveLocation).where(DriveLocation.channel_id == channel_id)
    return (await db.execute(stmt)).scalar_one_or_none()


async def location_of_user(db: AsyncSession, user_id: uuid.UUID) -> DriveLocation | None:
    stmt = select(DriveLocation).where(DriveLocation.user_id == user_id)
    return (await db.execute(stmt)).scalar_one_or_none()


async def channel_locations(
    db: AsyncSession, channel_ids: Sequence[uuid.UUID]
) -> list[DriveLocation]:
    if not channel_ids:
        return []
    stmt = (
        select(DriveLocation)
        .where(DriveLocation.channel_id.in_(list(channel_ids)))
        .order_by(DriveLocation.created_at)
    )
    return list((await db.execute(stmt)).scalars().all())


async def item(
    db: AsyncSession, item_id: uuid.UUID, *, for_update: bool = False
) -> DriveItem | None:
    if for_update:
        return await db.get(DriveItem, item_id, with_for_update=True, populate_existing=True)
    return await db.get(DriveItem, item_id)


async def lock_items(db: AsyncSession, ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, DriveItem]:
    """FOR UPDATE in id order (two requests locking the same folders never deadlock)."""
    wanted = sorted(set(ids))
    if not wanted:
        return {}
    stmt = (
        select(DriveItem)
        .where(DriveItem.id.in_(wanted))
        .order_by(DriveItem.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    return {row.id: row for row in (await db.execute(stmt)).scalars().all()}


async def items(db: AsyncSession, ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, DriveItem]:
    if not ids:
        return {}
    stmt = select(DriveItem).where(DriveItem.id.in_(list(set(ids))))
    return {row.id: row for row in (await db.execute(stmt)).scalars().all()}


async def ancestor_ids(db: AsyncSession, item_id: uuid.UUID) -> list[uuid.UUID]:
    """The item's chain from its root down to itself."""
    rows = await db.execute(_ANCESTORS, {"id": item_id, "limit": _WALK_LIMIT})
    return [row[0] for row in rows.all()]


async def subtree(db: AsyncSession, item_id: uuid.UUID) -> list[tuple[uuid.UUID, int]]:
    """(id, steps below the item) of the item and everything under it, the trash included."""
    rows = await db.execute(_SUBTREE, {"id": item_id, "limit": _WALK_LIMIT})
    return [(row[0], int(row[1])) for row in rows.all()]


async def child_by_key(db: AsyncSession, parent_id: uuid.UUID, name_key: str) -> DriveItem | None:
    stmt = select(DriveItem).where(
        DriveItem.parent_id == parent_id,
        DriveItem.name_key == name_key,
        DriveItem.trashed_at.is_(None),
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def child_keys(db: AsyncSession, parent_id: uuid.UUID, prefix_key: str) -> set[str]:
    """The keys of the live children whose key starts like `prefix_key` (for 「名前 (n)」)."""
    escaped = prefix_key.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    stmt = select(DriveItem.name_key).where(
        DriveItem.parent_id == parent_id,
        DriveItem.trashed_at.is_(None),
        DriveItem.name_key.like(f"{escaped}%", escape="\\"),
    )
    return set((await db.execute(stmt)).scalars().all())


async def count_children(db: AsyncSession, parent_id: uuid.UUID) -> int:
    stmt = (
        select(func.count())
        .select_from(DriveItem)
        .where(DriveItem.parent_id == parent_id, DriveItem.trashed_at.is_(None))
    )
    return int((await db.execute(stmt)).scalar_one())


async def bump_seq(db: AsyncSession, ids: Sequence[uuid.UUID]) -> None:
    if ids:
        await db.execute(
            update(DriveItem)
            .where(DriveItem.id.in_(list(ids)))
            .values(change_seq=text("nextval('drive_change_seq')"))
            .execution_options(synchronize_session=False)
        )


async def versions_bytes(db: AsyncSession, item_ids: Sequence[uuid.UUID]) -> int:
    if not item_ids:
        return 0
    stmt = select(func.coalesce(func.sum(DriveFileVersion.size_bytes), 0)).where(
        DriveFileVersion.item_id.in_(list(item_ids))
    )
    return int((await db.execute(stmt)).scalar_one())


async def versions_of(db: AsyncSession, item_ids: Sequence[uuid.UUID]) -> list[DriveFileVersion]:
    if not item_ids:
        return []
    stmt = select(DriveFileVersion).where(DriveFileVersion.item_id.in_(list(item_ids)))
    return list((await db.execute(stmt)).scalars().all())


async def current_files(
    db: AsyncSession, version_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, tuple[DriveFileVersion, Attachment]]:
    """{version id: (version, its attachment)}."""
    if not version_ids:
        return {}
    stmt = (
        select(DriveFileVersion, Attachment)
        .join(Attachment, Attachment.id == DriveFileVersion.attachment_id)
        .where(DriveFileVersion.id.in_(list(version_ids)))
    )
    return {v.id: (v, a) for v, a in (await db.execute(stmt)).all()}


async def version_counts(db: AsyncSession, item_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not item_ids:
        return {}
    stmt = (
        select(DriveFileVersion.item_id, func.count())
        .where(DriveFileVersion.item_id.in_(list(item_ids)))
        .group_by(DriveFileVersion.item_id)
    )
    return {row[0]: int(row[1]) for row in (await db.execute(stmt)).all()}


async def next_version_number(db: AsyncSession, item_id: uuid.UUID) -> int:
    stmt = select(func.coalesce(func.max(DriveFileVersion.number), 0)).where(
        DriveFileVersion.item_id == item_id
    )
    return int((await db.execute(stmt)).scalar_one()) + 1


async def reserved_bytes(db: AsyncSession, location_id: uuid.UUID | None) -> int:
    """The declared sizes of the sessions still under way (in one location, or everywhere)."""
    stmt = select(func.coalesce(func.sum(DriveUpload.size_bytes), 0)).where(
        DriveUpload.status.in_(("active", "completing"))
    )
    if location_id is not None:
        stmt = stmt.where(DriveUpload.location_id == location_id)
    return int((await db.execute(stmt)).scalar_one())


async def total_used(db: AsyncSession) -> int:
    stmt = select(func.coalesce(func.sum(DriveLocation.used_bytes), 0))
    return int((await db.execute(stmt)).scalar_one())
