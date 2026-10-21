"""Download tickets (docs/DRIVE.md §7.3, phase D2) and ZIP tickets (§7.2, phase D3, at the end).

A download ticket is a short-lived URL the browser can follow with its own download (an
<a href download>) or play as a video's source, because the Web client holds its access token in
memory only and no cookie authenticates /drive/items/{id}/content.

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


# --- ZIP tickets (§7.2, phase D3) ----------------------------------------------------------------

# A ZIP ticket is used once, within this long.
ZIP_SECONDS = 300.0


@dataclass
class ZipTicket:
    user_id: uuid.UUID
    # What the ZIP holds, fixed when the ticket was made (app.modules.drive.zips.ZipJob).
    job: object
    expires_at: float


@dataclass
class ZipTickets:
    """One-time tickets for a ZIP's URL: the browser follows it with its own download, the
    desktop app fetches it and writes the body to a file chunk by chunk. Kept as SHA-256 in
    this process's memory (a restart forgets them: the client asks again)."""

    clock: Callable[[], float] = time.monotonic
    seconds: float = ZIP_SECONDS
    per_user: int = 20
    _tickets: dict[bytes, ZipTicket] = field(default_factory=dict)

    def _prune(self, now: float) -> None:
        for key in [k for k, t in self._tickets.items() if t.expires_at <= now]:
            del self._tickets[key]

    def issue(self, user_id: uuid.UUID, job: object) -> str:
        now = self.clock()
        self._prune(now)
        mine = sorted(
            ((k, t) for k, t in self._tickets.items() if t.user_id == user_id),
            key=lambda pair: pair[1].expires_at,
        )
        for key, _ in mine[: max(0, len(mine) - self.per_user + 1)]:
            del self._tickets[key]
        token = secrets.token_urlsafe(32)
        self._tickets[DownloadTickets._digest(token)] = ZipTicket(
            user_id=user_id, job=job, expires_at=now + self.seconds
        )
        return token

    def peek(self, token: str) -> ZipTicket | None:
        ticket = self._tickets.get(DownloadTickets._digest(token))
        if ticket is None or ticket.expires_at <= self.clock():
            return None
        return ticket

    def take(self, token: str) -> ZipTicket | None:
        """The ticket, gone from here (used once); None when unknown or expired."""
        ticket = self._tickets.pop(DownloadTickets._digest(token), None)
        if ticket is None or ticket.expires_at <= self.clock():
            return None
        return ticket

    def __len__(self) -> int:
        return len(self._tickets)


@dataclass
class ZipSlots:
    """ZIPs streaming now, per person and in all (§7.2: DRIVE_ZIP_PER_USER and DRIVE_ZIP_TOTAL)."""

    _running: dict[uuid.UUID, int] = field(default_factory=dict)

    def try_acquire(self, user_id: uuid.UUID, *, per_user: int, total: int) -> bool:
        if sum(self._running.values()) >= total:
            return False
        if self._running.get(user_id, 0) >= per_user:
            return False
        self._running[user_id] = self._running.get(user_id, 0) + 1
        return True

    def release(self, user_id: uuid.UUID) -> None:
        left = self._running.get(user_id, 0) - 1
        if left > 0:
            self._running[user_id] = left
        else:
            self._running.pop(user_id, None)
