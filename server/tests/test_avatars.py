"""Profile pictures (M14a)."""

import io
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user


def _png(width: int, height: int, noisy: bool = False) -> bytes:
    image = Image.new("RGB", (width, height), (30, 120, 200))
    if noisy:
        image = Image.effect_noise((width, height), 100).convert("RGB")
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


async def _upload(client: AsyncClient, data: bytes, claimed: str = "image/png") -> Any:
    return await client.post("/api/v1/users/me/avatar", files={"file": ("me.png", data, claimed)})


async def test_avatar_upload_view_and_removal(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    assert (await client.get(f"/api/v1/users/{alice.id}/avatar")).status_code == 404

    uploaded = await _upload(client, _png(300, 200))
    assert uploaded.status_code == 200, uploaded.text
    version = uploaded.json()["avatar_updated_at"]
    assert version is not None
    listed = await client.get("/api/v1/users")
    assert (
        next(u for u in listed.json() if u["id"] == str(alice.id))["avatar_updated_at"] == version
    )

    as_user(bob)
    picture = await client.get(f"/api/v1/users/{alice.id}/avatar", params={"v": version})
    assert picture.status_code == 200
    assert picture.headers["content-type"] == "image/png"
    assert "max-age=86400" in picture.headers["cache-control"]
    with Image.open(io.BytesIO(picture.content)) as image:
        assert image.size == (256, 256)

    as_user(alice)
    again = await _upload(client, _png(64, 64))
    assert again.status_code == 200 and again.json()["avatar_updated_at"] != version
    removed = await client.delete("/api/v1/users/me/avatar")
    assert removed.status_code == 200 and removed.json()["avatar_updated_at"] is None
    assert (await client.get(f"/api/v1/users/{alice.id}/avatar")).status_code == 404


async def test_avatar_rejects_junk_and_huge_files(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    junk = await _upload(client, b"not an image at all", "image/png")
    assert junk.status_code == 400 and junk.json()["error"]["code"] == "avatar_not_image"
    empty = await _upload(client, b"")
    assert empty.status_code == 400
    huge = await _upload(client, _png(900, 900, noisy=True))
    assert huge.status_code == 413 and huge.json()["error"]["code"] == "avatar_too_large"
    assert (await client.get(f"/api/v1/users/{alice.id}/avatar")).status_code == 404
