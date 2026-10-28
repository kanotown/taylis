"""The drive's usage and quotas for administrators (docs/DRIVE.md §11, phase D3), and the check of
the counters (`app.cli drive-usage --verify / --rebuild`).

What is shown: sizes and counts, the locations' names (a channel's name, a person's display name),
never anything inside a location. A location's `used_bytes` and `item_count` are kept in the
transactions that change them (§4.2); the split into current versions, older versions and the trash
is summed from the versions when the screen asks (a few hundred thousand rows at most).
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments.models import Attachment
from app.modules.audit import service as audit
from app.modules.channels.models import Channel
from app.modules.drive import events, service
from app.modules.drive import repository as repo
from app.modules.drive.access import WORKSPACE_NAME, item_not_found
from app.modules.drive.models import DriveFileVersion, DriveLocation
from app.modules.drive.schemas import (
    DriveLocationUsageOut,
    DrivePersonUsageOut,
    DriveUsageOut,
    DriveUsageTotalOut,
)
from app.modules.users.models import User

_SPLIT = text(
    """
    SELECT i.location_id,
           coalesce(sum(v.size_bytes) FILTER (
               WHERE i.trashed_at IS NULL AND v.id = i.current_version_id), 0),
           coalesce(sum(v.size_bytes) FILTER (
               WHERE i.trashed_at IS NULL AND v.id <> i.current_version_id), 0),
           coalesce(sum(v.size_bytes) FILTER (WHERE i.trashed_at IS NOT NULL), 0),
           coalesce(sum(v.size_bytes) FILTER (WHERE v.source = 'message'), 0)
    FROM drive_file_versions v JOIN drive_items i ON i.id = v.item_id
    GROUP BY i.location_id
    """
)

_ACTUAL = text(
    """
    SELECT l.id, l.used_bytes, l.item_count,
           coalesce((SELECT sum(v.size_bytes) FROM drive_file_versions v
                     JOIN drive_items i ON i.id = v.item_id WHERE i.location_id = l.id), 0),
           (SELECT count(*) FROM drive_items i
            WHERE i.location_id = l.id AND i.parent_id IS NOT NULL)
    FROM drive_locations l
    ORDER BY l.id
    """
)

_ACTUAL_ONE = text(
    """
    SELECT coalesce((SELECT sum(v.size_bytes) FROM drive_file_versions v
                     JOIN drive_items i ON i.id = v.item_id WHERE i.location_id = :id), 0),
           (SELECT count(*) FROM drive_items i
            WHERE i.location_id = :id AND i.parent_id IS NOT NULL)
    """
)


def effective_quota(location: DriveLocation, settings: Settings) -> int | None:
    if location.quota_bytes is not None:
        return location.quota_bytes
    return settings.drive_user_default_quota_bytes if location.kind == "user" else None


async def _names(
    db: AsyncSession, rows: list[DriveLocation]
) -> tuple[dict[uuid.UUID, Channel], dict[uuid.UUID, User]]:
    channel_ids = [r.channel_id for r in rows if r.channel_id is not None]
    user_ids = [r.user_id for r in rows if r.user_id is not None]
    channels: dict[uuid.UUID, Channel] = {}
    users: dict[uuid.UUID, User] = {}
    if channel_ids:
        found = await db.execute(select(Channel).where(Channel.id.in_(channel_ids)))
        channels = {c.id: c for c in found.scalars()}
    if user_ids:
        people = await db.execute(select(User).where(User.id.in_(user_ids)))
        users = {u.id: u for u in people.scalars()}
    return channels, users


def _location_out(
    location: DriveLocation,
    settings: Settings,
    split: tuple[int, int, int, int],
    channels: dict[uuid.UUID, Channel],
    users: dict[uuid.UUID, User],
) -> DriveLocationUsageOut:
    name = WORKSPACE_NAME
    archived = False
    if location.kind == "channel" and location.channel_id is not None:
        channel = channels.get(location.channel_id)
        name = (channel.name if channel is not None else None) or ""
        archived = channel is not None and channel.is_archived
    elif location.kind == "user" and location.user_id is not None:
        user = users.get(location.user_id)
        name = (user.display_name or user.username) if user is not None else ""
        archived = user is not None and not user.is_active
    return DriveLocationUsageOut(
        id=location.id,
        kind=location.kind,  # type: ignore[arg-type]
        channel_id=location.channel_id,
        user_id=location.user_id,
        name=name,
        archived=archived,
        used_bytes=location.used_bytes,
        item_count=location.item_count,
        quota_bytes=location.quota_bytes,
        effective_quota_bytes=effective_quota(location, settings),
        updated_at=location.updated_at,
        current_bytes=split[0],
        old_versions_bytes=split[1],
        trash_bytes=split[2],
        posted_bytes=split[3],
    )


async def usage(db: AsyncSession, settings: Settings) -> DriveUsageOut:
    await service.workspace_location(db)
    rows = list(
        (
            await db.execute(
                select(DriveLocation)
                .where(DriveLocation.deleted_at.is_(None))
                .order_by(DriveLocation.used_bytes.desc(), DriveLocation.id)
            )
        ).scalars()
    )
    splits = {
        r[0]: (int(r[1]), int(r[2]), int(r[3]), int(r[4])) for r in (await db.execute(_SPLIT)).all()
    }
    channels, users = await _names(db, rows)
    locations = [
        _location_out(row, settings, splits.get(row.id, (0, 0, 0, 0)), channels, users)
        for row in rows
    ]
    people_rows = (
        await db.execute(
            select(
                DriveFileVersion.uploaded_by,
                func.sum(DriveFileVersion.size_bytes),
                func.count(),
            )
            .where(DriveFileVersion.uploaded_by.is_not(None))
            .group_by(DriveFileVersion.uploaded_by)
            .order_by(func.sum(DriveFileVersion.size_bytes).desc())
            .limit(500)
        )
    ).all()
    chat = (
        await db.execute(
            select(func.count(), func.coalesce(func.sum(Attachment.size_bytes), 0)).where(
                # CF1: a posted file in a drive is counted there; a tombstone has no bytes.
                Attachment.drive_item_id.is_(None),
                Attachment.status.not_in(("deleted", "purged")),
            )
        )
    ).one()
    total = DriveUsageTotalOut(
        used_bytes=sum(loc.used_bytes for loc in locations),
        item_count=sum(loc.item_count for loc in locations),
        location_count=len(locations),
        current_bytes=sum(loc.current_bytes for loc in locations),
        old_versions_bytes=sum(loc.old_versions_bytes for loc in locations),
        trash_bytes=sum(loc.trash_bytes for loc in locations),
        total_quota_bytes=settings.drive_total_quota_bytes,
        user_default_quota_bytes=settings.drive_user_default_quota_bytes,
        chat_attachments_bytes=int(chat[1]),
        chat_attachment_count=int(chat[0]),
    )
    return DriveUsageOut(
        total=total,
        locations=locations,
        people=[
            DrivePersonUsageOut(user_id=r[0], bytes=int(r[1]), versions=int(r[2]))
            for r in people_rows
            if r[0] is not None
        ],
    )


async def set_quota(
    db: AsyncSession,
    actor: User,
    settings: Settings,
    location_id: uuid.UUID,
    quota_bytes: int | None,
) -> DriveLocationUsageOut:
    """§11.1: a location's own quota (null: none). Lowering it below the use is allowed: what is
    there stays, only adding is refused. Audited as drive.quota_changed."""
    location = await repo.location(db, location_id, for_update=True)
    if location is None or location.deleted_at is not None:
        raise item_not_found()
    before = location.quota_bytes
    location.quota_bytes = quota_bytes
    location.updated_at = utcnow()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="drive.quota_changed",
        target_type="drive_location",
        target_id=location.id,
        details={"kind": location.kind, "before": before, "after": quota_bytes},
    )
    await events.emit_location_updated(db, location.id)
    await db.commit()
    split = {
        r[0]: (int(r[1]), int(r[2]), int(r[3]), int(r[4])) for r in (await db.execute(_SPLIT)).all()
    }
    channels, users = await _names(db, [location])
    return _location_out(location, settings, split.get(location.id, (0, 0, 0, 0)), channels, users)


# --- app.cli drive-usage -------------------------------------------------------------------------


@dataclass
class Difference:
    location_id: uuid.UUID
    used_bytes: int
    actual_bytes: int
    item_count: int
    actual_items: int

    def __str__(self) -> str:
        return (
            f"{self.location_id}: used_bytes {self.used_bytes} (versions {self.actual_bytes}), "
            f"item_count {self.item_count} (items {self.actual_items})"
        )


async def verify(db: AsyncSession) -> list[Difference]:
    """The locations whose counters differ from their versions and items."""
    out: list[Difference] = []
    for row in (await db.execute(_ACTUAL)).all():
        found = Difference(row[0], int(row[1]), int(row[3]), int(row[2]), int(row[4]))
        if (found.used_bytes, found.item_count) != (found.actual_bytes, found.actual_items):
            out.append(found)
    return out


async def rebuild(db: AsyncSession) -> int:
    """The counters that differ, recomputed under each location's lock; the number changed."""
    changed = 0
    for difference in await verify(db):
        location = await repo.location(db, difference.location_id, for_update=True)
        if location is None:
            continue
        row = (await db.execute(_ACTUAL_ONE, {"id": location.id})).one()
        location.used_bytes, location.item_count = int(row[0]), int(row[1])
        location.updated_at = utcnow()
        changed += 1
    await db.flush()
    return changed
