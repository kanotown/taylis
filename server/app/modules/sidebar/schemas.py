import re
from typing import get_args
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.emoji.schemas import TextEmojiColor

MAX_SECTIONS = 20
# M26: a custom emoji by name, or a few code points of emoji (a flag or a family is several).
_CUSTOM_EMOJI = re.compile(r"^:[a-z0-9_+-]{1,32}:$")
_MAX_EMOJI_CODEPOINTS = 16
# M114: a letter badge, `letter:<text>:<colour>` (DATA_MODEL.md sidebar_sections): one or two ASCII
# letters / digits, or one Japanese character (kana, kanji, 々), on a rounded square in a text emoji
# colour (apps/shared/text-emoji.json).
LETTER_PREFIX = "letter:"
_LETTER_TEXT = re.compile(
    r"[A-Za-z0-9]{1,2}|[\u3005\u3041-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff]"
)
_LETTER_COLORS = frozenset(get_args(TextEmojiColor))


def _clean_letter(value: str) -> str:
    parts = value[len(LETTER_PREFIX) :].split(":")
    if len(parts) != 2 or not _LETTER_TEXT.fullmatch(parts[0]) or parts[1] not in _LETTER_COLORS:
        raise ValueError(
            "A letter icon is letter:<1-2 letters or digits, or one Japanese character>:<colour>"
        )
    return value


def _clean_name(value: str) -> str:
    cleaned = " ".join(value.split())
    if not cleaned:
        raise ValueError("A section needs a name")
    return cleaned


def _clean_emoji(value: str | None) -> str | None:
    """An icon is one emoji (the clients pick it from the emoji picker), a custom emoji name or
    (M114) a letter badge; a flag or a keycap is several code points, so for an emoji only the
    length, spaces and control characters are checked."""
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if _CUSTOM_EMOJI.match(value):
        return value
    if value.startswith(LETTER_PREFIX):
        return _clean_letter(value)
    if len(value) > _MAX_EMOJI_CODEPOINTS or any(ch.isspace() or ord(ch) < 0x20 for ch in value):
        raise ValueError("The icon is one emoji or a custom emoji like :name:")
    return value


class SectionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=40)
    # M26 (Slack): the icon, and conversations to put in it at once (moved from other sections).
    emoji: str | None = Field(default=None, max_length=64)
    channel_ids: list[UUID] = Field(default_factory=list, max_length=500)

    _name = field_validator("name")(_clean_name)
    _emoji = field_validator("emoji")(_clean_emoji)


class SectionUpdate(BaseModel):
    """Only the fields sent change; `emoji: null` takes the icon off."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=40)
    emoji: str | None = Field(default=None, max_length=64)
    collapsed: bool | None = None
    # The new index among my sections (0 = first); others shift to make room.
    position: int | None = Field(default=None, ge=0, le=MAX_SECTIONS)

    @field_validator("name")
    @classmethod
    def name_clean(cls, value: str | None) -> str | None:
        return None if value is None else _clean_name(value)

    _emoji = field_validator("emoji")(_clean_emoji)


class SidebarSectionOut(BaseModel):
    id: UUID
    name: str
    # M26: the icon (an emoji, `:name:` or, M114, `letter:M:blue`), and whether it is folded up
    # on all my devices.
    emoji: str | None = None
    collapsed: bool = False
    position: int
    # Conversations placed here (clients order them like the default sections).
    channel_ids: list[UUID]


class SidebarUpdatedData(BaseModel):
    """The whole list after any change: small, and clients simply replace theirs."""

    sections: list[SidebarSectionOut]
