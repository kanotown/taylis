"""SSRF-safe page fetch (SECURITY.md §14): public http(s) hosts only, every redirect re-checked,
bounded time and size, HTML only."""

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable
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


def _is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved
    )


async def validate_public_url(url: str) -> str:
    """http(s), a host name that resolves only to public addresses (or a public literal)."""
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
    if literal is not None:
        addresses = [literal]
    else:
        if host in ("localhost",) or host.endswith(".localhost") or host.endswith(".local"):
            raise UrlNotAllowed("url_not_allowed", "Local hosts cannot be previewed")
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


def build_fetcher(*, timeout_seconds: float, max_bytes: int, user_agent: str) -> Fetcher:
    """The production fetcher; tests inject a fake with the same signature."""

    async def fetch(url: str) -> tuple[str, str]:
        current = await validate_public_url(url)
        headers = {
            "User-Agent": user_agent,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        }
        timeout = httpx.Timeout(timeout_seconds)
        async with httpx.AsyncClient(
            follow_redirects=False, timeout=timeout, headers=headers
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
