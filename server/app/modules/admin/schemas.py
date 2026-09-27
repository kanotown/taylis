from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.modules.users.models import User

USERNAME_PATTERN = r"^[a-z0-9._-]{3,32}$"
EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"
Role = Literal["admin", "member", "guest"]  # guest (M13e): restricted to their channels


class AdminUserCreate(BaseModel):
    username: str = Field(pattern=USERNAME_PATTERN)
    display_name: str = Field(min_length=1, max_length=80)
    email: str | None = Field(default=None, max_length=254, pattern=EMAIL_PATTERN)
    role: Role = "member"


class AdminUserUpdate(BaseModel):
    role: Role | None = None
    deactivated: bool | None = None


class AdminUserOut(BaseModel):
    id: UUID
    username: str
    display_name: str
    email: str | None
    role: str
    must_change_password: bool
    totp_enabled: bool = False  # M12i
    deactivated_at: datetime | None
    created_at: datetime
    updated_at: datetime


class AdminUserCreated(BaseModel):
    user: AdminUserOut
    temporary_password: str


class TemporaryPasswordOut(BaseModel):
    temporary_password: str


def to_admin_out(user: User, *, totp_enabled: bool = False) -> AdminUserOut:
    return AdminUserOut(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        email=user.email,
        role=user.role,
        must_change_password=user.must_change_password,
        totp_enabled=totp_enabled,
        deactivated_at=user.deactivated_at,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )
