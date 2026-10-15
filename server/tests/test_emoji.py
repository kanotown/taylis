"""Custom emoji (M12f): upload, list, image, delete and the event everyone hears."""

import io
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from tests.helpers import make_user


def _png(width: int = 64, height: int = 64) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", (width, height), (255, 0, 0, 255)).save(buffer, "PNG")
    return buffer.getvalue()


async def _add(client: AsyncClient, name: str, data: bytes, claimed: str = "image/png") -> Any:
    return await client.post(
        "/api/v1/emoji", data={"name": name}, files={"file": ("e.png", data, claimed)}
    )


async def test_upload_list_image_and_delete(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    admin = await make_user(db, "root", role="admin")
    as_user(alice)
    created = await _add(client, " Party_Parrot ", _png())
    assert created.status_code == 201, created.text
    parrot = created.json()
    assert parrot["name"] == "party_parrot" and parrot["width"] == 64
    assert (await _add(client, "party_parrot", _png())).status_code == 409
    for bad in ("x", "bad name", "日本語", "a" * 33):
        assert (await _add(client, bad, _png())).status_code == 400
    assert (await _add(client, "notimage", b"<html>")).status_code == 400
    assert (await _add(client, "huge", _png(600, 10))).status_code == 400
    assert (await _add(client, "empty", b"")).status_code == 400

    as_user(bob)
    listed = (await client.get("/api/v1/emoji")).json()
    assert [e["name"] for e in listed] == ["party_parrot"]
    booted = (await client.get("/api/v1/sync/bootstrap")).json()
    assert [e["name"] for e in booted["custom_emoji"]] == ["party_parrot"]
    image = await client.get(f"/api/v1/emoji/{parrot['id']}/image")
    assert image.status_code == 200 and image.headers["content-type"] == "image/png"
    assert image.content[:8] == b"\x89PNG\r\n\x1a\n"
    # Anyone can use it; only the creator or an admin removes it.
    assert (await client.delete(f"/api/v1/emoji/{parrot['id']}")).status_code == 403
    as_user(admin)
    assert (await client.delete(f"/api/v1/emoji/{parrot['id']}")).status_code == 204
    assert (await client.get(f"/api/v1/emoji/{parrot['id']}/image")).status_code == 404
    assert (await client.get("/api/v1/emoji")).json() == []
    events = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "emoji.updated")))
        .scalars()
        .all()
    )
    assert [(e.audience_type, e.payload["deleted"]) for e in events] == [
        ("all", False),
        ("all", True),
    ]
    assert events[0].payload["emoji"]["name"] == "party_parrot"


async def test_image_versions_etag_and_caching(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], app: FastAPI
) -> None:
    """docs/EMOJI.md §2.1: `?v=<image_version>` may be kept for good; ETag / If-None-Match → 304;
    without `v` (older clients) the day-long caching as before; sign-in still needed."""
    alice = await make_user(db, "alice")
    as_user(alice)
    emoji = (await _add(client, "parrot", _png())).json()
    version = emoji["image_version"]
    assert isinstance(version, str) and len(version) == 16
    listed = (await client.get("/api/v1/emoji")).json()
    assert listed[0]["image_version"] == version
    path = f"/api/v1/emoji/{emoji['id']}/image"

    versioned = await client.get(f"{path}?v={version}")
    assert versioned.status_code == 200
    assert versioned.headers["cache-control"] == "private, max-age=31536000, immutable"
    assert versioned.headers["etag"] == f'"{version}"'

    plain = await client.get(path)
    assert plain.headers["cache-control"] == "private, max-age=86400"
    assert plain.headers["etag"] == f'"{version}"'
    # A stale or unknown version is not kept for good.
    stale = await client.get(f"{path}?v=0000000000000000")
    assert stale.status_code == 200 and stale.headers["cache-control"] == "private, max-age=86400"

    for header in (f'"{version}"', f'W/"{version}"', f'"other", "{version}"', "*"):
        hit = await client.get(f"{path}?v={version}", headers={"If-None-Match": header})
        assert hit.status_code == 304 and hit.content == b""
        assert hit.headers["etag"] == f'"{version}"'
    miss = await client.get(path, headers={"If-None-Match": '"other"'})
    assert miss.status_code == 200 and miss.content[:4] == b"\x89PNG"

    text = await client.post("/api/v1/emoji/text", json={"name": "ok-text", "label": "OK"})
    assert text.status_code == 201 and text.json()["image_version"] is None

    app.dependency_overrides.clear()
    assert (await client.get(f"{path}?v={version}")).status_code == 401
