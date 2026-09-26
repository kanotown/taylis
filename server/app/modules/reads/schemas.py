from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class ReadMark(BaseModel):
    last_read_seq: int = Field(ge=0)
    # "advance": monotonic merge (default; SYNC_PROTOCOL.md §10).
    # "set": the exact position, used for 「ここから未読にする」 (mark as unread).
    mode: Literal["advance", "set"] = "advance"


class ReadStateOut(BaseModel):
    last_read_seq: int
    unread_count: int
    mention_count: int


class ReadUpdatedData(ReadStateOut):
    channel_id: UUID
