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
    limit: int = Field(default=20, ge=1, le=100)
    offset: int = Field(default=0, ge=0, le=10_000)


class SearchHit(BaseModel):
    message: MessageOut
    score: float


class SearchOut(BaseModel):
    hits: list[SearchHit]
    # What PGroonga matched on: clients highlight these in the bodies themselves.
    keywords: list[str]
    limit: int
    offset: int
    has_more: bool
