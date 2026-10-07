"""Events emitted by the messages module (SYNC_PROTOCOL.md §6)."""

from typing import Literal

from pydantic import BaseModel

from app.modules.messages.schemas import MessageOut, ParentThread

MESSAGE_CREATED = "message.created"
MESSAGE_UPDATED = "message.updated"
MESSAGE_DELETED = "message.deleted"


class MessageCreatedData(BaseModel):
    message: MessageOut
    # Present for thread replies: the parent's counters moved to the same seq.
    parent_thread: ParentThread | None = None


class MessageUpdatedData(BaseModel):
    message: MessageOut
    # "collection" (L6): the submissions of a collecting post changed (a reply came or went).
    # "tasks" (L9): the shared tasks made from it changed (MessageOut.tasks).
    # "attachments" (M79): the server learned a video's size, length or poster (the backfill).
    # "call" (M130, docs/CALLS.md §5.4): the call it announces ended (MessageOut.call).
    change: Literal[
        "body", "reactions", "pin", "poll", "ack", "collection", "tasks", "attachments", "call"
    ]


class MessageDeletedData(BaseModel):
    """The tombstone: ``deleted`` is true and the body is empty."""

    message: MessageOut
    parent_thread: ParentThread | None = None
