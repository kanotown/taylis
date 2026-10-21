"""Where a Nextcloud import reads from (M164, docs/DRIVE.md §15): Nextcloud's WebDAV with an app
password, or a copy of a user's data directory (``data/<user>/files``).

Both give the same entries: a path below the user's root (``/研究室共有/a.pdf``, NFC), file or
folder, the size, the modification time (whole seconds, UTC) and the owner's Nextcloud user id
when known. A walk goes depth first, a folder before what is in it, names in code point order,
and descends only into folders the caller wants (the mapping); a folder it does not descend
into is reported with its size (WebDAV ``oc:size``, or the files counted on disk).

WebDAV: one ``PROPFIND`` with ``Depth: 1`` per folder (``Depth: infinity`` is off on most
servers), asking for Nextcloud's paged answers (``X-NC-Paginate``) and following them when the
server pages. The credentials go in the ``Authorization`` header only; they are never part of a
URL, an exception text or a log line (``httpx`` logs nothing below WARNING while this runs).
"""

import asyncio
import logging
import os
import posixpath
import stat
import unicodedata
import xml.etree.ElementTree as ET
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote, unquote, urlsplit

import httpx
from starlette.concurrency import run_in_threadpool

log = logging.getLogger("app.importer.nextcloud")

CHUNK = 1024 * 1024
PAGE = 1000  # entries per paged PROPFIND answer
DAV = "{DAV:}"
OC = "{http://owncloud.org/ns}"
PROPFIND_BODY = (
    b'<?xml version="1.0" encoding="utf-8"?>'
    b'<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">'
    b"<d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><oc:size/>"
    b"<oc:owner-id/></d:prop></d:propfind>"
)
# Left-overs of Nextcloud's own uploads in a data directory, never user files.
_PARTIAL = (".ocTransferId",)


class SourceError(Exception):
    """The source cannot be read (an HTTP error, a missing directory); the text has no secret."""


@dataclass(frozen=True)
class Entry:
    path: str  # "/a/b.pdf" below the user's root, NFC; "" is never an entry
    kind: str  # "file" | "folder"
    size: int  # a folder: the bytes in it when known (oc:size), else 0
    mtime: datetime | None  # whole seconds, UTC
    owner: str | None = None  # the Nextcloud user id of the owner (WebDAV oc:owner-id)
    # The path as the source has it (not normalised: a server may keep NFD names), for reading.
    source_path: str = ""
    invalid_text: bool = False  # a data directory's name that is not UTF-8 (shown with U+FFFD)

    @property
    def name(self) -> str:
        return self.path.rsplit("/", 1)[-1]


@dataclass
class Unvisited:
    """A folder the walk did not go into (nothing in the mapping wants it, or a skip rule)."""

    path: str
    size: int
    files: int | None  # counted only for a data directory


@dataclass
class Walk:
    entries: list[Entry] = field(default_factory=list)
    unvisited: list[Unvisited] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)  # (path, why)


def nfc_path(path: str) -> str:
    return unicodedata.normalize("NFC", path)


def whole_seconds(at: datetime | None) -> datetime | None:
    if at is None:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=UTC)
    return at.astimezone(UTC).replace(microsecond=0)


class Source(Protocol):
    label: str  # the Nextcloud user whose files these are (part of every import key)

    async def walk(self, descend: Callable[[str], bool]) -> Walk:
        """Every entry below the root; `descend(folder_path)` says whether to go into one."""
        ...

    def open(self, path: str) -> Any:
        """``async with source.open(path) as chunks``: the file's bytes."""
        ...

    async def close(self) -> None: ...


# --- a data directory ---------------------------------------------------------------------------


class DataDirSource:
    """``data/<user>/files`` of a Nextcloud server (a copy, or the real one read-only). The label
    is ``<user>`` (the directory above ``files``) unless given."""

    def __init__(self, root: Path, label: str | None = None) -> None:
        if not root.is_dir():
            raise SourceError(f"{root}: not a directory")
        self.root = root
        if label is None:
            label = root.parent.name if root.name == "files" else root.name
        self.label = label

    def _local(self, path: str) -> Path:
        return self.root / path.lstrip("/")

    async def walk(self, descend: Callable[[str], bool]) -> Walk:
        return await run_in_threadpool(self._walk, descend)

    def _walk(self, descend: Callable[[str], bool]) -> Walk:
        out = Walk()
        self._visit(self.root, "", descend, out)
        return out

    def _visit(
        self, folder: Path, path: str, descend: Callable[[str], bool], out: Walk, raw: str = ""
    ) -> None:
        try:
            with os.scandir(folder) as it:
                found = sorted(it, key=lambda e: nfc_path(e.name))
        except OSError as exc:
            out.skipped.append((path or "/", f"cannot be read ({exc.strerror})"))
            return
        for item in found:
            name = nfc_path(item.name)
            bad = any(0xDC80 <= ord(c) <= 0xDCFF for c in name)  # not UTF-8 on disk
            if bad:
                name = name.encode("utf-8", "surrogateescape").decode("utf-8", "replace")
            child = f"{path}/{name}"
            raw_child = f"{raw}/{item.name}"
            try:
                info = item.stat(follow_symlinks=False)
            except OSError as exc:
                out.skipped.append((child, f"cannot be read ({exc.strerror})"))
                continue
            mtime = whole_seconds(datetime.fromtimestamp(info.st_mtime, tz=UTC))
            if stat.S_ISLNK(info.st_mode):
                out.skipped.append((child, "a symbolic link"))
            elif stat.S_ISDIR(info.st_mode):
                if descend(child):
                    out.entries.append(Entry(child, "folder", 0, mtime, self.label, raw_child, bad))
                    self._visit(Path(item.path), child, descend, out, raw_child)
                else:
                    size, files = _du(Path(item.path))
                    out.unvisited.append(Unvisited(child, size, files))
            elif stat.S_ISREG(info.st_mode):
                if name.startswith(_PARTIAL) and name.endswith(".part"):
                    out.skipped.append((child, "an unfinished Nextcloud upload (.part)"))
                    continue
                out.entries.append(
                    Entry(child, "file", info.st_size, mtime, self.label, raw_child, bad)
                )
            else:
                out.skipped.append((child, "not a regular file"))

    @asynccontextmanager
    async def open(self, path: str) -> AsyncIterator[AsyncIterator[bytes]]:
        local = self._local(path)
        try:
            handle = await run_in_threadpool(local.open, "rb")
        except OSError as exc:
            raise SourceError(f"{path}: cannot be opened ({exc.strerror})") from exc

        async def chunks() -> AsyncIterator[bytes]:
            while True:
                data = await run_in_threadpool(handle.read, CHUNK)
                if not data:
                    return
                yield data

        try:
            yield chunks()
        finally:
            handle.close()

    async def close(self) -> None:
        return None


def _du(folder: Path) -> tuple[int, int]:
    size = files = 0
    for top, _dirs, names in os.walk(folder):
        for name in names:
            try:
                info = os.lstat(os.path.join(top, name))
            except OSError:
                continue
            if stat.S_ISREG(info.st_mode):
                size += info.st_size
                files += 1
    return size, files


# --- WebDAV --------------------------------------------------------------------------------------


def _check_url(url: str) -> tuple[str, str]:
    """(the URL with a trailing slash, its path unquoted). A URL carrying credentials is refused:
    they would end up in logs and in the shell history."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise SourceError("--webdav must be an http(s) URL")
    if parts.username or parts.password:
        raise SourceError("--webdav must not contain a user or password (use --webdav-user)")
    if parts.query or parts.fragment:
        raise SourceError("--webdav must not have a query or a fragment")
    path = parts.path if parts.path.endswith("/") else parts.path + "/"
    base = f"{parts.scheme}://{parts.netloc}{path}"
    return base, unquote(path)


def server_root(webdav_url: str) -> str:
    """https://cloud/…/remote.php/dav/files/kano/ → https://cloud/… (for the OCS API)."""
    parts = urlsplit(webdav_url)
    path = parts.path
    for marker in ("/remote.php/", "/public.php/"):
        if marker in path:
            path = path.split(marker, 1)[0]
            break
    return f"{parts.scheme}://{parts.netloc}{path.rstrip('/')}"


def user_from_url(base_path: str) -> str | None:
    """The user of …/remote.php/dav/files/<user>/ (the label), if the URL has that shape."""
    segments = [s for s in base_path.split("/") if s]
    for i, segment in enumerate(segments[:-1]):
        if segment == "files" and i > 0 and segments[i - 1] == "dav":
            return segments[i + 1]
    return None


def _text(element: ET.Element | None) -> str | None:
    if element is None or element.text is None:
        return None
    return element.text.strip()


def parse_multistatus(body: bytes) -> list[dict[str, Any]]:
    """The <d:response> elements of a PROPFIND answer: href (unquoted path), folder, size,
    mtime, owner. Properties a server did not have (a 404 propstat) are None."""
    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        raise SourceError(f"the WebDAV answer is not XML ({exc})") from exc
    out: list[dict[str, Any]] = []
    for response in root.iter(f"{DAV}response"):
        href = _text(response.find(f"{DAV}href"))
        if href is None:
            continue
        props: dict[str, ET.Element] = {}
        for propstat in response.findall(f"{DAV}propstat"):
            status = _text(propstat.find(f"{DAV}status")) or ""
            if " 200 " not in f"{status} ":
                continue
            prop = propstat.find(f"{DAV}prop")
            if prop is not None:
                for child in prop:
                    props[child.tag] = child
        resourcetype = props.get(f"{DAV}resourcetype")
        folder = resourcetype is not None and resourcetype.find(f"{DAV}collection") is not None
        length = _text(props.get(f"{DAV}getcontentlength"))
        oc_size = _text(props.get(f"{OC}size"))
        modified = _text(props.get(f"{DAV}getlastmodified"))
        mtime = None
        if modified:
            try:
                mtime = whole_seconds(parsedate_to_datetime(modified))
            except (TypeError, ValueError):
                mtime = None
        size = 0
        for value in (length, oc_size) if not folder else (oc_size, length):
            if value and value.lstrip("-").isdigit():
                size = max(int(value), 0)
                break
        out.append(
            {
                "href": unquote(urlsplit(href).path),
                "folder": folder,
                "size": size,
                "mtime": mtime,
                "owner": _text(props.get(f"{OC}owner-id")),
            }
        )
    return out


class WebDavSource:
    def __init__(
        self,
        url: str,
        user: str,
        password: str,
        *,
        label: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 60.0,
        page: int = PAGE,
    ) -> None:
        self.base, self.base_path = _check_url(url)
        if not user or not password:
            raise SourceError("WebDAV needs a user and an app password")
        self.label = label or user_from_url(self.base_path) or user
        self.page = page
        self.client = httpx.AsyncClient(
            auth=httpx.BasicAuth(user, password),
            transport=transport,
            timeout=httpx.Timeout(timeout, connect=15.0),
            follow_redirects=False,
            headers={"User-Agent": "Taylis import-nextcloud"},
        )
        self.requests = 0  # PROPFINDs sent (the tests count them)

    def url_of(self, path: str) -> str:
        return self.base + quote(path.lstrip("/"), safe="/")

    async def close(self) -> None:
        await self.client.aclose()

    async def _propfind(self, path: str) -> list[dict[str, Any]]:
        """One folder's children (Depth 1), all pages. The folder's own response is dropped."""
        url = self.url_of(path + "/" if path else "")
        headers = {
            "Depth": "1",
            "Content-Type": "application/xml; charset=utf-8",
            "X-NC-Paginate": "true",
            "X-NC-Paginate-Count": str(self.page),
        }
        seen: dict[str, dict[str, Any]] = {}
        offset = 0
        token: str | None = None
        total = 0
        while True:
            send = dict(headers)
            if token is not None:
                send["X-NC-Paginate-Token"] = token
                send["X-NC-Paginate-Offset"] = str(offset)
            response = await self._request("PROPFIND", url, headers=send, content=PROPFIND_BODY)
            if response.status_code != 207:
                raise SourceError(f"PROPFIND {path or '/'}: HTTP {response.status_code}")
            rows = parse_multistatus(response.content)
            for row in rows:
                seen.setdefault(row["href"], row)
            offset += len(rows)
            # Paged (Nextcloud's PaginatePlugin, checked on Nextcloud 31): only the first answer
            # has the token of the cached listing and the total (every response, the folder's
            # own included); the next pages are asked for with the token and an offset.
            if token is None:
                token = response.headers.get("X-NC-Paginate-Token")
                count = response.headers.get("X-NC-Paginate-Total", "")
                if not token or not count.isdigit():
                    break  # not paged: the whole listing came at once
                total = int(count)
            if not rows or offset >= total:
                break
        own = self.base_path + path.lstrip("/")
        own = own.rstrip("/")
        children = []
        for href, row in seen.items():
            if href.rstrip("/") == own:
                continue
            if not href.startswith(self.base_path):
                continue
            children.append(row)
        return children

    async def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        self.requests += 1
        for attempt in range(3):
            try:
                return await self.client.request(method, url, **kwargs)
            except httpx.TransportError as exc:
                if attempt == 2:
                    raise SourceError(f"{method} failed: {type(exc).__name__}") from None
                await asyncio.sleep(2 * (attempt + 1))
        raise AssertionError  # unreachable

    async def walk(self, descend: Callable[[str], bool]) -> Walk:
        out = Walk()
        await self._visit("", descend, out, "")
        return out

    async def _visit(self, path: str, descend: Callable[[str], bool], out: Walk, raw: str) -> None:
        rows = await self._propfind(raw)
        listed = []
        for row in rows:
            rel = row["href"][len(self.base_path) :].rstrip("/")
            name = rel.rsplit("/", 1)[-1]
            if not name:
                continue
            listed.append((nfc_path(name), row))
        listed.sort(key=lambda pair: pair[0])
        for name, row in listed:
            child = f"{path}/{name}"
            raw_child = "/" + row["href"][len(self.base_path) :].strip("/")
            if row["folder"]:
                if descend(child):
                    out.entries.append(
                        Entry(child, "folder", row["size"], row["mtime"], row["owner"], raw_child)
                    )
                    await self._visit(child, descend, out, raw_child)
                else:
                    out.unvisited.append(Unvisited(child, row["size"], None))
            else:
                if name.startswith(_PARTIAL) and name.endswith(".part"):
                    out.skipped.append((child, "an unfinished Nextcloud upload (.part)"))
                    continue
                out.entries.append(
                    Entry(child, "file", row["size"], row["mtime"], row["owner"], raw_child)
                )

    @asynccontextmanager
    async def open(self, path: str) -> AsyncIterator[AsyncIterator[bytes]]:
        url = self.url_of(path)
        try:
            request = self.client.build_request("GET", url)
            response = await self.client.send(request, stream=True)
        except httpx.TransportError as exc:
            raise SourceError(f"GET {path}: {type(exc).__name__}") from None
        try:
            if response.status_code != 200:
                raise SourceError(f"GET {path}: HTTP {response.status_code}")

            async def chunks() -> AsyncIterator[bytes]:
                try:
                    async for data in response.aiter_bytes(CHUNK):
                        yield data
                except httpx.TransportError as exc:
                    raise SourceError(f"GET {path}: {type(exc).__name__}") from None

            yield chunks()
        finally:
            await response.aclose()

    async def list_shares(self) -> list[dict[str, Any]]:
        """The shares the user made and the ones made with them (OCS, read only)."""
        root = server_root(self.base)
        url = f"{root}/ocs/v2.php/apps/files_sharing/api/v1/shares"
        out: list[dict[str, Any]] = []
        for params, direction in (
            ({"format": "json", "reshares": "true"}, "by me"),
            ({"format": "json", "shared_with_me": "true"}, "with me"),
        ):
            response = await self._request(
                "GET", url, params=params, headers={"OCS-APIRequest": "true"}
            )
            if response.status_code != 200:
                raise SourceError(f"the OCS shares API answered HTTP {response.status_code}")
            try:
                data = response.json()["ocs"]["data"]
            except (ValueError, KeyError, TypeError) as exc:
                raise SourceError("the OCS shares API did not answer JSON") from exc
            for share in data or []:
                out.append(share_row(share, direction))
        return out


SHARE_TYPES = {
    0: "user",
    1: "group",
    3: "public link",
    4: "e-mail",
    6: "federated",
    7: "circle",
    10: "talk room",
    12: "deck",
}


def share_row(share: dict[str, Any], direction: str) -> dict[str, Any]:
    """One share for the --list-shares table (no token, no URL, no password)."""
    kind = SHARE_TYPES.get(int(share.get("share_type", -1)), str(share.get("share_type")))
    who = share.get("share_with_displayname") or share.get("share_with") or ""
    if kind == "public link":
        who = share.get("label") or ""
    permissions = int(share.get("permissions") or 0)
    rights = "".join(
        letter
        for bit, letter in ((1, "r"), (2, "w"), (4, "c"), (8, "d"), (16, "s"))
        if permissions & bit
    )
    path = share.get("path") or ""
    if direction == "with me":
        path = share.get("file_target") or path
    return {
        "direction": direction,
        "path": nfc_path(str(path)),
        "item": share.get("item_type") or "",
        "type": kind,
        "with": str(who),
        "owner": str(share.get("uid_owner") or ""),
        "permissions": rights,
        "expires": str(share.get("expiration") or "")[:10],
        "password": bool(share.get("password")) or bool(share.get("send_password_by_talk")),
    }


def iter_paths(path: str) -> Iterator[str]:
    """/a/b/c → /a, /a/b, /a/b/c."""
    segments = [s for s in path.split("/") if s]
    for i in range(1, len(segments) + 1):
        yield "/" + "/".join(segments[:i])


def parent_of(path: str) -> str:
    parent = posixpath.dirname(path)
    return "" if parent == "/" else parent
