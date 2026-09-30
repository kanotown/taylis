from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.modules.notifications.schemas import NotificationPreferenceOut
from app.modules.reads.schemas import ReadStateOut

ChannelType = Literal["public", "private", "dm", "group_dm"]
CHANNEL_NAME_PATTERN = r"^[^\s#@/]{1,80}$"


class ChannelCreate(BaseModel):
    type: Literal["public", "private"] = "public"
    name: str = Field(min_length=1, max_length=80, pattern=CHANNEL_NAME_PATTERN)
    topic: str | None = Field(default=None, max_length=250)
    purpose: str | None = Field(default=None, max_length=250)


PostingPolicy = Literal["everyone", "owners"]


class ChannelUpdate(BaseModel):
    name: str | None = Field(
        default=None, min_length=1, max_length=80, pattern=CHANNEL_NAME_PATTERN
    )
    topic: str | None = Field(default=None, max_length=250)
    purpose: str | None = Field(default=None, max_length=250)
    # M15a: who may start top-level posts (thread replies stay open to every member).
    posting_policy: PostingPolicy | None = None
    # M15b: public → private (owner or admin), private → public (admin only).
    type: Literal["public", "private"] | None = None
    # M24: administrators mark a channel as someone's times, or null to unmark it.
    times_owner_id: UUID | None = None


class MembershipOut(BaseModel):
    role: str
    joined_at: datetime


class ChannelOut(BaseModel):
    id: UUID
    type: ChannelType
    name: str | None
    topic: str | None
    purpose: str | None
    archived: bool
    created_by: UUID | None
    last_seq: int
    last_message_at: datetime | None
    created_at: datetime
    updated_at: datetime
    membership: MembershipOut | None
    dm_user_ids: list[UUID] | None
    # Filled by the sync module for the requesting user (bootstrap); None elsewhere.
    notification: NotificationPreferenceOut | None = None
    read_state: ReadStateOut | None = None
    # M11h: how many people are in the channel (browser, intro); None where not computed.
    member_count: int | None = None
    # M15a: "owners" = an announcement channel (only owners / admins start top-level posts).
    posting_policy: PostingPolicy = "everyone"
    # M24: whose times this is; others see it as quiet unread (SYNC_PROTOCOL.md §10.5).
    times_owner_id: UUID | None = None
    # M41: the conversation's canvas tab (CANVAS.md §4.3). Filled by bootstrap only (null
    # elsewhere); afterwards the canvas.* events carry is_channel_tab.
    canvas_tab_id: UUID | None = None


class MemberOut(BaseModel):
    user_id: UUID
    role: str
    joined_at: datetime


class MemberAdd(BaseModel):
    user_id: UUID


class MemberRoleUpdate(BaseModel):
    """L4: PATCH /channels/{id}/members/{user_id}."""

    model_config = ConfigDict(extra="forbid")

    role: Literal["owner", "member"]


class DmCreate(BaseModel):
    user_ids: list[UUID] = Field(min_length=1, max_length=9)


class ChannelReadStateOut(BaseModel):
    """One channel's read state after POST /channels/read-all (M12a)."""

    channel_id: UUID
    last_read_seq: int
    unread_count: int
    mention_count: int
    first_unread_at: datetime | None = None
