from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.modules.feeds.models import MAX_URL_LENGTH


class FeedCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(
        min_length=1,
        max_length=MAX_URL_LENGTH,
        description="The feed's URL (RSS 2.0 / RSS 1.0 / Atom), or a page that names its feed "
        'with <link rel="alternate">',
    )


class FeedUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool | None = None


class FeedOut(BaseModel):
    id: UUID
    channel_id: UUID
    owner_id: UUID = Field(description="The member who registered it; posts name them")
    bot_user_id: UUID = Field(description="The channel's feed bot that posts the entries")
    url: str
    title: str | None
    site_url: str | None
    enabled: bool
    owner_active: bool = Field(
        description="False while the owner is deactivated or not a member: nothing is fetched"
    )
    can_manage: bool = Field(
        description="The caller may pause, resume and delete it (the owner, the channel's "
        "owners, administrators)"
    )
    last_fetched_at: datetime | None
    last_success_at: datetime | None
    last_error_code: str | None
    last_error: str | None
    consecutive_failures: int
    post_count: int
    last_post_at: datetime | None
    created_at: datetime
    updated_at: datetime
