"""Custom emoji (M12f): upload, list, image, delete and the event everyone hears."""

import io
from collections.abc import Callable
from typing import Any

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
