"""Mention tokens in message bodies (DATA_MODEL.md "本文の形式")."""

import re
import uuid
from collections.abc import Callable, Sequence

from app import i18n

MENTION_USER = re.compile(r"<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>")
MENTION_ALL = re.compile(r"<!(channel|here)>")
MENTION_GROUP = re.compile(
    r"<@group:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>"
)  # M12k
MAX_MENTIONS = 50


def extract_mentions(body: str) -> tuple[list[uuid.UUID], bool]:
    """(mentioned user ids in order of first appearance, whether <!channel> / <!here> occurs)."""
    ids: list[uuid.UUID] = []
    for raw in MENTION_USER.findall(body):
        user_id = uuid.UUID(raw)
        if user_id not in ids:
            ids.append(user_id)
        if len(ids) >= MAX_MENTIONS:
            break
    return ids, MENTION_ALL.search(body) is not None


def extract_group_mentions(body: str) -> list[uuid.UUID]:
    """Group ids in order of first appearance (M12k); the members are resolved by `groups`."""
    ids: list[uuid.UUID] = []
    for raw in MENTION_GROUP.findall(body):
        group_id = uuid.UUID(raw)
        if group_id not in ids:
            ids.append(group_id)
    return ids


_FENCE_LINE = re.compile(r"^```[A-Za-z0-9_+#.-]*\s*$", re.MULTILINE)
_HEADING = re.compile(r"^#{1,3}\s+", re.MULTILINE)
_QUOTE = re.compile(r"^>\s?", re.MULTILINE)
_LIST_MARKER = re.compile(r"^\s*(?:[-*•]|\d{1,3}\.)\s+", re.MULTILINE)
# M107 (apps/shared/inline-format.json): the clients' inline tokenizer (markdown.ts INLINE),
# mention tokens left out (they are names by then). `_` emphasis is never inside a word (`\w` =
# a letter, digit or `_`, as the clients' `[\p{L}\p{N}_]`); URLs and e-mail addresses (and the
# shrug) are kept as they are, so their `_` `*` `~` stay; `\_` `\*` `\~` `\`` are the literal
# character, also inside emphasis.
_INLINE = re.compile(
    r"(\*\*((?:\\.|[^*\n\\])+?)\*\*)"
    r"|(``(?!`)(?:[^`\n]|`(?!`))+?``(?!`)|`([^`\n]+)`)"
    r"|(\*((?:\\.|[^*\n\\])+)\*)"
    r"|((?<!\w)_(?![\s\u3000_])((?:\\.|[^\n\\])*?(?:\\.|[^\s\u3000_\\]))_(?!\w))"
    r"|(~~((?:\\.|[^~\n\\])+)~~)"
    r"|(\[([^\]\n]+)\]\((https?://[^\s)]+)\))"
    r"|(https?://[^\s<>]+)"
    r"|(\\([_*~`]))"
    r"|([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}|¯\\_\(ツ\)_/¯)"
)
_ESCAPED = re.compile(r"\\([_*~`])")


_CURLY = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"'})


def _code_span(whole: str, single: str | None) -> str:
    """An inline code span's text (the clients' markdown.ts codeSpan): ``double`` spans may hold
    a backtick and lose one space at each end when they have one at both; quotes a keyboard
    curled (U+2018 U+2019 U+201C U+201D) are straight again."""
    if single is None:
        inner = whole[2:-2]
        if len(inner) >= 2 and inner[0] == " " and inner[-1] == " " and inner.strip():
            inner = inner[1:-1]
        single = inner
    return single.translate(_CURLY)


def _inline_text(match: re.Match[str]) -> str:
    """What a reader sees of one inline token: emphasis and code without their markers, a link's
    label, an escape's character; URLs and e-mail addresses as they are."""
    for whole, inner in ((1, 2), (5, 6), (7, 8), (9, 10)):
        if match.group(whole) is not None:
            return _ESCAPED.sub(r"\1", match.group(inner))
    if match.group(3) is not None:
        return _code_span(match.group(3), match.group(4))
    if match.group(11) is not None:
        return match.group(12)
    if match.group(15) is not None:
        return match.group(16)
    return match.group(0)


_WHITESPACE = re.compile(r"\s*\n+\s*")
# M15g: a table's separator rows vanish and each row becomes its cells joined by spaces.
_TABLE_SEPARATOR = re.compile(
    r"^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$", re.MULTILINE
)
_TABLE_ROW = re.compile(r"^[ \t]*\|(.*)\|[ \t]*$", re.MULTILINE)


def _table_cells(match: re.Match[str]) -> str:
    cells = match.group(1).replace("\\|", "\x00").split("|")
    return " ".join(cell.strip().replace("\x00", "|") for cell in cells)


def notification_text(
    body: str, names: dict[uuid.UUID, str], max_length: int = 200, locale: str = "ja"
) -> str:
    """One-line plain text for push and local notifications: mention tokens become display
    names (never raw ids; `names` maps user and group ids), light markdown markers are dropped,
    newlines collapse."""

    def named(fallback: str) -> Callable[[re.Match[str]], str]:
        def name_of(match: re.Match[str]) -> str:
            try:
                name = names.get(uuid.UUID(match.group(1)))
            except ValueError:
                name = None
            return "@" + (name or fallback)

        return name_of

    text = MENTION_USER.sub(named(i18n.t("member_fallback", locale)), body)
    # Group ids share the names map (M12k); an unknown one reads 「@グループ」 as on the clients.
    text = MENTION_GROUP.sub(named(i18n.t("group_fallback", locale)), text)
    text = MENTION_ALL.sub(lambda m: "@" + m.group(1), text)
    text = _TABLE_SEPARATOR.sub("", text)
    text = _TABLE_ROW.sub(_table_cells, text)
    text = _FENCE_LINE.sub("", text)
    text = _HEADING.sub("", text)
    text = _QUOTE.sub("", text)
    text = _LIST_MARKER.sub("", text)
    text = _INLINE.sub(_inline_text, text)
    text = _WHITESPACE.sub(" ", text).strip()
    return text[: max_length - 1] + "…" if len(text) > max_length else text


def attachment_text(attachments: Sequence[object], locale: str = "ja") -> str:
    """What a message without text sent, for notifications and one-line previews
    (tester, 2026-09-30: 「画像を送信」 rather than 「新しいメッセージ」). The clients use the
    same words: all images, all videos, or files; one, or how many. "" without attachments."""
    types = [
        str(a.get("content_type", "") if isinstance(a, dict) else getattr(a, "content_type", ""))
        for a in attachments
    ]
    n = len(types)
    if n == 0:
        return ""
    if all(t.startswith("image/") for t in types):
        kind = "image"
    elif all(t.startswith("video/") for t in types):
        kind = "video"
    else:
        kind = "file"
    if n == 1:
        return i18n.t(f"push.attachment.{kind}", locale)
    return i18n.t(f"push.attachment.{kind}s", locale, n=n)
