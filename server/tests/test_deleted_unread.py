"""2026-10-09 (tester): a DM or a mention deleted before the recipient read it left a red badge
that came back on switching workspaces. Every count the recipient can read from the server must
leave the deleted message out at once (SYNC_PROTOCOL.md §10.6)."""

import secrets
import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings, build_settings
from app.core.time import utcnow
from app.modules.auth.models import UserSession
from app.modules.notifications.planner import PushPlanner
from app.modules.notifications.providers import FakePushProvider
from app.modules.notifications.sender import PushSender
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_push_planner import add_device, deliveries, relay_with_planner


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> Any:
    payload = {"client_msg_id": str(uuid.uuid4()), "body": body, **extra}
    response = await client.post(f"/api/v1/channels/{channel_id}/messages", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _delete(client: AsyncClient, message_id: str) -> None:
    response = await client.delete(f"/api/v1/messages/{message_id}")
    assert response.status_code == 200, response.text


async def _counts(client: AsyncClient, db: AsyncSession, bob: User) -> dict[str, Any]:
    """Every number bob's devices read: bootstrap, the switcher summary, activity,
    threads and the badge of the next push."""
    boot = (await client.get("/api/v1/sync/bootstrap")).json()
    channels = {}
    for c in boot["channels"]:
        state = c["read_state"] or {}
        channels[c["name"] or c["type"]] = (state.get("unread_count"), state.get("mention_count"))
    planner = PushPlanner(build_settings(), is_active=lambda _uid: False)
    return {
        "channels": channels,
        "threads": (boot["threads"]["unread_count"], boot["threads"]["mention_count"]),
        "summary": (await client.get("/api/v1/sync/summary")).json(),
        "activity": (await client.get("/api/v1/activity/summary")).json()["unread_count"],
        "push_badge": await planner.badge_for(db, bob.id),
    }


async def test_deleted_dm_and_mentions_leave_every_count(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await db.execute(update(User).values(activity_read_at=utcnow() - timedelta(hours=1)))
    await db.commit()
    as_user(bob)
    await client.patch("/api/v1/users/me", json={"notify_keywords": ["deploy"]})
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")
    as_user(alice)
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})).json()
    root = await _post(client, general["id"], "plan")
    as_user(bob)  # bob follows the thread and reads everything so far
    await _post(client, general["id"], "ok", parent_id=root["id"])
    boot = (await client.get("/api/v1/sync/bootstrap")).json()
    for c in boot["channels"]:
        read = {"last_read_seq": c["last_seq"]}
        await client.put(f"/api/v1/channels/{c['id']}/read", json=read)

    as_user(alice)
    sent = [
        await _post(client, dm["id"], "are you there?"),
        await _post(client, general["id"], f"<@{bob.id}> look"),
        await _post(client, general["id"], "<!channel> everyone"),
        await _post(client, general["id"], "the deploy is done"),
        await _post(client, general["id"], f"<@{bob.id}> in the thread", parent_id=root["id"]),
        await _post(
            client,
            general["id"],
            f"<@{bob.id}> also here",
            parent_id=root["id"],
            also_in_channel=True,
        ),
    ]
    as_user(bob)
    before = await _counts(client, db, bob)
    assert before["channels"]["general"] == (4, 4)
    assert before["summary"] == {"badge": 5, "has_unread": True}
    assert before["push_badge"] == 5
    assert before["threads"] == (1, 1)
    assert before["activity"] == 5

    as_user(alice)
    for message in sent:
        await _delete(client, message["id"])

    as_user(bob)
    after = await _counts(client, db, bob)
    assert after["channels"] == {"dm": (0, 0), "general": (0, 0)}
    assert after["threads"] == (0, 0)
    assert after["summary"] == {"badge": 0, "has_unread": False}
    assert after["activity"] == 0
    assert after["push_badge"] == 0

    # The clients' refetch when they cannot decide a deletion themselves (§10.6): a read that moves
    # nothing answers the current counts.
    for channel_id in (dm["id"], general["id"]):
        r = await client.put(f"/api/v1/channels/{channel_id}/read", json={"last_read_seq": 0})
        assert r.status_code == 200, r.text
        state = r.json()
        assert (state["unread_count"], state["mention_count"]) == (0, 0)
        assert state["first_unread_at"] is None


async def test_a_push_waiting_for_a_deleted_message_is_not_sent(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    """PUSH_NOTIFICATIONS.md §7: a DM deleted while its push waited (planned, not yet sent: a
    retry's backoff) never shows its text on the phone."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    phone = await add_device(db, bob)
    db.add(
        UserSession(
            user_id=bob.id,
            device_id=phone.id,
            refresh_token_hash=secrets.token_bytes(32),
            expires_at=utcnow() + timedelta(days=1),
        )
    )
    await db.commit()
    as_user(alice)
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})).json()
    sent = await _post(client, dm["id"], "are you there?")
    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    assert [str(r.message_id) for r in await deliveries(db)] == [sent["id"]]
    await _delete(client, sent["id"])

    provider = FakePushProvider()
    assert await PushSender(app.state.db, {"apns": provider}).process_batch() == 1
    assert provider.sent == []
    db.expire_all()
    assert (await deliveries(db))[0].last_error == "message_deleted"
