"""Shared steps of the drive tests (docs/DRIVE.md, M160)."""

import hashlib
import uuid
from collections.abc import Callable
from typing import Any

from fastapi import Depends, FastAPI
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.modules.auth.deps import get_current_user
from app.modules.users.models import User

PART = 1024  # the tests' part size (DRIVE_PART_BYTES), so a few KB make several parts


def drive_settings(app: FastAPI, **overrides: Any) -> None:
    """Small parts (and any other DRIVE_* override) for this test's app."""
    app.state.settings = app.state.settings.model_copy(
        update={"drive_part_bytes": PART, **overrides}
    )


async def workspace_root(client: AsyncClient) -> str:
    locations = (await client.get("/api/v1/drive/locations")).json()["locations"]
    return str(next(loc["root_id"] for loc in locations if loc["kind"] == "workspace"))


async def location(client: AsyncClient, kind: str, **extra: Any) -> dict[str, Any]:
    response = await client.post("/api/v1/drive/locations/resolve", json={"kind": kind, **extra})
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def folder(client: AsyncClient, parent_id: str, name: str) -> str:
    response = await client.post(
        "/api/v1/drive/folders", json={"parent_id": parent_id, "name": name}
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


async def start(
    client: AsyncClient,
    parent_id: str,
    name: str,
    size: int,
    *,
    on_conflict: str = "fail",
    relative_dir: str | None = None,
    target_item_id: str | None = None,
    client_upload_id: str | None = None,
) -> Response:
    body: dict[str, Any] = {
        "client_upload_id": client_upload_id or str(uuid.uuid4()),
        "parent_id": parent_id,
        "name": name,
        "size_bytes": size,
        "on_conflict": on_conflict,
    }
    if relative_dir is not None:
        body["relative_dir"] = relative_dir
    if target_item_id is not None:
        body["target_item_id"] = target_item_id
    return await client.post("/api/v1/drive/uploads", json=body)


async def put_part(client: AsyncClient, upload_id: str, number: int, data: bytes) -> Response:
    return await client.put(
        f"/api/v1/drive/uploads/{upload_id}/parts/{number}",
        content=data,
        headers={
            "Content-Type": "application/octet-stream",
            "X-Content-SHA256": hashlib.sha256(data).hexdigest(),
        },
    )


async def send_parts(client: AsyncClient, upload: dict[str, Any], data: bytes) -> None:
    size = upload["part_size"]
    for number in range(1, upload["parts_total"] + 1):
        chunk = data[(number - 1) * size : number * size]
        response = await put_part(client, upload["id"], number, chunk)
        assert response.status_code == 200, response.text


async def complete(client: AsyncClient, upload_id: str) -> Response:
    return await client.post(f"/api/v1/drive/uploads/{upload_id}/complete")


async def upload(
    client: AsyncClient, parent_id: str, name: str, data: bytes, **options: Any
) -> dict[str, Any]:
    """A whole upload; the item it made."""
    started = await start(client, parent_id, name, len(data), **options)
    assert started.status_code == 201, started.text
    session = started.json()
    await send_parts(client, session, data)
    done = await complete(client, session["id"])
    assert done.status_code == 200, done.text
    item: dict[str, Any] = done.json()["item"]
    return item


async def children(client: AsyncClient, folder_id: str, **params: Any) -> Response:
    return await client.get(f"/api/v1/drive/folders/{folder_id}/children", params=params)


async def names_in(client: AsyncClient, folder_id: str) -> list[str]:
    response = await children(client, folder_id)
    assert response.status_code == 200, response.text
    return [item["name"] for item in response.json()["items"]]


def act_as(app: FastAPI) -> Callable[[User], None]:
    """Like conftest's as_user, but the user is loaded in the request's own session, as the real
    authentication does: a rollback in a request then expires it, and a lazy load after that
    fails as it would in production."""

    def apply(user: User) -> None:
        user_id = user.id

        async def current(db: AsyncSession = Depends(get_db)) -> User:
            found = await db.get(User, user_id)
            assert found is not None
            return found

        app.dependency_overrides[get_current_user] = current

    return apply
