"""Notification preferences, push registration and bootstrap (HTTP)."""

from collections.abc import Callable

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.auth.models import Device
from app.modules.users.models import User
from tests.helpers import make_user

PASSWORD = "correct-horse-battery"
DEVICE = {"platform": "ios", "device_name": "phone"}


async def test_preference_api_and_bootstrap(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})).json()

    bootstrap = (await client.get("/api/v1/sync/bootstrap")).json()
    by_id = {c["id"]: c for c in bootstrap["channels"]}
    assert by_id[channel["id"]]["notification"] == {
        "channel_id": channel["id"],
        "level": "mentions",
        "muted_until": None,
    }
    assert by_id[dm["id"]]["notification"]["level"] == "all"

    updated = await client.put(
        f"/api/v1/channels/{channel['id']}/notification-preference", json={"level": "all"}
    )
    assert updated.status_code == 200 and updated.json()["level"] == "all"
    events = (
        (
            await db.execute(
                select(OutboxEvent).where(
                    OutboxEvent.event_type == "notification_preference.updated"
                )
            )
        )
        .scalars()
        .all()
    )
    assert (
        len(events) == 1
        and events[0].audience_type == "user"
        and events[0].payload["level"] == "all"
    )

    muted = await client.put(
        f"/api/v1/channels/{dm['id']}/notification-preference",
        json={"level": "none", "muted_until": "2099-01-01T00:00:00Z"},
    )
    assert muted.status_code == 200 and muted.json()["muted_until"].startswith("2099-01-01")
    bootstrap = (await client.get("/api/v1/sync/bootstrap")).json()
    by_id = {c["id"]: c for c in bootstrap["channels"]}
    assert by_id[channel["id"]]["notification"]["level"] == "all"
    assert by_id[dm["id"]]["notification"]["level"] == "none"

    as_user(bob)
    denied = await client.put(
        f"/api/v1/channels/{channel['id']}/notification-preference", json={"level": "all"}
    )
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_a_member"


async def _login(client: AsyncClient, username: str) -> dict[str, str]:
    response = await client.post(
        "/api/v1/auth/login", json={"username": username, "password": PASSWORD, "device": DEVICE}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


async def test_push_registration_moves_tokens_and_logout_disables(
    client: AsyncClient, db: AsyncSession
) -> None:
    await make_user(db, "alice", password=PASSWORD)
    first = await _login(client, "alice")
    registered = await client.put(
        "/api/v1/devices/current",
        headers=first,
        json={"push_provider": "apns", "push_token": "TOKEN1", "push_environment": "sandbox"},
    )
    assert registered.status_code == 200
    assert (
        registered.json()["push_registered"] is True
        and registered.json()["push_environment"] == "sandbox"
    )

    second = await _login(
        client, "alice"
    )  # the same phone logged in again: token moves to the new device row
    moved = await client.put(
        "/api/v1/devices/current",
        headers=second,
        json={"push_provider": "apns", "push_token": "TOKEN1", "push_environment": "sandbox"},
    )
    assert moved.status_code == 200 and moved.json()["push_registered"] is True
    devices = (await db.execute(select(Device).order_by(Device.created_at))).scalars().all()
    assert [d.push_token for d in devices] == [None, "TOKEN1"]

    cleared = await client.put("/api/v1/devices/current", headers=second, json={"push_token": None})
    assert cleared.status_code == 200 and cleared.json()["push_registered"] is False

    re_registered = await client.put(
        "/api/v1/devices/current",
        headers=second,
        json={"push_provider": "apns", "push_token": "TOKEN2", "push_environment": "sandbox"},
    )
    assert re_registered.json()["push_registered"] is True
    assert (await client.post("/api/v1/auth/logout", headers=second)).status_code == 204
    db.expire_all()
    devices = (await db.execute(select(Device).order_by(Device.created_at))).scalars().all()
    assert (
        devices[1].enabled is False and devices[1].push_token == "TOKEN2"
    )  # disabled: the sender skips it
