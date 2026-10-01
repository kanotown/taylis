from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.modules.canvases.schemas import CanvasMeta
from app.modules.channels.schemas import ChannelOut
from app.modules.messages.schemas import MessageOut

MAX_QUERY_LENGTH = 200


HasFlag = Literal["file", "link", "pin", "reaction", "poll"]
SearchSort = Literal["relevance", "newest"]


class SearchQuery(BaseModel):
    # Words and modifiers (from:@ in:# before: after: on: has: is:); may be empty when the
    # structured filters below say what to look for.
    q: str = Field(default="", max_length=MAX_QUERY_LENGTH)
    channel_id: UUID | None = None
    from_user_id: UUID | None = None
    after: datetime | None = None
    before: datetime | None = None
    # The same conditions as has: / is:thread, for filter menus that should not edit the words.
    has: list[HasFlag] = Field(default_factory=list, max_length=5)
    is_thread: bool = False
    # L8: only times channels (TIMES_FEED.md §6), the same as is:times in `q`.
    is_times: bool = False
    # relevance (default for words) or newest; searches without words are always newest first.
    sort: SearchSort = "relevance"
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
    # M15h: "has:" flags understood (file, link, pin, reaction, poll) and "is:thread".
    has: list[str] = Field(default_factory=list)
    is_thread: bool = False
    is_times: bool = False
    # Modifiers that named nothing the caller can see (unknown user / channel, bad date or flag).
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
    # How many messages match (counting stops past 1000: then total_capped is true).
    total: int = 0
    total_capped: bool = False
    # L8: the channels of hits that the caller is not a member of (public times found by
    # is:times), so clients can name them and open their preview.
    channels: list[ChannelOut] = Field(default_factory=list)


# --- canvases (M42, CANVAS.md §4.8) -------------------------------------------------------------


class CanvasSearchQuery(BaseModel):
    # Words and modifiers (from:@ in:# before: after: on:); has: / is: do not apply to canvases.
    q: str = Field(default="", max_length=MAX_QUERY_LENGTH)
    channel_id: UUID | None = None
    # The canvas's creator or its last editor.
    from_user_id: UUID | None = None
    # On the last update (updated_at).
    after: datetime | None = None
    before: datetime | None = None
    sort: SearchSort = "relevance"
    tz_offset_minutes: int = Field(default=0, ge=-840, le=840)
    limit: int = Field(default=20, ge=1, le=100)
    offset: int = Field(default=0, ge=0, le=10_000)


class CanvasSearchHit(BaseModel):
    canvas: CanvasMeta
    # Plain text around the first matching word of the body (about 60 characters on each side,
    # whitespace folded, "…" where cut); the start of the body when only the title matched.
    # Clients highlight `keywords` in it themselves (no HTML).
    snippet: str
    score: float


class CanvasSearchOut(BaseModel):
    hits: list[CanvasSearchHit]
    keywords: list[str]
    filters: SearchFilters
    limit: int
    offset: int
    has_more: bool
    # How many canvases match (counting stops past 1000: then total_capped is true).
    total: int = 0
    total_capped: bool = False
