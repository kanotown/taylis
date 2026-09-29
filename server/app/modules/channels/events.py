"""Events emitted by the channels module (SYNC_PROTOCOL.md §6)."""

from uuid import UUID

from pydantic import BaseModel

from app.modules.channels.schemas import ChannelOut

CHANNEL_CREATED = "channel.created"
CHANNEL_UPDATED = "channel.updated"
CHANNEL_ARCHIVED = "channel.archived"
CHANNEL_MEMBER_ADDED = "channel.member_added"
CHANNEL_MEMBER_REMOVED = "channel.member_removed"
CHANNEL_MEMBER_UPDATED = "channel.member_updated"


class ChannelEventData(BaseModel):
    """``channel`` carries no per-recipient membership; ``member_ids`` lets a client tell
    whether it is a member (public channels are broadcast to everyone)."""

    channel: ChannelOut
    member_ids: list[UUID]


class ChannelArchivedData(BaseModel):
    channel_id: UUID


class ChannelMemberData(BaseModel):
    channel_id: UUID
    user_id: UUID


class ChannelMemberRoleData(BaseModel):
    """L4: a member's role in the channel changed (owner / member)."""

    channel_id: UUID
    user_id: UUID
    role: str
