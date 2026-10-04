"""POST /users/me/test-notification (PUSH_NOTIFICATIONS.md §15)."""

import uuid
from datetime import timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.auth.models import Device
from app.modules.notifications.providers import FakePushProvider, LogPushProvider, PushResult
from app.modules.users.models import User
from tests.conftest import LiveServer
from tests.helpers import http_login, make_user
from tests.test_auth_api import PASSWORD
from tests.test_realtime import _connect, _recv_type, _wait_outbox_drained

URL = "/api/v1/users/me/test-notification"


async def sign_in(
    client: AsyncClient,
    username: str,
    platform: str,
    *,
    name: str,
    provider: str | None = None,
    token: str | None = None,
) -> dict[str, Any]:
    """Log in as a device of `platform`; register a push token when given one."""
    response = await client.post(
        "/api/v1/auth/login",
        json={
            "username": username,
            "password": PASSWORD,
            "device": {"platform": platform, "device_name": name, "app_version": "1.0"},
        },
    )
    assert response.status_code == 200, response.text
    tokens: dict[str, Any] = response.json()
    if token:
        update = await client.put(
            "/api/v1/devices/current",
            headers=auth(tokens),
            json={"push_provider": provider, "push_token": token, "push_environment": "sandbox"},
        )
        assert update.status_code == 200, update.text
    return tokens


def auth(tokens: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def fakes(app: FastAPI) -> tuple[FakePushProvider, FakePushProvider]:
    apns, fcm = FakePushProvider("apns"), FakePushProvider("fcm")
    app.state.push_providers = {"apns": apns, "fcm": fcm}
    return apns, fcm


def by_name(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {d["device_name"]: d for d in body["devices"]}


async def test_sends_to_each_push_device_and_reports_the_others(
    app: FastAPI, client: AsyncClient, db: AsyncSession
) -> None:
    await make_user(db, "alice", password=PASSWORD)
    await make_user(db, "bob", password=PASSWORD)
    apns, fcm = fakes(app)
    desk = await sign_in(client, "alice", "desktop", name="Mac")
    await sign_in(client, "alice", "ios", name="iPhone", provider="apns", token="ios-tok")
    await sign_in(client, "alice", "android", name="Pixel", provider="fcm", token="fcm-tok")
    await sign_in(client, "alice", "ios", name="iPad")  # never registered: notifications off
    await sign_in(client, "bob", "ios", name="Bob phone", provider="apns", token="bob-tok")
    # A logged-out phone is listed but not sent to.
    gone = await sign_in(client, "alice", "android", name="Old", provider="fcm", token="old-tok")
    assert (await client.post("/api/v1/auth/logout", headers=auth(gone))).status_code == 204

    response = await client.post(URL, headers=auth(desk))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["apns_configured"] and body["fcm_configured"]
    assert body["sent_count"] == 2 and body["dnd_active"] is False
    devices = by_name(body)
    assert {k: v["status"] for k, v in devices.items()} == {
        "Mac": "in_app",
        "iPhone": "sent",
        "Pixel": "sent",
        "iPad": "no_token",
        "Old": "disabled",
    }
    assert devices["Mac"]["current"] and not devices["iPhone"]["current"]
    assert body["devices"][0]["device_name"] == "Mac"  # the current device first
    assert devices["Old"]["detail"] == "logout"

    # Bob's phone got nothing; the payload is a plain kind=test push.
    assert [d.push_token for d, _ in apns.sent] == ["ios-tok"]
    assert [d.push_token for d, _ in fcm.sent] == ["fcm-tok"]
    payload = apns.sent[0][1]
    assert payload["kind"] == "test" and payload["title"] == "Taylis"
    assert payload["channel_id"] is None and payload["body"].startswith("テスト通知")
    assert payload["badge"] == 0
    bob_device = (
        await db.execute(select(Device).where(Device.device_name == "Bob phone"))
    ).scalar_one()
    assert bob_device.push_token == "bob-tok"

    # notification.test to my own sessions, naming the device that asked.
    event = (
        await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "notification.test"))
    ).scalar_one()
    alice = (await db.execute(select(User).where(User.username == "alice"))).scalar_one()
    assert event.audience_type == "user" and event.audience_id == alice.id
    assert event.payload["device_id"] == desk["device"]["id"]
    assert event.payload["title"] == "Taylis"


async def test_push_off_on_this_server(app: FastAPI, client: AsyncClient, db: AsyncSession) -> None:
    await make_user(db, "alice", password=PASSWORD)
    app.state.push_providers = {"apns": LogPushProvider("apns"), "fcm": FakePushProvider("fcm")}
    phone = await sign_in(client, "alice", "ios", name="iPhone", provider="apns", token="t1")
    await sign_in(client, "alice", "android", name="Pixel", provider="fcm", token="t2")

    body = (await client.post(URL, headers=auth(phone))).json()
    assert body["apns_configured"] is False and body["fcm_configured"] is True
    devices = by_name(body)
    assert devices["iPhone"]["status"] == "not_configured" and devices["iPhone"]["current"]
    assert devices["Pixel"]["status"] == "sent"
    assert body["sent_count"] == 1


async def test_provider_failures_are_reported_and_a_dead_token_dropped(
    app: FastAPI, client: AsyncClient, db: AsyncSession
) -> None:
    await make_user(db, "alice", password=PASSWORD)
    apns, fcm = fakes(app)
    apns.outcomes = [PushResult("invalid_token", "Unregistered")]
    fcm.outcomes = [RuntimeError("boom")]
    phone = await sign_in(client, "alice", "ios", name="iPhone", provider="apns", token="t1")
    await sign_in(client, "alice", "android", name="Pixel", provider="fcm", token="t2")

    body = (await client.post(URL, headers=auth(phone))).json()
    devices = by_name(body)
    assert (devices["iPhone"]["status"], devices["iPhone"]["detail"]) == ("failed", "Unregistered")
    assert (devices["Pixel"]["status"], devices["Pixel"]["detail"]) == ("failed", "RuntimeError")
    assert body["sent_count"] == 0
    iphone = (await db.execute(select(Device).where(Device.device_name == "iPhone"))).scalar_one()
    assert iphone.push_token is None and iphone.push_token_invalid_reason == "Unregistered"


async def test_ignores_dnd_and_mute_but_says_so(
    app: FastAPI, client: AsyncClient, db: AsyncSession
) -> None:
    alice = await make_user(db, "alice", password=PASSWORD)
    alice.dnd_until = utcnow() + timedelta(hours=1)
    alice.notification_default = "none"
    await db.commit()
    apns, _ = fakes(app)
    phone = await sign_in(client, "alice", "ios", name="iPhone", provider="apns", token="t1")

    body = (await client.post(URL, headers=auth(phone))).json()
    assert body["dnd_active"] is True and body["sent_count"] == 1
    assert len(apns.sent) == 1


async def test_rate_limited_per_user(app: FastAPI, client: AsyncClient, db: AsyncSession) -> None:
    await make_user(db, "alice", password=PASSWORD)
    await make_user(db, "bob", password=PASSWORD)
    fakes(app)
    alice = await sign_in(client, "alice", "desktop", name="Mac")
    bob = await sign_in(client, "bob", "desktop", name="Mac")
    for _ in range(5):
        assert (await client.post(URL, headers=auth(alice))).status_code == 200
    refused = await client.post(URL, headers=auth(alice))
    assert refused.status_code == 429
    error = refused.json()["error"]
    assert error["code"] == "test_notification_rate_limited"
    assert error["details"]["retry_after_seconds"] > 0 and refused.headers["Retry-After"]
    assert (await client.post(URL, headers=auth(bob))).status_code == 200  # per user


async def test_requires_login(client: AsyncClient) -> None:
    assert (await client.post(URL)).status_code == 401


async def test_without_a_session_device(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Any
) -> None:
    """The dependency override in tests has no session: nothing is "current"."""
    alice = await make_user(db, "alice")
    fakes(app)
    as_user(alice)
    db.add(Device(user_id=alice.id, platform="ios", push_provider="apns", push_token="x"))
    await db.commit()
    body = (await client.post(URL)).json()
    # A device without a live session is treated as logged out (the sender skips it too).
    assert [(d["status"], d["detail"], d["current"]) for d in body["devices"]] == [
        ("disabled", "session_expired", False)
    ]
    assert uuid.UUID(body["devices"][0]["device_id"])


async def test_ws_event_reaches_my_sessions_only(live: LiveServer) -> None:
    async with live.app.state.db.session_factory() as db:
        await make_user(db, "alice", password=PASSWORD)
        await make_user(db, "bob", password=PASSWORD)
    alice = await http_login(live.base_url, "alice", PASSWORD)
    bob = await http_login(live.base_url, "bob", PASSWORD)
    await _wait_outbox_drained(live)
    alice_ws = await _connect(live, alice["access_token"])
    bob_ws = await _connect(live, bob["access_token"])
    try:
        async with AsyncClient(base_url=live.base_url) as http:
            response = await http.post(URL, headers=auth(alice))
            assert response.status_code == 200, response.text
        frame = await _recv_type(alice_ws, "event")
        while frame["event"] != "notification.test":
            frame = await _recv_type(alice_ws, "event")
        assert frame["data"]["device_id"] == alice["device"]["id"]
        assert frame["data"]["body"].startswith("テスト通知")
        await _wait_outbox_drained(live)
        with pytest.raises(TimeoutError):
            while True:
                other = await _recv_type(bob_ws, "event", wait=0.5)
                assert other["event"] != "notification.test"
    finally:
        await alice_ws.close()
        await bob_ws.close()
