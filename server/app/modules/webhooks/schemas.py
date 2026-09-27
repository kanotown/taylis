from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.messages.schemas import MAX_BODY_LENGTH
from app.modules.webhooks.models import Webhook


class WebhookCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=80, description="Shown as the bot's name")
    channel_id: UUID


class WebhookUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=80)
    channel_id: UUID | None = None
    enabled: bool | None = None


class WebhookOut(BaseModel):
    id: UUID
    name: str
    channel_id: UUID
    bot_user_id: UUID
    created_by: UUID
    enabled: bool
    post_count: int
    last_post_at: datetime | None
    created_at: datetime
    updated_at: datetime


class WebhookCreated(BaseModel):
    """The token is shown once; the URL is `<server>/hooks/<token>`."""

    webhook: WebhookOut
    token: str = Field(repr=False)


class WebhookPost(BaseModel):
    """What a caller sends (Slack-shaped: `text`); `id` makes retries idempotent."""

    model_config = ConfigDict(extra="ignore")

    text: str = Field(min_length=1, max_length=MAX_BODY_LENGTH)
    id: UUID | None = None

    @field_validator("text")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text must not be blank")
        return value


class WebhookPosted(BaseModel):
    message_id: UUID


def to_webhook_out(row: Webhook) -> WebhookOut:
    return WebhookOut(
        id=row.id,
        name=row.name,
        channel_id=row.channel_id,
        bot_user_id=row.bot_user_id,
        created_by=row.created_by,
        enabled=row.enabled,
        post_count=row.post_count,
        last_post_at=row.last_post_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )
