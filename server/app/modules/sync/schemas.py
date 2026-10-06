from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

from app.modules.activity.schemas import ActivitySummaryOut
from app.modules.channels.schemas import ChannelOut
from app.modules.drafts.schemas import DraftOut
from app.modules.emoji.schemas import CustomEmojiOut, EmojiPackOut
from app.modules.groups.schemas import GroupOut
from app.modules.lab.schemas import LabProfileOut
from app.modules.sidebar.schemas import SidebarDefaultOut, SidebarSectionOut
from app.modules.templates.schemas import TemplateOut
from app.modules.threads.schemas import ThreadSummary
from app.modules.users.schemas import UserMe, UserPublic
from app.modules.workspace.schemas import WorkspaceSettingsOut


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
    # Emoji packs (M100) in tab order; changes arrive as emoji_pack.updated.
    emoji_packs: list[EmojiPackOut] = []
    # Post templates (M30): the workspace's, then mine; changes arrive as template.updated.
    templates: list[TemplateOut] = []
    # User groups (M12k): every group with its members; changes arrive as group.updated.
    groups: list[GroupOut] = []
    # The lab roster (M23) in roster order; changes arrive as roster.updated.
    roster: list[LabProfileOut] = []
    # My sidebar sections (M14f); changes arrive as sidebar.updated.
    sidebar_sections: list[SidebarSectionOut] = []
    # 2026-10-07: the default sections' sorts (all three); changes arrive as sidebar.updated.
    sidebar_defaults: list[SidebarDefaultOut] = []
    # My drafts shared by my devices (M15d); changes arrive as draft.updated.
    drafts: list[DraftOut] = []
    # M39: the activity tab's badge (GET /activity/summary); activity.read and reaction.added move
    # it.
    activity: ActivitySummaryOut | None = None
    # M88: the workspace settings (docs/MEMBERSHIP.md §3); changes arrive as
    # workspace.settings_updated.
    workspace_settings: WorkspaceSettingsOut = WorkspaceSettingsOut()
    # M104: the people I blocked (docs/MODERATION.md §4), oldest first; changes arrive as
    # block.updated. Their messages fold away and they never notify me.
    blocked_user_ids: list[UUID] = []


class UnreadSummaryOut(BaseModel):
    """What the workspace switcher shows for a workspace that is not open (WORKSPACES.md §6)."""

    # The app-icon number (M13f): every unread DM message, mentions elsewhere, muted = mentions.
    badge: int
    # Anything unread at all (a muted conversation only with a mention; followed threads count).
    has_unread: bool
