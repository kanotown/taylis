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


class TypingFrame(BaseModel):
    """Volatile: relayed to the other members of the channel (M11b), never stored."""

    type: Literal["typing"]
    channel_id: UUID
    parent_id: UUID | None = None


class CanvasPresenceFrame(BaseModel):
    """Volatile (M72, CANVAS.md §18.2): I am editing this canvas (or stopped); relayed to the other
    members of its conversation, never stored. `section`: the heading the caret is under."""

    type: Literal["canvas_presence"]
    canvas_id: UUID
    editing: bool
    section: str | None = Field(default=None, max_length=120)


ClientFrame = Annotated[
    AuthFrame | PingFrame | TypingFrame | CanvasPresenceFrame, Field(discriminator="type")
]

PresenceStatus = Literal["online", "away", "offline"]


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


class TypingOut(BaseModel):
    type: Literal["typing"] = "typing"
    channel_id: UUID
    parent_id: UUID | None
    user_id: UUID


class CanvasPresenceOut(BaseModel):
    """Someone is editing a canvas (or stopped). Clients drop it after 45 s without a refresh."""

    type: Literal["canvas_presence"] = "canvas_presence"
    canvas_id: UUID
    channel_id: UUID
    user_id: UUID
    editing: bool
    section: str | None


class PresenceOut(BaseModel):
    type: Literal["presence"] = "presence"
    user_id: UUID
    status: PresenceStatus


ServerFrame = Annotated[
    HelloFrame | PongFrame | ErrorFrame | EventFrame | TypingOut | PresenceOut | CanvasPresenceOut,
    Field(discriminator="type"),
]
