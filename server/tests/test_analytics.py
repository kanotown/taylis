"""M116 (docs/ANALYTICS.md): last sign-in / last activity and the administrators' analytics."""

import asyncio
import csv
import io
import json
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import websockets
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.analytics.activity import ActivityTracker, purge_hours
from app.modules.analytics.models import UserActivityHour
from app.modules.analytics.service import period
from app.modules.auth.models import Device
from app.modules.messages.models import Message
from app.modules.users.models import User
from tests.conftest import LiveServer
from tests.helpers import http_login, make_user

PASSWORD = "correct-horse-battery"


async def _fresh(db: AsyncSession, user_id: uuid.UUID) -> User:
    db.expire_all()
    user = await db.get(User, user_id)
    assert user is not None
    return user


# --- the tracker ---------------------------------------------------------------------------


async def test_tracker_throttles_and_flushes(db: AsyncSession) -> None:
    alice_id = (await make_user(db, "alice")).id
    bob_id = (await make_user(db, "bob")).id
    tracker = ActivityTracker(300)
    t0 = datetime(2026, 10, 6, 9, 15, tzinfo=UTC)
    assert tracker.touch(alice_id, now=t0) is True
    assert tracker.touch(alice_id, now=t0 + timedelta(minutes=1)) is False  # throttled
    assert tracker.touch(bob_id, now=t0) is True
    assert tracker.pending == 2
    assert await tracker.flush(db) == 2
    assert tracker.pending == 0
    assert await tracker.flush(db) == 0  # nothing to write: no query at all

    assert (await _fresh(db, alice_id)).last_active_at == t0
    hours = (await db.execute(select(UserActivityHour.user_id, UserActivityHour.hour))).all()
    assert sorted((h.user_id, h.hour) for h in hours) == sorted(
        [(alice_id, t0.replace(minute=0)), (bob_id, t0.replace(minute=0))]
    )

    # Another process (a fresh tracker) with an older time never moves it backwards.
    older = ActivityTracker(300)
    older.touch(alice_id, now=t0 - timedelta(hours=2))
    await older.flush(db)
    assert (await _fresh(db, alice_id)).last_active_at == t0
    # The same hour twice is one row.
    again = ActivityTracker(300)
    again.touch(bob_id, now=t0 + timedelta(minutes=20))
    await again.flush(db)
    count = await db.scalar(text("SELECT count(*) FROM user_activity_hours"))
    assert count == 3  # alice 9:00, alice 7:00 (the older note still marks its hour), bob 9:00

    # A note for a person removed meanwhile is skipped, not an error.
    gone = ActivityTracker(300)
    gone.touch(uuid.uuid4(), now=t0)
    assert await gone.flush(db) == 1

    # Retention: a cutoff of 8:00 the same day takes alice's 7:00 row only.
    purged = await purge_hours(
        db, retention_days=1, now=t0.replace(hour=8, minute=0) + timedelta(days=1)
    )
    assert purged == 1
    assert await db.scalar(text("SELECT count(*) FROM user_activity_hours")) == 2


async def test_tracker_throttle_window_reopens() -> None:
    tracker = ActivityTracker(0.05)
    user = uuid.uuid4()
    assert tracker.touch(user)
    assert not tracker.touch(user)
    await asyncio.sleep(0.06)
    assert tracker.touch(user)
    tracker.forget_idle()
    await asyncio.sleep(0.06)
    tracker.forget_idle()
    assert tracker.touch(user)  # forgotten: noted again at once


# --- sign-in and requests ----------------------------------------------------------------


async def _login(client: AsyncClient, username: str) -> dict[str, Any]:
    response = await client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": PASSWORD, "device": {"platform": "desktop"}},
    )
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def test_login_sets_last_login_refresh_does_not(
    app: FastAPI, client: AsyncClient, db: AsyncSession
) -> None:
    alice = await make_user(db, "alice", password=PASSWORD)
    before = alice.updated_at
    assert alice.last_login_at is None and alice.last_active_at is None
    tokens = await _login(client, "alice")
    signed_in = await _fresh(db, alice.id)
    assert signed_in.last_login_at is not None
    assert signed_in.last_active_at == signed_in.last_login_at
    assert signed_in.updated_at == before  # the profile's version does not move
    first = signed_in.last_login_at

    refreshed = await client.post(
        "/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert refreshed.status_code == 200
    assert (await _fresh(db, alice.id)).last_login_at == first

    # An authenticated request notes the person (in memory) and the flush writes it.
    tracker: ActivityTracker = app.state.activity
    tracker._noted.clear()
    tracker._pending.clear()
    me = await client.get(
        "/api/v1/users/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}
    )
    assert me.status_code == 200
    assert alice.id in tracker._pending
    await tracker.flush(db)
    after = await _fresh(db, alice.id)
    assert after.last_active_at is not None and after.last_active_at >= first
    assert after.last_login_at == first


async def test_websocket_connection_notes_activity(live: LiveServer) -> None:
    async with live.app.state.db.session_factory() as db:
        alice = await make_user(db, "alice", password=PASSWORD)
    tokens = await http_login(live.base_url, "alice", PASSWORD)
    tracker: ActivityTracker = live.app.state.activity
    tracker._noted.clear()
    tracker._pending.clear()
    ws = await websockets.connect(live.ws_url)
    try:
        await ws.send(json.dumps({"type": "auth", "token": tokens["access_token"]}))
        hello = json.loads(await asyncio.wait_for(ws.recv(), 5))
        assert hello["type"] == "hello"
        assert alice.id in tracker._noted
    finally:
        await ws.close()


# --- the analytics -------------------------------------------------------------------------


async def _post(client: AsyncClient, channel_id: str, body: str = "hi") -> str:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body},
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


async def _fixture(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> dict[str, Any]:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol", role="guest")
    bot = await make_user(db, "hookbot", role="bot")
    gone = await make_user(db, "gone")

    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    secret = (
        await client.post("/api/v1/channels", json={"name": "secret-plans", "type": "private"})
    ).json()
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})).json()
    as_user(root)
    staff = (
        await client.post("/api/v1/channels", json={"name": "staff", "type": "private"})
    ).json()
    await client.post(f"/api/v1/channels/{staff['id']}/members", json={"user_id": str(alice.id)})
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")

    as_user(alice)
    for _ in range(3):
        await _post(client, general["id"])
    await _post(client, secret["id"])
    await _post(client, secret["id"])
    await _post(client, dm["id"], "private words")
    deleted = await _post(client, general["id"])
    assert (await client.delete(f"/api/v1/messages/{deleted}")).status_code in (200, 204)
    as_user(bob)
    await _post(client, general["id"])
    await _post(client, dm["id"])
    as_user(root)
    await _post(client, staff["id"])
    # A bot's post (its own sender) does not count; nor does a message from 40 days ago.
    as_user(bob)
    bot_msg = await _post(client, general["id"])  # bob's, handed to the bot below
    old = await _post(client, general["id"])
    now = datetime.now(UTC)
    await db.execute(
        update(Message).where(Message.id == uuid.UUID(bot_msg)).values(sender_id=bot.id)
    )
    await db.execute(
        update(Message)
        .where(Message.id == uuid.UUID(old))
        .values(created_at=now - timedelta(days=40))
    )
    # A people's activity: alice today, bob 3 days ago, carol never, gone deactivated.
    await db.execute(update(User).where(User.id == alice.id).values(last_active_at=now))
    await db.execute(
        update(User)
        .where(User.id == bob.id)
        .values(last_active_at=now - timedelta(days=3), last_login_at=now - timedelta(days=3))
    )
    await db.execute(update(User).where(User.id == gone.id).values(deactivated_at=now))
    await db.commit()
    return {
        "root": root,
        "alice": alice,
        "bob": bob,
        "carol": carol,
        "bot": bot,
        "gone": gone,
        "general": general,
        "secret": secret,
        "staff": staff,
        "dm": dm,
        "bot_msg": bot_msg,
    }


async def test_overview_numbers_and_privacy(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    f = await _fixture(client, db, as_user)
    now = datetime.now(UTC)
    tracker = ActivityTracker(300)
    tracker.touch(f["alice"].id, now=now)
    tracker.touch(f["bob"].id, now=now - timedelta(days=3))
    await tracker.flush(db)
    other = ActivityTracker(300)
    other.touch(f["alice"].id, now=now - timedelta(days=1))
    await other.flush(db)

    as_user(f["alice"])
    denied = await client.get("/api/v1/admin/analytics/overview")
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "admin_required"
    assert (await client.get("/api/v1/admin/analytics/members")).status_code == 403
    assert (await client.get("/api/v1/admin/analytics/members.csv")).status_code == 403

    as_user(f["root"])
    bad = await client.get("/api/v1/admin/analytics/overview?tz=Mars/Base")
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "validation_error"
    assert (await client.get("/api/v1/admin/analytics/overview?days=91")).status_code == 422

    response = await client.get("/api/v1/admin/analytics/overview?days=7&tz=Asia/Tokyo")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["days"] == 7 and body["tz"] == "Asia/Tokyo" and len(body["series"]) == 7
    members = body["members"]
    # root, alice, bob, carol active accounts; gone deactivated; the bot never counts.
    assert members["accounts"] == 4 and members["deactivated"] == 1
    assert members["admins"] == 1 and members["guests"] == 1
    assert members["active_1d"] == 1  # alice; bob 3 days ago
    assert members["active_7d"] == 2 and members["active_30d"] == 2
    assert members["new_in_period"] == 5
    assert members["never_signed_in"] == 3  # root, alice, carol (bob has a sign-in)

    # People's posts still there in the period: alice 3 + 2 + 1, bob 1 + 1, root 1.
    assert body["messages_in_period"] == 9
    start, end, _ = period(now, 7, ZoneInfo("Asia/Tokyo"))
    assert body["start"] == start.isoformat() and body["end"] == end.isoformat()
    assert body["series"][-1]["date"] == end.isoformat()
    assert end == now.astimezone(ZoneInfo("Asia/Tokyo")).date()
    assert sum(d["messages"] for d in body["series"]) == 9
    assert sum(d["new_members"] for d in body["series"]) == 5
    # alice today and yesterday, bob 3 days ago (one person a day at most).
    assert [d["active_members"] for d in body["series"]].count(1) == 3
    assert sum(d["active_members"] for d in body["series"]) == 3

    names = {c["name"]: c for c in body["top_channels"]}
    # Public by name; the admin's own private channel by name; not the one they are not in.
    assert set(names) == {"general", "staff"}
    assert names["general"]["messages"] == 4 and names["general"]["posters"] == 2
    assert names["staff"]["type"] == "private" and names["staff"]["messages"] == 1
    assert body["other_private_channels"] == {"conversations": 1, "messages": 2}
    assert body["direct_messages"] == {"conversations": 1, "messages": 2}
    text_body = response.text
    assert "secret-plans" not in text_body and "private words" not in text_body
    assert str(f["dm"]["id"]) not in text_body and str(f["secret"]["id"]) not in text_body

    posters = [(p["username"], p["messages"]) for p in body["top_posters"]]
    assert posters == [("alice", 6), ("bob", 2), ("root", 1)]


async def test_members_table_sort_filter_and_csv(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    f = await _fixture(client, db, as_user)
    # Two signed-in devices of bob's, and a disabled one that does not count.
    for platform, enabled in (("ios", True), ("desktop", True), ("android", False)):
        db.add(Device(user_id=f["bob"].id, platform=platform, enabled=enabled))
    await db.commit()
    as_user(f["root"])

    listed = await client.get("/api/v1/admin/analytics/members")
    assert listed.status_code == 200
    body = listed.json()
    assert body["total"] == 5  # no bot
    rows = {r["username"]: r for r in body["items"]}
    assert "hookbot" not in rows
    assert [r["username"] for r in body["items"]] == ["alice", "bob", "carol", "gone", "root"]
    assert rows["alice"]["messages_30d"] == 6 and rows["bob"]["messages_30d"] == 2
    assert rows["bob"]["devices"] == 2 and rows["bob"]["platforms"] == ["desktop", "ios"]
    assert rows["gone"]["status"] == "deactivated"
    assert rows["carol"]["last_active_at"] is None

    by_active = await client.get("/api/v1/admin/analytics/members?sort=last_active_at&order=desc")
    order = [r["username"] for r in by_active.json()["items"]]
    assert order[:2] == ["alice", "bob"]  # the never-active ones last

    by_count = await client.get("/api/v1/admin/analytics/members?sort=messages_30d&order=desc")
    assert [r["username"] for r in by_count.json()["items"]][:3] == ["alice", "bob", "root"]

    inactive = await client.get("/api/v1/admin/analytics/members?inactive_days=2")
    assert [r["username"] for r in inactive.json()["items"]] == ["bob", "carol", "root"]

    paged = await client.get("/api/v1/admin/analytics/members?limit=2&offset=2")
    assert paged.json()["total"] == 5
    assert [r["username"] for r in paged.json()["items"]] == ["carol", "gone"]

    searched = await client.get("/api/v1/admin/analytics/members?q=@AL")
    assert [r["username"] for r in searched.json()["items"]] == ["alice"]

    deactivated = await client.get("/api/v1/admin/analytics/members?status=deactivated")
    assert [r["username"] for r in deactivated.json()["items"]] == ["gone"]

    # A name that looks like a formula is defused in the CSV.
    await db.execute(
        update(User).where(User.id == f["carol"].id).values(display_name="=HYPERLINK()")
    )
    await db.commit()
    exported = await client.get("/api/v1/admin/analytics/members.csv?sort=name")
    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith("text/csv")
    assert "attachment" in exported.headers["content-disposition"]
    content = exported.content.decode("utf-8")
    assert content.startswith("\ufeff")
    table = list(csv.reader(io.StringIO(content.lstrip("\ufeff"))))
    assert table[0][:3] == ["id", "username", "display_name"]
    assert len(table) == 6
    carol_row = next(r for r in table if r[1] == "carol")
    assert carol_row[2] == "'=HYPERLINK()"
    bob_row = next(r for r in table if r[1] == "bob")
    assert bob_row[10] == "desktop ios" and bob_row[6].endswith("Z")


async def test_admin_users_list_carries_the_timestamps(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    await make_user(db, "alice", password=PASSWORD)
    await _login(client, "alice")
    as_user(root)
    listed = (await client.get("/api/v1/admin/users")).json()
    row = next(u for u in listed if u["username"] == "alice")
    assert row["last_login_at"] is not None and row["last_active_at"] is not None
    assert next(u for u in listed if u["username"] == "root")["last_login_at"] is None
