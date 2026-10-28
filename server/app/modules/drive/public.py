"""External share links, the public side (docs/DRIVE.md §5.4, §9.3, phase D4, M163).

`/api/v1/shares/{token}/…` needs no sign-in: the token in the path is the whole credential, so

- every request finds the link by the token's SHA-256 and checks it works now (shares.link_state);
  an unknown token is 404 share_link_not_found, any other link that does not work is 410
  share_link_unavailable (never why);
- an item is reachable only by id, and only when it is the shared item itself or under it, not in
  the trash (`shared_item`: the item's chain of ancestors, a recursive CTE, must reach the shared
  item); anything else is 404 drive_item_not_found, whatever exists;
- a password link answers nothing but 401 share_password_required until the browser holds the
  unlock cookie (`taylis_share`: the link's id, its password version and an expiry, signed with a
  key derived from SECRET_KEY; HttpOnly, SameSite=Lax, Path=/api/v1/shares/<token>);
- downloads (a file's bytes, a ZIP) count against the link's limit with one conditional UPDATE, so
  two at once never pass it; listings, thumbnails and previews do not count. A ranged request from
  byte 0 counts; a resumed one (a later start) counts unless this address already downloaded this
  version of the file through this link within a day (`ShareResumes`), so ranges cannot be used to
  read a limited file without being counted;
- the rate limits of §9.4 apply per address and per link; an address that keeps trying unknown or
  stopped links is refused (429) before any lookup, so a 429 tells nothing about a token;
- what happened is written to drive_share_events (open, download, zip, password_failed, refused).

The headers every answer here carries (noindex, no-referrer, nosniff, no framing, no-store) are set
by `ShareHeadersMiddleware`, error answers included.
"""

import hashlib
import hmac
import ipaddress
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from email.utils import format_datetime
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.errors import AppError, rate_limited
from app.core.ratelimit import RateLimiter
from app.core.security import verify_password
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.attachments import service as attachments
from app.modules.attachments.models import Attachment
from app.modules.attachments.schemas import to_attachment_out
from app.modules.attachments.videos import is_video
from app.modules.drive import album_cards, names, service, shares, tree, zips, zipstream
from app.modules.drive import repository as repo
from app.modules.drive.access import item_not_found
from app.modules.drive.models import (
    DriveAlbum,
    DriveFileVersion,
    DriveItem,
    DriveShareEvent,
    DriveShareLink,
)
from app.modules.drive.schemas import (
    DriveCrumb,
    SharedAlbumOut,
    SharedChildrenOut,
    SharedItemOut,
    ShareInfoOut,
)
from app.modules.users.models import User

COOKIE = "taylis_share"
PREFIX = "/api/v1/shares/"
MAX_TOKEN = 100
# A resumed (ranged) download of a version this address already downloaded is not counted again
# within this long.
RESUME_SECONDS = 24 * 3600.0

# Every answer of the public API (§9.1): kept out of search engines, never framed, no referrer,
# no caching anywhere, never sniffed.
PUBLIC_HEADERS: tuple[tuple[bytes, bytes], ...] = (
    (b"x-robots-tag", b"noindex, nofollow, noarchive"),
    (b"referrer-policy", b"no-referrer"),
    (b"x-frame-options", b"DENY"),
    (b"x-content-type-options", b"nosniff"),
)


class ShareHeadersMiddleware:
    """Adds PUBLIC_HEADERS (and no-store, and a sandboxing CSP when the route set none) to every
    answer under /api/v1/shares/, the errors too."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not str(scope.get("path") or "").startswith(PREFIX):
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [
                    (k, v)
                    for k, v in (message.get("headers") or [])
                    if k.lower() not in {name for name, _ in PUBLIC_HEADERS}
                    and k.lower() != b"cache-control"
                ]
                headers += list(PUBLIC_HEADERS)
                headers.append((b"cache-control", b"no-store"))
                if not any(k.lower() == b"content-security-policy" for k, _ in headers):
                    headers.append(
                        (
                            b"content-security-policy",
                            b"default-src 'none'; frame-ancestors 'none'; sandbox",
                        )
                    )
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_wrapper)


@dataclass
class ShareResumes:
    """Which address downloaded which version through which link lately (in this process's
    memory, as SHA-256 keys): its resumed range requests are not counted again."""

    clock: Any = time.monotonic
    seconds: float = RESUME_SECONDS
    _seen: dict[bytes, float] = field(default_factory=dict)

    @staticmethod
    def _key(link_id: uuid.UUID, version_id: uuid.UUID, ip: str) -> bytes:
        return hashlib.sha256(f"{link_id}|{version_id}|{ip}".encode()).digest()

    def grant(self, link_id: uuid.UUID, version_id: uuid.UUID, ip: str) -> None:
        now = self.clock()
        if len(self._seen) > 50_000:
            self._seen = {k: v for k, v in self._seen.items() if v > now}
        self._seen[self._key(link_id, version_id, ip)] = now + self.seconds

    def has(self, link_id: uuid.UUID, version_id: uuid.UUID, ip: str) -> bool:
        until = self._seen.get(self._key(link_id, version_id, ip))
        return until is not None and until > self.clock()


def limiters(settings: Settings) -> dict[str, RateLimiter]:
    """§9.4's limits (app.state.limiters)."""
    attempts = settings.drive_share_password_attempts_per_link
    return {
        "share_ip": RateLimiter(settings.drive_share_rate_limit_per_ip),
        "share_bad": RateLimiter(settings.drive_share_bad_rate_limit_per_ip),
        "share_download": RateLimiter(settings.drive_share_download_rate_limit_per_link),
        # 10 tries in 10 minutes: a burst of 10, then one a minute.
        "share_unlock_link": RateLimiter(attempts / 10, burst=attempts),
        "share_unlock_ip": RateLimiter(settings.drive_share_password_rate_limit_per_ip),
        "drive_link_create": RateLimiter(settings.drive_link_create_rate_limit_per_user),
    }


def client_ip(request: Request) -> str:
    return (request.client.host[:45] if request.client else None) or "unknown"


def _limiter(request: Request, name: str) -> RateLimiter:
    found: RateLimiter = request.app.state.limiters[name]
    return found


def _throttle(request: Request, name: str, key: str) -> None:
    limiter = _limiter(request, name)
    if not limiter.try_acquire(key):
        raise rate_limited(limiter.retry_after_seconds(key))


def _inet(value: str) -> str | None:
    """The address as the inet column takes it, or None (a proxy that passed something else must
    not turn a download into a 500)."""
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return None


def _event(
    db: AsyncSession,
    request: Request,
    link: DriveShareLink,
    kind: str,
    *,
    item_id: uuid.UUID | None = None,
    size: int | None = None,
) -> None:
    agent = request.headers.get("user-agent")
    db.add(
        DriveShareEvent(
            link_id=link.id,
            item_id=item_id,
            kind=kind,
            bytes=size,
            ip=_inet(client_ip(request)),
            user_agent=agent[:200] if agent else None,
        )
    )


# --- the link and its password -------------------------------------------------------------------


@dataclass
class Visit:
    link: DriveShareLink
    item: DriveItem
    token: str


async def open_link(request: Request, db: AsyncSession, token: str) -> Visit:
    ip = client_ip(request)
    _throttle(request, "share_ip", ip)
    bad = _limiter(request, "share_bad")
    if not bad.has_token(ip):
        raise rate_limited(bad.retry_after_seconds(ip))
    link: DriveShareLink | None = None
    if 0 < len(token) <= MAX_TOKEN:
        link = (
            await db.execute(
                select(DriveShareLink).where(DriveShareLink.token_hash == shares.token_hash(token))
            )
        ).scalar_one_or_none()
    if link is None:
        bad.try_acquire(ip)
        raise shares.link_not_found()
    resolved = await shares.link_state(db, link)
    if resolved.state != "active" or resolved.item is None:
        bad.try_acquire(ip)
        if resolved.state == "exhausted":
            _event(db, request, link, "refused")
            await db.commit()
        raise shares.link_unavailable()
    return Visit(link=link, item=resolved.item, token=token)


def _key(settings: Settings) -> bytes:
    return hmac.new(
        settings.secret_key.encode(), b"taylis-drive-share-unlock", hashlib.sha256
    ).digest()


def unlock_value(settings: Settings, link: DriveShareLink, *, now: float | None = None) -> str:
    expires = int((now or time.time()) + settings.drive_share_unlock_hours * 3600)
    message = f"{link.id}.{link.password_version}.{expires}"
    mac = hmac.new(_key(settings), message.encode(), hashlib.sha256).hexdigest()
    return f"{message}.{mac}"


def unlock_valid(settings: Settings, link: DriveShareLink, value: str | None) -> bool:
    if not value or len(value) > 200:
        return False
    parts = value.split(".")
    if len(parts) != 4:
        return False
    link_id, version, expires, mac = parts
    message = f"{link_id}.{version}.{expires}"
    wanted = hmac.new(_key(settings), message.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(wanted, mac):
        return False
    try:
        return (
            link_id == str(link.id)
            and int(version) == link.password_version
            and int(expires) > time.time()
        )
    except ValueError:
        return False


def unlocked(request: Request, link: DriveShareLink) -> bool:
    if link.password_hash is None:
        return True
    return unlock_valid(request.app.state.settings, link, request.cookies.get(COOKIE))


def require_unlocked(request: Request, visit: Visit) -> None:
    if not unlocked(request, visit.link):
        raise AppError(401, "share_password_required", "This link needs its password")


async def unlock(
    request: Request, response: Response, db: AsyncSession, token: str, password: str
) -> None:
    visit = await open_link(request, db, token)
    link = visit.link
    if link.password_hash is None:
        return
    ip = client_ip(request)
    for name, key in (("share_unlock_link", str(link.id)), ("share_unlock_ip", ip)):
        limiter = _limiter(request, name)
        if not limiter.try_acquire(key):
            _event(db, request, link, "refused")
            await db.commit()
            raise rate_limited(limiter.retry_after_seconds(key))
    if not await verify_password(link.password_hash, password):
        _event(db, request, link, "password_failed")
        await db.commit()
        raise AppError(401, "share_password_invalid", "Wrong password")
    settings: Settings = request.app.state.settings
    secure = (request.headers.get("x-forwarded-proto") or request.url.scheme) == "https"
    response.set_cookie(
        COOKIE,
        unlock_value(settings, link),
        max_age=settings.drive_share_unlock_hours * 3600,
        path=f"{PREFIX}{token}",
        httponly=True,
        secure=secure,
        samesite="lax",
    )


# --- items under the link ------------------------------------------------------------------------


async def shared_item(db: AsyncSession, visit: Visit, item_id: uuid.UUID) -> DriveItem:
    """The shared item or one under it, outside the trash; else 404 (whatever exists)."""
    root = visit.item
    if item_id == root.id:
        return root
    item = await repo.item(db, item_id)
    if item is None or item.trashed_at is not None or item.location_id != root.location_id:
        raise item_not_found()
    chain = await repo.ancestor_ids(db, item.id)
    if root.id not in chain:
        raise item_not_found()
    between = chain[chain.index(root.id) :]
    rows = await repo.items(db, between)
    if any(row.trashed_at is not None for row in rows.values()) or len(rows) != len(between):
        raise item_not_found()
    return item


async def _shown(db: AsyncSession, rows: list[DriveItem]) -> list[SharedItemOut]:
    files = await repo.current_files(
        db, [r.current_version_id for r in rows if r.current_version_id is not None]
    )
    out: list[SharedItemOut] = []
    for row in rows:
        found = files.get(row.current_version_id) if row.current_version_id else None
        attachment = found[1] if found is not None else None
        shown = to_attachment_out(attachment) if attachment is not None else None
        out.append(
            SharedItemOut(
                id=row.id,
                kind=row.kind,  # type: ignore[arg-type]
                name=row.name,
                size_bytes=row.size_bytes,
                content_type=row.content_type,
                modified_at=row.content_modified_at or row.updated_at,
                has_thumbnail=bool(shown and shown.has_thumbnail),
                width=shown.width if shown else None,
                height=shown.height if shown else None,
                preview=shown.preview if shown else None,
                has_display=attachment is not None and attachment.display_key is not None,
                display_width=attachment.display_width if attachment else None,
                display_height=attachment.display_height if attachment else None,
                taken_at=attachment.taken_at if attachment else None,
                has_poster=bool(shown and shown.has_poster),
                duration_ms=shown.duration_ms if shown else None,
            )
        )
    return out


async def _album(db: AsyncSession, folder: DriveItem) -> SharedAlbumOut | None:
    if folder.kind != "folder":
        return None
    row = await db.get(DriveAlbum, folder.id)
    if row is None:
        return None
    return album_cards.shared((await album_cards.outs(db, [row]))[row.folder_id])


def originals_disabled() -> AppError:
    return AppError(
        403,
        "share_originals_disabled",
        "This link shares display-size images only; the original files cannot be downloaded",
    )


async def info(request: Request, db: AsyncSession, token: str) -> ShareInfoOut:
    visit = await open_link(request, db, token)
    link = visit.link
    settings: Settings = request.app.state.settings
    is_open = unlocked(request, link)
    left = None if link.max_downloads is None else max(0, link.max_downloads - link.download_count)
    out = ShareInfoOut(
        kind=visit.item.kind if is_open else None,  # type: ignore[arg-type]
        password_required=link.password_hash is not None,
        unlocked=is_open,
        expires_at=link.expires_at,
        downloads_left=left,
        root_id=visit.item.id if is_open else None,
        item=(await _shown(db, [visit.item]))[0] if is_open else None,
        workspace_name=settings.workspace_display_name,
        originals=link.originals if is_open else None,
        album=await _album(db, visit.item) if is_open else None,
    )
    if is_open:
        _event(db, request, link, "open", item_id=visit.item.id)
        link.last_used_at = utcnow()
        await db.commit()
    return out


async def children(
    request: Request,
    db: AsyncSession,
    token: str,
    folder_id: uuid.UUID,
    *,
    cursor: str | None,
    limit: int,
    sort: str | None = None,
    order: str | None = None,
) -> SharedChildrenOut:
    """Folders first, then files: by name, or (AL1) in an album's order (`sort` / `order`
    override; an album folder takes its own when they are left out)."""
    visit = await open_link(request, db, token)
    require_unlocked(request, visit)
    folder = await shared_item(db, visit, folder_id)
    if folder.kind != "folder":
        raise item_not_found()
    album_row = await db.get(DriveAlbum, folder.id)
    chosen = sort or (album_row.sort if album_row is not None else "name")
    direction = order or (album_row.sort_order if album_row is not None and not sort else "asc")
    rows, next_cursor = await service.children_page(
        db,
        folder.id,
        sort=chosen,  # type: ignore[arg-type]
        order=direction,  # type: ignore[arg-type]
        cursor=cursor,
        limit=limit,
    )
    chain = await repo.ancestor_ids(db, folder.id)
    below = chain[chain.index(visit.item.id) :]
    crumbs = await repo.items(db, below)
    return SharedChildrenOut(
        folder=(await _shown(db, [folder]))[0],
        path=[
            DriveCrumb(
                id=i,
                name=crumbs[i].name,
                system_role=crumbs[i].system_role,  # type: ignore[arg-type]
            )
            for i in below
            if i in crumbs
        ],
        items=await _shown(db, rows),
        next_cursor=next_cursor,
        album=await _album(db, folder),
    )


async def _current(db: AsyncSession, item: DriveItem) -> tuple[DriveFileVersion, Attachment]:
    if item.kind != "file" or item.current_version_id is None:
        raise item_not_found()
    version = await db.get(DriveFileVersion, item.current_version_id)
    if version is None:
        raise item_not_found()
    attachment = await db.get(Attachment, version.attachment_id)
    if attachment is None or attachment.status == "deleted":
        raise item_not_found()
    return version, attachment


async def _count(db: AsyncSession, link: DriveShareLink) -> bool:
    """One download more, unless the link is used up (or stopped) meanwhile: the condition is in
    the UPDATE itself, so concurrent downloads never pass the limit."""
    now = utcnow()
    counted = await db.execute(
        update(DriveShareLink)
        .where(
            DriveShareLink.id == link.id,
            DriveShareLink.revoked_at.is_(None),
            or_(DriveShareLink.expires_at.is_(None), DriveShareLink.expires_at > now),
            or_(
                DriveShareLink.max_downloads.is_(None),
                DriveShareLink.download_count < DriveShareLink.max_downloads,
            ),
        )
        .values(download_count=DriveShareLink.download_count + 1, last_used_at=now)
        .returning(DriveShareLink.id)
        .execution_options(synchronize_session=False)
    )
    return counted.scalar_one_or_none() is not None


async def _spend(request: Request, db: AsyncSession, visit: Visit) -> None:
    """A counted download: the link's rate and its limit. Refused ones are recorded."""
    limiter = _limiter(request, "share_download")
    key = str(visit.link.id)
    if not limiter.try_acquire(key):
        _event(db, request, visit.link, "refused")
        await db.commit()
        raise rate_limited(limiter.retry_after_seconds(key))
    if not await _count(db, visit.link):
        _event(db, request, visit.link, "refused")
        await db.commit()
        raise shares.link_unavailable()


async def content(
    request: Request,
    db: AsyncSession,
    token: str,
    item_id: uuid.UUID,
    *,
    inline: bool,
) -> Response:
    """A file's bytes (§7.1): always an attachment (an image may be inline with ?inline=1), Range,
    nosniff, sandboxed. HEAD answers the headers without counting."""
    visit = await open_link(request, db, token)
    require_unlocked(request, visit)
    item = await shared_item(db, visit, item_id)
    version, attachment = await _current(db, item)
    if not visit.link.originals and not is_video(attachment.content_type):
        # AL1 (docs/ALBUMS.md §7): display-size images only (a video plays as it is).
        raise originals_disabled()
    shown_inline = inline and attachment.content_type in attachments.INLINE_TYPES
    headers = {
        "Content-Disposition": attachments.disposition(
            names.download_name(item.name), inline=shown_inline
        ),
        "Content-Type": attachments.served_type(attachment.content_type),
        "Content-Length": str(attachment.size_bytes),
        "Content-Security-Policy": "sandbox",
        "Accept-Ranges": "bytes",
        "ETag": f'"{version.id}"',
        "Last-Modified": format_datetime(version.created_at, usegmt=True),
    }
    if request.method == "HEAD":
        await db.commit()
        return Response(status_code=200, headers=headers)
    range_header = request.headers.get("range")
    if_range = request.headers.get("if-range")
    span = attachments.requested_range(
        range_header, if_range, headers["ETag"], attachment.size_bytes
    )
    ip = client_ip(request)
    resumed = (
        span is not None
        and span[0] > 0
        and request.app.state.share_resumes.has(visit.link.id, version.id, ip)
    )
    if resumed:
        _throttle(request, "share_download", str(visit.link.id))
    else:
        await _spend(request, db, visit)
        request.app.state.share_resumes.grant(visit.link.id, version.id, ip)
        served = attachment.size_bytes if span is None else span[1] - span[0] + 1
        _event(db, request, visit.link, "download", item_id=item.id, size=served)
    await db.commit()
    return attachments.ranged_response(
        request.app.state.blobs,
        attachment.storage_key,
        attachment.size_bytes,
        headers,
        range_header=range_header,
        if_range=if_range,
    )


def _image(blobs: Any, key: str, content_type: str) -> StreamingResponse:
    return StreamingResponse(
        attachments.stream(blobs, key),
        headers={
            "Content-Type": content_type,
            "Content-Disposition": "inline",
            "Content-Security-Policy": "sandbox",
        },
    )


async def display(
    request: Request, db: AsyncSession, token: str, item_id: uuid.UUID
) -> StreamingResponse:
    """AL1 (docs/ALBUMS.md §7): an image's display-size WebP (no metadata), not counted. Without
    one: a GIF as it is (it holds no EXIF), any image as it is when the link hands out
    originals; else 404 display_not_found."""
    visit = await open_link(request, db, token)
    require_unlocked(request, visit)
    item = await shared_item(db, visit, item_id)
    _, attachment = await _current(db, item)
    await db.commit()
    blobs = request.app.state.blobs
    if attachment.display_key is not None:
        return _image(blobs, attachment.display_key, "image/webp")
    plain = attachment.content_type == "image/gif" or (
        visit.link.originals and attachment.content_type in attachments.INLINE_TYPES
    )
    if not plain:
        raise AppError(404, "display_not_found", "This file has no display image")
    return _image(blobs, attachment.storage_key, attachment.content_type)


async def media(
    request: Request, db: AsyncSession, token: str, item_id: uuid.UUID, which: str
) -> StreamingResponse:
    """An image's thumbnail (JPEG), a document's first page (WebP) or every page (PDF): not
    counted (§9.2)."""
    visit = await open_link(request, db, token)
    require_unlocked(request, visit)
    item = await shared_item(db, visit, item_id)
    _, attachment = await _current(db, item)
    await db.commit()
    blobs = request.app.state.blobs
    if which == "thumbnail":
        if attachment.thumbnail_key is None:
            raise AppError(404, "thumbnail_not_found", "This file has no thumbnail")
        return _image(blobs, attachment.thumbnail_key, "image/jpeg")
    if attachment.preview_status != "ready":
        raise AppError(404, "preview_not_found", "This file has no preview")
    if which == "preview_thumbnail":
        if attachment.preview_thumb_key is None:
            raise AppError(404, "preview_not_found", "This file has no preview")
        return _image(blobs, attachment.preview_thumb_key, "image/webp")
    headers = attachments.preview_pdf_headers(attachment)
    stem = item.name.rsplit(".", 1)[0] if "." in item.name else item.name
    headers["Content-Disposition"] = attachments.disposition(
        f"{names.download_name(stem or 'preview')}.pdf", inline=True
    )
    return StreamingResponse(
        attachments.stream(blobs, attachment.preview_pdf_key or attachment.storage_key),
        headers=headers,
    )


def _stem(name: str) -> str:
    stem = name.rsplit(".", 1)[0] if "." in name.strip(".") else name
    return stem or "photo"


def _display_entries(root: tree.Node, prefix: str, taken: zips._Names) -> list[zipstream.ZipEntry]:
    """AL1 (docs/ALBUMS.md §7): a ZIP of what the public side shows: each image's display-size
    WebP (「名前.webp」), videos and GIFs (which hold no EXIF) as they are, nothing else."""
    item = root.item
    when = zips._when(item)
    if item.kind == "folder":
        name = taken.claim(prefix, item.name, is_file=False)
        path = f"{prefix}{name}"
        out = [zipstream.ZipEntry(name=f"{path}/", size=0, modified=when, is_dir=True)]
        for child in root.children:
            out += _display_entries(child, f"{path}/", taken)
        return out
    attachment = root.attachment
    if attachment is None or root.version is None:
        return []
    if attachment.display_key is not None and attachment.display_bytes is not None:
        name = taken.claim(prefix, f"{_stem(item.name)}.webp", is_file=True)
        size, source = attachment.display_bytes, attachment.display_key
    elif is_video(attachment.content_type) or attachment.content_type == "image/gif":
        name = taken.claim(prefix, item.name, is_file=True)
        size, source = root.version.size_bytes, attachment.storage_key
    else:
        return []
    return [
        zipstream.ZipEntry(
            name=f"{prefix}{name}", size=size, modified=when, source=source, item_id=item.id
        )
    ]


async def zip_folder(
    request: Request,
    db: AsyncSession,
    token: str,
    folder_id: uuid.UUID | None,
    *,
    size: str = "original",
) -> StreamingResponse:
    """The shared folder, or a folder under it, as one ZIP (§7.2's format and limits), counted
    as one download. AL1: `size=display` holds the display-size images instead (the only ZIP of
    a link that does not hand out originals: 403 share_originals_disabled otherwise)."""
    visit = await open_link(request, db, token)
    require_unlocked(request, visit)
    folder = await shared_item(db, visit, folder_id or visit.item.id)
    if folder.kind != "folder":
        raise item_not_found()
    display = size == "display"
    if not display and not visit.link.originals:
        raise originals_disabled()
    settings: Settings = request.app.state.settings
    try:
        node = await tree.snapshot(db, folder, cap=settings.drive_zip_max_entries)
    except tree.TooLarge:
        raise zips.zip_too_large(settings) from None
    entries = (
        _display_entries(node, "", zips._Names())
        if display
        else zips._entries(node, "", zips._Names())
    )
    if (
        len(entries) > settings.drive_zip_max_entries
        or sum(e.size for e in entries) > settings.drive_zip_max_bytes
    ):
        raise zips.zip_too_large(settings)
    creator = await db.get(User, visit.link.created_by)
    plan = zipstream.plan(entries, zips._zone(creator) if creator else ZoneInfo(zips.DEFAULT_ZONE))
    runtime = request.app.state.drive
    slot = visit.link.id
    if not runtime.zip_slots.try_acquire(
        slot, per_user=settings.drive_zip_per_user, total=settings.drive_zip_total
    ):
        _event(db, request, visit.link, "refused")
        await db.commit()
        raise rate_limited(10)
    try:
        await _spend(request, db, visit)
        _event(db, request, visit.link, "zip", item_id=folder.id, size=plan.length)
        await db.commit()
    except BaseException:
        runtime.zip_slots.release(slot)
        raise
    blobs = request.app.state.blobs

    async def body() -> AsyncIterator[bytes]:
        try:
            async for chunk in zipstream.stream(plan, lambda key: blobs.stream(key)):
                yield chunk
        finally:
            runtime.zip_slots.release(slot)

    headers = {
        "Content-Disposition": attachments.disposition(
            f"{names.download_name(folder.name)}.zip", inline=False
        ),
        "Content-Length": str(plan.length),
        "Content-Security-Policy": "sandbox",
    }
    return StreamingResponse(body(), media_type="application/zip", headers=headers)
