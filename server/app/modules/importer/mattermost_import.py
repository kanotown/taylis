"""Import one Mattermost team from the JSONL file ``mattermost_extract`` wrote (M18).

Runs inside the ChikuwaChat stack against its own database and object store; Mattermost's files
are read from its data directory (mounted read-only). Every row made here is recorded in
import_refs, so running again skips what exists and only appends posts made since. Edits,
deletions and reactions made in Mattermost after the first run are not carried over.

What becomes what (DATA_MODEL.md "Mattermost からの移行"):

- people: ``--user mm=chikuwa`` first, then an earlier run, then the same e-mail address. Anyone
  else who posted or reacted gets a new deactivated account (a bot account for bots), so their
  posts keep an author. Nobody new can log in until an administrator reactivates them.
- channels: public and private channels (archived ones stay archived), with the members that map
  to active accounts. Channel admins and the creator become owners.
- posts: in creation order, each taking the next channel seq; replies stay in their thread.
  ``@name`` becomes a mention, ``@channel`` / ``@all`` / ``@here`` the group mentions and a
  ``:shortcode:`` of a standard emoji its glyph. Files, reactions, pins, edit times and the
  custom emoji the posts use come along.

Imported messages count as read for every member: they are history, not news. No message events
and no pushes are sent; clients see the new channels at once and load their history on demand.
The steps shared with the Slack import live in ``core``.
"""

import hashlib
import json
import re
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import filetype
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.settings import Settings
from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import IMAGE_TYPES, make_thumbnail
from app.modules.attachments.models import Attachment
from app.modules.channels.models import Channel
from app.modules.emoji import service as emoji_service
from app.modules.emoji.models import CustomEmoji
from app.modules.importer import core
from app.modules.importer.core import (
    ChannelState,
    ImportFailed,
    Report,
    active_admin,
    channel_name,
    emoji_image,
    standard_glyph,
)
from app.modules.importer.core import shrink_emoji as _shrink_emoji
from app.modules.users.models import User

__all__ = [
    "ImportFailed",
    "MattermostImport",
    "Report",
    "_shrink_emoji",
    "channel_name",
    "import_mattermost",
    "read_dump",
    "standard_glyph",
]

SOURCE = "mattermost"
FORMAT_VERSION = 1
# client_msg_id and attachment ids derive from the Mattermost ids: a rerun lands on the same keys.
NAMESPACE = uuid.UUID("af747726-f112-4c34-a015-b2b5bf20fb99")

_CODE = re.compile(r"```.*?(?:```|\Z)|`[^`\n]*`", re.DOTALL)
_MENTION = re.compile(r"(?<![\w@])@([a-z0-9][a-z0-9._-]*)", re.IGNORECASE)
_SHORTCODE = re.compile(r"(?<!\w):([a-z0-9_+-]{1,64}):(?!\w)")


@dataclass
class Dump:
    meta: dict[str, Any]
    users: dict[str, dict[str, Any]]
    emoji: list[dict[str, Any]]
    channels: list[dict[str, Any]]
    path: Path

    def posts(self) -> Iterator[dict[str, Any]]:
        """Posts in creation order, streamed: the file can hold a hundred thousand of them."""
        with self.path.open(encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    record = json.loads(line)
                    if record.get("type") == "post":
                        yield record


def read_dump(path: Path) -> Dump:
    meta: dict[str, Any] | None = None
    users: dict[str, dict[str, Any]] = {}
    emoji: list[dict[str, Any]] = []
    chans: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as fh:
        for number, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ImportFailed(f"{path}:{number}: not JSON ({exc})") from exc
            kind = record.get("type")  # posts are read again, streamed, by Dump.posts
            if kind == "meta":
                meta = record
            elif kind == "user":
                users[record["id"]] = record
            elif kind == "emoji":
                emoji.append(record)
            elif kind == "channel":
                chans.append(record)
    if meta is None or meta.get("source") != SOURCE or meta.get("version") != FORMAT_VERSION:
        raise ImportFailed(f"{path}: not a mattermost-extract file (version {FORMAT_VERSION})")
    return Dump(meta=meta, users=users, emoji=emoji, channels=chans, path=path)


class MattermostImport(core.ImportJob):
    source = SOURCE
    source_label = "Mattermost"
    namespace = NAMESPACE
    name_suffix = "mm"

    def __init__(
        self,
        db: AsyncSession,
        dump: Dump,
        *,
        files_root: Path | None,
        user_map: dict[str, str],
        actor: User,
        blobs: BlobStore,
        settings: Settings,
        dry_run: bool,
        refresh_emoji: bool = False,
    ) -> None:
        super().__init__(
            db,
            users=dump.users,
            channel_records=dump.channels,
            user_map=user_map,
            actor=actor,
            blobs=blobs,
            settings=settings,
            dry_run=dry_run,
        )
        self.refresh_emoji = refresh_emoji
        self.dump = dump
        self.files_root = files_root.resolve() if files_root is not None else None

    def posts(self) -> Iterator[dict[str, Any]]:
        return self.dump.posts()

    async def channel_target_name(self, record: dict[str, Any]) -> str:
        """From the display name; a taken one becomes ``name-mm`` (warned)."""
        base = channel_name(record["display_name"] or record["name"])
        name, n = base, 1
        while (
            await self.db.execute(select(Channel.id).where(Channel.name == name))
        ).scalar_one_or_none() is not None:
            n += 1
            name = f"{base[:74]}-mm{n if n > 2 else ''}"
        if name != base:
            self.report.warn(f"#{base}: その名前は使用中なので #{name} として作成")
        return name

    # ---- custom emoji ------------------------------------------------------------------------

    async def _emoji(self) -> None:
        await super()._emoji()
        refs = await self._refs("emoji")
        for mm in self.dump.emoji:
            name = mm["name"].lower()
            if mm["id"] in refs and self.refresh_emoji:
                await self._refresh_emoji(mm, refs[mm["id"]])
                continue
            if mm["id"] in refs or name in self.custom_emoji:
                continue  # imported before, or ChikuwaChat already has one by that name
            if not emoji_service.NAME.match(name):
                self.report.warn(f":{mm['name']}: は ChikuwaChat の絵文字名にできないため未移行")
                continue
            raw = self._read_file(Path("emoji") / mm["id"] / "image", f":{name}:")
            if raw is None:
                continue
            emoji_id = await self._add_custom_emoji(name, raw, self._person_id(mm["creator_id"]))
            if emoji_id is not None:
                self._ref("emoji", mm["id"], emoji_id)

    async def _refresh_emoji(self, mm: dict[str, Any], target_id: uuid.UUID) -> None:
        """--refresh-emoji: an emoji imported before is read again from Mattermost, so one that was
        stored as its first frame gets its animation."""
        row = await self.db.get(CustomEmoji, target_id)
        raw = self._read_file(Path("emoji") / mm["id"] / "image", f":{mm['name']}:")
        if row is None or raw is None:
            return
        try:
            prepared = await emoji_image(raw, self.settings)
        except Exception as exc:
            self.report.warn(f":{row.name}: の画像を読めないため更新せず ({exc})")
            return
        if prepared is None:
            return
        data, width, height, content_type = prepared
        if content_type == row.content_type and len(data) == row.size_bytes:
            return
        if not self.dry_run:
            await self.blobs.put(row.storage_key, data, content_type)
        row.content_type, row.size_bytes, row.width, row.height = (
            content_type,
            len(data),
            width,
            height,
        )
        self.report.counts["emoji_refreshed"] += 1

    # ---- bodies ------------------------------------------------------------------------------

    def convert_body(self, text: str) -> str:
        """Mentions and emoji shortcodes, leaving code blocks and code spans as they are."""
        out: list[str] = []
        pos = 0
        for match in _CODE.finditer(text):
            out.append(self._convert_plain(text[pos : match.start()]))
            out.append(match.group(0))
            pos = match.end()
        out.append(self._convert_plain(text[pos:]))
        return "".join(out)

    def _convert_plain(self, text: str) -> str:
        return _SHORTCODE.sub(self._shortcode, _MENTION.sub(self._mention, text))

    def _mention(self, match: re.Match[str]) -> str:
        raw = match.group(1)
        if raw.lower() in ("channel", "all"):
            return "<!channel>"
        if raw.lower() == "here":
            return "<!here>"
        name, rest = raw, ""
        while name:
            person = self.by_source_name.get(name.lower())
            if person is not None:
                self.report.counts["mentions"] += 1
                return f"<@{person.id}>{rest}"
            if name[-1] not in "._-":
                break
            name, rest = name[:-1], name[-1] + rest  # "@bobmm." ends a sentence
        return match.group(0)

    def _shortcode(self, match: re.Match[str]) -> str:
        name = match.group(1)
        if name in self.custom_emoji:
            return match.group(0)
        return standard_glyph(name) or match.group(0)

    def finish_body(self, body: str, post: dict[str, Any], bound: list[Attachment]) -> str:
        if not body.strip() and not bound:
            return "📎 添付ファイルは移行できませんでした" if post["files"] else ""
        return body

    # ---- files -------------------------------------------------------------------------------

    def _file_path(self, relative: Path | str, label: str) -> Path | None:
        if self.files_root is None:
            self.report.counts["files_missing"] += 1
            return None
        path = (self.files_root / relative).resolve()
        if not path.is_relative_to(self.files_root) or not path.is_file():
            self.report.counts["files_missing"] += 1
            self.report.warn(f"{label}: ファイルが見つからない ({relative})")
            return None
        return path

    def _read_file(self, relative: Path | str, label: str) -> bytes | None:
        path = self._file_path(relative, label)
        return path.read_bytes() if path is not None else None

    async def _files(
        self,
        post: dict[str, Any],
        message_id: uuid.UUID,
        state: ChannelState,
        uploader_id: uuid.UUID,
        created_at: datetime,
    ) -> tuple[list[Attachment], list[str]]:
        bound: list[Attachment] = []
        for f in post["files"]:
            attachment = await self._attachment(f, message_id, state.id, uploader_id, created_at)
            if attachment is not None:
                bound.append(attachment)
        self.report.channel(state.label)["files"] += len(bound)
        return bound, []

    async def _attachment(
        self,
        f: dict[str, Any],
        message_id: uuid.UUID,
        channel_id: uuid.UUID,
        uploader_id: uuid.UUID,
        created_at: datetime,
    ) -> Attachment | None:
        path = self._file_path(f["path"], f"添付 {f['name']}")
        if path is None:
            return None
        attachment_id = uuid.uuid5(NAMESPACE, "file:" + f["id"])
        # A dry run checks that every file is there without reading 7 GB of them.
        data = path.read_bytes() if not self.dry_run else None
        with path.open("rb") as fh:
            head = fh.read(8192)
        kind = filetype.guess(head)
        content_type = kind.mime if kind is not None else "application/octet-stream"
        size = len(data) if data is not None else path.stat().st_size
        attachment = Attachment(
            id=attachment_id,
            uploader_id=uploader_id,
            message_id=message_id,
            channel_id=channel_id,
            status="attached",
            filename=attachments.sanitize_filename(f["name"]),
            content_type=content_type,
            size_bytes=size,
            sha256=hashlib.sha256(data).digest() if data is not None else None,
            storage_key=attachments.storage_key(attachment_id),
            created_at=created_at,
            attached_at=created_at,
        )
        if data is not None:
            if content_type in IMAGE_TYPES:
                try:
                    thumb, width, height = await run_in_threadpool(
                        make_thumbnail, data, self.settings.attachment_thumbnail_px
                    )
                    await self.blobs.put(
                        attachments.thumbnail_key(attachment_id), thumb, "image/jpeg"
                    )
                    attachment.width, attachment.height = width, height
                    attachment.thumbnail_key = attachments.thumbnail_key(attachment_id)
                except Exception as exc:  # stays a plain file, as an upload would
                    self.report.warn(f"添付 {f['name']}: サムネイルを作れない ({exc})")
            await self.blobs.put(attachment.storage_key, data, content_type)
        self._ref("file", f["id"], attachment_id)
        self.report.counts["files"] += 1
        self.report.counts["file_bytes"] += size
        if size > self.settings.attachment_max_bytes:
            self.report.counts["files_over_upload_limit"] += 1
        return attachment


async def import_mattermost(
    db: AsyncSession,
    dump_path: Path,
    *,
    files_root: Path | None,
    user_map: dict[str, str],
    actor_username: str,
    blobs: BlobStore,
    settings: Settings,
    dry_run: bool,
    refresh_emoji: bool = False,
) -> Report:
    dump = read_dump(dump_path)
    actor = await active_admin(db, actor_username)
    job = MattermostImport(
        db,
        dump,
        files_root=files_root,
        user_map=user_map,
        actor=actor,
        blobs=blobs,
        settings=settings,
        dry_run=dry_run,
        refresh_emoji=refresh_emoji,
    )
    return await job.run()
