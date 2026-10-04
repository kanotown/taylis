"""M97 (docs/FEEDS.md): RSS / Atom feeds posted into a channel by its feed bot."""

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
from email.utils import format_datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.channels.models import Channel, ChannelMember
from app.modules.feeds import service as feeds
from app.modules.feeds.models import ChannelFeed
from app.modules.feeds.parser import (
    FeedParseError,
    UnsafeXml,
    discover_feed_url,
    parse_feed,
    strip_html,
)
from app.modules.link_previews.fetcher import (
    FeedResponse,
    PreviewError,
    UrlNotAllowed,
    build_feed_fetcher,
)
from app.modules.messages.models import Message
from app.modules.users.models import User
from tests.helpers import make_user

FEED_URL = "https://blog.example.com/feed.xml"


def rss(items: list[tuple[str, str, str]], *, title: str = "アリスの週報") -> bytes:
    """items: (guid, title, pubDate)"""
    body = "".join(
        f"<item><guid>{guid}</guid><title>{name}</title>"
        f"<link>https://blog.example.com/{guid}</link>"
        f"<description>&lt;p&gt;今週は {name} をしました。&lt;b&gt;実験&lt;/b&gt;も進めた&lt;/p&gt;"
        f"</description><pubDate>{date}</pubDate></item>"
        for guid, name, date in items
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>'
        f"<title>{title}</title><link>https://blog.example.com/</link>{body}</channel></rss>"
    ).encode()


ATOM_DOC = b"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Bob's notes</title>
  <link rel="self" href="https://bob.example.org/atom.xml"/>
  <link rel="alternate" href="https://bob.example.org/"/>
  <entry>
    <id>tag:bob.example.org,2026:2</id>
    <title type="html">Week 40 &amp;amp; more</title>
    <link rel="alternate" href="/posts/2"/>
    <published>2026-10-02T09:00:00Z</published>
    <summary type="html">&lt;p&gt;Hello &lt;em&gt;world&lt;/em&gt;&lt;/p&gt;</summary>
  </entry>
  <entry>
    <id>tag:bob.example.org,2026:1</id>
    <title>Week 39</title>
    <link href="https://bob.example.org/posts/1"/>
    <updated>2026-09-25T09:00:00+09:00</updated>
    <content type="html">Body only</content>
  </entry>
</feed>"""

RDF_DOC = """<?xml version="1.0" encoding="Shift_JIS"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://old.example.jp/">
    <title>研究日誌</title><link>https://old.example.jp/</link>
  </channel>
  <item rdf:about="https://old.example.jp/1">
    <title>第一回</title><link>https://old.example.jp/1</link>
    <description>はじめまして</description><dc:date>2026-10-01T10:00:00+09:00</dc:date>
  </item>
</rdf:RDF>""".encode("shift_jis")


# --- parsing (pure) -----------------------------------------------------------------------------


def test_parse_rss2() -> None:
    feed = parse_feed(
        rss([("a2", "第2週", "Fri, 02 Oct 2026 09:00:00 +0900"), ("a1", "第1週", "")]),
        FEED_URL,
    )
    assert feed.kind == "rss" and feed.title == "アリスの週報"
    assert feed.site_url == "https://blog.example.com/"
    first, second = feed.entries
    assert first.title == "第2週" and first.link == "https://blog.example.com/a2"
    assert first.summary == "今週は 第2週 をしました。実験も進めた"
    assert first.published is not None and first.published.utcoffset() == timedelta(hours=9)
    assert second.published is None
    assert first.key != second.key and len(first.key) == 32


def test_parse_atom_and_rdf() -> None:
    feed = parse_feed(ATOM_DOC, "https://bob.example.org/atom.xml")
    assert feed.kind == "atom" and feed.title == "Bob's notes"
    assert feed.site_url == "https://bob.example.org/"
    newer, older = feed.entries
    assert newer.title == "Week 40 & more"
    assert newer.link == "https://bob.example.org/posts/2"  # relative, resolved
    assert newer.summary == "Hello world"
    assert older.summary == "Body only" and older.published is not None
    rdf = parse_feed(RDF_DOC, "https://old.example.jp/index.rdf")  # Shift_JIS decoded by Python
    assert rdf.kind == "rdf" and rdf.title == "研究日誌"
    assert [(e.title, e.link, e.summary) for e in rdf.entries] == [
        ("第一回", "https://old.example.jp/1", "はじめまして")
    ]


def test_entry_identity_and_unsafe_links() -> None:
    doc = (
        b'<rss version="2.0"><channel><title>t</title>'
        b"<item><title>no id</title><link>javascript:alert(1)</link></item>"
        b"<item><title>same</title><link>https://x.example/p</link></item>"
        b"</channel></rss>"
    )
    first, second = parse_feed(doc, "https://x.example/feed").entries
    assert first.link is None  # only http(s) links are kept
    assert first.key != second.key
    # An edited title keeps the key when there is a guid or link.
    edited = doc.replace(b"<title>same</title>", b"<title>same (edited)</title>")
    assert parse_feed(edited, "https://x.example/feed").entries[1].key == second.key


@pytest.mark.parametrize(
    "doc",
    [
        b"",
        b"<rss><channel><title>open",
        b"<html><body>not a feed</body></html>",
        b'{"json": true}',
        b"<?xml version='1.0'?><opml version='2.0'><body/></opml>",
    ],
)
def test_malformed_or_other_documents(doc: bytes) -> None:
    with pytest.raises(FeedParseError) as caught:
        parse_feed(doc, FEED_URL)
    assert caught.value.code == "not_a_feed"


@pytest.mark.parametrize(
    "doc",
    [
        # billion laughs
        b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">'
        b'<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">'
        b'<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>'
        b"<rss><channel><title>&lol3;</title></channel></rss>",
        # external entity (file read)
        b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
        b"<rss><channel><title>&xxe;</title></channel></rss>",
        # external parameter entity / DTD fetch
        b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY % ext SYSTEM "http://169.254.169.254/">'
        b"%ext;]><rss><channel/></rss>",
    ],
)
def test_entity_declarations_are_refused(doc: bytes) -> None:
    with pytest.raises(UnsafeXml):
        parse_feed(doc, FEED_URL)


def test_external_dtd_reference_is_not_loaded() -> None:
    doc = (
        b'<?xml version="1.0"?><!DOCTYPE rss SYSTEM "http://169.254.169.254/x.dtd">'
        b"<rss><channel><title>t</title><item><guid>1</guid><title>x</title></item>"
        b"</channel></rss>"
    )
    # The DOCTYPE itself is harmless: nothing is fetched, the feed parses.
    assert parse_feed(doc, FEED_URL).entries[0].title == "x"


def test_html_helpers() -> None:
    assert strip_html("<p>a&nbsp;<script>x()</script>b</p>\n\n c") == "a b c"
    page = (
        b'<!doctype html><html><head><link rel="stylesheet" href="/s.css">'
        b'<link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>'
    )
    assert discover_feed_url(page, "https://blog.example.com/about") == FEED_URL


def test_post_body_neutralizes_mentions() -> None:
    entry = parse_feed(rss([("x", "告知 &lt;@abc&gt;", "")]), FEED_URL).entries[0]
    body = feeds.post_body("<!channel> アリス", entry)
    assert body.startswith("📝 \uff1c!channel> アリス の新しい記事: 告知 \uff1c@abc>")
    assert "\nhttps://blog.example.com/x\n> 今週は" in body
    assert "<!" not in body and "<@" not in body


# --- the API and the worker ---------------------------------------------------------------------


@dataclass
class FakeFetch:
    """url -> body, or an exception; records (url, etag, last_modified)."""

    docs: dict[str, bytes | Exception] = field(default_factory=dict)
    etags: dict[str, str] = field(default_factory=dict)
    calls: list[tuple[str, str | None, str | None]] = field(default_factory=list)

    async def __call__(self, url: str, etag: str | None, last_modified: str | None) -> FeedResponse:
        self.calls.append((url, etag, last_modified))
        doc = self.docs.get(url)
        if doc is None:
            raise PreviewError("http_error", "HTTP 404")
        if isinstance(doc, Exception):
            raise doc
        tag = self.etags.get(url)
        if tag is not None and etag == tag:
            return FeedResponse(status=304, url=url, etag=etag, last_modified=last_modified)
        return FeedResponse(
            status=200, url=url, body=doc, etag=tag, last_modified="Fri, 02 Oct 2026 00:00:00 GMT"
        )


@pytest.fixture
def fetch(app: FastAPI) -> FakeFetch:
    fake = FakeFetch()
    app.state.feed_fetcher = fake
    return fake


async def _channel(client: AsyncClient, name: str, members: list[User], **extra: Any) -> str:
    created = await client.post("/api/v1/channels", json={"name": name, **extra})
    assert created.status_code == 201, created.text
    cid = str(created.json()["id"])
    for user in members:
        added = await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(user.id)})
        assert added.status_code == 200, added.text
    return cid


async def _bot_posts(db: AsyncSession, bot_id: Any) -> list[Message]:
    rows = await db.execute(
        select(Message)
        .where(Message.sender_id == uuid.UUID(str(bot_id)))
        .order_by(Message.seq)
        .execution_options(populate_existing=True)
    )
    return list(rows.scalars().all())


async def _poll(app: FastAPI, *, now: Any = None, settings: Settings | None = None) -> int:
    return await feeds.poll_due(
        app.state.db.session_factory,
        settings=settings or app.state.settings,
        fetch=app.state.feed_fetcher,
        now=now or utcnow() + timedelta(hours=1),
    )


async def _row(db: AsyncSession, feed_id: str) -> ChannelFeed:
    row = (
        await db.execute(
            select(ChannelFeed)
            .where(ChannelFeed.id == uuid.UUID(feed_id))
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    return row


def _soon(hours: int) -> str:
    """An RFC 822 date some hours after now (entries dated before the feed was added are
    backlog, so the new ones in these tests are dated after it)."""
    return format_datetime(utcnow() + timedelta(hours=hours))


WEEK1 = ("w1", "第1週", "Fri, 25 Sep 2026 09:00:00 +0900")
WEEK2 = ("w2", "第2週", _soon(1))


async def test_add_validates_records_the_backlog_and_posts_only_new_entries(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    fetch: FakeFetch,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "weekly", [bob])
    fetch.docs[FEED_URL] = rss([WEEK1])
    fetch.etags[FEED_URL] = '"v1"'

    as_user(bob)
    added = await client.post(f"/api/v1/channels/{cid}/feeds", json={"url": f" {FEED_URL} "})
    assert added.status_code == 201, added.text
    feed = added.json()
    assert feed["url"] == FEED_URL and feed["title"] == "アリスの週報"
    assert feed["owner_id"] == str(bob.id) and feed["owner_active"] and feed["can_manage"]
    assert feed["enabled"] and feed["post_count"] == 0 and feed["last_success_at"]
    # The bot is a member, named RSS, and the backlog was not posted.
    bot = (await client.get(f"/api/v1/users/{feed['bot_user_id']}")).json()
    assert bot["display_name"] == "RSS" and bot["role"] == "bot"
    assert await _bot_posts(db, feed["bot_user_id"]) == []
    # Members see it; the same URL again is refused.
    as_user(alice)
    listed = (await client.get(f"/api/v1/channels/{cid}/feeds")).json()
    assert [f["id"] for f in listed] == [feed["id"]] and listed[0]["can_manage"]  # channel owner
    again = await client.post(f"/api/v1/channels/{cid}/feeds", json={"url": FEED_URL})
    assert again.status_code == 409 and again.json()["error"]["code"] == "feed_exists"

    # Not yet due: nothing fetched.
    assert await _poll(app, now=utcnow()) == 0
    # Due and unchanged: a conditional GET answered 304.
    fetch.calls.clear()
    assert await _poll(app) == 1
    assert fetch.calls == [(FEED_URL, '"v1"', "Fri, 02 Oct 2026 00:00:00 GMT")]
    assert await _bot_posts(db, feed["bot_user_id"]) == []

    # A new entry: posted once, naming the owner; the next fetches do not repeat it.
    fetch.docs[FEED_URL] = rss([WEEK2, WEEK1])
    fetch.etags[FEED_URL] = '"v2"'
    await _poll(app, now=utcnow() + timedelta(hours=2))
    posts = await _bot_posts(db, feed["bot_user_id"])
    assert len(posts) == 1
    assert posts[0].body.startswith("📝 Bob の新しい記事: 第2週\nhttps://blog.example.com/w2\n> ")
    assert posts[0].channel_id == uuid.UUID(cid)
    fetch.etags.pop(FEED_URL)  # a server without validators: the full document each time
    await _poll(app, now=utcnow() + timedelta(hours=3))
    # An edited entry (same guid, new title) is not posted again.
    fetch.docs[FEED_URL] = rss([("w2", "第2週 (修正)", WEEK2[2]), WEEK1])
    await _poll(app, now=utcnow() + timedelta(hours=4))
    assert len(await _bot_posts(db, feed["bot_user_id"])) == 1
    row = await _row(db, feed["id"])
    assert row.post_count == 1 and row.consecutive_failures == 0
    assert set(row.seen_keys) == {e.key for e in parse_feed(rss([WEEK2, WEEK1]), FEED_URL).entries}


async def test_add_rejects_what_is_not_a_feed(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], fetch: FakeFetch
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "weekly", [])

    async def add(url: str) -> Any:
        return await client.post(f"/api/v1/channels/{cid}/feeds", json={"url": url})

    for url in ("ftp://x.example/feed", "http://127.0.0.1/feed", "http://intranet.local/rss"):
        refused = await add(url)
        assert refused.status_code == 400 and refused.json()["error"]["code"] == "url_not_allowed"
    missing = await add("https://nothing.example.com/feed")
    assert missing.status_code == 422
    assert missing.json()["error"] == {
        "code": "feed_invalid",
        "message": missing.json()["error"]["message"],
        "details": {"reason": "http_error"},
    }
    fetch.docs["https://page.example.com/"] = b"<html><body>no feed here</body></html>"
    page = await add("https://page.example.com/")
    assert page.status_code == 422 and page.json()["error"]["details"]["reason"] == "not_a_feed"
    fetch.docs["https://bomb.example.com/"] = (
        b'<!DOCTYPE r [<!ENTITY a "aaaa">]><rss><channel><title>&a;</title></channel></rss>'
    )
    bomb = await add("https://bomb.example.com/")
    assert bomb.status_code == 422 and bomb.json()["error"]["details"]["reason"] == "unsafe_xml"
    fetch.docs["https://redirect.example.com/"] = UrlNotAllowed("url_not_allowed", "private")
    redirected = await add("https://redirect.example.com/")
    assert redirected.status_code == 400
    # A site's page that names its feed is followed to it.
    fetch.docs["https://blog.example.com/"] = (
        b'<!doctype html><html><head><link rel="alternate" type="application/atom+xml" '
        b'href="/feed.xml"></head></html>'
    )
    fetch.docs[FEED_URL] = ATOM_DOC
    found = await add("https://blog.example.com/")
    assert found.status_code == 201 and found.json()["url"] == FEED_URL
    assert (await client.get(f"/api/v1/channels/{cid}/feeds")).json()[0]["title"] == "Bob's notes"


async def test_flood_cap_posts_the_newest_oldest_first(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    fetch: FakeFetch,
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "weekly", [])
    fetch.docs[FEED_URL] = rss([])
    feed = (await client.post(f"/api/v1/channels/{cid}/feeds", json={"url": FEED_URL})).json()
    # Eight new entries, out of order; and one dated long before the feed was added (backlog).
    fresh = [
        (f"n{i}", f"記事{i}", f"Sun, 0{i} Nov 2026 09:00:00 +0900")
        for i in (3, 1, 8, 5, 2, 7, 4, 6)
    ]
    fetch.docs[FEED_URL] = rss([*fresh, ("old", "昔の記事", "Mon, 01 Jun 2020 09:00:00 +0900")])
    await _poll(app)
    posts = await _bot_posts(db, feed["bot_user_id"])
    titles = [p.body.split(": ", 1)[1].split("\n")[0] for p in posts]
    assert titles == ["記事4", "記事5", "記事6", "記事7", "記事8"]
    # The rest were marked seen: nothing more comes later.
    await _poll(app, now=utcnow() + timedelta(hours=2))
    assert len(await _bot_posts(db, feed["bot_user_id"])) == 5
    assert (await _row(db, feed["id"])).post_count == 5


async def test_permissions(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], fetch: FakeFetch
) -> None:
    alice = await make_user(db, "alice")  # the channel's owner
    bob = await make_user(db, "bob")  # registers the feed
    carol = await make_user(db, "carol")  # another member
    dave = await make_user(db, "dave")  # not a member
    admin = await make_user(db, "root", role="admin")
    guest = await make_user(db, "visitor", role="guest")
    as_user(alice)
    cid = await _channel(client, "weekly", [bob, carol, guest])
    secret = await _channel(client, "secret", [], type="private")
    fetch.docs[FEED_URL] = rss([WEEK1])

    as_user(guest)
    refused = await client.post(f"/api/v1/channels/{cid}/feeds", json={"url": FEED_URL})
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "guest_restricted"
    as_user(dave)
    refused = await client.post(f"/api/v1/channels/{cid}/feeds", json={"url": FEED_URL})
    assert refused.status_code == 403
    assert (await client.get(f"/api/v1/channels/{secret}/feeds")).status_code == 403
    as_user(bob)
    feed = (await client.post(f"/api/v1/channels/{cid}/feeds", json={"url": FEED_URL})).json()
    fid = feed["id"]

    as_user(carol)
    listed = (await client.get(f"/api/v1/channels/{cid}/feeds")).json()
    assert listed[0]["can_manage"] is False
    paused = await client.patch(f"/api/v1/feeds/{fid}", json={"enabled": False})
    assert paused.status_code == 403 and paused.json()["error"]["code"] == "feed_manage_restricted"
    assert (await client.delete(f"/api/v1/feeds/{fid}")).status_code == 403
    as_user(bob)  # the owner
    paused = await client.patch(f"/api/v1/feeds/{fid}", json={"enabled": False})
    assert paused.status_code == 200 and paused.json()["enabled"] is False
    as_user(alice)  # the channel's owner
    resumed = await client.patch(f"/api/v1/feeds/{fid}", json={"enabled": True})
    assert resumed.status_code == 200 and resumed.json()["enabled"] is True
    as_user(admin)  # an administrator, not a member of the public channel
    assert (await client.patch(f"/api/v1/feeds/{fid}", json={"enabled": False})).status_code == 200
    as_user(dave)
    assert (await client.get(f"/api/v1/channels/{cid}/feeds")).status_code == 200  # public

    # DMs take no feeds.
    as_user(alice)
    dm = await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})
    assert dm.status_code in (200, 201), dm.text
    in_dm = await client.post(f"/api/v1/channels/{dm.json()['id']}/feeds", json={"url": FEED_URL})
    assert in_dm.status_code == 400
    assert in_dm.json()["error"]["code"] == "feed_channel_unsupported"

    # Deleting the last feed takes the bot out; its posts would stay.
    as_user(bob)
    assert (await client.delete(f"/api/v1/feeds/{fid}")).status_code == 204
    assert (await client.get(f"/api/v1/channels/{cid}/feeds")).json() == []
    member = await db.execute(
        select(ChannelMember).where(
            ChannelMember.channel_id == uuid.UUID(cid),
            ChannelMember.user_id == uuid.UUID(feed["bot_user_id"]),
        )
    )
    assert member.scalar_one_or_none() is None
    bot = await db.get(User, uuid.UUID(feed["bot_user_id"]), populate_existing=True)
    assert bot is not None and not bot.is_active


async def test_limits_and_shared_bot(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    fetch: FakeFetch,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "weekly", [bob])
    other = await _channel(client, "other", [bob])
    for i in range(4):
        fetch.docs[f"https://s{i}.example.com/feed"] = rss([])
    monkeypatch.setattr(feeds, "MAX_PER_CHANNEL", 3)
    monkeypatch.setattr(feeds, "MAX_PER_USER", 2)

    as_user(bob)
    first = (
        await client.post(
            f"/api/v1/channels/{cid}/feeds", json={"url": "https://s0.example.com/feed"}
        )
    ).json()
    second = (
        await client.post(
            f"/api/v1/channels/{cid}/feeds", json={"url": "https://s1.example.com/feed"}
        )
    ).json()
    assert first["bot_user_id"] == second["bot_user_id"]  # one bot per channel
    over = await client.post(
        f"/api/v1/channels/{other}/feeds", json={"url": "https://s2.example.com/feed"}
    )
    assert over.status_code == 409 and over.json()["error"]["code"] == "too_many_feeds"
    as_user(alice)
    third = await client.post(
        f"/api/v1/channels/{cid}/feeds", json={"url": "https://s2.example.com/feed"}
    )
    assert third.status_code == 201
    full = await client.post(
        f"/api/v1/channels/{cid}/feeds", json={"url": "https://s3.example.com/feed"}
    )
    assert full.status_code == 409 and full.json()["error"]["code"] == "too_many_channel_feeds"
    # Deleting one of several keeps the shared bot in the channel.
    as_user(bob)
    assert (await client.delete(f"/api/v1/feeds/{first['id']}")).status_code == 204
    bot = await db.get(User, uuid.UUID(second["bot_user_id"]), populate_existing=True)
    assert bot is not None and bot.is_active


async def test_failures_notify_the_owner_once_and_recovery_resets(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    fetch: FakeFetch,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "weekly", [bob])
    fetch.docs[FEED_URL] = rss([WEEK1])
    as_user(bob)
    feed = (await client.post(f"/api/v1/channels/{cid}/feeds", json={"url": FEED_URL})).json()
    bot_id = uuid.UUID(feed["bot_user_id"])
    fetch.docs[FEED_URL] = PreviewError("http_error", "HTTP 500")
    start = utcnow()
    for hour in range(1, 9):
        await _poll(app, now=start + timedelta(hours=hour))
    row = await _row(db, feed["id"])
    assert row.consecutive_failures == 8 and row.last_error_code == "http_error"
    assert row.failure_notified_at is not None
    dms = (
        await db.execute(
            select(Message, Channel)
            .join(Channel, Channel.id == Message.channel_id)
            .where(Message.sender_id == bot_id)
            .execution_options(populate_existing=True)
        )
    ).all()
    assert len(dms) == 1  # once, not every failure after the sixth
    message, channel = dms[0]
    assert channel.type == "dm" and "6 回続けて失敗" in message.body and "#weekly" in message.body
    listed = (await client.get(f"/api/v1/channels/{cid}/feeds")).json()[0]
    assert listed["last_error_code"] == "http_error" and listed["consecutive_failures"] == 8

    fetch.docs[FEED_URL] = rss([WEEK1])
    await _poll(app, now=start + timedelta(hours=10))
    row = await _row(db, feed["id"])
    assert row.consecutive_failures == 0 and row.last_error is None
    assert row.failure_notified_at is None
    assert [m.id for m in await _bot_posts(db, bot_id)] == [message.id]  # no post: WEEK1 is seen


async def test_archived_channel_absent_owner_and_resume_post_no_backlog(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    fetch: FakeFetch,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "weekly", [bob])
    fetch.docs[FEED_URL] = rss([WEEK1])
    as_user(bob)
    feed = (await client.post(f"/api/v1/channels/{cid}/feeds", json={"url": FEED_URL})).json()
    start = utcnow()

    # Archived: not fetched at all.
    as_user(alice)
    assert (await client.post(f"/api/v1/channels/{cid}/archive")).status_code == 200
    fetch.calls.clear()
    fetch.docs[FEED_URL] = rss([WEEK2, WEEK1])
    assert await _poll(app, now=start + timedelta(hours=1)) == 0
    assert fetch.calls == []
    as_user(bob)
    archived = await client.post(
        f"/api/v1/channels/{cid}/feeds", json={"url": "https://x.example.com/"}
    )
    assert archived.status_code == 409 and archived.json()["error"]["code"] == "channel_archived"
    as_user(alice)
    assert (await client.post(f"/api/v1/channels/{cid}/unarchive")).status_code == 200
    # Back: the entry published meanwhile is recorded, not posted.
    await _poll(app, now=start + timedelta(hours=2))
    assert len(fetch.calls) == 1
    assert await _bot_posts(db, feed["bot_user_id"]) == []

    # The owner leaves: nothing fetched, and the list says so.
    as_user(bob)
    assert (await client.post(f"/api/v1/channels/{cid}/leave")).status_code in (200, 204)
    as_user(alice)
    assert (await client.get(f"/api/v1/channels/{cid}/feeds")).json()[0]["owner_active"] is False
    fetch.calls.clear()
    fetch.docs[FEED_URL] = rss([("w3", "第3週", ""), WEEK2, WEEK1])
    assert await _poll(app, now=start + timedelta(hours=3)) == 0
    assert fetch.calls == []
    added = await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(bob.id)})
    assert added.status_code == 200
    await _poll(app, now=start + timedelta(hours=4))
    assert await _bot_posts(db, feed["bot_user_id"]) == []  # w3 came while away

    # Paused, then resumed: what came meanwhile is not posted; later entries are.
    as_user(bob)
    await client.patch(f"/api/v1/feeds/{feed['id']}", json={"enabled": False})
    fetch.docs[FEED_URL] = rss([("w4", "第4週", ""), ("w3", "第3週", ""), WEEK2, WEEK1])
    assert await _poll(app, now=start + timedelta(hours=5)) == 0
    await client.patch(f"/api/v1/feeds/{feed['id']}", json={"enabled": True})
    await _poll(app, now=start + timedelta(hours=6))
    assert await _bot_posts(db, feed["bot_user_id"]) == []
    fetch.docs[FEED_URL] = rss([("w5", "第5週", ""), ("w4", "第4週", ""), WEEK2, WEEK1])
    await _poll(app, now=start + timedelta(hours=7))
    posts = await _bot_posts(db, feed["bot_user_id"])
    assert [p.body.split("\n")[0] for p in posts] == ["📝 Bob の新しい記事: 第5週"]


# --- the real fetcher over a mock transport -------------------------------------------------------


async def test_fetcher_sends_validators_follows_checked_redirects_and_caps_size() -> None:
    seen: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.headers))
        path = request.url.path
        if path == "/moved":
            return httpx.Response(301, headers={"location": "/feed"})
        if path == "/inside":
            return httpx.Response(302, headers={"location": "http://10.0.0.5/feed"})
        if path == "/big":
            return httpx.Response(200, content=b"x" * 2000)
        if request.headers.get("if-none-match") == '"v1"':
            return httpx.Response(304)
        return httpx.Response(
            200,
            content=rss([WEEK1]),
            headers={"etag": '"v1"', "last-modified": "Fri, 02 Oct 2026 00:00:00 GMT"},
        )

    fetch = build_feed_fetcher(
        timeout_seconds=5,
        max_bytes=1000,
        user_agent="test-agent",
        transport=httpx.MockTransport(handler),
    )
    base = "http://93.184.216.34"  # a public literal: no DNS in tests
    first = await fetch(f"{base}/moved", None, None)
    assert first.status == 200 and first.url == f"{base}/feed" and first.etag == '"v1"'
    assert parse_feed(first.body, first.url).entries[0].title == "第1週"
    assert seen[0]["user-agent"] == "test-agent" and "if-none-match" not in seen[0]
    again = await fetch(f"{base}/feed", first.etag, first.last_modified)
    assert again.status == 304 and again.body == b""
    assert seen[-1]["if-none-match"] == '"v1"'
    assert seen[-1]["if-modified-since"] == "Fri, 02 Oct 2026 00:00:00 GMT"
    with pytest.raises(UrlNotAllowed):
        await fetch(f"{base}/inside", None, None)
    with pytest.raises(PreviewError) as big:
        await fetch(f"{base}/big", None, None)
    assert big.value.code == "too_large"
    with pytest.raises(UrlNotAllowed):
        await fetch("http://169.254.169.254/latest", None, None)
