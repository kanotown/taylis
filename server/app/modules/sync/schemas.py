from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

from app.modules.channels.schemas import ChannelOut
from app.modules.threads.schemas import ThreadSummary
from app.modules.users.schemas import UserMe, UserPublic


class Limits(BaseModel):
    max_message_length: int
    max_attachment_bytes: int
    max_attachments_per_message: int


class PresenceEntry(BaseModel):
    user_id: UUID
    status: Literal["online", "away", "offline"]


class BootstrapOut(BaseModel):
    server_time: datetime
    me: UserMe
    users: list[UserPublic]
    channels: list[ChannelOut]
    limits: Limits
    # Followed threads with unread replies / mentions (THREADS.md §3); the sidebar badge.
    threads: ThreadSummary = ThreadSummary(unread_count=0, mention_count=0)
    # Who is connected right now (SYNC_PROTOCOL.md §5.2 presence); users not listed are offline.
    presence: list[PresenceEntry] = []
