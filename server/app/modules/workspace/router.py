"""What a client may learn before signing in (WORKSPACES.md §3): which server this is."""

from fastapi import APIRouter, Request

from app.core.db import Db
from app.modules.auth.deps import CurrentAdmin
from app.modules.workspace import default_channels, service
from app.modules.workspace.schemas import (
    AdminWorkspaceSettingsOut,
    DefaultChannelsApply,
    DefaultChannelsApplyOut,
    ServerInfoOut,
    WorkspaceSettingsUpdate,
)

router = APIRouter(tags=["server"])


@router.get("/server", response_model=ServerInfoOut)
async def server_info(request: Request, db: Db) -> ServerInfoOut:
    return ServerInfoOut(
        workspace_id=await service.workspace_id(db) or await service.ensure(db),
        name=request.app.state.settings.workspace_display_name,
        api_version=request.app.version,
    )


def _legacy(request: Request) -> list[str]:
    """SSO_DEFAULT_CHANNELS (deprecated by M90), shown while the list was never saved."""
    names: list[str] = request.app.state.settings.sso_default_channel_names
    return names


@router.get("/admin/workspace-settings", response_model=AdminWorkspaceSettingsOut, tags=["admin"])
async def get_workspace_settings(
    _: CurrentAdmin, db: Db, request: Request
) -> AdminWorkspaceSettingsOut:
    """M88 (docs/MEMBERSHIP.md §3): 「参加・退出の表示」 and
    「参加前にチャンネルの中を見られる」; M90 (§6): 「既定のチャンネル」."""
    return await service.admin_settings(db, _legacy(request))


@router.patch("/admin/workspace-settings", response_model=AdminWorkspaceSettingsOut, tags=["admin"])
async def update_workspace_settings(
    actor: CurrentAdmin, body: WorkspaceSettingsUpdate, db: Db, request: Request
) -> AdminWorkspaceSettingsOut:
    return await service.update_settings(db, actor.id, body, _legacy(request))


@router.post(
    "/admin/workspace-settings/apply-default-channels",
    response_model=DefaultChannelsApplyOut,
    tags=["admin"],
)
async def apply_default_channels(
    actor: CurrentAdmin, body: DefaultChannelsApply, db: Db
) -> DefaultChannelsApplyOut:
    """M90 (docs/MEMBERSHIP.md §6) 「今いる人も全員入れる」: every active non-guest, non-bot
    account joins the default channels it is not in (one join line per channel). Idempotent.
    `dry_run` only counts (the confirmation)."""
    return await default_channels.apply_to_everyone(db, actor, dry_run=body.dry_run)
