from uuid import UUID

from fastapi import APIRouter

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.channel_links import service
from app.modules.channel_links.schemas import ChannelLinkOut, LinkCreate, LinkUpdate

router = APIRouter(tags=["channel links"])

# M15f: every call returns the conversation's whole link bar (it is small); the same list reaches
# the members as channel.links_updated.


@router.get("/channels/{channel_id}/links", response_model=list[ChannelLinkOut])
async def list_links(channel_id: UUID, user: CurrentUser, db: Db) -> list[ChannelLinkOut]:
    return await service.list_for(db, user, channel_id)


@router.post("/channels/{channel_id}/links", response_model=list[ChannelLinkOut], status_code=201)
async def add_link(
    channel_id: UUID, user: CurrentUser, body: LinkCreate, db: Db
) -> list[ChannelLinkOut]:
    """A new link at the end of the bar (at most 30; http / https only)."""
    return await service.create(db, user, channel_id, body)


@router.patch("/channels/{channel_id}/links/{link_id}", response_model=list[ChannelLinkOut])
async def update_link(
    channel_id: UUID, link_id: UUID, user: CurrentUser, body: LinkUpdate, db: Db
) -> list[ChannelLinkOut]:
    """Rename, change the URL, or move it (the others shift)."""
    return await service.update(db, user, channel_id, link_id, body)


@router.delete("/channels/{channel_id}/links/{link_id}", response_model=list[ChannelLinkOut])
async def delete_link(
    channel_id: UUID, link_id: UUID, user: CurrentUser, db: Db
) -> list[ChannelLinkOut]:
    return await service.delete(db, user, channel_id, link_id)
