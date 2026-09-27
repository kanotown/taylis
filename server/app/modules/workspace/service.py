"""The deployment's identity (WORKSPACES.md §3): one deployment = one workspace (D12)."""

import uuid

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ids import uuid7
from app.modules.workspace.models import WorkspaceIdentity


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
