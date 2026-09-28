from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.groups.models import UserGroup

# Same shape as usernames, so `@name` in the composer is unambiguous; a few words are taken.
NAME_PATTERN = r"^[a-z0-9][a-z0-9._-]{1,31}$"
RESERVED_NAMES = frozenset({"channel", "here", "everyone", "all", "group"})


def _check_name(value: str) -> str:
    if value in RESERVED_NAMES:
        raise ValueError("That name is reserved")
    return value


class GroupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=NAME_PATTERN)
    description: str | None = Field(default=None, max_length=200)
    member_ids: list[UUID] = Field(default_factory=list, max_length=200)

    _name = field_validator("name")(_check_name)


class GroupUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, pattern=NAME_PATTERN)
    description: str | None = Field(default=None, max_length=200)
    member_ids: list[UUID] | None = Field(default=None, max_length=200)

    @field_validator("name")
    @classmethod
    def name_not_reserved(cls, value: str | None) -> str | None:
        return None if value is None else _check_name(value)


class GroupOut(BaseModel):
    id: UUID
    name: str
    description: str | None
    member_ids: list[UUID]
    created_by: UUID
    created_at: datetime
    updated_at: datetime
    # M23: the members follow the lab roster; administrators cannot edit or delete it.
    managed: bool = False


class GroupUpdatedData(BaseModel):
    group: GroupOut
    deleted: bool = False


def to_group_out(group: UserGroup, member_ids: list[UUID]) -> GroupOut:
    return GroupOut(
        id=group.id,
        name=group.name,
        description=group.description,
        member_ids=member_ids,
        created_by=group.created_by,
        created_at=group.created_at,
        updated_at=group.updated_at,
        managed=group.managed_key is not None,
    )
