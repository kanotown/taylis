import uuid
from collections.abc import Callable
from datetime import timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.users.models import User
from tests.helpers import make_user


async def test_public_profiles_and_me(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    alice.email = "alice@example.com"
    bob = await make_user(db, "bob")
    bob.deactivated_at = utcnow()
    await db.commit()
    as_user(alice)
    listed = await client.get("/api/v1/users")
    assert listed.status_code == 200
    assert [u["username"] for u in listed.json()] == ["alice", "bob"]
    assert listed.json()[1]["deactivated_at"] is not None
    public = await client.get(f"/api/v1/users/{alice.id}")
    assert public.status_code == 200
    for data in [*listed.json(), public.json()]:
        assert "email" not in data and "password_hash" not in data
        assert "must_change_password" not in data
    me = await client.get("/api/v1/users/me")
    assert me.json()["email"] == "alice@example.com"
    assert me.json()["must_change_password"] is False
    assert "password_hash" not in me.json()
    missing = await client.get(f"/api/v1/users/{uuid.uuid4()}")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "user_not_found"


async def test_profile_update_preserves_omitted_fields_and_clears_email(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    updated = await client.patch(
        "/api/v1/users/me", json={"display_name": "ありす", "email": "alice@example.com"}
    )
    assert updated.status_code == 200 and updated.json()["display_name"] == "ありす"
    renamed = await client.patch("/api/v1/users/me", json={"display_name": "Alice"})
    assert renamed.json()["email"] == "alice@example.com"
    cleared = await client.patch("/api/v1/users/me", json={"email": None})
    assert cleared.json()["email"] is None and cleared.json()["display_name"] == "Alice"
    await db.refresh(alice)
    assert alice.display_name == "Alice" and alice.email is None


async def test_profile_email_is_unique_without_partial_update(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    bob.email = "bob@example.com"
    await db.commit()
    as_user(alice)
    duplicate = await client.patch(
        "/api/v1/users/me", json={"display_name": "Changed", "email": "BOB@example.com"}
    )
    assert duplicate.status_code == 409 and duplicate.json()["error"]["code"] == "email_taken"
    await db.refresh(alice)
    assert alice.display_name == "Alice" and alice.email is None


@pytest.mark.parametrize(
    "payload",
    [
        {"role": "admin"},
        {"must_change_password": False},
        {"username": "newname"},
        {"display_name": None},
        {"display_name": ""},
        {"display_name": "x" * 81},
        {"email": "invalid"},
    ],
)
async def test_profile_validation(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    payload: dict[str, str | bool | None],
) -> None:
    user = await make_user(db, "alice")
    as_user(user)
    result = await client.patch("/api/v1/users/me", json=payload)
    assert result.status_code == 422 and result.json()["error"]["code"] == "validation_error"


async def test_custom_status_and_title_are_public_and_expire(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    later = (utcnow() + timedelta(hours=1)).isoformat()
    updated = await client.patch(
        "/api/v1/users/me",
        json={
            "title": "開発",
            "status_text": "外出中",
            "status_emoji": "🚌",
            "status_expires_at": later,
        },
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert (
        body["title"] == "開発" and body["status_text"] == "外出中" and body["status_emoji"] == "🚌"
    )
    assert body["status_expires_at"] is not None

    # Everyone sees it (user list, profile, and the user.updated event).
    as_user(bob)
    listed = next(u for u in (await client.get("/api/v1/users")).json() if u["id"] == str(alice.id))
    assert listed["status_text"] == "外出中" and listed["title"] == "開発"
    events = list((await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars())
    changed = [e for e in events if e.event_type == "user.updated"]
    assert changed and changed[-1].payload["user"]["status_emoji"] == "🚌"

    # An expired status is reported as no status; the title stays.
    as_user(alice)
    past = (utcnow() - timedelta(minutes=1)).isoformat()
    expired = (await client.patch("/api/v1/users/me", json={"status_expires_at": past})).json()
    assert expired["status_text"] is None and expired["status_emoji"] is None
    assert expired["title"] == "開発"
    as_user(bob)
    seen = (await client.get(f"/api/v1/users/{alice.id}")).json()
    assert seen["status_text"] is None and seen["status_expires_at"] is None
    as_user(alice)

    # Clearing the text and emoji drops the expiry; omitted fields keep their values.
    await client.patch(
        "/api/v1/users/me",
        json={"status_text": "会議中", "status_emoji": "📅", "status_expires_at": later},
    )
    cleared = (
        await client.patch("/api/v1/users/me", json={"status_text": None, "status_emoji": None})
    ).json()
    assert cleared["status_expires_at"] is None and cleared["display_name"] == alice.display_name
    assert (
        await client.patch("/api/v1/users/me", json={"status_text": "x" * 101})
    ).status_code == 422
