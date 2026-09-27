from datetime import datetime
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_LINKS = 30
MAX_URL_LENGTH = 2000


def _clean_title(value: str) -> str:
    cleaned = " ".join(value.split())
    if not cleaned:
        raise ValueError("A link needs a title")
    return cleaned


def _clean_url(value: str) -> str:
    """http(s) only: the clients open these, so javascript:, data: and friends never get in."""
    url = value.strip()
    if any(ch.isspace() or ord(ch) < 0x20 for ch in url):
        raise ValueError("A URL cannot contain spaces or control characters")
    parts = urlsplit(url)
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        raise ValueError("Only http and https links")
    return url


class LinkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=80)
    url: str = Field(min_length=1, max_length=MAX_URL_LENGTH)

    _title = field_validator("title")(_clean_title)
    _url = field_validator("url")(_clean_url)


class LinkUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=80)
    url: str | None = Field(default=None, min_length=1, max_length=MAX_URL_LENGTH)
    # The new index in the bar (0 = first); the others shift to make room.
    position: int | None = Field(default=None, ge=0, le=MAX_LINKS)

    @field_validator("title")
    @classmethod
    def title_clean(cls, value: str | None) -> str | None:
        return None if value is None else _clean_title(value)

    @field_validator("url")
    @classmethod
    def url_clean(cls, value: str | None) -> str | None:
        return None if value is None else _clean_url(value)


class ChannelLinkOut(BaseModel):
    id: UUID
    title: str
    url: str
    position: int
    created_by: UUID
    created_at: datetime


class ChannelLinksUpdatedData(BaseModel):
    """channel.links_updated: the conversation's whole link bar after a change."""

    channel_id: UUID
    links: list[ChannelLinkOut]
