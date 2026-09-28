from uuid import UUID

from fastapi import APIRouter

from app.core.db import Db
from app.modules.auth.deps import CurrentAdmin, CurrentUser
from app.modules.channels import service as channels  # M13e guest visibility
from app.modules.lab import service
from app.modules.lab.schemas import LabProfileOut, LabProfilePut, MyLabProfileUpdate

router = APIRouter(tags=["lab"])


@router.get("/lab/roster", response_model=list[LabProfileOut])
async def get_roster(user: CurrentUser, db: Db) -> list[LabProfileOut]:
    """The lab roster in roster order (M23); also part of the bootstrap. Guests get only the people
    they share a channel with (M13e)."""
    return await service.roster(db, await channels.visible_user_ids(db, user))


@router.patch("/lab/roster/me", response_model=LabProfileOut)
async def update_my_line(user: CurrentUser, body: MyLabProfileUpdate, db: Db) -> LabProfileOut:
    """My research topic and reading (404 roster_entry_not_found while I am not on the roster)."""
    return await service.update_mine(db, user, body)


@router.put("/lab/roster/{user_id}", response_model=LabProfileOut)
async def put_line(
    user_id: UUID, actor: CurrentAdmin, body: LabProfilePut, db: Db
) -> LabProfileOut:
    """Put someone on the roster or change their line; the managed groups follow."""
    return await service.put(db, actor, user_id, body)


@router.delete("/lab/roster/{user_id}", status_code=204)
async def remove_line(user_id: UUID, actor: CurrentAdmin, db: Db) -> None:
    await service.remove(db, actor, user_id)
