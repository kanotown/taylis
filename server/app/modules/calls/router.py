from uuid import UUID

from fastapi import APIRouter, Request, Response

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.auth.deps import CurrentUser
from app.modules.calls import service
from app.modules.calls.schemas import CallCreate, CallOut
from app.modules.messages import service as messages

router = APIRouter(tags=["calls"])


@router.post("/channels/{channel_id}/calls", response_model=CallOut)
async def start_call(
    channel_id: UUID,
    user: CurrentUser,
    body: CallCreate,
    db: Db,
    request: Request,
    response: Response,
) -> CallOut:
    """M117 (docs/CALLS.md): start a call — a message 「📞 通話を始めました」 with a new meeting
    room's link (`message.call`). 201 when created, 200 for a retry with the same `client_msg_id`.
    403 not_a_member / posting_restricted / dm_unavailable, 409 channel_archived /
    calls_disabled / idempotency_conflict."""
    limiter = request.app.state.limiters["message"]  # counted as a post (SECURITY.md §5)
    key = str(user.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))
    message, created = await service.start_call(db, user, channel_id, body.client_msg_id)
    response.status_code = 201 if created else 200
    assert message.call_url is not None
    return CallOut(url=message.call_url, message=await messages.message_out(db, message, user.id))
