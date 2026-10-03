"""What a client may learn before signing in (WORKSPACES.md §3): which server this is."""

from fastapi import APIRouter, Request

from app.core.db import Db
from app.modules.auth.deps import CurrentAdmin
from app.modules.workspace import service
from app.modules.workspace.schemas import (
    AdminWorkspaceSettingsOut,
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


@router.get("/admin/workspace-settings", response_model=AdminWorkspaceSettingsOut, tags=["admin"])
async def get_workspace_settings(_: CurrentAdmin, db: Db) -> AdminWorkspaceSettingsOut:
    """M88 (docs/MEMBERSHIP.md §3): 「参加・退出の表示」 and
    「参加前にチャンネルの中を見られる」."""
    return await service.admin_settings(db)


@router.patch("/admin/workspace-settings", response_model=AdminWorkspaceSettingsOut, tags=["admin"])
async def update_workspace_settings(
    actor: CurrentAdmin, body: WorkspaceSettingsUpdate, db: Db
) -> AdminWorkspaceSettingsOut:
    return await service.update_settings(db, actor.id, body)
