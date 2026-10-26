from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from app.core.db import Db
from app.modules.auth.deps import CurrentUser, require_capability
from app.modules.lending import service
from app.modules.lending.schemas import (
    HISTORY_LIMIT_MAX,
    LendingCategoryCreate,
    LendingCategoryOut,
    LendingCategoryUpdate,
    LendingItemCreate,
    LendingItemDetailOut,
    LendingItemHistoryOut,
    LendingItemOut,
    LendingItemStatusIn,
    LendingItemUpdate,
    LendingSettingsOut,
    LendingSettingsUpdate,
)
from app.modules.users.models import User

router = APIRouter(tags=["lending"])

LendingManager = Annotated[User, Depends(require_capability("lending.manage"))]

# docs/LENDING.md §5 (M167 = L1: the ledger). Every person (not guests or bots: 403
# guest_restricted) sees the ledger while the workspace has the feature on (else 409
# lending_disabled, except for the settings); the 備品係 (keepers) and the holders of
# lending.manage change it (403 lending_keeper_required).


@router.get("/lending/settings", response_model=LendingSettingsOut)
async def get_settings(user: CurrentUser, db: Db) -> LendingSettingsOut:
    """The switch, the keepers and the defaults, and whether I am a keeper (also while off)."""
    return await service.get_settings(db, user)


@router.patch("/admin/lending/settings", response_model=LendingSettingsOut, tags=["admin"])
async def update_settings(
    body: LendingSettingsUpdate, actor: LendingManager, db: Db
) -> LendingSettingsOut:
    """`lending.manage`. 400 lending_keeper_invalid (details.user_ids) for a keeper added who is
    unknown, deactivated, a guest or a bot; more than 20 keepers, numbers out of range and unknown
    zones are 422."""
    return await service.update_settings(db, actor, body)


@router.get("/lending/categories", response_model=list[LendingCategoryOut])
async def list_categories(user: CurrentUser, db: Db) -> list[LendingCategoryOut]:
    """In the keepers' order."""
    return await service.list_categories(db, user)


@router.post("/lending/categories", response_model=LendingCategoryOut, status_code=201)
async def create_category(
    body: LendingCategoryCreate, user: CurrentUser, db: Db
) -> LendingCategoryOut:
    """Keepers. 409 lending_category_name_taken (details.existing_id), too_many_lending_categories
    (details.limit: 50)."""
    return await service.create_category(db, user, body)


@router.patch("/lending/categories/{category_id}", response_model=LendingCategoryOut)
async def update_category(
    category_id: UUID, body: LendingCategoryUpdate, user: CurrentUser, db: Db
) -> LendingCategoryOut:
    """Keepers. A new default applies to the coming loans of the items without their own value
    (loans already made keep theirs)."""
    return await service.update_category(db, user, category_id, body)


@router.delete("/lending/categories/{category_id}", status_code=204)
async def delete_category(category_id: UUID, user: CurrentUser, db: Db) -> Response:
    """Keepers. 409 lending_category_in_use (details.item_count) while items (retired ones too)
    are in it."""
    await service.delete_category(db, user, category_id)
    return Response(status_code=204)


@router.get("/lending/items", response_model=list[LendingItemOut])
async def list_items(
    user: CurrentUser,
    db: Db,
    include_retired: Annotated[bool, Query()] = False,
) -> list[LendingItemOut]:
    """Every item (retired ones with `include_retired`) in the Japanese name order, not paged
    (at most 2,000): clients filter by category, status and text themselves."""
    return await service.list_items(db, user, include_retired=include_retired)


@router.post("/lending/items", response_model=LendingItemDetailOut, status_code=201)
async def create_item(body: LendingItemCreate, user: CurrentUser, db: Db) -> LendingItemDetailOut:
    """Keepers. 409 lending_code_taken (details.existing_id; among the items not retired),
    too_many_lending_items (details.limit: 2,000), 404 lending_category_not_found, 400
    lending_photo_invalid (not my own new upload of a JPEG, PNG, WebP or HEIC image)."""
    return await service.create_item(db, user, body)


@router.get("/lending/items/{item_id}", response_model=LendingItemDetailOut)
async def get_item(item_id: UUID, user: CurrentUser, db: Db) -> LendingItemDetailOut:
    return await service.get_item(db, user, item_id)


@router.patch("/lending/items/{item_id}", response_model=LendingItemDetailOut)
async def update_item(
    item_id: UUID, body: LendingItemUpdate, user: CurrentUser, db: Db
) -> LendingItemDetailOut:
    """Keepers. null clears a field (`photo_attachment_id: null` removes the photo; a replaced or
    removed photo is deleted). The status changes through /status."""
    return await service.update_item(db, user, item_id, body)


@router.post("/lending/items/{item_id}/status", response_model=LendingItemDetailOut)
async def set_status(
    item_id: UUID, body: LendingItemStatusIn, user: CurrentUser, db: Db
) -> LendingItemDetailOut:
    """Keepers: available / in_repair / retired with an optional reason. 409 lending_item_on_loan
    while lent; lending_code_taken back from retired when its number was given again meanwhile.
    The same status and reason again: no change."""
    return await service.set_status(db, user, item_id, body)


@router.delete("/lending/items/{item_id}", status_code=204)
async def delete_item(item_id: UUID, user: CurrentUser, db: Db) -> Response:
    """Keepers. 409 lending_item_has_history for an item that was ever lent (retire it)."""
    await service.delete_item(db, user, item_id)
    return Response(status_code=204)


@router.get("/lending/items/{item_id}/history", response_model=LendingItemHistoryOut)
async def item_history(
    item_id: UUID,
    user: CurrentUser,
    db: Db,
    before: Annotated[UUID | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=HISTORY_LIMIT_MAX)] = 50,
) -> LendingItemHistoryOut:
    """The item's history, newest first; `before` = the previous page's `next_before`."""
    return await service.history(db, user, item_id, before=before, limit=limit)
