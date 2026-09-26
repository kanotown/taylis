from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

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


class UserMe(UserPublic):
    email: str | None
    must_change_password: bool


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    email: str | None = Field(default=None, max_length=254, pattern=EMAIL_PATTERN)

    @field_validator("display_name")
    @classmethod
    def display_name_not_null(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("Display name cannot be null")
        return value


def to_user_public(user: User) -> UserPublic:
    return UserPublic(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        deactivated_at=user.deactivated_at,
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


def to_user_me(user: User) -> UserMe:
    return UserMe(
        **to_user_public(user).model_dump(),
        email=user.email,
        must_change_password=user.must_change_password,
    )
