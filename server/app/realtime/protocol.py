"""WebSocket frames (SYNC_PROTOCOL.md §5)."""

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

CLOSE_RECONNECT = 4000
CLOSE_AUTH_FAILED = 4001
CLOSE_SESSION_REVOKED = 4003


class AuthFrame(BaseModel):
    type: Literal["auth"]
    token: str = Field(min_length=1, max_length=4096, repr=False)


class PingFrame(BaseModel):
    type: Literal["ping"]
    active: bool = False


ClientFrame = Annotated[AuthFrame | PingFrame, Field(discriminator="type")]


class HelloFrame(BaseModel):
    type: Literal["hello"] = "hello"
    session_id: UUID
    server_time: datetime
    heartbeat_interval_sec: int


class PongFrame(BaseModel):
    type: Literal["pong"] = "pong"
    server_time: datetime


class ErrorFrame(BaseModel):
    type: Literal["error"] = "error"
    code: str
    message: str


class EventFrame(BaseModel):
    type: Literal["event"] = "event"
    id: int
    event: str
    ts: datetime
    channel_id: UUID | None
    seq: int | None
    data: dict[str, Any]


ServerFrame = Annotated[
    HelloFrame | PongFrame | ErrorFrame | EventFrame, Field(discriminator="type")
]
