"""Preset emoji packs from a folder on the server (M102, docs/EMOJI.md §8).

The artwork stays out of the repository: the operator copies pack folders (the same folders the
admin screen imports, each with a `pack.json`) under EMOJI_PRESETS_DIR. At startup (and with
`python -m app.cli import-emoji-presets`) every immediate subfolder with a pack.json is brought
in as the system, with the pack import's rules (same manifest, same image checks, packs by
folder, emoji by shortcode), with these differences:

- The folder name is the preset key. A pack is found by it first, then by the manifest's name
  (a pack imported by hand earlier is adopted). The manifest's name only names a new pack: a
  rename by an administrator stays.
- What an administrator deleted (the pack, or one emoji) is remembered in
  `emoji_preset_removals` and left out from then on (`--restore <folder>` forgets it).
- The SHA-256 of each file is kept: a changed image (or tab icon) replaces the stored one under
  a new key, an unchanged one is not touched. Labels, keywords and order follow the manifest.
- A shortcode another emoji already has is skipped with a warning (not the whole folder). A bad
  folder (unreadable pack.json, a missing or bad image) is skipped with a warning; startup and
  readiness never depend on it.
- A run with nothing new writes nothing (no events, no audit row). One process at a time: a
  transaction-level advisory lock, the others skip.
"""

import hashlib
import logging
import os
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.errors import AppError, bad_request
from app.core.ids import uuid7
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments.blobstore import BlobStore
from app.modules.audit import service as audit
from app.modules.emoji import repository as repo
from app.modules.emoji import service
from app.modules.emoji.models import CustomEmoji, EmojiPack, EmojiPresetRemoval
from app.modules.users.models import User

log = logging.getLogger("app.emoji.presets")

LOCK = "SELECT pg_try_advisory_xact_lock(hashtext('emoji_presets'))"
MAX_FOLDERS = 100
KEY_MAX = 255


@dataclass
class PresetReport:
    changed: dict[str, str] = field(default_factory=dict)  # folder → what happened
    unchanged: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)  # deleted by an administrator: left out
    failed: dict[str, str] = field(default_factory=dict)  # folder → why it was skipped
    warnings: list[str] = field(default_factory=list)
    busy: bool = False  # another process holds the lock
    no_admin: bool = False  # nobody to own the new rows yet

    def summary(self) -> str:
        if self.busy:
            return "emoji presets: another process is importing them"
        if self.no_admin:
            return "emoji presets: no administrator yet; run again after creating one"
        parts = [f"{folder}: {what}" for folder, what in self.changed.items()]
        parts += [f"{folder}: unchanged" for folder in self.unchanged]
        parts += [f"{folder}: deleted by an administrator, left out" for folder in self.removed]
        parts += [f"{folder}: SKIPPED ({why})" for folder, why in self.failed.items()]
        return "emoji presets: " + ("; ".join(parts) if parts else "no pack folders")


@dataclass
class _Folder:
    key: str
    manifest: service.Manifest
    files: dict[str, bytes]  # the manifest's files that exist, by file_key


@dataclass
class _Blobs:
    written: list[str] = field(default_factory=list)  # removed again if the folder fails
    obsolete: list[str] = field(default_factory=list)  # removed once the import is committed


def folder_key(name: str) -> str:
    return unicodedata.normalize("NFC", name)


def scan(root: Path) -> list[tuple[str, Path]]:
    """The immediate subfolders with a pack.json, by name (hidden ones skipped)."""
    found: list[tuple[str, Path]] = []
    with os.scandir(root) as entries:
        for entry in entries:
            if entry.name.startswith(".") or not entry.is_dir():
                continue
            if os.path.isfile(os.path.join(entry.path, service.MANIFEST_NAME)):
                found.append((folder_key(entry.name), Path(entry.path)))
    found.sort()
    return found


def _read(path: str, limit: int) -> bytes:
    # One byte over the limit is enough for check_image (or the manifest check) to refuse it.
    with open(path, "rb") as handle:
        return handle.read(limit + 1)


def load_folder(key: str, path: Path, settings: Settings) -> _Folder:
    """pack.json and the files it names (blocking: run in a thread)."""
    if len(key) > KEY_MAX:
        raise bad_request("emoji_pack_manifest_invalid", f"Folder names are at most {KEY_MAX}")
    index: dict[str, str] = {}
    with os.scandir(path) as entries:
        for entry in entries:
            if not entry.is_file() or not service.wanted_file(entry.name):
                continue
            name = service.file_key(entry.name)
            if name in index:
                raise bad_request(
                    "emoji_pack_archive_invalid",
                    f"Two files are named {name}",
                    details={"file": name},
                )
            index[name] = entry.path
    raw = _read(index[service.MANIFEST_NAME], service.MANIFEST_MAX_BYTES)
    if len(raw) > service.MANIFEST_MAX_BYTES:
        raise bad_request("emoji_pack_manifest_invalid", "pack.json is larger than 1 MB")
    manifest = service.manifest_from_files({service.MANIFEST_NAME: raw})
    wanted = [item.file for item in manifest.items]
    if manifest.tab is not None:
        wanted.append(manifest.tab)
    files = {name: _read(index[name], settings.emoji_max_bytes) for name in wanted if name in index}
    return _Folder(key=key, manifest=manifest, files=files)


async def _owner(db: AsyncSession) -> User | None:
    """New preset rows need a creator: the first administrator (an active one if any)."""
    stmt = (
        select(User)
        .where(User.role == "admin", User.bot_kind.is_(None))
        .order_by(User.deactivated_at.is_not(None), User.created_at)
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def _removals(db: AsyncSession) -> dict[str, set[str]]:
    removed: dict[str, set[str]] = {}
    for key, shortcode in (
        await db.execute(select(EmojiPresetRemoval.preset_key, EmojiPresetRemoval.shortcode))
    ).all():
        removed.setdefault(key, set()).add(shortcode)
    return removed


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _missing(file: str, what: str = "") -> AppError:
    return AppError(
        400,
        "emoji_pack_file_missing",
        f"{file}{what} is in pack.json but not in the folder",
        details={"file": file},
    )


async def _checked(file: str, data: bytes, settings: Settings) -> service.CheckedImage:
    try:
        return await service.check_image(data, settings)
    except AppError as exc:
        raise AppError(
            exc.status, exc.code, f"{file}: {exc.message}", details={"file": file}
        ) from exc


async def _sync_folder(
    db: AsyncSession,
    folder: _Folder,
    removed: set[str],
    owner: User,
    settings: Settings,
    blobs: BlobStore,
    store: _Blobs,
    report: PresetReport,
) -> str | None:
    """Bring one folder in; what changed, or None when nothing did."""
    manifest = folder.manifest
    key = folder.key
    pack = (
        await db.execute(select(EmojiPack).where(EmojiPack.preset_key == key))
    ).scalar_one_or_none()
    adopted = False
    new_pack = False
    if pack is None:
        pack = await repo.get_pack_by_name(db, manifest.name)
        if pack is not None:
            if pack.preset_key is not None:
                raise bad_request(
                    "emoji_pack_name_taken",
                    f"The pack name {manifest.name!r} belongs to the preset folder "
                    f"{pack.preset_key!r}",
                )
            pack.preset_key = key
            adopted = True
    now = utcnow()
    if pack is None:
        pack = EmojiPack(
            id=uuid7(),
            name=manifest.name,
            position=await service._next_pack_position(db),
            created_by=owner.id,
            preset_key=key,
        )
        db.add(pack)
        await db.flush()
        new_pack = True

    tab_changed = False
    if manifest.tab is not None:
        data = folder.files.get(manifest.tab)
        if data is None:
            raise _missing(manifest.tab, " (the tab icon)")
        digest = _digest(data)
        if pack.preset_tab_hash != digest or not pack.tab_storage_key:
            tab = await _checked(manifest.tab, data, settings)
            tab_key = service.tab_storage_key(pack.id)
            await blobs.put(tab_key, tab.data, tab.content_type)
            store.written.append(tab_key)
            if pack.tab_storage_key:
                store.obsolete.append(pack.tab_storage_key)
            pack.tab_storage_key = tab_key
            pack.tab_content_type = tab.content_type
            pack.preset_tab_hash = digest
            tab_changed = True

    existing = {
        row.name: row
        for row in await repo.get_by_names(db, [item.shortcode for item in manifest.items])
    }
    created: list[CustomEmoji] = []
    changed: list[CustomEmoji] = []
    replaced = 0
    for position, item in enumerate(manifest.items):
        if item.shortcode in removed:
            continue
        row = existing.get(item.shortcode)
        visible = False
        if row is not None and row.pack_id != pack.id:
            if row.preset_key == key and row.pack_id is None and new_pack:
                # The pack was deleted (its emoji stayed) and has been restored: they rejoin.
                row.pack_id = pack.id
                visible = True
            elif row.preset_key == key:
                continue  # an administrator moved it to another pack: theirs now
            else:
                report.warnings.append(
                    f"{key}: :{item.shortcode}: is already another emoji's shortcode; skipped"
                )
                continue
        data = folder.files.get(item.file)
        if data is None:
            raise _missing(item.file)
        digest = _digest(data)
        if row is None:
            image = await _checked(item.file, data, settings)
            row = CustomEmoji(
                id=uuid7(),
                name=item.shortcode,
                created_by=owner.id,
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
                preset_key=key,
                preset_hash=digest,
            )
            row.storage_key = service.storage_key(row.id)
            await blobs.put(row.storage_key, image.data, image.content_type)
            store.written.append(row.storage_key)
            db.add(row)
            created.append(row)
            continue
        if row.preset_key is None:
            # Imported by hand before: adopted with the file as it is now (the image stays).
            row.preset_key = key
            row.preset_hash = digest
        elif row.preset_hash != digest and row.kind == "image":
            image = await _checked(item.file, data, settings)
            new_key = f"{service.storage_key(row.id)}-{uuid7().hex}"
            await blobs.put(new_key, image.data, image.content_type)
            store.written.append(new_key)
            store.obsolete.append(row.storage_key)
            row.storage_key = new_key
            row.content_type = image.content_type
            row.size_bytes = len(image.data)
            row.width = image.width
            row.height = image.height
            row.preset_hash = digest
            replaced += 1
            visible = True
        if (row.label, list(row.keywords or []), row.position) != (
            item.label,
            item.keywords,
            position,
        ):
            row.label = item.label
            row.keywords = item.keywords
            row.position = position
            visible = True
        if visible:
            row.updated_at = now
            changed.append(row)
    await db.flush()

    if not (new_pack or adopted or tab_changed or created or changed):
        return None
    for row in [*created, *changed]:
        await service._emit(db, row, deleted=False)
    if new_pack or tab_changed or created or changed:
        pack.updated_at = now
        await service._emit_pack(db, pack, deleted=False)
    details = {
        "folder": key,
        "name": pack.name,
        "new_pack": new_pack,
        "adopted": adopted,
        "created": len(created),
        "updated": len(changed),
        "images_replaced": replaced,
        "tab": tab_changed,
    }
    await audit.record_in_tx(
        db,
        actor_id=None,  # the system
        action="emoji_pack.preset",
        target_type="emoji_pack",
        target_id=pack.id,
        details=details,
    )
    what = ["new pack" if new_pack else "adopted" if adopted else "updated"]
    what += [f"{len(created)} added", f"{len(changed)} changed"]
    if replaced:
        what.append(f"{replaced} images replaced")
    if tab_changed:
        what.append("tab icon")
    return ", ".join(what)


async def import_presets(
    db: AsyncSession,
    root: Path,
    settings: Settings,
    blobs: BlobStore,
    *,
    restore: Sequence[str] = (),
) -> PresetReport:
    """Every preset folder under `root`, in one transaction (a savepoint per folder)."""
    report = PresetReport()
    if not await run_in_threadpool(root.is_dir):
        report.failed[str(root)] = "not a folder"
        return report
    folders = await run_in_threadpool(scan, root)
    if len(folders) > MAX_FOLDERS:
        report.warnings.append(f"only the first {MAX_FOLDERS} of {len(folders)} folders")
        folders = folders[:MAX_FOLDERS]
    if not (await db.execute(text(LOCK))).scalar():
        await db.rollback()
        report.busy = True
        return report
    owner = await _owner(db)
    if owner is None:
        await db.rollback()
        report.no_admin = True
        return report
    for key in restore:
        await db.execute(
            delete(EmojiPresetRemoval).where(EmojiPresetRemoval.preset_key == folder_key(key))
        )
    removals = await _removals(db)
    store = _Blobs()
    for key, path in folders:
        removed = removals.get(key, set())
        if "" in removed:
            report.removed.append(key)
            continue
        folder_store = _Blobs()
        try:
            folder = await run_in_threadpool(load_folder, key, path, settings)
            async with db.begin_nested():
                what = await _sync_folder(
                    db, folder, removed, owner, settings, blobs, folder_store, report
                )
        except Exception as exc:
            reason = exc.message if isinstance(exc, AppError) else repr(exc)
            report.failed[key] = reason
            for blob_key in folder_store.written:
                await _delete_quietly(blobs, blob_key)
            continue
        store.written += folder_store.written
        store.obsolete += folder_store.obsolete
        if what is None:
            report.unchanged.append(key)
        else:
            report.changed[key] = what
    try:
        await db.commit()
    except BaseException:
        await db.rollback()
        for blob_key in store.written:
            await _delete_quietly(blobs, blob_key)
        raise
    for blob_key in store.obsolete:
        await _delete_quietly(blobs, blob_key)
    return report


async def _delete_quietly(blobs: BlobStore, key: str) -> None:
    try:
        await blobs.delete(key)
    except Exception:
        log.warning("could not delete %s from the object store", key, exc_info=True)


async def run_at_startup(session: AsyncSession, settings: Settings, blobs: BlobStore) -> None:
    """The startup import: logs, never raises (a bad folder never blocks the app)."""
    try:
        report = await import_presets(session, Path(settings.emoji_presets_dir), settings, blobs)
    except Exception:
        log.exception("emoji presets: the import failed")
        return
    for warning in report.warnings:
        log.warning("emoji presets: %s", warning)
    for folder, why in report.failed.items():
        log.warning("emoji presets: skipped %s: %s", folder, why)
    log.info(report.summary())
