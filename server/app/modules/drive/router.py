"""The drive's HTTP API (docs/DRIVE.md §5, phase D1)."""

from email.utils import format_datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.attachments import service as attachments
from app.modules.attachments.models import Attachment
from app.modules.auth.deps import CurrentUser, require_capability
from app.modules.drive import names, service, uploads
from app.modules.drive.access import item_not_found
from app.modules.drive.models import DriveFileVersion
from app.modules.drive.schemas import (
    DriveChildrenOut,
    DriveFolderCreate,
    DriveItemDetailOut,
    DriveItemOut,
    DriveItemRename,
    DriveLocationListOut,
    DriveLocationOut,
    DriveLocationResolve,
    DriveMoveIn,
    DriveRestoreIn,
    DriveResultsOut,
    DriveTakeoverIn,
    DriveTakeoverOut,
    DriveTrashIn,
    DriveTrashOut,
    DriveUploadCompleteOut,
    DriveUploadCreate,
    DriveUploadListOut,
    DriveUploadOut,
    DriveUploadPartOut,
    DriveUploadPatch,
)
from app.modules.users.models import User

router = APIRouter(tags=["drive"])
DriveAdmin = Annotated[User, Depends(require_capability("drive.admin"))]


def _limit(request: Request, name: str, user: User) -> None:
    limiter = request.app.state.limiters[name]
    key = str(user.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))


# --- locations ---------------------------------------------------------------------------------


@router.get("/drive/locations", response_model=DriveLocationListOut)
async def list_locations(user: CurrentUser, db: Db) -> DriveLocationListOut:
    return DriveLocationListOut(locations=await service.list_locations(db, user))


@router.post("/drive/locations/resolve", response_model=DriveLocationOut)
async def resolve_location(
    data: DriveLocationResolve, user: CurrentUser, db: Db
) -> DriveLocationOut:
    """A channel's drive or my My Drive, made on first use."""
    return await service.resolve(db, user, data)


@router.get("/drive/locations/{location_id}/trash", response_model=DriveTrashOut)
async def list_trash(
    location_id: UUID,
    user: CurrentUser,
    db: Db,
    cursor: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=100, ge=1, le=200),
) -> DriveTrashOut:
    return await service.list_trash(db, user, location_id, cursor=cursor, limit=limit)


# --- items -------------------------------------------------------------------------------------


@router.get("/drive/folders/{folder_id}/children", response_model=DriveChildrenOut)
async def list_children(
    folder_id: UUID,
    user: CurrentUser,
    db: Db,
    sort: Literal["name", "modified", "size"] = Query(default="name"),
    order: Literal["asc", "desc"] = Query(default="asc"),
    cursor: str | None = Query(default=None, max_length=2000),
    limit: int = Query(default=100, ge=1, le=200),
) -> DriveChildrenOut:
    return await service.list_children(
        db, user, folder_id, sort=sort, order=order, cursor=cursor, limit=limit
    )


@router.get("/drive/items/{item_id}", response_model=DriveItemDetailOut)
async def get_item(item_id: UUID, user: CurrentUser, db: Db) -> DriveItemDetailOut:
    return await service.get_item(db, user, item_id)


@router.post(
    "/drive/folders",
    response_model=DriveItemOut,
    status_code=201,
    responses={200: {"model": DriveItemOut, "description": "The folder already existed"}},
)
async def create_folder(data: DriveFolderCreate, user: CurrentUser, db: Db) -> JSONResponse:
    out, created = await service.create_folder(db, user, data)
    return JSONResponse(out.model_dump(mode="json"), status_code=201 if created else 200)


@router.patch("/drive/items/{item_id}", response_model=DriveItemOut)
async def rename_item(
    item_id: UUID, data: DriveItemRename, user: CurrentUser, db: Db
) -> DriveItemOut:
    return await service.rename(db, user, item_id, data.name)


@router.post("/drive/items/move", response_model=DriveResultsOut)
async def move_items(
    data: DriveMoveIn, request: Request, user: CurrentUser, db: Db
) -> DriveResultsOut:
    return await service.move(
        db, user, request.app.state.settings, data.item_ids, data.target_folder_id, data.on_conflict
    )


@router.post("/drive/items/trash", response_model=DriveResultsOut)
async def trash_items(data: DriveTrashIn, user: CurrentUser, db: Db) -> DriveResultsOut:
    return await service.trash(db, user, data.item_ids)


@router.post("/drive/items/{item_id}/restore", response_model=DriveItemOut)
async def restore_item(
    item_id: UUID, user: CurrentUser, db: Db, data: DriveRestoreIn | None = None
) -> DriveItemOut:
    return await service.restore(db, user, item_id, (data or DriveRestoreIn()).on_conflict)


@router.delete("/drive/items/{item_id}", status_code=204)
async def delete_item(item_id: UUID, user: CurrentUser, db: Db) -> Response:
    """For good: only a group in the trash (§3.2)."""
    await service.delete_permanently(db, user, item_id)
    return Response(status_code=204)


@router.get("/drive/items/{item_id}/content")
async def download(
    item_id: UUID,
    request: Request,
    user: CurrentUser,
    db: Db,
    version_id: UUID | None = Query(default=None),
    inline: bool = Query(default=False),
) -> StreamingResponse:
    """The file under its current name (§7.1): Range (one range, 206), If-Range on the version's
    ETag; always an attachment except an image with ?inline=1."""
    item, _ = await service.readable_item(db, user, item_id)
    if item.kind != "file":
        raise item_not_found()
    version = await db.get(DriveFileVersion, version_id or item.current_version_id)
    if version is None or version.item_id != item.id:
        raise item_not_found()
    attachment = await db.get(Attachment, version.attachment_id)
    if attachment is None or attachment.status == "deleted":
        raise item_not_found()
    shown_inline = inline and attachment.content_type in attachments.INLINE_TYPES
    headers = {
        "Content-Disposition": attachments.disposition(
            names.download_name(item.name), inline=shown_inline
        ),
        "Content-Type": attachment.content_type,
        "Content-Length": str(attachment.size_bytes),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "private, max-age=3600",
        "Accept-Ranges": "bytes",
        "ETag": f'"{version.id}"',
        "Last-Modified": format_datetime(version.created_at, usegmt=True),
    }
    return attachments.ranged_response(
        request.app.state.blobs,
        attachment.storage_key,
        attachment.size_bytes,
        headers,
        range_header=request.headers.get("range"),
        if_range=request.headers.get("if-range"),
    )


# --- uploads (§6) ------------------------------------------------------------------------------


@router.post(
    "/drive/uploads",
    response_model=DriveUploadOut,
    status_code=201,
    responses={200: {"model": DriveUploadOut, "description": "This client_upload_id's session"}},
)
async def create_upload(
    data: DriveUploadCreate, request: Request, user: CurrentUser, db: Db
) -> JSONResponse:
    _limit(request, "drive_upload", user)
    out, created = await uploads.create(
        db, user, request.app.state.settings, request.app.state.blobs, data
    )
    return JSONResponse(out.model_dump(mode="json"), status_code=201 if created else 200)


@router.get("/drive/uploads", response_model=DriveUploadListOut)
async def list_uploads(
    user: CurrentUser,
    db: Db,
    status: Literal["active", "completing", "completed", "aborted", "expired"] | None = Query(
        default=None
    ),
) -> DriveUploadListOut:
    """My sessions (?status=active: the ones to resume after reopening the app)."""
    return await uploads.list_mine(db, user, status)


@router.get("/drive/uploads/{upload_id}", response_model=DriveUploadOut)
async def get_upload(upload_id: UUID, user: CurrentUser, db: Db) -> DriveUploadOut:
    return await uploads.get(db, user, upload_id)


@router.patch("/drive/uploads/{upload_id}", response_model=DriveUploadOut)
async def patch_upload(
    upload_id: UUID, data: DriveUploadPatch, user: CurrentUser, db: Db
) -> DriveUploadOut:
    return await uploads.patch(db, user, upload_id, data)


@router.put("/drive/uploads/{upload_id}/parts/{part_number}", response_model=DriveUploadPartOut)
async def put_part(
    upload_id: UUID, part_number: int, request: Request, user: CurrentUser, db: Db
) -> DriveUploadPartOut:
    """The part's bytes as the body (application/octet-stream) with X-Content-SHA256 (hex).
    Sending a number again replaces that part."""
    _limit(request, "drive_part", user)
    return await uploads.receive_part(
        db,
        user,
        request.app.state.settings,
        request.app.state.blobs,
        upload_id,
        part_number,
        request.headers.get("x-content-sha256"),
        request.stream(),
    )


@router.post(
    "/drive/uploads/{upload_id}/complete",
    response_model=DriveUploadCompleteOut,
    responses={202: {"model": DriveUploadCompleteOut, "description": "Still joining the parts"}},
)
async def complete_upload(
    upload_id: UUID, request: Request, user: CurrentUser, db: Db
) -> JSONResponse:
    """200 {completed, item} or 202 {completing} (ask GET /drive/uploads/{id} again)."""
    status, out = await uploads.complete(
        request.app.state.drive,
        db,
        user,
        request.app.state.settings,
        request.app.state.blobs,
        upload_id,
    )
    return JSONResponse(out.model_dump(mode="json"), status_code=status)


@router.delete("/drive/uploads/{upload_id}", status_code=204)
async def abort_upload(upload_id: UUID, request: Request, user: CurrentUser, db: Db) -> Response:
    await uploads.abort(db, user, request.app.state.blobs, upload_id)
    return Response(status_code=204)


# --- administrators (§5.5) ---------------------------------------------------------------------


@router.post("/admin/drive/users/{user_id}/takeover", response_model=DriveTakeoverOut)
async def takeover(
    user_id: UUID, request: Request, admin: DriveAdmin, db: Db, data: DriveTakeoverIn | None = None
) -> DriveTakeoverOut:
    """A deactivated person's My Drive into 研究室ドライブ (§3.3), audited."""
    folder = await service.takeover(
        db,
        admin,
        request.app.state.settings,
        user_id,
        (data or DriveTakeoverIn()).target_folder_name,
    )
    return DriveTakeoverOut(folder=folder)
