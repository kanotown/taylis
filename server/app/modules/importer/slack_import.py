"""Import a Slack workspace export (M87): the ZIP a workspace admin downloads from Slack.

The export holds ``users.json``, ``channels.json`` and one folder per channel with a JSON array of
messages per day (``general/2024-05-01.json``). Paid plans may add ``groups.json`` (private
channels), ``dms.json`` and ``mpims.json`` (group DMs): those are read only with
``--include-private`` / ``--include-dms``; the default is the public channels, archived ones
included (they stay archived). The target can be any ChikuwaChat server: nothing here assumes one.

The shared steps (people, channels, seq, threads, read state, import_refs, --dry-run) are
``core.ImportJob``'s, as for the Mattermost import. What is Slack's:

- people: ``--user slack=chikuwa`` (the Slack username, display name or user id), an earlier run,
  then the same e-mail address (users.json ``profile.email``). Other senders get deactivated
  accounts, bots (``is_bot``, or a ``bot_message`` with ``bot_id`` / ``username``) bot accounts.
- bodies: mrkdwn → ChikuwaChat markdown (``slack_mrkdwn``); an empty ``text`` shows the
  ``attachments`` / ``blocks`` fallback text.
- messages: ``ts`` gives the time and the order, ``thread_ts`` the thread, ``thread_broadcast``
  a reply also sent to the channel, ``edited.ts`` the edit time, ``pinned_to`` (and the channel's
  ``pins``) the pins, ``reactions`` the reactions (skin tones kept). Joins, leaves, topic / purpose
  / name changes and deleted messages are left out; the channel takes its topic and purpose from
  channels.json.
- files: the export only links them (``url_private_download``, with a ``?t=`` token): they are
  downloaded (``--download``, into the resumable ``--files-cache``) or read from ``--files-dir``,
  checked like uploads (size limit, type from the content) and get thumbnails and video posters.
  A file that cannot be had is reported and leaves a line in the message, never stops the import.
"""

import asyncio
import hashlib
import json
import logging
import re
import uuid
import zipfile
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import filetype
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.settings import Settings
from app.modules.attachments import service as attachments
from app.modules.attachments import videos
from app.modules.attachments.blobstore import BlobStore
from app.modules.attachments.images import IMAGE_TYPES, ImageTooLarge, make_thumbnail
from app.modules.attachments.models import Attachment
from app.modules.channels.models import Channel
from app.modules.channels.schemas import CHANNEL_NAME_PATTERN
from app.modules.emoji import service as emoji_service
from app.modules.importer import core
from app.modules.importer.core import (
    REACTION,
    USERNAME,
    ChannelState,
    ImportFailed,
    Report,
    active_admin,
    standard_glyph,
)
from app.modules.importer.slack_mrkdwn import Resolver, to_markdown, unescape, with_skin_tone
from app.modules.messages.schemas import MAX_BODY_LENGTH
from app.modules.users.models import User

log = logging.getLogger("app.importer")

SOURCE = "slack"
NAMESPACE = uuid.UUID("5f0c0d1e-7d43-4c55-9b1e-6a3f8f2b7c11")
# Subtypes that are not conversation: membership and channel-setting notices, deletions.
SKIPPED_SUBTYPES = {
    "channel_join",
    "channel_leave",
    "channel_topic",
    "channel_purpose",
    "channel_name",
    "channel_archive",
    "channel_unarchive",
    "channel_convert_to_private",
    "channel_convert_to_public",
    "channel_posting_permissions",
    "group_join",
    "group_leave",
    "group_topic",
    "group_purpose",
    "group_name",
    "group_archive",
    "group_unarchive",
    "pinned_item",
    "unpinned_item",
    "bot_add",
    "bot_remove",
    "bot_enable",
    "bot_disable",
    "sh_room_created",
    "sh_room_shared",
    "app_conversation_join",
}
DELETED_SUBTYPES = {"tombstone", "message_deleted", "message_changed", "message_replied"}
HIDDEN_FILE_MODES = {"hidden_by_limit", "tombstone"}
# The Authorization header goes only to Slack's own file hosts.
SLACK_FILE_HOSTS = ("slack.com", "slack-edge.com", "slack-files.com")
_DAY_FILE = re.compile(r"^\d{4}-\d{2}-\d{2}\.json$")
_FILE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_CHANNEL_NAME = re.compile(CHANNEL_NAME_PATTERN)
_SHORTCODE_NAMES = re.compile(r"(?<![\w:]):([a-z0-9_+'-]{1,64}):")
_URL_TOKEN = re.compile(r"([?&]t=)[^&\s'\"]+")
_SLUG_DROP = re.compile(r"[^a-z0-9._-]+")
EMOJI_EXTENSIONS = (".png", ".gif", ".jpg", ".jpeg", ".webp")
PLACEHOLDER = "📎 {name} (Slack から取得できませんでした)"


def ts_to_us(ts: str | float | int | None) -> int:
    """Slack's ``"1712345678.000200"`` as epoch microseconds, without float rounding."""
    if ts is None:
        return 0
    seconds, _, fraction = str(ts).partition(".")
    return int(seconds or 0) * 1_000_000 + int((fraction + "000000")[:6])


def slug(name: str) -> str:
    """A username from a Slack name or bot label ("My Bot" → "my-bot")."""
    return _SLUG_DROP.sub("-", name.strip().lower()).strip("-._")[:32]


# ---- reading the export ------------------------------------------------------------------------


class Export:
    """The export ZIP, or the directory it was unpacked into."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._zip: zipfile.ZipFile | None = None
        self._root = ""
        if path.is_dir():
            self._names = None
        else:
            try:
                self._zip = zipfile.ZipFile(path)
            except (OSError, zipfile.BadZipFile) as exc:
                raise ImportFailed(f"{path}: not a Slack export ZIP ({exc})") from exc
            self._names = set(self._zip.namelist())
            # Some unpack-and-repack tools put everything under one folder.
            users = sorted((n for n in self._names if n.endswith("users.json")), key=len)
            if users:
                self._root = users[0][: -len("users.json")]
        if self.json("users.json") is None or self.json("channels.json") is None:
            raise ImportFailed(f"{path}: not a Slack export (no users.json / channels.json)")

    def close(self) -> None:
        if self._zip is not None:
            self._zip.close()

    def _read(self, name: str) -> bytes | None:
        if self._zip is not None:
            member = self._root + name
            assert self._names is not None
            if member not in self._names:
                return None
            return self._zip.read(member)
        target = (self.path / name).resolve()
        if not target.is_relative_to(self.path.resolve()) or not target.is_file():
            return None
        return target.read_bytes()

    def json(self, name: str) -> Any:
        raw = self._read(name)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ImportFailed(f"{self.path}: {name} is not JSON ({exc})") from exc

    def day_files(self, folder: str) -> list[str]:
        if "/" in folder or folder in ("", ".", ".."):
            return []
        if self._zip is not None:
            assert self._names is not None
            prefix = f"{self._root}{folder}/"
            names = [
                n[len(self._root) :]
                for n in self._names
                if n.startswith(prefix) and _DAY_FILE.match(n[len(prefix) :])
            ]
        else:
            directory = self.path / folder
            names = (
                [f"{folder}/{p.name}" for p in directory.iterdir() if _DAY_FILE.match(p.name)]
                if directory.is_dir()
                else []
            )
        return sorted(names)

    def messages(self, folder: str) -> list[dict[str, Any]]:
        """A channel's messages in ``ts`` order (the day files, merged)."""
        out: list[dict[str, Any]] = []
        for name in self.day_files(folder):
            day = self.json(name)
            if isinstance(day, list):
                out.extend(m for m in day if isinstance(m, dict) and m.get("ts"))
        out.sort(key=lambda m: ts_to_us(m["ts"]))
        return out


# ---- files ---------------------------------------------------------------------------------------


@dataclass
class FileSource:
    """Where the bytes of the export's files come from: ``files_dir`` (downloaded beforehand) or
    ``cache_dir`` (filled by ``fetch`` when ``download``). Failures are kept per file id."""

    files_dir: Path | None = None
    cache_dir: Path | None = None
    download: bool = False
    token: str | None = None
    max_bytes: int = 100 * 1024 * 1024
    concurrency: int = 4
    attempts: int = 4
    backoff_seconds: float = 1.0
    timeout_seconds: float = 120.0
    token_hosts: tuple[str, ...] = SLACK_FILE_HOSTS
    transport: httpx.AsyncBaseTransport | None = None  # tests
    failures: dict[str, str] = field(default_factory=dict)
    counts: Counter[str] = field(default_factory=Counter)

    @staticmethod
    def file_name(f: dict[str, Any]) -> str:
        name = attachments.sanitize_filename(f.get("name") or f.get("title") or f.get("id"))
        return "file" if name in (".", "..") else name

    def _cached(self, f: dict[str, Any]) -> Path | None:
        if self.cache_dir is None:
            return None
        return self.cache_dir / str(f["id"]) / self.file_name(f)

    def locate(self, f: dict[str, Any]) -> Path | None:
        """The file on disk, if it is there (a cache entry only when it is complete)."""
        if not _FILE_ID.match(str(f.get("id") or "")):
            return None
        cached = self._cached(f)
        if cached is not None and cached.is_file() and self._complete(f, cached):
            return cached
        if self.files_dir is not None:
            return self._in_files_dir(f)
        return None

    def _in_files_dir(self, f: dict[str, Any]) -> Path | None:
        """``<id>/<name>``, the one file in ``<id>/``, ``<id>-<name>``, ``<id>.<ext>`` or ``<id>``:
        the layouts the usual Slack download tools write."""
        assert self.files_dir is not None
        fid, name = f["id"], self.file_name(f)
        folder = self.files_dir / fid
        candidates = [folder / name]
        if folder.is_dir():
            inside = [p for p in folder.iterdir() if p.is_file()]
            if len(inside) == 1:
                candidates.append(inside[0])
        candidates += [self.files_dir / f"{fid}-{name}", self.files_dir / fid]
        candidates += sorted(self.files_dir.glob(f"{fid}.*"))
        return next((p for p in candidates if p.is_file()), None)

    @staticmethod
    def _complete(f: dict[str, Any], path: Path) -> bool:
        size = f.get("size")
        return not isinstance(size, int) or size <= 0 or path.stat().st_size == size

    def reason(self, f: dict[str, Any]) -> str:
        if f.get("id") in self.failures:
            return self.failures[f["id"]]
        if not _FILE_ID.match(str(f.get("id") or "")):
            return "ファイル id が不正"
        if self.download:
            return "ダウンロードできなかった"
        if self.files_dir is not None:
            return "--files-dir に無い"
        return "--download も --files-dir も指定していない"

    async def fetch(self, files: list[dict[str, Any]]) -> None:
        """Download what is not in the cache yet, a few at a time; never raises."""
        if not self.download or self.cache_dir is None:
            return
        wanted = [f for f in files if self.locate(f) is None]
        if not wanted:
            return
        semaphore = asyncio.Semaphore(max(1, self.concurrency))
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(self.timeout_seconds, connect=30.0),
            transport=self.transport,
        ) as client:

            async def one(f: dict[str, Any]) -> None:
                async with semaphore:
                    error = await self._download(client, f)
                if error is None:
                    self.counts["downloaded"] += 1
                else:
                    self.failures[f["id"]] = error
                    self.counts["download_failed"] += 1
                    log.warning("slack file %s (%s): %s", f["id"], f.get("name"), error)

            await asyncio.gather(*(one(f) for f in wanted))

    def _headers(self, url: str) -> dict[str, str]:
        host = (urlsplit(url).hostname or "").lower()
        if self.token and any(host == h or host.endswith("." + h) for h in self.token_hosts):
            return {"Authorization": f"Bearer {self.token}"}
        return {}

    async def _download(self, client: httpx.AsyncClient, f: dict[str, Any]) -> str | None:
        if not _FILE_ID.match(str(f.get("id") or "")):
            return "ファイル id が不正"
        url = f.get("url_private_download") or f.get("url_private")
        if not isinstance(url, str) or urlsplit(url).scheme not in ("https", "http"):
            return "ダウンロードの URL が無い"
        size = f.get("size")
        if isinstance(size, int) and size > self.max_bytes:
            return f"添付の上限 ({self.max_bytes} バイト) を超える"
        dest = self._cached(f)
        assert dest is not None
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        last = ""
        for attempt in range(self.attempts):
            if attempt:
                await asyncio.sleep(self._delay(attempt, last))
            try:
                async with client.stream("GET", url, headers=self._headers(url)) as response:
                    if response.status_code == 429 or response.status_code >= 500:
                        last = f"HTTP {response.status_code}"
                        retry_after = response.headers.get("retry-after", "")
                        if retry_after.isdigit():
                            last += f" retry-after={min(int(retry_after), 60)}"
                        continue
                    if response.status_code != 200:
                        return f"HTTP {response.status_code}"
                    content_type = response.headers.get("content-type", "")
                    if content_type.startswith("text/html") and not str(
                        f.get("mimetype", "")
                    ).startswith("text/html"):
                        return "Slack がログイン画面を返した (トークンが無効か期限切れ)"
                    error = await self._write(response, part)
                    if error is not None:
                        return error
                part.replace(dest)
                return None
            except httpx.HTTPError as exc:  # the text may hold the URL: no ?t= token in reports
                last = _URL_TOKEN.sub(r"\1…", f"{type(exc).__name__}: {exc}")
        part.unlink(missing_ok=True)
        return f"{self.attempts} 回試して失敗 ({last})"

    def _delay(self, attempt: int, last: str) -> float:
        match = re.search(r"retry-after=(\d+)", last)
        if match:
            return float(match.group(1))
        return float(self.backoff_seconds * 2 ** (attempt - 1))

    async def _write(self, response: httpx.Response, part: Path) -> str | None:
        written = 0
        with part.open("wb") as out:
            async for chunk in response.aiter_bytes(1024 * 1024):
                written += len(chunk)
                if written > self.max_bytes:
                    out.close()
                    await run_in_threadpool(part.unlink, True)
                    return f"添付の上限 ({self.max_bytes} バイト) を超える"
                await run_in_threadpool(out.write, chunk)
        return None


def _sha256(path: Path) -> bytes:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def _thumbnail(path: Path, max_px: int) -> tuple[bytes, int, int]:
    with path.open("rb") as fh:
        return make_thumbnail(fh, max_px)


# ---- fallback text for messages without text ---------------------------------------------------


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _styled(text: str, style: dict[str, Any]) -> str:
    """Slack's markers around the words (spaces stay outside, or mrkdwn would not see them)."""
    core_text = text.strip()
    if not core_text:
        return text
    lead, trail = text[: len(text) - len(text.lstrip())], text[len(text.rstrip()) :]
    for key, mark in (("code", "`"), ("bold", "*"), ("italic", "_"), ("strike", "~")):
        if style.get(key):
            core_text = f"{mark}{core_text}{mark}"
    return lead + core_text + trail


def _rich_text(elements: list[Any]) -> str:
    """Slack's ``rich_text`` elements back to mrkdwn (what the message's ``text`` would hold)."""
    out: list[str] = []
    for element in elements:
        if not isinstance(element, dict):
            continue
        kind = element.get("type")
        if kind == "text":
            out.append(_styled(_escape(str(element.get("text", ""))), element.get("style") or {}))
        elif kind == "link":
            label = element.get("text")
            out.append(
                f"<{element.get('url', '')}|{_escape(label)}>"
                if label
                else f"<{element.get('url', '')}>"
            )
        elif kind == "user":
            out.append(f"<@{element.get('user_id', '')}>")
        elif kind == "channel":
            out.append(f"<#{element.get('channel_id', '')}>")
        elif kind == "broadcast":
            out.append(f"<!{element.get('range', 'here')}>")
        elif kind == "emoji":
            tone = element.get("skin_tone")
            out.append(f":{element.get('name', '')}:" + (f":skin-tone-{tone}:" if tone else ""))
        elif kind == "rich_text_section":
            out.append(_rich_text(element.get("elements", [])))
        elif kind in ("rich_text_list", "rich_text_preformatted", "rich_text_quote") and (
            out and not out[-1].endswith("\n")
        ):
            out.append("\n")
            out.append(_rich_text([element]))
        elif kind == "rich_text_list":
            ordered = element.get("style") == "ordered"
            items = [
                (f"{n}. " if ordered else "- ") + _rich_text(item.get("elements", []))
                for n, item in enumerate(element.get("elements", []), 1)
                if isinstance(item, dict)
            ]
            out.append("\n".join(items) + "\n")
        elif kind == "rich_text_preformatted":
            out.append("```" + _rich_text(element.get("elements", [])) + "```\n")
        elif kind == "rich_text_quote":
            quoted = _rich_text(element.get("elements", []))
            out.append("\n".join("&gt; " + line for line in quoted.split("\n")) + "\n")
    return "".join(out)


def fallback_text(message: dict[str, Any]) -> str:
    """The text to show when ``text`` is empty: the blocks' text, else each attachment's."""
    parts: list[str] = []
    for block in message.get("blocks") or []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "rich_text":
            parts.append(_rich_text(block.get("elements", [])).rstrip("\n"))
        elif block.get("type") in ("section", "header", "context"):
            texts = [block.get("text"), *(block.get("fields") or [])]
            texts += list(block.get("elements") or []) if block.get("type") == "context" else []
            for text in texts:
                if isinstance(text, dict) and text.get("text"):
                    value = str(text["text"])
                    parts.append(value if text.get("type") == "mrkdwn" else _escape(value))
    if any(p.strip() for p in parts):
        return "\n".join(p for p in parts if p.strip())
    for attachment in message.get("attachments") or []:
        if not isinstance(attachment, dict):
            continue
        lines = [
            str(attachment[key]) for key in ("pretext", "title", "text") if attachment.get(key)
        ]
        if not lines and attachment.get("fallback"):
            lines = [str(attachment["fallback"])]
        if attachment.get("title_link") and attachment.get("title"):
            lines = [
                f"<{attachment['title_link']}|{attachment['title']}>"
                if line == attachment["title"]
                else line
                for line in lines
            ]
        parts.append("\n".join(lines))
    return "\n".join(p for p in parts if p.strip())


# ---- the import ----------------------------------------------------------------------------------


@dataclass
class Options:
    channel_prefix: str = ""
    include_private: bool = False
    include_dms: bool = False
    emoji_dir: Path | None = None


class SlackImport(core.ImportJob):
    source = SOURCE
    source_label = "Slack"
    namespace = NAMESPACE
    name_suffix = "slack"

    def __init__(
        self,
        db: AsyncSession,
        export: Export,
        *,
        files: FileSource,
        options: Options,
        user_map: dict[str, str],
        actor: User,
        blobs: BlobStore,
        settings: Settings,
        dry_run: bool,
    ) -> None:
        self.export = export
        self.files = files
        self.options = options
        self.raw_users: dict[str, dict[str, Any]] = {}
        self.bots_by_bot_id: dict[str, str] = {}  # Slack bot id → user id (users.json)
        users = self._read_users()
        records = self._read_channels(users)
        super().__init__(
            db,
            users=users,
            channel_records=records,
            user_map=user_map,
            actor=actor,
            blobs=blobs,
            settings=settings,
            dry_run=dry_run,
        )
        self.names: dict[str, str] = {}  # Slack channel id → its name in ChikuwaChat
        self._prescan()

    # ---- users and channels from the export ----------------------------------------------

    def _read_users(self) -> dict[str, dict[str, Any]]:
        users: dict[str, dict[str, Any]] = {}
        raw = self.export.json("users.json")
        for u in raw if isinstance(raw, list) else []:
            if not isinstance(u, dict) or not u.get("id"):
                continue
            profile = u.get("profile") or {}
            self.raw_users[u["id"]] = u
            is_bot = bool(u.get("is_bot") or u.get("is_app_user")) or u["id"] == "USLACKBOT"
            if profile.get("bot_id"):
                self.bots_by_bot_id[profile["bot_id"]] = u["id"]
            users[u["id"]] = {
                "id": u["id"],
                "username": u.get("name") or slug(profile.get("real_name") or u["id"]),
                "email": profile.get("email") or None,
                "first_name": profile.get("real_name") or u.get("real_name") or "",
                "last_name": "",
                "nickname": profile.get("display_name") or "",
                "position": profile.get("title") or "",
                "is_bot": is_bot,
            }
        return users

    def user_keys(self, record: dict[str, Any]) -> list[str]:
        raw = self.raw_users.get(record["id"], {})
        profile = raw.get("profile") or {}
        keys = [record["id"], record["username"], profile.get("display_name") or ""]
        return [k.lower().lstrip("@") for k in dict.fromkeys(keys) if k]

    def _display(self, user_id: str) -> str:
        record = self.users.get(user_id) if hasattr(self, "users") else None
        if record is None:
            raw = self.raw_users.get(user_id)
            if raw is None:
                return user_id
            profile = raw.get("profile") or {}
            return str(profile.get("display_name") or raw.get("name") or user_id)
        return str(record["nickname"] or record["username"])

    def _plain(self, text: str, names: dict[str, str]) -> str:
        """A topic or purpose: tokens as plain text (they are not rendered there)."""
        resolver = Resolver(
            user=self._user_text,
            user_text=self._user_text,
            channel=lambda cid, label: "#" + (label or names.get(cid, cid)),
            emoji=lambda name, tone: None,
        )
        return to_markdown(text, resolver)

    def _read_channels(self, users: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        kinds: list[tuple[str, str]] = [("channels.json", "public")]
        if self.options.include_private:
            kinds.append(("groups.json", "private"))
        if self.options.include_dms:
            kinds += [("dms.json", "dm"), ("mpims.json", "group_dm")]
        raw: list[tuple[dict[str, Any], str]] = []
        for name, kind in kinds:
            data = self.export.json(name)
            if data is None and kind != "public":
                log.warning("slack: %s is not in the export", name)
            for c in data if isinstance(data, list) else []:
                if isinstance(c, dict) and c.get("id"):
                    raw.append((c, kind))
        names = {c["id"]: str(c.get("name") or c["id"]) for c, _ in raw}
        records: list[dict[str, Any]] = []
        for c, kind in raw:
            members = [m for m in c.get("members") or [] if isinstance(m, str)]
            if kind == "dm" and not members and c.get("user"):
                members = [c["user"]]
            created = ts_to_us(c.get("created")) or 1_000_000
            dm = kind in ("dm", "group_dm")
            label = (
                ", ".join(self._display(m) for m in members)
                if dm
                else str(c.get("name") or c["id"])
            )
            records.append(
                {
                    "id": c["id"],
                    "name": str(c.get("name") or c["id"]),
                    "display_name": label,
                    "private": kind == "private",
                    "channel_type": "group_dm" if kind == "group_dm" else kind,
                    "folder": c["id"] if kind == "dm" else str(c.get("name") or c["id"]),
                    "header": self._plain((c.get("topic") or {}).get("value") or "", names),
                    "purpose": self._plain((c.get("purpose") or {}).get("value") or "", names),
                    "creator_id": c.get("creator"),
                    "create_at": created,
                    "archived": bool(c.get("is_archived")),
                    "delete_at": 0,
                    "members": [{"user_id": m, "admin": False} for m in members],
                    "pins": {
                        str(p.get("id")): p
                        for p in c.get("pins") or []
                        if isinstance(p, dict) and p.get("id")
                    },
                }
            )
        return records

    def _prescan(self) -> None:
        """One pass over the messages: senders not in users.json (bots, Slackbot, people of
        other workspaces) get records, archived channels an archive time (their last message)."""
        for record in self.channel_records:
            last = record["create_at"]
            for message in self.export.messages(record["folder"]):
                self._sender(message)
                last = max(last, ts_to_us(message["ts"]))
            if record["archived"]:
                record["delete_at"] = last

    def _sender(self, message: dict[str, Any]) -> str | None:
        """The sender's user id (made up for bots and people users.json does not have)."""
        user = message.get("user")
        if isinstance(user, str) and user in self.users:
            return user
        profile = message.get("bot_profile") or {}
        bot_id = message.get("bot_id") or profile.get("id")
        if message.get("subtype") == "bot_message" or bot_id:
            if bot_id and bot_id in self.bots_by_bot_id:
                return self.bots_by_bot_id[bot_id]
            label = str(message.get("username") or profile.get("name") or bot_id or "bot")
            key = f"bot:{bot_id}" if bot_id else f"bot:name:{label.lower()}"[:64]
            if key not in self.users:
                username = slug(label)
                self.users[key] = {
                    "id": key,
                    "username": username if USERNAME.match(username) else "slack-bot",
                    "email": None,
                    "first_name": label,
                    "last_name": "",
                    "nickname": "",
                    "position": "",
                    "is_bot": True,
                }
            return key
        if isinstance(user, str) and user:
            profile = message.get("user_profile") or {}
            name = slug(str(profile.get("name") or user))
            self.users[user] = {
                "id": user,
                "username": name if USERNAME.match(name) else slug(user),
                "email": None,
                "first_name": str(profile.get("real_name") or ""),
                "last_name": "",
                "nickname": str(profile.get("display_name") or ""),
                "position": "",
                "is_bot": user == "USLACKBOT",
            }
            return user
        return None

    # ---- posts -----------------------------------------------------------------------------

    def to_datetime(self, value: int) -> datetime:
        return datetime.fromtimestamp(value // 1_000_000, tz=UTC).replace(
            microsecond=value % 1_000_000
        )

    def to_ms(self, value: int) -> int:
        return value // 1000

    def posts(self) -> Iterator[dict[str, Any]]:
        for record in self.channel_records:
            for message in self.export.messages(record["folder"]):
                post = self._post_record(message, record)
                if post is not None:
                    yield post

    def _post_record(self, m: dict[str, Any], channel: dict[str, Any]) -> dict[str, Any] | None:
        subtype = m.get("subtype")
        if m.get("type", "message") != "message" or subtype in SKIPPED_SUBTYPES:
            return None
        if subtype in DELETED_SUBTYPES or m.get("hidden") or m.get("is_deleted"):
            return None
        sender = self._sender(m)
        if sender is None:
            return None
        ts = str(m["ts"])
        created = ts_to_us(ts)
        thread_ts = m.get("thread_ts")
        root = f"{channel['id']}:{thread_ts}" if thread_ts and str(thread_ts) != ts else None
        text = str(m.get("text") or "")
        if not text.strip():
            text = fallback_text(m)
        pin = channel["pins"].get(ts)
        pinned = channel["id"] in (m.get("pinned_to") or []) or pin is not None
        reactions = [
            {"user_id": u, "emoji_name": str(r["name"]), "create_at": created}
            for r in m.get("reactions") or []
            if isinstance(r, dict) and r.get("name")
            for u in r.get("users") or []
        ]
        return {
            "id": f"{channel['id']}:{ts}",
            "channel_id": channel["id"],
            "user_id": sender,
            "root_id": root,
            "message": text,
            "create_at": created,
            "edit_at": ts_to_us((m.get("edited") or {}).get("ts")),
            "pinned": pinned,
            "pinned_by": (pin or {}).get("user") or (pin or {}).get("created_by"),
            "files": [f for f in m.get("files") or [] if isinstance(f, dict)],
            "reactions": reactions,
            "also_in_channel": subtype == "thread_broadcast",
        }

    def needed_user_ids(self) -> set[str]:
        needed = super().needed_user_ids()
        for record in self.channel_records:
            if record["channel_type"] in ("dm", "group_dm"):  # the people make the DM
                needed.update(m["user_id"] for m in record["members"])
        return needed

    # ---- before anything is written ------------------------------------------------------

    async def prepare(self) -> None:
        """Checks that need no writes, then the downloads (no transaction is held meanwhile):
        a channel name taken in ChikuwaChat stops the import here, with nothing written."""
        self._check_user_map()
        for target in sorted(set(self.user_map.values())):
            if await self._user_by_name(target) is None:
                raise ImportFailed(f"--user …={target}: no ChikuwaChat user {target}")
        refs = await self._refs("channel")
        clashes: list[str] = []
        prefix = self.options.channel_prefix
        for record in self.channel_records:
            if record["channel_type"] not in ("public", "private") or record["id"] in refs:
                continue
            name = prefix + record["name"]
            if not _CHANNEL_NAME.match(name):
                raise ImportFailed(
                    f"#{record['name']}: '{name}' cannot be a channel name "
                    "(at most 80 characters, no spaces, # @ /)"
                )
            taken = (
                await self.db.execute(select(Channel.id).where(Channel.name == name))
            ).scalar_one_or_none()
            if taken is not None:
                clashes.append("#" + name)
        if clashes:
            hint = (
                "choose another --channel-prefix"
                if prefix
                else "give --channel-prefix (e.g. --channel-prefix slack-) to import them "
                "under other names"
            )
            raise ImportFailed(
                f"channels already exist in ChikuwaChat: {', '.join(clashes)}; {hint}"
            )
        posts = await self._refs("post")
        file_refs = await self._refs("file")
        await self.db.rollback()  # downloads can take long: hold no transaction meanwhile
        wanted = [
            f
            for post in self.posts()
            if post["id"] not in posts
            for f in post["files"]
            if self._fetchable(f) and f"{post['id']}:{f.get('id')}" not in file_refs
        ]
        unique = list({str(f.get("id")): f for f in wanted}.values())
        self.report.counts["files_wanted"] = len(unique)
        await self.files.fetch(unique)
        await self.db.refresh(self.actor)  # the rollback expired it
        for key, value in self.files.counts.items():
            self.report.counts[f"files_{key}"] = value

    @staticmethod
    def _fetchable(f: dict[str, Any]) -> bool:
        return not (f.get("mode") in HIDDEN_FILE_MODES or f.get("is_external")) and (
            f.get("mode") != "external"
        )

    # ---- channels and emoji ----------------------------------------------------------------

    async def channel_target_name(self, record: dict[str, Any]) -> str:
        return self.options.channel_prefix + str(record["name"])

    async def _channels(self) -> None:
        await super()._channels()
        for record in self.channel_records:
            state = self.channels.get(record["id"])
            if state is not None and state.label.startswith("#"):
                self.names[record["id"]] = state.label[1:]

    async def _emoji(self) -> None:
        """Names that are no standard emoji and no custom emoji yet become custom emoji when
        --emoji-dir has an image of that name (``<name>.png`` etc.)."""
        await super()._emoji()
        directory = self.options.emoji_dir
        if directory is None:
            return
        refs = await self._refs("emoji")
        used: set[str] = set()
        for post in self.posts():
            used.update(r["emoji_name"].split("::", 1)[0].lower() for r in post["reactions"])
            used.update(_SHORTCODE_NAMES.findall(post["message"]))
        for name in sorted(used):
            if name in refs or name in self.custom_emoji or standard_glyph(name) is not None:
                continue
            if not emoji_service.NAME.match(name):
                continue
            path = next(
                (
                    directory / f"{name}{ext}"
                    for ext in EMOJI_EXTENSIONS
                    if (directory / f"{name}{ext}").is_file()
                ),
                None,
            )
            if path is None:
                continue
            emoji_id = await self._add_custom_emoji(name, path.read_bytes(), self.actor.id)
            if emoji_id is not None:
                self._ref("emoji", name, emoji_id)

    def reaction_emoji(self, name: str) -> str | None:
        """``+1::skin-tone-2`` is 👍🏼's glyph with the tone; a custom name drops the tone."""
        base, _, tone = name.lower().partition("::")
        glyph = standard_glyph(base)
        if base not in self.custom_emoji and glyph is not None:
            toned = with_skin_tone(glyph, tone.removeprefix("skin-tone-") or None)
            return toned if REACTION.match(toned) else glyph if REACTION.match(glyph) else None
        token = f":{base}:"
        return token if REACTION.match(token) else None

    # ---- bodies ----------------------------------------------------------------------------

    def _user_token(self, user_id: str, label: str | None) -> str:
        person = self.people.get(user_id)
        if person is not None:
            self.report.counts["mentions"] += 1
            return f"<@{person.id}>"
        return self._user_text(user_id, label)

    def _user_text(self, user_id: str, label: str | None) -> str:
        return "@" + (unescape(label) if label else self._display(user_id))

    def _channel_token(self, channel_id: str, label: str | None) -> str:
        name = self.names.get(channel_id)
        if name is None:
            name = unescape(label) if label else channel_id
        return "#" + name

    def _emoji_glyph(self, name: str, tone: str | None) -> str | None:
        if name in self.custom_emoji:
            return None
        glyph = standard_glyph(name)
        return with_skin_tone(glyph, tone) if glyph is not None else None

    def convert_body(self, text: str) -> str:
        body = to_markdown(
            text,
            Resolver(
                user=self._user_token,
                user_text=self._user_text,
                channel=self._channel_token,
                emoji=self._emoji_glyph,
            ),
        )
        if len(body) > MAX_BODY_LENGTH:
            self.report.counts["bodies_clipped"] += 1
            body = body[: MAX_BODY_LENGTH - 1] + "…"
        return body

    # ---- files -----------------------------------------------------------------------------

    async def _files(
        self,
        post: dict[str, Any],
        message_id: uuid.UUID,
        state: ChannelState,
        uploader_id: uuid.UUID,
        created_at: datetime,
    ) -> tuple[list[Attachment], list[str]]:
        bound: list[Attachment] = []
        lines: list[str] = []
        per_channel = self.report.channel(state.label)
        for f in post["files"]:
            name = FileSource.file_name(f)
            if f.get("mode") in HIDDEN_FILE_MODES:
                self.report.counts["files_hidden"] += 1
                continue
            if f.get("is_external") or f.get("mode") == "external":
                url = f.get("url_private") or f.get("permalink") or ""
                safe = re.match(r"^https?://[^\s()<>]+$", str(url))
                lines.append(f"📎 [{name}]({url})" if safe else f"📎 {name}")
                self.report.counts["files_external"] += 1
                continue
            attachment, reason = await self._attachment(
                f, post["id"], message_id, state.id, uploader_id, created_at
            )
            if attachment is None:
                lines.append(PLACEHOLDER.format(name=name))
                self.report.failed_files.append(f"{state.label} {name} ({f.get('id')}): {reason}")
                self.report.counts["files_failed"] += 1
                per_channel["files_failed"] += 1
                continue
            bound.append(attachment)
            per_channel["files"] += 1
        return bound, lines

    async def _attachment(
        self,
        f: dict[str, Any],
        post_id: str,
        message_id: uuid.UUID,
        channel_id: uuid.UUID,
        uploader_id: uuid.UUID,
        created_at: datetime,
    ) -> tuple[Attachment | None, str]:
        """Checked like an upload: the size limit, not empty, the type from the content, an
        image that has too many pixels refused; thumbnails and video posters made."""
        path = self.files.locate(f)
        if path is None:
            return None, self.files.reason(f)
        size = path.stat().st_size
        if size == 0:
            return None, "空のファイル"
        if size > self.settings.attachment_max_bytes:
            return None, f"添付の上限 ({self.settings.attachment_max_bytes} バイト) を超える"
        with path.open("rb") as fh:
            head = fh.read(attachments.SNIFF_BYTES)
        kind = filetype.guess(head)
        content_type = kind.mime if kind is not None else "application/octet-stream"
        attachment_id = uuid.uuid5(NAMESPACE, f"file:{post_id}:{f['id']}")
        attachment = Attachment(
            id=attachment_id,
            uploader_id=uploader_id,
            message_id=message_id,
            channel_id=channel_id,
            status="attached",
            filename=FileSource.file_name(f),
            content_type=content_type,
            size_bytes=size,
            storage_key=attachments.storage_key(attachment_id),
            created_at=created_at,
            attached_at=created_at,
        )
        if not self.dry_run:  # a dry run checks that the files are there, not their pixels
            attachment.sha256 = await run_in_threadpool(_sha256, path)
            if content_type in IMAGE_TYPES:
                try:
                    thumb, width, height = await run_in_threadpool(
                        _thumbnail, path, self.settings.attachment_thumbnail_px
                    )
                except ImageTooLarge:
                    return None, "画像の画素数が多すぎる (アップロードでも断る)"
                except Exception as exc:  # stays a plain file, as an upload would
                    self.report.warn(f"添付 {attachment.filename}: サムネイルを作れない ({exc})")
                else:
                    await self.blobs.put(
                        attachments.thumbnail_key(attachment_id), thumb, "image/jpeg"
                    )
                    attachment.width, attachment.height = width, height
                    attachment.thumbnail_key = attachments.thumbnail_key(attachment_id)
            elif videos.is_video(content_type):
                try:
                    info = await videos.probe_video(str(path), self.settings)
                    if info is not None:
                        await attachments.apply_video_info(attachment, info, self.blobs)
                except Exception as exc:  # never fails the import, as it never fails an upload
                    self.report.warn(f"添付 {attachment.filename}: 動画を調べられない ({exc})")
            with path.open("rb") as fh:
                await self.blobs.put(attachment.storage_key, fh, content_type)
        self._ref("file", f"{post_id}:{f['id']}", attachment_id)
        self.report.counts["files"] += 1
        self.report.counts["file_bytes"] += size
        return attachment, ""


async def import_slack(
    db: AsyncSession,
    export_path: Path,
    *,
    files: FileSource,
    options: Options,
    user_map: dict[str, str],
    actor_username: str,
    blobs: BlobStore,
    settings: Settings,
    dry_run: bool,
) -> Report:
    export = Export(export_path)
    try:
        actor = await active_admin(db, actor_username)
        if options.emoji_dir is not None and not options.emoji_dir.is_dir():
            raise ImportFailed(f"--emoji-dir {options.emoji_dir}: not a directory")
        files.max_bytes = min(files.max_bytes, settings.attachment_max_bytes)
        job = SlackImport(
            db,
            export,
            files=files,
            options=options,
            user_map=user_map,
            actor=actor,
            blobs=blobs,
            settings=settings,
            dry_run=dry_run,
        )
        await job.prepare()
        return await job.run()
    finally:
        export.close()
