"""What a client may learn before signing in (WORKSPACES.md §3): which server this is."""

from fastapi import APIRouter, Request

from app.core.db import Db
from app.modules.workspace import service
from app.modules.workspace.schemas import ServerInfoOut

router = APIRouter(tags=["server"])


@router.get("/server", response_model=ServerInfoOut)
async def server_info(request: Request, db: Db) -> ServerInfoOut:
    return ServerInfoOut(
        workspace_id=await service.workspace_id(db) or await service.ensure(db),
        name=request.app.state.settings.workspace_display_name,
        api_version=request.app.version,
    )
