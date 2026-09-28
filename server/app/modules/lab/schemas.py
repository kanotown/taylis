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
