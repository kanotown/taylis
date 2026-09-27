from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.messages.schemas import MAX_BODY_LENGTH, clean_body

MAX_DRAFTS = 500


class DraftOut(BaseModel):
    channel_id: UUID
    parent_id: UUID | None = None
    body: str
    updated_at: datetime


class DraftPut(BaseModel):
    """Save the text of one composer; send DELETE /drafts when it becomes empty."""

    model_config = ConfigDict(extra="forbid")

    channel_id: UUID
    parent_id: UUID | None = None
    body: str = Field(min_length=1, max_length=MAX_BODY_LENGTH)

    @field_validator("body")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        cleaned = clean_body(value)
        if not cleaned.strip():
            raise ValueError("An empty draft is deleted with DELETE /drafts")
        return cleaned


class DraftUpdatedData(DraftOut):
    """draft.updated: a draft saved or deleted (then `body` is empty) on one of my devices."""

    deleted: bool = False
