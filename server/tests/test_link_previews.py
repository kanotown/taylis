"""Link previews (M11g): Open Graph parsing, SSRF guard, caching and the rate limit."""

import hashlib
from collections.abc import Callable
from datetime import timedelta

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ratelimit import RateLimiter
from app.core.time import utcnow
from app.modules.link_previews.fetcher import PreviewError, UrlNotAllowed, validate_public_url
from app.modules.link_previews.models import LinkPreview
from app.modules.link_previews.parser import decode_html, parse_page
from app.modules.users.models import User
from tests.helpers import make_user

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<title>Fallback   title</title>
<meta property="og:title" content="リリース手順 &amp; チェックリスト">
<meta property="og:description" content="来週の   リリースについて">
<meta property="og:image" content="/images/cover.png">
<meta property="og:site_name" content="Wiki">
</head><body><p>body text is ignored</p></body></html>"""


def test_parse_page_prefers_open_graph_and_resolves_relative_images() -> None:
    meta = parse_page(PAGE, "https://wiki.example.com/pages/1")
    assert meta.title == "リリース手順 & チェックリスト"
    assert meta.description == "来週の リリースについて"
    assert meta.image_url == "https://wiki.example.com/images/cover.png"
    assert meta.site_name == "Wiki"
    plain = parse_page(
        "<html><head><title>Only a title</title></head><body></body></html>", "https://x.test/"
    )
    assert plain.title == "Only a title" and plain.description is None and plain.image_url is None
    long_title = parse_page("<title>" + "あ" * 300 + "</title>", "https://x.test/")
    assert long_title.title is not None and len(long_title.title) == 200
    assert decode_html(
        "<meta charset='shift_jis'><title>日本語</title>".encode("shift_jis"), None
    ) == ("<meta charset='shift_jis'><title>日本語</title>")


async def test_private_and_local_targets_are_rejected_before_any_request() -> None:
    for url in (
        "ftp://example.com/x",
        "http://localhost/",
        "http://127.0.0.1:8000/readyz",
        "http://10.0.0.5/",
        "http://192.168.0.22:8000/",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/",
        "http://user:pass@example.com/",
        "http://printer.local/",
    ):
        with pytest.raises(UrlNotAllowed):
            await validate_public_url(url)
    assert await validate_public_url("http://93.184.216.34/") == "http://93.184.216.34/"


async def test_previews_are_fetched_once_cached_and_rate_limited(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    calls: list[str] = []

    async def fake_fetch(url: str) -> tuple[str, str]:
        calls.append(url)
        if url.startswith("https://wiki.example.com/"):
            return url, PAGE
        if url == "https://redirect.example.com/":
            raise UrlNotAllowed("url_not_allowed", "redirected to a private address")
        raise PreviewError("http_error", "HTTP 404")

    app.state.link_fetcher = fake_fetch

    first = await client.get(
        "/api/v1/link-previews", params={"url": "https://wiki.example.com/pages/1#section"}
    )
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["status"] == "ok" and body["title"] == "リリース手順 & チェックリスト"
    assert body["url"] == "https://wiki.example.com/pages/1"  # the fragment is dropped
    assert body["image_url"] == "https://wiki.example.com/images/cover.png"
    # Same page again (with or without the fragment): served from the cache.
    again = await client.get(
        "/api/v1/link-previews", params={"url": "https://wiki.example.com/pages/1"}
    )
    assert again.status_code == 200 and calls == ["https://wiki.example.com/pages/1"]

    # A failing page is remembered as failed, so the client can stop asking.
    failed = await client.get("/api/v1/link-previews", params={"url": "https://gone.example.com/"})
    assert failed.status_code == 200 and failed.json()["status"] == "failed"
    assert failed.json()["title"] is None
    await client.get("/api/v1/link-previews", params={"url": "https://gone.example.com/"})
    assert calls.count("https://gone.example.com/") == 1

    # An expired entry is fetched again.
    row = await db.get(
        LinkPreview, __import__("hashlib").sha256(b"https://wiki.example.com/pages/1").hexdigest()
    )
    assert row is not None
    row.fetched_at = utcnow() - timedelta(days=8)
    await db.commit()
    await client.get("/api/v1/link-previews", params={"url": "https://wiki.example.com/pages/1"})
    assert calls.count("https://wiki.example.com/pages/1") == 2

    # Redirects into private space are refused (400) and never cached; local targets never reach the fetcher.
    refused = await client.get(
        "/api/v1/link-previews", params={"url": "https://redirect.example.com/"}
    )
    assert refused.status_code == 400 and refused.json()["error"]["code"] == "url_not_allowed"
    assert (
        await client.get("/api/v1/link-previews", params={"url": "http://127.0.0.1/"})
    ).status_code == 400
    assert "http://127.0.0.1/" not in calls

    # Per-user rate limit.
    app.state.limiters["link_preview"] = RateLimiter(1)
    assert (
        await client.get("/api/v1/link-previews", params={"url": "https://wiki.example.com/a"})
    ).status_code == 200
    assert (
        await client.get("/api/v1/link-previews", params={"url": "https://wiki.example.com/b"})
    ).status_code == 429
