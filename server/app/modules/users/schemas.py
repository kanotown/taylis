from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.time import utcnow
from app.modules.users.models import User

EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class UserPublic(BaseModel):
    id: UUID
    username: str
    display_name: str
    role: str
    deactivated_at: datetime | None
    created_at: datetime
    updated_at: datetime
    # Profile card (M11d). An expired status is reported as no status.
    title: str | None = None
    status_text: str | None = None
    status_emoji: str | None = None
    status_expires_at: datetime | None = None


class UserMe(UserPublic):
    email: str | None
    must_change_password: bool


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    email: str | None = Field(default=None, max_length=254, pattern=EMAIL_PATTERN)
    # M11d: send null to clear. Omitted fields keep their value (model_fields_set).
    title: str | None = Field(default=None, max_length=80)
    status_text: str | None = Field(default=None, max_length=100)
    status_emoji: str | None = Field(default=None, max_length=32)
    status_expires_at: datetime | None = None

    @field_validator("display_name")
    @classmethod
    def display_name_not_null(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("Display name cannot be null")
        return value


def to_user_public(user: User, now: datetime | None = None) -> UserPublic:
    expired = user.status_expires_at is not None and user.status_expires_at <= (now or utcnow())
    return UserPublic(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        deactivated_at=user.deactivated_at,
        created_at=user.created_at,
        updated_at=user.updated_at,
        title=user.title,
        status_text=None if expired else user.status_text,
        status_emoji=None if expired else user.status_emoji,
        status_expires_at=None if expired else user.status_expires_at,
    )


def to_user_me(user: User) -> UserMe:
    return UserMe(
        **to_user_public(user).model_dump(),
        email=user.email,
        must_change_password=user.must_change_password,
    )
