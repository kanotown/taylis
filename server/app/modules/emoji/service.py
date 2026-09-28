"""Custom emoji (M12f).

Any member may add one (a name and a small PNG / GIF / JPEG / WebP); the creator or an admin
may remove it. Clients learn the table from bootstrap and emoji.updated, render `:name:` in
bodies and reactions as the image, and fall back to the text when the name is unknown.
"""

import io
import re
import uuid

import filetype
from fastapi import UploadFile
from PIL import Image
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.ids import uuid7
from app.core.settings import Settings
from app.events.outbox import write_outbox
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import IMAGE_TYPES
from app.modules.emoji import repository as repo
from app.modules.emoji.events import EMOJI_UPDATED, EmojiUpdatedData
from app.modules.emoji.models import CustomEmoji
from app.modules.emoji.schemas import CustomEmojiOut, to_emoji_out
from app.modules.users.models import User

NAME = re.compile(r"^[a-z0-9][a-z0-9_+-]{1,31}$")
MAX_PIXELS = 512
READ_CHUNK = 64 * 1024


def storage_key(emoji_id: uuid.UUID) -> str:
    return f"emoji/{emoji_id}"


def _dimensions(data: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(data)) as image:
        return image.size


async def upload(
    db: AsyncSession,
    actor: User,
    name: str,
    file: UploadFile,
    settings: Settings,
    blobs: BlobStore,
) -> CustomEmojiOut:
    cleaned = name.strip().lower()
    if not NAME.match(cleaned):
        raise bad_request("emoji_name_invalid", "Names are 2-32 characters of a-z, 0-9, _, + or -")
    if await repo.get_by_name(db, cleaned) is not None:
        raise conflict("emoji_name_taken", "An emoji with this name already exists")
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await file.read(READ_CHUNK)
        if not chunk:
            break
        size += len(chunk)
        if size > settings.emoji_max_bytes:
            raise AppError(
                413,
                "emoji_too_large",
                f"Emoji images are limited to {settings.emoji_max_bytes} bytes",
            )
        chunks.append(chunk)
    if size == 0:
        raise bad_request("emoji_empty", "The file is empty")
    data = b"".join(chunks)
    kind = filetype.guess(data[:8192])
    content_type = kind.mime if kind is not None else ""
    if content_type not in IMAGE_TYPES:
        raise bad_request("emoji_not_image", "Use a PNG, GIF, JPEG or WebP image")
    try:
        width, height = await run_in_threadpool(_dimensions, data)
    except Exception as exc:
        raise bad_request("emoji_not_image", "The image could not be read") from exc
    if width > MAX_PIXELS or height > MAX_PIXELS:
        raise bad_request("emoji_too_big", f"Emoji images are at most {MAX_PIXELS}px wide and high")
    row = CustomEmoji(
        id=uuid7(),  # the default is only applied at INSERT: the key below needs it now
        name=cleaned,
        created_by=actor.id,
        content_type=content_type,
        size_bytes=size,
        width=width,
        height=height,
        storage_key="",
    )
    row.storage_key = storage_key(row.id)
    await blobs.put(row.storage_key, data, content_type)
    db.add(row)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        await blobs.delete(row.storage_key)
        raise conflict("emoji_name_taken", "An emoji with this name already exists") from exc
    await _emit(db, row, deleted=False)
    await db.commit()
    return to_emoji_out(row)


async def _emit(db: AsyncSession, row: CustomEmoji, *, deleted: bool) -> None:
    await write_outbox(
        db,
        event_type=EMOJI_UPDATED,
        audience_type="all",
        payload=EmojiUpdatedData(emoji=to_emoji_out(row), deleted=deleted).model_dump(mode="json"),
    )


async def announce_created_in_tx(db: AsyncSession, row: CustomEmoji) -> None:
    """emoji.updated for an emoji added outside the API (M18 import)."""
    await _emit(db, row, deleted=False)


async def list_all(db: AsyncSession) -> list[CustomEmojiOut]:
    return [to_emoji_out(row) for row in await repo.list_all(db)]


async def require(db: AsyncSession, emoji_id: uuid.UUID) -> CustomEmoji:
    row = await repo.get(db, emoji_id)
    if row is None:
        raise not_found("emoji_not_found", "No such emoji")
    return row


async def delete(db: AsyncSession, actor: User, emoji_id: uuid.UUID, blobs: BlobStore) -> None:
    row = await require(db, emoji_id)
    if row.created_by != actor.id and actor.role != "admin":
        raise forbidden("emoji_forbidden", "Only the creator or an admin can remove an emoji")
    await _emit(db, row, deleted=True)
    await db.delete(row)
    await db.commit()
    await blobs.delete(row.storage_key)
