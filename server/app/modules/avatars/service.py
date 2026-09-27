"""Profile pictures (M14a): one square 256px PNG per user in the object store.

The picture is referenced from `users.avatar_key`; `users.avatar_updated_at` is the version
clients cache by (it travels in UserPublic, so a change reaches every device as user.updated).
"""

import io
import uuid

import filetype
from fastapi import UploadFile
from PIL import Image, ImageOps
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.errors import AppError, bad_request, not_found
from app.core.ids import uuid7
from app.core.settings import Settings
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import IMAGE_TYPES
from app.modules.users import service as users
from app.modules.users.models import User

SIDE = 256
READ_CHUNK = 64 * 1024


def _square_png(data: bytes) -> bytes:
    """Centre-cropped to a square, 256px, re-encoded as PNG (so no metadata survives)."""
    with Image.open(io.BytesIO(data)) as image:
        upright = ImageOps.exif_transpose(image) or image
        rgba = upright.convert("RGBA")
    side = min(rgba.size)
    left = (rgba.width - side) // 2
    top = (rgba.height - side) // 2
    square = rgba.crop((left, top, left + side, top + side)).resize(
        (SIDE, SIDE), Image.Resampling.LANCZOS
    )
    out = io.BytesIO()
    square.save(out, format="PNG", optimize=True)
    return out.getvalue()


async def _read(file: UploadFile, limit: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await file.read(READ_CHUNK)
        if not chunk:
            break
        size += len(chunk)
        if size > limit:
            raise AppError(413, "avatar_too_large", f"Pictures are limited to {limit} bytes")
        chunks.append(chunk)
    if size == 0:
        raise bad_request("avatar_empty", "The file is empty")
    return b"".join(chunks)


async def upload(
    db: AsyncSession, actor: User, file: UploadFile, settings: Settings, blobs: BlobStore
) -> User:
    data = await _read(file, settings.avatar_max_bytes)
    kind = filetype.guess(data[:8192])
    if kind is None or kind.mime not in IMAGE_TYPES:
        raise bad_request("avatar_not_image", "Use a PNG, GIF, JPEG or WebP image")
    try:
        png = await run_in_threadpool(_square_png, data)
    except Exception as exc:
        raise bad_request("avatar_not_image", "The image could not be read") from exc
    key = f"avatars/{actor.id}/{uuid7()}"
    await blobs.put(key, png, "image/png")
    previous = actor.avatar_key
    user = await users.set_avatar(db, actor.id, key)
    if previous:
        await _forget(blobs, previous)
    return user


async def remove(db: AsyncSession, actor: User, blobs: BlobStore) -> User:
    previous = actor.avatar_key
    user = await users.set_avatar(db, actor.id, None)
    if previous:
        await _forget(blobs, previous)
    return user


async def _forget(blobs: BlobStore, key: str) -> None:
    try:
        await blobs.delete(key)
    except Exception:  # the row already moved on; a stray object is harmless
        pass


async def storage_key(db: AsyncSession, user_id: uuid.UUID) -> str:
    user = await users.get_user(db, user_id)
    if user is None or not user.avatar_key:
        raise not_found("avatar_not_found", "No picture")
    return user.avatar_key
