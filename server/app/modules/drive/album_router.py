"""The albums' HTTP API (AL1, docs/ALBUMS.md §5) and the display-size image of an attachment."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from app.core.db import Db
from app.core.errors import AppError
from app.modules.attachments import service as attachments
from app.modules.auth.deps import CurrentUser
from app.modules.drive import albums, photos
from app.modules.drive.schemas import (
    AlbumAddIn,
    AlbumAddOut,
    AlbumCreate,
    AlbumCreatedOut,
    AlbumDetailOut,
    AlbumListOut,
    AlbumOut,
    AlbumPut,
)
from app.modules.drive.uploads import DriveRuntime

router = APIRouter(tags=["drive"])


def _wake(request: Request) -> None:
    runtime: DriveRuntime = request.app.state.drive
    runtime.media_wake.set()
    if runtime.preview_wake is not None:
        runtime.preview_wake.set()


@router.post(
    "/drive/albums",
    response_model=AlbumCreatedOut,
    status_code=201,
    responses={200: {"model": AlbumCreatedOut, "description": "This client_op_id's album"}},
)
async def create_album(data: AlbumCreate, user: CurrentUser, db: Db) -> JSONResponse:
    """A new folder that is an album, in `parent_id` or in the 「アルバム」 folder of
    `location_id` (made when missing). 409 drive_name_taken, 422 drive_album_invalid (a
    description over 2,000 characters, dates the wrong way round), 403 drive_read_only."""
    out, created = await albums.create(db, user, data)
    return JSONResponse(out.model_dump(mode="json"), status_code=201 if created else 200)


@router.get("/drive/albums", response_model=AlbumListOut)
async def list_albums(
    request: Request,
    user: CurrentUser,
    db: Db,
    location_id: UUID | None = Query(default=None),
    cursor: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=50, ge=1, le=100),
) -> AlbumListOut:
    """The albums of the locations I can read (`location_id`: one of them), newest first: by
    their first day, else the day they were made. Never in the trash."""
    return await albums.list_albums(
        db,
        user,
        request.app.state.settings,
        location_id=location_id,
        cursor=cursor,
        limit=limit,
    )


@router.get("/drive/albums/{folder_id}", response_model=AlbumDetailOut)
async def album_detail(
    folder_id: UUID,
    user: CurrentUser,
    db: Db,
    sort: Literal["taken", "name", "added"] | None = Query(default=None),
    order: Literal["asc", "desc"] | None = Query(default=None),
    cursor: str | None = Query(default=None, max_length=2000),
    limit: int = Query(default=100, ge=1, le=200),
) -> AlbumDetailOut:
    """The album and a page of its photos and videos (the album's order unless `sort` / `order`
    are given). 404 drive_album_not_found for a folder that is not an album, drive_item_not_found
    for one I cannot read."""
    return await albums.detail(
        db, user, folder_id, sort=sort, order=order, cursor=cursor, limit=limit
    )


@router.put("/drive/folders/{folder_id}/album", response_model=AlbumOut)
async def put_album(folder_id: UUID, data: AlbumPut, user: CurrentUser, db: Db) -> AlbumOut:
    """Makes a folder an album or changes it (whoever can write in the location). 422
    drive_album_invalid: the location's top folder, 「投稿のファイル」, a cover that is not a photo
    or video directly in it, a description over 2,000 characters, dates the wrong way round."""
    return await albums.put(db, user, folder_id, data)


@router.delete("/drive/folders/{folder_id}/album", status_code=204)
async def delete_album(folder_id: UUID, user: CurrentUser, db: Db) -> Response:
    """A plain folder again; its files stay."""
    await albums.remove(db, user, folder_id)
    return Response(status_code=204)


@router.post("/drive/albums/{folder_id}/add", response_model=AlbumAddOut)
async def add_to_album(
    folder_id: UUID, data: AlbumAddIn, request: Request, user: CurrentUser, db: Db
) -> AlbumAddOut:
    """Photos into the album (docs/ALBUMS.md §9): one result per source. A file posted in the
    album's own channel drive is moved (its message does not change); one posted elsewhere and
    an ordinary attachment are copied; drive items are moved within the location, copied from
    another (`mode` overrides). The same `client_op_id` again makes no second copy."""
    out, woke = await albums.add(
        db, user, request.app.state.settings, request.app.state.blobs, folder_id, data
    )
    if woke:
        _wake(request)
    return out


@router.get("/attachments/{attachment_id}/display")
async def display(
    attachment_id: UUID, request: Request, user: CurrentUser, db: Db
) -> StreamingResponse:
    """AL1 (docs/ALBUMS.md §6): the display-size image (long edge at most 2048 px, WebP, no
    metadata) for the full-screen viewer. Without one yet, the original image (PNG, JPEG, GIF,
    WebP only; a drive image not read yet is queued to get one); 404 display_not_found for
    anything else. Read as the attachment itself (`get_for_access`)."""
    attachment = await attachments.get_for_access(db, user, attachment_id)
    blobs = request.app.state.blobs
    if attachment.display_key is not None:
        await db.commit()
        return StreamingResponse(
            attachments.stream(blobs, attachment.display_key),
            headers={
                "Content-Type": "image/webp",
                "Content-Disposition": "inline",
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, max-age=86400",
            },
        )
    if attachment.content_type not in attachments.INLINE_TYPES:
        raise AppError(404, "display_not_found", "This file has no display image")
    queued = await photos.requeue_in_tx(db, attachment)
    key, content_type = attachment.storage_key, attachment.content_type
    await db.commit()
    if queued:
        request.app.state.drive.media_wake.set()
    return StreamingResponse(
        attachments.stream(blobs, key),
        headers={
            "Content-Type": content_type,
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
            "Cache-Control": "private, max-age=3600",
        },
    )
