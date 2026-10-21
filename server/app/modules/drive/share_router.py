"""The external share links' HTTP API (docs/DRIVE.md §5.4, §5.5, phase D4, M163): the signed-in
side (making, listing, changing and revoking links; the switches) and the public side
(/shares/{token}/…, no sign-in)."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import StreamingResponse

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.auth.deps import CurrentUser, require_capability
from app.modules.drive import public, service, shares
from app.modules.drive.schemas import (
    DriveItemLinksOut,
    DriveLocationOut,
    DriveLocationPatch,
    DriveShareEventListOut,
    DriveShareLinkCreate,
    DriveShareLinkCreatedOut,
    DriveShareLinkListOut,
    DriveShareLinkOut,
    DriveShareLinkPatch,
    DriveShareSettingsOut,
    DriveShareSettingsPatch,
    SharedChildrenOut,
    ShareInfoOut,
    ShareUnlockIn,
)
from app.modules.users.models import User

router = APIRouter(tags=["drive"])
public_router = APIRouter(tags=["shares"])
DriveAdmin = Annotated[User, Depends(require_capability("drive.admin"))]


# --- the signed-in side ------------------------------------------------------------------------


@router.post(
    "/drive/items/{item_id}/links", response_model=DriveShareLinkCreatedOut, status_code=201
)
async def create_link(
    item_id: UUID, data: DriveShareLinkCreate, request: Request, user: CurrentUser, db: Db
) -> DriveShareLinkCreatedOut:
    """A link to a file or a folder (§9). Its address is in this answer only. 403
    drive_links_disabled / guest_restricted / drive_read_only, 409 drive_root_immutable, 422
    share_link_expiry_too_long / share_link_password_required."""
    limiter = request.app.state.limiters["drive_link_create"]
    if not limiter.try_acquire(str(user.id)):
        raise rate_limited(limiter.retry_after_seconds(str(user.id)))
    return await shares.create_link(db, user, request.app.state.settings, item_id, data)


@router.get("/drive/items/{item_id}/links", response_model=DriveItemLinksOut)
async def item_links(
    item_id: UUID, request: Request, user: CurrentUser, db: Db
) -> DriveItemLinksOut:
    """The item's links that are not revoked (mine; every one for those who manage the
    location's links) and what the share dialog may offer."""
    return await shares.item_links(db, user, request.app.state.settings, item_id)


@router.get("/drive/links", response_model=DriveShareLinkListOut)
async def my_links(
    user: CurrentUser,
    db: Db,
    cursor: str | None = Query(default=None, max_length=100),
    limit: int = Query(default=100, ge=1, le=200),
) -> DriveShareLinkListOut:
    """The links I made that are not revoked, newest first."""
    return await shares.my_links(db, user, cursor, limit)


@router.patch("/drive/links/{link_id}", response_model=DriveShareLinkOut)
async def update_link(
    link_id: UUID, data: DriveShareLinkPatch, user: CurrentUser, db: Db
) -> DriveShareLinkOut:
    """Its creator only. `password: null` removes the password."""
    return await shares.update_link(db, user, link_id, data)


@router.delete("/drive/links/{link_id}", status_code=204)
async def revoke_link(link_id: UUID, user: CurrentUser, db: Db) -> Response:
    """Its creator, the location's managers or an administrator; for good."""
    await shares.revoke_link(db, user, link_id)
    return Response(status_code=204)


@router.get("/drive/links/{link_id}/events", response_model=DriveShareEventListOut)
async def link_events(
    link_id: UUID,
    user: CurrentUser,
    db: Db,
    cursor: str | None = Query(default=None, max_length=30),
    limit: int = Query(default=100, ge=1, le=200),
) -> DriveShareEventListOut:
    """How the link was used (§9.5), newest first: its creator and the administrators."""
    return await shares.link_events(db, user, link_id, cursor, limit)


@router.patch("/drive/locations/{location_id}", response_model=DriveLocationOut)
async def patch_location(
    location_id: UUID, data: DriveLocationPatch, user: CurrentUser, db: Db
) -> DriveLocationOut:
    """The location's switch for external links (§3.2: who manages the location). Off stops its
    links; none is removed."""
    location = await shares.set_location_links(db, user, location_id, data.external_links)
    return await service.location_out(db, user, location)


@router.get("/admin/drive/links", response_model=DriveShareLinkListOut)
async def admin_links(
    admin: DriveAdmin,
    db: Db,
    cursor: str | None = Query(default=None, max_length=100),
    limit: int = Query(default=100, ge=1, le=200),
) -> DriveShareLinkListOut:
    """Every link that is not revoked, in every location (§3.4): names, never contents."""
    return await shares.all_links(db, admin, cursor, limit)


@router.delete("/admin/drive/links/{link_id}", status_code=204)
async def admin_revoke_link(link_id: UUID, admin: DriveAdmin, db: Db) -> Response:
    """Audited as drive.link_revoked with by_admin."""
    await shares.revoke_link(db, admin, link_id, as_admin=True)
    return Response(status_code=204)


@router.get("/admin/drive/settings", response_model=DriveShareSettingsOut)
async def get_share_settings(request: Request, admin: DriveAdmin, db: Db) -> DriveShareSettingsOut:
    return shares.settings_out(await shares.policy(db), request.app.state.settings)


@router.patch("/admin/drive/settings", response_model=DriveShareSettingsOut)
async def patch_share_settings(
    data: DriveShareSettingsPatch, request: Request, admin: DriveAdmin, db: Db
) -> DriveShareSettingsOut:
    """The workspace's switch for external links, the longest expiry (null: none required) and
    whether a password is required; audited as workspace.settings_updated."""
    return await shares.update_settings(db, admin, request.app.state.settings, data)


# --- the public side (no sign-in) ----------------------------------------------------------------


@public_router.get("/shares/{token}", response_model=ShareInfoOut)
async def share_info(token: str, request: Request, db: Db) -> ShareInfoOut:
    """What the link shares. 404 share_link_not_found (unknown), 410 share_link_unavailable
    (revoked, expired, used up or stopped); a password link tells nothing more until unlocked."""
    return await public.info(request, db, token)


@public_router.post("/shares/{token}/unlock", status_code=204)
async def share_unlock(token: str, data: ShareUnlockIn, request: Request, db: Db) -> Response:
    """The password: 204 with the unlock cookie (12 hours), 401 share_password_invalid, 429 after
    10 tries in 10 minutes for the link or 20 a minute from one address."""
    response = Response(status_code=204)
    await public.unlock(request, response, db, token, data.password)
    return response


@public_router.get("/shares/{token}/folders/{folder_id}/children", response_model=SharedChildrenOut)
async def share_children(
    token: str,
    folder_id: UUID,
    request: Request,
    db: Db,
    cursor: str | None = Query(default=None, max_length=2000),
    limit: int = Query(default=100, ge=1, le=200),
) -> SharedChildrenOut:
    """A folder under the link (folders first, by name): names, sizes, times, previews only."""
    return await public.children(request, db, token, folder_id, cursor=cursor, limit=limit)


@public_router.api_route("/shares/{token}/items/{item_id}/content", methods=["GET", "HEAD"])
async def share_content(
    token: str, item_id: UUID, request: Request, db: Db, inline: bool = Query(default=False)
) -> Response:
    """A file's bytes (Range; counted against the link's limit)."""
    return await public.content(request, db, token, item_id, inline=inline)


@public_router.get("/shares/{token}/items/{item_id}/thumbnail")
async def share_thumbnail(token: str, item_id: UUID, request: Request, db: Db) -> StreamingResponse:
    return await public.media(request, db, token, item_id, "thumbnail")


@public_router.get("/shares/{token}/items/{item_id}/preview/thumbnail")
async def share_preview_thumbnail(
    token: str, item_id: UUID, request: Request, db: Db
) -> StreamingResponse:
    return await public.media(request, db, token, item_id, "preview_thumbnail")


@public_router.get("/shares/{token}/items/{item_id}/preview/pdf")
async def share_preview_pdf(
    token: str, item_id: UUID, request: Request, db: Db
) -> StreamingResponse:
    return await public.media(request, db, token, item_id, "preview_pdf")


@public_router.get("/shares/{token}/zip")
async def share_zip(
    token: str, request: Request, db: Db, folder_id: UUID | None = Query(default=None)
) -> StreamingResponse:
    """The shared folder (or a folder under it) as one ZIP: one download."""
    return await public.zip_folder(request, db, token, folder_id)
