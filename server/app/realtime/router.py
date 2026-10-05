"""``/api/v1/ws``: auth, hello, heartbeat, events, typing relay (SYNC_PROTOCOL.md §5)."""

import asyncio
import json
import logging
import time
import uuid
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from app.core.errors import AppError
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.analytics.activity import ActivityTracker
from app.modules.auth import service as auth
from app.modules.canvases import repository as canvas_repo
from app.modules.channels import repository as channel_repo
from app.modules.channels import service as channels
from app.realtime.hub import CLOSE_KEY, Connection, RealtimeHub
from app.realtime.protocol import (
    CLOSE_AUTH_FAILED,
    CLOSE_RECONNECT,
    AuthFrame,
    CanvasPresenceFrame,
    CanvasPresenceOut,
    ClientFrame,
    ErrorFrame,
    HelloFrame,
    PingFrame,
    PongFrame,
    TypingFrame,
    TypingOut,
)

log = logging.getLogger("app.realtime")
router = APIRouter(tags=["realtime"])
_client_frame: TypeAdapter[AuthFrame | PingFrame | TypingFrame | CanvasPresenceFrame] = TypeAdapter(
    ClientFrame
)
# M72 (CANVAS.md §18.2): the canvases one connection said it edits, remembered for its close.
MAX_PRESENCE_CANVASES = 20


async def _relay_typing(
    websocket: WebSocket, hub: RealtimeHub, user_id: uuid.UUID, frame: TypingFrame
) -> None:
    """Volatile typing indicator (M11b): to the channel's other members, only from a member."""
    async with websocket.app.state.db.session_factory() as db:
        members = (await channel_repo.member_ids_for_channels(db, [frame.channel_id])).get(
            frame.channel_id, []
        )
    if user_id not in members:
        return
    out = TypingOut(channel_id=frame.channel_id, parent_id=frame.parent_id, user_id=user_id)
    hub.send_to_users((m for m in members if m != user_id), out.model_dump(mode="json"))


async def _relay_canvas_presence(
    websocket: WebSocket,
    hub: RealtimeHub,
    user_id: uuid.UUID,
    canvas_id: uuid.UUID,
    editing: bool,
    section: str | None,
) -> bool:
    """Volatile 「編集中」 (M72, CANVAS.md §18.2): to the other members of the canvas's
    conversation, only from a member and for a canvas not in the trash. True when relayed."""
    async with websocket.app.state.db.session_factory() as db:
        canvas = await canvas_repo.get(db, canvas_id)
        if canvas is None or canvas.is_deleted:
            return False
        channel_id = canvas.channel_id
        members = (await channel_repo.member_ids_for_channels(db, [channel_id])).get(channel_id, [])
    if user_id not in members:
        return False
    out = CanvasPresenceOut(
        canvas_id=canvas_id,
        channel_id=channel_id,
        user_id=user_id,
        editing=editing,
        section=section,
    )
    hub.send_to_users((m for m in members if m != user_id), out.model_dump(mode="json"))
    return True


async def _send(websocket: WebSocket, frame: dict[str, Any]) -> None:
    await websocket.send_text(json.dumps(frame, ensure_ascii=False, default=str))


async def _fail(websocket: WebSocket, code: str, message: str, close_code: int) -> None:
    try:
        await _send(websocket, ErrorFrame(code=code, message=message).model_dump(mode="json"))
        await websocket.close(code=close_code)
    except Exception:  # the peer may already be gone
        log.debug("could not deliver websocket error %s", code)


async def _authenticate(websocket: WebSocket, settings: Settings) -> auth.AuthContext | None:
    try:
        raw = await asyncio.wait_for(
            websocket.receive_text(), timeout=settings.ws_auth_timeout_seconds
        )
        frame = _client_frame.validate_json(raw)
    except (TimeoutError, ValidationError, WebSocketDisconnect, RuntimeError):
        await _fail(websocket, "auth_required", "Send an auth frame first", CLOSE_AUTH_FAILED)
        return None
    if not isinstance(frame, AuthFrame):
        await _fail(websocket, "auth_required", "Send an auth frame first", CLOSE_AUTH_FAILED)
        return None
    async with websocket.app.state.db.session_factory() as db:
        try:
            context = await auth.authenticate(db, frame.token, settings)
        except AppError as exc:
            await _fail(websocket, exc.code, exc.message, CLOSE_AUTH_FAILED)
            return None
    if context.user.must_change_password:
        await _fail(
            websocket, "password_change_required", "Password change required", CLOSE_AUTH_FAILED
        )
        return None
    return context


async def _sender(websocket: WebSocket, conn: Connection) -> None:
    while True:
        frame = await conn.queue.get()
        if CLOSE_KEY in frame:
            await websocket.close(code=int(frame[CLOSE_KEY]))
            return
        await _send(websocket, frame)


def _origin_allowed(origin: str, websocket: WebSocket, settings: Settings) -> bool:
    """Browsers always send Origin (M12j): accept our own host or a configured client origin."""
    if origin in settings.cors_origins:
        return True
    host = websocket.headers.get("host", "")
    return bool(host) and urlparse(origin).netloc.lower() == host.lower()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    settings: Settings = websocket.app.state.settings
    hub: RealtimeHub = websocket.app.state.hub
    ip = websocket.client.host[:45] if websocket.client else "unknown"
    limiter = websocket.app.state.limiters["ws_connect"]  # SECURITY.md §5: attempts per IP
    if not limiter.try_acquire(ip):
        log.warning("websocket attempts throttled", extra={"ip": ip})
        await websocket.close(code=1008)  # before accept: the handshake answers 403
        return
    origin = websocket.headers.get("origin")
    if origin is not None and not _origin_allowed(origin, websocket, settings):
        log.warning("websocket origin rejected", extra={"origin": origin})
        await websocket.close(code=1008)  # before accept: the handshake answers 403
        return
    await websocket.accept()

    context = await _authenticate(websocket, settings)
    if context is None:
        return
    # M116 (docs/ANALYTICS.md §2): connecting is using the app.
    activity: ActivityTracker = websocket.app.state.activity
    activity.touch(context.user.id)

    visible: frozenset[uuid.UUID] | None = None
    if context.user.is_guest:  # M13e: presence only of the people the guest shares a channel with
        async with websocket.app.state.db.session_factory() as db:
            visible = frozenset(await channels.shared_member_ids(db, context.user.id))
    # At most ws_max_connections_per_user sockets per user (SECURITY.md §5): the oldest yields.
    existing = hub.connections_of(context.user.id)
    for old in existing[: max(0, len(existing) - settings.ws_max_connections_per_user + 1)]:
        old.request_close(CLOSE_RECONNECT)
    conn = hub.new_connection(
        context.user.id,
        context.session.id,
        visible=visible,
        presence_hidden=context.user.presence_hidden,
    )
    await _send(
        websocket,
        HelloFrame(
            session_id=context.session.id,
            server_time=utcnow(),
            heartbeat_interval_sec=settings.ws_heartbeat_interval_seconds,
        ).model_dump(mode="json"),
    )
    sender = asyncio.create_task(_sender(websocket, conn))
    deadline = time.monotonic() + settings.ws_max_lifetime_seconds
    last_typing = 0.0
    # canvas id → (editing, section, when relayed): repeats are throttled, changes go at once.
    canvas_presence: dict[uuid.UUID, tuple[bool, str | None, float]] = {}
    closing = False  # we asked for the close: let the queued frames flush first
    try:
        while not sender.done():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                conn.request_close(CLOSE_RECONNECT)
                closing = True
                break
            try:
                timeout = min(settings.ws_idle_timeout_seconds, remaining)
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=timeout)
            except TimeoutError:
                # No ping within the idle window (or the lifetime is over): ask for a reconnect.
                conn.request_close(CLOSE_RECONNECT)
                closing = True
                break
            except (WebSocketDisconnect, RuntimeError):
                break  # the peer went away: nothing to flush, drop the registration at once
            try:
                frame = _client_frame.validate_json(raw)
            except ValidationError:
                conn.offer(ErrorFrame(code="invalid_frame", message="Unknown frame").model_dump())
                continue
            if isinstance(frame, PingFrame):
                hub.mark_active(conn, frame.active)
                if frame.active:  # M116: an app in use, not one left open in the background
                    activity.touch(context.user.id)
                conn.offer(PongFrame(server_time=utcnow()).model_dump(mode="json"))
            elif isinstance(frame, TypingFrame):
                now = time.monotonic()
                if now - last_typing >= settings.typing_min_interval_seconds:
                    last_typing = now
                    await _relay_typing(websocket, hub, context.user.id, frame)
            elif isinstance(frame, CanvasPresenceFrame):
                now = time.monotonic()
                section = " ".join((frame.section or "").split()) or None
                last = canvas_presence.get(frame.canvas_id)
                if last is None:
                    skip = not frame.editing  # a stop for nothing started on this connection
                else:
                    skip = (
                        last[:2] == (frame.editing, section)
                        and now - last[2] < settings.typing_min_interval_seconds
                    )
                if not skip:
                    if last is None and len(canvas_presence) >= MAX_PRESENCE_CANVASES:
                        oldest = min(canvas_presence, key=lambda c: canvas_presence[c][2])
                        del canvas_presence[oldest]
                    if await _relay_canvas_presence(
                        websocket, hub, context.user.id, frame.canvas_id, frame.editing, section
                    ):
                        canvas_presence[frame.canvas_id] = (frame.editing, section, now)
            else:
                error = ErrorFrame(code="already_authenticated", message="Already authenticated")
                conn.offer(error.model_dump())
        if closing and not sender.done():
            try:
                await asyncio.wait_for(sender, timeout=2.0)
            except (TimeoutError, Exception):
                pass
    finally:
        hub.remove(conn)
        if not sender.done():
            sender.cancel()
        # A window closed or lost while editing: its 「編集中」 ends now, not 45 s later (§18.2).
        for canvas_id, (editing, _, _) in canvas_presence.items():
            if not editing:
                continue
            try:
                await _relay_canvas_presence(
                    websocket, hub, context.user.id, canvas_id, False, None
                )
            except Exception:  # best effort: the receivers drop it after 45 s anyway
                log.debug("could not end the canvas presence of %s", canvas_id)
