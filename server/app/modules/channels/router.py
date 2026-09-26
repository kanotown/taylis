from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.channels import service
from app.modules.channels.schemas import (
    ChannelCreate,
    ChannelOut,
    ChannelUpdate,
    DmCreate,
    MemberAdd,
    MemberOut,
)
from app.modules.reads.schemas import ReadMark, ReadStateOut

router = APIRouter(tags=["channels"])


@router.post("/channels", response_model=ChannelOut, status_code=201)
async def create_channel(user: CurrentUser, body: ChannelCreate, db: Db) -> ChannelOut:
    return await service.create_channel(db, user, body)


@router.get("/channels", response_model=list[ChannelOut])
async def list_channels(
    user: CurrentUser,
    db: Db,
    include: Literal["public"] | None = Query(default=None),
) -> list[ChannelOut]:
    return await service.list_channels(db, user, include_public=include == "public")


@router.get("/channels/{channel_id}", response_model=ChannelOut)
async def get_channel(channel_id: UUID, user: CurrentUser, db: Db) -> ChannelOut:
    return await service.get_channel(db, user, channel_id)


@router.patch("/channels/{channel_id}", response_model=ChannelOut)
async def update_channel(
    channel_id: UUID, user: CurrentUser, body: ChannelUpdate, db: Db
) -> ChannelOut:
    return await service.update_channel(db, user, channel_id, body)


@router.post("/channels/{channel_id}/archive", response_model=ChannelOut)
async def archive_channel(channel_id: UUID, user: CurrentUser, db: Db) -> ChannelOut:
    return await service.archive_channel(db, user, channel_id)


@router.post("/channels/{channel_id}/join", response_model=ChannelOut)
async def join_channel(channel_id: UUID, user: CurrentUser, db: Db) -> ChannelOut:
    return await service.join_channel(db, user, channel_id)


@router.post("/channels/{channel_id}/leave", status_code=204)
async def leave_channel(channel_id: UUID, user: CurrentUser, db: Db) -> None:
    await service.leave_channel(db, user, channel_id)


@router.get("/channels/{channel_id}/members", response_model=list[MemberOut])
async def list_members(channel_id: UUID, user: CurrentUser, db: Db) -> list[MemberOut]:
    return await service.list_members(db, user, channel_id)


@router.post("/channels/{channel_id}/members", response_model=MemberOut)
async def add_member(channel_id: UUID, user: CurrentUser, body: MemberAdd, db: Db) -> MemberOut:
    (target,) = await service.load_users(db, [body.user_id])
    return await service.add_member(db, user, channel_id, target)


@router.delete("/channels/{channel_id}/members/{user_id}", status_code=204)
async def remove_member(channel_id: UUID, user_id: UUID, user: CurrentUser, db: Db) -> None:
    await service.remove_member(db, user, channel_id, user_id)


@router.post("/dms", response_model=ChannelOut)
async def get_or_create_dm(
    user: CurrentUser, body: DmCreate, db: Db, response: Response
) -> ChannelOut:
    participants = await service.load_users(db, body.user_ids)
    channel, created = await service.get_or_create_dm(db, user, participants)
    response.status_code = 201 if created else 200
    return channel


@router.put("/channels/{channel_id}/read", response_model=ReadStateOut)
async def mark_read(channel_id: UUID, user: CurrentUser, body: ReadMark, db: Db) -> ReadStateOut:
    """Advance my read position (monotonic; SYNC_PROTOCOL.md §4.5 / §10)."""
    return await service.mark_read(db, user, channel_id, body)
