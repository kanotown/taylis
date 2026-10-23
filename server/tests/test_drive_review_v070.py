"""REVIEW-v0.1.70 (docs/DRIVE.md §28): an upload completed after its folder moved to another
location (#1), a ZIP ticket whose entries lost access (#2), the completion's answer for a file the
uploader can no longer read (#3), and the same part sent twice at once with different bytes (#5).
The tests act as two people through the real API (drive_helpers.act_as)."""

import asyncio
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import MemoryBlobStore
from app.modules.drive import repository as repo
from app.modules.drive import service
from app.modules.drive.models import DriveUpload
from app.modules.users.models import User
from tests.drive_helpers import (
    act_as,
    children,
    complete,
    drive_settings,
    folder,
    location,
    names_in,
    send_parts,
    start,
    upload,
    workspace_root,
)
from tests.helpers import make_user

API = "/api/v1"


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


def blobs(app: FastAPI) -> MemoryBlobStore:
    store = app.state.blobs
    assert isinstance(store, MemoryBlobStore)
    return store


async def move(client: AsyncClient, item_id: str, target_folder_id: str) -> None:
    response = await client.post(
        f"{API}/drive/items/move",
        json={"item_ids": [item_id], "target_folder_id": target_folder_id, "on_conflict": "fail"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["results"][0]["ok"], response.text


async def content(client: AsyncClient, item_id: str) -> bytes:
    response = await client.get(f"{API}/drive/items/{item_id}/content")
    assert response.status_code == 200, response.text
    return response.content


async def reserved(app: FastAPI) -> int:
    async with app.state.drive.session_factory() as db:
        return await repo.reserved_bytes(db, None)


async def assert_ended_moved(app: FastAPI, client: AsyncClient, session: dict[str, Any]) -> None:
    """The session is over: aborted with the error, no reservation, its multipart dropped."""
    state = (await client.get(f"{API}/drive/uploads/{session['id']}")).json()
    assert state["status"] == "aborted" and state["error"] == "drive_upload_target_moved"
    assert state["received_parts"] == []
    assert await reserved(app) == 0
    async with app.state.drive.session_factory() as db:
        row = await db.get(DriveUpload, session["id"])
        assert row is not None
        key = attachments.storage_key(row.attachment_id)
        s3_upload_id = row.s3_upload_id
    store = blobs(app)
    assert s3_upload_id not in store.uploads
    assert key not in store.objects
    # Asked again: the same answer (not 410, not a completion).
    again = await complete(client, session["id"])
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "drive_upload_target_moved"


def moved_error(response: Any) -> None:
    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == "drive_upload_target_moved"


# --- #1: the folder moved to another location during the upload ---------------------------------


async def test_new_version_refused_after_the_folder_moved_to_someone_elses_drive(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """The review's case: parts sent, then B moves the folder to B's マイドライブ and saves a
    file of the same name; A's `version` completion must not overwrite it."""
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    shared = await folder(client, await workspace_root(client), "folder")
    session = (await start(client, shared, "file.txt", 4, on_conflict="version")).json()
    await send_parts(client, session, b"EVIL")
    assert await reserved(app) == 4

    as_user(bob)
    mine = await location(client, "me")
    await move(client, shared, mine["root_id"])
    private = await upload(client, shared, "file.txt", b"PRIVATE")

    as_user(alice)
    assert (await children(client, shared)).status_code == 404
    moved_error(await complete(client, session["id"]))
    await assert_ended_moved(app, client, session)

    as_user(bob)
    assert await content(client, private["id"]) == b"PRIVATE"
    versions = await client.get(f"{API}/drive/items/{private['id']}/versions")
    assert len(versions.json()["versions"]) == 1
    usage = await location(client, "me")
    assert usage["root_id"] == mine["root_id"]


async def test_new_file_refused_when_the_folder_moved_before_the_parts(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    shared = await folder(client, await workspace_root(client), "folder")
    session = (await start(client, shared, "new.txt", 3)).json()

    as_user(bob)
    mine = await location(client, "me")
    await move(client, shared, mine["root_id"])

    as_user(alice)
    await send_parts(client, session, b"new")  # the parts still go in: the completion decides
    moved_error(await complete(client, session["id"]))
    await assert_ended_moved(app, client, session)
    as_user(bob)
    assert await names_in(client, shared) == []


async def test_relative_dir_refused_after_the_folder_moved(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    shared = await folder(client, await workspace_root(client), "folder")
    session = (await start(client, shared, "deep.txt", 4, relative_dir="sub/deeper")).json()
    await send_parts(client, session, b"deep")

    as_user(bob)
    mine = await location(client, "me")
    await move(client, shared, mine["root_id"])

    as_user(alice)
    moved_error(await complete(client, session["id"]))
    await assert_ended_moved(app, client, session)
    as_user(bob)
    assert await names_in(client, shared) == []  # no folder made in B's drive


async def test_relative_dir_folder_moved_away_during_the_upload(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """Only the existing subfolder of relative_dir moves to B's drive: the file goes in a new
    folder of that name in the session's location, never into B's."""
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    shared = await folder(client, await workspace_root(client), "folder")
    sub = await folder(client, shared, "sub")
    session = (await start(client, shared, "deep.txt", 4, relative_dir="sub")).json()
    await send_parts(client, session, b"deep")

    as_user(bob)
    mine = await location(client, "me")
    await move(client, sub, mine["root_id"])

    as_user(alice)
    done = await complete(client, session["id"])
    assert done.status_code == 200, done.text
    as_user(bob)
    assert await names_in(client, sub) == []
    as_user(alice)
    item = done.json()["item"]
    assert item["parent_id"] != sub and await names_in(client, item["parent_id"]) == ["deep.txt"]


async def test_target_item_moved_to_someone_elses_drive(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    root = await workspace_root(client)
    original = await upload(client, root, "report.txt", b"v1")
    session = (await start(client, root, "report.txt", 2, target_item_id=original["id"])).json()
    await send_parts(client, session, b"v2")

    as_user(bob)
    mine = await location(client, "me")
    await move(client, original["id"], mine["root_id"])

    as_user(alice)
    moved_error(await complete(client, session["id"]))
    await assert_ended_moved(app, client, session)
    as_user(bob)
    assert await content(client, original["id"]) == b"v1"


async def test_folder_moved_while_the_completion_waits_for_its_lock(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """B's move holds the folder's row (moved, not yet committed) while A's completion, past
    its first checks, waits to lock it: once B commits, the completion sees the new location."""
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    shared = await folder(client, await workspace_root(client), "folder")
    session = (await start(client, shared, "file.txt", 4, on_conflict="version")).json()
    await send_parts(client, session, b"EVIL")
    as_user(bob)
    mine = await location(client, "me")

    moved, release = asyncio.Event(), asyncio.Event()
    real = service.move_across_in_tx

    async def held(*args: Any, **kwargs: Any) -> None:
        await real(*args, **kwargs)
        moved.set()
        await release.wait()

    monkeypatch.setattr(service, "move_across_in_tx", held)
    moving = asyncio.create_task(move(client, shared, mine["root_id"]))
    await asyncio.wait_for(moved.wait(), 5)
    as_user(alice)
    completing = asyncio.create_task(complete(client, session["id"]))
    async with app.state.drive.session_factory() as watch:
        for _ in range(200):
            waiting = await watch.execute(text("SELECT count(*) FROM pg_locks WHERE NOT granted"))
            if int(waiting.scalar_one()) > 0:
                break
            await watch.rollback()
            await asyncio.sleep(0.02)
        else:
            raise AssertionError("the completion never waited for the folder's lock")
    release.set()
    await moving
    moved_error(await completing)
    await assert_ended_moved(app, client, session)
    as_user(bob)
    assert await names_in(client, shared) == []
