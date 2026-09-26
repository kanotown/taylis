"""RealtimeHub: connection registry, fan-out and presence (process-local, ARCHITECTURE.md §7)."""

import asyncio
import logging
import time
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from app.events.envelope import Envelope
from app.realtime.protocol import (
    CLOSE_RECONNECT,
    CLOSE_SESSION_REVOKED,
    PresenceOut,
    PresenceStatus,
)

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
    def __init__(self, *, queue_size: int = 1000, away_seconds: float = 300.0) -> None:
        self.queue_size = queue_size
        # Presence (SYNC_PROTOCOL.md §5.2): online while activity is younger than this, else away.
        self.away_seconds = away_seconds
        self._by_user: dict[uuid.UUID, set[Connection]] = {}
        self._by_session: dict[uuid.UUID, set[Connection]] = {}
        self._last_active: dict[uuid.UUID, float] = {}
        # Last presence announced per user; users not listed are (announced as) offline.
        self._announced: dict[uuid.UUID, PresenceStatus] = {}

    def new_connection(self, user_id: uuid.UUID, session_id: uuid.UUID) -> Connection:
        conn = Connection(
            user_id=user_id, session_id=session_id, queue=asyncio.Queue(self.queue_size)
        )
        self._by_user.setdefault(user_id, set()).add(conn)
        self._by_session.setdefault(session_id, set()).add(conn)
        # Connecting counts as activity: apps connect when they come to the foreground.
        self._last_active[user_id] = time.monotonic()
        self._announce(user_id)
        return conn

    def remove(self, conn: Connection) -> None:
        for index, key in ((self._by_user, conn.user_id), (self._by_session, conn.session_id)):
            conns = index.get(key)
            if conns is not None:
                conns.discard(conn)
                if not conns:
                    del index[key]
        self._announce(conn.user_id)

    def connection_count(self) -> int:
        return sum(len(c) for c in self._by_user.values())

    def mark_active(self, user_id: uuid.UUID, active: bool) -> None:
        if active:
            self._last_active[user_id] = time.monotonic()
            self._announce(user_id)

    def is_active(self, user_id: uuid.UUID, within_seconds: float) -> bool:
        last = self._last_active.get(user_id)
        return last is not None and time.monotonic() - last <= within_seconds

    # --- presence (volatile, process-local) ----------------------------------------------

    def presence_status(self, user_id: uuid.UUID) -> PresenceStatus:
        if user_id not in self._by_user:
            return "offline"
        return "online" if self.is_active(user_id, self.away_seconds) else "away"

    def presence_snapshot(self) -> list[tuple[uuid.UUID, PresenceStatus]]:
        """Everyone connected right now (for bootstrap); absent users are offline."""
        return [(user_id, self.presence_status(user_id)) for user_id in self._by_user]

    def sweep_presence(self) -> None:
        """Periodic: announce users whose activity window lapsed (online → away)."""
        for user_id in list(self._by_user):
            self._announce(user_id)

    def _announce(self, user_id: uuid.UUID) -> None:
        status = self.presence_status(user_id)
        if status == self._announced.get(user_id, "offline"):
            return
        if status == "offline":
            self._announced.pop(user_id, None)
        else:
            self._announced[user_id] = status
        self.broadcast(PresenceOut(user_id=user_id, status=status).model_dump(mode="json"))

    def broadcast(self, frame: dict[str, Any]) -> None:
        for conns in self._by_user.values():
            for conn in conns:
                conn.offer(frame)

    def send_to_users(self, user_ids: Iterable[uuid.UUID], frame: dict[str, Any]) -> None:
        for user_id in user_ids:
            for conn in self._by_user.get(user_id, ()):
                conn.offer(frame)

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
