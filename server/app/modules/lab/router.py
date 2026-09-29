from uuid import UUID

from fastapi import APIRouter, Request

from app.core.db import Db
from app.modules.auth.deps import CurrentAdmin, CurrentUser
from app.modules.channels import service as channels  # M13e guest visibility
from app.modules.lab import rollover, service
from app.modules.lab.schemas import (
    LabProfileOut,
    LabProfilePut,
    MyLabProfileUpdate,
    RolloverApply,
    RolloverOut,
    RolloverPreviewIn,
    RolloverPreviewOut,
)

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


# --- yearly rollover (L7): administrators only ---------------------------------------------


@router.post("/lab/rollover/preview", response_model=RolloverPreviewOut)
async def preview_rollover(body: RolloverPreviewIn, _: CurrentAdmin, db: Db) -> RolloverPreviewOut:
    """Every student with the proposed step (up a grade, or graduation for M2 and D3) and the
    channels a graduate would leave."""
    return await rollover.preview(db, body.academic_year)


@router.get("/lab/rollovers", response_model=list[RolloverOut])
async def list_rollovers(_: CurrentAdmin, db: Db) -> list[RolloverOut]:
    return await rollover.list_rollovers(db)


@router.post("/lab/rollovers", response_model=RolloverOut)
async def apply_rollover(
    body: RolloverApply, request: Request, actor: CurrentAdmin, db: Db
) -> RolloverOut:
    """One transaction for the whole year (409 rollover_applied when it is in force already)."""
    out, role_changed = await rollover.apply(db, actor, body)
    for user_id in role_changed:
        request.app.state.hub.reconnect(user_id)
    return out


@router.post("/lab/rollovers/{academic_year}/undo", response_model=RolloverOut)
async def undo_rollover(
    academic_year: int, request: Request, actor: CurrentAdmin, db: Db
) -> RolloverOut:
    out, role_changed = await rollover.undo(db, actor, academic_year)
    for user_id in role_changed:
        request.app.state.hub.reconnect(user_id)
    return out
