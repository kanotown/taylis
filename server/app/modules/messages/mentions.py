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
