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
"""

import hashlib
import io
import json
import logging
import re
import uuid
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import filetype
from PIL import Image
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.ids import uuid7, uuid7_at
from app.core.security import generate_temporary_password, hash_password
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.admin import service as admin
from app.modules.admin.schemas import EMAIL_PATTERN, AdminUserCreate
from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import IMAGE_TYPES, make_thumbnail
from app.modules.attachments.models import Attachment
from app.modules.channels import service as channels
from app.modules.channels.models import Channel, ChannelMember
from app.modules.emoji import service as emoji_service
from app.modules.emoji.models import CustomEmoji
from app.modules.groups import service as groups
from app.modules.importer.models import ImportRef
from app.modules.messages.mentions import extract_mentions
from app.modules.messages.models import Message, Reaction
from app.modules.messages.schemas import EMOJI_PATTERN
from app.modules.reads.models import ReadState
from app.modules.threads.models import ThreadFollow
from app.modules.users.events import USER_DEACTIVATED, emit_user_event
from app.modules.users.models import User

log = logging.getLogger("app.importer")

SOURCE = "mattermost"
FORMAT_VERSION = 1
# client_msg_id and attachment ids derive from the Mattermost ids: a rerun lands on the same keys.
NAMESPACE = uuid.UUID("af747726-f112-4c34-a015-b2b5bf20fb99")
BATCH = 1000  # posts per transaction
TOPIC_MAX = 250
EMOJI_THUMB_PX = 128

_CODE = re.compile(r"```.*?(?:```|\Z)|`[^`\n]*`", re.DOTALL)
_MENTION = re.compile(r"(?<![\w@])@([a-z0-9][a-z0-9._-]*)", re.IGNORECASE)
_SHORTCODE = re.compile(r"(?<!\w):([a-z0-9_+-]{1,64}):(?!\w)")
_REACTION = re.compile(EMOJI_PATTERN)
_CHANNEL_NAME_DROP = re.compile(r"[#@/]")
_WHITESPACE = re.compile(r"\s+")
_EMAIL = re.compile(EMAIL_PATTERN)
_USERNAME = re.compile(r"^[a-z0-9._-]{3,32}$")
_GLYPHS: dict[str, str] = json.loads(
    Path(__file__).with_name("emoji_names.json").read_text(encoding="utf-8")
)


def standard_glyph(name: str) -> str | None:
    """The glyph of a standard emoji name. Mattermost writes some names with hyphens and the
    person first (``woman-bowing``, ``rainbow-flag``) where the table has ``bowing_woman`` and
    ``rainbow_flag``."""
    underscored = name.replace("-", "_")
    candidates = [name, underscored]
    for person in ("woman", "man"):
        if underscored.startswith(person + "_"):
            candidates.append(f"{underscored[len(person) + 1 :]}_{person}")
    return next((_GLYPHS[c] for c in candidates if c in _GLYPHS), None)


class ImportFailed(Exception):
    """The dump or the options cannot be imported; nothing was committed by the failing step."""


@dataclass
class Report:
    dry_run: bool
    people: list[str] = field(default_factory=list)  # "@mm → @chikuwa (how)"
    counts: Counter[str] = field(default_factory=Counter)
    warnings: list[str] = field(default_factory=list)
    # Reaction names kept as ":name:" text with no image yet: a custom emoji of that name added
    # later (before or after the import) is shown for them.
    unmatched_emoji: Counter[str] = field(default_factory=Counter)
    # Reaction names that cannot be stored at all (not a valid reaction), with how often.
    dropped_emoji: Counter[str] = field(default_factory=Counter)

    def warn(self, message: str) -> None:
        self.warnings.append(message)
        log.warning("import: %s", message)


@dataclass
class Person:
    id: uuid.UUID
    username: str
    active: bool  # a member who can log in: memberships, follows and read state


@dataclass
class ChannelState:
    id: uuid.UUID
    last_seq: int
    last_message_at: datetime | None
    members: set[uuid.UUID]
    created: bool  # made by this run (announced at the end)
    touched: bool = False  # got posts in this run
    locked: bool = False  # the channel row is locked for the batch being built (see _lock)


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


def ms_to_datetime(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=UTC)


def channel_name(display_name: str) -> str:
    """A ChikuwaChat channel name (no whitespace, # @ or /, at most 80 characters)."""
    cleaned = _CHANNEL_NAME_DROP.sub("", _WHITESPACE.sub("-", display_name.strip()))
    return cleaned.strip("-")[:80] or "channel"


def _clip(text: str, limit: int) -> str | None:
    text = text.strip()
    if not text:
        return None
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _shrink_emoji(data: bytes, max_bytes: int) -> tuple[bytes, int, int, str]:
    """A too-large custom emoji made smaller: an animated one stays an animated GIF (testers,
    2026-09-29: imported GIFs did not move) at 128, 96 or 64 px, the first that fits `max_bytes`;
    otherwise, and for a still one, a 128 px PNG."""
    with Image.open(io.BytesIO(data)) as image:
        if getattr(image, "n_frames", 1) > 1:
            for side in (EMOJI_THUMB_PX, 96, 64):
                animated = _animated_gif(image, side)
                if animated is not None and len(animated[0]) <= max_bytes:
                    return (*animated, "image/gif")
            image.seek(0)
        image.thumbnail((EMOJI_THUMB_PX, EMOJI_THUMB_PX))
        canvas = image.convert("RGBA")
    out = io.BytesIO()
    canvas.save(out, format="PNG", optimize=True)
    return out.getvalue(), canvas.width, canvas.height, "image/png"


def _animated_gif(image: Image.Image, side: int) -> tuple[bytes, int, int] | None:
    frames: list[Image.Image] = []
    durations: list[int] = []
    for index in range(min(getattr(image, "n_frames", 1), 200)):
        image.seek(index)
        frame = image.convert("RGBA")
        frame.thumbnail((side, side))
        frames.append(frame)
        durations.append(int(image.info.get("duration", 100)) or 100)
    if len(frames) < 2:
        return None
    out = io.BytesIO()
    frames[0].save(
        out,
        format="GIF",
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        disposal=2,
        optimize=True,
    )
    return out.getvalue(), frames[0].width, frames[0].height


def _dimensions(data: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(data)) as image:
        return image.size


class MattermostImport:
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
        self.refresh_emoji = refresh_emoji
        self.db = db
        self.dump = dump
        self.files_root = files_root.resolve() if files_root is not None else None
        self.user_map = {k.lower().lstrip("@"): v.lower().lstrip("@") for k, v in user_map.items()}
        self.actor = actor
        self.blobs = blobs
        self.settings = settings
        self.report = Report(dry_run=dry_run)
        self.people: dict[str, Person] = {}  # Mattermost user id → account
        self.by_mm_name: dict[str, Person] = {}  # Mattermost username (lower) → account
        self.custom_emoji: set[str] = set()
        self.new_emoji: list[CustomEmoji] = []
        self.channels: dict[str, ChannelState] = {}  # Mattermost channel id → state
        self.post_refs: dict[str, uuid.UUID] = {}
        # Attachments and reactions of the batch: inserted once its messages are (the unit of
        # work does not order inserts by plain foreign keys).
        self.children: list[Attachment | Reaction] = []
        # Thread bookkeeping for the replies of this run, applied per batch / at the end.
        self.parent_bumps: dict[uuid.UUID, list[Any]] = {}  # parent → [replies, last_at, seq]
        self.participants: dict[uuid.UUID, set[uuid.UUID]] = {}

    @property
    def dry_run(self) -> bool:
        return self.report.dry_run

    async def run(self) -> Report:
        try:
            await self._people()
            await self._emoji()
            await self._commit()
            await self._channels()
            await self._commit()
            await self._posts()
            await self._threads_and_reads()
            await self._announce()
            await self._commit()
        except BaseException:
            await self.db.rollback()  # the last batch; the committed ones stay (a rerun resumes)
            raise
        if self.dry_run:
            await self.db.rollback()
        return self.report

    async def _commit(self) -> None:
        """A dry run keeps everything in one transaction and rolls it back at the end."""
        if self.dry_run:
            await self.db.flush()
        else:
            await self.db.commit()
        self.db.expunge_all()  # bounded memory over ~100k posts; we keep ids, not rows

    async def _refs(self, kind: str) -> dict[str, uuid.UUID]:
        rows = await self.db.execute(
            select(ImportRef.source_id, ImportRef.target_id).where(
                ImportRef.source == SOURCE, ImportRef.kind == kind
            )
        )
        return {source_id: target_id for source_id, target_id in rows.all()}

    def _ref(self, kind: str, source_id: str, target_id: uuid.UUID) -> None:
        self.db.add(ImportRef(source=SOURCE, kind=kind, source_id=source_id, target_id=target_id))

    # ---- people ------------------------------------------------------------------------------

    async def _people(self) -> None:
        by_name = {u["username"].lower(): u for u in self.dump.users.values()}
        for mm_name in self.user_map:
            if mm_name not in by_name:
                raise ImportFailed(f"--user {mm_name}=…: no such Mattermost user in the file")
        # Only people with something to show get a new account: members who never posted or
        # reacted are left out, and so are people who are only mentioned.
        needed: set[str] = set()
        for post in self.dump.posts():
            needed.add(post["user_id"])
            needed.update(r["user_id"] for r in post["reactions"])
        refs = await self._refs("user")
        for mm in sorted(self.dump.users.values(), key=lambda u: u["username"].lower()):
            mm_name = mm["username"].lower()
            user, how = await self._existing_account(mm, refs)
            if user is None:
                if mm["id"] not in needed:
                    continue
                user = await self._new_account(mm)
                how = "新規 bot" if mm["is_bot"] else "新規 (無効化済み)"
                self.report.counts["users_created"] += 1
            else:
                self.report.counts["users_mapped"] += 1
            if mm["id"] not in refs:
                self._ref("user", mm["id"], user.id)
            person = Person(user.id, user.username, user.is_active and user.role != "bot")
            self.people[mm["id"]] = person
            self.by_mm_name[mm_name] = person
            self.report.people.append(f"@{mm['username']} → @{user.username} ({how})")

    async def _existing_account(
        self, mm: dict[str, Any], refs: dict[str, uuid.UUID]
    ) -> tuple[User | None, str]:
        target = self.user_map.get(mm["username"].lower())
        earlier = refs.get(mm["id"])
        if target is not None:
            user = await self._user_by_name(target)
            if user is None:
                raise ImportFailed(
                    f"--user {mm['username']}={target}: no ChikuwaChat user {target}"
                )
            if earlier is not None and earlier != user.id:
                raise ImportFailed(
                    f"--user {mm['username']}={target}: an earlier run imported "
                    f"@{mm['username']} as another account"
                )
            return user, "--user"
        if earlier is not None:
            user = await self.db.get(User, earlier)
            if user is None:
                raise ImportFailed(f"@{mm['username']}: imported before, now gone")
            return user, "前回の移行"
        if mm["email"]:
            user = (
                await self.db.execute(select(User).where(User.email == mm["email"]))
            ).scalar_one_or_none()
            if user is not None:
                return user, "メールアドレス一致"
        return None, ""

    async def _user_by_name(self, username: str) -> User | None:
        return (
            await self.db.execute(select(User).where(User.username == username))
        ).scalar_one_or_none()

    async def _free_username(self, wanted: str) -> str:
        base = wanted.lower() if _USERNAME.match(wanted.lower()) else "mm-user"
        candidate, n = base, 1
        while await self._user_by_name(candidate) is not None or await groups.name_in_use(
            self.db, candidate
        ):
            n += 1
            candidate = f"{base[:26]}-mm{n if n > 2 else ''}"
        return candidate

    async def _new_account(self, mm: dict[str, Any]) -> User:
        username = await self._free_username(mm["username"])
        if username != mm["username"].lower():
            self.report.warn(
                f"@{mm['username']}: その名前は使用中なので @{username} として作成 "
                f"(同じ人なら --user {mm['username']}=<ユーザー名> を指定)"
            )
        full_name = f"{mm['first_name']} {mm['last_name']}".strip()
        display_name = (mm["nickname"] or full_name or mm["username"])[:80]
        if mm["is_bot"]:
            return await admin.create_bot_in_tx(
                self.db, actor_id=self.actor.id, username=username, display_name=display_name
            )
        email = mm["email"] if mm["email"] and _EMAIL.match(mm["email"]) else None
        user = await admin.create_user_in_tx(
            self.db,
            AdminUserCreate(username=username, display_name=display_name, email=email),
            password_hash=await hash_password(generate_temporary_password(32)),
            must_change_password=True,
            actor_id=self.actor.id,
            details={"source": SOURCE},
        )
        user.title = _clip(mm["position"], 80)
        user.deactivated_at = utcnow()
        await self.db.flush()
        await emit_user_event(self.db, USER_DEACTIVATED, user)
        return user

    # ---- custom emoji ------------------------------------------------------------------------

    async def _emoji(self) -> None:
        self.custom_emoji = set((await self.db.execute(select(CustomEmoji.name))).scalars().all())
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
            data: bytes = raw
            kind = filetype.guess(data[:8192])
            content_type = kind.mime if kind is not None else ""
            if content_type not in IMAGE_TYPES:
                self.report.warn(f":{name}: の画像を読めないため未移行")
                continue
            try:
                width, height = await run_in_threadpool(_dimensions, data)
                if (
                    max(width, height) > emoji_service.MAX_PIXELS
                    or len(data) > self.settings.emoji_max_bytes
                ):
                    data, width, height, content_type = await run_in_threadpool(
                        _shrink_emoji, data, self.settings.emoji_max_bytes
                    )
            except Exception as exc:
                self.report.warn(f":{name}: の画像を読めないため未移行 ({exc})")
                continue
            row = CustomEmoji(
                id=uuid7(),
                name=name,
                created_by=self._person_id(mm["creator_id"]),
                content_type=content_type,
                size_bytes=len(data),
                width=width,
                height=height,
                storage_key="",
            )
            row.storage_key = emoji_service.storage_key(row.id)
            if not self.dry_run:
                await self.blobs.put(row.storage_key, data, content_type)
            self.db.add(row)
            self._ref("emoji", mm["id"], row.id)
            self.new_emoji.append(row)
            self.custom_emoji.add(name)
            self.report.counts["emoji_created"] += 1

    async def _refresh_emoji(self, mm: dict[str, Any], target_id: uuid.UUID) -> None:
        """--refresh-emoji: an emoji imported before is read again from Mattermost, so one that was
        stored as its first frame gets its animation."""
        row = await self.db.get(CustomEmoji, target_id)
        raw = self._read_file(Path("emoji") / mm["id"] / "image", f":{mm['name']}:")
        if row is None or raw is None:
            return
        data: bytes = raw
        kind = filetype.guess(data[:8192])
        content_type = kind.mime if kind is not None else ""
        if content_type not in IMAGE_TYPES:
            return
        try:
            width, height = await run_in_threadpool(_dimensions, data)
            if (
                max(width, height) > emoji_service.MAX_PIXELS
                or len(data) > self.settings.emoji_max_bytes
            ):
                data, width, height, content_type = await run_in_threadpool(
                    _shrink_emoji, data, self.settings.emoji_max_bytes
                )
        except Exception as exc:
            self.report.warn(f":{row.name}: の画像を読めないため更新せず ({exc})")
            return
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

    def _person_id(self, mm_user_id: str | None) -> uuid.UUID:
        person = self.people.get(mm_user_id or "")
        return person.id if person is not None else self.actor.id

    # ---- channels ----------------------------------------------------------------------------

    async def _channels(self) -> None:
        refs = await self._refs("channel")
        for mm in self.dump.channels:
            members = {
                self.people[m["user_id"]].id: m["admin"] or m["user_id"] == mm["creator_id"]
                for m in mm["members"]
                if m["user_id"] in self.people and self.people[m["user_id"]].active
            }
            earlier = refs.get(mm["id"])
            if earlier is not None:
                channel = await self.db.get(Channel, earlier)
                if channel is None:
                    raise ImportFailed(f"channel {mm['display_name']}: imported before, now gone")
                created = False
            else:
                channel = await self._new_channel(mm)
                if mm["private"] and not members:
                    # Nobody left who can open it: the importing administrator keeps it.
                    members[self.actor.id] = True
                created = True
            existing = set(
                (
                    await self.db.execute(
                        select(ChannelMember.user_id).where(ChannelMember.channel_id == channel.id)
                    )
                )
                .scalars()
                .all()
            )
            for user_id, owner in members.items():
                if user_id not in existing:
                    self.db.add(
                        ChannelMember(
                            channel_id=channel.id,
                            user_id=user_id,
                            role="owner" if owner else "member",
                        )
                    )
            self.channels[mm["id"]] = ChannelState(
                id=channel.id,
                last_seq=channel.last_seq,
                last_message_at=channel.last_message_at,
                members=existing | set(members),
                created=created,
            )

    async def _new_channel(self, mm: dict[str, Any]) -> Channel:
        base = channel_name(mm["display_name"] or mm["name"])
        name, n = base, 1
        while (
            await self.db.execute(select(Channel.id).where(Channel.name == name))
        ).scalar_one_or_none() is not None:
            n += 1
            name = f"{base[:74]}-mm{n if n > 2 else ''}"
        if name != base:
            self.report.warn(f"#{base}: その名前は使用中なので #{name} として作成")
        created_at = ms_to_datetime(mm["create_at"])
        channel = Channel(
            id=uuid7_at(mm["create_at"]),
            type="private" if mm["private"] else "public",
            name=name,
            topic=_clip(mm["header"], TOPIC_MAX),
            purpose=_clip(mm["purpose"], TOPIC_MAX),
            created_by=self._person_id(mm["creator_id"]),
            created_at=created_at,
            updated_at=created_at,
            archived_at=ms_to_datetime(mm["delete_at"]) if mm["delete_at"] else None,
        )
        self.db.add(channel)
        await self.db.flush()
        self._ref("channel", mm["id"], channel.id)
        self.report.counts["channels_created"] += 1
        if channel.archived_at is not None:
            self.report.counts["channels_archived"] += 1
        return channel

    # ---- posts -------------------------------------------------------------------------------

    async def _posts(self) -> None:
        self.post_refs = await self._refs("post")
        pending = 0
        for post in self.dump.posts():
            if post["id"] in self.post_refs:
                self.report.counts["posts_skipped_existing"] += 1
                continue
            state = self.channels.get(post["channel_id"])
            sender = self.people.get(post["user_id"])
            if state is None or sender is None:
                self.report.warn(f"post {post['id']}: チャンネルか投稿者が不明なため未移行")
                continue
            await self._post(post, state, sender)
            pending += 1
            if pending >= BATCH:
                await self._flush_posts()
                pending = 0
        await self._flush_posts()

    async def _lock(self, state: ChannelState) -> None:
        """The channel row is locked for the rest of the batch, as `allocate_seq` locks it for a
        post, and the seq continues from what the row says under the lock: a rerun while someone
        posts must neither hand out a seq twice nor write an older `last_seq` back."""
        if state.locked:
            return
        row = (
            await self.db.execute(
                select(Channel.last_seq, Channel.last_message_at)
                .where(Channel.id == state.id)
                .with_for_update()
            )
        ).one()
        state.last_seq, state.last_message_at = int(row[0]), row[1]
        state.locked = True

    async def _post(self, post: dict[str, Any], state: ChannelState, sender: Person) -> None:
        parent_id: uuid.UUID | None = None
        if post["root_id"]:
            parent_id = self.post_refs.get(post["root_id"])
            if parent_id is None:
                self.report.warn(f"post {post['id']}: スレッドの親が無いのでチャンネルに投稿")
        await self._lock(state)
        seq = state.last_seq + 1
        created_at = ms_to_datetime(post["create_at"])
        message_id = uuid7_at(post["create_at"])
        body = self.convert_body(post["message"])
        bound: list[Attachment] = []
        for f in post["files"]:
            attachment = await self._attachment(f, message_id, state.id, sender.id, created_at)
            if attachment is not None:
                bound.append(attachment)
        if not body.strip() and not bound:
            body = "📎 添付ファイルは移行できませんでした" if post["files"] else ""
        mentioned, mention_all = extract_mentions(body)
        self.db.add(
            Message(
                id=message_id,
                channel_id=state.id,
                sender_id=sender.id,
                parent_id=parent_id,
                seq=seq,
                updated_seq=seq,
                client_msg_id=uuid.uuid5(NAMESPACE, "post:" + post["id"]),
                body=body,
                mentioned_user_ids=mentioned,
                mention_all=mention_all,
                created_at=created_at,
                edited_at=ms_to_datetime(post["edit_at"]) if post["edit_at"] else None,
                pinned_at=created_at if post["pinned"] else None,
                pinned_by=sender.id if post["pinned"] else None,
            )
        )
        self.children.extend(bound)
        self._ref("post", post["id"], message_id)
        self.post_refs[post["id"]] = message_id
        self._reactions(post, message_id)
        if parent_id is not None:
            bump = self.parent_bumps.setdefault(parent_id, [0, created_at, seq])
            bump[0] += 1
            bump[1] = max(bump[1], created_at)
            bump[2] = seq
            self.participants.setdefault(parent_id, set()).add(sender.id)
            self.report.counts["replies"] += 1
        state.last_seq = seq
        if state.last_message_at is None or created_at > state.last_message_at:
            state.last_message_at = created_at
        state.touched = True
        self.report.counts["posts"] += 1
        if post["pinned"]:
            self.report.counts["pins"] += 1

    async def _flush_posts(self) -> None:
        """Parents' reply counters and the channels' seq go with the batch's posts, atomically."""
        await self.db.flush()
        self.db.add_all(self.children)
        self.children.clear()
        await self.db.flush()
        for parent_id, (replies, last_at, seq) in self.parent_bumps.items():
            await self.db.execute(
                update(Message)
                .where(Message.id == parent_id)
                .values(
                    reply_count=Message.reply_count + replies,
                    last_reply_at=func.greatest(
                        func.coalesce(Message.last_reply_at, last_at), last_at
                    ),
                    updated_seq=func.greatest(Message.updated_seq, seq),
                )
                .execution_options(synchronize_session=False)
            )
        self.parent_bumps.clear()
        for state in self.channels.values():
            if state.touched:
                await self.db.execute(
                    update(Channel)
                    .where(Channel.id == state.id)
                    .values(last_seq=state.last_seq, last_message_at=state.last_message_at)
                    .execution_options(synchronize_session=False)
                )
        await self._commit()
        if not self.dry_run:  # the commit released the row locks (a dry run keeps them)
            for state in self.channels.values():
                state.locked = False

    def _reactions(self, post: dict[str, Any], message_id: uuid.UUID) -> None:
        seen: set[tuple[uuid.UUID, str]] = set()
        for r in post["reactions"]:
            person = self.people.get(r["user_id"])
            emoji = self.reaction_emoji(r["emoji_name"])
            if emoji is None:
                self.report.dropped_emoji[r["emoji_name"]] += 1
            if person is None or emoji is None or (person.id, emoji) in seen:
                self.report.counts["reactions_skipped"] += 1
                continue
            if emoji.startswith(":") and emoji[1:-1] not in self.custom_emoji:
                self.report.unmatched_emoji[emoji[1:-1]] += 1
            seen.add((person.id, emoji))
            self.children.append(
                Reaction(
                    message_id=message_id,
                    user_id=person.id,
                    emoji=emoji,
                    created_at=ms_to_datetime(r["create_at"]),
                )
            )
            self.report.counts["reactions"] += 1

    def reaction_emoji(self, mm_name: str) -> str | None:
        """A custom emoji stays ``:name:``; a standard one becomes its glyph, as clients send it."""
        name = mm_name.lower()
        glyph = standard_glyph(name)
        if name not in self.custom_emoji and glyph is not None and _REACTION.match(glyph):
            return glyph
        token = f":{name}:"
        return token if _REACTION.match(token) else None

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
            person = self.by_mm_name.get(name.lower())
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

    # ---- threads, read state, events ---------------------------------------------------------

    async def _threads_and_reads(self) -> None:
        """Participants follow their threads and every member has read everything imported."""
        now = utcnow()
        members_of = {state.id: state.members for state in self.channels.values()}
        parents = list(self.participants)
        for start in range(0, len(parents), BATCH):
            chunk = parents[start : start + BATCH]
            rows = await self.db.execute(
                select(
                    Message.id, Message.sender_id, Message.channel_id, Message.updated_seq
                ).where(Message.id.in_(chunk))
            )
            follows: list[dict[str, Any]] = []
            for parent_id, root_sender, channel_id, updated_seq in rows.all():
                for user_id in self.participants[parent_id] | {root_sender}:
                    if user_id in members_of.get(channel_id, set()):
                        follows.append(
                            {
                                "parent_id": parent_id,
                                "user_id": user_id,
                                "following": True,
                                "last_read_seq": updated_seq,
                                "created_at": now,
                                "updated_at": now,
                            }
                        )
            # A few thousand rows per statement: asyncpg takes at most 32767 parameters.
            for rows_start in range(0, len(follows), BATCH):
                stmt = insert(ThreadFollow).values(follows[rows_start : rows_start + BATCH])
                await self.db.execute(
                    stmt.on_conflict_do_update(
                        index_elements=[ThreadFollow.parent_id, ThreadFollow.user_id],
                        set_={
                            "last_read_seq": func.greatest(
                                ThreadFollow.last_read_seq, stmt.excluded.last_read_seq
                            ),
                            "updated_at": now,
                        },
                    )
                )
            self.report.counts["thread_follows"] += len(follows)
        reads = [
            {
                "user_id": user_id,
                "channel_id": state.id,
                "last_read_seq": state.last_seq,
                "updated_at": now,
            }
            for state in self.channels.values()
            if state.touched or state.created
            for user_id in state.members
        ]
        for start in range(0, len(reads), BATCH):
            read_stmt = insert(ReadState).values(reads[start : start + BATCH])
            await self.db.execute(
                read_stmt.on_conflict_do_update(
                    index_elements=[ReadState.user_id, ReadState.channel_id],
                    set_={
                        "last_read_seq": func.greatest(
                            ReadState.last_read_seq, read_stmt.excluded.last_read_seq
                        ),
                        "updated_at": now,
                    },
                )
            )

    async def _announce(self) -> None:
        """channel.created (with the final seq) and emoji.updated, as the API would send them."""
        for state in self.channels.values():
            if state.created:
                channel = await self.db.get(Channel, state.id)
                assert channel is not None
                await channels.announce_created_in_tx(self.db, channel)
        for row in self.new_emoji:
            emoji = await self.db.get(CustomEmoji, row.id)
            assert emoji is not None
            await emoji_service.announce_created_in_tx(self.db, emoji)


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
    actor = (
        await db.execute(select(User).where(User.username == actor_username))
    ).scalar_one_or_none()
    if actor is None or not actor.is_admin or not actor.is_active:
        raise ImportFailed(f"--actor {actor_username}: not an active administrator")
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
