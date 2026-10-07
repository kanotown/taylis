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
