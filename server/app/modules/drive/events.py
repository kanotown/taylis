"""The drive's events (docs/DRIVE.md §14, SYNC_PROTOCOL.md §18) and the outbox audience `drive`.

drive.changed carries ids and a number only (no names): the clients re-read the folders they have
open. Its audience `drive` is the location's id, resolved when the relay sends it from who can read
the location then (研究室ドライブ: the people who are not guests or bots; a channel's drive: its
members; My Drive: its owner), so someone who just lost access never gets it.
drive.upload.updated goes to the uploader (a completion that finished in the background, an
expired session).
"""

import uuid
from collections.abc import Iterable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.envelope import Audience
from app.events.models import OutboxEvent
from app.events.outbox import AudienceResolver, write_outbox
from app.modules.drive import access
from app.modules.drive.models import DriveItem, DriveLocation
from app.modules.drive.schemas import DriveChangedData, DriveUploadOut, DriveUploadUpdatedData

DRIVE_CHANGED = "drive.changed"
DRIVE_UPLOAD_UPDATED = "drive.upload.updated"

__all__ = [
    "DRIVE_CHANGED",
    "DRIVE_UPLOAD_UPDATED",
    "DriveChangedData",
    "DriveUploadUpdatedData",
]


async def next_seq(db: AsyncSession) -> int:
    return int((await db.execute(text("SELECT nextval('drive_change_seq')"))).scalar_one())


async def emit_changed(
    db: AsyncSession, location_id: uuid.UUID, folder_ids: Iterable[uuid.UUID | None]
) -> None:
    ids = sorted({i for i in folder_ids if i is not None})
    await write_outbox(
        db,
        event_type=DRIVE_CHANGED,
        audience_type="drive",
        audience_id=location_id,
        payload=DriveChangedData(
            location_id=location_id, folder_ids=ids, seq=await next_seq(db)
        ).model_dump(mode="json"),
    )


async def emit_upload_updated(db: AsyncSession, user_id: uuid.UUID, upload: DriveUploadOut) -> None:
    await write_outbox(
        db,
        event_type=DRIVE_UPLOAD_UPDATED,
        audience_type="user",
        audience_id=user_id,
        payload=DriveUploadUpdatedData(upload=upload).model_dump(mode="json"),
    )


async def resolve_drive_audience(db: AsyncSession, event: OutboxEvent) -> Audience | None:
    if event.audience_type != "drive" or event.audience_id is None:
        return None
    location = await db.get(DriveLocation, event.audience_id)
    if location is None:
        return Audience(kind="users", ids=())
    return Audience(kind="users", ids=tuple(await access.readers(db, location)))


def audience_resolver(fallback: AudienceResolver) -> AudienceResolver:
    """The relay's resolver: drive events here, everything else as before."""

    async def resolve(db: AsyncSession, event: OutboxEvent) -> Audience:
        audience = await resolve_drive_audience(db, event)
        if audience is not None:
            return audience
        return await fallback(db, event)

    return resolve


async def media_changed_in_tx(db: AsyncSession, item_id: uuid.UUID) -> None:
    """A file's thumbnail, poster or preview changed (the preview loop's hook, set by main.py):
    its folder is re-read."""
    item = await db.get(DriveItem, item_id)
    if item is not None and item.trashed_at is None:
        await emit_changed(db, item.location_id, [item.parent_id])
