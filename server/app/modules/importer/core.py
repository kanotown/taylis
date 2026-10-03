"""What every import shares (M18, M87): people, channels, posts, threads, read state.

An importer (Mattermost, Slack) turns its source into plain records and subclasses ``ImportJob``:

- user: ``id``, ``username``, ``email``, ``first_name``, ``last_name``, ``nickname``,
  ``position``, ``is_bot``
- channel: ``id``, ``name``, ``display_name``, ``private`` (or ``channel_type``: public,
  private, dm, group_dm), ``header``, ``purpose``, ``creator_id``, ``create_at``, ``delete_at`` and
  ``members`` (``user_id``, ``admin``)
- post: ``id``, ``channel_id``, ``user_id``, ``root_id``, ``message``, ``create_at``,
  ``edit_at``, ``pinned``, ``files``, ``reactions`` (``user_id``, ``emoji_name``,
  ``create_at``) and optionally ``also_in_channel``

Times are integers in the unit the subclass reads with ``to_datetime`` / ``to_ms`` (epoch
milliseconds unless it says otherwise). Every row made is recorded in import_refs under the
subclass's ``source``, so a second run skips what exists and appends only newer posts. Imported
messages count as read for every member; no message events and no pushes are sent.
"""

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
from typing import Any, ClassVar

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
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import IMAGE_TYPES
from app.modules.attachments.models import Attachment
from app.modules.channels import service as channels
from app.modules.channels.models import DM_TYPES, Channel, ChannelMember
from app.modules.emoji import service as emoji_service
from app.modules.emoji.models import CustomEmoji
from app.modules.groups import service as groups
from app.modules.importer.models import ImportRef
from app.modules.messages import repository as message_repo
from app.modules.messages.mentions import extract_mentions
from app.modules.messages.models import Message, Reaction
from app.modules.messages.schemas import EMOJI_PATTERN
from app.modules.reads.models import ReadState
from app.modules.threads.models import ThreadFollow
from app.modules.users.events import USER_DEACTIVATED, emit_user_event
from app.modules.users.models import User

log = logging.getLogger("app.importer")

BATCH = 1000  # posts per transaction
TOPIC_MAX = 250
EMOJI_THUMB_PX = 128

REACTION = re.compile(EMOJI_PATTERN)
_CHANNEL_NAME_DROP = re.compile(r"[#@/]")
_WHITESPACE = re.compile(r"\s+")
_EMAIL = re.compile(EMAIL_PATTERN)
USERNAME = re.compile(r"^[a-z0-9._-]{3,32}$")
_GLYPHS: dict[str, str] = json.loads(
    Path(__file__).with_name("emoji_names.json").read_text(encoding="utf-8")
)


def standard_glyph(name: str) -> str | None:
    """The glyph of a standard emoji name. Mattermost and Slack write some names with hyphens and
    the person first (``woman-bowing``, ``rainbow-flag``) where the table has ``bowing_woman``
    and ``rainbow_flag``."""
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
    people: list[str] = field(default_factory=list)  # "@source → @chikuwa (how)"
    counts: Counter[str] = field(default_factory=Counter)
    warnings: list[str] = field(default_factory=list)
    # Reaction names kept as ":name:" text with no image yet: a custom emoji of that name added
    # later (before or after the import) is shown for them.
    unmatched_emoji: Counter[str] = field(default_factory=Counter)
    # Reaction names that cannot be stored at all (not a valid reaction), with how often.
    dropped_emoji: Counter[str] = field(default_factory=Counter)
    # Per channel (its ChikuwaChat name): posts, replies, files, files_failed.
    channels: dict[str, Counter[str]] = field(default_factory=dict)
    # Source people who got a new account (deactivated, or a bot): nobody was mapped to them.
    unmapped: list[str] = field(default_factory=list)
    # Files that could not be brought over, one line each ("#channel name: why").
    failed_files: list[str] = field(default_factory=list)

    def warn(self, message: str) -> None:
        self.warnings.append(message)
        log.warning("import: %s", message)

    def channel(self, label: str) -> Counter[str]:
        return self.channels.setdefault(label, Counter())


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
    label: str = ""  # its name in the report
    touched: bool = False  # got posts in this run (the whole import: read states at the end)
    locked: bool = False  # the channel row is locked for the batch being built (see _lock)
    # Got posts in the batch being built: only these rows are written by _flush_posts, which
    # resets the flag on commit. Review v0.1.22 #2: a channel touched by an earlier batch is not
    # rewritten from stale values after normal posts moved it on between batches.
    in_batch: bool = False


def ms_to_datetime(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=UTC)


def channel_name(display_name: str) -> str:
    """A ChikuwaChat channel name (no whitespace, # @ or /, at most 80 characters)."""
    cleaned = _CHANNEL_NAME_DROP.sub("", _WHITESPACE.sub("-", display_name.strip()))
    return cleaned.strip("-")[:80] or "channel"


def clip(text: str, limit: int) -> str | None:
    text = text.strip()
    if not text:
        return None
    return text if len(text) <= limit else text[: limit - 1] + "…"


def shrink_emoji(data: bytes, max_bytes: int) -> tuple[bytes, int, int, str]:
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


async def emoji_image(data: bytes, settings: Settings) -> tuple[bytes, int, int, str] | None:
    """(bytes, width, height, content type) of a custom emoji image as the upload would take it,
    made smaller when it is too large; None when it is not a readable image. Raises on a broken
    image (the caller warns)."""
    kind = filetype.guess(data[:8192])
    content_type = kind.mime if kind is not None else ""
    if content_type not in IMAGE_TYPES:
        return None
    width, height = await run_in_threadpool(_dimensions, data)
    if max(width, height) > emoji_service.MAX_PIXELS or len(data) > settings.emoji_max_bytes:
        return await run_in_threadpool(shrink_emoji, data, settings.emoji_max_bytes)
    return data, width, height, content_type


class ImportJob:
    """The shared steps; a subclass supplies the records and how bodies and files convert."""

    source: ClassVar[str]  # import_refs.source
    source_label: ClassVar[str]  # in messages ("Mattermost", "Slack")
    namespace: ClassVar[uuid.UUID]  # client_msg_id and attachment ids derive from source ids
    name_suffix: ClassVar[str]  # a taken username becomes "name-<suffix>"

    def __init__(
        self,
        db: AsyncSession,
        *,
        users: dict[str, dict[str, Any]],
        channel_records: list[dict[str, Any]],
        user_map: dict[str, str],
        actor: User,
        blobs: BlobStore,
        settings: Settings,
        dry_run: bool,
    ) -> None:
        self.db = db
        self.users = users
        self.channel_records = channel_records
        self.user_map = {k.lower().lstrip("@"): v.lower().lstrip("@") for k, v in user_map.items()}
        self.actor = actor
        self.blobs = blobs
        self.settings = settings
        self.report = Report(dry_run=dry_run)
        self.people: dict[str, Person] = {}  # source user id → account
        self.by_source_name: dict[str, Person] = {}  # source username (lower) → account
        self.custom_emoji: set[str] = set()
        self.new_emoji: list[CustomEmoji] = []
        self.channels: dict[str, ChannelState] = {}  # source channel id → state
        self.post_refs: dict[str, uuid.UUID] = {}
        # Attachments and reactions of the batch: inserted once its messages are (the unit of
        # work does not order inserts by plain foreign keys).
        self.children: list[Attachment | Reaction] = []
        # Thread bookkeeping for the replies of this run, applied per batch / at the end.
        self.parent_bumps: dict[uuid.UUID, list[Any]] = {}  # parent → [replies, last_at, seq]
        self.participants: dict[uuid.UUID, set[uuid.UUID]] = {}

    # ---- what a subclass provides ------------------------------------------------------------

    def posts(self) -> Iterator[dict[str, Any]]:
        """Posts in creation order (per channel at least; a thread's root before its replies)."""
        raise NotImplementedError

    def user_keys(self, record: dict[str, Any]) -> list[str]:
        """The names `--user NAME=…` may use for this person (lower case)."""
        return [record["username"].lower()]

    def needed_user_ids(self) -> set[str]:
        """People who get an account when nobody is mapped to them: posters and reactors."""
        needed: set[str] = set()
        for post in self.posts():
            needed.add(post["user_id"])
            needed.update(r["user_id"] for r in post["reactions"])
        return needed

    async def _emoji(self) -> None:
        """Custom emoji the posts use (before the posts, so reactions find them)."""
        self.custom_emoji = set((await self.db.execute(select(CustomEmoji.name))).scalars().all())

    def convert_body(self, text: str) -> str:
        return text

    async def _files(
        self,
        post: dict[str, Any],
        message_id: uuid.UUID,
        state: ChannelState,
        uploader_id: uuid.UUID,
        created_at: datetime,
    ) -> tuple[list[Attachment], list[str]]:
        """The post's attachments, and lines to add to its body (files that did not come)."""
        return [], []

    def finish_body(self, body: str, post: dict[str, Any], bound: list[Attachment]) -> str:
        return body

    async def channel_target_name(self, record: dict[str, Any]) -> str:
        """The new channel's name; it must be free."""
        raise NotImplementedError

    def to_datetime(self, value: int) -> datetime:
        return ms_to_datetime(value)

    def to_ms(self, value: int) -> int:
        return value

    # ---- the run -----------------------------------------------------------------------------

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
                ImportRef.source == self.source, ImportRef.kind == kind
            )
        )
        return {source_id: target_id for source_id, target_id in rows.all()}

    def _ref(self, kind: str, source_id: str, target_id: uuid.UUID) -> None:
        self.db.add(
            ImportRef(source=self.source, kind=kind, source_id=source_id, target_id=target_id)
        )

    # ---- people ------------------------------------------------------------------------------

    def _check_user_map(self) -> None:
        owners: dict[str, set[str]] = {}
        for record in self.users.values():
            for key in self.user_keys(record):
                owners.setdefault(key, set()).add(record["id"])
        for name in self.user_map:
            if name not in owners:
                raise ImportFailed(f"--user {name}=…: no such {self.source_label} user in the file")
            if len(owners[name]) > 1:
                raise ImportFailed(
                    f"--user {name}=…: several {self.source_label} users have that name; "
                    "give the user id"
                )

    def _mapped_target(self, record: dict[str, Any]) -> str | None:
        return next((self.user_map[k] for k in self.user_keys(record) if k in self.user_map), None)

    async def _people(self) -> None:
        self._check_user_map()
        # Only people with something to show get a new account: members who never posted or
        # reacted are left out, and so are people who are only mentioned.
        needed = self.needed_user_ids()
        refs = await self._refs("user")
        for record in sorted(self.users.values(), key=lambda u: u["username"].lower()):
            user, how = await self._existing_account(record, refs)
            if user is None:
                if record["id"] not in needed:
                    continue
                user = await self._new_account(record)
                how = "新規 bot" if record["is_bot"] else "新規 (無効化済み)"
                self.report.counts["users_created"] += 1
                self.report.unmapped.append(f"@{record['username']} → @{user.username} ({how})")
            else:
                self.report.counts["users_mapped"] += 1
            if record["id"] not in refs:
                self._ref("user", record["id"], user.id)
            person = Person(user.id, user.username, user.is_active and user.role != "bot")
            self.people[record["id"]] = person
            self.by_source_name[record["username"].lower()] = person
            self.report.people.append(f"@{record['username']} → @{user.username} ({how})")

    async def _existing_account(
        self, record: dict[str, Any], refs: dict[str, uuid.UUID]
    ) -> tuple[User | None, str]:
        target = self._mapped_target(record)
        earlier = refs.get(record["id"])
        if target is not None:
            user = await self._user_by_name(target)
            if user is None:
                raise ImportFailed(
                    f"--user {record['username']}={target}: no ChikuwaChat user {target}"
                )
            if earlier is not None and earlier != user.id:
                raise ImportFailed(
                    f"--user {record['username']}={target}: an earlier run imported "
                    f"@{record['username']} as another account"
                )
            return user, "--user"
        if earlier is not None:
            user = await self.db.get(User, earlier)
            if user is None:
                raise ImportFailed(f"@{record['username']}: imported before, now gone")
            return user, "前回の移行"
        if record["email"]:
            user = (
                await self.db.execute(select(User).where(User.email == record["email"]))
            ).scalar_one_or_none()
            if user is not None:
                return user, "メールアドレス一致"
        return None, ""

    async def _user_by_name(self, username: str) -> User | None:
        return (
            await self.db.execute(select(User).where(User.username == username))
        ).scalar_one_or_none()

    async def _free_username(self, wanted: str) -> str:
        suffix = self.name_suffix
        base = wanted.lower() if USERNAME.match(wanted.lower()) else f"{suffix}-user"
        candidate, n = base, 1
        while await self._user_by_name(candidate) is not None or await groups.name_in_use(
            self.db, candidate
        ):
            n += 1
            candidate = f"{base[: 29 - len(suffix)]}-{suffix}{n if n > 2 else ''}"
        return candidate

    async def _new_account(self, record: dict[str, Any]) -> User:
        username = await self._free_username(record["username"])
        if username != record["username"].lower():
            self.report.warn(
                f"@{record['username']}: その名前は使用中なので @{username} として作成 "
                f"(同じ人なら --user {record['username']}=<ユーザー名> を指定)"
            )
        full_name = f"{record['first_name']} {record['last_name']}".strip()
        display_name = (record["nickname"] or full_name or record["username"])[:80]
        if record["is_bot"]:
            return await admin.create_bot_in_tx(
                self.db, actor_id=self.actor.id, username=username, display_name=display_name
            )
        email = record["email"] if record["email"] and _EMAIL.match(record["email"]) else None
        user = await admin.create_user_in_tx(
            self.db,
            AdminUserCreate(username=username, display_name=display_name, email=email),
            password_hash=await hash_password(generate_temporary_password(32)),
            must_change_password=True,
            actor_id=self.actor.id,
            details={"source": self.source},
        )
        user.title = clip(record["position"], 80)
        user.deactivated_at = utcnow()
        await self.db.flush()
        await emit_user_event(self.db, USER_DEACTIVATED, user)
        return user

    def _person_id(self, source_user_id: str | None) -> uuid.UUID:
        person = self.people.get(source_user_id or "")
        return person.id if person is not None else self.actor.id

    async def _add_custom_emoji(
        self, name: str, data: bytes, creator_id: uuid.UUID
    ) -> uuid.UUID | None:
        """A custom emoji from an image (made smaller like the upload would); None when the
        image cannot be read (warned)."""
        try:
            prepared = await emoji_image(data, self.settings)
        except Exception as exc:
            self.report.warn(f":{name}: の画像を読めないため未移行 ({exc})")
            return None
        if prepared is None:
            self.report.warn(f":{name}: の画像を読めないため未移行")
            return None
        data, width, height, content_type = prepared
        row = CustomEmoji(
            id=uuid7(),
            name=name,
            created_by=creator_id,
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
        self.new_emoji.append(row)
        self.custom_emoji.add(name)
        self.report.counts["emoji_created"] += 1
        return row.id

    # ---- channels ----------------------------------------------------------------------------

    def _channel_type(self, record: dict[str, Any]) -> str:
        return str(record.get("channel_type") or ("private" if record["private"] else "public"))

    async def _channels(self) -> None:
        refs = await self._refs("channel")
        for record in self.channel_records:
            kind = self._channel_type(record)
            if kind in DM_TYPES:
                await self._dm_channel(record, kind, refs)
                continue
            members = {
                self.people[m["user_id"]].id: m["admin"] or m["user_id"] == record["creator_id"]
                for m in record["members"]
                if m["user_id"] in self.people and self.people[m["user_id"]].active
            }
            earlier = refs.get(record["id"])
            if earlier is not None:
                channel = await self.db.get(Channel, earlier)
                if channel is None:
                    raise ImportFailed(
                        f"channel {record['display_name']}: imported before, now gone"
                    )
                created = False
            else:
                channel = await self._new_channel(record, kind)
                if kind == "private" and not members:
                    # Nobody left who can open it: the importing administrator keeps it.
                    members[self.actor.id] = True
                created = True
            await self._add_members(channel, record, members, created)

    async def _add_members(
        self,
        channel: Channel,
        record: dict[str, Any],
        members: dict[uuid.UUID, bool],
        created: bool,
    ) -> None:
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
        self.channels[record["id"]] = ChannelState(
            id=channel.id,
            last_seq=channel.last_seq,
            last_message_at=channel.last_message_at,
            members=existing | set(members),
            created=created,
            label=f"#{channel.name}" if channel.name else f"DM {record['display_name']}",
        )

    async def _dm_channel(
        self, record: dict[str, Any], kind: str, refs: dict[str, uuid.UUID]
    ) -> None:
        """A DM or group DM between the accounts its members map to (deactivated ones too: the
        set of people is what makes the conversation). One that exists already in ChikuwaChat
        gets the imported history appended."""
        people = {
            self.people[m["user_id"]].id for m in record["members"] if m["user_id"] in self.people
        }
        if len(people) < 2:
            self.report.warn(f"DM {record['display_name']}: 相手が分からないため未移行")
            return
        earlier = refs.get(record["id"])
        channel: Channel | None
        created = False
        if earlier is not None:
            channel = await self.db.get(Channel, earlier)
            if channel is None:
                raise ImportFailed(f"DM {record['display_name']}: imported before, now gone")
        else:
            dm_key = channels.dm_key_for(sorted(people))
            channel = (
                await self.db.execute(select(Channel).where(Channel.dm_key == dm_key))
            ).scalar_one_or_none()
            if channel is None:
                created_at = self.to_datetime(record["create_at"])
                channel = Channel(
                    id=uuid7_at(self.to_ms(record["create_at"])),
                    type="group_dm" if len(people) > 2 else "dm",
                    dm_key=dm_key,
                    created_by=self._person_id(record["creator_id"]),
                    created_at=created_at,
                    updated_at=created_at,
                )
                self.db.add(channel)
                await self.db.flush()
                created = True
                self.report.counts["dms_created"] += 1
            else:
                self.report.warn(f"DM {record['display_name']}: 既にある DM に続けて読み込む")
            self._ref("channel", record["id"], channel.id)
        await self._add_members(channel, record, dict.fromkeys(people, False), created)

    async def _new_channel(self, record: dict[str, Any], kind: str) -> Channel:
        name = await self.channel_target_name(record)
        created_at = self.to_datetime(record["create_at"])
        channel = Channel(
            id=uuid7_at(self.to_ms(record["create_at"])),
            type=kind,
            name=name,
            topic=clip(record["header"], TOPIC_MAX),
            purpose=clip(record["purpose"], TOPIC_MAX),
            created_by=self._person_id(record["creator_id"]),
            created_at=created_at,
            updated_at=created_at,
            archived_at=self.to_datetime(record["delete_at"]) if record["delete_at"] else None,
        )
        self.db.add(channel)
        await self.db.flush()
        self._ref("channel", record["id"], channel.id)
        self.report.counts["channels_created"] += 1
        if channel.archived_at is not None:
            self.report.counts["channels_archived"] += 1
        return channel

    # ---- posts -------------------------------------------------------------------------------

    async def _posts(self) -> None:
        self.post_refs = await self._refs("post")
        pending = 0
        for post in self.posts():
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
        created_at = self.to_datetime(post["create_at"])
        message_id = uuid7_at(self.to_ms(post["create_at"]))
        body = self.convert_body(post["message"])
        bound, lines = await self._files(post, message_id, state, sender.id, created_at)
        if lines:
            body = "\n".join([body, *lines]) if body.strip() else "\n".join(lines)
        body = self.finish_body(body, post, bound)
        mentioned, mention_all = extract_mentions(body)
        pinned_by = self.people.get(post.get("pinned_by") or "")
        self.db.add(
            Message(
                id=message_id,
                channel_id=state.id,
                sender_id=sender.id,
                parent_id=parent_id,
                also_in_channel=bool(post.get("also_in_channel")) and parent_id is not None,
                seq=seq,
                updated_seq=seq,
                client_msg_id=uuid.uuid5(self.namespace, "post:" + post["id"]),
                body=body,
                mentioned_user_ids=mentioned,
                mention_all=mention_all,
                created_at=created_at,
                edited_at=self.to_datetime(post["edit_at"]) if post["edit_at"] else None,
                pinned_at=created_at if post["pinned"] else None,
                pinned_by=(pinned_by.id if pinned_by else sender.id) if post["pinned"] else None,
            )
        )
        self.children.extend(bound)
        self._ref("post", post["id"], message_id)
        self.post_refs[post["id"]] = message_id
        self._reactions(post, message_id)
        per_channel = self.report.channel(state.label)
        if parent_id is not None:
            bump = self.parent_bumps.setdefault(parent_id, [0, created_at, seq])
            bump[0] += 1
            bump[1] = max(bump[1], created_at)
            bump[2] = seq
            self.participants.setdefault(parent_id, set()).add(sender.id)
            self.report.counts["replies"] += 1
            per_channel["replies"] += 1
        state.last_seq = seq
        if state.last_message_at is None or created_at > state.last_message_at:
            state.last_message_at = created_at
        state.touched = True
        state.in_batch = True
        self.report.counts["posts"] += 1
        per_channel["posts"] += 1
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
        # C3: the repliers, from the rows (a re-run appends to threads imported before).
        await message_repo.refresh_reply_user_ids(self.db, list(self.parent_bumps))
        self.parent_bumps.clear()
        for state in self.channels.values():
            if not state.in_batch:
                continue
            # Locked by this batch (_lock), so the values are current; GREATEST still guards
            # against ever moving the sync number or the activity time backwards.
            assert state.locked
            await self.db.execute(
                update(Channel)
                .where(Channel.id == state.id)
                .values(
                    last_seq=func.greatest(Channel.last_seq, state.last_seq),
                    last_message_at=func.greatest(Channel.last_message_at, state.last_message_at),
                )
                .execution_options(synchronize_session=False)
            )
        await self._commit()
        for state in self.channels.values():
            state.in_batch = False
            if not self.dry_run:  # the commit released the row locks (a dry run keeps them)
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
                    created_at=self.to_datetime(r["create_at"]),
                )
            )
            self.report.counts["reactions"] += 1

    def reaction_emoji(self, name: str) -> str | None:
        """A custom emoji stays ``:name:``; a standard one becomes its glyph, as clients send it."""
        name = name.lower()
        glyph = standard_glyph(name)
        if name not in self.custom_emoji and glyph is not None and REACTION.match(glyph):
            return glyph
        token = f":{name}:"
        return token if REACTION.match(token) else None

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


async def active_admin(db: AsyncSession, username: str) -> User:
    actor = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if actor is None or not actor.is_admin or not actor.is_active:
        raise ImportFailed(f"--actor {username}: not an active administrator")
    return actor
