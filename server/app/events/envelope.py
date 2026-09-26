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

    def frame(self) -> dict[str, Any]:
        """The WebSocket ``event`` frame (SYNC_PROTOCOL.md §5.2). Audience is never sent."""
        return {
            "type": "event",
            "id": self.id,
            "event": self.event,
            "ts": self.ts.isoformat().replace("+00:00", "Z"),
            "channel_id": str(self.channel_id) if self.channel_id else None,
            "seq": self.seq,
            "data": self.data,
        }
