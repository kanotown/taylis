"""M93 (docs/WORKSPACES.md §3.4): the workspace icon an administrator sets."""

import io
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.audit.models import AuditLog
from app.modules.users.models import User
from tests.helpers import make_user

API = "/api/v1"
ICON = f"{API}/admin/workspace-settings/icon"


def _image(width: int, height: int, fmt: str = "PNG") -> bytes:
    image = Image.new("RGB", (width, height), (30, 120, 200))
    out = io.BytesIO()
    image.save(out, format=fmt)
    return out.getvalue()


async def _upload(client: AsyncClient, data: bytes, name: str = "logo.png") -> Any:
    return await client.post(ICON, files={"file": (name, data, "image/png")})


async def test_admin_sets_the_icon_everyone_sees_it_before_signing_in(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    member = await make_user(db, "member")
    info = (await client.get(f"{API}/server")).json()
    assert info["icon_version"] is None
    assert (await client.get(f"{API}/server/icon")).status_code == 404

    as_user(root)
    uploaded = await _upload(client, _image(400, 300, "JPEG"), "logo.jpg")
    assert uploaded.status_code == 200, uploaded.text
    version = uploaded.json()["icon_version"]
    assert version and uploaded.json()["updated_by"] == str(root.id)

    # Public: no sign-in needed (the login screen shows it).
    app.dependency_overrides.clear()
    assert (await client.get(f"{API}/server")).json()["icon_version"] == version
    picture = await client.get(f"{API}/server/icon", params={"v": version})
    assert picture.status_code == 200
    assert picture.headers["content-type"] == "image/png"
    assert "public" in picture.headers["cache-control"]
    with Image.open(io.BytesIO(picture.content)) as image:
        assert image.size == (256, 256)

    # Signed-in devices get it in bootstrap's workspace_settings.
    as_user(member)
    boot = (await client.get(f"{API}/sync/bootstrap")).json()
    assert boot["workspace_settings"]["icon_version"] == version

    # A new upload is a new version; removing returns to the letter tile.
    as_user(root)
    again = (await _upload(client, _image(64, 64, "WEBP"), "logo.webp")).json()
    assert again["icon_version"] not in (None, version)
    removed = await client.delete(ICON)
    assert removed.status_code == 200 and removed.json()["icon_version"] is None
    assert (await client.get(f"{API}/server")).json()["icon_version"] is None
    missing = await client.get(f"{API}/server/icon")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "workspace_icon_not_found"
    # Removing again changes nothing (no audit, no event).
    assert (await client.delete(ICON)).status_code == 200

    audits = (
        (
            await db.execute(
                select(AuditLog)
                .where(AuditLog.action == "workspace.settings_updated")
                .order_by(AuditLog.id)
            )
        )
        .scalars()
        .all()
    )
    assert [a.details for a in audits] == [
        {"icon": {"from": None, "to": version}},
        {"icon": {"from": version, "to": again["icon_version"]}},
        {"icon": {"from": again["icon_version"], "to": None}},
    ]
    events = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "workspace.settings_updated")
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    assert [e.audience_type for e in events] == ["all", "all", "all"]
    assert [e.payload["settings"]["icon_version"] for e in events] == [
        version,
        again["icon_version"],
        None,
    ]


async def test_only_admins_upload_and_junk_is_refused(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    member = await make_user(db, "member")
    as_user(member)
    assert (await _upload(client, _image(64, 64))).status_code == 403
    assert (await client.delete(ICON)).status_code == 403

    as_user(root)
    junk = await _upload(client, b"not an image at all")
    assert junk.status_code == 400
    assert junk.json()["error"]["code"] == "workspace_icon_not_image"
    gif = await _upload(client, _image(64, 64, "GIF"), "logo.gif")
    assert gif.status_code == 400
    assert gif.json()["error"]["code"] == "workspace_icon_not_image"
    empty = await _upload(client, b"")
    assert empty.status_code == 400 and empty.json()["error"]["code"] == "workspace_icon_empty"
    assert (await client.get(f"{API}/server")).json()["icon_version"] is None
