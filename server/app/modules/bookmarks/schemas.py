from datetime import datetime
from uuid import UUID

from pydantic import BaseModel

from app.modules.messages.schemas import MessageOut


class BookmarkStateOut(BaseModel):
    message_id: UUID
    bookmarked: bool


class BookmarkItem(BaseModel):
    message: MessageOut
    created_at: datetime


class BookmarkListOut(BaseModel):
    items: list[BookmarkItem]
    # created_at of the last item; pass it back as `cursor` for the next page (null: no more).
    next_cursor: datetime | None


class BookmarkUpdatedData(BaseModel):
    message_id: UUID
    channel_id: UUID
    bookmarked: bool
