from fastapi import APIRouter

from app.core.db import Db
from app.modules.auth.deps import CurrentUser
from app.modules.sync import service
from app.modules.sync.schemas import BootstrapOut

router = APIRouter(prefix="/sync", tags=["sync"])


@router.get("/bootstrap", response_model=BootstrapOut)
async def bootstrap(user: CurrentUser, db: Db) -> BootstrapOut:
    return await service.bootstrap(db, user)
