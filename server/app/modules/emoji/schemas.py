from datetime import datetime
from uuid import UUID

from pydantic import BaseModel

from app.modules.emoji.models import CustomEmoji


class CustomEmojiOut(BaseModel):
    id: UUID
    name: str
    content_type: str
    width: int
    height: int
    created_by: UUID
    created_at: datetime


class EmojiUpdatedData(BaseModel):
    emoji: CustomEmojiOut
    deleted: bool


def to_emoji_out(row: CustomEmoji) -> CustomEmojiOut:
    return CustomEmojiOut(
        id=row.id,
        name=row.name,
        content_type=row.content_type,
        width=row.width,
        height=row.height,
        created_by=row.created_by,
        created_at=row.created_at,
    )
