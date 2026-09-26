"""Mention tokens in message bodies (DATA_MODEL.md "本文の形式")."""

import re
import uuid

MENTION_USER = re.compile(r"<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>")
MENTION_ALL = re.compile(r"<!(channel|here)>")
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


_FENCE_LINE = re.compile(r"^```[A-Za-z0-9_+#.-]*\s*$", re.MULTILINE)
_HEADING = re.compile(r"^#{1,3}\s+", re.MULTILINE)
_QUOTE = re.compile(r"^>\s?", re.MULTILINE)
_LIST_MARKER = re.compile(r"^\s*(?:[-*•]|\d{1,3}\.)\s+", re.MULTILINE)
_INLINE = [
    (re.compile(r"\*\*([^*\n]+?)\*\*"), r"\1"),
    (re.compile(r"\*([^*\n]+)\*"), r"\1"),
    (re.compile(r"_([^_\n]+)_"), r"\1"),
    (re.compile(r"~~([^~\n]+)~~"), r"\1"),
    (re.compile(r"`([^`\n]+)`"), r"\1"),
    (re.compile(r"\[([^\]\n]+)\]\((https?://[^\s)]+)\)"), r"\1"),
]
_WHITESPACE = re.compile(r"\s*\n+\s*")


def notification_text(body: str, names: dict[uuid.UUID, str], max_length: int = 200) -> str:
    """One-line plain text for push and local notifications: mention tokens become display
    names (never raw ids), light markdown markers are dropped, newlines collapse."""

    def user_name(match: re.Match[str]) -> str:
        try:
            name = names.get(uuid.UUID(match.group(1)))
        except ValueError:
            name = None
        return "@" + (name or "メンバー")

    text = MENTION_USER.sub(user_name, body)
    text = MENTION_ALL.sub(lambda m: "@" + m.group(1), text)
    text = _FENCE_LINE.sub("", text)
    text = _HEADING.sub("", text)
    text = _QUOTE.sub("", text)
    text = _LIST_MARKER.sub("", text)
    for pattern, replacement in _INLINE:
        text = pattern.sub(replacement, text)
    text = _WHITESPACE.sub(" ", text).strip()
    return text[: max_length - 1] + "…" if len(text) > max_length else text
