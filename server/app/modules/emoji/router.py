from uuid import UUID

from fastapi import APIRouter, File, Form, Header, Query, Request, Response, UploadFile
from fastapi.responses import StreamingResponse

from app.core.db import Db
from app.core.errors import AppError, bad_request, forbidden, rate_limited
from app.modules.attachments import service as attachments
from app.modules.auth.deps import CurrentUser, EmojiManager
from app.modules.emoji import service
from app.modules.emoji.schemas import (
    CustomEmojiOut,
    CustomEmojiUpdate,
    EmojiPackCreate,
    EmojiPackImportOut,
    EmojiPackOut,
    EmojiPackUpdate,
    TextEmojiCreate,
    image_version,
    to_pack_out,
)
from app.modules.users.models import User

router = APIRouter(tags=["emoji"])

# A ZIP, or a folder's files together (Review v0.1.37 #8); infra/Caddyfile lets 70 MB through on
# this path (this plus the multipart overhead), every other /api/* request stays at 1 MB.
PACK_UPLOAD_MAX_BYTES = 64 * 1024 * 1024


# docs/EMOJI.md §2.1: a request naming the current version (`?v=`) gets bytes that never change
# for that URL; one without it (older clients) the day-long caching it always had.
IMMUTABLE_CACHE = "private, max-age=31536000, immutable"
DAY_CACHE = "private, max-age=86400"


def _matches(if_none_match: str | None, etag: str) -> bool:
    if if_none_match is None:
        return False
    tags = [t.strip().removeprefix("W/") for t in if_none_match.split(",")]
    return "*" in tags or etag in tags


def _image_response(
    request: Request,
    key: str,
    content_type: str,
    version: str,
    asked: str | None,
    if_none_match: str | None,
) -> Response:
    etag = f'"{version}"'
    cache = IMMUTABLE_CACHE if asked == version else DAY_CACHE
    if _matches(if_none_match, etag):
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": cache})
    return StreamingResponse(
        attachments.stream(request.app.state.blobs, key),
        headers={
            "Content-Type": content_type,
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": cache,
            "ETag": etag,
        },
    )


def _limit_uploads(request: Request, user: User) -> None:
    limiter = request.app.state.limiters["upload"]
    key = str(user.id)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))


@router.get("/emoji", response_model=list[CustomEmojiOut])
async def list_emoji(user: CurrentUser, db: Db) -> list[CustomEmojiOut]:
    """Every custom emoji, by name (also part of bootstrap)."""
    return await service.list_all(db)


@router.post("/emoji", response_model=CustomEmojiOut, status_code=201)
async def add_emoji(
    request: Request,
    user: CurrentUser,
    db: Db,
    name: str = Form(...),
    file: UploadFile = File(...),
    label: str | None = Form(None),
    keywords: list[str] = Form([]),
) -> CustomEmojiOut:
    """M12f: any member adds a `:name:` (2-32 chars of a-z 0-9 _ + -) with a small image.
    M100: an optional `label` (display name) and `keywords` (repeated field) for search."""
    if user.is_guest:
        raise forbidden("guest_restricted", "Guests cannot add emoji")
    _limit_uploads(request, user)
    return await service.upload(
        db,
        user,
        name,
        file,
        request.app.state.settings,
        request.app.state.blobs,
        label=label,
        keywords=keywords,
    )


@router.post("/emoji/text", response_model=CustomEmojiOut, status_code=201)
async def add_text_emoji(
    body: TextEmojiCreate, request: Request, user: CurrentUser, db: Db
) -> CustomEmojiOut:
    """M100: a text emoji: `:name:` drawn as a pill with `label` (at most 12 characters, e.g.
    「確認しました」) in one of the palette's colours."""
    if user.is_guest:
        raise forbidden("guest_restricted", "Guests cannot add emoji")
    _limit_uploads(request, user)
    return await service.create_text(db, user, body)


@router.patch("/emoji/{emoji_id}", response_model=CustomEmojiOut)
async def update_emoji(
    emoji_id: UUID, body: CustomEmojiUpdate, user: CurrentUser, db: Db
) -> CustomEmojiOut:
    """M100: label, colour (text emoji) and keywords by the creator or an admin; the pack and
    the order inside it by an admin."""
    return await service.update_emoji(db, user, emoji_id, body)


@router.delete("/emoji/{emoji_id}", status_code=204)
async def delete_emoji(emoji_id: UUID, request: Request, user: CurrentUser, db: Db) -> Response:
    """The creator or an admin removes it; bodies keep the text `:name:`."""
    await service.delete(db, user, emoji_id, request.app.state.blobs)
    return Response(status_code=204)


@router.get(
    "/emoji/{emoji_id}/image",
    responses={304: {"description": "If-None-Match matched the image's version (ETag)"}},
)
async def emoji_image(
    emoji_id: UUID,
    request: Request,
    user: CurrentUser,
    db: Db,
    v: str | None = Query(default=None, max_length=64),
    if_none_match: str | None = Header(default=None),
) -> Response:
    """The image. `v` = the emoji's `image_version`: the response may then be kept for good
    (docs/EMOJI.md §2.1). ETag is the version; If-None-Match → 304."""
    row = await service.require_image(db, emoji_id)
    version = image_version(row.storage_key) or ""
    return _image_response(request, row.storage_key, row.content_type, version, v, if_none_match)


# ---- packs (M100) -------------------------------------------------------------------------


@router.get("/emoji/packs", response_model=list[EmojiPackOut])
async def list_packs(user: CurrentUser, db: Db) -> list[EmojiPackOut]:
    """Every emoji pack in tab order (also part of bootstrap)."""
    return await service.list_packs(db)


@router.post("/emoji/packs", response_model=EmojiPackOut, status_code=201)
async def create_pack(body: EmojiPackCreate, admin: EmojiManager, db: Db) -> EmojiPackOut:
    """An empty pack; emoji join it with PATCH /emoji/{id} `pack_id` (admin)."""
    return await service.create_pack(db, admin, body.name)


@router.post("/emoji/packs/import", response_model=EmojiPackImportOut)
async def import_pack(
    request: Request,
    admin: EmojiManager,
    db: Db,
    archive: UploadFile | None = File(None),
    files: list[UploadFile] = File([]),
) -> EmojiPackImportOut:
    """Create or update a pack from a folder's files (repeated `files`, pack.json among them)
    or a ZIP (`archive`) with a pack.json (docs/EMOJI.md §4). Idempotent by pack name and
    shortcode; all or nothing."""
    _limit_uploads(request, admin)
    settings = request.app.state.settings
    found: dict[str, bytes] = {}
    if archive is not None:
        data = await archive.read(PACK_UPLOAD_MAX_BYTES + 1)
        if len(data) > PACK_UPLOAD_MAX_BYTES:
            raise AppError(413, "emoji_too_large", "The ZIP is too large")
        found = service.read_archive(data, settings)
    else:
        if not files:
            raise bad_request("emoji_pack_manifest_invalid", "Send a ZIP or the folder's files")
        if len(files) > service.ARCHIVE_MAX_ENTRIES:
            raise bad_request("emoji_pack_archive_invalid", "Too many files")
        total = 0
        for upload in files:
            name = upload.filename or ""
            if not service.wanted_file(name):
                continue
            limit = service.file_limit(name, settings)
            data = await upload.read(limit + 1)
            if len(data) > limit:
                raise AppError(
                    413,
                    "emoji_too_large",
                    f"{service.file_key(name)} is larger than {limit} bytes",
                    details={"file": service.file_key(name)},
                )
            total += len(data)
            if total > PACK_UPLOAD_MAX_BYTES:
                raise AppError(413, "emoji_too_large", "The folder is too large")
            service.add_file(found, name, data)
    manifest = service.manifest_from_files(found)
    result = await service.import_pack(
        db, admin, manifest, found, settings, request.app.state.blobs
    )
    return EmojiPackImportOut(
        pack=to_pack_out(result.pack),
        created=result.created,
        updated=result.updated,
        unchanged=result.unchanged,
    )


@router.patch("/emoji/packs/{pack_id}", response_model=EmojiPackOut)
async def update_pack(
    pack_id: UUID, body: EmojiPackUpdate, admin: EmojiManager, db: Db
) -> EmojiPackOut:
    """Rename or reorder (lower `position` first)."""
    return await service.update_pack(db, admin, pack_id, body.name, body.position)


@router.delete("/emoji/packs/{pack_id}", status_code=204)
async def delete_pack(pack_id: UUID, request: Request, admin: EmojiManager, db: Db) -> Response:
    """The pack goes; its emoji stay, ungrouped."""
    await service.delete_pack(db, admin, pack_id, request.app.state.blobs)
    return Response(status_code=204)


@router.get(
    "/emoji/packs/{pack_id}/tab",
    responses={304: {"description": "If-None-Match matched the icon's version (ETag)"}},
)
async def pack_tab(
    pack_id: UUID,
    request: Request,
    user: CurrentUser,
    db: Db,
    v: str | None = Query(default=None, max_length=64),
    if_none_match: str | None = Header(default=None),
) -> Response:
    """The tab icon. `v` = the pack's `tab_version`: the response may then be kept for good.
    ETag is the version; If-None-Match → 304."""
    row = await service.require_pack_tab(db, pack_id)
    version = to_pack_out(row).tab_version or ""
    return _image_response(
        request,
        row.tab_storage_key or "",
        row.tab_content_type or "application/octet-stream",
        version,
        v,
        if_none_match,
    )
