"""The desktop / Web composer's mode (UserMe.composer_mode): set and reset through PATCH /users/me,
carried to my other devices like the other private settings (SYNC_PROTOCOL.md §6)."""

from collections.abc import Callable

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user


async def test_set_and_reset_composer_mode(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    assert (await client.get("/api/v1/users/me")).json()["composer_mode"] is None
    for mode in ("markdown", "rich"):
        updated = await client.patch("/api/v1/users/me", json={"composer_mode": mode})
        assert updated.status_code == 200, updated.text
        assert updated.json()["composer_mode"] == mode
        await db.refresh(alice)
        assert alice.composer_mode == mode
    # Other fields leave it alone.
    await client.patch("/api/v1/users/me", json={"title": "M2"})
    assert (await client.get("/api/v1/users/me")).json()["composer_mode"] == "rich"
    reset = await client.patch("/api/v1/users/me", json={"composer_mode": None})
    assert reset.status_code == 200 and reset.json()["composer_mode"] is None


async def test_composer_mode_validation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    for bad in ("wysiwyg", "", "Rich", 1, True):
        result = await client.patch("/api/v1/users/me", json={"composer_mode": bad})
        assert result.status_code == 422, bad
        assert result.json()["error"]["code"] == "validation_error"
    await db.refresh(alice)
    assert alice.composer_mode is None
    # Not part of what everyone sees of me.
    assert "composer_mode" not in (await client.get(f"/api/v1/users/{alice.id}")).json()
