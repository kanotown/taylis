from fastapi import APIRouter, Request

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.sync import service
from app.modules.sync.schemas import BootstrapOut, UnreadSummaryOut

router = APIRouter(prefix="/sync", tags=["sync"])


@router.get("/bootstrap", response_model=BootstrapOut)
async def bootstrap(request: Request, user: CurrentUser, db: Db) -> BootstrapOut:
    state = request.app.state
    return await service.bootstrap(db, user, state.settings, state.hub.presence_snapshot())


@router.get("/summary", response_model=UnreadSummaryOut)
async def unread_summary(user: CurrentUser, db: Db) -> UnreadSummaryOut:
    """Badges for a workspace the client has not opened (WORKSPACES.md §6)."""
    return await service.unread_summary(db, user)
