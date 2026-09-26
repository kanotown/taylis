"""Open Graph / Twitter card / <title> extraction from an HTML head (no third-party parser)."""

import re
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urljoin

_WS = re.compile(r"\s+")
_CHARSET = re.compile(rb"""<meta[^>]+charset=["']?\s*([A-Za-z0-9_\-]+)""", re.IGNORECASE)


@dataclass
class PageMeta:
    title: str | None = None
    description: str | None = None
    image_url: str | None = None
    site_name: str | None = None


class _HeadParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title = ""
        self._in_title = False
        self.done = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.done:
            return
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            a = {k.lower(): (v or "") for k, v in attrs}
            key = (a.get("property") or a.get("name") or "").lower()
            content = a.get("content", "")
            if key and content and key not in self.meta:
                self.meta[key] = content
        elif tag == "body":
            self.done = True  # everything we need lives in <head>

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        elif tag == "head":
            self.done = True

    def handle_data(self, data: str) -> None:
        if self._in_title and not self.done:
            self.title += data


def _clean(value: str | None, limit: int) -> str | None:
    if not value:
        return None
    text = _WS.sub(" ", unescape(value)).strip()
    if not text:
        return None
    return text[: limit - 1] + "…" if len(text) > limit else text


def decode_html(raw: bytes, header_charset: str | None) -> str:
    """Decode with the header charset, else a <meta charset>, else UTF-8 (lenient)."""
    for candidate in (header_charset, _meta_charset(raw), "utf-8"):
        if not candidate:
            continue
        try:
            return raw.decode(candidate, errors="replace" if candidate == "utf-8" else "strict")
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", errors="replace")


def _meta_charset(raw: bytes) -> str | None:
    match = _CHARSET.search(raw[:4096])
    return match.group(1).decode("ascii", errors="ignore") if match else None


def parse_page(html: str, base_url: str) -> PageMeta:
    """Prefer Open Graph, then Twitter cards, then plain <title> / description."""
    parser = _HeadParser()
    try:
        parser.feed(html)
    except Exception:  # a broken page still yields whatever was collected
        pass
    meta = parser.meta
    image = meta.get("og:image") or meta.get("og:image:url") or meta.get("twitter:image")
    return PageMeta(
        title=_clean(meta.get("og:title") or meta.get("twitter:title") or parser.title, 200),
        description=_clean(
            meta.get("og:description")
            or meta.get("twitter:description")
            or meta.get("description"),
            300,
        ),
        image_url=urljoin(base_url, image.strip()) if image and image.strip() else None,
        site_name=_clean(meta.get("og:site_name"), 80),
    )
