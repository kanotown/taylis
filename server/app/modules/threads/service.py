"""Followed threads (THREADS.md). `messages` calls the *_in_tx hooks inside its own transaction
for replies; the router calls the rest. Every change fans out as thread.updated to each follower."""

import uuid
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.events.outbox import write_outbox
from app.modules.messages.models import Message
from app.modules.messages.schemas import MessageOut
from app.modules.threads import repository as repo
from app.modules.threads.events import (
    THREAD_UPDATED,
    THREADS_READ_ALL,
    ThreadsReadAllData,
    ThreadUpdatedData,
)
from app.modules.threads.models import ThreadFollow
from app.modules.threads.schemas import (
    ThreadItem,
    ThreadListOut,
    ThreadReadPosition,
    ThreadsReadAllOut,
    ThreadState,
    ThreadSummary,
)

Reason = Literal["reply", "deleted", "read", "follow"]

# How many of each thread's newest replies GET /threads previews (THREADS.md §5).
LATEST_REPLIES = 2


def _state(
    parent: Message,
    row: ThreadFollow | None,
    counts: tuple[int, int],
    participant_ids: list[uuid.UUID],
) -> ThreadState:
    return ThreadState(
        parent_id=parent.id,
        channel_id=parent.channel_id,
        following=row.following if row else False,
        last_read_seq=row.last_read_seq if row else 0,
        unread_count=counts[0],
        mention_count=counts[1],
        reply_count=parent.reply_count,
        last_reply_at=parent.last_reply_at,
        participant_ids=participant_ids,
    )


async def state_for(
    db: AsyncSession,
    parent: Message,
    user_id: uuid.UUID,
    participant_ids: list[uuid.UUID] | None = None,
) -> ThreadState:
    row = await repo.get(db, parent.id, user_id)
    counts = await repo.counts(db, parent.id, user_id, row.last_read_seq if row else 0)
    if participant_ids is None:
        participant_ids = await repo.followers(db, parent.id)
    return _state(parent, row, counts, participant_ids)


async def _emit(
    db: AsyncSession,
    parent: Message,
    user_id: uuid.UUID,
    reason: Reason,
    participant_ids: list[uuid.UUID],
) -> ThreadState:
    state = await state_for(db, parent, user_id, participant_ids)
    await write_outbox(
        db,
        event_type=THREAD_UPDATED,
        audience_type="user",
        audience_id=user_id,
        channel_id=parent.channel_id,
        payload=ThreadUpdatedData(reason=reason, **state.model_dump()).model_dump(mode="json"),
    )
    return state


async def _emit_to_followers(db: AsyncSession, parent: Message, reason: Reason) -> None:
    """One thread.updated per follower (each carries that person's own counts and position),
    from a single query for all of them."""
    states = await repo.follower_states(db, parent.id)
    followers = [row.user_id for row, _, _ in states]
    for row, unread, mentions in states:
        state = _state(parent, row, (unread, mentions), followers)
        await write_outbox(
            db,
            event_type=THREAD_UPDATED,
            audience_type="user",
            audience_id=row.user_id,
            channel_id=parent.channel_id,
            payload=ThreadUpdatedData(reason=reason, **state.model_dump()).model_dump(mode="json"),
        )


async def followers(db: AsyncSession, parent_id: uuid.UUID) -> list[uuid.UUID]:
    """Push targets and `parent_thread.participant_ids` for a reply (THREADS.md §4)."""
    return await repo.followers(db, parent_id)


async def unfollowed(db: AsyncSession, parent_id: uuid.UUID) -> list[uuid.UUID]:
    """Members who unfollowed the thread by hand: its replies never push to them."""
    return await repo.unfollowed(db, parent_id)


async def last_read_seqs(
    db: AsyncSession, parent_id: uuid.UUID, user_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    """The push planner's "already read" check for a reply: the thread's positions, not the
    channel's (a reply read on the desktop must not ring the phone)."""
    return await repo.last_read_seqs(db, parent_id, user_ids)


async def is_read(db: AsyncSession, user_id: uuid.UUID, parent_id: uuid.UUID, seq: int) -> bool:
    positions = await repo.last_read_seqs(db, parent_id, [user_id])
    return positions.get(user_id, 0) >= seq


async def on_reply_created_in_tx(db: AsyncSession, parent: Message, reply: Message) -> None:
    """Auto-follow (parent author, repliers, people mentioned in the thread), mark the replier's
    own reply read, then tell every follower about the thread's new state."""
    candidates = [
        parent.sender_id,
        reply.sender_id,
        *parent.mentioned_user_ids,
        *parent.keyword_user_ids,
        *reply.mentioned_user_ids,
        *reply.keyword_user_ids,
    ]
    # Mentions may name people outside the channel (or whole groups): only members follow.
    await repo.auto_follow(db, parent.id, await repo.member_ids(db, parent.channel_id, candidates))
    await repo.advance_read(db, parent.id, reply.sender_id, reply.seq)
    await _emit_to_followers(db, parent, "reply")


async def on_reply_deleted_in_tx(db: AsyncSession, parent: Message) -> None:
    await _emit_to_followers(db, parent, "deleted")


async def mark_read(db: AsyncSession, parent: Message, user_id: uuid.UUID, seq: int) -> ThreadState:
    """Monotonic and clamped to the newest reply; other devices follow via thread.updated."""
    newest = await repo.newest_reply_seq(db, parent.id)
    _, changed = await repo.advance_read(db, parent.id, user_id, min(seq, newest))
    followers = await repo.followers(db, parent.id)
    state = (
        await _emit(db, parent, user_id, "read", followers)
        if changed
        else await state_for(db, parent, user_id, followers)
    )
    await db.commit()
    return state


async def mark_all_read(db: AsyncSession, user_id: uuid.UUID) -> ThreadsReadAllOut:
    """POST /threads/read-all (THREADS.md §3): one transaction, one threads.read_all to my
    devices (not one thread.updated per thread: a person may follow hundreds of threads). No
    event when nothing moved, like a read that does not move."""
    moved = await repo.read_all(db, user_id)
    counts = await repo.counts_for_user(db, user_id, [parent_id for parent_id, _, _ in moved])
    threads = [
        ThreadReadPosition(
            parent_id=parent_id,
            channel_id=channel_id,
            last_read_seq=seq,
            unread_count=counts.get(parent_id, (0, 0))[0],
            mention_count=counts.get(parent_id, (0, 0))[1],
        )
        for parent_id, channel_id, seq in moved
    ]
    out = ThreadsReadAllOut(summary=await summary_for(db, user_id), threads=threads)
    if threads:
        await write_outbox(
            db,
            event_type=THREADS_READ_ALL,
            audience_type="user",
            audience_id=user_id,
            payload=ThreadsReadAllData(**out.model_dump()).model_dump(mode="json"),
        )
    await db.commit()
    return out


async def set_following(
    db: AsyncSession, parent: Message, user_id: uuid.UUID, following: bool
) -> ThreadState:
    _, changed = await repo.set_following(db, parent.id, user_id, following)
    followers = await repo.followers(db, parent.id)
    state = (
        await _emit(db, parent, user_id, "follow", followers)
        if changed
        else await state_for(db, parent, user_id, followers)
    )
    await db.commit()
    return state


async def list_threads(
    db: AsyncSession,
    user_id: uuid.UUID,
    parents_out: list[MessageOut],
    rows: list[tuple[Message, ThreadFollow]],
    latest_replies: dict[uuid.UUID, list[MessageOut]] | None = None,
) -> ThreadListOut:
    """Assemble the list from rows the router fetched (it owns the MessageOut mapping)."""
    parent_ids = [parent.id for parent, _ in rows]
    counts = await repo.counts_for_user(db, user_id, parent_ids)
    followers = await repo.followers_of(db, parent_ids)
    items = [
        ThreadItem(
            parent=out,
            state=_state(parent, row, counts.get(parent.id, (0, 0)), followers.get(parent.id, [])),
            latest_replies=(latest_replies or {}).get(parent.id, []),
        )
        for out, (parent, row) in zip(parents_out, rows, strict=True)
    ]
    next_cursor = rows[-1][0].last_reply_at if rows else None
    return ThreadListOut(
        items=items, next_cursor=next_cursor, summary=await summary_for(db, user_id)
    )


async def summary_for(db: AsyncSession, user_id: uuid.UUID) -> ThreadSummary:
    unread, mentions = await repo.summary(db, user_id)
    return ThreadSummary(unread_count=unread, mention_count=mentions)
