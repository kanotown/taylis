import re
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.modules.messages.models import Message

MAX_BODY_LENGTH = 20_000
# Control characters other than newline and tab are stripped (SECURITY.md §5).
_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class MessageCreate(BaseModel):
    client_msg_id: UUID
    body: str = Field(min_length=1, max_length=MAX_BODY_LENGTH)

    @field_validator("body")
    @classmethod
    def _clean_body(cls, value: str) -> str:
        cleaned = _CONTROL_CHARS.sub("", value)
        if not cleaned.strip():
            raise ValueError("body must not be empty")
        return cleaned


class MessageOut(BaseModel):
    id: UUID
    channel_id: UUID
    sender_id: UUID
    seq: int
    updated_seq: int
    client_msg_id: UUID | None
    body: str
    created_at: datetime
    edited_at: datetime | None
    deleted: bool


class HistoryOut(BaseModel):
    channel_last_seq: int
    messages: list[MessageOut]
    has_more: bool


def to_message_out(message: Message) -> MessageOut:
    return MessageOut(
        id=message.id,
        channel_id=message.channel_id,
        sender_id=message.sender_id,
        seq=message.seq,
        updated_seq=message.updated_seq,
        client_msg_id=message.client_msg_id,
        body="" if message.is_deleted else message.body,
        created_at=message.created_at,
        edited_at=message.edited_at,
        deleted=message.is_deleted,
    )
