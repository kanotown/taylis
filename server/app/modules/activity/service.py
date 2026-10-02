"""Activity (M39): the feed, its summary and the read position (MOBILE_UI.md §7.2).

M76 (CANVAS.md §20): canvas mentions are items too, for the clients that ask for them by name
(`include=canvas_mention`): the phones of M39-M76 fail on an item without a message."""

from collections.abc import Collection
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.activity import repository as repo
from app.modules.activity.events import ACTIVITY_READ
from app.modules.activity.schemas import (
    ActivityCanvas,
    ActivityFilter,
    ActivityItem,
    ActivityListOut,
    ActivityReadData,
    ActivitySummaryOut,
)
from app.modules.messages.service import messages_out
from app.modules.users.models import User


def _item_key(item: ActivityItem) -> tuple[datetime, str, str]:
    """Newest first; ties in a fixed order (kind, then the message or the canvas item)."""
    ref = item.message.id if item.message else item.canvas.item_id if item.canvas else ""
    return item.at, item.kind, str(ref)


async def list_activity(
    db: AsyncSession,
    actor: User,
    *,
    kind: ActivityFilter,
    cursor: datetime | None,
    limit: int,
    include: Collection[str] = (),
) -> ActivityListOut:
    """Newest first, the kinds merged by time; `cursor` is the previous page's `next_cursor`.
    `include`: the kinds a client asks for by name (M76: canvas_mention, under all and
    mentions)."""
    items: list[ActivityItem] = []
    if "canvas_mention" in include and kind in ("all", "mentions"):
        for row, canvas in await repo.canvas_mentions(db, actor.id, before=cursor, limit=limit):
            items.append(
                ActivityItem(
                    kind="canvas_mention",
                    at=row.at,
                    canvas=ActivityCanvas(
                        item_id=row.id,
                        canvas_id=canvas.id,
                        channel_id=canvas.channel_id,
                        title=canvas.title,
                        excerpt=row.excerpt,
                        rev_id=row.rev_id,
                    ),
                    actor_ids=[row.actor_id],
                )
            )
    if kind in ("all", "mentions"):
        rows = await repo.mentions(db, actor.id, before=cursor, limit=limit)
        for message in await messages_out(db, rows, actor.id):
            items.append(
                ActivityItem(
                    kind="mention",
                    at=message.created_at,
                    message=message,
                    actor_ids=[message.sender_id],
                )
            )
    if kind in ("all", "threads"):
        rows = await repo.replies(db, actor.id, before=cursor, limit=limit)
        for message in await messages_out(db, rows, actor.id):
            items.append(
                ActivityItem(
                    kind="thread_reply",
                    at=message.created_at,
                    message=message,
                    actor_ids=[message.sender_id],
                )
            )
    if kind in ("all", "reactions"):
        groups = await repo.reactions(db, actor.id, before=cursor, limit=limit)
        messages = await repo.messages_by_ids(db, [g[0] for g in groups])
        shaped = {m.id: m for m in await messages_out(db, messages, actor.id)}
        for message_id, at, actors, emojis in groups:
            if message_id in shaped:
                items.append(
                    ActivityItem(
                        kind="reaction",
                        at=at,
                        message=shaped[message_id],
                        actor_ids=actors,
                        emojis=emojis,
                    )
                )
    items.sort(key=_item_key, reverse=True)
    page = items[:limit]
    full = len(items) >= limit
    return ActivityListOut(
        items=page,
        next_cursor=page[-1].at if page and full else None,
        read_at=actor.activity_read_at,
    )


async def summary(
    db: AsyncSession, actor: User, include: Collection[str] = ()
) -> ActivitySummaryOut:
    count, mention = await repo.unread(
        db, actor.id, actor.activity_read_at, canvas="canvas_mention" in include
    )
    return ActivitySummaryOut(
        read_at=actor.activity_read_at, unread_count=count, mention_unread=mention
    )


async def mark_read(
    db: AsyncSession,
    actor: User,
    read_at: datetime,
    include: Collection[str] = (),
) -> ActivitySummaryOut:
    """Moves the read position forward only (max-merge, like read states), never past now; my other
    devices follow."""
    target = min(read_at, utcnow())
    if target > actor.activity_read_at:
        actor.activity_read_at = target
        await write_outbox(
            db,
            event_type=ACTIVITY_READ,
            audience_type="user",
            audience_id=actor.id,
            payload=ActivityReadData(read_at=target).model_dump(mode="json"),
        )
        await db.commit()
    return await summary(db, actor, include)
