from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.modules.workspace.models import DEFAULT_MEETING_BASE_URL


class ServerInfoOut(BaseModel):
    # Always "chikuwachat": the add-workspace dialog tells our server from any other site.
    product: Literal["chikuwachat"] = "chikuwachat"
    # Also in every push payload, so a notification opens the right workspace.
    workspace_id: UUID
    # The name for the switcher (WORKSPACE_NAME, else the application name).
    name: str
    api_version: str
    # M93 (WORKSPACES.md §3.4): the icon's version, or null when there is none (the letter tile).
    # The picture is GET /server/icon?v=<icon_version>, public like this answer.
    icon_version: str | None = None


class WorkspaceSettingsOut(BaseModel):
    """M88 (docs/MEMBERSHIP.md §3): the switches every client needs (bootstrap, and the event
    workspace.settings_updated)."""

    # 「参加・退出の表示」: new join / leave lines are written (existing ones always stay).
    show_membership_messages: bool = True
    # 「参加前にチャンネルの中を見られる」: a public channel's messages, threads and files can be
    # read before joining it (M27). False: 403 preview_disabled, search keeps to one's channels.
    preview_before_join: bool = True
    # M93 (WORKSPACES.md §3.4): the workspace icon's version (null: none); a change reaches the
    # signed-in devices through workspace.settings_updated, so the rail follows at once.
    icon_version: str | None = None
    # M117 (docs/CALLS.md): whether the 📞 button is shown (POST /channels/{id}/calls works), and
    # the meeting service a call's room is made on (null when calls are off).
    calls_enabled: bool = True
    meeting_base_url: str | None = DEFAULT_MEETING_BASE_URL


# M117: the longest meeting service URL an administrator can set.
MAX_MEETING_BASE_URL = 200

# M90: at most this many default channels (a long list would bury a newcomer's sidebar).
MAX_DEFAULT_CHANNELS = 20


class DefaultChannelOut(BaseModel):
    id: UUID
    name: str


class AdminWorkspaceSettingsOut(WorkspaceSettingsOut):
    """GET / PATCH /admin/workspace-settings: the settings and who changed them last."""

    updated_at: datetime | None = None
    updated_by: UUID | None = None
    # M90 「既定のチャンネル」 (docs/MEMBERSHIP.md §6): the public channels every new non-guest
    # account joins, in order. Only channels that are still public and not archived are listed.
    default_channel_ids: list[UUID] = []
    default_channels: list[DefaultChannelOut] = []
    # False until an administrator saves the list once (even empty): until then Google sign-in's
    # auto-provisioned accounts still join SSO_DEFAULT_CHANNELS (deprecated), shown here.
    default_channels_set: bool = False
    legacy_sso_default_channels: list[str] = []


class WorkspaceSettingsUpdate(BaseModel):
    """PATCH /admin/workspace-settings: only the fields sent change."""

    model_config = ConfigDict(extra="forbid")

    show_membership_messages: bool | None = None
    preview_before_join: bool | None = None
    # M90: the whole ordered list (send [] to clear). Each must be a public, non-archived channel
    # (422 default_channel_not_found / default_channel_not_public / default_channel_archived);
    # repeats are dropped.
    default_channel_ids: list[UUID] | None = Field(default=None, max_length=MAX_DEFAULT_CHANNELS)
    # M117 (docs/CALLS.md): the meeting service's base URL (https; http only for localhost on a
    # DEBUG server; no query, fragment or credentials; a missing final "/" is added). "" or an
    # explicit null turns calls off (422 meeting_url_invalid otherwise).
    meeting_base_url: str | None = Field(default=None, max_length=MAX_MEETING_BASE_URL)


class DefaultChannelsApply(BaseModel):
    """POST /admin/workspace-settings/apply-default-channels (M90)."""

    model_config = ConfigDict(extra="forbid")

    # True: only count who would be added (the confirmation), change nothing.
    dry_run: bool = False


class DefaultChannelApplied(BaseModel):
    id: UUID
    name: str
    # People added to this channel (or who would be, with dry_run).
    added: int


class DefaultChannelsApplyOut(BaseModel):
    dry_run: bool
    # Distinct people added to at least one channel, and the memberships made in all.
    users: int
    memberships: int
    channels: list[DefaultChannelApplied]
