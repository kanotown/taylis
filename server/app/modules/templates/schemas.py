from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.modules.templates.models import MessageTemplate

Scope = Literal["workspace", "user"]
SuggestIn = Literal["any", "times"]


class TemplateOut(BaseModel):
    id: UUID
    scope: Scope
    # The person whose own template it is; null for the workspace's.
    owner_id: UUID | None
    name: str
    body: str
    suggest_in: SuggestIn
    position: int
    created_at: datetime
    updated_at: datetime


class TemplateCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope: Scope = "user"
    name: str = Field(min_length=1, max_length=20)
    body: str = Field(min_length=1, max_length=4000)
    suggest_in: SuggestIn = "any"
    # Where it goes in the picker; the end when left out.
    position: int | None = Field(default=None, ge=0, le=10_000)


class TemplateUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=20)
    body: str | None = Field(default=None, min_length=1, max_length=4000)
    suggest_in: SuggestIn | None = None
    position: int | None = Field(default=None, ge=0, le=10_000)


class TemplateUpdatedData(BaseModel):
    template: TemplateOut
    deleted: bool


def to_template_out(row: MessageTemplate) -> TemplateOut:
    return TemplateOut(
        id=row.id,
        scope=row.scope,  # type: ignore[arg-type]
        owner_id=row.owner_id,
        name=row.name,
        body=row.body,
        suggest_in=row.suggest_in,  # type: ignore[arg-type]
        position=row.position,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )
