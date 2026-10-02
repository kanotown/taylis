"""M76 (CANVAS.md §20): canvas mentions as activity items.

The canvases module records one when a save newly mentions someone (the same rule as
canvas.mentioned, §18.1), in the save's transaction. Depends on models only (no import cycle with
the canvases module)."""

import re
import uuid
from collections.abc import Iterable
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.activity.models import CanvasMention
from app.modules.messages.mentions import MENTION_GROUP, MENTION_USER, notification_text

EXCERPT_LENGTH = 200
# Plain text kept before the mention when the line is long (the rest follows the mention).
EXCERPT_LEAD = 40
_WHOLE = 100_000
# A checklist item's box (`- [ ] `, `* [x] `): dropped like the list marker.
_TASK_BOX = re.compile(r"^[ \t]*[-*] \[[ xX]\][ \t]*")


def find_mention(
    body: str, user_id: uuid.UUID, groups_with_user: Iterable[uuid.UUID] = ()
) -> tuple[str, int] | None:
    """(the line, where in it) of the first direct mention of the person, else of the first
    mention of a group they are in; None when the body mentions neither."""
    lines = body.split("\n")
    for line in lines:
        for match in MENTION_USER.finditer(line):
            if uuid.UUID(match.group(1)) == user_id:
                return line, match.start()
    wanted = set(groups_with_user)
    if wanted:
        for line in lines:
            for match in MENTION_GROUP.finditer(line):
                if uuid.UUID(match.group(1)) in wanted:
                    return line, match.start()
    return None


def excerpt_around(line: str, position: int, names: dict[uuid.UUID, str]) -> str:
    """The line as one plain line (mentions as names, light Markdown dropped) starting a little
    before the mention, at most EXCERPT_LENGTH characters."""
    box = _TASK_BOX.match(line)
    start = box.end() if box is not None and box.end() <= position else 0
    head, tail = line[start:position], line[position:]
    before = notification_text(head, names, _WHOLE)
    after = notification_text(tail, names, _WHOLE)
    if len(before) > EXCERPT_LEAD:
        before = "…" + before[-EXCERPT_LEAD:].lstrip()
    gap = " " if before and head[-1:].isspace() else ""
    text = f"{before}{gap}{after}"
    return text[: EXCERPT_LENGTH - 1] + "…" if len(text) > EXCERPT_LENGTH else text


async def record(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    read_at: datetime,
    canvas_id: uuid.UUID,
    rev_id: uuid.UUID,
    actor_id: uuid.UUID,
    excerpt: str,
    at: datetime,
) -> None:
    """The person's item for this canvas: their unread one moves (one item per canvas while
    unread), else a new one. Saves of one canvas are serialised by its row lock."""
    unread = await db.scalar(
        select(CanvasMention)
        .where(
            CanvasMention.user_id == user_id,
            CanvasMention.canvas_id == canvas_id,
            CanvasMention.at > read_at,
        )
        .order_by(CanvasMention.at.desc())
        .limit(1)
    )
    if unread is None:
        db.add(
            CanvasMention(
                user_id=user_id,
                canvas_id=canvas_id,
                rev_id=rev_id,
                actor_id=actor_id,
                excerpt=excerpt,
                at=at,
            )
        )
    else:
        unread.rev_id, unread.actor_id, unread.excerpt, unread.at = rev_id, actor_id, excerpt, at
