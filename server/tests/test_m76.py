"""M76 (CANVAS.md §20): canvas mentions in the activity, only for clients that ask for them."""

import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.activity.canvas_mentions import excerpt_around, find_mention
from app.modules.activity.models import CanvasMention
from app.modules.canvases import service as canvases
from app.modules.channels.models import ChannelMember
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_canvas_phase2 import _add, _canvas, _channel, _save

API = "/api/v1"
Actor = Callable[[User], None]
WITH = {"include": "canvas_mention"}


async def _feed(client: AsyncClient, **params: Any) -> dict[str, Any]:
    response = await client.get(f"{API}/activity", params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def _summary(client: AsyncClient, **params: Any) -> dict[str, Any]:
    response = await client.get(f"{API}/activity/summary", params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def test_canvas_mentions_are_items_for_clients_that_ask(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    await db.execute(update(User).values(activity_read_at=utcnow() - timedelta(hours=1)))
    await db.commit()
    as_user(alice)
    cid = await _channel(client, "lab")
    await _add(client, cid, bob, carol)
    canvas = await _canvas(client, cid, f"# 予定\n- [ ] **予稿** <@{bob.id}> と <@{carol.id}>\n")

    as_user(bob)
    # A client that does not name the kind (the phones of M39-M76) never sees it, nor counts it.
    assert (await _feed(client))["items"] == []
    assert (await _summary(client))["unread_count"] == 0
    assert (await client.get(f"{API}/sync/bootstrap")).json()["activity"]["unread_count"] == 0

    feed = await _feed(client, **WITH)
    assert len(feed["items"]) == 1
    item = feed["items"][0]
    assert item["kind"] == "canvas_mention" and item["message"] is None
    assert item["actor_ids"] == [str(alice.id)]
    assert item["canvas"] == {
        "item_id": item["canvas"]["item_id"],
        "canvas_id": canvas["id"],
        "channel_id": cid,
        "title": "議事録",
        "excerpt": "予稿 @Bob と @Carol",
        "rev_id": canvas["head_rev_id"],
    }
    assert [i["kind"] for i in (await _feed(client, filter="mentions", **WITH))["items"]] == [
        "canvas_mention"
    ]
    assert (await _feed(client, filter="threads", **WITH))["items"] == []
    summary = await _summary(client, **WITH)
    assert summary["unread_count"] == 1 and summary["mention_unread"] is True
    boot = await client.get(f"{API}/sync/bootstrap", params={"activity_include": "canvas_mention"})
    assert boot.json()["activity"]["unread_count"] == 1
    # Unknown kinds are ignored (a newer client against this server).
    assert len((await _feed(client, include=["canvas_mention", "later_kind"]))["items"]) == 1

    # While unread, another mention in the same canvas (removed and added back, by carol) moves
    # the one item: its time, who and the excerpt.
    first_at = item["at"]
    as_user(alice)
    await _save(client, canvas, "なし")
    as_user(carol)
    await _save(client, canvas, f"メモ\n確認お願いします <@{bob.id}>")
    as_user(bob)
    items = (await _feed(client, **WITH))["items"]
    assert len(items) == 1
    moved = items[0]
    assert moved["canvas"]["item_id"] == item["canvas"]["item_id"]
    assert moved["at"] > first_at and moved["actor_ids"] == [str(carol.id)]
    assert moved["canvas"]["excerpt"] == "確認お願いします @Bob"
    assert moved["canvas"]["rev_id"] == canvas["head_rev_id"]

    # Read, then mentioned again: a second item; the read one stays in the list.
    read = await client.put(
        f"{API}/activity/read", params=WITH, json={"read_at": utcnow().isoformat()}
    )
    assert read.json()["unread_count"] == 0
    # (The test's user object belongs to the test's session: write the position for the app's.)
    await db.execute(
        update(User).where(User.id == bob.id).values(activity_read_at=bob.activity_read_at)
    )
    await db.commit()
    as_user(alice)
    await _save(client, canvas, "なし")
    await _save(client, canvas, f"<@{bob.id}> 再び")
    as_user(bob)
    items = (await _feed(client, **WITH))["items"]
    assert [i["canvas"]["excerpt"] for i in items] == ["@Bob 再び", "確認お願いします @Bob"]
    assert (await _summary(client, **WITH))["unread_count"] == 1

    # Pages: the cursor walks the canvas items like the others.
    page = await _feed(client, limit=1, **WITH)
    assert len(page["items"]) == 1 and page["next_cursor"] == items[0]["at"]
    rest = await _feed(client, limit=1, cursor=page["next_cursor"], **WITH)
    assert rest["items"][0]["canvas"]["item_id"] == items[1]["canvas"]["item_id"]

    # The trash hides them (restoring shows them again); leaving the conversation hides them.
    as_user(alice)
    assert (await client.delete(f"{API}/canvases/{canvas['id']}")).status_code == 204
    as_user(bob)
    assert (await _feed(client, **WITH))["items"] == []
    assert (await _summary(client, **WITH))["unread_count"] == 0
    as_user(alice)
    assert (await client.post(f"{API}/canvases/{canvas['id']}/restore")).status_code == 200
    as_user(bob)
    assert len((await _feed(client, **WITH))["items"]) == 2
    assert (await client.post(f"{API}/channels/{cid}/leave")).status_code in (200, 204)
    assert (await _feed(client, **WITH))["items"] == []


async def test_merged_with_message_mentions_groups_and_no_bots(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    bot = await make_user(db, "helper", role="bot")
    await db.execute(update(User).values(activity_read_at=utcnow() - timedelta(hours=1)))
    await db.commit()
    as_user(root)
    group = await client.post(
        f"{API}/admin/groups", json={"name": "design", "member_ids": [str(bob.id)]}
    )
    assert group.status_code == 201, group.text
    gid = group.json()["id"]

    as_user(alice)
    cid = await _channel(client, "lab")
    await _add(client, cid, bob)
    db.add(ChannelMember(channel_id=uuid.UUID(cid), user_id=bot.id, role="member"))
    await db.commit()
    posted = await client.post(
        f"{API}/channels/{cid}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": f"<@{bob.id}> 見て"},
    )
    assert posted.status_code == 201, posted.text
    # Through a group, and a bot mentioned directly: the bot gets no item.
    canvas = await _canvas(client, cid, f"担当: <@group:{gid}> の皆さん\n<@{bot.id}> 要約して")
    rows = (await db.execute(select(CanvasMention.user_id))).scalars().all()
    assert rows == [bob.id]

    as_user(bob)
    items = (await _feed(client, **WITH))["items"]
    assert [i["kind"] for i in items] == ["canvas_mention", "mention"]
    assert items[0]["canvas"]["excerpt"] == "担当: @design の皆さん"
    summary = await _summary(client, **WITH)
    assert summary["unread_count"] == 2 and summary["mention_unread"] is True
    assert (await _summary(client))["unread_count"] == 1
    # A purge of the trash takes the items with it.
    as_user(alice)
    assert (await client.delete(f"{API}/canvases/{canvas['id']}")).status_code == 204
    count = select(func.count()).select_from(CanvasMention)
    assert await db.scalar(count) == 1
    purged = await canvases.purge_trash(db, now=utcnow() + timedelta(days=31), trash_days=30)
    assert purged == 1
    assert await db.scalar(count) == 0


def test_excerpt_starts_a_little_before_the_mention() -> None:
    bob = uuid.uuid4()
    group = uuid.uuid4()
    line = "- [ ] " + "あ" * 80 + f" <@{bob}> に頼む **大事**"
    found = find_mention(f"# 見出し\n{line}", bob)
    assert found is not None and found[0] == line
    text = excerpt_around(found[0], found[1], {bob: "Bob"})
    assert text == "…" + "あ" * 40 + " @Bob に頼む 大事"
    assert find_mention(f"<@group:{group}> へ", bob, [group]) == (f"<@group:{group}> へ", 0)
    assert find_mention("誰もいない", bob) is None
    long = excerpt_around(f"<@{bob}> " + "い" * 300, 0, {bob: "Bob"})
    assert len(long) == 200 and long.endswith("…")
