from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class DmCloseStateOut(BaseModel):
    channel_id: UUID
    closed: bool
    # When it was closed; null when it is open.
    closed_at: datetime | None = None


class DmCloseUpdatedData(BaseModel):
    channel_id: UUID
    closed: bool
    # When it was closed or opened again.
    at: datetime
    # Closed: the channel's last_seq it was closed at (Review v0.1.43 #6). A device that already
    # holds a timeline message with a higher seq keeps it open (that message reopened it on the
    # server too). Null when opened again, and from an older server.
    closed_seq: int | None = None
