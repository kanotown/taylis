"""M39: the activity feed (mentions, reactions to my messages, replies in threads I follow), its
read position, and reaction pushes for those who ask for them (MOBILE_UI.md §7.2)."""

import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import build_settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.notifications.models import PushDelivery
from app.modules.notifications.planner import PushPlanner
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_push_planner import add_device


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> Any:
    payload = {"client_msg_id": str(uuid.uuid4()), "body": body, **extra}
    response = await client.post(f"/api/v1/channels/{channel_id}/messages", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def test_activity_feed_and_read_position(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    # Nothing before the feed existed is news.
    await db.execute(update(User).values(activity_read_at=utcnow() - timedelta(hours=1)))
    await db.commit()
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")
    as_user(alice)
    mine = await _post(client, general["id"], "my plan")
    as_user(bob)
    await client.put(f"/api/v1/messages/{mine['id']}/reactions/👍")
    await client.put(f"/api/v1/messages/{mine['id']}/reactions/🎉")
    mention = await _post(client, general["id"], f"<@{alice.id}> look")
    reply = await _post(client, general["id"], "a reply", parent_id=mine["id"])
    await _post(client, general["id"], "just talk")  # nothing for alice

    as_user(alice)
    feed = (await client.get("/api/v1/activity")).json()
    kinds = [(item["kind"], item["message"]["id"]) for item in feed["items"]]
    assert kinds == [
        ("thread_reply", reply["id"]),
        ("mention", mention["id"]),
        ("reaction", mine["id"]),
    ]
    reaction = feed["items"][2]
    assert reaction["emojis"] == sorted(["👍", "🎉"]) and reaction["actor_ids"] == [str(bob.id)]
    only = (await client.get("/api/v1/activity", params={"filter": "reactions"})).json()
    assert [i["kind"] for i in only["items"]] == ["reaction"]
    summary = (await client.get("/api/v1/activity/summary")).json()
    assert summary["unread_count"] == 3 and summary["mention_unread"] is True
    boot = (await client.get("/api/v1/sync/bootstrap")).json()
    assert boot["activity"]["unread_count"] == 3

    # Read up to now: nothing unread; the read position never goes back.
    read = await client.put("/api/v1/activity/read", json={"read_at": utcnow().isoformat()})
    assert read.json()["unread_count"] == 0
    back = await client.put(
        "/api/v1/activity/read", json={"read_at": (utcnow() - timedelta(days=1)).isoformat()}
    )
    assert back.json()["read_at"] == read.json()["read_at"]
    events = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "activity.read")))
        .scalars()
        .all()
    )
    assert [e.audience_id for e in events] == [alice.id]

    # A channel I left drops out of the feed.
    await client.post(f"/api/v1/channels/{general['id']}/leave")
    assert (await client.get("/api/v1/activity")).json()["items"] == []


async def test_reaction_event_and_push_only_when_asked(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})).json()
    mine = await _post(client, dm["id"], "hello")
    await client.put(f"/api/v1/messages/{mine['id']}/reactions/😀")  # my own: no news
    as_user(bob)
    await client.put(f"/api/v1/messages/{mine['id']}/reactions/👍")
    events = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "reaction.added")))
        .scalars()
        .all()
    )
    assert [(e.audience_id, e.payload["emoji"]) for e in events] == [(alice.id, "👍")]

    # A device for alice to push to.
    await add_device(db, alice, "t-alice")
    as_user(alice)
    planner = PushPlanner(build_settings(), is_active=lambda _uid: False)
    await planner.handle_reaction(db, events[0])
    await db.commit()
    count = select(PushDelivery).where(PushDelivery.event_id == events[0].id)
    assert (await db.execute(count)).scalars().all() == []  # banners off by default
    me = await client.patch("/api/v1/users/me", json={"notify_reactions": True})
    assert me.json()["notify_reactions"] is True
    await db.refresh(alice)
    await planner.handle_reaction(db, events[0])
    await db.commit()
    deliveries = (await db.execute(count)).scalars().all()
    assert len(deliveries) == 1 and deliveries[0].payload["kind"] == "reaction"
    assert deliveries[0].payload["title"] == "Bob がリアクションしました"
