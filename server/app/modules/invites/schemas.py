from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.admin.schemas import USERNAME_PATTERN, Role
from app.modules.auth.schemas import DeviceCreate
from app.modules.invites.models import Invite

InviteStatus = Literal["active", "expired", "exhausted", "revoked"]


class InviteCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Role = "member"
    # Joined on acceptance: public channels, or private ones the issuing admin belongs to.
    channel_ids: list[UUID] = Field(default_factory=list, max_length=20)
    note: str | None = Field(default=None, max_length=80, description="Who it is for")
    max_uses: int | None = Field(default=1, ge=1, le=100, description="null = unlimited")
    expires_in_hours: int = Field(default=168, ge=1, le=720)


class InviteOut(BaseModel):
    id: UUID
    created_by: UUID
    role: str
    channel_ids: list[UUID]
    note: str | None
    max_uses: int | None
    use_count: int
    used_by: list[UUID]
    expires_at: datetime
    revoked_at: datetime | None
    created_at: datetime
    status: InviteStatus


class InviteCreated(BaseModel):
    """The token is shown once; clients build `<server>/invite/<token>` from it."""

    invite: InviteOut
    token: str = Field(repr=False)


class InvitePreviewOut(BaseModel):
    """What an invitee sees before choosing a username (no login)."""

    invited_by: str
    role: str
    channels: list[str]
    expires_at: datetime
    password_min_length: int


class InviteAccept(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(pattern=USERNAME_PATTERN)
    display_name: str = Field(min_length=1, max_length=80)
    # The minimum length is a server setting (password_min_length) checked in the service.

    @field_validator("display_name")
    @classmethod
    def _display_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("display_name must not be blank")
        return cleaned

    password: str = Field(min_length=1, max_length=128, repr=False)
    device: DeviceCreate


def status_of(invite: Invite, now: datetime) -> InviteStatus:
    if invite.revoked_at is not None:
        return "revoked"
    if invite.expires_at <= now:
        return "expired"
    if invite.max_uses is not None and invite.use_count >= invite.max_uses:
        return "exhausted"
    return "active"


def to_invite_out(invite: Invite, now: datetime) -> InviteOut:
    return InviteOut(
        id=invite.id,
        created_by=invite.created_by,
        role=invite.role,
        channel_ids=list(invite.channel_ids or []),
        note=invite.note,
        max_uses=invite.max_uses,
        use_count=invite.use_count,
        used_by=list(invite.used_by or []),
        expires_at=invite.expires_at,
        revoked_at=invite.revoked_at,
        created_at=invite.created_at,
        status=status_of(invite, now),
    )
