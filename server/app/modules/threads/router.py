from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.messages import service as messages
from app.modules.messages.models import Message
from app.modules.messages.schemas import MessageOut
from app.modules.threads import repository as repo
from app.modules.threads import service
from app.modules.threads.schemas import ThreadFollowIn, ThreadListOut, ThreadRead, ThreadState
from app.modules.users.models import User

router = APIRouter(tags=["threads"])


async def _parent(db: AsyncSession, user: User, message_id: UUID) -> Message:
    """The thread's parent (a reply id is accepted too); membership is checked by `messages`."""
    message = await messages.get_message(db, user, message_id)
    if message.parent_id is not None:
        return await messages.get_message(db, user, message.parent_id)
    return message


@router.get("/threads", response_model=ThreadListOut)
async def list_threads(
    user: CurrentUser,
    db: Db,
    filter: Literal["all", "unread"] = "all",
    cursor: datetime | None = None,
    limit: int = Query(default=50, ge=1, le=100),
) -> ThreadListOut:
    """Threads I follow, newest reply first (THREADS.md §3). `cursor` is the previous page's
    `next_cursor`."""
    rows = await repo.list_followed(
        db, user.id, unread_only=filter == "unread", before=cursor, limit=limit
    )
    latest = await repo.latest_replies(
        db, user.id, [parent.id for parent, _ in rows], service.LATEST_REPLIES
    )
    # One messages_out for the parents and their previews: its lookups run once for the page.
    replies = [reply for parent, _ in rows for reply in latest.get(parent.id, [])]
    outs = await messages.messages_out(db, [parent for parent, _ in rows] + replies, user.id)
    parents, reply_outs = outs[: len(rows)], outs[len(rows) :]
    by_parent: dict[UUID, list[MessageOut]] = {}
    for out in reply_outs:
        assert out.parent_id is not None
        by_parent.setdefault(out.parent_id, []).append(out)
    return await service.list_threads(db, user.id, parents, rows, by_parent)


@router.get("/messages/{message_id}/thread", response_model=ThreadState)
async def get_thread_state(message_id: UUID, user: CurrentUser, db: Db) -> ThreadState:
    """My relation to one thread (follow flag, read position, counts); `following=false` and
    `last_read_seq=0` when I never touched it."""
    return await service.state_for(db, await _parent(db, user, message_id), user.id)


@router.put("/messages/{message_id}/thread/read", response_model=ThreadState)
async def mark_thread_read(
    message_id: UUID, user: CurrentUser, db: Db, body: ThreadRead
) -> ThreadState:
    """Monotonic: the newest reply `seq` the client has shown (THREADS.md §3)."""
    return await service.mark_read(
        db, await _parent(db, user, message_id), user.id, body.last_read_seq
    )


@router.put("/messages/{message_id}/thread/follow", response_model=ThreadState)
async def set_thread_follow(
    message_id: UUID, user: CurrentUser, db: Db, body: ThreadFollowIn
) -> ThreadState:
    """false removes the thread from the list and from the reply pushes; auto-follow never
    flips it back."""
    return await service.set_following(
        db, await _parent(db, user, message_id), user.id, body.following
    )
