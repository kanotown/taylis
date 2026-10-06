from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class DmPinStateOut(BaseModel):
    channel_id: UUID
    pinned: bool


class DmPinUpdatedData(BaseModel):
    channel_id: UUID
    pinned: bool
    # When it was pinned (its place in the pin order), or unpinned.
    at: datetime
