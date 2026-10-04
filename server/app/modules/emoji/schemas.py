from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.modules.emoji.models import CustomEmoji, EmojiPack

EmojiKind = Literal["image", "text"]
# Text emoji colours (apps/shared/text-emoji.json holds the hex values each client draws).
TextEmojiColor = Literal["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"]


class CustomEmojiOut(BaseModel):
    id: UUID
    name: str
    # M100: "image" (the image at GET /emoji/{id}/image, `width` x `height`: wider than high is
    # drawn wider, at most 3:1) or "text" (`label` drawn as a pill in `color`; content_type is
    # "", width and height 0, no image).
    kind: EmojiKind = "image"
    content_type: str
    width: int
    height: int
    # M100: the display name (picker tooltip, e.g. 「おじぎ」); the text of a text emoji.
    label: str | None = None
    color: TextEmojiColor | None = None
    # M100: search terms for the picker and `:` completion (Japanese included).
    keywords: list[str] = []
    # M100: the pack (its own picker tab); null = the 「カスタム」 tab.
    pack_id: UUID | None = None
    position: int = 0
    created_by: UUID
    created_at: datetime


class EmojiUpdatedData(BaseModel):
    emoji: CustomEmojiOut
    deleted: bool


class TextEmojiCreate(BaseModel):
    """POST /emoji/text (M100): a label drawn as a pill instead of an image."""

    name: str = Field(max_length=64)
    label: str = Field(max_length=64)
    color: TextEmojiColor | None = None
    keywords: list[str] = Field(default=[], max_length=50)


class CustomEmojiUpdate(BaseModel):
    """PATCH /emoji/{id} (M100): only the fields sent change. `pack_id` and `position` are for
    administrators; the rest for the creator or an administrator."""

    label: str | None = Field(default=None, max_length=64)
    color: TextEmojiColor | None = None
    keywords: list[str] | None = Field(default=None, max_length=50)
    pack_id: UUID | None = None
    position: int | None = Field(default=None, ge=0, le=100_000)


class EmojiPackOut(BaseModel):
    id: UUID
    name: str
    position: int
    # The tab icon at GET /emoji/packs/{id}/tab when not null; the value changes with the
    # icon (a cache key). Null: clients show the pack's first emoji.
    tab_version: str | None
    created_at: datetime
    updated_at: datetime


class EmojiPackUpdatedData(BaseModel):
    pack: EmojiPackOut
    deleted: bool


class EmojiPackCreate(BaseModel):
    name: str = Field(max_length=200)


class EmojiPackUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    position: int | None = Field(default=None, ge=0, le=100_000)


class EmojiPackImportOut(BaseModel):
    """POST /emoji/packs/import: the pack and what happened to each shortcode."""

    pack: EmojiPackOut
    created: list[str]
    updated: list[str]
    unchanged: list[str]


def to_emoji_out(row: CustomEmoji) -> CustomEmojiOut:
    return CustomEmojiOut(
        id=row.id,
        name=row.name,
        kind=row.kind,  # type: ignore[arg-type]
        content_type=row.content_type,
        width=row.width,
        height=row.height,
        label=row.label,
        color=row.color,  # type: ignore[arg-type]
        keywords=list(row.keywords or []),
        pack_id=row.pack_id,
        position=row.position or 0,
        created_by=row.created_by,
        created_at=row.created_at,
    )


def to_pack_out(row: EmojiPack) -> EmojiPackOut:
    version = None
    if row.tab_storage_key:
        version = row.tab_storage_key.rsplit("/", 1)[-1].removeprefix("tab-")
    return EmojiPackOut(
        id=row.id,
        name=row.name,
        position=row.position,
        tab_version=version,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )
