"""Events emitted by the messages module (SYNC_PROTOCOL.md §6)."""

from typing import Literal

from pydantic import BaseModel

from app.modules.messages.schemas import MessageOut

MESSAGE_CREATED = "message.created"
MESSAGE_UPDATED = "message.updated"
MESSAGE_DELETED = "message.deleted"


class MessageCreatedData(BaseModel):
    message: MessageOut


class MessageUpdatedData(BaseModel):
    message: MessageOut
    change: Literal["body", "reactions", "pin"]


class MessageDeletedData(BaseModel):
    """The tombstone: ``deleted`` is true and the body is empty."""

    message: MessageOut
