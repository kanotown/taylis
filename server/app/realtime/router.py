"""``/api/v1/ws``: auth frame, hello, heartbeat, event delivery (SYNC_PROTOCOL.md §5)."""

import asyncio
import json
import logging
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import TypeAdapter, ValidationError

from app.core.errors import AppError
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.auth import service as auth
from app.realtime.hub import CLOSE_KEY, Connection, RealtimeHub
from app.realtime.protocol import (
    CLOSE_AUTH_FAILED,
    CLOSE_RECONNECT,
    AuthFrame,
    ClientFrame,
    ErrorFrame,
    HelloFrame,
    PingFrame,
    PongFrame,
)

log = logging.getLogger("app.realtime")
router = APIRouter(tags=["realtime"])
_client_frame: TypeAdapter[AuthFrame | PingFrame] = TypeAdapter(ClientFrame)


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


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    settings: Settings = websocket.app.state.settings
    hub: RealtimeHub = websocket.app.state.hub
    await websocket.accept()

    context = await _authenticate(websocket, settings)
    if context is None:
        return

    conn = hub.new_connection(context.user.id, context.session.id)
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
    try:
        while not sender.done():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                conn.request_close(CLOSE_RECONNECT)
                break
            try:
                timeout = min(settings.ws_idle_timeout_seconds, remaining)
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=timeout)
            except TimeoutError:
                # No ping within the idle window (or the lifetime is over): ask for a reconnect.
                conn.request_close(CLOSE_RECONNECT)
                break
            except (WebSocketDisconnect, RuntimeError):
                break
            try:
                frame = _client_frame.validate_json(raw)
            except ValidationError:
                conn.offer(ErrorFrame(code="invalid_frame", message="Unknown frame").model_dump())
                continue
            if isinstance(frame, PingFrame):
                hub.mark_active(context.user.id, frame.active)
                conn.offer(PongFrame(server_time=utcnow()).model_dump(mode="json"))
            else:
                error = ErrorFrame(code="already_authenticated", message="Already authenticated")
                conn.offer(error.model_dump())
        if not sender.done():
            try:
                await asyncio.wait_for(sender, timeout=2.0)
            except (TimeoutError, Exception):
                pass
    finally:
        hub.remove(conn)
        if not sender.done():
            sender.cancel()
