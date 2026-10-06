from uuid import UUID

from fastapi import APIRouter

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.sidebar import service
from app.modules.sidebar.schemas import (
    DefaultSectionKey,
    SectionCreate,
    SectionUpdate,
    SidebarDefaultOut,
    SidebarDefaultUpdate,
    SidebarSectionOut,
)

router = APIRouter(tags=["sidebar"])

# Every call returns my whole list of sections (it is small); the same list reaches my other
# devices as sidebar.updated.


@router.get("/sidebar/sections", response_model=list[SidebarSectionOut])
async def list_sections(user: CurrentUser, db: Db) -> list[SidebarSectionOut]:
    return await service.list_for(db, user.id)


@router.post("/sidebar/sections", response_model=list[SidebarSectionOut], status_code=201)
async def create_section(user: CurrentUser, body: SectionCreate, db: Db) -> list[SidebarSectionOut]:
    """M14f: a new section at the end (at most 20). M26: the conversations in `channel_ids` move
    here from another section of mine or from お気に入り (they are unstarred: one place per
    conversation)."""
    return await service.create(db, user, body)


@router.patch("/sidebar/sections/{section_id}", response_model=list[SidebarSectionOut])
async def update_section(
    section_id: UUID, user: CurrentUser, body: SectionUpdate, db: Db
) -> list[SidebarSectionOut]:
    """Rename, move to another position (the others shift), fold, or change the sort / the
    hand-made order (`manual_order`, the conversation ids in order)."""
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
    """Put a conversation I belong to in the section (moving it out of any other). A starred one
    is unstarred (favorite.updated): one place per conversation."""
    return await service.place(db, user, section_id, channel_id)


@router.delete("/sidebar/channels/{channel_id}", response_model=list[SidebarSectionOut])
async def unplace_channel(channel_id: UUID, user: CurrentUser, db: Db) -> list[SidebarSectionOut]:
    """Back to the default sections."""
    return await service.unplace(db, user, channel_id)


@router.get("/sidebar/defaults", response_model=list[SidebarDefaultOut])
async def list_defaults(user: CurrentUser, db: Db) -> list[SidebarDefaultOut]:
    """The sorts of the default sections (お気に入り / チャンネル / ダイレクトメッセージ),
    all three."""
    return await service.list_defaults(db, user.id)


@router.patch("/sidebar/defaults/{key}", response_model=list[SidebarDefaultOut])
async def update_default(
    key: DefaultSectionKey, user: CurrentUser, body: SidebarDefaultUpdate, db: Db
) -> list[SidebarDefaultOut]:
    """Change a default section's sort or hand-made order; sidebar.updated carries it."""
    return await service.update_default(db, user, key, body)
