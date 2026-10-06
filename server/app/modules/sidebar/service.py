"""Custom sidebar sections (M14f).

Each user may group their conversations into named sections (at most 20). A conversation sits in
at most one of my sections; the rest stay in the default ones (お気に入り / チャンネル / DM).
Every change fans out to my own devices as `sidebar.updated` carrying the whole list.

2026-10-07 (DATA_MODEL.md sidebar_sections 「並べ替え」): every section, the default ones too, has a
sort (name / recent / manual) and a hand-made order; the clients sort by them.

2026-10-07 (「1 つの会話は 1 か所」): a conversation is in お気に入り or in one of my sections,
never both (Slack). Putting a starred one in a section unstars it (favorite.updated); starring
one takes it out of its section (the hook below, sidebar.updated).
"""

import uuid
from typing import cast

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import conflict, not_found
from app.events.outbox import write_outbox
from app.modules.channels import service as channels
from app.modules.favorites import service as favorites
from app.modules.sidebar import repository as repo
from app.modules.sidebar.events import SIDEBAR_UPDATED, SidebarUpdatedData
from app.modules.sidebar.models import SidebarDefaultSection, SidebarSection
from app.modules.sidebar.schemas import (
    DEFAULT_SORTS,
    MAX_SECTIONS,
    DefaultSectionKey,
    SectionCreate,
    SectionUpdate,
    SidebarDefaultOut,
    SidebarDefaultUpdate,
    SidebarSectionOut,
    SidebarSort,
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
            sort=_sort(s.sort, "name"),
            manual_order=list(s.manual_order),
        )
        for s in sections
    ]


def _sort(value: str, fallback: SidebarSort) -> SidebarSort:
    return cast(SidebarSort, value) if value in ("name", "recent", "manual") else fallback


async def list_defaults(db: AsyncSession, user_id: uuid.UUID) -> list[SidebarDefaultOut]:
    """The three default sections, in sidebar order, with the default sort where I chose none."""
    rows = {row.key: row for row in await repo.defaults_for(db, user_id)}
    out = []
    for key, fallback in DEFAULT_SORTS.items():
        row = rows.get(key)
        out.append(
            SidebarDefaultOut(
                key=key,
                sort=_sort(row.sort, fallback) if row else fallback,
                manual_order=list(row.manual_order) if row else [],
            )
        )
    return out


async def _renumber(sections: list[SidebarSection]) -> None:
    for index, section in enumerate(sections):
        section.position = index


async def _announce(db: AsyncSession, actor: User) -> list[SidebarSectionOut]:
    await db.flush()
    out = await list_for(db, actor.id)
    defaults = await list_defaults(db, actor.id)
    await write_outbox(
        db,
        event_type=SIDEBAR_UPDATED,
        audience_type="user",
        audience_id=actor.id,
        payload=SidebarUpdatedData(sections=out, defaults=defaults).model_dump(mode="json"),
    )
    return out


async def _commit(db: AsyncSession, actor: User) -> list[SidebarSectionOut]:
    out = await _announce(db, actor)
    await db.commit()
    return out


async def _place(
    db: AsyncSession, actor: User, channel_id: uuid.UUID, section_id: uuid.UUID
) -> None:
    """Into the section (out of any other of mine) and out of お気に入り: one place per
    conversation."""
    await channels.require_member(db, actor.id, channel_id)
    await repo.place(db, actor.id, channel_id, section_id)
    await favorites.unstar_in_tx(db, actor.id, channel_id)


async def unplace_when_starred(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> None:
    """Registered with favorites: a starred conversation leaves my section (sidebar.updated when it
    was in one). The favorites transaction commits."""
    if await repo.unplace(db, actor.id, channel_id):
        await _announce(db, actor)


favorites.set_starred_hook(unplace_when_starred)


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
    # M26: the conversations chosen in the create form move here (only ones I am in), out of
    # another section of mine or お気に入り.
    for channel_id in dict.fromkeys(data.channel_ids):
        await _place(db, actor, channel_id, section.id)
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
    if data.sort is not None:
        section.sort = data.sort
    if data.manual_order is not None:
        section.manual_order = data.manual_order
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
    await _place(db, actor, channel_id, section.id)
    return await _commit(db, actor)


async def unplace(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> list[SidebarSectionOut]:
    await repo.unplace(db, actor.id, channel_id)
    return await _commit(db, actor)


async def update_default(
    db: AsyncSession, actor: User, key: DefaultSectionKey, data: SidebarDefaultUpdate
) -> list[SidebarDefaultOut]:
    """The sort / hand-made order of a default section; the whole sidebar goes out again."""
    row = await repo.default_section(db, actor.id, key)
    if row is None:
        row = SidebarDefaultSection(
            user_id=actor.id, key=key, sort=DEFAULT_SORTS[key], manual_order=[]
        )
        db.add(row)
    if data.sort is not None:
        row.sort = data.sort
    if data.manual_order is not None:
        row.manual_order = data.manual_order
    await _commit(db, actor)
    return await list_defaults(db, actor.id)
