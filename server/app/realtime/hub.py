"""RealtimeHub: WebSocket connection registry and fan-out (process-local, ARCHITECTURE.md §7)."""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from app.events.envelope import Envelope
from app.realtime.protocol import CLOSE_RECONNECT, CLOSE_SESSION_REVOKED

log = logging.getLogger("app.realtime")

CLOSE_KEY = "__close__"


@dataclass(eq=False)
class Connection:
    user_id: uuid.UUID
    session_id: uuid.UUID
    queue: asyncio.Queue[dict[str, Any]]
    connected_at: float = field(default_factory=time.monotonic)
    id: str = field(default_factory=lambda: uuid.uuid4().hex)

    def offer(self, frame: dict[str, Any]) -> None:
        """Queue a frame; a full queue means the client cannot keep up, so it must resync."""
        try:
            self.queue.put_nowait(frame)
        except asyncio.QueueFull:
            log.warning("connection %s overflowed; closing for resync", self.id)
            self.request_close(CLOSE_RECONNECT)

    def request_close(self, code: int) -> None:
        """Close after the frames already queued (e.g. session.revoked) have been sent."""
        marker = {CLOSE_KEY: code}
        try:
            self.queue.put_nowait(marker)
        except asyncio.QueueFull:
            while not self.queue.empty():
                self.queue.get_nowait()
            self.queue.put_nowait(marker)


class RealtimeHub:
    def __init__(self, *, queue_size: int = 1000) -> None:
        self.queue_size = queue_size
        self._by_user: dict[uuid.UUID, set[Connection]] = {}
        self._by_session: dict[uuid.UUID, set[Connection]] = {}
        self._last_active: dict[uuid.UUID, float] = {}

    def new_connection(self, user_id: uuid.UUID, session_id: uuid.UUID) -> Connection:
        conn = Connection(
            user_id=user_id, session_id=session_id, queue=asyncio.Queue(self.queue_size)
        )
        self._by_user.setdefault(user_id, set()).add(conn)
        self._by_session.setdefault(session_id, set()).add(conn)
        return conn

    def remove(self, conn: Connection) -> None:
        for index, key in ((self._by_user, conn.user_id), (self._by_session, conn.session_id)):
            conns = index.get(key)
            if conns is not None:
                conns.discard(conn)
                if not conns:
                    del index[key]

    def connection_count(self) -> int:
        return sum(len(c) for c in self._by_user.values())

    def mark_active(self, user_id: uuid.UUID, active: bool) -> None:
        if active:
            self._last_active[user_id] = time.monotonic()

    def is_active(self, user_id: uuid.UUID, within_seconds: float) -> bool:
        last = self._last_active.get(user_id)
        return last is not None and time.monotonic() - last <= within_seconds

    def _targets(self, envelope: Envelope) -> set[Connection]:
        audience = envelope.audience
        if audience.kind == "all":
            return {c for conns in self._by_user.values() for c in conns}
        index = self._by_users_or_sessions(audience.kind)
        return {c for key in audience.ids for c in index.get(key, ())}

    def _by_users_or_sessions(self, kind: str) -> dict[uuid.UUID, set[Connection]]:
        return self._by_session if kind == "sessions" else self._by_user

    async def on_event(self, envelope: Envelope) -> None:
        """EventBus subscriber: fan out to every connection in the audience."""
        frame = envelope.frame()
        for conn in self._targets(envelope):
            conn.offer(frame)
            if envelope.event == "session.revoked":
                conn.request_close(CLOSE_SESSION_REVOKED)
