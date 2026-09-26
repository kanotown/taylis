import uuid
from collections.abc import Callable

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
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
