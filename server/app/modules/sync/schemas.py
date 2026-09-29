from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

from app.modules.channels.schemas import ChannelOut
from app.modules.drafts.schemas import DraftOut
from app.modules.emoji.schemas import CustomEmojiOut
from app.modules.groups.schemas import GroupOut
from app.modules.lab.schemas import LabProfileOut
from app.modules.sidebar.schemas import SidebarSectionOut
from app.modules.templates.schemas import TemplateOut
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
    # My saved messages (M11c): ids only, newest first; the list itself is GET /bookmarks.
    bookmarks: list[UUID] = []
    # My starred channels (M12a) among the channels above, oldest star first.
    favorites: list[UUID] = []
    # Custom emoji (M12f): the whole table, by name; changes arrive as emoji.updated.
    custom_emoji: list[CustomEmojiOut] = []
    # Post templates (M30): the workspace's, then mine; changes arrive as template.updated.
    templates: list[TemplateOut] = []
    # User groups (M12k): every group with its members; changes arrive as group.updated.
    groups: list[GroupOut] = []
    # The lab roster (M23) in roster order; changes arrive as roster.updated.
    roster: list[LabProfileOut] = []
    # My sidebar sections (M14f); changes arrive as sidebar.updated.
    sidebar_sections: list[SidebarSectionOut] = []
    # My drafts shared by my devices (M15d); changes arrive as draft.updated.
    drafts: list[DraftOut] = []


class UnreadSummaryOut(BaseModel):
    """What the workspace switcher shows for a workspace that is not open (WORKSPACES.md §6)."""

    # The app-icon number (M13f): every unread DM message, mentions elsewhere, muted = mentions.
    badge: int
    # Anything unread at all (a muted conversation only with a mention; followed threads count).
    has_unread: bool
