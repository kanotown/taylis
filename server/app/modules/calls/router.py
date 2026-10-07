"""In-app calls on LiveKit (M130, docs/CALLS.md §5.2) and the end of M117's calls endpoint."""

import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response
from fastapi.security.utils import get_authorization_scheme_param

from app.core.db import Db
from app.core.errors import AppError, bad_request, rate_limited
from app.core.security import decode_access_token
from app.modules.auth import repository as auth_repo
from app.modules.auth.deps import CurrentUser
from app.modules.auth.models import Device
from app.modules.calls import service
from app.modules.calls.livekit import InvalidWebhook, verify_webhook
from app.modules.calls.schemas import (
    CallJoinedOut,
    CallListOut,
    CallStateOut,
    HuddleCreate,
    HuddleOut,
)
from app.modules.messages import service as messages

router = APIRouter(tags=["calls"])
log = logging.getLogger("app.calls")

NO_STORE = {"Cache-Control": "no-store"}


def _runtime(request: Request) -> service.CallsRuntime | None:
    rt: service.CallsRuntime | None = request.app.state.calls
    return rt


def _limit(request: Request, name: str, key: str) -> None:
    limiter = request.app.state.limiters[name]
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))


async def _platform(request: Request, db: Db) -> str | None:
    """The platform of the device this request's session belongs to (screen sharing is not in
    the iOS / Android tokens, §7.1); None when it cannot be told."""
    scheme, token = get_authorization_scheme_param(request.headers.get("Authorization"))
    if scheme.lower() != "bearer" or not token:
        return None
    try:
        claims = decode_access_token(token, request.app.state.settings.secret_key)
        session = await auth_repo.get_session(db, claims.session_id)
        device = await db.get(Device, session.device_id) if session is not None else None
    except Exception:
        return None
    return device.platform if device is not None else None


@router.post("/channels/{channel_id}/huddle", response_model=HuddleOut, status_code=201)
async def start_or_join(
    channel_id: UUID,
    user: CurrentUser,
    body: HuddleCreate,
    db: Db,
    request: Request,
    response: Response,
) -> HuddleOut:
    """Start the conversation's call, or join the one in progress (docs/CALLS.md §5.2). 201 when
    a call was started (its message is posted: message.created, push, call.started); 200 for a
    retry with the same `client_msg_id` or when a call was already in progress (no new message,
    `message` is that call's). `join` = the LiveKit URL and a 10-minute token for this call only.
    403 not_a_member / posting_restricted (an announcement channel: owners and administrators
    start, everyone joins) / dm_unavailable (a 1:1 DM with a block either way) / forbidden
    (bots), 409 channel_archived / calls_disabled / call_full / call_ended (a retry of an ended
    call) / idempotency_conflict, 503 calls_unavailable (LiveKit cannot be reached: nothing is
    posted), 429 rate_limited (10 starts a minute)."""
    _limit(request, "call_start", str(user.id))
    result = await service.huddle(
        db, _runtime(request), user, channel_id, body.client_msg_id, await _platform(request, db)
    )
    response.status_code = 201 if result.created else 200
    response.headers.update(NO_STORE)
    return HuddleOut(
        call=await service.call_out(db, result.call),
        message=await messages.message_out(db, result.message, user.id),
        join=result.join,
    )


@router.post("/calls/{call_id}/join", response_model=CallJoinedOut)
async def join_call(
    call_id: UUID, user: CurrentUser, db: Db, request: Request, response: Response
) -> CallJoinedOut:
    """A token to join or reconnect (after the 10 minutes of the last one). 404 call_not_found,
    403 not_a_member / dm_unavailable / forbidden, 409 call_ended / call_full / channel_archived
    / calls_disabled (no LiveKit on this server), 429 rate_limited (30 a minute)."""
    _limit(request, "call_join", str(user.id))
    call, join = await service.join(
        db, _runtime(request), user, call_id, await _platform(request, db)
    )
    response.headers.update(NO_STORE)
    return CallJoinedOut(call=await service.call_out(db, call), join=join)


@router.post("/calls/{call_id}/leave", status_code=204)
async def leave_call(call_id: UUID, user: CurrentUser, db: Db, request: Request) -> Response:
    """Hung up: LiveKit drops this person's connection (in case the client could not) and the
    call shows them gone (call.updated). Idempotent; an ended call is fine."""
    await service.leave(db, _runtime(request), user, call_id)
    return Response(status_code=204)


@router.get("/calls/{call_id}", response_model=CallStateOut)
async def get_call(call_id: UUID, user: CurrentUser, db: Db) -> CallStateOut:
    """A call and who is in it. Members of its conversation only (403 not_a_member)."""
    call, _ = await service.require_call(db, user, call_id)
    return CallStateOut(call=await service.call_out(db, call))


@router.get("/calls", response_model=CallListOut)
async def list_calls(
    user: CurrentUser,
    db: Db,
    active: Annotated[bool, Query(description="Only true is supported")] = True,
) -> CallListOut:
    """The calls in progress in my conversations (what a client reads after reconnecting: the
    call.* events have no seq)."""
    if not active:
        raise bad_request("validation_error", "Only active=true is supported")
    return CallListOut(calls=await service.active_calls(db, user))


@router.post("/channels/{channel_id}/calls", deprecated=True, status_code=409)
async def legacy_start_call(channel_id: UUID, user: CurrentUser) -> None:
    """M117's calls by meeting link, retired by M130 (docs/CALLS.md §11): always 409
    calls_disabled, so that the released M117 clients hide their 📞."""
    raise service.calls_disabled()


@router.post("/livekit/webhook", include_in_schema=False)
async def livekit_webhook(request: Request, db: Db) -> dict[str, str]:
    """LiveKit's webhook (§3.2). Only reachable inside the compose network (Caddy answers 404 for
    /api/v1/livekit/* from outside); the signature is checked anyway. 401 when it does not
    verify; 200 for anything verified (unknown rooms and events included)."""
    rt = _runtime(request)
    if rt is None:
        raise AppError(404, "not_found", "Not found")
    body = await request.body()
    try:
        event = verify_webhook(rt.config, body, request.headers.get("Authorization"))
    except InvalidWebhook as exc:
        log.warning("rejected a LiveKit webhook: %s", exc)
        raise AppError(401, "unauthorized", "Invalid webhook signature") from None
    outcome = await service.handle_webhook(db, event)
    log.info("livekit webhook %s (%s): %s", event.get("event"), event.get("id"), outcome)
    return {"status": "ok"}
