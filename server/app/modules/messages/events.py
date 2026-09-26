"""Events emitted by the messages module (SYNC_PROTOCOL.md §6)."""

from pydantic import BaseModel

from app.modules.messages.schemas import MessageOut

MESSAGE_CREATED = "message.created"


class MessageCreatedData(BaseModel):
    message: MessageOut
