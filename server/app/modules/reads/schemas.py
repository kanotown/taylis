from uuid import UUID

from pydantic import BaseModel, Field


class ReadMark(BaseModel):
    last_read_seq: int = Field(ge=0)


class ReadStateOut(BaseModel):
    last_read_seq: int
    unread_count: int
    mention_count: int


class ReadUpdatedData(ReadStateOut):
    channel_id: UUID
