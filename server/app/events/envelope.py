"""The unit that travels over the EventBus and, as a frame, over WebSocket."""

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

AudienceKind = Literal["users", "sessions", "all"]


@dataclass(frozen=True)
class Audience:
    kind: AudienceKind
    ids: tuple[uuid.UUID, ...] = ()


@dataclass(frozen=True)
class Envelope:
    id: int
    event: str
    ts: datetime
    channel_id: uuid.UUID | None
    seq: int | None
    data: dict[str, Any]
    audience: Audience = field(default=Audience(kind="all"))
    # A volatile frame sent as it is instead of an ``event`` frame (an AI bot's ``typing``,
    # docs/AI.md §2.2): never stored, no id or seq (id is 0), not part of any cursor.
    volatile: dict[str, Any] | None = None

    def frame(self) -> dict[str, Any]:
        """The WebSocket ``event`` frame (SYNC_PROTOCOL.md §5.2), or the volatile frame as it is.
        Audience is never sent."""
        if self.volatile is not None:
            return dict(self.volatile)
        return {
            "type": "event",
            "id": self.id,
            "event": self.event,
            "ts": self.ts.isoformat().replace("+00:00", "Z"),
            "channel_id": str(self.channel_id) if self.channel_id else None,
            "seq": self.seq,
            "data": self.data,
        }
