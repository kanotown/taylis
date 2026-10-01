from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.channels import service
from app.modules.channels.schemas import (
    ChannelCreate,
    ChannelOut,
    ChannelReadStateOut,
    ChannelUpdate,
    DmCreate,
    MemberAdd,
    MemberOut,
    MemberRoleUpdate,
)
from app.modules.reads.schemas import ReadAllIn, ReadMark, ReadStateOut
from app.modules.times_feed import service as times_feed

router = APIRouter(tags=["channels"])


async def _with_last_message(
    request: Request, db: Db, user: CurrentUser, listed: list[ChannelOut]
) -> list[ChannelOut]:
    """M49: `last_message` for the channels the user is a member of (never a non-member's
    public channel). The lookup comes from main.py (channels does not depend on messages)."""
    mine = [c.id for c in listed if c.membership is not None]
    if not mine:
        return listed
    visible = await service.visible_user_ids(db, user)
    last = await request.app.state.last_messages(db, mine, visible)
    return [
        c.model_copy(update={"last_message": last[c.id]}) if c.id in last else c for c in listed
    ]


@router.post("/channels", response_model=ChannelOut, status_code=201)
async def create_channel(user: CurrentUser, body: ChannelCreate, db: Db) -> ChannelOut:
    return await service.create_channel(db, user, body)


@router.get("/channels", response_model=list[ChannelOut])
async def list_channels(
    user: CurrentUser,
    db: Db,
    request: Request,
    include: Literal["public"] | None = Query(default=None),
) -> list[ChannelOut]:
    listed = await service.list_channels(db, user, include_public=include == "public")
    return await _with_last_message(request, db, user, listed)


@router.get("/channels/{channel_id}", response_model=ChannelOut)
async def get_channel(channel_id: UUID, user: CurrentUser, db: Db, request: Request) -> ChannelOut:
    channel = await service.get_channel(db, user, channel_id)
    return (await _with_last_message(request, db, user, [channel]))[0]


@router.patch("/channels/{channel_id}", response_model=ChannelOut)
async def update_channel(
    channel_id: UUID, user: CurrentUser, body: ChannelUpdate, db: Db
) -> ChannelOut:
    return await service.update_channel(db, user, channel_id, body)


@router.post("/channels/{channel_id}/archive", response_model=ChannelOut)
async def archive_channel(channel_id: UUID, user: CurrentUser, db: Db) -> ChannelOut:
    return await service.archive_channel(db, user, channel_id)


@router.post("/channels/{channel_id}/unarchive", response_model=ChannelOut)
async def unarchive_channel(channel_id: UUID, user: CurrentUser, db: Db) -> ChannelOut:
    """M13d: owner or administrator; posting works again afterwards."""
    return await service.unarchive_channel(db, user, channel_id)


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
async def add_member(
    channel_id: UUID, user: CurrentUser, body: MemberAdd, db: Db, request: Request
) -> MemberOut:
    (target,) = await service.load_users(db, [body.user_id])
    if target.role == "bot":
        # M65: an AI bot without allow_private stays out of private channels (400
        # ai_private_not_allowed). The check comes from main.py: channels does not depend on ai.
        channel, _ = await service.require_member(db, user.id, channel_id)
        await request.app.state.ai_private_guard(db, channel.type, [target.id])
    return await service.add_member(db, user, channel_id, target)


@router.patch("/channels/{channel_id}/members/{user_id}", response_model=MemberOut)
async def update_member(
    channel_id: UUID, user_id: UUID, body: MemberRoleUpdate, user: CurrentUser, db: Db
) -> MemberOut:
    """L4: make a member an owner or a member again (owners and administrators)."""
    return await service.update_member_role(db, user, channel_id, user_id, body.role)


@router.delete("/channels/{channel_id}/members/{user_id}", status_code=204)
async def remove_member(channel_id: UUID, user_id: UUID, user: CurrentUser, db: Db) -> None:
    await service.remove_member(db, user, channel_id, user_id)


@router.post("/times", response_model=ChannelOut)
async def ensure_times(
    user: CurrentUser, db: Db, request: Request, response: Response
) -> ChannelOut:
    """My times (M24): made on the first call (201), returned afterwards (200). The supervisors on
    the lab roster join it (the lookup is injected by main.py: channels does not depend on lab)."""
    followers = await request.app.state.times_followers(db, user.id)
    channel, created = await service.ensure_times(db, user, followers)
    response.status_code = 201 if created else 200
    return channel


@router.post("/dms", response_model=ChannelOut)
async def get_or_create_dm(
    user: CurrentUser, body: DmCreate, db: Db, request: Request, response: Response
) -> ChannelOut:
    participants = await service.load_users(db, body.user_ids)
    bots = [p.id for p in participants if p.role == "bot"]
    if bots:  # M65: a DM is private (see add_member)
        await request.app.state.ai_private_guard(db, "dm", bots)
    channel, created = await service.get_or_create_dm(db, user, participants)
    response.status_code = 201 if created else 200
    if created:
        return channel  # nothing said yet
    return (await _with_last_message(request, db, user, [channel]))[0]


@router.post("/channels/read-all", response_model=list[ChannelReadStateOut])
async def mark_all_read(
    user: CurrentUser, db: Db, body: ReadAllIn | None = None
) -> list[ChannelReadStateOut]:
    """M12a 「すべて既読にする」: every channel I belong to is read to its end; with scope "times"
    only the Times feed's channels (L8)."""
    only = None
    if body is not None and body.scope == "times":
        only = set(await times_feed.feed_channel_ids(db, user))
    return await service.mark_all_read(db, user, only=only)


@router.put("/channels/{channel_id}/read", response_model=ReadStateOut)
async def mark_read(channel_id: UUID, user: CurrentUser, body: ReadMark, db: Db) -> ReadStateOut:
    """Advance my read position (monotonic; SYNC_PROTOCOL.md §4.5 / §10)."""
    return await service.mark_read(db, user, channel_id, body)
