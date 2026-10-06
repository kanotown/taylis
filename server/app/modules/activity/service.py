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
    ActivityPage,
    ActivityReadData,
    ActivityReservation,
    ActivitySummaryOut,
)
from app.modules.messages.models import Message
from app.modules.messages.service import messages_out
from app.modules.reservations import repository as reservations_repo
from app.modules.users.models import User

# M120 (docs/WIKI.md §9.3): the wiki's kinds by the name a client asks for them, and the notice
# kind each one is.
PAGE_KINDS = {"page_mention": "mention", "page_shared": "shared"}


def _page_kinds(include: Collection[str], kind: str) -> list[str]:
    if kind not in ("all", "mentions"):
        return []
    return [notice for name, notice in PAGE_KINDS.items() if name in include]


def _item_key(item: ActivityItem) -> tuple[datetime, str, str]:
    """Newest first; ties in a fixed order (kind, then the message or the canvas item)."""
    ref: object = ""
    if item.message:
        ref = item.message.id
    elif item.canvas:
        ref = item.canvas.item_id
    elif item.reservation:
        ref = item.reservation.item_id
    elif item.page:
        ref = item.page.item_id
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
    read_at = actor.activity_read_at
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
                    read=row.at <= read_at,
                )
            )
    for page_notice, wiki_page in await repo.page_notices(
        db, actor, _page_kinds(include, kind), before=cursor, limit=limit
    ):
        items.append(
            ActivityItem(
                kind="page_mention" if page_notice.kind == "mention" else "page_shared",
                at=page_notice.at,
                page=ActivityPage(
                    item_id=page_notice.id,
                    page_id=wiki_page.id,
                    title=wiki_page.title,
                    icon=wiki_page.icon,
                    excerpt=page_notice.excerpt,
                    rev_id=page_notice.rev_id,
                    level=page_notice.level,  # type: ignore[arg-type]
                ),
                actor_ids=[page_notice.actor_id] if page_notice.actor_id else [],
                read=page_notice.at <= read_at,
            )
        )
    if "reservation" in include and kind == "all":
        for notice, pool_name in await reservations_repo.notices_for(
            db, actor.id, before=cursor, limit=limit
        ):
            items.append(
                ActivityItem(
                    kind="reservation",
                    at=notice.at,
                    reservation=ActivityReservation(
                        item_id=notice.id,
                        pool_id=notice.pool_id,
                        pool_name=pool_name,
                        reservation_id=notice.reservation_id,
                        text=notice.text,
                        operator=notice.operator,
                        done=notice.done_at is not None,
                        done_at=notice.done_at,
                        done_by=notice.done_by,
                    ),
                    actor_ids=[],
                    read=notice.at <= read_at or notice.done_at is not None,
                )
            )
    # Mentions and replies already read in their conversation are read here too (2026-10-06).
    mention_rows: list[Message] = []
    reply_rows: list[Message] = []
    if kind in ("all", "mentions"):
        mention_rows = await repo.mentions(db, actor.id, before=cursor, limit=limit)
    if kind in ("all", "threads"):
        reply_rows = await repo.replies(db, actor.id, before=cursor, limit=limit)
    seen = await repo.read_ids(
        db, actor.id, [m.id for m in (*mention_rows, *reply_rows) if m.created_at > read_at]
    )
    if mention_rows:
        for message in await messages_out(db, mention_rows, actor.id):
            items.append(
                ActivityItem(
                    kind="mention",
                    at=message.created_at,
                    message=message,
                    actor_ids=[message.sender_id],
                    read=message.created_at <= read_at or message.id in seen,
                )
            )
    if reply_rows:
        for message in await messages_out(db, reply_rows, actor.id):
            items.append(
                ActivityItem(
                    kind="thread_reply",
                    at=message.created_at,
                    message=message,
                    actor_ids=[message.sender_id],
                    read=message.created_at <= read_at or message.id in seen,
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
                        read=at <= read_at,
                    )
                )
    items.sort(key=_item_key, reverse=True)
    page = items[:limit]
    full = len(items) >= limit
    return ActivityListOut(
        items=page,
        next_cursor=page[-1].at if page and full else None,
        read_at=read_at,
    )


async def summary(
    db: AsyncSession, actor: User, include: Collection[str] = ()
) -> ActivitySummaryOut:
    count, mention = await repo.unread(
        db,
        actor.id,
        actor.activity_read_at,
        canvas="canvas_mention" in include,
        reservation="reservation" in include,
    )
    # M120: wiki notices are addressed to me, so they count as mentions (the red badge).
    pages = await repo.unread_page_notices(
        db, actor, _page_kinds(include, "all"), actor.activity_read_at
    )
    return ActivitySummaryOut(
        read_at=actor.activity_read_at,
        unread_count=min(count + pages, repo.UNREAD_CAP),
        mention_unread=mention or pages > 0,
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
