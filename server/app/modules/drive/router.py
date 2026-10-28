"""The drive's HTTP API (docs/DRIVE.md §5: phases D1 to D3, and D6's conversation side)."""

from collections.abc import AsyncIterator
from email.utils import format_datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from app.core.db import Db
from app.core.errors import rate_limited
from app.modules.attachments import service as attachments
from app.modules.attachments.models import Attachment
from app.modules.attachments.schemas import AttachmentOut
from app.modules.auth.deps import CurrentUser, require_capability
from app.modules.drive import (
    channel_files,
    conversation,
    copying,
    names,
    service,
    uploads,
    usage,
    versions,
    zips,
    zipstream,
)
from app.modules.drive.access import item_not_found
from app.modules.drive.models import DriveFileVersion, DriveItem
from app.modules.drive.schemas import (
    DriveChildrenOut,
    DriveCopyIn,
    DriveCopyResultsOut,
    DriveDownloadTicketOut,
    DriveFolderCreate,
    DriveImpactIn,
    DriveImpactOut,
    DriveItemDetailOut,
    DriveItemOut,
    DriveItemRename,
    DriveLocationListOut,
    DriveLocationOut,
    DriveLocationResolve,
    DriveLocationUsageOut,
    DriveMoveIn,
    DrivePreviewOut,
    DriveQuotaIn,
    DriveReachOut,
    DriveRestoreIn,
    DriveResultsOut,
    DriveSaveAttachmentIn,
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
    DriveUsageOut,
    DriveVersionListOut,
    DriveZipIn,
    DriveZipOut,
)
from app.modules.drive.uploads import DriveRuntime
from app.modules.drive.zips import ZipJob
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


@router.post("/drive/items/impact", response_model=DriveImpactOut)
async def item_impact(data: DriveImpactIn, user: CurrentUser, db: Db) -> DriveImpactOut:
    """CF1 (docs/CHANNEL_FILES.md §6.4): before a move into `target_folder_id` (or, without one,
    a trash), what it would do to the messages showing posted files among the items (and what is
    under them): per channel I can read, the messages concerned and how many members (guests
    among them) would no longer see a file in its message. Nothing is changed. 404 for an item
    (or a target) I cannot read."""
    out = await channel_files.impact(db, user, data)
    await db.rollback()
    return out


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


async def _content(
    request: Request,
    db: Db,
    item: DriveItem,
    version_id: UUID | None,
    inline: bool,
    *,
    cache: str = "private, max-age=3600",
) -> Response:
    """A file's bytes under its current name (§7.1): Range (one range, 206), If-Range on the
    version's ETag; always an attachment except an image with ?inline=1."""
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
        "Content-Type": attachments.served_type(attachment.content_type),
        "Content-Length": str(attachment.size_bytes),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
        "Cache-Control": cache,
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
        head=request.method == "HEAD",
    )


@router.get(
    "/drive/items/{item_id}/content",
    operation_id="download_api_v1_drive_items__item_id__content_get",
)
@router.head(
    "/drive/items/{item_id}/content",
    operation_id="download_api_v1_drive_items__item_id__content_head",
)
async def download(
    item_id: UUID,
    request: Request,
    user: CurrentUser,
    db: Db,
    version_id: UUID | None = Query(default=None),
    inline: bool = Query(default=False),
) -> Response:
    """The file under its current name (§7.1), with the bearer token (the desktop app)."""
    item, _ = await service.readable_item(db, user, item_id)
    return await _content(request, db, item, version_id, inline)


@router.post("/drive/items/{item_id}/download-ticket", response_model=DriveDownloadTicketOut)
async def download_ticket(
    item_id: UUID,
    request: Request,
    user: CurrentUser,
    db: Db,
    version_id: UUID | None = Query(default=None),
) -> DriveDownloadTicketOut:
    """Phase D2 (§7.3): a URL for the browser's own download or a video's source, without the
    bearer token (the Web keeps it in memory only). Valid while used within `expires_in`
    seconds (at most 12 hours); each use checks the access again."""
    item, _ = await service.readable_item(db, user, item_id)
    if item.kind != "file":
        raise item_not_found()
    version = await db.get(DriveFileVersion, version_id or item.current_version_id)
    if version is None or version.item_id != item.id:
        raise item_not_found()
    runtime: DriveRuntime = request.app.state.drive
    token = runtime.tickets.issue(user.id, item.id, version.id)
    return DriveDownloadTicketOut(
        url=f"/api/v1/drive/download/{token}", expires_in=int(runtime.tickets.idle_seconds)
    )


@router.get(
    "/drive/download/{token}",
    operation_id="download_by_ticket_api_v1_drive_download__token__get",
)
@router.head(
    "/drive/download/{token}",
    operation_id="download_by_ticket_api_v1_drive_download__token__head",
)
async def download_by_ticket(
    token: str,
    request: Request,
    db: Db,
    inline: bool = Query(default=False),
) -> Response:
    """The file of a download ticket (no bearer token): 404 for an unknown or expired ticket and
    for a person who can no longer read the file."""
    runtime: DriveRuntime = request.app.state.drive
    ticket = runtime.tickets.use(token) if len(token) <= 100 else None
    if ticket is None:
        raise item_not_found()
    user = await db.get(User, ticket.user_id)
    if user is None or not user.is_active:
        raise item_not_found()
    item, _ = await service.readable_item(db, user, ticket.item_id)
    return await _content(request, db, item, ticket.version_id, inline, cache="private, no-store")


# --- versions, copies, ZIPs (phase D3) --------------------------------------------------------


def _wake(request: Request) -> None:
    """New versions to read (SHA-256, thumbnails) and previews to make."""
    runtime: DriveRuntime = request.app.state.drive
    runtime.media_wake.set()
    if runtime.preview_wake is not None:
        runtime.preview_wake.set()


@router.post("/drive/items/{item_id}/preview", response_model=DrivePreviewOut)
async def request_preview(
    item_id: UUID, request: Request, user: CurrentUser, db: Db
) -> DrivePreviewOut:
    """2026-10-22 (§27): asks for the preview of a file's current version when it was never made
    (imported files, §24): 'pending' until the preview loop makes it (drive.changed then). Only
    a file without one is queued; a ready, pending or failed preview is answered as it is, and
    null means this file gets none (the viewer offers the download instead)."""
    out, queued = await service.request_preview(db, user, request.app.state.settings, item_id)
    if queued:
        _wake(request)
    return out


@router.get("/drive/items/{item_id}/versions", response_model=DriveVersionListOut)
async def list_versions(
    item_id: UUID, request: Request, user: CurrentUser, db: Db
) -> DriveVersionListOut:
    """Newest first (§10.2)."""
    return await versions.list_versions(db, user, request.app.state.settings, item_id)


@router.post("/drive/items/{item_id}/versions/{version_id}/restore", response_model=DriveItemOut)
async def restore_version(
    item_id: UUID, version_id: UUID, request: Request, user: CurrentUser, db: Db
) -> DriveItemOut:
    """The version copied as the file's new current version (the versions in between stay)."""
    out = await versions.restore_version(
        db, user, request.app.state.settings, request.app.state.blobs, item_id, version_id
    )
    _wake(request)
    return out


@router.delete("/drive/items/{item_id}/versions/{version_id}", status_code=204)
async def delete_version(item_id: UUID, version_id: UUID, user: CurrentUser, db: Db) -> Response:
    """An older version for good (who may delete for good, §3.2); the current one: 409."""
    await versions.delete_version(db, user, item_id, version_id)
    return Response(status_code=204)


@router.post("/drive/items/copy", response_model=DriveCopyResultsOut)
async def copy_items(
    data: DriveCopyIn, request: Request, user: CurrentUser, db: Db
) -> DriveCopyResultsOut:
    """Files and folders into a folder (§10.3): one result per item, `new_id` for its copy.
    413 drive_copy_too_large past DRIVE_COPY_MAX_ITEMS / DRIVE_COPY_MAX_BYTES."""
    out, woke = await copying.copy(
        db, user, request.app.state.settings, request.app.state.blobs, data
    )
    if woke:
        _wake(request)
    return out


@router.post("/drive/zip", response_model=DriveZipOut)
async def create_zip(data: DriveZipIn, request: Request, user: CurrentUser, db: Db) -> DriveZipOut:
    """A ZIP of folders and files (§7.2): what it holds is fixed now; `url` streams it once
    within `expires_in` seconds. 413 drive_zip_too_large past the limits."""
    job = await zips.prepare(db, user, request.app.state.settings, data.item_ids)
    await db.commit()
    runtime: DriveRuntime = request.app.state.drive
    token = runtime.zip_tickets.issue(user.id, job)
    return DriveZipOut(
        url=f"/api/v1/drive/zip/{token}",
        expires_in=int(runtime.zip_tickets.seconds),
        entries=len(job.plan.entries),
        size_bytes=job.plan.bytes_total,
        zip_bytes=job.plan.length,
        filename=job.filename,
    )


@router.get("/drive/zip/{token}")
async def download_zip(token: str, request: Request, db: Db) -> StreamingResponse:
    """The ZIP of a ticket (no bearer token; used once): stored entries, ZIP64 where needed,
    Content-Length exact. 404 for an unknown or used ticket or a person who can no longer read
    the items; 409 drive_zip_outdated when an item inside can no longer be read (moved, in the
    trash; make a new ZIP); 429 while too many ZIPs stream (the ticket stays valid)."""
    runtime: DriveRuntime = request.app.state.drive
    settings = request.app.state.settings
    ticket = runtime.zip_tickets.peek(token) if len(token) <= 100 else None
    if ticket is None or not isinstance(ticket.job, ZipJob):
        raise item_not_found()
    job = ticket.job
    if not await zips.still_readable(db, job):
        runtime.zip_tickets.take(token)
        raise item_not_found()
    if not await zips.entries_readable(db, job):
        # REVIEW-v0.1.70 #2: an entry moved where the person cannot read it, or into the trash.
        runtime.zip_tickets.take(token)
        raise zips.zip_outdated()
    await db.commit()
    if not runtime.zip_slots.try_acquire(
        job.user_id, per_user=settings.drive_zip_per_user, total=settings.drive_zip_total
    ):
        raise rate_limited(10)
    if runtime.zip_tickets.take(token) is None:
        runtime.zip_slots.release(job.user_id)
        raise item_not_found()
    blobs = request.app.state.blobs

    async def body() -> AsyncIterator[bytes]:
        try:
            async for chunk in zipstream.stream(job.plan, lambda key: blobs.stream(key)):
                yield chunk
        finally:
            runtime.zip_slots.release(job.user_id)

    headers = {
        "Content-Disposition": attachments.disposition(job.filename, inline=False),
        "Content-Length": str(job.plan.length),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "private, no-store",
    }
    return StreamingResponse(body(), media_type="application/zip", headers=headers)


# --- conversations (phase D6, §13) -------------------------------------------------------------


@router.post("/drive/items/{item_id}/attach-copy", response_model=AttachmentOut, status_code=201)
async def attach_copy(item_id: UUID, request: Request, user: CurrentUser, db: Db) -> AttachmentOut:
    """The file's current version as a pending attachment of mine (copied inside the store), to
    send with a message like an upload. 413 attachment_too_large past ATTACHMENT_MAX_BYTES."""
    _limit(request, "upload", user)
    out = await conversation.attach_copy(
        db, user, request.app.state.settings, request.app.state.blobs, item_id
    )
    if out.preview is not None and out.preview.status == "pending":
        request.app.state.preview_wake.set()
    return out


@router.post(
    "/drive/save-attachment",
    response_model=DriveItemOut,
    status_code=201,
    responses={200: {"model": DriveItemOut, "description": "This client_op_id's file"}},
)
async def save_attachment(
    data: DriveSaveAttachmentIn, request: Request, user: CurrentUser, db: Db
) -> JSONResponse:
    """An attachment I can read copied into a folder I can write, as a new file. 404
    attachment_not_found for an attachment I cannot read (or a pending one, or a drive file's)."""
    _limit(request, "upload", user)
    out, created = await conversation.save_attachment(
        db, user, request.app.state.settings, request.app.state.blobs, data
    )
    if created:
        _wake(request)
    return JSONResponse(out.model_dump(mode="json"), status_code=201 if created else 200)


@router.get("/drive/items/{item_id}/reach", response_model=DriveReachOut)
async def item_reach(
    item_id: UUID, user: CurrentUser, db: Db, channel_id: UUID = Query()
) -> DriveReachOut:
    """How many of the conversation's members can and cannot read the item (the composer's
    warning before a `/d/<id>` link is sent)."""
    return await conversation.reach(db, user, item_id, channel_id)


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
    """200 {completed, item} or 202 {completing} (ask GET /drive/uploads/{id} again). `item` and
    `version_id` are null when the uploader can no longer read the file (moved elsewhere, a
    channel left). 409 drive_upload_target_moved: the folder moved to another drive, the session
    ended. 409 drive_upload_incomplete (`details.missing`): parts to send, also after the store
    refused parts whose bytes differed (the session is active again without them)."""
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


@router.get("/admin/drive/usage", response_model=DriveUsageOut)
async def drive_usage(request: Request, admin: DriveAdmin, db: Db) -> DriveUsageOut:
    """The whole drive and each location: sizes and counts only (§11.2)."""
    return await usage.usage(db, request.app.state.settings)


@router.patch("/admin/drive/locations/{location_id}", response_model=DriveLocationUsageOut)
async def set_location_quota(
    location_id: UUID, data: DriveQuotaIn, request: Request, admin: DriveAdmin, db: Db
) -> DriveLocationUsageOut:
    """A location's own quota in bytes (null: none), audited as drive.quota_changed."""
    return await usage.set_quota(
        db, admin, request.app.state.settings, location_id, data.quota_bytes
    )


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
