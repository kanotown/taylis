"""M35: an overall notification setting per person, a channel's own level over it, and channels
muted until unmuted (PUSH_NOTIFICATIONS.md §4)."""

import uuid
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import build_settings
from app.modules.channels import service as channels
from app.modules.notifications.planner import PushPlanner
from app.modules.notifications.service import push_level
from app.modules.users.models import User
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str) -> Any:
    payload = {"client_msg_id": str(uuid.uuid4()), "body": body}
    response = await client.post(f"/api/v1/channels/{channel_id}/messages", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_push_level() -> None:
    def level(own: str | None, overall: str, *, dm: bool = False, times: bool = False) -> str:
        return push_level(own, is_dm=dm, others_times=times, overall=overall)

    # A channel's own level wins, whatever the overall setting.
    assert level("all", "none") == "all"
    assert level("none", "all", dm=True) == "none"
    # Otherwise the overall setting, except that DMs notify of every message and someone else's
    # times of mentions — and "none" silences everything.
    assert level(None, "all") == "all"
    assert level(None, "mentions") == "mentions"
    assert level(None, "mentions", dm=True) == "all"
    assert level(None, "all", times=True) == "mentions"
    assert level(None, "none", dm=True) == "none"
    assert level(None, "none", times=True) == "none"


async def test_overall_setting_own_levels_and_mute(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    random = (await client.post("/api/v1/channels", json={"name": "random"})).json()
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})).json()
    as_user(bob)
    for channel in (general, random):
        assert (await client.post(f"/api/v1/channels/{channel['id']}/join")).status_code == 200
    me = (await client.get("/api/v1/users/me")).json()
    assert me["notification_default"] == "mentions"

    planner = PushPlanner(build_settings(), is_active=lambda _uid: False)

    async def notified(channel: dict[str, Any], body: str) -> bool:
        as_user(alice)
        message = await _post(client, channel["id"], body)
        as_user(bob)
        record = await channels.require_channel(db, uuid.UUID(channel["id"]))
        return await planner.select_recipients(db, record, [bob.id], message) == [bob.id]

    # The default: mentions in channels, everything in DMs.
    assert not await notified(general, "hello")
    assert await notified(general, f"<@{bob.id}> look")
    assert await notified(dm, "hi")

    # Everything, overall: the channels without a level of their own follow.
    changed = await client.patch("/api/v1/users/me", json={"notification_default": "all"})
    assert changed.status_code == 200 and changed.json()["notification_default"] == "all"
    await db.refresh(bob)
    assert await notified(general, "hello again")
    # A channel of its own stays at its level.
    own = await client.put(
        f"/api/v1/channels/{random['id']}/notification-preference", json={"level": "mentions"}
    )
    assert own.json() == {
        "channel_id": random["id"],
        "level": "mentions",
        "muted_until": None,
        "follows_default": False,
        "muted": False,
    }
    assert not await notified(random, "quiet here")
    bootstrap = (await client.get("/api/v1/sync/bootstrap")).json()
    by_id = {c["id"]: c["notification"] for c in bootstrap["channels"]}
    assert by_id[general["id"]]["level"] == "all" and by_id[general["id"]]["follows_default"]
    assert by_id[random["id"]]["level"] == "mentions"
    assert not by_id[random["id"]]["follows_default"]

    # Muted until unmuted: not even a mention; the level is kept, and null follows the overall.
    muted = await client.put(
        f"/api/v1/channels/{general['id']}/notification-preference",
        json={"level": None, "muted": True},
    )
    assert muted.json()["muted"] is True and muted.json()["follows_default"] is True
    assert not await notified(general, f"<@{bob.id}> muted")
    # Changing the level alone (muted omitted) keeps the mute.
    kept = await client.put(
        f"/api/v1/channels/{general['id']}/notification-preference", json={"level": "all"}
    )
    assert kept.json()["muted"] is True
    unmuted = await client.put(
        f"/api/v1/channels/{general['id']}/notification-preference",
        json={"level": None, "muted": False},
    )
    assert unmuted.json()["muted"] is False and unmuted.json()["level"] == "all"
    assert await notified(general, "back")

    # Nothing, overall: DMs too (the unread counts are unaffected).
    await client.patch("/api/v1/users/me", json={"notification_default": "none"})
    await db.refresh(bob)
    assert not await notified(dm, "silent")
    assert not await notified(general, f"<@{bob.id}> silent")
    assert (
        await client.patch("/api/v1/users/me", json={"notification_default": "some"})
    ).status_code == 422
