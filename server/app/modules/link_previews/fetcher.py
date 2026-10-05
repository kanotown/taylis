"""SSRF-safe page fetch (SECURITY.md §14): public http(s) hosts only, every redirect re-checked,
bounded time (per I/O and an overall deadline over DNS, redirects and the body) and size, HTML
only. The feed fetcher (docs/FEEDS.md, M97) shares the checks: any
content type, a conditional GET (ETag / Last-Modified), and a body over the cap is an error."""

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx

from app.modules.link_previews.parser import decode_html

Fetcher = Callable[[str], Awaitable[tuple[str, str]]]  # url -> (final url, html)

MAX_REDIRECTS = 3
_REDIRECTS = {301, 302, 303, 307, 308}


class PreviewError(Exception):
    """The page cannot or must not be fetched; the reason is cached as a failed preview."""

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code


class UrlNotAllowed(PreviewError):
    """Rejected before any request (scheme, private address, ...): reported as 400, never cached."""


def _deadline(timeout_seconds: float, deadline_seconds: float | None) -> float:
    """The overall budget of one fetch. httpx's timeout bounds each read, so a server dripping a
    few bytes just inside it could hold a fetch (and the feed poller behind it) for as long as it
    likes (Review v0.1.37 #3); the deadline bounds the whole fetch."""
    return deadline_seconds if deadline_seconds is not None else timeout_seconds * 3


def _deadline_error(seconds: float) -> PreviewError:
    return PreviewError("timeout", f"The site did not finish answering within {seconds:g} s")


def _is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved
    )


def check_url_shape(url: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """The checks that need no DNS: http(s), a host, no credentials, not a local name, and an IP
    literal must be public. Returns the literal address, if the host is one."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise UrlNotAllowed("url_not_allowed", "Only public http(s) links can be previewed")
    if parts.username or parts.password:
        raise UrlNotAllowed("url_not_allowed", "Credentials in links are not allowed")
    host = parts.hostname
    try:
        literal: ipaddress.IPv4Address | ipaddress.IPv6Address | None = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is None and (
        host in ("localhost",) or host.endswith(".localhost") or host.endswith(".local")
    ):
        raise UrlNotAllowed("url_not_allowed", "Local hosts cannot be previewed")
    if literal is not None and not _is_public(literal):
        raise UrlNotAllowed("url_not_allowed", "Private or local addresses cannot be previewed")
    return literal


async def validate_public_url(url: str) -> str:
    """http(s), a host name that resolves only to public addresses (or a public literal)."""
    literal = check_url_shape(url)
    parts = urlsplit(url)
    host = parts.hostname or ""
    if literal is not None:
        addresses = [literal]
    else:
        try:
            infos = await asyncio.to_thread(
                socket.getaddrinfo, host, parts.port or 80, 0, socket.SOCK_STREAM
            )
        except (socket.gaierror, OSError) as exc:
            raise PreviewError("dns_failed", "Host not found") from exc
        addresses = [ipaddress.ip_address(info[4][0]) for info in infos]
        if not addresses:
            raise PreviewError("dns_failed", "Host not found")
    if not all(_is_public(ip) for ip in addresses):
        raise UrlNotAllowed("url_not_allowed", "Private or local addresses cannot be previewed")
    return url


def build_fetcher(
    *,
    timeout_seconds: float,
    max_bytes: int,
    user_agent: str,
    deadline_seconds: float | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> Fetcher:
    """The production fetcher; tests inject a fake with the same signature. A fetch that has not
    finished within the deadline (default: 3 timeouts) raises PreviewError("timeout")."""
    deadline = _deadline(timeout_seconds, deadline_seconds)

    async def fetch(url: str) -> tuple[str, str]:
        try:
            async with asyncio.timeout(deadline):
                return await _fetch(url)
        except TimeoutError as exc:
            raise _deadline_error(deadline) from exc

    async def _fetch(url: str) -> tuple[str, str]:
        current = await validate_public_url(url)
        headers = {
            "User-Agent": user_agent,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        }
        timeout = httpx.Timeout(timeout_seconds)
        async with httpx.AsyncClient(
            follow_redirects=False, timeout=timeout, headers=headers, transport=transport
        ) as client:
            for _ in range(MAX_REDIRECTS + 1):
                async with client.stream("GET", current) as response:
                    if response.status_code in _REDIRECTS and response.headers.get("location"):
                        current = await validate_public_url(
                            urljoin(current, response.headers["location"])
                        )
                        continue
                    if response.status_code >= 400:
                        raise PreviewError("http_error", f"HTTP {response.status_code}")
                    content_type = response.headers.get("content-type", "")
                    if not content_type.startswith(("text/html", "application/xhtml")):
                        raise PreviewError("not_html", content_type or "no content type")
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        raw.extend(chunk)
                        if len(raw) >= max_bytes:
                            break  # the head has been read; the rest is not needed
                    return current, decode_html(bytes(raw), response.charset_encoding)
        raise PreviewError("too_many_redirects", "Too many redirects")

    return fetch


@dataclass(frozen=True)
class FeedResponse:
    """What the feed fetcher returns: 304 (not modified, empty body) or 200 with the body."""

    status: int
    url: str
    body: bytes = b""
    etag: str | None = None
    last_modified: str | None = None
    content_type: str = ""


# url, etag, last_modified -> response
FeedFetcher = Callable[[str, str | None, str | None], Awaitable[FeedResponse]]


def build_feed_fetcher(
    *,
    timeout_seconds: float,
    max_bytes: int,
    user_agent: str,
    deadline_seconds: float | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> FeedFetcher:
    """RSS / Atom fetches (docs/FEEDS.md §4) with the same guard as the previews: every hop is
    checked by validate_public_url, at most MAX_REDIRECTS, bounded time (each I/O, and the whole
    fetch by the deadline: PreviewError("timeout")); a body larger than max_bytes raises
    `too_large` (a cut XML document would not parse anyway)."""
    deadline = _deadline(timeout_seconds, deadline_seconds)

    async def fetch(url: str, etag: str | None, last_modified: str | None) -> FeedResponse:
        try:
            async with asyncio.timeout(deadline):
                return await _fetch(url, etag, last_modified)
        except TimeoutError as exc:
            raise _deadline_error(deadline) from exc

    async def _fetch(url: str, etag: str | None, last_modified: str | None) -> FeedResponse:
        current = await validate_public_url(url)
        headers = {
            "User-Agent": user_agent,
            "Accept": (
                "application/rss+xml, application/atom+xml, application/rdf+xml;q=0.9, "
                "application/xml;q=0.8, text/xml;q=0.8, text/html;q=0.5, */*;q=0.1"
            ),
        }
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        async with httpx.AsyncClient(
            follow_redirects=False,
            timeout=httpx.Timeout(timeout_seconds),
            headers=headers,
            transport=transport,  # tests only
        ) as client:
            for _ in range(MAX_REDIRECTS + 1):
                async with client.stream("GET", current) as response:
                    if response.status_code in _REDIRECTS and response.headers.get("location"):
                        current = await validate_public_url(
                            urljoin(current, response.headers["location"])
                        )
                        continue
                    if response.status_code == 304:
                        return FeedResponse(
                            status=304, url=current, etag=etag, last_modified=last_modified
                        )
                    if response.status_code >= 400:
                        raise PreviewError("http_error", f"HTTP {response.status_code}")
                    declared = response.headers.get("content-length", "")
                    if declared.isdigit() and int(declared) > max_bytes:
                        raise PreviewError("too_large", f"The feed is over {max_bytes} bytes")
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        raw.extend(chunk)
                        if len(raw) > max_bytes:
                            raise PreviewError("too_large", f"The feed is over {max_bytes} bytes")
                    return FeedResponse(
                        status=200,
                        url=current,
                        body=bytes(raw),
                        etag=(response.headers.get("etag") or None),
                        last_modified=(response.headers.get("last-modified") or None),
                        content_type=response.headers.get("content-type", ""),
                    )
        raise PreviewError("too_many_redirects", "Too many redirects")

    return fetch
