import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.sidebar.models import SidebarSection, SidebarSectionChannel


async def sections_for(db: AsyncSession, user_id: uuid.UUID) -> list[SidebarSection]:
    stmt = (
        select(SidebarSection)
        .where(SidebarSection.user_id == user_id)
        .order_by(SidebarSection.position.asc(), SidebarSection.created_at.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def placements_for(db: AsyncSession, user_id: uuid.UUID) -> list[SidebarSectionChannel]:
    stmt = (
        select(SidebarSectionChannel)
        .where(SidebarSectionChannel.user_id == user_id)
        .order_by(SidebarSectionChannel.added_at.asc())
    )
    return list((await db.execute(stmt)).scalars().all())


async def get(db: AsyncSession, user_id: uuid.UUID, section_id: uuid.UUID) -> SidebarSection | None:
    stmt = select(SidebarSection).where(
        SidebarSection.id == section_id, SidebarSection.user_id == user_id
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def count(db: AsyncSession, user_id: uuid.UUID) -> int:
    stmt = select(func.count()).select_from(SidebarSection).where(SidebarSection.user_id == user_id)
    return int(await db.scalar(stmt) or 0)


async def place(
    db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID, section_id: uuid.UUID
) -> None:
    """Put the conversation in the section, moving it out of any other of my sections."""
    stmt = (
        pg_insert(SidebarSectionChannel)
        .values(user_id=user_id, channel_id=channel_id, section_id=section_id)
        .on_conflict_do_update(
            index_elements=["user_id", "channel_id"],
            set_={"section_id": section_id, "added_at": func.now()},
        )
    )
    await db.execute(stmt)


async def unplace(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> bool:
    result = await db.execute(
        delete(SidebarSectionChannel)
        .where(
            SidebarSectionChannel.user_id == user_id,
            SidebarSectionChannel.channel_id == channel_id,
        )
        .returning(SidebarSectionChannel.channel_id)
    )
    return result.first() is not None


async def remove(db: AsyncSession, section: SidebarSection) -> None:
    await db.execute(
        delete(SidebarSectionChannel).where(SidebarSectionChannel.section_id == section.id)
    )
    await db.delete(section)
