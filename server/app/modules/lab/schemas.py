from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.modules.lab.models import LabProfile

Affiliation = Literal["faculty", "student", "alumni", "other"]
Rank = Literal["professor", "associate_professor", "lecturer", "assistant_professor"]
Grade = Literal["B3", "B4", "M1", "M2", "D1", "D2", "D3"]


class LabProfilePut(BaseModel):
    """An administrator's line for someone (PUT /lab/roster/{user_id}). Affiliation, rank, grade and
    supervisor are replaced as sent; the research topic and reading, which the person may edit
    too, change only when sent."""

    model_config = ConfigDict(extra="forbid")

    affiliation: Affiliation
    rank: Rank | None = None
    grade: Grade | None = None
    supervisor_id: UUID | None = None
    research_topic: str | None = Field(default=None, max_length=200)
    reading: str | None = Field(default=None, max_length=80)

    @model_validator(mode="after")
    def fits_affiliation(self) -> "LabProfilePut":
        if self.rank is not None and self.affiliation != "faculty":
            raise ValueError("A rank is for faculty only")
        if self.grade is not None and self.affiliation != "student":
            raise ValueError("A grade is for students only")
        return self


class LabPreset(BaseModel):
    """L7: the roster line an invite link gives on acceptance (and whether to make a times)."""

    model_config = ConfigDict(extra="forbid")

    affiliation: Affiliation
    rank: Rank | None = None
    grade: Grade | None = None
    supervisor_id: UUID | None = None
    times: bool = False

    @model_validator(mode="after")
    def fits_affiliation(self) -> "LabPreset":
        if self.rank is not None and self.affiliation != "faculty":
            raise ValueError("A rank is for faculty only")
        if self.grade is not None and self.affiliation != "student":
            raise ValueError("A grade is for students only")
        return self

    def as_put(self) -> LabProfilePut:
        return LabProfilePut(
            affiliation=self.affiliation,
            rank=self.rank,
            grade=self.grade,
            supervisor_id=self.supervisor_id,
        )


class MyLabProfileUpdate(BaseModel):
    """What people change on their own line (PATCH /lab/roster/me); null clears."""

    model_config = ConfigDict(extra="forbid")

    research_topic: str | None = Field(default=None, max_length=200)
    reading: str | None = Field(default=None, max_length=80)


class LabProfileOut(BaseModel):
    user_id: UUID
    affiliation: Affiliation
    rank: Rank | None
    grade: Grade | None
    supervisor_id: UUID | None
    research_topic: str | None
    reading: str | None
    updated_at: datetime


class RosterUpdatedData(BaseModel):
    """`roster.updated`: the person's line, or null when they left the roster."""

    user_id: UUID
    profile: LabProfileOut | None


def to_profile_out(row: LabProfile) -> LabProfileOut:
    return LabProfileOut(
        user_id=row.user_id,
        affiliation=row.affiliation,  # type: ignore[arg-type]
        rank=row.rank,  # type: ignore[arg-type]
        grade=row.grade,  # type: ignore[arg-type]
        supervisor_id=row.supervisor_id,
        research_topic=row.research_topic,
        reading=row.reading,
        updated_at=row.updated_at,
    )


# --- yearly rollover (L7) ----------------------------------------------------------------------

RolloverAction = Literal["advance", "stay", "graduate"]


class RolloverChannelOut(BaseModel):
    id: UUID
    name: str | None
    type: str


class RolloverPreviewItem(BaseModel):
    """A student on the roster, with the proposed step and the channels a graduate would leave."""

    user_id: UUID
    grade: Grade | None
    action: RolloverAction
    next_grade: Grade | None
    times_channel_id: UUID | None
    channels: list[RolloverChannelOut]


class RolloverPreviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    academic_year: int = Field(ge=2000, le=2100)


class RolloverPreviewOut(BaseModel):
    academic_year: int
    # Set when this year's rollover is in force (applying again is 409 until it is undone).
    applied_at: datetime | None
    items: list[RolloverPreviewItem]


class RolloverItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: UUID
    action: RolloverAction
    # A graduate becomes a guest (sees only the channels they stay in).
    guest: bool = False
    # A graduate stays in these channels (a paper still being written…); the rest are left.
    keep_channel_ids: list[UUID] = Field(default_factory=list, max_length=50)


class RolloverApply(BaseModel):
    model_config = ConfigDict(extra="forbid")

    academic_year: int = Field(ge=2000, le=2100)
    items: list[RolloverItem] = Field(min_length=1, max_length=200)
    # Graduates join it (#alumni), and stay in it.
    alumni_channel_id: UUID | None = None


class RolloverOut(BaseModel):
    academic_year: int
    applied_by: UUID
    applied_at: datetime
    undone_at: datetime | None
    advanced: int
    stayed: int
    graduated: int
