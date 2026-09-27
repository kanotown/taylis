from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_SECTIONS = 20


def _clean_name(value: str) -> str:
    cleaned = " ".join(value.split())
    if not cleaned:
        raise ValueError("A section needs a name")
    return cleaned


class SectionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=40)

    _name = field_validator("name")(_clean_name)


class SectionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=40)
    # The new index among my sections (0 = first); others shift to make room.
    position: int | None = Field(default=None, ge=0, le=MAX_SECTIONS)

    @field_validator("name")
    @classmethod
    def name_clean(cls, value: str | None) -> str | None:
        return None if value is None else _clean_name(value)


class SidebarSectionOut(BaseModel):
    id: UUID
    name: str
    position: int
    # Conversations placed here (clients order them like the default sections).
    channel_ids: list[UUID]


class SidebarUpdatedData(BaseModel):
    """The whole list after any change: small, and clients simply replace theirs."""

    sections: list[SidebarSectionOut]
