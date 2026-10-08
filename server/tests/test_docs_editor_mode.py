"""M150 (docs/WIKI.md §22.6): how Desktop / Web edits Docs pages (UserMe.docs_editor_mode) — set
and reset through PATCH /users/me, private like the composer's mode (SYNC_PROTOCOL.md §6)."""

from collections.abc import Callable

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user


async def test_set_and_reset_docs_editor_mode(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    assert (await client.get("/api/v1/users/me")).json()["docs_editor_mode"] is None
    for mode in ("markdown", "wysiwyg"):
        updated = await client.patch("/api/v1/users/me", json={"docs_editor_mode": mode})
        assert updated.status_code == 200, updated.text
        assert updated.json()["docs_editor_mode"] == mode
        await db.refresh(alice)
        assert alice.docs_editor_mode == mode
    # Other fields (the composer's mode too) leave it alone.
    other = await client.patch("/api/v1/users/me", json={"composer_mode": "markdown"})
    assert other.status_code == 200, other.text
    await db.refresh(alice)
    me = (await client.get("/api/v1/users/me")).json()
    assert me["docs_editor_mode"] == "wysiwyg" and me["composer_mode"] == "markdown"
    reset = await client.patch("/api/v1/users/me", json={"docs_editor_mode": None})
    assert reset.status_code == 200 and reset.json()["docs_editor_mode"] is None


async def test_docs_editor_mode_validation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    for bad in ("rich", "", "WYSIWYG", 1, True):
        result = await client.patch("/api/v1/users/me", json={"docs_editor_mode": bad})
        assert result.status_code == 422, bad
        assert result.json()["error"]["code"] == "validation_error"
    await db.refresh(alice)
    assert alice.docs_editor_mode is None
    # Not part of what everyone sees of me.
    assert "docs_editor_mode" not in (await client.get(f"/api/v1/users/{alice.id}")).json()
