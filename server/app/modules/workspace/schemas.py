from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


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


class InAppCallsOut(BaseModel):
    """M130 (docs/CALLS.md §5.1). `enabled`: the administrator's switch is on and this server has
    LiveKit configured. `video` / `screen_share` follow `enabled` in v1 (kept apart so that an
    administrator can turn them off later)."""

    enabled: bool = False
    video: bool = False
    screen_share: bool = False


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
    # M130 (docs/CALLS.md §5.1): in-app calls (LiveKit). New clients show 🎧 when `enabled`.
    in_app_calls: InAppCallsOut = InAppCallsOut()
    # M117's meeting links, retired by M130 (docs/CALLS.md §11): always false and null, so that
    # the released M117 clients hide their 📞. New clients do not read them.
    calls_enabled: bool = False
    meeting_base_url: str | None = None


# M90: at most this many default channels (a long list would bury a newcomer's sidebar).
MAX_DEFAULT_CHANNELS = 20


class DefaultChannelOut(BaseModel):
    id: UUID
    name: str


class AdminWorkspaceSettingsOut(WorkspaceSettingsOut):
    """GET / PATCH /admin/workspace-settings: the settings and who changed them last."""

    updated_at: datetime | None = None
    updated_by: UUID | None = None
    # M130: the administrator's 「アプリ内通話」 switch as saved (in_app_calls.enabled also needs
    # LiveKit on the server).
    in_app_calls_enabled: bool = True
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
    # M130 (docs/CALLS.md §5.1): 「アプリ内通話」. Turning it off ends no call in progress; it
    # only stops new ones.
    in_app_calls_enabled: bool | None = None
    # M117's meeting service, retired (docs/CALLS.md §11): sending it at all (an M117 desktop's
    # admin screen) is refused with 409 meeting_links_retired rather than silently dropped.
    meeting_base_url: str | None = None


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
