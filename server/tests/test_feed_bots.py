"""M98 (docs/FEEDS.md §1, §3): the channel's feed bot is named by its owners, can be an adopted
(imported) bot, and is marked `bot_kind = "feed"` for the clients' link previews."""

import uuid
from collections.abc import Callable
from datetime import timedelta

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.audit.models import AuditLog
from app.modules.channels.models import ChannelMember
from app.modules.feeds.models import ChannelFeed
from app.modules.messages import service as messages
from app.modules.messages.schemas import MessageCreate
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_feeds import FEED_URL, WEEK1, WEEK2, FakeFetch, _bot_posts, _channel, _poll, rss


@pytest.fixture
def fetch(app: FastAPI) -> FakeFetch:
    fake = FakeFetch()
    app.state.feed_fetcher = fake
    return fake


async def _member(db: AsyncSession, cid: str, user_id: uuid.UUID) -> bool:
    found = await db.execute(
        select(ChannelMember).where(
            ChannelMember.channel_id == uuid.UUID(cid), ChannelMember.user_id == user_id
        )
    )
    return found.scalar_one_or_none() is not None


async def _imported_bot(db: AsyncSession, cid: str, name: str) -> User:
    """A bot as a Slack import leaves it: it posted in the channel but is not a member."""
    bot = await make_user(db, name, role="bot")
    bot.display_name = "週報 - 中村の週報"
    db.add(ChannelMember(channel_id=uuid.UUID(cid), user_id=bot.id, role="member"))
    await db.commit()
    await messages.create_message(
        db,
        bot,
        uuid.UUID(cid),
        MessageCreate(client_msg_id=uuid.uuid4(), body="中村の週報 https://kikuchi.example.com/1"),
        advance_read=False,
        mentions=False,
    )
    await db.execute(
        delete(ChannelMember).where(
            ChannelMember.channel_id == uuid.UUID(cid), ChannelMember.user_id == bot.id
        )
    )
    await db.commit()
    return bot


async def test_rename_and_the_bot_survives_its_last_feed(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], fetch: FakeFetch
) -> None:
    alice = await make_user(db, "alice")  # the channel's owner
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "weekly", [bob])
    fetch.docs[FEED_URL] = rss([WEEK1])

    before = (await client.get(f"/api/v1/channels/{cid}/feed-bot")).json()
    assert before["bot_user_id"] is None and not before["can_rename"]
    missing = await client.patch(f"/api/v1/channels/{cid}/feed-bot", json={"display_name": "x"})
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "feed_bot_not_found"

    as_user(bob)
    feed = (await client.post(f"/api/v1/channels/{cid}/feeds", json={"url": FEED_URL})).json()
    bot_id = feed["bot_user_id"]
    shown = (await client.get(f"/api/v1/users/{bot_id}")).json()
    assert shown["bot_kind"] == "feed" and shown["display_name"] == "RSS"
    person = (await client.get(f"/api/v1/users/{bob.id}")).json()
    assert person["bot_kind"] is None
    got = (await client.get(f"/api/v1/channels/{cid}/feed-bot")).json()
    assert got["bot_user_id"] == bot_id and got["display_name"] == "RSS"
    assert not got["can_rename"] and not got["can_adopt"] and got["candidates"] == []
    refused = await client.patch(f"/api/v1/channels/{cid}/feed-bot", json={"display_name": "x"})
    assert refused.status_code == 403
    assert refused.json()["error"]["code"] == "feed_bot_rename_restricted"

    as_user(alice)
    blank = await client.patch(f"/api/v1/channels/{cid}/feed-bot", json={"display_name": "  "})
    assert blank.status_code == 422
    too_long = await client.patch(
        f"/api/v1/channels/{cid}/feed-bot", json={"display_name": "x" * 81}
    )
    assert too_long.status_code == 422
    renamed = await client.patch(
        f"/api/v1/channels/{cid}/feed-bot", json={"display_name": " 週報RSS "}
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["display_name"] == "週報RSS" and renamed.json()["can_rename"]
    assert (await client.get(f"/api/v1/users/{bot_id}")).json()["display_name"] == "週報RSS"
    audit = await db.execute(select(AuditLog).where(AuditLog.action == "feed.bot_renamed"))
    assert audit.scalar_one().details["to"] == "週報RSS"

    # The last feed goes: the bot leaves (deactivated); the next feed brings the same bot back.
    as_user(bob)
    assert (await client.delete(f"/api/v1/feeds/{feed['id']}")).status_code == 204
    bot = await db.get(User, uuid.UUID(bot_id), populate_existing=True)
    assert bot is not None and not bot.is_active
    assert not await _member(db, cid, bot.id)
    again = (await client.post(f"/api/v1/channels/{cid}/feeds", json={"url": FEED_URL})).json()
    assert again["bot_user_id"] == bot_id
    bot = await db.get(User, uuid.UUID(bot_id), populate_existing=True)
    assert bot is not None and bot.is_active and bot.display_name == "週報RSS"
    assert await _member(db, cid, bot.id)


async def test_admin_adopts_an_imported_bot(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    fetch: FakeFetch,
) -> None:
    alice = await make_user(db, "alice")  # the channel's owner
    bob = await make_user(db, "bob")
    root = await make_user(db, "root", role="admin")
    as_user(alice)
    cid = await _channel(client, "weekly-rss", [bob])
    imported = await _imported_bot(db, cid, "slack-rss")
    fetch.docs[FEED_URL] = rss([WEEK1])
    as_user(bob)
    feed = (await client.post(f"/api/v1/channels/{cid}/feeds", json={"url": FEED_URL})).json()
    made = uuid.UUID(feed["bot_user_id"])

    as_user(root)
    hook = await client.post("/api/v1/admin/webhooks", json={"name": "CI", "channel_id": cid})
    assert hook.status_code == 201, hook.text
    hook_bot = hook.json()["webhook"]["bot_user_id"]
    got = (await client.get(f"/api/v1/channels/{cid}/feed-bot")).json()
    assert got["can_adopt"] and got["can_rename"]
    # The imported bot only (not the webhook's, not the current feed bot, not people).
    assert [c["id"] for c in got["candidates"]] == [str(imported.id)]

    as_user(alice)  # a channel owner renames, but only administrators adopt
    refused = await client.patch(
        f"/api/v1/channels/{cid}/feed-bot", json={"bot_user_id": str(imported.id)}
    )
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "admin_required"
    as_user(root)
    for wrong in (hook_bot, str(bob.id), str(uuid.uuid4())):
        bad = await client.patch(f"/api/v1/channels/{cid}/feed-bot", json={"bot_user_id": wrong})
        assert bad.status_code == 409 and bad.json()["error"]["code"] == "feed_bot_unavailable"

    adopted = await client.patch(
        f"/api/v1/channels/{cid}/feed-bot",
        json={"bot_user_id": str(imported.id), "display_name": "週報RSS"},
    )
    assert adopted.status_code == 200, adopted.text
    body = adopted.json()
    assert body["bot_user_id"] == str(imported.id) and body["adopted"]
    assert body["display_name"] == "週報RSS"
    shown = (await client.get(f"/api/v1/users/{imported.id}")).json()
    assert shown["bot_kind"] == "feed" and shown["display_name"] == "週報RSS"
    assert await _member(db, cid, imported.id)
    # The bot the feeds made is retired; the feeds post as the adopted one.
    retired = await db.get(User, made, populate_existing=True)
    assert retired is not None and not retired.is_active and not await _member(db, cid, made)
    rows = await db.execute(
        select(ChannelFeed.bot_user_id).execution_options(populate_existing=True)
    )
    assert set(rows.scalars().all()) == {imported.id}
    fetch.docs[FEED_URL] = rss([WEEK2, WEEK1])
    await _poll(app, now=utcnow() + timedelta(hours=2))
    posts = await _bot_posts(db, imported.id)
    assert len(posts) == 2 and posts[1].body.startswith("📝 Bob の新しい記事: 第2週")

    # The last feed goes: an adopted bot stays (active, in the channel).
    assert (await client.delete(f"/api/v1/feeds/{feed['id']}")).status_code == 204
    kept = await db.get(User, imported.id, populate_existing=True)
    assert kept is not None and kept.is_active and await _member(db, cid, imported.id)
    as_user(bob)
    again = (await client.post(f"/api/v1/channels/{cid}/feeds", json={"url": FEED_URL})).json()
    assert again["bot_user_id"] == str(imported.id)
    audit = await db.execute(select(AuditLog).where(AuditLog.action == "feed.bot_adopted"))
    assert audit.scalar_one().details["previous_bot_user_id"] == str(made)
