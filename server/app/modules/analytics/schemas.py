"""Administrators' analytics (M116, docs/ANALYTICS.md §4). Counts and timestamps only: never a
message's text, never who talks to whom in a DM, never the name of a private channel the
administrator is not in."""

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel

MemberSort = Literal[
    "name", "role", "status", "created_at", "last_login_at", "last_active_at", "messages_30d"
]
MemberStatus = Literal["active", "deactivated"]


class MemberTotalsOut(BaseModel):
    """People (bots never count). `accounts`: not deactivated."""

    accounts: int
    admins: int
    guests: int
    deactivated: int
    active_1d: int
    active_7d: int
    active_30d: int
    new_in_period: int
    never_signed_in: int


class DayOut(BaseModel):
    """One day of the period in the requested time zone."""

    date: date
    messages: int
    active_members: int
    new_members: int


class ChannelStatOut(BaseModel):
    """A public channel, or a private one the asking administrator is a member of."""

    channel_id: uuid.UUID
    name: str
    type: Literal["public", "private"]
    archived: bool
    messages: int
    posters: int


class HiddenConversationsOut(BaseModel):
    """Conversations shown only as a total: how many had posts and how many posts."""

    conversations: int
    messages: int


class PosterOut(BaseModel):
    user_id: uuid.UUID
    username: str
    display_name: str
    messages: int


class AnalyticsOverviewOut(BaseModel):
    generated_at: datetime
    days: int
    tz: str
    start: date
    end: date
    members: MemberTotalsOut
    messages_in_period: int
    series: list[DayOut]
    top_channels: list[ChannelStatOut]
    other_private_channels: HiddenConversationsOut
    direct_messages: HiddenConversationsOut
    top_posters: list[PosterOut]


class AnalyticsMemberOut(BaseModel):
    id: uuid.UUID
    username: str
    display_name: str
    role: str
    status: MemberStatus
    created_at: datetime
    deactivated_at: datetime | None
    last_login_at: datetime | None
    last_active_at: datetime | None
    messages_30d: int
    devices: int
    platforms: list[str]


class AnalyticsMembersOut(BaseModel):
    items: list[AnalyticsMemberOut]
    total: int
    limit: int
    offset: int
