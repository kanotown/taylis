"""The deployment's identity (WORKSPACES.md §3): one deployment = one workspace (D12). Also the
workspace-wide settings an administrator changes (M88, docs/MEMBERSHIP.md §3)."""

import uuid
from collections.abc import Sequence
from typing import Any

import filetype
from fastapi import UploadFile
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.errors import AppError, bad_request, not_found
from app.core.ids import uuid7
from app.core.settings import Settings
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import ImageTooLarge
from app.modules.audit import service as audit
from app.modules.avatars import service as avatars
from app.modules.channels.models import Channel
from app.modules.workspace.events import WORKSPACE_SETTINGS_UPDATED, WorkspaceSettingsUpdatedData
from app.modules.workspace.models import WorkspaceIdentity, WorkspaceSettings
from app.modules.workspace.schemas import (
    AdminWorkspaceSettingsOut,
    DefaultChannelOut,
    WorkspaceSettingsOut,
    WorkspaceSettingsUpdate,
)


async def workspace_id(db: AsyncSession) -> uuid.UUID | None:
    """Stable across restarts and restores (it is data). The migration creates it."""
    return (await db.execute(select(WorkspaceIdentity.id))).scalar_one_or_none()


async def ensure(db: AsyncSession) -> uuid.UUID:
    """Startup: a restore that lost the row gets a new identity (clients re-read GET /server)."""
    current = await workspace_id(db)
    if current is not None:
        return current
    await db.execute(
        insert(WorkspaceIdentity)
        .values(singleton=True, id=uuid7())
        .on_conflict_do_nothing(index_elements=["singleton"])
    )
    await db.commit()
    return (await db.execute(select(WorkspaceIdentity.id))).scalar_one()


# --- settings (M88) -----------------------------------------------------------------------------

SETTING_FIELDS = ("show_membership_messages", "preview_before_join")


async def _row(db: AsyncSession, *, for_update: bool = False) -> WorkspaceSettings | None:
    stmt = select(WorkspaceSettings)
    if for_update:
        stmt = stmt.with_for_update()
    return (await db.execute(stmt)).scalar_one_or_none()


async def settings(db: AsyncSession) -> WorkspaceSettingsOut:
    """The settings every client sees (bootstrap); the defaults when the row is missing."""
    row = await _row(db)
    if row is None:
        return WorkspaceSettingsOut()
    return WorkspaceSettingsOut(
        show_membership_messages=row.show_membership_messages,
        preview_before_join=row.preview_before_join,
        icon_version=icon_version_of(row.icon_key),
    )


def usable_default(channel: Channel | None) -> bool:
    """M90: a channel that can be a default — public and not archived."""
    return channel is not None and channel.type == "public" and not channel.is_archived


async def default_channel_ids(db: AsyncSession) -> list[uuid.UUID] | None:
    """M90: the saved list as it is (None when never set); the caller skips unusable ones."""
    row = await _row(db)
    return None if row is None else row.default_channel_ids


async def usable_default_channels(
    db: AsyncSession, ids: Sequence[uuid.UUID] | None
) -> list[Channel]:
    """The listed channels that are still public and not archived, in the listed order."""
    if not ids:
        return []
    rows = (await db.execute(select(Channel).where(Channel.id.in_(list(ids))))).scalars().all()
    by_id = {c.id: c for c in rows}
    return [by_id[i] for i in dict.fromkeys(ids) if usable_default(by_id.get(i))]


async def lock_usable_default_channels(
    db: AsyncSession, ids: Sequence[uuid.UUID] | None
) -> list[Channel]:
    """``usable_default_channels`` for a caller about to add members (review v0.1.30 #1): the
    channel rows are locked (FOR NO KEY UPDATE, in id order so two such callers never deadlock)
    and re-read under the lock, so a channel made private or archived by a transaction that
    committed first is skipped, and one that commits later waits until these memberships are in
    (they were then made while the channel was public). Making a channel private or archiving it
    locks the channel row before the settings row, and nothing here locks the settings row, so
    the two never wait on each other in a cycle. Held until the caller commits."""
    if not ids:
        return []
    rows = (
        (
            await db.execute(
                select(Channel)
                .where(Channel.id.in_(list(ids)))
                .order_by(Channel.id)
                .with_for_update(key_share=True)
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    by_id = {c.id: c for c in rows}
    return [by_id[i] for i in dict.fromkeys(ids) if usable_default(by_id.get(i))]


async def admin_settings(
    db: AsyncSession, legacy_default_channels: Sequence[str] = ()
) -> AdminWorkspaceSettingsOut:
    """``legacy_default_channels``: SSO_DEFAULT_CHANNELS, shown while the list was never set."""
    row = await _row(db)
    if row is None:
        return AdminWorkspaceSettingsOut(legacy_sso_default_channels=list(legacy_default_channels))
    usable = await usable_default_channels(db, row.default_channel_ids)
    is_set = row.default_channel_ids is not None
    return AdminWorkspaceSettingsOut(
        show_membership_messages=row.show_membership_messages,
        preview_before_join=row.preview_before_join,
        icon_version=icon_version_of(row.icon_key),
        updated_at=row.updated_at,
        updated_by=row.updated_by,
        default_channel_ids=[c.id for c in usable],
        default_channels=[DefaultChannelOut(id=c.id, name=c.name or "") for c in usable],
        default_channels_set=is_set,
        legacy_sso_default_channels=[] if is_set else list(legacy_default_channels),
    )


async def _validate_defaults(db: AsyncSession, ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """PATCH: every listed channel must exist, be public and not archived; repeats dropped."""
    wanted = list(dict.fromkeys(ids))
    rows = (await db.execute(select(Channel).where(Channel.id.in_(wanted)))).scalars().all()
    by_id = {c.id: c for c in rows}
    for channel_id in wanted:
        channel = by_id.get(channel_id)
        details = {"channel_id": str(channel_id)}
        if channel is None:
            raise AppError(422, "default_channel_not_found", "Channel not found", details=details)
        if channel.type != "public":
            raise AppError(
                422,
                "default_channel_not_public",
                "Only a public channel can be a default channel",
                details=details,
            )
        if channel.is_archived:
            raise AppError(
                422,
                "default_channel_archived",
                "An archived channel cannot be a default channel",
                details=details,
            )
    return wanted


def _ids_json(ids: Sequence[uuid.UUID] | None) -> list[str] | None:
    return None if ids is None else [str(i) for i in ids]


async def _announce_change(db: AsyncSession, actor_id: uuid.UUID | None, changes: Any) -> None:
    await audit.record_in_tx(
        db,
        actor_id=actor_id,
        action="workspace.settings_updated",
        target_type="workspace",
        target_id=None,
        details=changes,
    )
    await write_outbox(
        db,
        event_type=WORKSPACE_SETTINGS_UPDATED,
        audience_type="all",
        payload=WorkspaceSettingsUpdatedData(settings=await settings(db)).model_dump(mode="json"),
    )


async def update_settings(
    db: AsyncSession,
    actor_id: uuid.UUID,
    data: WorkspaceSettingsUpdate,
    legacy_default_channels: Sequence[str] = (),
) -> AdminWorkspaceSettingsOut:
    """PATCH /admin/workspace-settings: the fields sent; a change is audited
    (`workspace.settings_updated`, before / after) and announced to every device."""
    wanted_defaults = (
        await _validate_defaults(db, data.default_channel_ids)
        if data.default_channel_ids is not None
        else None
    )
    await db.execute(
        insert(WorkspaceSettings)
        .values(singleton=True)
        .on_conflict_do_nothing(index_elements=["singleton"])
    )
    row = await _row(db, for_update=True)
    assert row is not None
    changes: dict[str, dict[str, Any]] = {}
    for field in SETTING_FIELDS:
        wanted = getattr(data, field)
        if wanted is not None and wanted != getattr(row, field):
            changes[field] = {"from": getattr(row, field), "to": wanted}
            setattr(row, field, wanted)
    if wanted_defaults is not None and wanted_defaults != row.default_channel_ids:
        changes["default_channel_ids"] = {
            "from": _ids_json(row.default_channel_ids),
            "to": _ids_json(wanted_defaults),
        }
        row.default_channel_ids = wanted_defaults
    if changes:
        row.updated_at = utcnow()
        row.updated_by = actor_id
        await db.flush()
        await _announce_change(db, actor_id, changes)
    await db.commit()
    return await admin_settings(db, legacy_default_channels)


async def drop_default_channel_in_tx(
    db: AsyncSession, channel_id: uuid.UUID, actor_id: uuid.UUID | None, reason: str
) -> bool:
    """M90: a default channel was archived or made private — it leaves the list (audited like an
    administrator's change, with the reason). Unarchiving or making it public again does not put it
    back. The caller commits; False when it was not listed."""
    row = await _row(db)
    if row is None or not row.default_channel_ids or channel_id not in row.default_channel_ids:
        return False
    row = await _row(db, for_update=True)
    assert row is not None and row.default_channel_ids is not None
    before = list(row.default_channel_ids)
    row.default_channel_ids = [i for i in before if i != channel_id]
    row.updated_at = utcnow()
    await db.flush()
    await _announce_change(
        db,
        actor_id,
        {
            "default_channel_ids": {
                "from": _ids_json(before),
                "to": _ids_json(row.default_channel_ids),
            },
            "reason": reason,
        },
    )
    return True


# --- icon (M93, WORKSPACES.md §3.4) -------------------------------------------------------------

ICON_PREFIX = "workspace-icon/"
# PNG, JPEG and WebP (not GIF: an animated logo on the rail would be noise).
ICON_TYPES = {"image/png", "image/jpeg", "image/webp"}


def icon_version_of(key: str | None) -> str | None:
    """The key's last part (a fresh uuid7 per upload) is the version clients cache by."""
    return key.rsplit("/", 1)[-1] if key else None


async def icon_version(db: AsyncSession) -> str | None:
    row = await _row(db)
    return None if row is None else icon_version_of(row.icon_key)


async def icon_key(db: AsyncSession) -> str:
    """GET /server/icon: the object to stream, or 404 workspace_icon_not_found."""
    row = await _row(db)
    if row is None or not row.icon_key:
        raise not_found("workspace_icon_not_found", "This workspace has no icon")
    return row.icon_key


async def _set_icon(db: AsyncSession, actor_id: uuid.UUID, key: str | None) -> str | None:
    """Store the new key (audited and announced like any setting); returns the replaced key."""
    await db.execute(
        insert(WorkspaceSettings)
        .values(singleton=True)
        .on_conflict_do_nothing(index_elements=["singleton"])
    )
    row = await _row(db, for_update=True)
    assert row is not None
    previous = row.icon_key
    if previous == key:
        return None
    row.icon_key = key
    row.updated_at = utcnow()
    row.updated_by = actor_id
    await db.flush()
    await _announce_change(
        db,
        actor_id,
        {"icon": {"from": icon_version_of(previous), "to": icon_version_of(key)}},
    )
    await db.commit()
    return previous


async def upload_icon(
    db: AsyncSession,
    actor_id: uuid.UUID,
    file: UploadFile,
    settings: Settings,
    blobs: BlobStore,
    legacy_default_channels: Sequence[str] = (),
) -> AdminWorkspaceSettingsOut:
    """POST /admin/workspace-settings/icon: a PNG / JPEG / WebP, centre-cropped square and
    resized to 256px PNG (as a profile picture, so no metadata survives)."""
    data = await avatars.read_upload(file, settings.avatar_max_bytes, prefix="workspace_icon")
    kind = filetype.guess(data[:8192])
    if kind is None or kind.mime not in ICON_TYPES:
        raise bad_request("workspace_icon_not_image", "Use a PNG, JPEG or WebP image")
    try:
        png = await run_in_threadpool(avatars.square_png, data)
    except ImageTooLarge as exc:
        raise AppError(422, "image_too_large", "The image has too many pixels") from exc
    except Exception as exc:
        raise bad_request("workspace_icon_not_image", "The image could not be read") from exc
    key = f"{ICON_PREFIX}{uuid7()}"
    await blobs.put(key, png, "image/png")
    previous = await _set_icon(db, actor_id, key)
    if previous:
        await avatars.forget(blobs, previous)
    return await admin_settings(db, legacy_default_channels)


async def remove_icon(
    db: AsyncSession,
    actor_id: uuid.UUID,
    blobs: BlobStore,
    legacy_default_channels: Sequence[str] = (),
) -> AdminWorkspaceSettingsOut:
    """DELETE /admin/workspace-settings/icon: back to the letter tile (idempotent)."""
    previous = await _set_icon(db, actor_id, None)
    if previous:
        await avatars.forget(blobs, previous)
    return await admin_settings(db, legacy_default_channels)
