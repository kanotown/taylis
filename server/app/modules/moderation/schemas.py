from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

ReportReason = Literal["spam", "harassment", "inappropriate", "other"]
ReportStatus = Literal["open", "resolved"]

# How much of the reported body the report keeps (the admin screen shows it).
SNAPSHOT_MAX = 4000


class BlockOut(BaseModel):
    user_id: UUID
    created_at: datetime


class BlockStateOut(BaseModel):
    user_id: UUID
    blocked: bool


class BlockUpdatedData(BaseModel):
    """block.updated (audience: the blocker only): my other devices follow."""

    user_id: UUID
    blocked: bool


class ReportCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: ReportReason
    note: str | None = Field(default=None, max_length=1000)


class ReportAck(BaseModel):
    """What the reporter gets back: their own report only, never what others reported."""

    id: UUID
    message_id: UUID
    reason: ReportReason
    created_at: datetime


class AdminReportOut(BaseModel):
    id: UUID
    message_id: UUID
    channel_id: UUID
    channel_type: str
    # The channel's name; null for a DM / group DM.
    channel_name: str | None
    reporter_id: UUID
    reported_user_id: UUID
    reason: ReportReason
    note: str | None
    # The body when it was reported (the message may have changed or gone since).
    body_snapshot: str
    message_deleted: bool
    status: ReportStatus
    created_at: datetime
    resolved_at: datetime | None
    resolved_by: UUID | None


class AccountDeletion(BaseModel):
    """POST /users/me/delete-account: the current password, or for an account without one
    (Google sign-in) the username typed again."""

    model_config = ConfigDict(extra="forbid")

    password: str | None = Field(default=None, max_length=256)
    confirm_username: str | None = Field(default=None, max_length=64)
