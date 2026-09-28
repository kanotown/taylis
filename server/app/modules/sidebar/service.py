"""Custom sidebar sections (M14f).

Each user may group their conversations into named sections (at most 20). A conversation sits in
at most one of my sections; the rest stay in the default ones (お気に入り / チャンネル / DM).
Every change fans out to my own devices as `sidebar.updated` carrying the whole list.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict, not_found
from app.events.outbox import write_outbox
from app.modules.channels import service as channels
from app.modules.sidebar import repository as repo
from app.modules.sidebar.events import SIDEBAR_UPDATED, SidebarUpdatedData
from app.modules.sidebar.models import SidebarSection
from app.modules.sidebar.schemas import (
    MAX_SECTIONS,
    SectionCreate,
    SectionUpdate,
    SidebarSectionOut,
)
from app.modules.users.models import User


async def list_for(db: AsyncSession, user_id: uuid.UUID) -> list[SidebarSectionOut]:
    sections = await repo.sections_for(db, user_id)
    placed: dict[uuid.UUID, list[uuid.UUID]] = {s.id: [] for s in sections}
    for row in await repo.placements_for(db, user_id):
        placed.setdefault(row.section_id, []).append(row.channel_id)
    return [
        SidebarSectionOut(
            id=s.id,
            name=s.name,
            emoji=s.emoji,
            collapsed=s.collapsed,
            position=s.position,
            channel_ids=placed[s.id],
        )
        for s in sections
    ]


async def _renumber(sections: list[SidebarSection]) -> None:
    for index, section in enumerate(sections):
        section.position = index


async def _commit(db: AsyncSession, actor: User) -> list[SidebarSectionOut]:
    await db.flush()
    out = await list_for(db, actor.id)
    await write_outbox(
        db,
        event_type=SIDEBAR_UPDATED,
        audience_type="user",
        audience_id=actor.id,
        payload=SidebarUpdatedData(sections=out).model_dump(mode="json"),
    )
    await db.commit()
    return out


async def _require(db: AsyncSession, actor: User, section_id: uuid.UUID) -> SidebarSection:
    section = await repo.get(db, actor.id, section_id)
    if section is None:
        raise not_found("section_not_found", "Section not found")
    return section


async def create(db: AsyncSession, actor: User, data: SectionCreate) -> list[SidebarSectionOut]:
    if await repo.count(db, actor.id) >= MAX_SECTIONS:
        raise conflict("too_many_sections", f"At most {MAX_SECTIONS} sections")
    section = SidebarSection(
        user_id=actor.id,
        name=data.name,
        emoji=data.emoji,
        position=await repo.count(db, actor.id),
    )
    db.add(section)
    await db.flush()
    # M26: the conversations chosen in the create form move here (only ones I am in).
    for channel_id in dict.fromkeys(data.channel_ids):
        await channels.require_member(db, actor.id, channel_id)
        await repo.place(db, actor.id, channel_id, section.id)
    return await _commit(db, actor)


async def update(
    db: AsyncSession, actor: User, section_id: uuid.UUID, data: SectionUpdate
) -> list[SidebarSectionOut]:
    section = await _require(db, actor, section_id)
    if data.name is not None:
        section.name = data.name
    if "emoji" in data.model_fields_set:
        section.emoji = data.emoji
    if data.collapsed is not None:
        section.collapsed = data.collapsed
    if data.position is not None:
        ordered = [s for s in await repo.sections_for(db, actor.id) if s.id != section.id]
        ordered.insert(min(data.position, len(ordered)), section)
        await _renumber(ordered)
    return await _commit(db, actor)


async def delete(db: AsyncSession, actor: User, section_id: uuid.UUID) -> list[SidebarSectionOut]:
    """Its conversations go back to the default sections."""
    section = await _require(db, actor, section_id)
    await repo.remove(db, section)
    await db.flush()
    await _renumber(await repo.sections_for(db, actor.id))
    return await _commit(db, actor)


async def place(
    db: AsyncSession, actor: User, section_id: uuid.UUID, channel_id: uuid.UUID
) -> list[SidebarSectionOut]:
    section = await _require(db, actor, section_id)
    await channels.require_member(db, actor.id, channel_id)
    await repo.place(db, actor.id, channel_id, section.id)
    return await _commit(db, actor)


async def unplace(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> list[SidebarSectionOut]:
    await repo.unplace(db, actor.id, channel_id)
    return await _commit(db, actor)
