"""The deployment's identity (WORKSPACES.md §3): one deployment = one workspace (D12). Also the
workspace-wide settings an administrator changes (M88, docs/MEMBERSHIP.md §3)."""

import uuid
from collections.abc import Sequence
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.ids import uuid7
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.audit import service as audit
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
