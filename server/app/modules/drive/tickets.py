"""Download tickets (docs/DRIVE.md §7.3, phase D2): a short-lived URL the browser can follow with
its own download (an <a href download>) or play as a video's source, because the Web client holds
its access token in memory only and no cookie authenticates /drive/items/{id}/content.

A ticket names one person, one file and one version. It is 32 random bytes (base64url), kept in
this process's memory as its SHA-256 only (one process, as the ZIP tickets of §7.2; a restart
forgets them and the client asks for another). It may be used several times while it lives (the
browser resumes a broken download with a Range request, a video seeks), each use extends it by
the idle time up to a hard limit, and every use checks again that the person may still read the
file (drive.service.readable_item). The token never reaches the logs (core/logging.py).
"""

import hashlib
import secrets
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

# Unused for this long, a ticket is gone (a download that starts, a video that seeks within it).
IDLE_SECONDS = 300.0
# However often it is used, a ticket ends this long after it was issued.
MAX_SECONDS = 12 * 3600.0
# Tickets one person may hold at once (the oldest go first past it).
PER_USER = 200


@dataclass
class Ticket:
    user_id: uuid.UUID
    item_id: uuid.UUID
    version_id: uuid.UUID
    issued_at: float
    expires_at: float


@dataclass
class DownloadTickets:
    clock: Callable[[], float] = time.monotonic
    idle_seconds: float = IDLE_SECONDS
    max_seconds: float = MAX_SECONDS
    per_user: int = PER_USER
    _tickets: dict[bytes, Ticket] = field(default_factory=dict)

    @staticmethod
    def _digest(token: str) -> bytes:
        return hashlib.sha256(token.encode()).digest()

    def _prune(self, now: float) -> None:
        for key in [k for k, t in self._tickets.items() if t.expires_at <= now]:
            del self._tickets[key]

    def issue(self, user_id: uuid.UUID, item_id: uuid.UUID, version_id: uuid.UUID) -> str:
        now = self.clock()
        self._prune(now)
        mine = sorted(
            ((k, t) for k, t in self._tickets.items() if t.user_id == user_id),
            key=lambda pair: pair[1].issued_at,
        )
        for key, _ in mine[: max(0, len(mine) - self.per_user + 1)]:
            del self._tickets[key]
        token = secrets.token_urlsafe(32)
        self._tickets[self._digest(token)] = Ticket(
            user_id=user_id,
            item_id=item_id,
            version_id=version_id,
            issued_at=now,
            expires_at=now + self.idle_seconds,
        )
        return token

    def use(self, token: str) -> Ticket | None:
        """The ticket, extended by the idle time (within its hard limit); None when unknown or
        expired."""
        now = self.clock()
        key = self._digest(token)
        ticket = self._tickets.get(key)
        if ticket is None:
            return None
        if ticket.expires_at <= now:
            del self._tickets[key]
            return None
        ticket.expires_at = min(now + self.idle_seconds, ticket.issued_at + self.max_seconds)
        return ticket

    def __len__(self) -> int:
        return len(self._tickets)
