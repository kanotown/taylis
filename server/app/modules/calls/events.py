"""M130 (docs/CALLS.md §5.3): a call's state, for the members of its conversation. No seq: a
client that missed one reads GET /calls?active=true after reconnecting (and the bootstrap's
active_calls). The record of a call is its message (message.created / message.updated with
change "call"), which has a seq."""

from pydantic import BaseModel

from app.modules.calls.schemas import CallOut

CALL_STARTED = "call.started"
CALL_UPDATED = "call.updated"
CALL_ENDED = "call.ended"


class CallEventData(BaseModel):
    # The whole call: clients replace theirs by id.
    call: CallOut
