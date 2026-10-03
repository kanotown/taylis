"""The deployment's identity (WORKSPACES.md §3): one deployment = one workspace (D12). Also the
workspace-wide settings an administrator changes (M88, docs/MEMBERSHIP.md §3)."""

import uuid

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ids import uuid7
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.audit import service as audit
from app.modules.workspace.events import WORKSPACE_SETTINGS_UPDATED, WorkspaceSettingsUpdatedData
from app.modules.workspace.models import WorkspaceIdentity, WorkspaceSettings
from app.modules.workspace.schemas import (
    AdminWorkspaceSettingsOut,
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


async def admin_settings(db: AsyncSession) -> AdminWorkspaceSettingsOut:
    row = await _row(db)
    if row is None:
        return AdminWorkspaceSettingsOut()
    return AdminWorkspaceSettingsOut(
        show_membership_messages=row.show_membership_messages,
        preview_before_join=row.preview_before_join,
        updated_at=row.updated_at,
        updated_by=row.updated_by,
    )


async def update_settings(
    db: AsyncSession, actor_id: uuid.UUID, data: WorkspaceSettingsUpdate
) -> AdminWorkspaceSettingsOut:
    """PATCH /admin/workspace-settings: the fields sent; a change is audited
    (`workspace.settings_updated`, before / after) and announced to every device."""
    await db.execute(
        insert(WorkspaceSettings)
        .values(singleton=True)
        .on_conflict_do_nothing(index_elements=["singleton"])
    )
    row = await _row(db, for_update=True)
    assert row is not None
    changes: dict[str, dict[str, bool]] = {}
    for field in SETTING_FIELDS:
        wanted = getattr(data, field)
        if wanted is not None and wanted != getattr(row, field):
            changes[field] = {"from": getattr(row, field), "to": wanted}
            setattr(row, field, wanted)
    if changes:
        row.updated_at = utcnow()
        row.updated_by = actor_id
        await db.flush()
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
            payload=WorkspaceSettingsUpdatedData(settings=await settings(db)).model_dump(
                mode="json"
            ),
        )
    await db.commit()
    return await admin_settings(db)
