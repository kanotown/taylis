import re
from typing import Literal, get_args
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.emoji.schemas import TextEmojiColor

MAX_SECTIONS = 20
# 2026-10-07 (DATA_MODEL.md sidebar_sections 「並べ替え」): how a section is ordered, and
# which default sections have their own sort. The clients sort (apps/shared/sidebar-order.json);
# the server only keeps the choice.
SidebarSort = Literal["name", "recent", "manual"]
DefaultSectionKey = Literal["favorites", "channels", "dms"]
DEFAULT_SORTS: dict[DefaultSectionKey, SidebarSort] = {
    "favorites": "name",
    "channels": "name",
    "dms": "recent",
}
MAX_MANUAL_ORDER = 1000
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


def _clean_order(value: list[UUID] | None) -> list[UUID] | None:
    """The hand-made order: each id once, the first place kept."""
    return None if value is None else list(dict.fromkeys(value))


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
    # 2026-10-07: the sort, and the hand-made order (the conversation ids in order) for "manual".
    sort: SidebarSort | None = None
    manual_order: list[UUID] | None = Field(default=None, max_length=MAX_MANUAL_ORDER)

    _order = field_validator("manual_order")(_clean_order)

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
    # Conversations placed here, in no meaningful order (the clients sort by `sort`).
    channel_ids: list[UUID]
    # 2026-10-07: name / recent / manual, and for manual the conversation ids in order (ids no
    # longer here are skipped; conversations not in it follow by name).
    sort: SidebarSort = "name"
    manual_order: list[UUID] = []


class SidebarDefaultOut(BaseModel):
    """The sort of a default section (お気に入り / チャンネル / ダイレクトメッセージ); always
    all three."""

    key: DefaultSectionKey
    sort: SidebarSort
    manual_order: list[UUID] = []


class SidebarDefaultUpdate(BaseModel):
    """Only the fields sent change."""

    model_config = ConfigDict(extra="forbid")

    sort: SidebarSort | None = None
    manual_order: list[UUID] | None = Field(default=None, max_length=MAX_MANUAL_ORDER)

    _order = field_validator("manual_order")(_clean_order)


class SidebarUpdatedData(BaseModel):
    """The whole list after any change: small, and clients simply replace theirs."""

    sections: list[SidebarSectionOut]
    # 2026-10-07: the default sections' sorts (all three); older servers sent none.
    defaults: list[SidebarDefaultOut] = []
