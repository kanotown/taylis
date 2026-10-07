from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from app.modules.messages.schemas import MessageOut


class HuddleCreate(BaseModel):
    """POST /channels/{id}/huddle. `client_msg_id` is the call message's idempotency key: a retry
    gets the same call and message back (with a fresh token)."""

    model_config = ConfigDict(extra="forbid")

    client_msg_id: UUID


class CallParticipantOut(BaseModel):
    user_id: UUID
    # When this person's current connection joined.
    joined_at: datetime


class CallOut(BaseModel):
    """An in-app call (M130, docs/CALLS.md §5.2)."""

    id: UUID
    channel_id: UUID
    message_id: UUID | None
    started_by: UUID
    started_at: datetime
    ended_at: datetime | None
    # Who is in it now (one entry per person, in the order they joined). Empty once ended.
    participants: list[CallParticipantOut] = []
    # People who were ever in it (distinct), and the most at once.
    participant_count: int = 0
    peak_participants: int = 0


class CallJoinOut(BaseModel):
    """What a client connects to LiveKit with (docs/CALLS.md §7.1): `url` is LIVEKIT_URL, `token`
    an access token for this call's room only, good until `expires_at` (10 minutes; needed only to
    connect). Never logged, never cached."""

    url: str
    token: str
    expires_at: datetime


class HuddleOut(BaseModel):
    call: CallOut
    # The call message (that of the call in progress when the conversation had one already).
    message: MessageOut
    join: CallJoinOut


class CallJoinedOut(BaseModel):
    call: CallOut
    join: CallJoinOut


class CallListOut(BaseModel):
    calls: list[CallOut]


class CallStateOut(BaseModel):
    call: CallOut
