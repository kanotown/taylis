"""Importing Nextcloud's files into the drive (M164, docs/DRIVE.md §15).

``python -m app.cli import-nextcloud (--webdav URL --webdav-user U --webdav-password-file F |
--data-dir DIR) --map MAP.toml --actor ADMIN [--dry-run]``:

- the mapping (TOML, ``[[map]] source/target`` and ``[[skip]] source``) puts each Nextcloud folder
  in a drive location and folder: the longest source (by whole path segments) that contains a
  path decides, a skip rule included, so a map inside a skipped folder brings that part back.
  What no rule covers is not imported and is reported with its size, never dropped silently. A
  target channel or person that does not exist stops the run before anything is written (the
  channels and their members are made in Taylis first); target folders are made;
- folders keep their shape (empty ones too), files their modification time
  (``content_modified_at``); names are NFC. A name the drive refuses (§4.3) or one that differs
  from a name already in the folder only in case becomes 「名前 (1)」 and is reported;
- every folder and file made is an ``import_refs`` row (source ``nextcloud``, kind
  ``drive_item``, source_id the SHA-256 of the Nextcloud user, the full Nextcloud path and the
  rule's target), so a run again skips what has not changed (size and time equal to the last
  imported version), adds a changed file as a new version (``source = 'import'``), and adds
  nothing twice. A file someone changed in Taylis since its import and that changed in Nextcloud
  too is left alone and reported; something deleted (or put in the trash) in Taylis is not
  brought back; what was deleted in Nextcloud stays in Taylis (reported);
- the bytes stream from WebDAV (or the file) to the object store one part (16 MiB) at a time
  (``drive.uploads.store_stream``), never whole in memory, and each file is committed on its own:
  a run stopped anywhere goes on from there when started again. Quotas are checked like an
  upload's (before reading and again when placing); ``--limit-bytes`` ends a run early;
- previews are not queued (``generate-previews --drive`` makes them afterwards, so the chat's
  previews are not held up) unless ``--previews``. The SHA-256 is computed while streaming; the
  drive's media loop still makes the thumbnails and posters of images and videos;
- ``--dry-run`` reads the Nextcloud tree and writes nothing: the report has the counts, the
  sizes per location against their quotas, the names that change, the unmapped folders.
"""

import hashlib
import logging
import time
import tomllib
import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.ids import uuid7
from app.core.roles import PERSON_ROLES
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import service as attachments
from app.modules.attachments import videos
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import IMAGE_TYPES
from app.modules.audit import service as audit
from app.modules.channels.models import DM_TYPES, Channel
from app.modules.drive import access as acl
from app.modules.drive import events, names, service, uploads
from app.modules.drive import repository as repo
from app.modules.drive.models import DriveItem, DriveLocation
from app.modules.drive.usage import effective_quota
from app.modules.importer.core import ImportFailed, active_admin
from app.modules.importer.models import ImportRef
from app.modules.importer.nextcloud_source import Entry, Source, SourceError, nfc_path
from app.modules.users.models import User

log = logging.getLogger("app.importer.nextcloud")

SOURCE = "nextcloud"
KIND = "drive_item"
EARLIEST = datetime(1980, 1, 1, tzinfo=UTC)
ATTEMPTS = 3  # tries per file (a WebDAV read cut off)
GIVE_UP_AFTER = 10  # files failing one after the other: the source is gone, stop
REPORT_LINES = 500


# --- the mapping ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Target:
    kind: str  # workspace | channel | user
    name: str | None  # the channel's or the person's name
    path: tuple[str, ...]  # folders below the location's root

    @property
    def spec(self) -> str:
        path = "/" + "/".join(self.path)
        return f"{self.kind}:{path}" if self.name is None else f"{self.kind}:{self.name}:{path}"

    @property
    def place(self) -> str:
        return self.kind if self.name is None else f"{self.kind}:{self.name}"


@dataclass(frozen=True)
class Rule:
    source: tuple[str, ...]
    target: Target | None  # None: a skip rule

    @property
    def source_path(self) -> str:
        return "/" + "/".join(self.source)


def _segments(path: str, where: str) -> tuple[str, ...]:
    path = nfc_path(path.strip())
    if not path.startswith("/"):
        raise ImportFailed(f"{where}: {path!r} must start with /")
    out = tuple(s for s in path.split("/") if s)
    if any(s in (".", "..") for s in out):
        raise ImportFailed(f"{where}: {path!r} has . or ..")
    return out


def parse_target(spec: str, where: str) -> Target:
    kind, sep, rest = spec.strip().partition(":")
    if not sep:
        raise ImportFailed(
            f"{where}: target {spec!r}: workspace:/…, channel:NAME:/… or user:NAME:/…"
        )
    name: str | None = None
    if kind in ("channel", "user"):
        name, sep, rest = rest.partition(":")
        name = name.strip()
        if not sep or not name:
            raise ImportFailed(f"{where}: target {spec!r}: {kind}:NAME:/path")
    elif kind != "workspace":
        raise ImportFailed(f"{where}: target {spec!r}: workspace, channel or user")
    segments = _segments(rest, where)
    try:
        path = tuple(names.normalize(s) for s in segments)
    except AppError as exc:
        raise ImportFailed(f"{where}: target {spec!r}: {exc.message}") from exc
    return Target(kind, name, path)


class Mapping:
    def __init__(self, rules: list[Rule]) -> None:
        self.rules = rules
        self._by_source = {rule.source: rule for rule in rules}

    def match(self, path: str) -> tuple[Rule, tuple[str, ...]] | None:
        """The longest rule containing `path` and the segments below its source."""
        segments = tuple(s for s in path.split("/") if s)
        for n in range(len(segments), -1, -1):
            rule = self._by_source.get(segments[:n])
            if rule is not None:
                return rule, segments[n:]
        return None

    def descend(self, folder: str) -> bool:
        """Whether a walk goes into `folder`: a map rule covers it or lies below it."""
        found = self.match(folder)
        if found is not None and found[0].target is not None:
            return True
        segments = tuple(s for s in folder.split("/") if s)
        return any(
            rule.target is not None
            and len(rule.source) > len(segments)
            and rule.source[: len(segments)] == segments
            for rule in self.rules
        )


def parse_mapping(source: str, where: str = "--map") -> Mapping:
    try:
        data = tomllib.loads(source)
    except tomllib.TOMLDecodeError as exc:
        raise ImportFailed(f"{where}: {exc}") from exc
    unknown = set(data) - {"map", "skip"}
    if unknown:
        raise ImportFailed(f"{where}: unknown keys {', '.join(sorted(unknown))} (map, skip)")
    rules: list[Rule] = []
    seen: set[tuple[str, ...]] = set()
    for section in ("map", "skip"):
        entries = data.get(section, [])
        if not isinstance(entries, list):
            raise ImportFailed(f"{where}: [[{section}]] must be a list of tables")
        for i, entry in enumerate(entries, 1):
            here = f"{where} [[{section}]] #{i}"
            if not isinstance(entry, dict) or not isinstance(entry.get("source"), str):
                raise ImportFailed(f'{here}: needs source = "/…"')
            allowed = {"source", "target"} if section == "map" else {"source"}
            extra = set(entry) - allowed
            if extra:
                raise ImportFailed(f"{here}: unknown keys {', '.join(sorted(extra))}")
            segments = _segments(entry["source"], here)
            if segments in seen:
                raise ImportFailed(f"{here}: source {entry['source']!r} appears twice")
            seen.add(segments)
            target = None
            if section == "map":
                if not isinstance(entry.get("target"), str):
                    raise ImportFailed(f'{here}: needs target = "…"')
                target = parse_target(entry["target"], here)
            rules.append(Rule(segments, target))
    if not any(rule.target is not None for rule in rules):
        raise ImportFailed(f"{where}: no [[map]] entry")
    return Mapping(rules)


def ref_key(label: str, path: str, target: Target) -> str:
    """import_refs.source_id: 64 hex characters (§15.4)."""
    return hashlib.sha256(f"{label}\n{path}\n{target.spec}".encode()).hexdigest()


def clamp_time(at: datetime | None) -> datetime | None:
    """A modification time the drive keeps (§6.2: 1980 to a day from now), else None."""
    if at is None or at < EARLIEST or at > utcnow() + timedelta(days=1):
        return None
    return at


def valid_name(entry: Entry) -> tuple[str, str | None]:
    """(a name the drive takes for the entry, why it is not Nextcloud's or None)."""
    name, why = drive_name(entry.name)
    if entry.invalid_text and why is None:
        why = "the name is not UTF-8 on disk (shown with �)"
    return name, why


def drive_name(raw: str) -> tuple[str, str | None]:
    """(a name the drive takes, why it changed or None)."""
    try:
        return names.normalize(raw), None
    except AppError:
        pass
    cleaned = "".join(" " if ord(c) < 32 or ord(c) == 127 else c for c in raw)
    cleaned = cleaned.replace("/", "_").strip()
    if cleaned in ("", ".", ".."):
        cleaned = "_" + cleaned
    if len(cleaned) > names.MAX_NAME:
        stem, dot, ext = cleaned.rpartition(".")
        if dot and 0 < len(ext) < 20:
            cleaned = stem[: names.MAX_NAME - len(ext) - 1] + "." + ext
        else:
            cleaned = cleaned[: names.MAX_NAME]
    return names.normalize(cleaned), "a name the drive refuses"


# --- the report ----------------------------------------------------------------------------------


@dataclass
class PlaceUse:
    label: str
    used: int  # before the import
    quota: int | None
    files: int = 0
    adding: int = 0  # bytes this run adds (new files and versions)


@dataclass
class NextcloudReport:
    dry_run: bool
    label: str = ""
    counts: Counter[str] = field(default_factory=Counter)
    bytes: Counter[str] = field(default_factory=Counter)
    places: dict[str, PlaceUse] = field(default_factory=dict)
    total_quota: int | None = None
    total_used: int = 0
    renamed: list[tuple[str, str, str]] = field(default_factory=list)  # (nextcloud, taylis, why)
    unmapped: list[tuple[str, int, int | None]] = field(default_factory=list)
    skipped: list[tuple[str, str, int]] = field(default_factory=list)  # (path, why, bytes)
    missing_targets: list[str] = field(default_factory=list)
    gone: list[str] = field(default_factory=list)  # imported before, not in Nextcloud now
    failed: list[tuple[str, str]] = field(default_factory=list)
    owners: Counter[str] = field(default_factory=Counter)  # Nextcloud owners without --user
    stopped: str | None = None
    transferred: int = 0
    seconds: float = 0.0

    @property
    def over_quota(self) -> list[str]:
        out = []
        for use in self.places.values():
            if use.quota is not None and use.used + use.adding > use.quota:
                out.append(
                    f"{use.label}: {use.used + use.adding} bytes after the import, quota "
                    f"{use.quota}"
                )
        adding = sum(use.adding for use in self.places.values())
        if self.total_quota is not None and self.total_used + adding > self.total_quota:
            out.append(
                f"the whole drive: {self.total_used + adding} bytes after the import, "
                f"DRIVE_TOTAL_QUOTA_BYTES {self.total_quota}"
            )
        return out


# --- planning ------------------------------------------------------------------------------------


@dataclass
class Place:
    """A target location. Only ids are kept: the run commits and rolls back between files, which
    expires every loaded row."""

    key: str  # "workspace" / "channel:name" / "user:name" (or a location's id)
    label: str  # for the report
    kind: str
    channel_id: uuid.UUID | None = None
    user_id: uuid.UUID | None = None
    location_id: uuid.UUID | None = None  # None: made at the first write
    root: "VFolder | None" = None


@dataclass
class VNode:
    kind: str
    item_id: uuid.UUID | None
    claimed: bool  # an imported Nextcloud entry (this run or an earlier one) is this item
    folder: "VFolder | None" = None


@dataclass
class VFolder:
    """A drive folder as the plan sees it: one that exists (item_id) or one to make."""

    place: Place
    parent: "VFolder | None"
    name: str
    path: str  # "研究室ドライブ/ゼミ資料" for the report
    item_id: uuid.UUID | None
    depth: int
    nextcloud: bool = False  # a Nextcloud folder (made by its own step), not a target folder
    owner_id: uuid.UUID | None = None
    modified: datetime | None = None
    failed: bool = False
    children: dict[str, VNode] | None = None  # by name key, loaded when first needed


@dataclass
class Step:
    entry: Entry
    key: str
    action: str  # folder | file | version
    folder: VFolder  # the parent (file), the folder itself (folder), the place's root (version)
    name: str
    item_id: uuid.UUID | None = None  # version: the item; folder: an existing one to link
    owner_id: uuid.UUID | None = None


@dataclass
class Options:
    previews: bool = False
    limit_bytes: int | None = None
    progress: Callable[[str], None] | None = None


@dataclass(frozen=True)
class Known:
    """An item an earlier run imported."""

    kind: str
    name: str
    parent_id: uuid.UUID | None
    location_id: uuid.UUID
    current_version_id: uuid.UUID | None
    trashed: bool


class FolderFailed(Exception):
    """A Nextcloud folder could not be made: what is in it is not imported this run."""


class NextcloudImport:
    def __init__(
        self,
        db: AsyncSession,
        source: Source,
        mapping: Mapping,
        *,
        actor_id: uuid.UUID,
        user_map: dict[str, uuid.UUID],
        blobs: BlobStore,
        settings: Settings,
        options: Options,
        dry_run: bool,
    ) -> None:
        self.db = db
        self.source = source
        self.mapping = mapping
        self.actor_id = actor_id
        self.user_map = user_map
        self.blobs = blobs
        self.settings = settings
        self.options = options
        self.dry_run = dry_run
        self.report = NextcloudReport(dry_run=dry_run, label=source.label)
        self.refs: dict[str, uuid.UUID] = {}
        self.known: dict[uuid.UUID, Known] = {}
        # item → (size, time, version id) of its newest imported version
        self.imported: dict[uuid.UUID, tuple[int, datetime | None, uuid.UUID]] = {}
        self.places: dict[str, Place] = {}
        self.places_by_location: dict[uuid.UUID, Place] = {}
        self.folders: dict[str, VFolder] = {}  # by Nextcloud folder path
        self.steps: list[Step] = []
        self.seen_items: set[uuid.UUID] = set()

    def _progress(self, message: str) -> None:
        if self.options.progress is not None:
            self.options.progress(message)

    # ---- targets ---------------------------------------------------------------------------

    async def resolve_places(self) -> None:
        for rule in self.mapping.rules:
            target = rule.target
            if target is None or target.place in self.places:
                continue
            place = await self._resolve(target)
            if place is not None:
                self._add_place(place, await self._location(place))

    async def _resolve(self, target: Target) -> Place | None:
        problems = self.report.missing_targets
        if target.kind == "workspace":
            return Place(target.place, acl.WORKSPACE_NAME, "workspace")
        if target.kind == "channel":
            channel = (
                await self.db.execute(select(Channel).where(Channel.name == target.name))
            ).scalar_one_or_none()
            if channel is None:
                problems.append(f"{target.spec}: no channel named {target.name}")
            elif channel.type in DM_TYPES:
                problems.append(f"{target.spec}: a DM has no drive")
            elif channel.archived_at is not None:
                problems.append(f"{target.spec}: the channel is archived")
            else:
                return Place(target.place, f"#{channel.name}", "channel", channel_id=channel.id)
            return None
        user = (
            await self.db.execute(select(User).where(User.username == target.name))
        ).scalar_one_or_none()
        if user is None:
            problems.append(f"{target.spec}: no user named {target.name}")
            return None
        if user.role not in PERSON_ROLES:
            problems.append(f"{target.spec}: {target.name} has no My Drive ({user.role})")
            return None
        mine = await repo.location_of_user(self.db, user.id)
        if mine is not None and mine.deleted_at is not None:
            problems.append(f"{target.spec}: the My Drive of {target.name} is being deleted")
            return None
        return Place(target.place, f"マイドライブ ({user.username})", "user", user_id=user.id)

    async def _location(self, place: Place) -> DriveLocation | None:
        if place.kind == "workspace":
            return await repo.workspace_location(self.db)
        if place.kind == "channel":
            assert place.channel_id is not None
            return await repo.location_of_channel(self.db, place.channel_id)
        assert place.user_id is not None
        return await repo.location_of_user(self.db, place.user_id)

    def _add_place(self, place: Place, location: DriveLocation | None) -> None:
        self.places[place.key] = place
        if location is not None:
            place.location_id = location.id
            self.places_by_location[location.id] = place
            quota = effective_quota(location, self.settings)
            used = location.used_bytes
        else:
            quota = self.settings.drive_user_default_quota_bytes if place.kind == "user" else None
            used = 0
        place.root = VFolder(
            place, None, "", place.label, location.root_id if location else None, 0
        )
        self.report.places.setdefault(place.key, PlaceUse(place.label, used, quota))

    async def _place_of_location(self, location_id: uuid.UUID) -> Place:
        """The place of an imported item someone moved to another location since."""
        found = self.places_by_location.get(location_id)
        if found is not None:
            return found
        location = await repo.location(self.db, location_id)
        assert location is not None
        place = Place(
            str(location_id),
            await acl.location_name(self.db, location),
            location.kind,
            channel_id=location.channel_id,
            user_id=location.user_id,
        )
        self._add_place(place, location)
        return place

    # ---- the plan ----------------------------------------------------------------------------

    async def load_refs(self) -> None:
        rows = await self.db.execute(
            select(ImportRef.source_id, ImportRef.target_id).where(
                ImportRef.source == SOURCE, ImportRef.kind == KIND
            )
        )
        self.refs = {str(s): t for s, t in rows.all()}
        ids = list(set(self.refs.values()))
        for start in range(0, len(ids), 5000):
            chunk = ids[start : start + 5000]
            items = await self.db.execute(
                select(
                    DriveItem.id,
                    DriveItem.kind,
                    DriveItem.name,
                    DriveItem.parent_id,
                    DriveItem.location_id,
                    DriveItem.current_version_id,
                    DriveItem.trashed_at,
                ).where(DriveItem.id.in_(chunk))
            )
            for item_id, kind, name, parent_id, location_id, current, trashed in items.all():
                self.known[item_id] = Known(
                    kind, name, parent_id, location_id, current, trashed is not None
                )
            versions = await self.db.execute(
                text(
                    "SELECT DISTINCT ON (item_id) item_id, size_bytes, content_modified_at, id "
                    "FROM drive_file_versions WHERE source = 'import' AND item_id = ANY(:ids) "
                    "ORDER BY item_id, number DESC"
                ),
                {"ids": chunk},
            )
            for item_id, size, modified, version_id in versions.all():
                self.imported[item_id] = (int(size), modified, version_id)

    async def _children(self, folder: VFolder) -> dict[str, VNode]:
        if folder.children is None:
            folder.children = {}
            if folder.item_id is not None:
                rows = await self.db.execute(
                    select(DriveItem.id, DriveItem.name_key, DriveItem.kind).where(
                        DriveItem.parent_id == folder.item_id, DriveItem.trashed_at.is_(None)
                    )
                )
                for item_id, key, kind in rows.all():
                    folder.children[key] = VNode(kind, item_id, item_id in self.known)
        return folder.children

    async def _target_folder(self, place: Place, path: tuple[str, ...]) -> VFolder | None:
        """The rule's target folder, mkdir -p (an existing folder of the name is used); None
        when a file is in the way."""
        assert place.root is not None
        folder = place.root
        for segment in path:
            children = await self._children(folder)
            node = children.get(names.key(segment))
            if node is None:
                node = VNode("folder", None, False)
                children[names.key(segment)] = node
            if node.kind != "folder":
                return None
            if node.folder is None:
                node.folder = VFolder(
                    place,
                    folder,
                    segment,
                    f"{folder.path}/{segment}",
                    node.item_id,
                    folder.depth + 1,
                )
            folder = node.folder
        return folder

    async def _free(self, folder: VFolder, name: str, *, is_file: bool) -> str:
        children = await self._children(folder)
        if names.key(name) not in children:
            return name
        n = 1
        while names.key(names.numbered(name, n, is_file=is_file)) in children:
            n += 1
        return names.numbered(name, n, is_file=is_file)

    def _owner(self, entry: Entry) -> uuid.UUID:
        if entry.owner:
            found = self.user_map.get(entry.owner.lower())
            if found is not None:
                return found
            self.report.owners[entry.owner] += 1
        return self.actor_id

    async def plan(self) -> None:
        walk = await self.source.walk(self.mapping.descend)
        for unvisited in walk.unvisited:
            found = self.mapping.match(unvisited.path)
            if found is not None and found[0].target is None:
                self.report.skipped.append((unvisited.path, "[[skip]]", unvisited.size))
                self.report.bytes["skipped"] += unvisited.size
            else:
                self.report.unmapped.append((unvisited.path, unvisited.size, unvisited.files))
                self.report.bytes["unmapped"] += unvisited.size
        for path, why in walk.skipped:
            self.report.skipped.append((path, why, 0))
            self.report.counts["skipped (not a file)"] += 1
        dead: set[str] = set()
        for entry in walk.entries:
            await self._plan_entry(entry, dead)

    def _skip(self, entry: Entry, why: str, count: str | None = None) -> None:
        self.report.skipped.append((entry.path, why, entry.size if entry.kind == "file" else 0))
        if entry.kind == "file":
            self.report.bytes["skipped"] += entry.size
        if count is not None:
            self.report.counts[count] += 1

    async def _plan_entry(self, entry: Entry, dead: set[str]) -> None:
        parent_path = entry.path.rsplit("/", 1)[0]
        if parent_path in dead:
            if entry.kind == "folder":
                dead.add(entry.path)
            self.report.counts["skipped (in a folder that is not imported)"] += 1
            return
        found = self.mapping.match(entry.path)
        if found is None or found[0].target is None:
            if entry.kind == "file":
                if found is None:
                    self.report.unmapped.append((entry.path, entry.size, 1))
                    self.report.bytes["unmapped"] += entry.size
                else:
                    self._skip(entry, "[[skip]]")
            return
        rule, rest = found
        target = rule.target
        assert target is not None
        place = self.places.get(target.place)
        if place is None:  # a missing target (reported)
            return
        key = ref_key(self.source.label, entry.path, target)
        ref = self.refs.get(key)
        known = self.known.get(ref) if ref is not None else None
        if ref is not None and (known is None or known.trashed):
            why = "deleted in Taylis" if known is None else "in the Taylis trash"
            self._skip(entry, f"{why}: not imported again", f"skipped ({why})")
            if entry.kind == "folder":
                dead.add(entry.path)
            return
        if ref is not None:
            self.seen_items.add(ref)
        if rest:
            parent = self.folders.get(parent_path) or await self._target_folder(place, target.path)
        else:
            # The rule's own source: a folder becomes the target folder, a file goes in it.
            parent = await self._target_folder(place, target.path)
            if parent is not None and entry.kind == "folder":
                self.folders[entry.path] = parent
                return
        if parent is None:
            self._skip(entry, f"{target.spec}: a file is in the way", "skipped (target)")
            if entry.kind == "folder":
                dead.add(entry.path)
            return
        if entry.kind == "folder":
            await self._plan_folder(entry, key, ref, known, parent, dead)
        else:
            await self._plan_file(entry, key, ref, known, parent)

    async def _plan_folder(
        self,
        entry: Entry,
        key: str,
        ref: uuid.UUID | None,
        known: Known | None,
        parent: VFolder,
        dead: set[str],
    ) -> None:
        if ref is not None and known is not None:
            if known.location_id == parent.place.location_id and known.parent_id == parent.item_id:
                place, depth, path = parent.place, parent.depth + 1, f"{parent.path}/{known.name}"
            else:  # moved in Taylis since: what is new goes where the folder is now
                place = await self._place_of_location(known.location_id)
                depth = len(await repo.ancestor_ids(self.db, ref)) - 1
                path = f"{place.label}/…/{known.name}"
            self.folders[entry.path] = VFolder(
                place, None, known.name, path, ref, depth, nextcloud=True
            )
            self.report.counts["folders unchanged"] += 1
            return
        if parent.depth + 1 > names.MAX_DEPTH:
            self._skip(entry, "deeper than 32 folders", "skipped (too deep)")
            dead.add(entry.path)
            return
        name, why = valid_name(entry)
        children = await self._children(parent)
        node = children.get(names.key(name))
        reuse: uuid.UUID | None = None
        if node is not None and node.kind == "folder" and not node.claimed:
            reuse = node.item_id  # a folder of that name made in Taylis: the files go in it
            node.claimed = True
        elif node is not None:
            name = await self._free(parent, name, is_file=False)
            why = why or "a name in the folder differs only in case (or is a file)"
            node = None
        if node is None:
            node = VNode("folder", None, True)
            children[names.key(name)] = node
        folder = VFolder(
            parent.place,
            parent,
            name,
            f"{parent.path}/{name}",
            reuse,
            parent.depth + 1,
            nextcloud=True,
            owner_id=self._owner(entry),
            modified=clamp_time(entry.mtime),
        )
        node.folder = folder
        self.folders[entry.path] = folder
        if why is not None:
            self.report.renamed.append((entry.path, folder.path, why))
        self.steps.append(Step(entry, key, "folder", folder, name, reuse, folder.owner_id))
        self.report.counts["folders new" if reuse is None else "folders linked"] += 1

    async def _plan_file(
        self,
        entry: Entry,
        key: str,
        ref: uuid.UUID | None,
        known: Known | None,
        parent: VFolder,
    ) -> None:
        if entry.size > self.settings.drive_max_file_bytes:
            self._skip(
                entry,
                f"larger than DRIVE_MAX_FILE_BYTES ({self.settings.drive_max_file_bytes})",
                "skipped (too large)",
            )
            return
        modified = clamp_time(entry.mtime)
        if ref is not None and known is not None:
            last = self.imported.get(ref)
            if last is not None and last[0] == entry.size and last[1] == modified:
                self.report.counts["files unchanged"] += 1
                return
            if last is None or known.current_version_id != last[2]:
                self._skip(
                    entry,
                    "changed in Taylis since the import and in Nextcloud: left as it is",
                    "skipped (changed in both)",
                )
                return
            place = await self._place_of_location(known.location_id)
            assert place.root is not None
            self.steps.append(
                Step(entry, key, "version", place.root, known.name, ref, self._owner(entry))
            )
            self.report.counts["files new version"] += 1
            self.report.bytes["new versions"] += entry.size
            self.report.places[place.key].adding += entry.size
            return
        if parent.depth + 1 > names.MAX_DEPTH:
            self._skip(entry, "deeper than 32 folders", "skipped (too deep)")
            return
        name, why = valid_name(entry)
        children = await self._children(parent)
        if names.key(name) in children:
            name = await self._free(parent, name, is_file=True)
            why = why or "a name in the folder differs only in case (or is a folder)"
        children[names.key(name)] = VNode("file", None, True)
        if why is not None:
            self.report.renamed.append((entry.path, f"{parent.path}/{name}", why))
        self.steps.append(Step(entry, key, "file", parent, name, None, self._owner(entry)))
        self.report.counts["files new"] += 1
        self.report.bytes["new files"] += entry.size
        use = self.report.places[parent.place.key]
        use.files += 1
        use.adding += entry.size

    async def find_gone(self) -> None:
        """Imported items in the rules' target folders that this Nextcloud tree no longer has
        (kept in Taylis, reported)."""
        imported = set(self.refs.values())
        roots: set[uuid.UUID] = set()
        for rule in self.mapping.rules:
            if rule.target is None or rule.target.place not in self.places:
                continue
            folder = await self._target_folder(self.places[rule.target.place], rule.target.path)
            if folder is not None and folder.item_id is not None:
                roots.add(folder.item_id)
        gone: set[uuid.UUID] = set()
        for root in roots:
            for item_id, _depth in await repo.live_subtree(self.db, root, cap=1_000_000):
                if item_id in imported and item_id not in self.seen_items:
                    gone.add(item_id)
        if not gone:
            return
        rows = await self.db.execute(
            select(DriveItem.id, DriveItem.name, DriveItem.kind).where(DriveItem.id.in_(gone))
        )
        found = sorted(rows.all(), key=lambda r: r[1])
        self.report.counts["in Taylis, no longer in this Nextcloud tree"] = len(found)
        for item_id, name, kind in found[:REPORT_LINES]:
            chain = await repo.ancestor_ids(self.db, item_id)
            above = await repo.items(self.db, chain[1:-1])
            path = "/".join(above[i].name for i in chain[1:-1] if i in above)
            self.report.gone.append(f"{kind}: {path + '/' if path else ''}{name}")

    # ---- the run -----------------------------------------------------------------------------

    async def run(self) -> None:
        started = time.monotonic()
        failures_in_a_row = 0
        total = sum(step.entry.size for step in self.steps if step.action != "folder")
        files = 0
        last_line = started
        try:
            for step in self.steps:
                if step.action == "folder":
                    await self._run_folder(step)
                    continue
                limit = self.options.limit_bytes
                if (
                    limit is not None
                    and self.report.transferred > 0
                    and self.report.transferred + step.entry.size > limit
                ):
                    self.report.stopped = (
                        f"--limit-bytes {limit} reached: run the same command again to go on"
                    )
                    break
                ok = await self._run_file(step)
                files += 1
                failures_in_a_row = 0 if ok else failures_in_a_row + 1
                if failures_in_a_row >= GIVE_UP_AFTER:
                    self.report.stopped = (
                        f"{GIVE_UP_AFTER} files failed one after the other: stopped "
                        "(fix the cause and run again)"
                    )
                    break
                now = time.monotonic()
                if now - last_line > 10:
                    last_line = now
                    speed = self.report.transferred / max(now - started, 0.001)
                    self._progress(
                        f"{files} file(s), {self.report.transferred} of {total} bytes, "
                        f"{speed / 1e6:.1f} MB/s"
                    )
        finally:
            self.report.seconds = time.monotonic() - started

    async def _ensure_place(self, place: Place) -> uuid.UUID:
        if place.location_id is None:
            location = await service.ensure_location(
                self.db, place.kind, channel_id=place.channel_id, user_id=place.user_id
            )
            location_id, root_id = location.id, location.root_id
            await self.db.commit()
            place.location_id = location_id
            self.places_by_location[location_id] = place
            assert place.root is not None
            place.root.item_id = root_id
            return location_id
        return place.location_id

    async def _materialize(
        self, folder: VFolder, made: list[uuid.UUID], *, making: VFolder | None = None
    ) -> DriveItem:
        """The folder's row, locked; made (and the target folders above it) when missing, in
        the open transaction. `made` gets the parent of every folder made."""
        if folder.failed:
            raise FolderFailed
        if folder.item_id is not None:
            row = (await repo.lock_items(self.db, [folder.item_id])).get(folder.item_id)
            if row is None or row.trashed_at is not None or row.kind != "folder":
                raise acl.item_not_found()
            return row
        if folder.nextcloud and folder is not making:
            raise FolderFailed  # its own step did not make it
        assert folder.parent is not None
        parent = await self._materialize(folder.parent, made)
        name = folder.name
        existing = await repo.child_by_key(self.db, parent.id, names.key(name))
        if existing is not None and existing.kind == "folder" and not folder.nextcloud:
            locked = (await repo.lock_items(self.db, [existing.id]))[existing.id]
            folder.item_id = locked.id
            return locked
        if existing is not None:  # taken since the plan
            name = await service.free_name(self.db, parent.id, name, is_file=False)
            self.report.renamed.append(("", f"{folder.path} → {name}", "taken during the run"))
        if await service.depth_of(self.db, parent.id) + 1 > names.MAX_DEPTH:
            raise service.depth_exceeded()
        owner = await self.db.get(User, folder.owner_id or self.actor_id)
        assert owner is not None
        row = await service.new_folder_in_tx(self.db, owner, parent, name)
        if folder.modified is not None:
            row.content_modified_at = folder.modified
            await self.db.flush()
        made.append(parent.id)
        folder.item_id = row.id
        self.report.counts["done: folders made"] += 1
        return row

    async def _ref(self, key: str, item_id: uuid.UUID) -> None:
        await self.db.execute(
            insert(ImportRef)
            .values(source=SOURCE, kind=KIND, source_id=key, target_id=item_id)
            .on_conflict_do_update(
                index_elements=["source", "kind", "source_id"], set_={"target_id": item_id}
            )
        )
        self.refs[key] = item_id

    async def _count_folders(self, location_id: uuid.UUID, made: list[uuid.UUID]) -> None:
        if made:
            location = await service.lock_location(self.db, location_id)
            location.item_count += len(made)
            location.updated_at = utcnow()
            await events.emit_changed(self.db, location_id, made)

    async def _run_folder(self, step: Step) -> None:
        folder = step.folder
        location_id = await self._ensure_place(folder.place)
        made: list[uuid.UUID] = []
        try:
            row = await self._materialize(folder, made, making=folder)
            await self._ref(step.key, row.id)
            await self._count_folders(location_id, made)
            await self.db.commit()
        except (AppError, FolderFailed) as exc:
            await self.db.rollback()
            folder.failed = True
            folder.item_id = None
            why = exc.code if isinstance(exc, AppError) else "its folder was not made"
            self.report.failed.append((step.entry.path, why))

    async def _check_quota(self, location_id: uuid.UUID, size: int) -> None:
        try:
            location = await service.lock_location(self.db, location_id)
            await service.check_quota_in_tx(
                self.db, self.settings, location, size, with_reservations=True
            )
        finally:
            await self.db.rollback()

    async def _run_file(self, step: Step) -> bool:
        """Whether the source could be read (False counts towards giving up)."""
        entry = step.entry
        if step.action == "version":
            assert step.item_id is not None
            item = await repo.item(self.db, step.item_id)
            found = item.location_id if item is not None and item.trashed_at is None else None
            await self.db.rollback()
            if found is None:
                self.report.failed.append((entry.path, "deleted in Taylis during the run"))
                return True
            location_id = found
        else:
            if step.folder.failed:
                self.report.failed.append((entry.path, "its folder was not made"))
                return True
            location_id = await self._ensure_place(step.folder.place)
        try:
            await self._check_quota(location_id, entry.size)
        except AppError as exc:
            self.report.failed.append((entry.path, exc.code))
            return True
        attachment_id = uuid7()
        key = attachments.storage_key(attachment_id)
        try:
            digest, head = await self._stream(entry, key)
        except SourceError as exc:
            self.report.failed.append((entry.path, str(exc)))
            return False
        try:
            placed = await self._place(step, attachment_id, digest, uploads.sniffed_type(head))
        except BaseException:
            await self.db.rollback()
            await self._drop(key)
            raise
        if not placed:
            await self._drop(key)
            return True
        self.report.transferred += entry.size
        self.report.counts["done: files"] += 1
        return True

    async def _stream(self, entry: Entry, key: str) -> tuple[bytes, bytes]:
        last: Exception | None = None
        for attempt in range(ATTEMPTS):
            try:
                async with self.source.open(entry.source_path or entry.path) as chunks:
                    return await uploads.store_stream(
                        self.blobs,
                        key,
                        chunks,
                        size=entry.size,
                        part_size=self.settings.drive_part_bytes,
                    )
            except (SourceError, ValueError) as exc:
                last = exc
                log.warning("reading %s failed (try %d): %s", entry.path, attempt + 1, exc)
        if isinstance(last, ValueError):
            raise SourceError(f"changed while it was read ({last}): run again")
        raise SourceError(str(last))

    async def _drop(self, key: str) -> None:
        try:
            await self.blobs.delete(key)
        except Exception:
            log.warning("could not delete %s", key, exc_info=True)

    async def _place(
        self, step: Step, attachment_id: uuid.UUID, digest: bytes, content_type: str
    ) -> bool:
        entry = step.entry
        owner = step.owner_id or self.actor_id
        made: list[uuid.UUID] = []
        try:
            if step.action == "version":
                assert step.item_id is not None
                item = (await repo.lock_items(self.db, [step.item_id])).get(step.item_id)
                if item is None or item.trashed_at is not None or item.kind != "file":
                    raise acl.item_not_found()
                new_item = False
                folders = [item.parent_id]
            else:
                parent = await self._materialize(step.folder, made)
                name = step.name
                if await repo.child_by_key(self.db, parent.id, names.key(name)) is not None:
                    name = await service.free_name(self.db, parent.id, name, is_file=True)
                    self.report.renamed.append(
                        (entry.path, f"{step.folder.path}/{name}", "taken during the run")
                    )
                await service.require_room(self.db, parent.id)
                item = DriveItem(
                    id=uuid7(),
                    location_id=parent.location_id,
                    parent_id=parent.id,
                    kind="file",
                    created_by=owner,
                    created_at=utcnow(),
                    change_seq=0,
                )
                service.set_name(item, name)
                new_item = True
                folders = [*made, parent.id]
            await uploads.add_version_in_tx(
                self.db,
                self.settings,
                owner,
                item,
                location_id=item.location_id,
                new_item=new_item,
                folders_made=len(made),
                attachment_id=attachment_id,
                size=entry.size,
                content_type=content_type,
                content_modified_at=clamp_time(entry.mtime),
                source="import",
                with_reservations=True,
                sha256=digest,
                preview=self.options.previews,
                media_done=content_type not in IMAGE_TYPES and not videos.is_video(content_type),
            )
            await self._ref(step.key, item.id)
            await events.emit_changed(self.db, item.location_id, [f for f in folders if f])
            await self.db.commit()
        except (AppError, FolderFailed) as exc:
            await self.db.rollback()
            why = exc.code if isinstance(exc, AppError) else "its folder was not made"
            self.report.failed.append((entry.path, why))
            return False
        return True

    async def record(self) -> None:
        await audit.record_in_tx(
            self.db,
            actor_id=self.actor_id,
            action="drive.import",
            target_type="drive",
            target_id=None,
            details={
                "source": SOURCE,
                "nextcloud_user": self.source.label,
                "counts": {k: v for k, v in self.report.counts.items() if k.startswith("done")},
                "bytes": self.report.transferred,
                "failed": len(self.report.failed),
                "stopped": self.report.stopped,
            },
        )
        await self.db.commit()


async def import_nextcloud(
    db: AsyncSession,
    source: Source,
    mapping: Mapping,
    *,
    actor_username: str,
    user_map: dict[str, str],
    blobs: BlobStore,
    settings: Settings,
    options: Options,
    dry_run: bool,
) -> NextcloudReport:
    """The plan (and without dry_run, the run) of importing `source` by `mapping`; the report
    says what was (or would be) done. A run stopped by an exception (Ctrl-C included) has
    committed every file before the one it was at, and is recorded in the audit log."""
    actor = await active_admin(db, actor_username)
    actor_id = actor.id
    resolved: dict[str, uuid.UUID] = {}
    for nc_user, username in user_map.items():
        user = (
            await db.execute(select(User).where(User.username == username))
        ).scalar_one_or_none()
        if user is None:
            raise ImportFailed(f"--user {nc_user}={username}: no such account")
        resolved[nc_user] = user.id
    job = NextcloudImport(
        db,
        source,
        mapping,
        actor_id=actor_id,
        user_map=resolved,
        blobs=blobs,
        settings=settings,
        options=options,
        dry_run=dry_run,
    )
    await job.resolve_places()
    if job.report.missing_targets and not dry_run:
        raise ImportFailed(
            "targets that cannot be used (make them in Taylis first; nothing was written):\n  "
            + "\n  ".join(job.report.missing_targets)
        )
    await job.load_refs()
    job.report.total_quota = settings.drive_total_quota_bytes
    job.report.total_used = await repo.total_used(db)
    try:
        await job.plan()
    except SourceError as exc:
        raise ImportFailed(str(exc)) from exc
    await job.find_gone()
    await db.rollback()
    if dry_run:
        return job.report
    await blobs.ensure_bucket()
    try:
        await job.run()
    finally:
        await db.rollback()
        try:
            await job.record()
        except Exception:
            log.warning("could not write the import's audit entry", exc_info=True)
    return job.report
