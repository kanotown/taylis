"""ZIPs of folders and selections (docs/DRIVE.md §7.2, phase D3).

POST /drive/zip counts what the ZIP holds and checks the limits (DRIVE_ZIP_MAX_ENTRIES /
DRIVE_ZIP_MAX_BYTES, else 413 drive_zip_too_large), then hands out a one-time URL valid for five
minutes. What the ZIP holds is fixed then (the items, their names and their versions): changes
made while it streams are not in it, and a version removed meanwhile can still be read (the
attachment GC waits a day before it removes bytes). Items in the trash and folders the actor
cannot read are never in it.

Inside: each requested item at the top (a folder with everything under it), names made safe for
Windows (names.download_name, the downloads' rule) and numbered 「名前 (1)」 where two would clash
in one folder (case-insensitively, as Windows and macOS compare), folders as entries of their own
(empty ones too), times from the file's own time else the last change. The bytes stream from the
store through zipstream (stored, ZIP64 only where needed, the exact Content-Length).
"""

import uuid
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.settings import Settings
from app.modules.drive import access as acl
from app.modules.drive import names, service, tree, zipstream
from app.modules.drive import repository as repo
from app.modules.drive.models import DriveItem
from app.modules.users.models import User

DEFAULT_ZONE = "Asia/Tokyo"


def zip_too_large(settings: Settings) -> AppError:
    return AppError(
        413,
        "drive_zip_too_large",
        f"A ZIP holds at most {settings.drive_zip_max_entries} items and "
        f"{settings.drive_zip_max_bytes} bytes; download the folders one by one",
        details={
            "limit_bytes": settings.drive_zip_max_bytes,
            "limit_entries": settings.drive_zip_max_entries,
        },
    )


@dataclass
class ZipJob:
    user_id: uuid.UUID
    # The requested items (checked again when the ZIP starts: still readable).
    item_ids: list[uuid.UUID]
    plan: zipstream.ZipPlan
    filename: str


def _zone(actor: User) -> ZoneInfo:
    """The DOS times' zone: the person's own (their quiet hours' zone) else Japan's."""
    for name in (actor.quiet_hours_tz, DEFAULT_ZONE):
        if name:
            try:
                return ZoneInfo(name)
            except (ZoneInfoNotFoundError, ValueError):
                continue
    return ZoneInfo("UTC")


class _Names:
    """Unique names per folder of the ZIP."""

    def __init__(self) -> None:
        self.taken: dict[str, set[str]] = {}

    def claim(self, folder: str, raw: str, *, is_file: bool) -> str:
        used = self.taken.setdefault(folder, set())
        base = names.download_name(raw)
        name = base
        n = 0
        while name.casefold() in used:
            n += 1
            name = names.numbered(base, n, is_file=is_file)
        used.add(name.casefold())
        return name


def _when(item: DriveItem) -> datetime:
    return item.content_modified_at or item.updated_at


def _entries(root: tree.Node, prefix: str, taken: _Names) -> list[zipstream.ZipEntry]:
    item = root.item
    name = taken.claim(prefix, item.name, is_file=item.kind == "file")
    path = f"{prefix}{name}"
    if item.kind == "file":
        if root.attachment is None or root.version is None:
            return []  # its bytes are gone: left out rather than a broken ZIP
        return [
            zipstream.ZipEntry(
                name=path,
                size=root.version.size_bytes,
                modified=_when(item),
                source=root.attachment.storage_key,
            )
        ]
    out = [zipstream.ZipEntry(name=f"{path}/", size=0, modified=_when(item), is_dir=True)]
    for child in root.children:
        out += _entries(child, f"{path}/", taken)
    return out


async def prepare(
    db: AsyncSession, actor: User, settings: Settings, item_ids: list[uuid.UUID]
) -> ZipJob:
    wanted = list(dict.fromkeys(item_ids))
    rows: list[DriveItem] = []
    for item_id in wanted:
        item, _ = await service.readable_item(db, actor, item_id)
        rows.append(item)
    cap = settings.drive_zip_max_entries
    taken = _Names()
    entries: list[zipstream.ZipEntry] = []
    # A requested root (the location's top folder) stands for what is in it.
    for item in rows:
        try:
            node = await tree.snapshot(db, item, cap=cap)
        except tree.TooLarge:
            raise zip_too_large(settings) from None
        if item.parent_id is None:
            for child in node.children:
                entries += _entries(child, "", taken)
        else:
            entries += _entries(node, "", taken)
        if len(entries) > cap:
            raise zip_too_large(settings)
    total = sum(entry.size for entry in entries)
    if len(entries) > cap or total > settings.drive_zip_max_bytes:
        raise zip_too_large(settings)
    plan = zipstream.plan(entries, _zone(actor))
    return ZipJob(
        user_id=actor.id,
        item_ids=[row.id for row in rows],
        plan=plan,
        filename=await _filename(db, actor, rows),
    )


async def _filename(db: AsyncSession, actor: User, rows: list[DriveItem]) -> str:
    """One item: its name; several in one folder: that folder's (or the location's) name; else
    「ドライブ」."""
    if len(rows) == 1 and rows[0].parent_id is not None:
        return f"{names.download_name(rows[0].name)}.zip"
    parents = {row.parent_id for row in rows}
    folder_id = rows[0].id if len(rows) == 1 else (parents.pop() if len(parents) == 1 else None)
    if folder_id is not None:
        folder = await repo.item(db, folder_id)
        if folder is not None:
            if folder.parent_id is not None:
                return f"{names.download_name(folder.name)}.zip"
            location = await repo.location(db, folder.location_id)
            if location is not None:
                return f"{names.download_name(await acl.location_name(db, location))}.zip"
    return "drive.zip"


async def still_readable(db: AsyncSession, job: ZipJob) -> bool:
    """When the ZIP starts: its person may still sign in and read each requested item."""
    user = await db.get(User, job.user_id)
    if user is None or not user.is_active:
        return False
    for item_id in job.item_ids:
        try:
            await service.readable_item(db, user, item_id)
        except AppError:
            return False
    return True
