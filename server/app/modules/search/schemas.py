from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field

from app.modules.messages.schemas import MessageOut

MAX_QUERY_LENGTH = 200


class SearchQuery(BaseModel):
    q: str = Field(min_length=1, max_length=MAX_QUERY_LENGTH)
    channel_id: UUID | None = None
    from_user_id: UUID | None = None
    after: datetime | None = None
    before: datetime | None = None
    # The caller's UTC offset, used to interpret `before:` / `after:` / `on:` dates in the query.
    tz_offset_minutes: int = Field(default=0, ge=-840, le=840)
    limit: int = Field(default=20, ge=1, le=100)
    offset: int = Field(default=0, ge=0, le=10_000)


class SearchFilters(BaseModel):
    """What the server understood from the query: the free text and the resolved modifiers."""

    text: str
    from_username: str | None = None
    in_channel: str | None = None
    after: datetime | None = None
    before: datetime | None = None
    # Modifiers that named nothing the caller can see (unknown user / channel, bad date).
    unresolved: list[str] = Field(default_factory=list)


class SearchHit(BaseModel):
    message: MessageOut
    score: float


class SearchOut(BaseModel):
    hits: list[SearchHit]
    # What PGroonga matched on: clients highlight these in the bodies themselves.
    keywords: list[str]
    filters: SearchFilters
    limit: int
    offset: int
    has_more: bool
