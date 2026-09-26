"""Operations (M10): audit trail, anonymisation, retention purges, channel export, readiness."""

import json
import uuid
from collections.abc import Callable
from datetime import timedelta

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.cli import export_channel_lines
from app.core.time import utcnow
from app.modules.audit import service as audit
from app.modules.auth import repository as auth_repo
from app.modules.auth.models import Device, UserSession
from app.modules.messages.models import Message
from app.modules.users.models import User
from tests.helpers import make_user


async def test_admin_actions_are_audited_and_anonymisation_erases_identity(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "root", role="admin")
    as_user(admin)
    created = await client.post(
        "/api/v1/admin/users", json={"username": "bob", "display_name": "Bob", "role": "member"}
    )
    assert created.status_code == 201
    bob_id = created.json()["user"]["id"]
    assert (await client.post(f"/api/v1/admin/users/{bob_id}/reset-password")).status_code == 200
    assert (await client.delete(f"/api/v1/admin/users/{bob_id}/sessions")).status_code == 204
    assert (
        await client.patch(f"/api/v1/admin/users/{bob_id}", json={"role": "admin"})
    ).status_code == 200

    rows = await audit.list_recent(db)
    assert [r.action for r in reversed(rows)] == [
        "admin.user_created",
        "admin.password_reset",
        "admin.sessions_revoked",
        "admin.user_updated",
    ]
    assert all(str(r.actor_id) == str(admin.id) and r.target_id == bob_id for r in rows)
    assert rows[0].details == {"role": "admin"}

    # Anonymisation: identity gone, sessions and devices dead, history intact.
    bob = await db.get(User, uuid.UUID(bob_id))
    assert bob is not None
    bob.email = "bob@example.com"
    await db.commit()
    as_user(bob)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    posted = await client.post(
        f"/api/v1/channels/{channel['id']}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "bob was here"},
    )
    assert posted.status_code == 201
    as_user(admin)
    denied = await client.post(f"/api/v1/admin/users/{admin.id}/anonymize")
    assert denied.status_code == 409
    anonymized = await client.post(f"/api/v1/admin/users/{bob_id}/anonymize")
    assert anonymized.status_code == 200, anonymized.text
    body = anonymized.json()
    assert body["username"].startswith("deleted-") and body["display_name"] == "退会したユーザー"
    assert body.get("email") is None and body["deactivated_at"] is not None
    refreshed = (
        await db.execute(
            select(User)
            .where(User.id == uuid.UUID(bob_id))
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert refreshed.email is None and refreshed.username.startswith("deleted-")
    kept = (
        (await db.execute(select(Message).where(Message.channel_id == uuid.UUID(channel["id"]))))
        .scalars()
        .all()
    )
    assert [str(m.sender_id) for m in kept] == [bob_id]  # history stays, under the generic name
    latest = (await audit.list_recent(db, limit=1))[0]
    assert latest.action == "admin.user_anonymized" and latest.details == {}
    assert refreshed.deactivated_at is not None
    live_sessions = (
        (
            await db.execute(
                select(UserSession).where(
                    UserSession.user_id == refreshed.id, UserSession.revoked_at.is_(None)
                )
            )
        )
        .scalars()
        .all()
    )
    assert live_sessions == []
    devices = (
        (await db.execute(select(Device).where(Device.user_id == refreshed.id))).scalars().all()
    )
    assert all(d.push_token is None and not d.enabled for d in devices)


async def test_retention_purges_old_sessions_and_devices(db: AsyncSession) -> None:
    alice = await make_user(db, "alice")
    old = utcnow() - timedelta(days=40)
    device = Device(user_id=alice.id, platform="desktop", enabled=False, updated_at=old)
    db.add(device)
    await db.flush()
    db.add(
        UserSession(
            user_id=alice.id,
            device_id=device.id,
            refresh_token_hash=b"x" * 32,
            expires_at=utcnow() + timedelta(days=30),
            revoked_at=old,
            revoke_reason="logout",
        )
    )
    await db.commit()

    cutoff = utcnow() - timedelta(days=30)
    assert await auth_repo.purge_devices(db, cutoff) == 0  # still referenced by the session
    assert await auth_repo.purge_sessions(db, cutoff) == 1
    assert await auth_repo.purge_devices(db, cutoff) == 1
    await db.commit()
    assert list((await db.execute(select(UserSession))).scalars()) == []
    assert list((await db.execute(select(Device))).scalars()) == []


async def test_channel_export_is_jsonl_with_usernames(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    for body in ("first", "second"):
        await client.post(
            f"/api/v1/channels/{channel['id']}/messages",
            json={"client_msg_id": str(uuid.uuid4()), "body": body},
        )
    lines = await export_channel_lines(db, uuid.UUID(channel["id"]))
    records = [json.loads(line) for line in lines]
    assert [r["body"] for r in records] == ["first", "second"]
    assert records[0]["sender_username"] == "alice" and records[0]["seq"] == 1
    assert "reactions" in records[0] and "attachments" in records[0]


async def test_readiness_reports_schema_and_queue(client: AsyncClient) -> None:
    response = await client.get("/readyz")
    checks = response.json()["checks"]
    assert checks["db"] == "ok" and checks["schema"] == "ok"
    assert isinstance(checks["outbox_pending"], int)
