"""Moderation (M104, docs/MODERATION.md): account deletion, message reports, blocking people."""

import uuid
from collections.abc import Callable
from typing import Any, cast

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.events.models import OutboxEvent
from app.modules.audit import service as audit
from app.modules.auth.models import Device, UserSession
from app.modules.channels import service as channels
from app.modules.messages.models import Message
from app.modules.moderation import service as moderation
from app.modules.moderation.models import UserBlock
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_push_planner import add_device, deliveries, post, relay_with_planner


async def _post(client: AsyncClient, channel_id: str, body: str) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body},
    )
    assert response.status_code == 201, response.text
    return cast(dict[str, Any], response.json())


async def _reload(db: AsyncSession, user_id: uuid.UUID) -> User:
    stmt = select(User).where(User.id == user_id).execution_options(populate_existing=True)
    return (await db.execute(stmt)).scalar_one()


async def _bot_dm_bodies(db: AsyncSession, admin: User) -> list[str]:
    bot_id = await moderation.bot_user_id(db)
    if bot_id is None:
        return []
    stmt = select(Message).where(Message.sender_id == bot_id).order_by(Message.created_at)
    out = []
    for message in (await db.execute(stmt)).scalars().all():
        if admin.id in await channels.member_ids_of(db, message.channel_id):
            out.append(message.body)
    return out


# --- account deletion ----------------------------------------------------------------------------


async def test_delete_own_account_anonymizes_and_keeps_messages(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "admin", role="admin")
    bob = await make_user(db, "bob", password="correct-horse")
    bob.email = "bob@example.com"
    bob.title = "M2"
    bob.status_text = "here"
    await db.commit()
    db.add(Device(user_id=bob.id, platform="ios", push_provider="apns", push_token="tok"))
    db.add(UserBlock(blocker_id=bob.id, blocked_id=admin.id))
    await db.commit()
    as_user(bob)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    await _post(client, channel["id"], "hello")

    wrong = await client.post("/api/v1/users/me/delete-account", json={"password": "nope"})
    assert wrong.status_code == 422 and wrong.json()["error"]["code"] == "invalid_password"
    assert (await client.post("/api/v1/users/me/delete-account", json={})).status_code == 422
    done = await client.post("/api/v1/users/me/delete-account", json={"password": "correct-horse"})
    assert done.status_code == 204, done.text

    gone = await _reload(db, bob.id)
    assert gone.username.startswith("deleted-") and gone.display_name == "退会したユーザー"
    assert gone.email is None and gone.title is None and gone.status_text is None
    assert gone.deactivated_at is not None
    kept = (await db.execute(select(Message).where(Message.sender_id == bob.id))).scalars().all()
    assert [m.body for m in kept] == ["hello"]  # history stays, under the tombstone
    devices = (await db.execute(select(Device).where(Device.user_id == bob.id))).scalars().all()
    assert devices and all(d.push_token is None and not d.enabled for d in devices)
    live = (
        (
            await db.execute(
                select(UserSession).where(
                    UserSession.user_id == bob.id, UserSession.revoked_at.is_(None)
                )
            )
        )
        .scalars()
        .all()
    )
    assert live == []
    blocks = (await db.execute(select(UserBlock).where(UserBlock.blocker_id == bob.id))).all()
    assert blocks == []
    rows = [r for r in await audit.list_recent(db, limit=10) if r.action == "user.account_deleted"]
    assert [(r.actor_id, r.target_id, r.details) for r in rows] == [(bob.id, str(bob.id), {})]
    # The administrators hear of it from the moderation bot, without the former name.
    notices = await _bot_dm_bodies(db, admin)
    assert len(notices) == 1 and "アカウントを削除" in notices[0] and "Bob" not in notices[0]


async def test_account_without_password_confirms_with_username(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    carol = await make_user(db, "carol")
    carol.password_hash = None  # made by Google sign-in (M48)
    await db.commit()
    as_user(carol)
    typo = await client.post("/api/v1/users/me/delete-account", json={"confirm_username": "caro"})
    assert typo.status_code == 422 and typo.json()["error"]["code"] == "invalid_confirmation"
    done = await client.post("/api/v1/users/me/delete-account", json={"confirm_username": "Carol"})
    assert done.status_code == 204
    assert (await _reload(db, carol.id)).username.startswith("deleted-")


async def test_last_admin_cannot_delete_own_account(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin", password="pw-12345678")
    await make_user(db, "member")
    retired = await make_user(db, "retired", role="admin")
    retired.deactivated_at = retired.created_at  # a deactivated admin does not count
    await db.commit()
    as_user(root)
    denied = await client.post("/api/v1/users/me/delete-account", json={"password": "pw-12345678"})
    assert denied.status_code == 409 and denied.json()["error"]["code"] == "last_admin"
    assert (await _reload(db, root.id)).deactivated_at is None
    await make_user(db, "second", role="admin")
    done = await client.post("/api/v1/users/me/delete-account", json={"password": "pw-12345678"})
    assert done.status_code == 204


async def test_admin_anonymize_still_works_and_is_audited(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "admin", role="admin")
    dave = await make_user(db, "dave")
    as_user(admin)
    response = await client.post(f"/api/v1/admin/users/{dave.id}/anonymize")
    assert response.status_code == 200
    assert response.json()["display_name"] == "退会したユーザー"
    assert (await audit.list_recent(db, limit=1))[0].action == "admin.user_anonymized"


async def test_account_deletion_page_is_public(client: AsyncClient) -> None:
    page = await client.get("/account-deletion")
    assert page.status_code == 200
    assert "アカウントを削除" in page.text and "退会したユーザー" in page.text


# --- reports -------------------------------------------------------------------------------------


async def test_report_flow_and_permissions(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "admin", role="admin")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    eve = await make_user(db, "eve")
    as_user(alice)
    private = (
        await client.post("/api/v1/channels", json={"name": "lab", "type": "private"})
    ).json()
    await client.post(f"/api/v1/channels/{private['id']}/members", json={"user_id": str(bob.id)})
    message = await _post(client, private["id"], "spam spam <@everyone>")

    # Not one's own message; not a message one cannot read.
    own = await client.post(f"/api/v1/messages/{message['id']}/report", json={"reason": "spam"})
    assert own.status_code == 400 and own.json()["error"]["code"] == "cannot_report_own"
    as_user(eve)
    outsider = await client.post(
        f"/api/v1/messages/{message['id']}/report", json={"reason": "spam"}
    )
    assert outsider.status_code == 403
    as_user(bob)
    bad = await client.post(f"/api/v1/messages/{message['id']}/report", json={"reason": "meh"})
    assert bad.status_code == 422
    first = await client.post(
        f"/api/v1/messages/{message['id']}/report",
        json={"reason": "harassment", "note": "<@x> 何度も"},
    )
    assert first.status_code == 201, first.text
    assert set(first.json()) == {"id", "message_id", "reason", "created_at"}
    again = await client.post(f"/api/v1/messages/{message['id']}/report", json={"reason": "spam"})
    assert again.status_code == 200 and again.json()["id"] == first.json()["id"]
    # Members cannot see the reports.
    assert (await client.get("/api/v1/admin/reports")).status_code == 403

    notices = await _bot_dm_bodies(db, admin)
    assert len(notices) == 1
    assert "嫌がらせ" in notices[0] and "#lab" in notices[0] and f"/m/{message['id']}" in notices[0]
    assert "<@x>" not in notices[0]  # the note cannot mention anyone

    # The author edits the message away: the report keeps what was reported.
    as_user(alice)
    await client.delete(f"/api/v1/messages/{message['id']}")
    as_user(admin)
    reports = (await client.get("/api/v1/admin/reports")).json()
    assert len(reports) == 1
    report = reports[0]
    assert report["body_snapshot"] == "spam spam <@everyone>" and report["message_deleted"]
    assert report["reporter_id"] == str(bob.id) and report["reported_user_id"] == str(alice.id)
    assert report["channel_name"] == "lab" and report["status"] == "open"
    resolved = await client.post(f"/api/v1/admin/reports/{report['id']}/resolve")
    assert resolved.status_code == 200 and resolved.json()["status"] == "resolved"
    assert resolved.json()["resolved_by"] == str(admin.id)
    assert (await client.get("/api/v1/admin/reports")).json() == []
    assert len((await client.get("/api/v1/admin/reports?status=all")).json()) == 1
    reopened = await client.post(f"/api/v1/admin/reports/{report['id']}/reopen")
    assert reopened.json()["status"] == "open" and reopened.json()["resolved_by"] is None
    missing = await client.post(f"/api/v1/admin/reports/{uuid.uuid4()}/resolve")
    assert missing.status_code == 404


async def test_reports_are_rate_limited(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    ids = [(await _post(client, channel["id"], f"m{i}"))["id"] for i in range(11)]
    as_user(bob)
    await client.post(f"/api/v1/channels/{channel['id']}/join")
    codes = [
        (await client.post(f"/api/v1/messages/{mid}/report", json={"reason": "spam"})).status_code
        for mid in ids
    ]
    assert codes[:10] == [201] * 10 and codes[10] == 429


# --- blocks --------------------------------------------------------------------------------------


async def test_block_is_private_synced_and_idempotent(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    assert (await client.put(f"/api/v1/users/{alice.id}/block")).status_code == 400
    assert (await client.put(f"/api/v1/users/{uuid.uuid4()}/block")).status_code == 404
    first = await client.put(f"/api/v1/users/{bob.id}/block")
    assert first.status_code == 201 and first.json() == {"user_id": str(bob.id), "blocked": True}
    assert (await client.put(f"/api/v1/users/{bob.id}/block")).status_code == 200
    assert [b["user_id"] for b in (await client.get("/api/v1/users/me/blocks")).json()] == [
        str(bob.id)
    ]
    assert (await client.get("/api/v1/sync/bootstrap")).json()["blocked_user_ids"] == [str(bob.id)]
    as_user(bob)  # the blocked person sees nothing of it
    assert (await client.get("/api/v1/users/me/blocks")).json() == []
    assert (await client.get("/api/v1/sync/bootstrap")).json()["blocked_user_ids"] == []
    as_user(alice)
    removed = await client.delete(f"/api/v1/users/{bob.id}/block")
    assert removed.status_code == 200 and removed.json()["blocked"] is False
    events = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "block.updated")))
        .scalars()
        .all()
    )
    assert [(e.audience_type, e.audience_id, e.payload["blocked"]) for e in events] == [
        ("user", alice.id, True),
        ("user", alice.id, False),
    ]


async def test_blocked_user_cannot_dm_the_blocker(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(bob)
    existing = (await client.post("/api/v1/dms", json={"user_ids": [str(alice.id)]})).json()
    await _post(client, existing["id"], "before")
    as_user(alice)
    await client.put(f"/api/v1/users/{bob.id}/block")

    as_user(bob)
    refused = await client.post(
        f"/api/v1/channels/{existing['id']}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "after"},
    )
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "dm_unavailable"
    # A group DM is not refused (only folded away on alice's side).
    group = (
        await client.post("/api/v1/dms", json={"user_ids": [str(alice.id), str(carol.id)]})
    ).json()
    await _post(client, group["id"], "group hello")
    # Alice may still write to bob.
    as_user(alice)
    await _post(client, existing["id"], "from alice")

    # A new 1:1 DM to someone who blocked you is refused.
    as_user(carol)
    await client.put(f"/api/v1/users/{bob.id}/block")
    as_user(bob)
    new = await client.post("/api/v1/dms", json={"user_ids": [str(carol.id)]})
    assert new.status_code == 403 and new.json()["error"]["code"] == "dm_unavailable"
    # Carol can open it herself.
    as_user(carol)
    opened = await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})
    assert opened.status_code in (200, 201), opened.text


async def test_no_push_or_activity_from_a_blocked_user(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    test_settings: Settings,
    as_user: Callable[[User], None],
) -> None:
    alice = await make_user(db, "alice", notification_default="all")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol", notification_default="all")
    alice_phone = await add_device(db, alice)
    carol_phone = await add_device(db, carol, token="carol-tok")
    as_user(bob)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    for person in (alice, carol):
        as_user(person)
        await client.post(f"/api/v1/channels/{channel['id']}/join")
    as_user(alice)
    await client.put(f"/api/v1/users/{bob.id}/block")

    await post(db, bob, uuid.UUID(channel["id"]), f"<@{alice.id}> <@{carol.id}> hi")
    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    devices = {d.device_id for d in await deliveries(db)}
    assert carol_phone.id in devices and alice_phone.id not in devices
    # The mention is not in alice's activity either; carol's is.
    as_user(alice)
    assert (await client.get("/api/v1/activity?kind=mentions")).json()["items"] == []
    assert (await client.get("/api/v1/activity/summary")).json()["unread_count"] == 0
    as_user(carol)
    assert len((await client.get("/api/v1/activity?kind=mentions")).json()["items"]) == 1
