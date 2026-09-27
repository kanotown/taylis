from uuid import UUID

from fastapi import APIRouter

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.sidebar import service
from app.modules.sidebar.schemas import SectionCreate, SectionUpdate, SidebarSectionOut

router = APIRouter(tags=["sidebar"])

# Every call returns my whole list of sections (it is small); the same list reaches my other
# devices as sidebar.updated.


@router.get("/sidebar/sections", response_model=list[SidebarSectionOut])
async def list_sections(user: CurrentUser, db: Db) -> list[SidebarSectionOut]:
    return await service.list_for(db, user.id)


@router.post("/sidebar/sections", response_model=list[SidebarSectionOut], status_code=201)
async def create_section(user: CurrentUser, body: SectionCreate, db: Db) -> list[SidebarSectionOut]:
    """M14f: a new section at the end (at most 20)."""
    return await service.create(db, user, body)


@router.patch("/sidebar/sections/{section_id}", response_model=list[SidebarSectionOut])
async def update_section(
    section_id: UUID, user: CurrentUser, body: SectionUpdate, db: Db
) -> list[SidebarSectionOut]:
    """Rename, or move to another position (the others shift)."""
    return await service.update(db, user, section_id, body)


@router.delete("/sidebar/sections/{section_id}", response_model=list[SidebarSectionOut])
async def delete_section(section_id: UUID, user: CurrentUser, db: Db) -> list[SidebarSectionOut]:
    """Its conversations return to the default sections."""
    return await service.delete(db, user, section_id)


@router.put(
    "/sidebar/sections/{section_id}/channels/{channel_id}",
    response_model=list[SidebarSectionOut],
)
async def place_channel(
    section_id: UUID, channel_id: UUID, user: CurrentUser, db: Db
) -> list[SidebarSectionOut]:
    """Put a conversation I belong to in the section (moving it out of any other)."""
    return await service.place(db, user, section_id, channel_id)


@router.delete("/sidebar/channels/{channel_id}", response_model=list[SidebarSectionOut])
async def unplace_channel(channel_id: UUID, user: CurrentUser, db: Db) -> list[SidebarSectionOut]:
    """Back to the default sections."""
    return await service.unplace(db, user, channel_id)
