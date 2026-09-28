import uuid

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.lab.models import LabProfile


async def lock_roster(db: AsyncSession) -> None:
    """Roster changes one at a time: each recomputes the managed groups from the whole roster."""
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext('lab_roster'))"))


async def get(db: AsyncSession, user_id: uuid.UUID) -> LabProfile | None:
    stmt = select(LabProfile).where(LabProfile.user_id == user_id)
    return (await db.execute(stmt.execution_options(populate_existing=True))).scalar_one_or_none()


async def list_all(db: AsyncSession) -> list[LabProfile]:
    return list((await db.execute(select(LabProfile))).scalars().all())


async def remove(db: AsyncSession, user_id: uuid.UUID) -> bool:
    result = await db.execute(delete(LabProfile).where(LabProfile.user_id == user_id))
    return bool(getattr(result, "rowcount", 0))
