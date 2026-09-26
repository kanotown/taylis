from datetime import datetime

from pydantic import BaseModel

from app.modules.channels.schemas import ChannelOut
from app.modules.users.schemas import UserMe, UserPublic


class Limits(BaseModel):
    max_message_length: int
    max_attachment_bytes: int
    max_attachments_per_message: int


class BootstrapOut(BaseModel):
    server_time: datetime
    me: UserMe
    users: list[UserPublic]
    channels: list[ChannelOut]
    limits: Limits
