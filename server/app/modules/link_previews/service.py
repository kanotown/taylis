"""Link previews (M11g): one URL in, cached Open Graph data out. The fetcher is injected (app
state) so tests never touch the network; rejected URLs raise 400 and are not cached."""

import hashlib
import logging
from datetime import timedelta
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import bad_request
from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.link_previews import repository as repo
from app.modules.link_previews.fetcher import (
    Fetcher,
    PreviewError,
    UrlNotAllowed,
    validate_public_url,
)
from app.modules.link_previews.models import LinkPreview
from app.modules.link_previews.parser import parse_page
from app.modules.link_previews.schemas import LinkPreviewOut

log = logging.getLogger("app.link_previews")
MAX_URL_LENGTH = 2048


def normalize_url(url: str) -> str:
    """Drop the fragment; the rest (query included) identifies the page."""
    parts = urlsplit(url.strip())
    return urlunsplit((parts.scheme.lower(), parts.netloc, parts.path or "/", parts.query, ""))


def to_out(row: LinkPreview) -> LinkPreviewOut:
    return LinkPreviewOut(
        url=row.url,
        status="ok" if row.status == "ok" else "failed",
        title=row.title,
        description=row.description,
        image_url=row.image_url,
        site_name=row.site_name,
        fetched_at=row.fetched_at,
    )


async def get_preview(
    db: AsyncSession, url: str, *, settings: Settings, fetch: Fetcher
) -> LinkPreviewOut:
    if len(url) > MAX_URL_LENGTH:
        raise bad_request("url_not_allowed", "Link is too long")
    try:
        normalized = normalize_url(url)
        await validate_public_url(normalized)
    except ValueError as exc:  # a malformed host or port ("http://[::1/", ":99999")
        raise bad_request("url_not_allowed", "This link cannot be previewed") from exc
    except UrlNotAllowed as exc:
        raise bad_request(exc.code, str(exc)) from exc
    except PreviewError:
        pass  # DNS failures are cached as a failed preview below
    key = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    now = utcnow()
    cached = await repo.get(db, key)
    if cached is not None:
        ttl = timedelta(
            hours=settings.link_preview_ttl_hours
            if cached.status == "ok"
            else settings.link_preview_negative_ttl_hours
        )
        if cached.fetched_at + ttl > now:
            return to_out(cached)
    row = LinkPreview(url_hash=key, url=normalized, status="failed", fetched_at=now)
    try:
        final_url, html = await fetch(normalized)
        meta = parse_page(html, final_url)
        if meta.title or meta.description:
            row.status = "ok"
            row.title = meta.title
            row.description = meta.description
            row.image_url = meta.image_url if (meta.image_url or "").startswith("http") else None
            row.site_name = meta.site_name
    except UrlNotAllowed as exc:  # a redirect went somewhere private: refuse, remember nothing
        raise bad_request(exc.code, str(exc)) from exc
    except PreviewError as exc:
        log.info("link preview failed for %s: %s", normalized, exc.code)
    except Exception as exc:  # network / TLS / decoding problems: cached as failed
        log.info("link preview failed for %s: %s", normalized, type(exc).__name__)
    saved = await repo.put(db, row)
    await db.commit()
    return to_out(saved)
