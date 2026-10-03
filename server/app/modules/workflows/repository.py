import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.workflows.models import Workflow


async def get(
    db: AsyncSession, workflow_id: uuid.UUID, *, for_update: bool = False
) -> Workflow | None:
    stmt = select(Workflow).where(Workflow.id == workflow_id, Workflow.deleted_at.is_(None))
    if for_update:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one_or_none()


async def list_all(db: AsyncSession) -> list[Workflow]:
    stmt = (
        select(Workflow)
        .where(Workflow.deleted_at.is_(None))
        .order_by(func.lower(Workflow.name), Workflow.id)
    )
    return list((await db.execute(stmt)).scalars().all())


async def list_offered_in(db: AsyncSession, channel_id: uuid.UUID) -> list[Workflow]:
    stmt = (
        select(Workflow)
        .where(
            Workflow.deleted_at.is_(None),
            Workflow.offered_channel_ids.contains([channel_id]),
        )
        .order_by(func.lower(Workflow.name), Workflow.id)
    )
    return list((await db.execute(stmt)).scalars().all())


async def count(db: AsyncSession) -> int:
    stmt = select(func.count()).select_from(Workflow).where(Workflow.deleted_at.is_(None))
    return int((await db.execute(stmt)).scalar_one())


async def name_taken(db: AsyncSession, name: str, *, except_id: uuid.UUID | None = None) -> bool:
    stmt = select(Workflow.id).where(
        Workflow.deleted_at.is_(None), func.lower(Workflow.name) == name.lower()
    )
    if except_id is not None:
        stmt = stmt.where(Workflow.id != except_id)
    return (await db.execute(stmt.limit(1))).first() is not None
