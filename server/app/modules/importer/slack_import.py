"""Import a Slack workspace export (M87): the ZIP a workspace admin downloads from Slack.

The export holds ``users.json``, ``channels.json`` and one folder per channel with a JSON array of
messages per day (``general/2024-05-01.json``). Paid plans may add ``groups.json`` (private
channels), ``dms.json`` and ``mpims.json`` (group DMs): those are read only with
``--include-private`` / ``--include-dms``; the default is the public channels, archived ones
included (they stay archived). The target can be any ChikuwaChat server: nothing here assumes one.

The shared steps (people, channels, seq, threads, read state, import_refs, --dry-run) are
``core.ImportJob``'s, as for the Mattermost import. What is Slack's:

- people: ``--user slack=chikuwa`` (the Slack username, display name, user id or e-mail address),
  an earlier run, then the same e-mail address (users.json ``profile.email``, after
  ``--email-domain-map``). Other senders get deactivated accounts, bots (``is_bot``, or a
  ``bot_message`` with ``bot_id`` / ``username``) bot accounts. M91: regular members whose address
  is in an ``--activate-domain`` get active accounts without a password (Google sign-in finds them
  by the address), Slack guests (``is_restricted`` / ``is_ultra_restricted``) deactivated guest
  accounts; a new person's username is their address's local part (a student id).
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
- bridges (M92): ``--bot-as BOTNAME=TARGET`` imports a bot's posts (a Mattermost → Slack bridge
  posting as ``username``) as a person's; the bridge's relayed "X がチャンネルに参加しました" lines
  are left out. Custom emoji come from ``--emoji-dir`` (a folder or a ZIP); ``--emoji-rename``
  gives a Slack name that is no valid Taylis name (Japanese) a new one, for the image, the
  reactions and ``:name:`` in the text.
- bot names (M98): a bot account is named after its posts' ``username``; one ``bot_id`` that
  posted under several (the Slack RSS app: one per feed) is named after its ``bot_profile.name``,
  else what the names share, and the report lists them. ``--bot-name BOT=NAME`` names it.
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import unicodedata
import uuid
import zipfile
from collections import Counter
from collections.abc import AsyncIterator, Collection, Iterator, Sequence
from contextlib import asynccontextmanager
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
    ACTION_BOT_AS,
    ACTION_DEACTIVATED,
    ACTION_GUEST,
    REACTION,
    USERNAME,
    ChannelState,
    ImportFailed,
    Person,
    PersonRow,
    Report,
    active_admin,
    standard_glyph,
)
from app.modules.importer.models import ImportRef
from app.modules.importer.slack_mrkdwn import Resolver, to_markdown, unescape, with_skin_tone
from app.modules.messages.models import Message
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
# The Authorization header goes only to Slack's own file hosts, and only over HTTPS.
SLACK_FILE_HOSTS = ("slack.com", "slack-edge.com", "slack-files.com")
MAX_REDIRECTS = 5
_DAY_FILE = re.compile(r"^\d{4}-\d{2}-\d{2}\.json$")
_FILE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_CHANNEL_NAME = re.compile(CHANNEL_NAME_PATTERN)
_SHORTCODE_NAMES = re.compile(r"(?<![\w:]):([a-z0-9_+'-]{1,64}):")
_CODE_SPAN = re.compile(r"```.*?```|`[^`\n]+`", re.DOTALL)  # as slack_mrkdwn reads code
_URL_TOKEN = re.compile(r"([?&]t=)[^&\s'\"]+")
_SLUG_DROP = re.compile(r"[^a-z0-9._-]+")
EMOJI_EXTENSIONS = (".png", ".gif", ".jpg", ".jpeg", ".webp")
# M92: what a Mattermost → Slack bridge relays when someone joins a channel there, as a bot post
# of its own: "suzuki がチャンネルに参加しました。", "@99x9999zさんがチャンネルに参加しました".
_JOINER = r"(?:<@[A-Za-z0-9]+(?:\|[^>\n]*)?>|@?[^\s<>@][^\n<>]{0,63}?)"
BRIDGE_JOIN = re.compile(rf"^\s*{_JOINER}\s*(?:さん\s*)?がチャンネルに参加しました[。.]?\s*$")
BOT_AS_PREFIX = "bot-as:"
# Review v0.1.30 #2: an import_refs kind marking a ``--bot-as`` bot whose posts went to an existing
# person (a Slack user or @username) rather than to a ``new:`` account; its ``user`` ref says who.
BOT_AS_PERSON = "bot_as_person"
POST_REF_CHUNK = 5000
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


# Trailing separators dropped from a shared bot name: space, tab, hyphen, en / em dash, …
_NAME_SEPARATORS = " \t-\u2013\u2014:|/\u30fb_.,"


def shared_bot_name(names: Sequence[str]) -> str | None:
    """M98: what a bot's several post names have in common ("週報 - 中村の週報", "週報 - 田中の週報"
    → "週報"), without trailing separators; None when that is shorter than 2 characters."""
    prefix = os.path.commonprefix([n.strip() for n in names]).rstrip(_NAME_SEPARATORS)
    return prefix if len(prefix) >= 2 else None


# ---- reading the export ------------------------------------------------------------------------


def _member_name(info: zipfile.ZipInfo) -> str:
    """A member's name as the exporter wrote it: UTF-8 even without the ZIP's UTF-8 flag (0x800)."""
    if info.flag_bits & 0x800:
        return info.filename
    try:
        return info.filename.encode("cp437").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return info.filename


class Export:
    """The export ZIP, or the directory it was unpacked into."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._zip: zipfile.ZipFile | None = None
        self._members: dict[str, str] = {}
        self._root = ""
        if path.is_dir():
            self._names = None
        else:
            try:
                self._zip = zipfile.ZipFile(path)
            except (OSError, zipfile.BadZipFile) as exc:
                raise ImportFailed(f"{path}: not a Slack export ZIP ({exc})") from exc
            # Slack's export stores UTF-8 names without the ZIP UTF-8 flag, so zipfile decodes them
            # as cp437 (mojibake) and Japanese channel folders would not be found: take the bytes
            # back and read them as UTF-8. The original member name is kept for reading.
            self._members = {_member_name(info): info.filename for info in self._zip.infolist()}
            self._names = set(self._members)
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
            return self._zip.read(self._members[member])
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


def nfc(text: str) -> str:
    """Names compared as NFC: macOS writes file names decomposed (ご as こ + ゛)."""
    return unicodedata.normalize("NFC", text)


class EmojiImages:
    """Custom emoji images by name (M92): ``--emoji-dir`` is a folder of ``<name>.png`` (``.gif``,
    ``.jpg``, ``.webp``) or a ZIP of them, whose UTF-8 names may lack the UTF-8 flag (as in the
    export). Folders inside the ZIP do not matter; with two images of one name the extension
    listed first in EMOJI_EXTENSIONS wins."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._zip: zipfile.ZipFile | None = None
        found: dict[str, tuple[int, str | Path]] = {}

        def add(file_name: str, where: str | Path) -> None:
            base = file_name.rsplit("/", 1)[-1]
            stem, dot, ext = base.rpartition(".")
            extension = f".{ext.lower()}"
            if not dot or not stem or base.startswith("._") or extension not in EMOJI_EXTENSIONS:
                return
            rank = EMOJI_EXTENSIONS.index(extension)
            key = nfc(stem)
            if key not in found or rank < found[key][0]:
                found[key] = (rank, where)

        if path.is_dir():
            for entry in sorted(path.iterdir()):
                if entry.is_file():
                    add(entry.name, entry)
        else:
            try:
                self._zip = zipfile.ZipFile(path)
            except (OSError, zipfile.BadZipFile) as exc:
                raise ImportFailed(f"--emoji-dir {path}: not a directory or a ZIP ({exc})") from exc
            for info in self._zip.infolist():
                name = _member_name(info)
                if not info.is_dir() and not name.startswith("__MACOSX/"):
                    add(name, info.filename)
        self._files = {name: where for name, (_, where) in found.items()}

    def __len__(self) -> int:
        return len(self._files)

    def get(self, name: str) -> bytes | None:
        key = nfc(name)
        where = self._files.get(key, self._files.get(key.lower()))
        if where is None:
            return None
        if isinstance(where, Path):
            return where.read_bytes()
        assert self._zip is not None
        return self._zip.read(where)

    def close(self) -> None:
        if self._zip is not None:
            self._zip.close()


@dataclass(frozen=True)
class BotTarget:
    """Whose a ``--bot-as`` bot's posts are: a Slack person (``slack``, their user id), an
    existing Taylis account (``user``, its username) or a new deactivated one (``new``, its
    display name)."""

    kind: str
    value: str
    guest: bool = False


def parse_bot_target(bot: str, target: str) -> BotTarget:
    """``TARGET`` of ``--bot-as``: ``@username``, ``new:<display name>[:guest]`` or else a Slack
    user (``value`` is then the name to look up); raises ImportFailed when it is none."""
    target = target.strip()
    if target.lower().startswith("new:"):
        display = target[4:]
        guest = display.lower().endswith(":guest")
        if guest:
            display = display[: -len(":guest")]
        display = display.strip()
        if not display or len(display) > 80:
            raise ImportFailed(
                f"--bot-as {bot}={target}: new:<display name>[:guest] needs a display name "
                "(at most 80 characters)"
            )
        return BotTarget("new", display, guest)
    if target.startswith("@"):
        name = target[1:].strip().lower()
        if not name:
            raise ImportFailed(f"--bot-as {bot}={target}: @ needs a Taylis username")
        return BotTarget("user", name)
    if not target:
        raise ImportFailed(f"--bot-as {bot}=: give a Slack user, @taylis-user or new:<name>")
    return BotTarget("slack", target.lower())


# ---- files ---------------------------------------------------------------------------------------


class _Refused(Exception):
    """A download that is not even tried (again): the reason goes to the report."""


@dataclass
class FileSource:
    """Where the bytes of the export's files come from: ``files_dir`` (downloaded beforehand) or
    ``cache_dir`` (filled by ``fetch`` when ``download``). Failures are kept per file id."""

    files_dir: Path | None = None
    cache_dir: Path | None = None
    download: bool = False
    token: str | None = None
    # 0 = the server's ATTACHMENT_MAX_BYTES (set by run_import): a fixed 100 MB here used to cap the
    # download even when an import run raised the limit (the lab's 592 MB videos, 2026-10-03).
    max_bytes: int = 0
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
            follow_redirects=False,  # by hand (_get): the token rule holds at every hop
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
        """The token goes only over HTTPS to Slack's file hosts (Review v0.1.22 #4)."""
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        allowed = any(host == h or host.endswith("." + h) for h in self.token_hosts)
        if self.token and parts.scheme == "https" and allowed:
            return {"Authorization": f"Bearer {self.token}"}
        return {}

    @asynccontextmanager
    async def _get(self, client: httpx.AsyncClient, url: str) -> AsyncIterator[httpx.Response]:
        """GET, following redirects by hand: every hop must be HTTPS (a plain-HTTP URL or
        redirect is refused before anything is sent to it) and gets the token only by _headers,
        so a redirect never carries it anywhere the first request could not."""
        for _ in range(MAX_REDIRECTS + 1):
            if urlsplit(url).scheme != "https":
                raise _Refused("HTTPS でない URL は取得しない")
            request = client.build_request("GET", url, headers=self._headers(url))
            response = await client.send(request, stream=True)
            if not response.is_redirect:
                break
            location = response.headers.get("location", "")
            await response.aclose()
            url = str(response.url.join(location))
        else:
            raise _Refused(f"転送が {MAX_REDIRECTS} 回を超えた")
        try:
            yield response
        finally:
            await response.aclose()

    async def _download(self, client: httpx.AsyncClient, f: dict[str, Any]) -> str | None:
        if not _FILE_ID.match(str(f.get("id") or "")):
            return "ファイル id が不正"
        url = f.get("url_private_download") or f.get("url_private")
        if not isinstance(url, str) or urlsplit(url).scheme not in ("https", "http"):
            return "ダウンロードの URL が無い"
        if urlsplit(url).scheme != "https":
            return "HTTPS でない URL は取得しない"
        size = f.get("size")
        if self.max_bytes and isinstance(size, int) and size > self.max_bytes:
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
                async with self._get(client, url) as response:
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
            except _Refused as exc:
                part.unlink(missing_ok=True)
                return str(exc)
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
                if self.max_bytes and written > self.max_bytes:
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
    emoji_dir: Path | None = None  # a folder or (M92) a ZIP of <name>.png …
    # M92: a bot's name → whose posts they are (parse_bot_target).
    bot_as: dict[str, str] = field(default_factory=dict)
    # M92: a Slack custom emoji name → the Taylis custom emoji name it becomes.
    emoji_renames: dict[str, str] = field(default_factory=dict)
    # M98: a bot (its bot_id, a post's username or bot_profile.name) → the display name of the
    # bot account made for it.
    bot_names: dict[str, str] = field(default_factory=dict)


class SlackImport(core.ImportJob):
    source = SOURCE
    source_label = "Slack"
    namespace = NAMESPACE
    name_suffix = "slack"
    username_from_email = True

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
        email_domain_map: dict[str, str] | None = None,
        activate_domains: Collection[str] = (),
    ) -> None:
        self.export = export
        self.files = files
        self.options = options
        self.raw_users: dict[str, dict[str, Any]] = {}
        self.bots_by_bot_id: dict[str, str] = {}  # Slack bot id → user id (users.json)
        # M92: --bot-as names (lower case, NFC) → the target as given; the posts found per name,
        # the label as the export wrote it, and the targets (checked by _people).
        self.bot_as = {nfc(k.strip().lower()): v for k, v in options.bot_as.items()}
        self.bot_as_posts: Counter[str] = Counter()
        self.bot_as_post_ids: dict[str, list[str]] = {}  # their post ids (an earlier run's sender)
        self.bot_as_labels: dict[str, str] = {}
        self.bot_targets: dict[str, BotTarget] = {}
        # M98: per made-up bot record (key "bot:<bot_id>"), the distinct usernames its posts carry
        # (in order), its bot_profile.name, and --bot-name (lower case, NFC → display name).
        self.bot_post_names: dict[str, list[str]] = {}
        self.bot_profile_names: dict[str, str] = {}
        self.bot_names = {nfc(k.strip().lower()): v.strip() for k, v in options.bot_names.items()}
        # M92: Slack emoji name → Taylis name, and back (a name may be the target of several).
        self.emoji_renames = {
            nfc(k.strip().strip(":")): v.strip().strip(":").lower()
            for k, v in options.emoji_renames.items()
        }
        self.renamed_from: dict[str, list[str]] = {}
        for old, new in sorted(self.emoji_renames.items()):
            self.renamed_from.setdefault(new, []).append(old)
        self._rename_pattern = (
            re.compile(
                r"(?<![A-Za-z0-9_:]):("
                + "|".join(re.escape(k) for k in sorted(self.emoji_renames, key=len, reverse=True))
                + r"):"
            )
            if self.emoji_renames
            else None
        )
        self.emoji_images: EmojiImages | None = None
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
            email_domain_map=email_domain_map,
            activate_domains=activate_domains,
        )
        self.names: dict[str, str] = {}  # Slack channel id → its name in ChikuwaChat
        self._prescan()
        unused = sorted(set(self.bot_as) - set(self.bot_as_posts))
        if unused:
            raise ImportFailed(
                f"--bot-as {unused[0]}=…: no bot post with that name (username / "
                "bot_profile.name) in the channels being imported"
            )
        self._name_bots()

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
                "deleted": bool(u.get("deleted")),
                "guest": bool(u.get("is_restricted") or u.get("is_ultra_restricted")),
            }
        return users

    def user_keys(self, record: dict[str, Any]) -> list[str]:
        raw = self.raw_users.get(record["id"], {})
        profile = raw.get("profile") or {}
        keys = [record["id"], record["username"], profile.get("display_name") or ""]
        keys += [record.get("email") or "", self.target_email(record) or ""]  # M91
        return list(dict.fromkeys(k.lower().lstrip("@") for k in keys if k))

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
                last = max(last, ts_to_us(message["ts"]))
                if self._bridge_join(message):  # M92: never a sender of its own
                    self.report.counts["bridge_join_skipped"] += 1
                    continue
                name = self._bot_as_name(message)
                if name is not None and self._importable(message):
                    self.bot_as_posts[name] += 1
                    self.bot_as_post_ids.setdefault(name, []).append(
                        f"{record['id']}:{message['ts']}"
                    )
                self._sender(message)
            if record["archived"]:
                record["delete_at"] = last

    def _name_bots(self) -> None:
        """M98: a made-up bot account is named after its posts' username, as before, unless one
        bot_id posted under several (the Slack RSS app names each post after its feed): then
        after its bot_profile.name, else what the names share ("週報"), else "Slack bot", and
        the report lists the names. ``--bot-name`` (bot_id, a username or the profile's name)
        sets the name outright."""
        used: set[str] = set()
        for key, names in sorted(self.bot_post_names.items()):
            record = self.users.get(key)
            if record is None or not record.get("is_bot") or not names:
                continue
            bot_id = key.removeprefix("bot:") if not key.startswith("bot:name:") else ""
            profile = self.bot_profile_names.get(key)
            labels = [bot_id, *names, profile or ""]
            chosen = next(
                (
                    (nfc(label.lower()), self.bot_names[nfc(label.lower())])
                    for label in labels
                    if label and nfc(label.lower()) in self.bot_names
                ),
                None,
            )
            if chosen is not None:
                used.add(chosen[0])
                name = chosen[1]
            elif len(names) > 1:
                name = profile or shared_bot_name(names) or "Slack bot"
                shown = "」「".join(names[:5]) + ("」…" if len(names) > 5 else "」")
                label = bot_id or names[0]
                self.report.warn(
                    f"bot {label}: {len(names)} 種類の名前で投稿 (「{shown})。"
                    f"bot アカウントの名前は「{name}」(--bot-name {label}=<名前> で指定)"
                )
            else:
                continue
            record["first_name"] = name[:80]
            record["last_name"] = record["nickname"] = ""
            username = slug(name)
            if USERNAME.match(username):
                record["username"] = username
        unused = sorted(set(self.bot_names) - used)
        if unused:
            raise ImportFailed(
                f"--bot-name {unused[0]}=…: no bot post with that bot_id / username / "
                "bot_profile.name in the channels being imported"
            )

    def _is_bot_post(self, message: dict[str, Any]) -> bool:
        """Posted by a bot (an integration or a bridge), not by a person of users.json."""
        if message.get("subtype") == "bot_message":
            return True
        user = message.get("user")
        profile = message.get("bot_profile") or {}
        has_bot = bool(message.get("bot_id") or profile.get("id"))
        return has_bot and not (isinstance(user, str) and user in self.raw_users)

    def _bridge_join(self, message: dict[str, Any]) -> bool:
        """A bridge's relayed join line (M92): a bot post that says only that someone joined.
        People's own posts are never taken for one."""
        text = message.get("text")
        return (
            isinstance(text, str)
            and self._is_bot_post(message)
            and BRIDGE_JOIN.match(text) is not None
        )

    def _bot_as_name(self, message: dict[str, Any]) -> str | None:
        """The ``--bot-as`` name of a bot post (its ``username``, else ``bot_profile.name``)."""
        if not self.bot_as or not self._is_bot_post(message):
            return None
        profile = message.get("bot_profile") or {}
        for label in (message.get("username"), profile.get("name")):
            if isinstance(label, str) and nfc(label.strip().lower()) in self.bot_as:
                key = nfc(label.strip().lower())
                self.bot_as_labels.setdefault(key, label.strip())
                return key
        return None

    @staticmethod
    def _importable(message: dict[str, Any]) -> bool:
        subtype = message.get("subtype")
        if message.get("type", "message") != "message" or subtype in SKIPPED_SUBTYPES:
            return False
        return not (
            subtype in DELETED_SUBTYPES or message.get("hidden") or message.get("is_deleted")
        )

    def _sender(self, message: dict[str, Any]) -> str | None:
        """The sender's user id (made up for bots and people users.json does not have)."""
        bot_as = self._bot_as_name(message)
        if bot_as is not None:
            return (BOT_AS_PREFIX + bot_as)[:64]  # a person: resolved by _people (M92)
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
            names = self.bot_post_names.setdefault(key, [])
            if label.strip() and label.strip() not in names:
                names.append(label.strip())
            if isinstance(profile.get("name"), str) and profile["name"].strip():
                self.bot_profile_names.setdefault(key, profile["name"].strip())
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
        if not self._importable(m) or self._bridge_join(m):
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
        text = self._rename_in_text(text)
        pin = channel["pins"].get(ts)
        pinned = channel["id"] in (m.get("pinned_to") or []) or pin is not None
        reactions = [
            {"user_id": u, "emoji_name": self._renamed(str(r["name"])), "create_at": created}
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

    def _renamed(self, name: str) -> str:
        """A reaction name after ``--emoji-rename`` (``完了::skin-tone-2`` keeps its tone)."""
        base, sep, tone = name.partition("::")
        new = self.emoji_renames.get(nfc(base))
        return f"{new}{sep}{tone}" if new is not None else name

    def _rename_in_text(self, text: str) -> str:
        """``:FROM:`` → ``:TO:`` outside code (where Slack shows the text as it is)."""
        pattern = self._rename_pattern
        if pattern is None or ":" not in text:
            return text

        def renamed(part: str) -> str:
            return pattern.sub(lambda m: f":{self.emoji_renames[m.group(1)]}:", part)

        text = nfc(text)
        out: list[str] = []
        last = 0
        for match in _CODE_SPAN.finditer(text):
            out += [renamed(text[last : match.start()]), match.group(0)]
            last = match.end()
        out.append(renamed(text[last:]))
        return "".join(out)

    def needed_user_ids(self) -> set[str]:
        needed = super().needed_user_ids()
        for record in self.channel_records:
            if record["channel_type"] in ("dm", "group_dm"):  # the people make the DM
                needed.update(m["user_id"] for m in record["members"])
        # M92: a bridge bot's posts are their target's: a Slack person gets an account for them.
        for key in [k for k in needed if k.startswith(BOT_AS_PREFIX)]:
            needed.discard(key)
            target = self.bot_targets.get(key)
            if target is not None and target.kind == "slack":
                needed.add(target.value)
        return needed

    # ---- people: bots that are people (M92) ------------------------------------------------

    def _resolve_bot_targets(self) -> None:
        """Each ``--bot-as`` target checked and, for a Slack person, found (by user id, username,
        display name or address, as ``--user`` finds them)."""
        owners: dict[str, set[str]] = {}
        for record in self.users.values():
            if record["id"].startswith("bot:"):
                continue
            for key in self.user_keys(record):
                owners.setdefault(nfc(key), set()).add(record["id"])
        for name, raw in sorted(self.bot_as.items()):
            target = parse_bot_target(name, raw)
            if target.kind == "slack":
                ids = owners.get(nfc(target.value), set())
                if not ids:
                    raise ImportFailed(
                        f"--bot-as {name}={raw}: no such Slack user in the file "
                        "(an existing Taylis user is @username, a new one new:<display name>)"
                    )
                if len(ids) > 1:
                    raise ImportFailed(
                        f"--bot-as {name}={raw}: several Slack users have that name; "
                        "give the user id"
                    )
                target = BotTarget("slack", next(iter(ids)))
            self.bot_targets[(BOT_AS_PREFIX + name)[:64]] = target

    async def _people(self) -> None:
        """The people (core), then the bridge bots as the people they stand for: a Slack person
        is the account the people step chose, so the targets are resolved after it."""
        self._resolve_bot_targets()
        await super()._people()
        refs = await self._refs("user")
        persons = await self._refs(BOT_AS_PERSON)
        for key, target in sorted(self.bot_targets.items()):
            await self._bot_person(key, target, refs, persons)

    async def _earlier_senders(self, name: str) -> set[uuid.UUID]:
        """Who the bot's posts that an earlier run imported were sent as (their messages'
        sender): the mapping of a run that did not store it yet (review v0.1.30 #2)."""
        ids = self.bot_as_post_ids.get(name, [])
        senders: set[uuid.UUID] = set()
        for start in range(0, len(ids), POST_REF_CHUNK):
            rows = await self.db.execute(
                select(Message.sender_id)
                .join(ImportRef, ImportRef.target_id == Message.id)
                .where(
                    ImportRef.source == self.source,
                    ImportRef.kind == "post",
                    ImportRef.source_id.in_(ids[start : start + POST_REF_CHUNK]),
                )
                .distinct()
            )
            senders.update(s for s in rows.scalars().all() if s is not None)
        return senders

    async def _username_of(self, user_id: uuid.UUID) -> str:
        user = await self.db.get(User, user_id)
        return f"@{user.username}" if user is not None else str(user_id)

    async def _bot_person(
        self,
        key: str,
        target: BotTarget,
        refs: dict[str, uuid.UUID],
        persons: dict[str, uuid.UUID],
    ) -> None:
        """A bridge bot's account. Review v0.1.30 #2: every mapping is kept in import_refs
        (``user``, plus ``bot_as_person`` when it is an existing person's), and a rerun whose
        target resolves to another account stops before anything is written, as ``--user``
        does: a name taken over by someone else after a rename never gets the newer posts. A run
        from before the mapping was stored is matched by the senders of the posts it imported."""
        name = key[len(BOT_AS_PREFIX) :]
        label = self.bot_as_labels.get(name, name)
        earlier = refs.get(key)
        stored = earlier is not None
        was_person = key in persons
        if earlier is None:
            senders = await self._earlier_senders(name)
            if len(senders) > 1:
                shown = ", ".join(sorted([await self._username_of(s) for s in senders]))
                raise ImportFailed(
                    f"--bot-as {name}: an earlier run imported its posts as several accounts "
                    f"({shown}); fix them by hand first"
                )
            if senders:
                earlier, was_person = next(iter(senders)), True
        user: User | None
        if target.kind in ("slack", "user"):
            if target.kind == "slack":
                person = self.people.get(target.value)
                if person is None:  # needed_user_ids asked for them
                    raise ImportFailed(
                        f"--bot-as {name}: the Slack user {target.value} got no account"
                    )
                user = await self.db.get(User, person.id)
                how = f"--bot-as, Slack {target.value}"
            else:
                user = await self._user_by_name(target.value)
                if user is None:
                    raise ImportFailed(f"--bot-as {name}=@{target.value}: no such Taylis user")
                how = "--bot-as"
            assert user is not None
            if earlier is not None and earlier != user.id:
                raise ImportFailed(
                    f"--bot-as {name}={self.bot_as[name]}: an earlier run imported its posts as "
                    f"{await self._username_of(earlier)}, not @{user.username} (give that account, "
                    "e.g. after a rename)"
                )
            if not stored and key not in persons:
                self._ref(BOT_AS_PERSON, key, user.id)
        else:
            if earlier is not None and was_person:
                raise ImportFailed(
                    f"--bot-as {name}=new:…: an earlier run imported its posts as "
                    f"{await self._username_of(earlier)} (give that account instead)"
                )
            user = await self.db.get(User, earlier) if earlier is not None else None
            if earlier is not None and user is None:
                raise ImportFailed(f"--bot-as {name}: imported before, now gone")
            how = "--bot-as, previous run"
            if user is None:
                record = {
                    "id": key,
                    "username": slug(name) or "bot-user",
                    "email": None,
                    "first_name": "",
                    "last_name": "",
                    "nickname": target.value,
                    "position": "",
                    "is_bot": False,
                    "guest": target.guest,
                }
                user = await self._new_account(
                    record, ACTION_GUEST if target.guest else ACTION_DEACTIVATED
                )
                self.report.counts["users_created"] += 1
                how = "--bot-as, new" + (" guest" if target.guest else "")
        if not stored:
            self._ref("user", key, user.id)
        assert user is not None
        self.people[key] = Person(
            user.id, user.username, user.is_active and user.role != "bot", user.is_guest
        )
        self.report.people.append(f"bot {label} → @{user.username} ({how})")
        self.report.people_rows.append(
            PersonRow(
                source_id=f"bot:{label}"[:64],
                name=f"{label} ({self.bot_as_posts[name]} posts)",
                source_email="",
                username=user.username,
                email=user.email or "",
                action=ACTION_BOT_AS,
            )
        )
        self.report.counts[f"people: {ACTION_BOT_AS}"] += 1

    # ---- before anything is written ------------------------------------------------------

    async def prepare(self) -> None:
        """Checks that need no writes, then the downloads (no transaction is held meanwhile):
        a channel name taken in ChikuwaChat stops the import here, with nothing written."""
        self._check_user_map()
        for target in sorted(set(self.user_map.values())):
            if await self._user_by_name(target) is None:
                raise ImportFailed(f"--user …={target}: no Taylis user {target}")
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
            raise ImportFailed(f"channels already exist in Taylis: {', '.join(clashes)}; {hint}")
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
        --emoji-dir has an image of that name (``<name>.png`` etc.). M92: a name renamed with
        --emoji-rename (the posts use the new name already) takes the old name's image, and a
        new name that is a custom emoji here already is reused. import_refs keeps Slack's name."""
        await super()._emoji()
        images = self.emoji_images
        if images is None and not self.emoji_renames:
            return
        refs = await self._refs("emoji")
        used: set[str] = set()
        for post in self.posts():
            used.update(r["emoji_name"].split("::", 1)[0].lower() for r in post["reactions"])
            used.update(_SHORTCODE_NAMES.findall(post["message"]))
            # also right after Japanese text ("了解:kanryo:"), which _SHORTCODE_NAMES skips
            used.update(n for n in self.renamed_from if f":{n}:" in post["message"])
        for name in sorted(used):
            froms = self.renamed_from.get(name, [])
            slack_name = froms[0] if froms else name
            label = f":{slack_name}: → :{name}:" if froms else f":{name}:"
            if slack_name in refs or name in refs:
                if froms:
                    self.report.emoji_lines.append(f"{label} imported before")
                continue
            if name in self.custom_emoji:
                if froms:
                    self.report.emoji_lines.append(f"{label} already a custom emoji here: reused")
                    self.report.counts["emoji_reused"] += 1
                continue
            if standard_glyph(name) is not None:
                if froms:
                    self.report.emoji_lines.append(f"{label} is a standard emoji")
                continue
            if not emoji_service.NAME.match(name):
                continue
            data = images.get(slack_name) if images is not None else None
            if data is None:
                if froms:
                    self.report.emoji_lines.append(
                        f"{label} no image of :{slack_name}: in --emoji-dir (kept as :{name}:)"
                    )
                continue
            emoji_id = await self._add_custom_emoji(name, data, self.actor.id)
            if emoji_id is not None:
                self._ref("emoji", slack_name, emoji_id)
                self.report.emoji_lines.append(f"{label} created")
                if froms:
                    self.report.counts["emoji_renamed"] += 1

    def reaction_emoji(self, name: str) -> str | None:
        """``+1::skin-tone-2`` is 👍🏼's glyph with the tone; a custom name drops the tone.
        M92: a keycap (``one`` 1️⃣ … ``zero``, ``hash`` #️⃣, ``asterisk``) begins with an ASCII
        character, which a reaction cannot (EMOJI_PATTERN): it stays ``:one:``, shown once a
        custom emoji of that name is added (``ten`` / ``keycap_ten`` 🔟 is a glyph as before)."""
        base, _, tone = name.lower().partition("::")
        glyph = standard_glyph(base)
        if base not in self.custom_emoji and glyph is not None:
            toned = with_skin_tone(glyph, tone.removeprefix("skin-tone-") or None)
            if REACTION.match(toned):
                return toned
            if REACTION.match(glyph):
                return glyph
            self.report.counts["reactions_keycap_as_name"] += 1
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
    email_domain_map: dict[str, str] | None = None,
    activate_domains: Collection[str] = (),
    people_only: bool = False,
) -> Report:
    """The import; ``people_only`` (M91) works out the people table and writes nothing: no
    channels, posts or files (the messages are still read, to know who posted)."""
    export = Export(export_path)
    images: EmojiImages | None = None
    try:
        actor = await active_admin(db, actor_username)
        for old, new in options.emoji_renames.items():
            if not emoji_service.NAME.match(new.strip().strip(":").lower()):
                raise ImportFailed(
                    f"--emoji-rename {old}={new}: not a custom emoji name "
                    "(a-z 0-9 _ + -, 2 to 32 characters)"
                )
        if options.emoji_dir is not None:
            if not options.emoji_dir.exists():
                raise ImportFailed(f"--emoji-dir {options.emoji_dir}: no such directory or ZIP")
            images = EmojiImages(options.emoji_dir)
        files.max_bytes = (
            min(files.max_bytes, settings.attachment_max_bytes)
            if files.max_bytes
            else settings.attachment_max_bytes
        )
        job = SlackImport(
            db,
            export,
            files=files,
            options=options,
            user_map=user_map,
            actor=actor,
            blobs=blobs,
            settings=settings,
            dry_run=dry_run or people_only,
            email_domain_map=email_domain_map,
            activate_domains=activate_domains,
        )
        job.emoji_images = images
        if people_only:
            return await job.people_preview()
        await job.prepare()
        return await job.run()
    finally:
        export.close()
        if images is not None:
            images.close()
