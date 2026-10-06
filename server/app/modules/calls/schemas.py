from uuid import UUID

from pydantic import BaseModel, ConfigDict

from app.modules.messages.schemas import MessageOut


class CallCreate(BaseModel):
    """POST /channels/{id}/calls. `client_msg_id` is the message's idempotency key, as for any
    post: a retry gets the same call back."""

    model_config = ConfigDict(extra="forbid")

    client_msg_id: UUID


class CallOut(BaseModel):
    # The meeting room to open (the same as message.call.url).
    url: str
    # The message that announces the call in the conversation.
    message: MessageOut
