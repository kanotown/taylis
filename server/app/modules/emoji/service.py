"""Custom emoji (M12f) with text emoji, labels, keywords and packs (M100, docs/EMOJI.md).

Any member may add one (a name and a small PNG / GIF / JPEG / WebP, or a short label drawn as a
pill); the creator or an admin may change or remove it. Administrators group emoji into packs,
each with its own picker tab, and import a whole pack from a folder or ZIP with a `pack.json`.
Clients learn the tables from bootstrap and emoji.updated / emoji_pack.updated, render `:name:`
in bodies and reactions as the image or label, and fall back to the text when the name is
unknown.
"""

import io
import json
import re
import unicodedata
import uuid
import zipfile
from dataclasses import dataclass
from typing import Any

import filetype
from fastapi import UploadFile
from PIL import Image
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.errors import AppError, bad_request, conflict, forbidden, not_found
from app.core.ids import uuid7
from app.core.settings import Settings
from app.core.time import utcnow
from app.events.outbox import write_outbox
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import IMAGE_TYPES
from app.modules.audit import service as audit
from app.modules.emoji import repository as repo
from app.modules.emoji.events import (
    EMOJI_PACK_UPDATED,
    EMOJI_UPDATED,
    EmojiPackUpdatedData,
    EmojiUpdatedData,
)
from app.modules.emoji.models import CustomEmoji, EmojiPack
from app.modules.emoji.schemas import (
    CustomEmojiOut,
    CustomEmojiUpdate,
    EmojiPackOut,
    TextEmojiCreate,
    to_emoji_out,
    to_pack_out,
)
from app.modules.users.models import User

NAME = re.compile(r"^[a-z0-9][a-z0-9_+-]{1,31}$")
MAX_PIXELS = 512
READ_CHUNK = 64 * 1024
TEXT_LABEL_MAX = 12  # a text emoji's label (M100): a reaction chip stays one short pill
LABEL_MAX = 32  # an image emoji's display name
KEYWORD_MAX = 32
KEYWORDS_MAX = 20
PACK_NAME_MAX = 64


def storage_key(emoji_id: uuid.UUID) -> str:
    return f"emoji/{emoji_id}"


def tab_storage_key(pack_id: uuid.UUID) -> str:
    """A new key per icon: the last part is the pack's tab_version (clients' cache key)."""
    return f"emoji-packs/{pack_id}/tab-{uuid7().hex}"


def _dimensions(data: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(data)) as image:
        return image.size


# ---- validation ---------------------------------------------------------------------------


def clean_name(name: str) -> str:
    cleaned = name.strip().lower()
    if not NAME.match(cleaned):
        raise bad_request("emoji_name_invalid", "Names are 2-32 characters of a-z, 0-9, _, + or -")
    return cleaned


def _clean_text(value: str) -> str:
    """NFC, no control or format characters, runs of white space as one space."""
    text = unicodedata.normalize("NFC", value)
    text = "".join(" " if ch.isspace() else ch for ch in text)
    if any(unicodedata.category(ch) in ("Cc", "Cs", "Co") for ch in text):
        raise bad_request("emoji_label_invalid", "The label has characters that cannot be shown")
    return " ".join(text.split())


def clean_label(value: str | None, *, max_length: int = LABEL_MAX) -> str | None:
    if value is None:
        return None
    text = _clean_text(value)
    if len(text) > max_length:
        raise bad_request("emoji_label_invalid", f"Labels are at most {max_length} characters")
    return text or None


def clean_keywords(values: list[str] | None) -> list[str]:
    """Trimmed, NFC, lower case for Latin letters, each once; at most 20 of 32 characters."""
    seen: list[str] = []
    for value in values or []:
        if not isinstance(value, str):
            raise bad_request("emoji_keywords_invalid", "Keywords are strings")
        text = _clean_text(value).lower()
        if not text:
            continue
        if len(text) > KEYWORD_MAX:
            raise bad_request(
                "emoji_keywords_invalid", f"Keywords are at most {KEYWORD_MAX} characters"
            )
        if text not in seen:
            seen.append(text)
    if len(seen) > KEYWORDS_MAX:
        raise bad_request("emoji_keywords_invalid", f"At most {KEYWORDS_MAX} keywords")
    return seen


def clean_pack_name(value: str) -> str:
    text = _clean_text(value) if value else ""
    if not text or len(text) > PACK_NAME_MAX:
        raise bad_request("emoji_pack_name_invalid", f"Pack names are 1-{PACK_NAME_MAX} characters")
    return text


@dataclass
class CheckedImage:
    data: bytes
    content_type: str
    width: int
    height: int


async def check_image(data: bytes, settings: Settings) -> CheckedImage:
    """The upload rules for an emoji (or a pack's tab icon): size, type, readable, 512px."""
    if not data:
        raise bad_request("emoji_empty", "The file is empty")
    if len(data) > settings.emoji_max_bytes:
        raise AppError(
            413,
            "emoji_too_large",
            f"Emoji images are limited to {settings.emoji_max_bytes} bytes",
        )
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
    return CheckedImage(data, content_type, width, height)


async def read_upload(file: UploadFile, settings: Settings) -> bytes:
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
    return b"".join(chunks)


# ---- emoji --------------------------------------------------------------------------------


async def upload(
    db: AsyncSession,
    actor: User,
    name: str,
    file: UploadFile,
    settings: Settings,
    blobs: BlobStore,
    *,
    label: str | None = None,
    keywords: list[str] | None = None,
) -> CustomEmojiOut:
    cleaned = clean_name(name)
    cleaned_label = clean_label(label)
    cleaned_keywords = clean_keywords(keywords)
    if await repo.get_by_name(db, cleaned) is not None:
        raise conflict("emoji_name_taken", "An emoji with this name already exists")
    image = await check_image(await read_upload(file, settings), settings)
    row = CustomEmoji(
        id=uuid7(),  # the default is only applied at INSERT: the key below needs it now
        name=cleaned,
        created_by=actor.id,
        kind="image",
        content_type=image.content_type,
        size_bytes=len(image.data),
        width=image.width,
        height=image.height,
        storage_key="",
        label=cleaned_label,
        keywords=cleaned_keywords,
    )
    row.storage_key = storage_key(row.id)
    await blobs.put(row.storage_key, image.data, image.content_type)
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


async def create_text(db: AsyncSession, actor: User, body: TextEmojiCreate) -> CustomEmojiOut:
    """A text emoji (M100): `:name:` drawn as a pill with `label` in `color`."""
    cleaned = clean_name(body.name)
    label = clean_label(body.label, max_length=TEXT_LABEL_MAX)
    if label is None:
        raise bad_request("emoji_label_invalid", "A text emoji needs a label")
    keywords = clean_keywords(body.keywords)
    if await repo.get_by_name(db, cleaned) is not None:
        raise conflict("emoji_name_taken", "An emoji with this name already exists")
    row = CustomEmoji(
        id=uuid7(),
        name=cleaned,
        created_by=actor.id,
        kind="text",
        content_type="",
        size_bytes=0,
        width=0,
        height=0,
        storage_key="",
        label=label,
        color=body.color,
        keywords=keywords,
    )
    db.add(row)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise conflict("emoji_name_taken", "An emoji with this name already exists") from exc
    await _emit(db, row, deleted=False)
    await db.commit()
    return to_emoji_out(row)


async def update_emoji(
    db: AsyncSession, actor: User, emoji_id: uuid.UUID, body: CustomEmojiUpdate
) -> CustomEmojiOut:
    row = await require(db, emoji_id)
    sent = body.model_fields_set
    if row.created_by != actor.id and actor.role != "admin":
        raise forbidden("emoji_forbidden", "Only the creator or an admin can change an emoji")
    if ("pack_id" in sent or "position" in sent) and actor.role != "admin":
        raise forbidden("emoji_forbidden", "Only an admin can move an emoji between packs")
    if "label" in sent:
        if row.kind == "text":
            label = clean_label(body.label, max_length=TEXT_LABEL_MAX)
            if label is None:
                raise bad_request("emoji_label_invalid", "A text emoji needs a label")
            row.label = label
        else:
            row.label = clean_label(body.label)
    if "color" in sent:
        row.color = body.color if row.kind == "text" else None
    if "keywords" in sent:
        row.keywords = clean_keywords(body.keywords)
    if "pack_id" in sent:
        if body.pack_id is not None and await db.get(EmojiPack, body.pack_id) is None:
            raise not_found("emoji_pack_not_found", "No such emoji pack")
        row.pack_id = body.pack_id
    if "position" in sent and body.position is not None:
        row.position = body.position
    row.updated_at = utcnow()
    await db.flush()
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


async def _emit_pack(db: AsyncSession, row: EmojiPack, *, deleted: bool) -> None:
    await write_outbox(
        db,
        event_type=EMOJI_PACK_UPDATED,
        audience_type="all",
        payload=EmojiPackUpdatedData(pack=to_pack_out(row), deleted=deleted).model_dump(
            mode="json"
        ),
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


async def require_image(db: AsyncSession, emoji_id: uuid.UUID) -> CustomEmoji:
    row = await require(db, emoji_id)
    if row.kind != "image" or not row.storage_key:
        raise not_found("emoji_not_found", "This emoji has no image")
    return row


async def delete(db: AsyncSession, actor: User, emoji_id: uuid.UUID, blobs: BlobStore) -> None:
    row = await require(db, emoji_id)
    if row.created_by != actor.id and actor.role != "admin":
        raise forbidden("emoji_forbidden", "Only the creator or an admin can remove an emoji")
    await _emit(db, row, deleted=True)
    key = row.storage_key
    await db.delete(row)
    await db.commit()
    if key:
        await blobs.delete(key)


# ---- packs (admin) ------------------------------------------------------------------------


async def list_packs(db: AsyncSession) -> list[EmojiPackOut]:
    return [to_pack_out(row) for row in await repo.list_packs(db)]


async def require_pack(db: AsyncSession, pack_id: uuid.UUID) -> EmojiPack:
    row = await db.get(EmojiPack, pack_id)
    if row is None:
        raise not_found("emoji_pack_not_found", "No such emoji pack")
    return row


async def _next_pack_position(db: AsyncSession) -> int:
    top = (await db.execute(select(func.max(EmojiPack.position)))).scalar_one_or_none()
    return 0 if top is None else top + 1


async def _new_pack(db: AsyncSession, actor: User, name: str) -> EmojiPack:
    if await repo.get_pack_by_name(db, name) is not None:
        raise conflict("emoji_pack_name_taken", "A pack with this name already exists")
    row = EmojiPack(
        id=uuid7(), name=name, position=await _next_pack_position(db), created_by=actor.id
    )
    db.add(row)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise conflict("emoji_pack_name_taken", "A pack with this name already exists") from exc
    return row


async def create_pack(db: AsyncSession, actor: User, name: str) -> EmojiPackOut:
    row = await _new_pack(db, actor, clean_pack_name(name))
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="emoji_pack.create",
        target_type="emoji_pack",
        target_id=row.id,
        details={"name": row.name},
    )
    await _emit_pack(db, row, deleted=False)
    await db.commit()
    return to_pack_out(row)


async def update_pack(
    db: AsyncSession, actor: User, pack_id: uuid.UUID, name: str | None, position: int | None
) -> EmojiPackOut:
    row = await require_pack(db, pack_id)
    before = {"name": row.name, "position": row.position}
    if name is not None:
        cleaned = clean_pack_name(name)
        other = await repo.get_pack_by_name(db, cleaned)
        if other is not None and other.id != row.id:
            raise conflict("emoji_pack_name_taken", "A pack with this name already exists")
        row.name = cleaned
    if position is not None:
        row.position = position
    row.updated_at = utcnow()
    await db.flush()
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="emoji_pack.update",
        target_type="emoji_pack",
        target_id=row.id,
        details={"before": before, "after": {"name": row.name, "position": row.position}},
    )
    await _emit_pack(db, row, deleted=False)
    await db.commit()
    return to_pack_out(row)


async def delete_pack(db: AsyncSession, actor: User, pack_id: uuid.UUID, blobs: BlobStore) -> None:
    """The pack goes; its emoji stay, ungrouped (the 「カスタム」 tab), so bodies and reactions
    that use them keep their images (docs/EMOJI.md §3)."""
    row = await require_pack(db, pack_id)
    members = list(
        (await db.execute(select(CustomEmoji).where(CustomEmoji.pack_id == row.id))).scalars().all()
    )
    now = utcnow()
    await db.execute(
        update(CustomEmoji)
        .where(CustomEmoji.pack_id == row.id)
        .values(pack_id=None, updated_at=now)
        .execution_options(synchronize_session=False)
    )
    for emoji in members:
        emoji.pack_id = None
        emoji.updated_at = now
        await _emit(db, emoji, deleted=False)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="emoji_pack.delete",
        target_type="emoji_pack",
        target_id=row.id,
        details={"name": row.name, "emoji_kept": len(members)},
    )
    await _emit_pack(db, row, deleted=True)
    key = row.tab_storage_key
    await db.delete(row)
    await db.commit()
    if key:
        await blobs.delete(key)


async def require_pack_tab(db: AsyncSession, pack_id: uuid.UUID) -> EmojiPack:
    row = await require_pack(db, pack_id)
    if not row.tab_storage_key:
        raise not_found("emoji_pack_not_found", "This pack has no tab icon")
    return row


# ---- pack import --------------------------------------------------------------------------


@dataclass
class ManifestItem:
    file: str
    shortcode: str
    label: str | None
    keywords: list[str]


@dataclass
class Manifest:
    name: str
    tab: str | None
    items: list[ManifestItem]


MAX_PACK_ITEMS = 300


def file_key(name: str) -> str:
    """How manifest file names and uploaded / zipped file names meet: the base name, NFC (macOS
    hands out Japanese names decomposed), case kept."""
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    return unicodedata.normalize("NFC", base)


def parse_manifest(raw: Any) -> Manifest:
    """`pack.json`: {name, tab?, items: [{file, shortcode, label?, keywords?}]}."""

    def invalid(message: str) -> AppError:
        return bad_request("emoji_pack_manifest_invalid", message)

    if not isinstance(raw, dict):
        raise invalid("pack.json must be a JSON object")
    name = raw.get("name")
    if not isinstance(name, str):
        raise invalid('pack.json needs a "name"')
    pack_name = clean_pack_name(name)
    tab = raw.get("tab")
    if tab is not None and (not isinstance(tab, str) or not tab.strip()):
        raise invalid('"tab" must be a file name')
    items_raw = raw.get("items")
    if not isinstance(items_raw, list) or not items_raw:
        raise invalid('pack.json needs "items"')
    if len(items_raw) > MAX_PACK_ITEMS:
        raise invalid(f"A pack has at most {MAX_PACK_ITEMS} items")
    items: list[ManifestItem] = []
    shortcodes: set[str] = set()
    files: set[str] = set()
    for index, entry in enumerate(items_raw):
        where = f"items[{index}]"
        if not isinstance(entry, dict):
            raise invalid(f"{where} must be an object")
        file = entry.get("file")
        shortcode = entry.get("shortcode")
        if not isinstance(file, str) or not file.strip():
            raise invalid(f'{where} needs a "file"')
        if not isinstance(shortcode, str):
            raise invalid(f'{where} needs a "shortcode"')
        try:
            code = clean_name(shortcode)
        except AppError as exc:
            raise AppError(
                400,
                "emoji_name_invalid",
                f"{where}: {shortcode!r} is not a valid shortcode (a-z 0-9 _ + -, 2-32)",
                details={"shortcode": shortcode},
            ) from exc
        if code in shortcodes:
            raise invalid(f"{where}: the shortcode {code!r} appears twice")
        key = file_key(file)
        if key in files:
            raise invalid(f"{where}: the file {file!r} appears twice")
        shortcodes.add(code)
        files.add(key)
        label = entry.get("label")
        if label is not None and not isinstance(label, str):
            raise invalid(f'{where}: "label" must be a string')
        keywords = entry.get("keywords", [])
        if not isinstance(keywords, list):
            raise invalid(f'{where}: "keywords" must be a list of strings')
        items.append(
            ManifestItem(
                file=key,
                shortcode=code,
                label=clean_label(label),
                keywords=clean_keywords(keywords),
            )
        )
    return Manifest(name=pack_name, tab=file_key(tab) if tab else None, items=items)


@dataclass
class ImportResult:
    pack: EmojiPack
    created: list[str]
    updated: list[str]
    unchanged: list[str]


async def import_pack(
    db: AsyncSession,
    actor: User,
    manifest: Manifest,
    files: dict[str, bytes],
    settings: Settings,
    blobs: BlobStore,
) -> ImportResult:
    """Create or update the pack named in the manifest (docs/EMOJI.md §4).

    Idempotent: the pack is found by name, its emoji by shortcode. A shortcode already in this
    pack gets the manifest's label, keywords and order (its image stays); a new one is added.
    Emoji of the pack the manifest leaves out stay. All checks run before anything is written:
    a missing file, a bad image or a shortcode another emoji (outside the pack) already has
    fails the whole import."""
    pack = await repo.get_pack_by_name(db, manifest.name)
    existing = {
        row.name: row
        for row in await repo.get_by_names(db, [item.shortcode for item in manifest.items])
    }
    taken = sorted(name for name, row in existing.items() if pack is None or row.pack_id != pack.id)
    if taken:
        raise conflict(
            "emoji_name_taken",
            "These shortcodes are already used by other emoji: " + ", ".join(taken),
            details={"shortcodes": taken},
        )
    images: dict[str, CheckedImage] = {}
    for item in manifest.items:
        if item.shortcode in existing:
            continue
        data = files.get(item.file)
        if data is None:
            raise AppError(
                400,
                "emoji_pack_file_missing",
                f"{item.file} is in pack.json but not among the files",
                details={"file": item.file},
            )
        try:
            images[item.shortcode] = await check_image(data, settings)
        except AppError as exc:
            raise AppError(
                exc.status, exc.code, f"{item.file}: {exc.message}", details={"file": item.file}
            ) from exc
    tab: CheckedImage | None = None
    if manifest.tab is not None:
        data = files.get(manifest.tab)
        if data is None:
            raise AppError(
                400,
                "emoji_pack_file_missing",
                f"{manifest.tab} (the tab icon) is not among the files",
                details={"file": manifest.tab},
            )
        try:
            tab = await check_image(data, settings)
        except AppError as exc:
            raise AppError(
                exc.status,
                exc.code,
                f"{manifest.tab}: {exc.message}",
                details={"file": manifest.tab},
            ) from exc

    written: list[str] = []
    old_tab: str | None = None
    try:
        new_pack = pack is None
        if pack is None:
            pack = await _new_pack(db, actor, manifest.name)
        now = utcnow()
        if tab is not None:
            old_tab = pack.tab_storage_key
            key = tab_storage_key(pack.id)
            await blobs.put(key, tab.data, tab.content_type)
            written.append(key)
            pack.tab_storage_key = key
            pack.tab_content_type = tab.content_type
        pack.updated_at = now
        created: list[str] = []
        new_rows: list[CustomEmoji] = []
        updated: list[str] = []
        unchanged: list[str] = []
        for position, item in enumerate(manifest.items):
            row = existing.get(item.shortcode)
            if row is not None:
                if (row.label, list(row.keywords or []), row.position) == (
                    item.label,
                    item.keywords,
                    position,
                ):
                    unchanged.append(item.shortcode)
                    continue
                row.label = item.label
                row.keywords = item.keywords
                row.position = position
                row.updated_at = now
                updated.append(item.shortcode)
                await _emit(db, row, deleted=False)
                continue
            image = images[item.shortcode]
            row = CustomEmoji(
                id=uuid7(),
                name=item.shortcode,
                created_by=actor.id,
                kind="image",
                content_type=image.content_type,
                size_bytes=len(image.data),
                width=image.width,
                height=image.height,
                storage_key="",
                label=item.label,
                keywords=item.keywords,
                pack_id=pack.id,
                position=position,
            )
            row.storage_key = storage_key(row.id)
            await blobs.put(row.storage_key, image.data, image.content_type)
            written.append(row.storage_key)
            db.add(row)
            new_rows.append(row)
            created.append(item.shortcode)
        await db.flush()
        for row in new_rows:
            await _emit(db, row, deleted=False)
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="emoji_pack.import",
            target_type="emoji_pack",
            target_id=pack.id,
            details={
                "name": pack.name,
                "new_pack": new_pack,
                "created": len(created),
                "updated": len(updated),
                "unchanged": len(unchanged),
                "tab": tab is not None,
            },
        )
        await _emit_pack(db, pack, deleted=False)
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        for key in written:
            await blobs.delete(key)
        raise conflict(
            "emoji_name_taken", "Another emoji took one of these shortcodes meanwhile"
        ) from exc
    except BaseException:
        await db.rollback()
        for key in written:
            await blobs.delete(key)
        raise
    if old_tab:
        await blobs.delete(old_tab)
    return ImportResult(pack=pack, created=created, updated=updated, unchanged=unchanged)


# ---- reading a pack's files ---------------------------------------------------------------

IMAGE_SUFFIXES = (".png", ".gif", ".jpg", ".jpeg", ".webp")
MANIFEST_NAME = "pack.json"
MANIFEST_MAX_BYTES = 1024 * 1024
ARCHIVE_MAX_ENTRIES = 1000
ARCHIVE_MAX_TOTAL = 64 * 1024 * 1024


def wanted_file(name: str) -> bool:
    """Images and pack.json; anything else in the folder (notes, .DS_Store) is skipped."""
    key = file_key(name)
    if key.startswith(".") or "__MACOSX" in name:
        return False
    return key == MANIFEST_NAME or key.lower().endswith(IMAGE_SUFFIXES)


def file_limit(name: str, settings: Settings) -> int:
    return MANIFEST_MAX_BYTES if file_key(name) == MANIFEST_NAME else settings.emoji_max_bytes


def add_file(files: dict[str, bytes], name: str, data: bytes) -> None:
    key = file_key(name)
    if key in files:
        raise bad_request(
            "emoji_pack_archive_invalid",
            f"Two files are named {key} (a pack is one flat folder)",
            details={"file": key},
        )
    files[key] = data


def read_archive(data: bytes, settings: Settings) -> dict[str, bytes]:
    """The images and pack.json of a ZIP (at its root or in one folder), by base name."""

    def invalid(message: str) -> AppError:
        return bad_request("emoji_pack_archive_invalid", message)

    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise invalid("The file is not a ZIP archive") from exc
    infos = archive.infolist()
    if len(infos) > ARCHIVE_MAX_ENTRIES:
        raise invalid(f"A pack's ZIP has at most {ARCHIVE_MAX_ENTRIES} entries")
    files: dict[str, bytes] = {}
    total = 0
    for info in infos:
        if info.is_dir():
            continue
        name = info.filename
        if not info.flag_bits & 0x800:
            # Not flagged UTF-8: zipfile read the name as CP437; most tools wrote UTF-8.
            try:
                name = name.encode("cp437").decode("utf-8")
            except (UnicodeEncodeError, UnicodeDecodeError):
                pass
        if not wanted_file(name):
            continue
        limit = file_limit(name, settings)
        if info.file_size > limit:
            raise AppError(
                413,
                "emoji_too_large",
                f"{file_key(name)} is larger than {limit} bytes",
                details={"file": file_key(name)},
            )
        total += info.file_size
        if total > ARCHIVE_MAX_TOTAL:
            raise invalid("The ZIP is too large once unpacked")
        try:
            with archive.open(info) as handle:
                content = handle.read(limit + 1)
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
            raise invalid(f"{file_key(name)} could not be read from the ZIP") from exc
        if len(content) > limit:
            raise invalid(f"{file_key(name)} is larger than it claims")
        add_file(files, name, content)
    return files


def manifest_from_files(files: dict[str, bytes]) -> Manifest:
    raw = files.get(MANIFEST_NAME)
    if raw is None:
        raise bad_request("emoji_pack_manifest_invalid", "The folder or ZIP has no pack.json")
    try:
        parsed = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise bad_request(
            "emoji_pack_manifest_invalid", f"pack.json is not valid JSON ({exc})"
        ) from exc
    return parse_manifest(parsed)
