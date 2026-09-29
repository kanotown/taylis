from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator

from app.modules.attachments.schemas import AttachmentOut
from app.modules.messages.schemas import MAX_BODY_LENGTH, strip_control_chars


class ScheduledCreate(BaseModel):
    client_msg_id: UUID
    body: str = Field(default="", max_length=MAX_BODY_LENGTH)
    parent_id: UUID | None = None
    attachment_ids: list[UUID] = Field(default_factory=list, max_length=10)
    send_at: datetime

    @field_validator("body")
    @classmethod
    def _clean_body(cls, value: str) -> str:
        # The same cleaning as MessageCreate: a body this accepts must post when its time comes
        # (a body of control characters alone used to pass here and fail at the send).
        return strip_control_chars(value)

    @model_validator(mode="after")
    def _body_or_attachments(self) -> "ScheduledCreate":
        self.body = self.body.strip()
        if not self.body and not self.attachment_ids:
            raise ValueError("A message needs a body or an attachment")
        if self.send_at.tzinfo is None:
            raise ValueError("send_at needs a time zone")
        return self


class ScheduledOut(BaseModel):
    id: UUID
    channel_id: UUID
    parent_id: UUID | None
    client_msg_id: UUID
    body: str
    attachments: list[AttachmentOut]
    send_at: datetime
    status: Literal["pending", "sent", "failed", "cancelled"]
    error: str | None
    sent_message_id: UUID | None
    created_at: datetime


class ScheduledUpdatedData(BaseModel):
    scheduled: ScheduledOut
