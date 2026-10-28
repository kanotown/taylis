"""Files posted in a channel live in the channel's drive (CF1, docs/CHANNEL_FILES.md).

- **Filing** (§6.1): when a message is sent in a public or private channel whose switch is on
  (§9), each attachment bound to it becomes version 1 of a new item in
  「投稿のファイル > 2026-10」 of the channel's drive — the same `attachments` row (one row, one
  object, counted once in the location's used_bytes, §3.1, §8). The drive is locked before the
  message takes its seq (`prepare_in_tx`, the order of every drive operation: folders, location,
  then channel and attachments, posted.py), the items are written right after the bind
  (`file_in_tx`). Both run in a savepoint: whatever goes wrong there (a full folder, a name, an
  unexpected error) leaves an ordinary attachment and a warning in the log; the send never fails
  because of the drive. The quota is not checked (§8).
- **A message deleted** (§7.3): `delete_rules` says, per posted file, whether the
  `drive_files=auto` rule puts it in the trash; `on_message_delete_in_tx` does it before the
  delete takes the channel (attachments.mark_deleted_in_tx then takes the rows off the message).
- **Impact** (§6.4, `POST /drive/items/impact`): what a move or a trash would do to messages.
- **Backfill** (§10, `app.cli channel-files-backfill`): earlier attachments, filed the same way
  without announcing anything (opt-in, per channel, no bytes copied).
"""

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, conflict
from app.core.ids import uuid7
from app.core.roles import has_capability
from app.core.time import utcnow
from app.modules.attachments.models import Attachment
from app.modules.attachments.schemas import AttachmentDriveOut
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.drive import access as acl
from app.modules.drive import events, names, posted, service
from app.modules.drive import repository as repo
from app.modules.drive.models import DriveFileVersion, DriveItem, DriveLocation
from app.modules.drive.posted import LIVE_STATES, SYSTEM_ROLE
from app.modules.drive.schemas import (
    DriveImpactChannelOut,
    DriveImpactIn,
    DriveImpactOut,
    DriveMessageFileOut,
    DriveMessageFilesOut,
)
from app.modules.messages.models import Message
from app.modules.users.models import User
from app.modules.workspace.models import WorkspaceSettings

log = logging.getLogger("app.drive.channel_files")

POSTS_FOLDER_NAME = "投稿のファイル"
# A posted file whose name the drive refuses (§3.3).
FALLBACK_NAME = "ファイル"
DriveFilesMode = Literal["auto", "keep", "trash"]

_zone = ZoneInfo("Asia/Tokyo")


def set_timezone(name: str) -> None:
    """CHANNEL_FILES_TZ (main.py and the CLI): the zone of the month folders."""
    global _zone
    _zone = ZoneInfo(name)


def zone() -> ZoneInfo:
    return _zone


def month_name(at: datetime) -> str:
    """「2026-10」: the month of `at` in the workspace's zone (names sort in time order)."""
    return f"{at.astimezone(_zone):%Y-%m}"


# --- the switch (§9) ----------------------------------------------------------------------------


async def workspace_default(db: AsyncSession) -> bool:
    value = (
        await db.execute(select(WorkspaceSettings.channel_files_to_drive))
    ).scalar_one_or_none()
    return True if value is None else bool(value)


async def enabled_for(db: AsyncSession, channel: Channel) -> bool:
    """Public and private channels only (a DM has no drive): the channel's own setting, else the
    workspace's."""
    if channel.type not in ("public", "private"):
        return False
    if channel.files_to_drive is not None:
        return bool(channel.files_to_drive)
    return await workspace_default(db)


# --- filing (§6.1) ------------------------------------------------------------------------------


@dataclass
class Plan:
    """The drive rows a send holds (locked) before taking its seq."""

    location_id: uuid.UUID
    root: DriveItem
    # None: 「投稿のファイル」 is made under the locked root.
    posts: DriveItem | None
    month_name: str
    # None: the month's folder is made under the locked 「投稿のファイル」.
    month: DriveItem | None


async def _posts_folder(db: AsyncSession, location_id: uuid.UUID) -> DriveItem | None:
    stmt = select(DriveItem).where(
        DriveItem.location_id == location_id,
        DriveItem.system_role == SYSTEM_ROLE,
        DriveItem.trashed_at.is_(None),
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def _lock_plan(db: AsyncSession, channel_id: uuid.UUID, month: str) -> Plan:
    """The folders top down (the root only when 「投稿のファイル」 is still to be made), then the
    location: the order of the drive's own changes (folders, then locations)."""
    location = await service.ensure_location(db, "channel", channel_id=channel_id)
    root = await repo.item(db, location.root_id)
    posts = await _posts_folder(db, location.id)
    if posts is None:
        root = (await repo.lock_items(db, [location.root_id])).get(location.root_id)
        posts = await _posts_folder(db, location.id)  # made by a send that held the root
    if root is None:
        raise RuntimeError("the channel's drive has no root")
    found: DriveItem | None = None
    if posts is not None:
        posts = (await repo.lock_items(db, [posts.id]))[posts.id]
        if posts.trashed_at is not None or posts.system_role != SYSTEM_ROLE:
            raise RuntimeError("「投稿のファイル」 changed while it was locked")
        existing = await repo.child_by_key(db, posts.id, names.key(month))
        if existing is not None:
            if existing.kind != "folder":
                raise conflict("drive_name_taken", "A file holds the month folder's name")
            found = (await repo.lock_items(db, [existing.id])).get(existing.id)
            if found is None or found.trashed_at is not None or found.parent_id != posts.id:
                raise RuntimeError("the month folder changed while it was locked")
    await service.lock_location(db, location.id)
    return Plan(location_id=location.id, root=root, posts=posts, month_name=month, month=found)


async def prepare_in_tx(
    db: AsyncSession, channel: Channel, attachment_ids: list[uuid.UUID]
) -> Plan | None:
    """Before a send takes its seq: None when its files stay out of the drive (no files, a DM,
    the switch off, or the drive could not be prepared)."""
    if not attachment_ids or not await enabled_for(db, channel):
        return None
    try:
        async with db.begin_nested():
            return await _lock_plan(db, channel.id, month_name(utcnow()))
    except Exception:
        log.warning(
            "channel files: the drive of channel %s could not be prepared; "
            "the files are sent as plain attachments",
            channel.id,
            exc_info=True,
        )
        return None


def file_name(raw: str) -> str:
    """The attachment's name as a drive name (§3.3): NFC, at most 255 characters; a name the
    drive refuses becomes 「ファイル」 with the original's extension when that is a good name."""
    try:
        return names.normalize(raw)
    except AppError:
        dot = raw.rfind(".")
        ext = raw[dot:] if 0 < dot and 1 < len(raw) - dot <= 20 else ""
        try:
            return names.normalize(FALLBACK_NAME + ext)
        except AppError:
            return FALLBACK_NAME


async def _file(
    db: AsyncSession, plan: Plan, sender: User, rows: list[Attachment]
) -> dict[uuid.UUID, AttachmentDriveOut]:
    changed: list[uuid.UUID] = []
    made = 0
    posts = plan.posts
    if posts is None:
        name = await service.free_name(db, plan.root.id, POSTS_FOLDER_NAME, is_file=False)
        posts = await service.new_folder_in_tx(db, sender, plan.root, name)
        posts.system_role = SYSTEM_ROLE
        made += 1
        changed.append(plan.root.id)
    month = plan.month
    if month is None:
        existing = await repo.child_by_key(db, posts.id, names.key(plan.month_name))
        if existing is not None:
            raise conflict("drive_name_taken", "A file holds the month folder's name")
        month = await service.new_folder_in_tx(db, sender, posts, plan.month_name)
        made += 1
        changed.append(posts.id)
    await service.require_room(db, month.id, len(rows))
    out: dict[uuid.UUID, AttachmentDriveOut] = {}
    total = 0
    for attachment in rows:
        at = attachment.attached_at or utcnow()
        name = await service.free_name(db, month.id, file_name(attachment.filename), is_file=True)
        version_id = uuid7()
        item = DriveItem(
            id=uuid7(),
            location_id=plan.location_id,
            parent_id=month.id,
            kind="file",
            current_version_id=version_id,
            size_bytes=attachment.size_bytes,
            content_type=attachment.content_type,
            created_by=attachment.uploader_id,
            created_at=at,
            updated_by=attachment.uploader_id,
            updated_at=at,
            change_seq=await events.next_seq(db),
        )
        service.set_name(item, name)
        db.add(item)
        await db.flush()
        # The upload already read it (SHA-256, thumbnail, poster): the media loop has nothing to
        # do, unless an old upload has no SHA-256. The text loop (§29) reads it as any current
        # version.
        processed = attachment.sha256 is not None
        db.add(
            DriveFileVersion(
                id=version_id,
                item_id=item.id,
                number=1,
                attachment_id=attachment.id,
                size_bytes=attachment.size_bytes,
                sha256=attachment.sha256,
                content_modified_at=None,
                uploaded_by=attachment.uploader_id,
                created_at=at,
                source="message",
                processed_at=at if processed else None,
                process_next_at=None if processed else utcnow(),
            )
        )
        attachment.drive_item_id = item.id
        attachment.drive_state = "available"
        total += attachment.size_bytes
        out[attachment.id] = AttachmentDriveOut(
            item_id=item.id, version_id=version_id, version_number=1, state="available"
        )
    await db.flush()
    # §8: counted once, here (and no longer among the chat's attachments); never refused.
    location = await service.lock_location(db, plan.location_id)
    location.used_bytes += total
    location.item_count += len(rows) + made
    location.updated_at = utcnow()
    changed.append(month.id)
    await events.emit_changed(db, plan.location_id, changed)
    return out


async def file_in_tx(
    db: AsyncSession, plan: Plan, sender: User, rows: list[Attachment]
) -> dict[uuid.UUID, AttachmentDriveOut]:
    """Right after the bind, in the send's transaction: {attachment id: its drive place}. On any
    failure nothing of it stays and the files are plain attachments ({})."""
    if not rows:
        return {}
    try:
        async with db.begin_nested():
            return await _file(db, plan, sender, rows)
    except Exception:
        log.warning(
            "channel files: %d file(s) of a message in drive location %s stay plain attachments",
            len(rows),
            plan.location_id,
            exc_info=True,
        )
        for attachment in rows:
            await db.refresh(attachment)
        return {}


# --- a message deleted (§7) ---------------------------------------------------------------------


async def _live_posted(db: AsyncSession, message_id: uuid.UUID) -> list[Attachment]:
    stmt = (
        select(Attachment)
        .where(
            Attachment.message_id == message_id,
            Attachment.drive_state.in_(LIVE_STATES),
            Attachment.drive_item_id.is_not(None),
        )
        .order_by(Attachment.created_at, Attachment.id)
    )
    return list((await db.execute(stmt)).scalars().all())


async def delete_rules(
    db: AsyncSession, actor: User, message: Message
) -> list[DriveMessageFileOut]:
    """§7.2-§7.3: per posted file of the message, whether deleting it (drive_files=auto, and
    trash) puts the file in the trash. Only a file the actor posted (or any, for a moderator)
    that has not changed since: its only version is the posted one, it is still in the channel's
    drive outside the trash, and no other message shows it. A rename or a move inside the
    channel's drive is no change."""
    rows = await _live_posted(db, message.id)
    if not rows:
        return []
    moderator = has_capability(actor, "channels.moderate")
    home = await repo.location_of_channel(db, message.channel_id)
    item_ids = [a.drive_item_id for a in rows if a.drive_item_id is not None]
    items = await repo.items(db, item_ids)
    counts = await repo.version_counts(db, item_ids)
    others = dict(
        (
            await db.execute(
                select(Attachment.drive_item_id, func.count())
                .where(
                    Attachment.drive_item_id.in_(item_ids),
                    Attachment.drive_state.in_(LIVE_STATES),
                    Attachment.message_id != message.id,
                )
                .group_by(Attachment.drive_item_id)
            )
        ).all()
    )
    out: list[DriveMessageFileOut] = []
    for attachment in rows:
        assert attachment.drive_item_id is not None
        item = items.get(attachment.drive_item_id)
        reason: str | None = None
        if item is None or item.trashed_at is not None:
            reason = "in_trash"
        elif home is None or item.location_id != home.id:
            reason = "moved"
        elif not moderator and not (
            message.sender_id == actor.id and attachment.uploader_id == actor.id
        ):
            reason = "not_permitted"
        elif counts.get(item.id, 0) != 1 or others.get(item.id, 0):
            reason = "changed"
        out.append(
            DriveMessageFileOut(
                attachment_id=attachment.id,
                item_id=attachment.drive_item_id,
                state=attachment.drive_state,  # type: ignore[arg-type]
                trash=reason is None,
                reason=reason,  # type: ignore[arg-type]
            )
        )
    return out


async def message_files(db: AsyncSession, actor: User, message: Message) -> DriveMessageFilesOut:
    return DriveMessageFilesOut(files=await delete_rules(db, actor, message))


async def on_message_delete_in_tx(
    db: AsyncSession, actor: User, message: Message, mode: DriveFilesMode
) -> list[uuid.UUID]:
    """Before the delete takes the message's channel: the files its rule puts in the trash
    (`keep`: none). Returns the items trashed."""
    if mode == "keep":
        return []
    wanted = [r.item_id for r in await delete_rules(db, actor, message) if r.trash]
    if not wanted:
        return []
    return await service.trash_posted_in_tx(db, actor.id, wanted, message_id=message.id)


# --- impact (§6.4) ------------------------------------------------------------------------------


async def _audience(db: AsyncSession, channel_id: uuid.UUID) -> dict[uuid.UUID, bool]:
    """{member id: is a guest} of the channel's members who can sign in (bots aside)."""
    member_ids = await channels.member_ids_of(db, channel_id)
    if not member_ids:
        return {}
    rows = await db.execute(
        select(User.id, User.role).where(
            User.id.in_(member_ids), User.role != "bot", User.deactivated_at.is_(None)
        )
    )
    return {row[0]: row[1] == "guest" for row in rows.all()}


async def impact(db: AsyncSession, actor: User, data: DriveImpactIn) -> DriveImpactOut:
    """What moving the items into `target_folder_id` (or trashing them) would do to the
    messages showing their posted files: per channel, the messages concerned and the members who
    would no longer see a file there. Every item (and the target) must be readable (404)."""
    target_location: uuid.UUID | None = None
    if data.target_folder_id is not None:
        folder, _ = await service.readable_item(db, actor, data.target_folder_id)
        if folder.kind != "folder":
            raise acl.item_not_found()
        target_location = folder.location_id
    ids: list[uuid.UUID] = []
    for item_id in dict.fromkeys(data.item_ids):
        item, _ = await service.readable_item(db, actor, item_id)
        ids.extend(i for i, _ in await repo.subtree(db, item.id))
    rows = (
        await db.execute(
            select(Attachment.drive_item_id, Attachment.message_id, Attachment.channel_id)
            .join(Message, Message.id == Attachment.message_id)
            .where(
                Attachment.drive_item_id.in_(ids),
                Attachment.drive_state.in_(("available", "moved")),
                Message.deleted_at.is_(None),
            )
        )
    ).all()
    if not rows:
        return DriveImpactOut(posted_messages=0, channels=[])
    places = {
        i: (loc, trashed)
        for i, (loc, trashed) in (
            await posted._item_places(db, {r[0] for r in rows if r[0] is not None})
        ).items()
    }
    homes = {
        row[0]: row[1]
        for row in (
            await db.execute(
                select(DriveLocation.channel_id, DriveLocation.id).where(
                    DriveLocation.channel_id.in_({r[2] for r in rows if r[2] is not None})
                )
            )
        ).all()
    }
    readers: dict[uuid.UUID, set[uuid.UUID]] = {}

    async def readers_of(location_id: uuid.UUID) -> set[uuid.UUID]:
        if location_id not in readers:
            location = await repo.location(db, location_id)
            readers[location_id] = (
                set(await acl.readers(db, location)) if location is not None else set()
            )
        return readers[location_id]

    audiences: dict[uuid.UUID, dict[uuid.UUID, bool]] = {}
    messages: dict[uuid.UUID, set[uuid.UUID]] = {}
    lost: dict[uuid.UUID, set[uuid.UUID]] = {}
    every: set[uuid.UUID] = set()
    for found_item, found_message, found_channel in rows:
        if found_item is None or found_message is None or found_channel is None:
            continue
        item_id, message_id, channel_id = found_item, found_message, found_channel
        if item_id not in places:
            continue
        if channel_id not in audiences:
            audiences[channel_id] = await _audience(db, channel_id)
        members = set(audiences[channel_id])
        home = homes.get(channel_id)
        location_id, _ = places[item_id]
        before = members if location_id == home else members & await readers_of(location_id)
        if target_location is None:
            after: set[uuid.UUID] = set()
            now_state, then_state = ("available" if location_id == home else "moved"), "trashed"
        else:
            after = (
                members if target_location == home else members & await readers_of(target_location)
            )
            now_state = "available" if location_id == home else "moved"
            then_state = "available" if target_location == home else "moved"
        if now_state == then_state and before <= after:
            continue
        every.add(message_id)
        messages.setdefault(channel_id, set()).add(message_id)
        lost.setdefault(channel_id, set()).update(before - after)
    out: list[DriveImpactChannelOut] = []
    for channel_id in sorted(messages):
        try:
            await channels.require_readable(db, actor, channel_id)
        except AppError:
            continue
        gone = lost.get(channel_id, set())
        out.append(
            DriveImpactChannelOut(
                channel_id=channel_id,
                messages=len(messages[channel_id]),
                unreadable_after=len(gone),
                unreadable_guests=sum(1 for u in gone if audiences[channel_id].get(u)),
            )
        )
    return DriveImpactOut(posted_messages=len(every), channels=out)


# --- backfill (§10) -----------------------------------------------------------------------------


@dataclass
class BackfillChannel:
    channel_id: uuid.UUID
    name: str
    enabled: bool
    files: int = 0
    bytes: int = 0
    used_bytes: int = 0
    quota_bytes: int | None = None
    filed: int = 0
    failed: int = 0


@dataclass
class BackfillResult:
    channels: list[BackfillChannel] = field(default_factory=list)
    remaining: bool = False


def _candidates(channel_id: uuid.UUID, since: datetime | None) -> Select[Any]:
    stmt = (
        select(Attachment)
        .join(Message, Message.id == Attachment.message_id)
        .where(
            Attachment.channel_id == channel_id,
            Attachment.status == "attached",
            Attachment.drive_item_id.is_(None),
            Attachment.drive_state.is_(None),
            Attachment.canvas_id.is_(None),
            Attachment.page_id.is_(None),
            Message.deleted_at.is_(None),
        )
    )
    if since is not None:
        stmt = stmt.where(Attachment.attached_at >= since)
    return stmt


async def _channels_to_fill(db: AsyncSession, names_wanted: list[str] | None) -> list[Channel]:
    stmt = select(Channel).where(Channel.type.in_(("public", "private"))).order_by(Channel.name)
    if names_wanted is not None:
        stmt = stmt.where(Channel.name.in_(names_wanted))
    found = list((await db.execute(stmt)).scalars().all())
    if names_wanted is not None:
        known = {(c.name or "").lower() for c in found}
        missing = [n for n in names_wanted if n.lower() not in known]
        if missing:
            raise ValueError(f"no public or private channel named {', '.join(missing)}")
    return found


async def _file_one(db: AsyncSession, attachment_id: uuid.UUID) -> bool:
    """One earlier attachment into its channel's drive, in its own transaction (committed by
    the caller). False when it no longer qualifies."""
    peek = await db.get(Attachment, attachment_id, populate_existing=True)
    if peek is None or peek.channel_id is None or peek.attached_at is None:
        return False
    plan = await _lock_plan(db, peek.channel_id, month_name(peek.attached_at))
    row = (
        await db.execute(
            select(Attachment)
            .where(Attachment.id == attachment_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if (
        row is None
        or row.status != "attached"
        or row.drive_item_id is not None
        or row.drive_state is not None
        or row.message_id is None
        or row.canvas_id is not None
        or row.page_id is not None
    ):
        return False
    message = await db.get(Message, row.message_id, populate_existing=True)
    sender = await db.get(User, row.uploader_id)
    if message is None or message.deleted_at is not None or sender is None:
        return False
    await _file(db, plan, sender, [row])
    return True


async def backfill(
    db: AsyncSession,
    *,
    channel_names: list[str] | None,
    since: datetime | None,
    dry_run: bool,
    limit: int | None,
) -> BackfillResult:
    """§10: the attachments of messages (not deleted, not a canvas's or a page's) posted in
    these channels (None: every public and private channel) before their files went to the
    drive, into 「投稿のファイル > <month of the post>」. Nothing is copied: each row gets its item
    and version 1, the location counts its bytes. No message.updated (the devices learn the new
    `drive` the next time they read the message). Skips channels whose switch is off. Each file
    is committed on its own: stopping and running it again goes on where it was (rows filed
    already are not candidates). `dry_run`: the counts, sizes and the drives' use and quota."""
    result = BackfillResult()
    left = limit
    # Read before any rollback (it expires the rows).
    wanted = [
        BackfillChannel(channel_id=c.id, name=c.name or "", enabled=await enabled_for(db, c))
        for c in await _channels_to_fill(db, channel_names)
    ]
    for report in wanted:
        channel_id = report.channel_id
        result.channels.append(report)
        counted = _candidates(channel_id, since).subquery()
        files, size = (
            await db.execute(select(func.count(), func.coalesce(func.sum(counted.c.size_bytes), 0)))
        ).one()
        report.files, report.bytes = int(files), int(size)
        location = await repo.location_of_channel(db, channel_id)
        if location is not None:
            report.used_bytes, report.quota_bytes = location.used_bytes, location.quota_bytes
        await db.rollback()
        if dry_run or not report.enabled or not report.files:
            continue
        ids = list(
            (
                await db.execute(
                    _candidates(channel_id, since)
                    .with_only_columns(Attachment.id)
                    .order_by(Attachment.attached_at, Attachment.id)
                )
            ).scalars()
        )
        await db.rollback()
        for attachment_id in ids:
            if left is not None and left <= 0:
                result.remaining = True
                return result
            try:
                done = await _file_one(db, attachment_id)
                await db.commit()
            except Exception:
                await db.rollback()
                log.warning("channel files backfill: %s failed", attachment_id, exc_info=True)
                report.failed += 1
                continue
            if done:
                report.filed += 1
                if left is not None:
                    left -= 1
    return result
