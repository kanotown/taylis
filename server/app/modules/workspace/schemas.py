from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class ServerInfoOut(BaseModel):
    # Always "chikuwachat": the add-workspace dialog tells our server from any other site.
    product: Literal["chikuwachat"] = "chikuwachat"
    # Also in every push payload, so a notification opens the right workspace.
    workspace_id: UUID
    # The name for the switcher (WORKSPACE_NAME, else the application name).
    name: str
    api_version: str


class WorkspaceSettingsOut(BaseModel):
    """M88 (docs/MEMBERSHIP.md §3): the switches every client needs (bootstrap, and the event
    workspace.settings_updated)."""

    # 「参加・退出の表示」: new join / leave lines are written (existing ones always stay).
    show_membership_messages: bool = True
    # 「参加前にチャンネルの中を見られる」: a public channel's messages, threads and files can be
    # read before joining it (M27). False: 403 preview_disabled, search keeps to one's channels.
    preview_before_join: bool = True


class AdminWorkspaceSettingsOut(WorkspaceSettingsOut):
    """GET / PATCH /admin/workspace-settings: the settings and who changed them last."""

    updated_at: datetime | None = None
    updated_by: UUID | None = None


class WorkspaceSettingsUpdate(BaseModel):
    """PATCH /admin/workspace-settings: only the fields sent change."""

    model_config = ConfigDict(extra="forbid")

    show_membership_messages: bool | None = None
    preview_before_join: bool | None = None
