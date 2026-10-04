"""RSS 2.0 (and 0.9x), RSS 1.0 (RDF) and Atom 1.0, parsed with the standard library only
(docs/FEEDS.md §4, SECURITY.md §14).

The XML goes through pyexpat directly, not ElementTree's parser, so that the document can be
refused before anything is expanded: any entity declaration (internal ones are how "billion laughs"
bombs are built, external ones read files or URLs) and any external entity reference raise
`UnsafeXml`. Parameter entities are never parsed, and no DTD is ever loaded. What remains is a plain
element tree (ElementTree's TreeBuilder) that the format readers walk. The body is already capped
by the fetcher (FEED_MAX_BYTES).
"""

import hashlib
import html
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlsplit
from xml.etree.ElementTree import Element, TreeBuilder
from xml.parsers import expat

MAX_ENTRIES = 200
MAX_TITLE = 200
MAX_EXCERPT = 200

ATOM = "http://www.w3.org/2005/Atom"
RSS1 = "http://purl.org/rss/1.0/"
RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
DC = "http://purl.org/dc/elements/1.1/"
CONTENT = "http://purl.org/rss/1.0/modules/content/"

# Encodings expat reads by itself; others (Shift_JIS, EUC-JP, ...) are decoded by Python first.
_EXPAT_ENCODINGS = {
    "utf-8",
    "utf8",
    "utf-16",
    "utf16",
    "iso-8859-1",
    "latin-1",
    "us-ascii",
    "ascii",
}
_DECLARATION = re.compile(rb"^\s*<\?xml[^>]*?encoding\s*=\s*[\"']([A-Za-z0-9._-]+)[\"'][^>]*\?>")
_SPACE = re.compile(r"\s+")


class FeedParseError(Exception):
    """Not a feed this parser reads (malformed XML, another root, HTML, ...)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class UnsafeXml(FeedParseError):
    """The document declares entities or refers to external ones: refused, never expanded."""

    def __init__(self, message: str = "Entity declarations are not allowed") -> None:
        super().__init__("unsafe_xml", message)


@dataclass
class FeedEntry:
    key: str  # a short hash of the entry's identity (guid / id, else link, else title + date)
    title: str
    link: str | None
    summary: str
    published: datetime | None


@dataclass
class ParsedFeed:
    kind: str  # "rss" | "atom" | "rdf"
    title: str | None
    site_url: str | None
    entries: list[FeedEntry] = field(default_factory=list)


# --- safe XML ---------------------------------------------------------------------------------


def _refuse(*_: Any) -> int:
    raise UnsafeXml()


def _reencode(data: bytes) -> bytes:
    """A declared encoding expat does not read itself (Shift_JIS, EUC-JP, ...) is decoded with
    Python's codec and handed over as UTF-8 without the declaration."""
    match = _DECLARATION.match(data[:512])
    if match is None:
        return data
    name = match.group(1).decode("ascii").lower()
    if name in _EXPAT_ENCODINGS:
        return data
    try:
        text = data.decode(name, errors="replace")
    except LookupError as exc:
        raise FeedParseError("not_a_feed", f"Unknown encoding {name}") from exc
    text = re.sub(r"^\s*<\?xml[^>]*\?>", "", text, count=1)
    return text.encode("utf-8")


def parse_xml(data: bytes) -> Element:
    """The document's root element; raises UnsafeXml / FeedParseError."""
    builder = TreeBuilder()
    parser = expat.ParserCreate(namespace_separator="}")
    parser.buffer_text = True
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    parser.EntityDeclHandler = _refuse
    parser.UnparsedEntityDeclHandler = _refuse
    parser.ExternalEntityRefHandler = _refuse

    def name_of(raw: str) -> str:
        return "{" + raw if "}" in raw else raw

    def start(tag: str, attrs: dict[str, str]) -> None:
        builder.start(name_of(tag), {name_of(k): v for k, v in attrs.items()})

    def end(tag: str) -> None:
        builder.end(name_of(tag))

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = builder.data
    try:
        parser.Parse(_reencode(data), True)
    except expat.ExpatError as exc:
        raise FeedParseError("not_a_feed", f"Not well-formed XML: {exc}") from exc
    try:
        return builder.close()
    except Exception as exc:  # an empty document
        raise FeedParseError("not_a_feed", "Empty document") from exc


# --- text helpers -----------------------------------------------------------------------------


class _TextOnly(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("script", "style"):
            self._skip += 1
        elif tag in ("br", "p", "div", "li"):
            self.parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style") and self._skip:
            self._skip -= 1

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.parts.append(data)


def strip_html(value: str) -> str:
    """Tags out, entities decoded, whitespace collapsed to single spaces."""
    if "<" in value or "&" in value:
        stripper = _TextOnly()
        try:
            stripper.feed(value)
            stripper.close()
            value = "".join(stripper.parts)
        except Exception:
            value = html.unescape(value)
    return _SPACE.sub(" ", value).strip()


def clip(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[: limit - 1].rstrip() + "…"


def _text(element: Element | None) -> str:
    if element is None:
        return ""
    return "".join(element.itertext()).strip()


def _http_url(value: str | None, base: str | None) -> str | None:
    if not value:
        return None
    url = urljoin(base or "", value.strip())
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc or len(url) > 2048:
        return None
    return url


def _date(value: str) -> datetime | None:
    value = value.strip()
    if not value:
        return None
    parsed: datetime | None = None
    try:
        parsed = parsedate_to_datetime(value)  # RFC 822 (RSS)
    except (TypeError, ValueError, IndexError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))  # RFC 3339 (Atom, dc)
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def entry_key(identity: str) -> str:
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]


def _entry(
    *, ident: str, title: str, link: str | None, summary: str, published: datetime | None
) -> FeedEntry | None:
    title = clip(strip_html(title), MAX_TITLE)
    if not (ident or link or title):
        return None
    identity = ident or link or f"{title}|{published.isoformat() if published else ''}"
    return FeedEntry(
        key=entry_key(identity),
        title=title or "(無題)",
        link=link,
        summary=clip(strip_html(summary), MAX_EXCERPT),
        published=published,
    )


# --- formats ----------------------------------------------------------------------------------


def _rss(root: Element, base: str) -> ParsedFeed:
    channel = root.find("channel")
    if channel is None:
        raise FeedParseError("not_a_feed", "An RSS document without a channel")
    site = _http_url(_text(channel.find("link")), base)
    feed = ParsedFeed(
        kind="rss", title=clip(strip_html(_text(channel.find("title"))), 200) or None, site_url=site
    )
    items = channel.findall("item") or root.findall("item")  # RSS 0.9x puts items beside it
    for item in items[:MAX_ENTRIES]:
        guid = item.find("guid")
        ident = _text(guid)
        link = _http_url(_text(item.find("link")), site or base)
        if link is None and guid is not None and guid.get("isPermaLink", "true") != "false":
            link = _http_url(ident, site or base)
        summary = _text(item.find("description")) or _text(item.find(f"{{{CONTENT}}}encoded"))
        published = _date(_text(item.find("pubDate"))) or _date(_text(item.find(f"{{{DC}}}date")))
        entry = _entry(
            ident=ident,
            title=_text(item.find("title")),
            link=link,
            summary=summary,
            published=published,
        )
        if entry is not None:
            feed.entries.append(entry)
    return feed


def _atom_link(element: Element, base: str) -> str | None:
    fallback: str | None = None
    for link in element.findall(f"{{{ATOM}}}link"):
        rel = link.get("rel", "alternate")
        href = _http_url(link.get("href"), base)
        if href is None:
            continue
        if rel == "alternate":
            return href
        if fallback is None and rel not in ("self", "edit", "replies", "enclosure"):
            fallback = href
    return fallback


def _atom(root: Element, base: str) -> ParsedFeed:
    site = _atom_link(root, base)
    feed = ParsedFeed(
        kind="atom",
        title=clip(strip_html(_text(root.find(f"{{{ATOM}}}title"))), 200) or None,
        site_url=site,
    )
    for item in root.findall(f"{{{ATOM}}}entry")[:MAX_ENTRIES]:
        summary = _text(item.find(f"{{{ATOM}}}summary")) or _text(item.find(f"{{{ATOM}}}content"))
        published = _date(_text(item.find(f"{{{ATOM}}}published"))) or _date(
            _text(item.find(f"{{{ATOM}}}updated"))
        )
        entry = _entry(
            ident=_text(item.find(f"{{{ATOM}}}id")),
            title=_text(item.find(f"{{{ATOM}}}title")),
            link=_atom_link(item, site or base),
            summary=summary,
            published=published,
        )
        if entry is not None:
            feed.entries.append(entry)
    return feed


def _rdf(root: Element, base: str) -> ParsedFeed:
    channel = root.find(f"{{{RSS1}}}channel")
    site = _http_url(_text(channel.find(f"{{{RSS1}}}link")), base) if channel is not None else None
    title = _text(channel.find(f"{{{RSS1}}}title")) if channel is not None else ""
    feed = ParsedFeed(kind="rdf", title=clip(strip_html(title), 200) or None, site_url=site)
    for item in root.findall(f"{{{RSS1}}}item")[:MAX_ENTRIES]:
        link = _http_url(_text(item.find(f"{{{RSS1}}}link")), site or base)
        entry = _entry(
            ident=item.get(f"{{{RDF}}}about", ""),
            title=_text(item.find(f"{{{RSS1}}}title")),
            link=link,
            summary=_text(item.find(f"{{{RSS1}}}description"))
            or _text(item.find(f"{{{CONTENT}}}encoded")),
            published=_date(_text(item.find(f"{{{DC}}}date"))),
        )
        if entry is not None:
            feed.entries.append(entry)
    return feed


def parse_feed(data: bytes, base_url: str) -> ParsedFeed:
    """A feed from its bytes; relative links resolve against the feed's URL."""
    root = parse_xml(data)
    if root.tag == "rss":
        return _rss(root, base_url)
    if root.tag == f"{{{ATOM}}}feed":
        return _atom(root, base_url)
    if root.tag == f"{{{RDF}}}RDF":
        return _rdf(root, base_url)
    raise FeedParseError("not_a_feed", f"Not an RSS or Atom feed (root <{root.tag}>)")


# --- autodiscovery ----------------------------------------------------------------------------

_FEED_TYPES = ("application/rss+xml", "application/atom+xml", "application/rdf+xml")


class _AlternateLinks(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.found: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "link":
            return
        values = {k.lower(): (v or "") for k, v in attrs}
        rels = values.get("rel", "").lower().split()
        if "alternate" in rels and values.get("type", "").lower() in _FEED_TYPES:
            if values.get("href"):
                self.found.append(values["href"])


def looks_like_html(data: bytes) -> bool:
    head = data[:2048].lower()
    return b"<html" in head or b"<!doctype html" in head


def discover_feed_url(data: bytes, page_url: str) -> str | None:
    """A site's page names its feed with <link rel="alternate" type="application/rss+xml">: the
    first such http(s) link, so a member can paste their site's address instead of the feed's."""
    finder = _AlternateLinks()
    try:
        finder.feed(data[: 512 * 1024].decode("utf-8", errors="replace"))
        finder.close()
    except Exception:
        return None
    for href in finder.found:
        url = _http_url(href, page_url)
        if url is not None:
            return url
    return None
