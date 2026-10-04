from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

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


class FeedBotCandidate(BaseModel):
    id: UUID
    username: str
    display_name: str
    active: bool


class FeedBotOut(BaseModel):
    """M98: the channel's feed bot (docs/FEEDS.md §3)."""

    bot_user_id: UUID | None = Field(
        description="The bot the channel's feeds post as; null before the first feed"
    )
    display_name: str | None = Field(description="Its name (「RSS」 unless renamed)")
    adopted: bool = Field(
        description="An administrator chose an existing bot (e.g. an imported one) for it: the "
        "feeds never deactivate it or take it out of the channel"
    )
    can_rename: bool = Field(description="The caller may rename it (channel owners, admins)")
    can_adopt: bool = Field(description="The caller may choose another bot for it (admins)")
    candidates: list[FeedBotCandidate] = Field(
        default_factory=list,
        description="For administrators: the bots that may become the feed bot (members of the "
        "channel or bots that posted in it, used by no webhook, AI, scheduled post, system "
        "bot or other channel's feeds)",
    )


class FeedBotUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(
        default=None,
        min_length=1,
        max_length=80,
        description="A new name for the channel's feed bot (channel owners, administrators)",
    )
    bot_user_id: UUID | None = Field(
        default=None,
        description="Administrators: make this bot (one of `candidates`) the channel's feed bot",
    )

    @field_validator("display_name")
    @classmethod
    def name_not_blank(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("The name cannot be blank")
        return cleaned
