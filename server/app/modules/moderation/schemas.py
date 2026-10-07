from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

# A message report's reason (child_safety since M119).
ReportReason = Literal["spam", "harassment", "inappropriate", "child_safety", "other"]
# POST /reports (M119): a report about a person or the app, or feedback.
ReportCategory = Literal["child_safety", "harassment", "inappropriate", "spam", "feedback", "other"]
ReportKind = Literal["message", "user", "general"]
ReportStatus = Literal["open", "resolved"]

# The longest note of a POST /reports (after trimming).
GENERAL_NOTE_MAX = 4000

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


class GeneralReportCreate(BaseModel):
    """POST /reports (M119, docs/MODERATION.md §3.1): a report about a person (`user_id`) or
    about anything else, or feedback. The note is required."""

    model_config = ConfigDict(extra="forbid")

    category: ReportCategory
    # 1 to 4000 characters after trimming.
    note: str = Field(max_length=GENERAL_NOTE_MAX * 2)
    user_id: UUID | None = None
    # The client's id of this report: a retried request returns the first report (200).
    client_report_id: UUID | None = None

    @field_validator("note")
    @classmethod
    def _trim_note(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("The note is required")
        if len(value) > GENERAL_NOTE_MAX:
            raise ValueError(f"The note is at most {GENERAL_NOTE_MAX} characters")
        return value


class GeneralReportAck(BaseModel):
    """What the reporter gets back: their own report only."""

    id: UUID
    category: ReportCategory
    user_id: UUID | None
    created_at: datetime


class AdminReportOut(BaseModel):
    id: UUID
    # What was reported (M119): a message, a person (`reported_user_id`) or neither (`general`:
    # a report about something else, or feedback). Only `message` has a message and a channel.
    kind: ReportKind = "message"
    message_id: UUID | None
    channel_id: UUID | None
    # The channel's type; "none" for a report without a message.
    channel_type: str
    # The channel's name; null for a DM / group DM and a report without a message.
    channel_name: str | None
    reporter_id: UUID
    # The message's author, or the reported person; null for a general report.
    reported_user_id: UUID | None
    # A message report's reason, or a POST /reports category (also `feedback`).
    reason: ReportCategory
    note: str | None
    # The body when it was reported (the message may have changed or gone since); "" without a
    # message.
    body_snapshot: str
    # M142 (docs/ROLES.md §4.3): true when the snapshot (and the channel name) is withheld from a
    # manager who cannot read that conversation; clients say only administrators can see it.
    snapshot_hidden: bool = False
    # The reported message is gone; false for a report without a message.
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
