"""Posted files as the drive sees them (CF1, docs/CHANNEL_FILES.md §5, §6.4-§6.5, §7.5).

A file posted in a public or private channel is one `attachments` row that is both the message's
attachment and version 1 of an item in the channel's drive (channel_files.py files it). This
module holds what the drive's own operations need of that, without the drive importing the
messages:

- who reads a posted file through its message (`posted_readable`, attachments.get_for_access's
  second way in, injected by main.py);
- `attachments.drive_state` kept in step with the item (`restate_in_tx` after a move across
  locations, a trash, a restore; `purge_posted_in_tx` when the item is purged), each change
  announced as the message's `message.updated` (change "attachments") through the announcer
  main.py hands over (messages.service.announce_change_by_id_in_tx);
- the messages a file's versions are attached to (`posts_of`, `posted_items`, `posted_versions`).

Locks: the caller holds the drive's rows (folders, then locations); here the channels are locked
in id order, then the attachments rows, then the messages take their seq (the channel rows are
already ours). A send takes the same order (channel_files.prepare_in_tx locks the drive before the
message's seq), and so do a message's delete and the preview loop (channel, then attachment).
"""

import logging
import uuid
from collections.abc import Awaitable, Callable, Iterable, Sequence
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, conflict
from app.core.time import utcnow
from app.modules.attachments.models import Attachment
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.drive.models import DriveFileVersion, DriveItem, DriveLocation
from app.modules.drive.schemas import DrivePostOut
from app.modules.messages.models import Message
from app.modules.users.models import User

log = logging.getLogger("app.drive.posted")

SYSTEM_ROLE = "channel_posts"
# The states in which the row is still a drive version (a tombstone is 'deleted').
LIVE_STATES = ("available", "moved", "trashed")
POSTS_SHOWN = 5
_CHUNK = 5000

# messages.service.announce_change_by_id_in_tx (set by main.py): a new updated_seq and
# message.updated for the message; None when it is deleted.
Announce = Callable[[AsyncSession, uuid.UUID, str], Awaitable[Any]]
_announce: Announce | None = None


def set_announcer(announce: Announce | None) -> None:
    global _announce
    _announce = announce


def folder_system() -> AppError:
    return conflict(
        "drive_folder_system", "This folder is kept by the server and cannot be changed"
    )


def version_posted(message_id: uuid.UUID, channel_id: uuid.UUID | None) -> AppError:
    details: dict[str, Any] = {"message_id": str(message_id)}
    if channel_id is not None:
        details["channel_id"] = str(channel_id)
    return conflict("drive_version_posted", "A message shows this version", details)


def _chunks(ids: Sequence[uuid.UUID]) -> Iterable[list[uuid.UUID]]:
    wanted = list(dict.fromkeys(ids))
    for start in range(0, len(wanted), _CHUNK):
        yield wanted[start : start + _CHUNK]


# --- reading ----------------------------------------------------------------------------------


async def posted_readable(db: AsyncSession, actor: User, attachment: Attachment) -> bool:
    """§5.1 rule 2: the message is not deleted and the actor can read it now (its members; in a
    public channel anyone but a guest, M27), and the item is in that channel's drive, outside the
    trash (the trash marks every row of a group, so the item's own mark is enough). False when
    the file is not the message's any more (404 for everyone the drive does not let in); the
    channel's own refusal (403) is raised as it is for a plain attachment."""
    if (
        attachment.message_id is None
        or attachment.drive_item_id is None
        or attachment.drive_state is None
    ):
        return False
    message = await db.get(Message, attachment.message_id)
    if message is None or message.deleted_at is not None:
        return False
    item = await db.get(DriveItem, attachment.drive_item_id)
    if item is None or item.trashed_at is not None:
        return False
    location = await db.get(DriveLocation, item.location_id)
    if location is None or location.deleted_at is not None:
        return False
    if location.kind != "channel" or location.channel_id != message.channel_id:
        return False
    # As for any attachment of the channel: its 403 (not_a_member, preview_disabled) stands, so
    # a posted file answers what an attachment answered before CF1.
    await channels.require_readable(db, actor, message.channel_id)
    return True


async def posted_items(db: AsyncSession, item_ids: Sequence[uuid.UUID]) -> set[uuid.UUID]:
    """The items among these with a version attached to a message (DriveItemOut.posted)."""
    found: set[uuid.UUID] = set()
    for chunk in _chunks(item_ids):
        rows = await db.execute(
            select(Attachment.drive_item_id)
            .where(Attachment.drive_item_id.in_(chunk), Attachment.drive_state.in_(LIVE_STATES))
            .distinct()
        )
        found.update(i for i in rows.scalars().all() if i is not None)
    return found


async def posted_versions(
    db: AsyncSession, version_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, tuple[uuid.UUID, uuid.UUID]]:
    """{version id: (message id, channel id)} of the versions a message shows (§4.2: never
    removed by the retention, never deleted by hand)."""
    if not version_ids:
        return {}
    rows = await db.execute(
        select(DriveFileVersion.id, Attachment.message_id, Attachment.channel_id)
        .join(Attachment, Attachment.id == DriveFileVersion.attachment_id)
        .where(
            DriveFileVersion.id.in_(list(version_ids)),
            Attachment.drive_state.in_(LIVE_STATES),
            Attachment.message_id.is_not(None),
        )
    )
    return {
        row[0]: (row[1], row[2]) for row in rows.all() if row[1] is not None and row[2] is not None
    }


async def posts_of(db: AsyncSession, actor: User, item_id: uuid.UUID) -> list[DrivePostOut]:
    """The messages (not deleted) that show a version of the item, newest first, those the
    actor can read now, at most POSTS_SHOWN."""
    rows = (
        await db.execute(
            select(Message, DriveFileVersion.number, Attachment.attached_at)
            .join(Attachment, Attachment.message_id == Message.id)
            .join(DriveFileVersion, DriveFileVersion.attachment_id == Attachment.id)
            .where(
                Attachment.drive_item_id == item_id,
                Attachment.drive_state.in_(LIVE_STATES),
                Message.deleted_at.is_(None),
            )
            .order_by(Message.created_at.desc(), Message.id.desc())
            .limit(50)
        )
    ).all()
    out: list[DrivePostOut] = []
    readable: dict[uuid.UUID, bool] = {}
    for message, number, attached_at in rows:
        if message.channel_id not in readable:
            try:
                await channels.require_readable(db, actor, message.channel_id)
                readable[message.channel_id] = True
            except AppError:
                readable[message.channel_id] = False
        if not readable[message.channel_id]:
            continue
        out.append(
            DrivePostOut(
                message_id=message.id,
                channel_id=message.channel_id,
                parent_id=message.parent_id,
                sender_id=message.sender_id,
                version_number=int(number),
                posted_at=attached_at or message.created_at,
            )
        )
        if len(out) >= POSTS_SHOWN:
            break
    return out


# --- keeping drive_state in step ----------------------------------------------------------------


async def _channel_locations(
    db: AsyncSession, channel_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, uuid.UUID]:
    wanted = list(set(channel_ids))
    if not wanted:
        return {}
    rows = await db.execute(
        select(DriveLocation.channel_id, DriveLocation.id).where(
            DriveLocation.channel_id.in_(wanted)
        )
    )
    return {row[0]: row[1] for row in rows.all() if row[0] is not None}


async def _item_places(
    db: AsyncSession, item_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, tuple[uuid.UUID, bool]]:
    """{item id: (location id, in the trash)} as the database has them now (the drive's bulk
    updates leave the session's copies stale)."""
    out: dict[uuid.UUID, tuple[uuid.UUID, bool]] = {}
    for chunk in _chunks(list(item_ids)):
        rows = await db.execute(
            select(DriveItem.id, DriveItem.location_id, DriveItem.trashed_at).where(
                DriveItem.id.in_(chunk)
            )
        )
        out.update({row[0]: (row[1], row[2] is not None) for row in rows.all()})
    return out


def state_for(place: tuple[uuid.UUID, bool], channel_location: uuid.UUID | None) -> str:
    location_id, trashed = place
    if trashed:
        return "trashed"
    return "available" if location_id == channel_location else "moved"


async def lock_channels(db: AsyncSession, channel_ids: Iterable[uuid.UUID]) -> None:
    wanted = sorted(set(channel_ids))
    if wanted:
        await db.execute(
            select(Channel.id).where(Channel.id.in_(wanted)).order_by(Channel.id).with_for_update()
        )


async def announce(db: AsyncSession, message_ids: Iterable[uuid.UUID]) -> None:
    if _announce is None:
        return
    for message_id in sorted(set(message_ids)):
        await _announce(db, message_id, "attachments")


async def restate_in_tx(
    db: AsyncSession,
    item_ids: Sequence[uuid.UUID],
    *,
    skip_message_id: uuid.UUID | None = None,
) -> list[tuple[uuid.UUID, uuid.UUID]]:
    """After the items moved, went to the trash or came back (the caller holds their folders
    and has flushed): each posted file among them takes the state its item now gives it, and
    each message whose file changed gets message.updated. Returns (item id, message id) of the
    rows that changed. `skip_message_id`: a message being deleted (its rows are taken off it
    right after)."""
    if not item_ids:
        return []
    candidates: list[tuple[uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID, str]] = []
    for chunk in _chunks(item_ids):
        rows = await db.execute(
            select(
                Attachment.id,
                Attachment.drive_item_id,
                Attachment.message_id,
                Attachment.channel_id,
                Attachment.drive_state,
            ).where(Attachment.drive_item_id.in_(chunk), Attachment.drive_state.in_(LIVE_STATES))
        )
        candidates.extend(
            (r[0], r[1], r[2], r[3], r[4] or "")
            for r in rows.all()
            if r[1] is not None and r[2] is not None and r[3] is not None
        )
    candidates = [c for c in candidates if c[2] != skip_message_id]
    if not candidates:
        return []
    places = await _item_places(db, {c[1] for c in candidates})
    homes = await _channel_locations(db, {c[3] for c in candidates})
    changing = [
        c for c in candidates if c[1] in places and state_for(places[c[1]], homes.get(c[3])) != c[4]
    ]
    if not changing:
        return []
    await lock_channels(db, {c[3] for c in changing})
    locked = (
        (
            await db.execute(
                select(Attachment)
                .where(Attachment.id.in_(sorted(c[0] for c in changing)))
                .order_by(Attachment.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    changed: list[tuple[uuid.UUID, uuid.UUID]] = []
    for row in locked:
        # Again under the lock: a delete of the message may have taken it off meanwhile.
        if (
            row.drive_state not in LIVE_STATES
            or row.drive_item_id is None
            or row.message_id is None
            or row.channel_id is None
            or row.drive_item_id not in places
        ):
            continue
        wanted = state_for(places[row.drive_item_id], homes.get(row.channel_id))
        if wanted != row.drive_state:
            row.drive_state = wanted
            changed.append((row.drive_item_id, row.message_id))
    await db.flush()
    await announce(db, [m for _, m in changed])
    return changed


async def purge_posted_in_tx(
    db: AsyncSession, attachment_ids: Sequence[uuid.UUID]
) -> list[uuid.UUID]:
    """§7.5: the versions are purged with their item. A posted one becomes a tombstone
    (drive_state 'deleted', status 'deleted'; the GC removes its bytes and keeps the row as
    'purged' while the message is alive). Returns the messages to announce once the items are
    gone (the caller calls `announce`)."""
    if not attachment_ids:
        return []
    found: list[tuple[uuid.UUID, uuid.UUID]] = []
    for chunk in _chunks(attachment_ids):
        rows = await db.execute(
            select(Attachment.id, Attachment.channel_id).where(
                Attachment.id.in_(chunk),
                Attachment.drive_state.in_(LIVE_STATES),
                Attachment.message_id.is_not(None),
            )
        )
        found.extend((r[0], r[1]) for r in rows.all() if r[1] is not None)
    if not found:
        return []
    await lock_channels(db, {c for _, c in found})
    now = utcnow()
    messages: list[uuid.UUID] = []
    rows_locked = (
        (
            await db.execute(
                select(Attachment)
                .where(Attachment.id.in_(sorted(i for i, _ in found)))
                .order_by(Attachment.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    for row in rows_locked:
        if row.drive_state not in LIVE_STATES or row.message_id is None:
            continue
        row.drive_state = "deleted"
        row.status = "deleted"
        row.deleted_at = now
        messages.append(row.message_id)
    await db.flush()
    return messages


async def count_live(db: AsyncSession, item_ids: Sequence[uuid.UUID]) -> int:
    total = 0
    for chunk in _chunks(item_ids):
        total += int(
            (
                await db.execute(
                    select(func.count())
                    .select_from(Attachment)
                    .where(
                        Attachment.drive_item_id.in_(chunk),
                        Attachment.drive_state.in_(LIVE_STATES),
                    )
                )
            ).scalar_one()
        )
    return total
