"""M96: usernames can be changed by the person and by administrators (DATA_MODEL.md users
「ユーザー名の変更」, SECURITY.md §2.9)."""

import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.audit.models import AuditLog
from app.modules.users.models import User
from tests.helpers import make_user

PASSWORD = "correct-horse-battery"
DEVICE = {"platform": "desktop"}


async def _login(client: AsyncClient, username: str) -> Any:
    return await client.post(
        "/api/v1/auth/login", json={"username": username, "password": PASSWORD, "device": DEVICE}
    )


async def _rename_me(client: AsyncClient, username: str) -> Any:
    return await client.patch("/api/v1/users/me", json={"username": username})


async def _audit_rows(db: AsyncSession, user: User) -> list[AuditLog]:
    stmt = (
        select(AuditLog)
        .where(AuditLog.action == "user.username_changed", AuditLog.target_id == str(user.id))
        .order_by(AuditLog.id)
    )
    return list((await db.scalars(stmt)).all())


async def test_renaming_myself_signs_in_with_the_new_name_and_frees_the_old(
    client: AsyncClient, db: AsyncSession
) -> None:
    await make_user(db, "alice", password=PASSWORD)
    tokens = (await _login(client, "alice")).json()
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    renamed = await client.patch(
        "/api/v1/users/me", json={"username": "alice.k", "title": "M2"}, headers=headers
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["username"] == "alice.k" and renamed.json()["title"] == "M2"

    # The session stays valid; the refresh token too.
    me = await client.get("/api/v1/users/me", headers=headers)
    assert me.status_code == 200 and me.json()["username"] == "alice.k"
    refreshed = await client.post(
        "/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert refreshed.status_code == 200 and refreshed.json()["user"]["username"] == "alice.k"

    # Password sign-in: the new name works, the old one is like any unknown name.
    assert (await _login(client, "alice.k")).status_code == 200
    old = await _login(client, "alice")
    assert old.status_code == 401 and old.json()["error"]["code"] == "invalid_credentials"

    # The old name is free at once.
    root = await make_user(db, "root", role="admin", password=PASSWORD)
    root_tokens = (await _login(client, root.username)).json()
    created = await client.post(
        "/api/v1/admin/users",
        json={"username": "alice", "display_name": "Another Alice"},
        headers={"Authorization": f"Bearer {root_tokens['access_token']}"},
    )
    assert created.status_code == 201, created.text


async def test_rename_emits_user_updated_and_is_audited(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    assert (await _rename_me(client, "alicia")).status_code == 200

    events = (
        await db.scalars(select(OutboxEvent).where(OutboxEvent.event_type == "user.updated"))
    ).all()
    assert [e.payload["user"]["username"] for e in events] == ["alicia"]
    assert events[0].audience_type == "all"

    rows = await _audit_rows(db, alice)
    assert len(rows) == 1
    assert rows[0].actor_id == alice.id
    assert rows[0].details == {"from": "alice", "to": "alicia", "by": "self"}

    # The same name again is no change: no event, no audit row, nothing counted.
    assert (await _rename_me(client, "alicia")).status_code == 200
    assert len(await _audit_rows(db, alice)) == 1


async def test_refusals(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    await make_user(db, "bob")
    as_user(root)
    group = await client.post("/api/v1/admin/groups", json={"name": "design"})
    assert group.status_code == 201, group.text

    as_user(alice)
    for name in ("bob", "design"):
        taken = await _rename_me(client, name)
        assert taken.status_code == 409 and taken.json()["error"]["code"] == "username_taken"
    for name in ("here", "channel", "everyone", "all", "group", "deleted-0123456789ab"):
        reserved = await _rename_me(client, name)
        assert reserved.status_code == 409, name
        assert reserved.json()["error"]["code"] == "username_reserved"
    for name in ("Bob", "ab", "has space", "x" * 33, "ゆーざー"):
        invalid = await _rename_me(client, name)
        assert invalid.status_code == 422, name
    null = await client.patch("/api/v1/users/me", json={"username": None})
    assert null.status_code == 422

    # Nothing changed, nothing was counted against the limit.
    assert (await client.get(f"/api/v1/users/{alice.id}")).json()["username"] == "alice"
    assert await _audit_rows(db, alice) == []

    # A failed rename takes the rest of the request with it.
    both = await client.patch("/api/v1/users/me", json={"username": "bob", "title": "x"})
    assert both.status_code == 409
    assert (await client.get(f"/api/v1/users/{alice.id}")).json()["title"] is None


async def test_self_renames_are_limited_to_three_a_day(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    for name in ("alice1", "alice2", "alice3"):
        assert (await _rename_me(client, name)).status_code == 200
    limited = await _rename_me(client, "alice4")
    assert limited.status_code == 429
    error = limited.json()["error"]
    assert error["code"] == "username_change_limited"
    assert error["details"]["limit"] == 3 and error["details"]["window_hours"] == 24
    retry = int(limited.headers["Retry-After"])
    assert 23 * 3600 < retry <= 24 * 3600 + 1
    assert retry == error["details"]["retry_after_seconds"]
    assert (await client.get(f"/api/v1/users/{alice.id}")).json()["username"] == "alice3"

    # Once the oldest is a day old, one more is allowed.
    oldest = (await _audit_rows(db, alice))[0]
    await db.execute(
        update(AuditLog).where(AuditLog.id == oldest.id).values(at=utcnow() - timedelta(hours=25))
    )
    await db.commit()
    assert (await _rename_me(client, "alice4")).status_code == 200
    assert (await _rename_me(client, "alice5")).status_code == 429

    # An administrator renaming them does not use up their allowance, and is not limited.
    root = await make_user(db, "root", role="admin")
    as_user(root)
    for name in ("al1", "al2", "al3", "al4"):
        response = await client.patch(f"/api/v1/admin/users/{alice.id}", json={"username": name})
        assert response.status_code == 200, response.text
        assert response.json()["username"] == name
    rows = await _audit_rows(db, alice)
    assert [r.details["by"] for r in rows[-4:]] == ["admin"] * 4
    assert all(r.actor_id == root.id for r in rows[-4:])
    as_user(alice)
    assert (await _rename_me(client, "alice6")).status_code == 429  # still 3 own ones in 24 h

    # Administrators renaming themselves are not limited either.
    as_user(root)
    for name in ("root1", "root2", "root3", "root4"):
        assert (await _rename_me(client, name)).status_code == 200


async def test_admin_renames_people_and_bots_with_the_same_checks(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    member = await make_user(db, "member")
    bot = await make_user(db, "ci-bot", role="bot")
    guest = await make_user(db, "visitor", role="guest")

    as_user(member)
    denied = await client.patch(f"/api/v1/admin/users/{bot.id}", json={"username": "x-bot"})
    assert denied.status_code == 403

    as_user(root)
    renamed = await client.patch(f"/api/v1/admin/users/{bot.id}", json={"username": "deploy-bot"})
    assert renamed.status_code == 200 and renamed.json()["username"] == "deploy-bot"
    taken = await client.patch(f"/api/v1/admin/users/{bot.id}", json={"username": "member"})
    assert taken.status_code == 409 and taken.json()["error"]["code"] == "username_taken"
    reserved = await client.patch(f"/api/v1/admin/users/{bot.id}", json={"username": "here"})
    assert reserved.status_code == 409 and reserved.json()["error"]["code"] == "username_reserved"
    missing = await client.patch(f"/api/v1/admin/users/{uuid.uuid4()}", json={"username": "zzz"})
    assert missing.status_code == 404
    # An administrator may rename themselves here too (cannot_modify_self is for role / state).
    me = await client.patch(f"/api/v1/admin/users/{root.id}", json={"username": "boss"})
    assert me.status_code == 200 and me.json()["username"] == "boss"

    # Guests rename themselves like anyone else.
    as_user(guest)
    assert (await _rename_me(client, "visitor2")).status_code == 200

    audit = (
        await db.scalars(select(AuditLog).where(AuditLog.action == "admin.user_updated"))
    ).all()
    assert {"username": "deploy-bot"} in [a.details for a in audit]


async def test_times_channel_follows_the_username_unless_renamed_by_hand(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")

    as_user(alice)
    times = (await client.post("/api/v1/times")).json()
    assert times["name"] == "times-alice"
    assert (await _rename_me(client, "alice.k")).status_code == 200
    channel = (await client.get(f"/api/v1/channels/{times['id']}")).json()
    assert channel["name"] == "times-alice.k"
    rows = await _audit_rows(db, alice)
    assert rows[-1].details["times_channel"] == {"from": "times-alice", "to": "times-alice.k"}
    updated = (
        await db.scalars(
            select(OutboxEvent).where(
                OutboxEvent.event_type == "channel.updated",
                OutboxEvent.channel_id == uuid.UUID(times["id"]),
            )
        )
    ).all()
    assert updated and updated[-1].payload["channel"]["name"] == "times-alice.k"

    # A taken name gets the next free suffix (as when the times was made).
    as_user(root)
    await client.post("/api/v1/channels", json={"name": "times-bobby"})
    as_user(bob)
    bob_times = (await client.post("/api/v1/times")).json()
    assert (await _rename_me(client, "bobby")).status_code == 200
    renamed = (await client.get(f"/api/v1/channels/{bob_times['id']}")).json()
    assert renamed["name"] == "times-bobby-2"
    # … and a `-2` name made from the old username follows again.
    assert (await _rename_me(client, "robert")).status_code == 200
    renamed = (await client.get(f"/api/v1/channels/{bob_times['id']}")).json()
    assert renamed["name"] == "times-robert"

    # A times its owner named by hand keeps its name.
    as_user(carol)
    carol_times = (await client.post("/api/v1/times")).json()
    hand = await client.patch(f"/api/v1/channels/{carol_times['id']}", json={"name": "日報-carol"})
    assert hand.status_code == 200, hand.text
    assert (await _rename_me(client, "caroline")).status_code == 200
    kept = (await client.get(f"/api/v1/channels/{carol_times['id']}")).json()
    assert kept["name"] == "日報-carol"
    assert "times_channel" not in (await _audit_rows(db, carol))[-1].details
