"""REVIEW-v0.1.70 (docs/DRIVE.md §28): an upload completed after its folder moved to another
location (#1), a ZIP ticket whose entries lost access (#2), the completion's answer for a file the
uploader can no longer read (#3), and the same part sent twice at once with different bytes (#5).
The tests act as two people through the real API (drive_helpers.act_as)."""

import asyncio
import io
import zipfile
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


# --- #3: the completion asked again after the file became unreadable ----------------------------


async def test_completion_asked_again_hides_a_file_moved_to_someone_elses_drive(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    root = await workspace_root(client)
    session = (await start(client, root, "old.txt", 3)).json()
    await send_parts(client, session, b"old")
    first = await complete(client, session["id"])
    assert first.status_code == 200
    made = first.json()["item"]
    # Unchanged permissions: the same answer again (idempotent).
    again = await complete(client, session["id"])
    assert again.status_code == 200 and again.json() == first.json()

    as_user(bob)
    mine = await location(client, "me")
    await move(client, made["id"], mine["root_id"])
    renamed = await client.patch(
        f"{API}/drive/items/{made['id']}", json={"name": "PRIVATE-NEW-NAME.txt"}
    )
    assert renamed.status_code == 200, renamed.text
    await upload(
        client, mine["root_id"], "PRIVATE-NEW-NAME.txt", b"new secret", on_conflict="version"
    )

    as_user(alice)
    assert (await client.get(f"{API}/drive/items/{made['id']}")).status_code == 404
    late = await complete(client, session["id"])
    assert late.status_code == 200, late.text
    assert late.json() == {"status": "completed", "item": None, "version_id": None}
    assert "PRIVATE" not in late.text


async def test_completion_asked_again_after_leaving_the_channel(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    owner = await make_user(db, "owner")
    member = await make_user(db, "member")
    as_user(owner)
    lab = (await client.post(f"{API}/channels", json={"name": "lab", "type": "private"})).json()
    joined = await client.post(
        f"{API}/channels/{lab['id']}/members", json={"user_id": str(member.id)}
    )
    assert joined.status_code in (200, 201, 204), joined.text
    drive = await location(client, "channel", channel_id=lab["id"])
    as_user(member)
    session = (await start(client, drive["root_id"], "notes.txt", 5)).json()
    await send_parts(client, session, b"notes")
    first = await complete(client, session["id"])
    assert first.status_code == 200 and first.json()["item"]["name"] == "notes.txt"

    as_user(owner)
    removed = await client.delete(f"{API}/channels/{lab['id']}/members/{member.id}")
    assert removed.status_code in (200, 204), removed.text
    renamed = await client.patch(
        f"{API}/drive/items/{first.json()['item']['id']}", json={"name": "after.txt"}
    )
    assert renamed.status_code == 200, renamed.text

    as_user(member)
    late = await complete(client, session["id"])
    assert late.status_code == 200
    assert late.json() == {"status": "completed", "item": None, "version_id": None}
    # The session itself still says how it ended (its own ids, no names).
    state = (await client.get(f"{API}/drive/uploads/{session['id']}")).json()
    assert state["status"] == "completed" and state["item_id"] == first.json()["item"]["id"]


# --- #2: a ZIP ticket whose entries lost access ------------------------------------------------


async def make_zip(client: AsyncClient, item_ids: list[str]) -> str:
    response = await client.post(f"{API}/drive/zip", json={"item_ids": item_ids})
    assert response.status_code == 200, response.text
    return str(response.json()["url"])


def outdated(response: Any) -> None:
    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == "drive_zip_outdated"
    assert "CONFIDENTIAL" not in response.text


async def zip_tree(app: FastAPI, client: AsyncClient, db: AsyncSession) -> dict[str, Any]:
    """A shared folder of 研究室ドライブ with a file and a grandchild in a subfolder."""
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user = act_as(app)
    as_user(alice)
    root = await workspace_root(client)
    shared = await folder(client, root, "shared")
    sub = await folder(client, shared, "sub")
    child = await upload(client, shared, "confidential.txt", b"CONFIDENTIAL")
    grandchild = await upload(client, sub, "deeper.txt", b"CONFIDENTIAL-2")
    return {
        "alice": alice,
        "bob": bob,
        "as_user": as_user,
        "root": root,
        "shared": shared,
        "sub": sub,
        "child": child,
        "grandchild": grandchild,
    }


async def test_zip_refused_when_a_child_moved_to_someone_elses_drive(
    app: FastAPI, client: AsyncClient, db: AsyncSession
) -> None:
    """The review's case: only the child moves to B's マイドライブ; the folder stays readable."""
    t = await zip_tree(app, client, db)
    url = await make_zip(client, [t["shared"]])
    t["as_user"](t["bob"])
    mine = await location(client, "me")
    await move(client, t["child"]["id"], mine["root_id"])
    t["as_user"](t["alice"])
    assert (await client.get(f"{API}/drive/items/{t['child']['id']}/content")).status_code == 404
    outdated(await client.get(url))
    assert (await client.get(url)).status_code == 404  # the ticket was used up
    # A new ZIP has what A can read now.
    fresh = await client.get(await make_zip(client, [t["shared"]]))
    assert fresh.status_code == 200
    assert sorted(zipfile.ZipFile(io.BytesIO(fresh.content)).namelist()) == [
        "shared/",
        "shared/sub/",
        "shared/sub/deeper.txt",
    ]


async def test_zip_refused_when_a_grandchild_moved_to_a_channel_not_joined(
    app: FastAPI, client: AsyncClient, db: AsyncSession
) -> None:
    t = await zip_tree(app, client, db)
    url = await make_zip(client, [t["shared"]])
    t["as_user"](t["bob"])
    lab = (await client.post(f"{API}/channels", json={"name": "lab", "type": "private"})).json()
    drive = await location(client, "channel", channel_id=lab["id"])
    await move(client, t["grandchild"]["id"], drive["root_id"])
    t["as_user"](t["alice"])
    outdated(await client.get(url))


async def test_zip_refused_when_a_child_or_its_folder_went_to_the_trash(
    app: FastAPI, client: AsyncClient, db: AsyncSession
) -> None:
    t = await zip_tree(app, client, db)
    url = await make_zip(client, [t["shared"]])
    trashed = await client.post(f"{API}/drive/items/trash", json={"item_ids": [t["sub"]]})
    assert trashed.status_code == 200 and trashed.json()["results"][0]["ok"]
    outdated(await client.get(url))
    # A file in the trash on its own.
    url = await make_zip(client, [t["shared"]])
    trashed = await client.post(f"{API}/drive/items/trash", json={"item_ids": [t["child"]["id"]]})
    assert trashed.status_code == 200 and trashed.json()["results"][0]["ok"]
    outdated(await client.get(url))


async def test_zip_refused_when_the_entry_moved_to_a_channel_the_person_left(
    app: FastAPI, client: AsyncClient, db: AsyncSession
) -> None:
    """Both channels readable when the ticket is made; A is removed from the one the file
    moved to before the ZIP starts."""
    drive_settings(app)
    owner = await make_user(db, "owner")
    member = await make_user(db, "member")
    as_user = act_as(app)
    as_user(owner)
    drives = []
    for name in ("one", "two"):
        channel = (
            await client.post(f"{API}/channels", json={"name": name, "type": "private"})
        ).json()
        joined = await client.post(
            f"{API}/channels/{channel['id']}/members", json={"user_id": str(member.id)}
        )
        assert joined.status_code in (200, 201, 204), joined.text
        drives.append((channel, await location(client, "channel", channel_id=channel["id"])))
    box = await folder(client, drives[0][1]["root_id"], "box")
    secret = await upload(client, box, "secret.txt", b"CONFIDENTIAL")
    as_user(member)
    url = await make_zip(client, [box])
    as_user(owner)
    await move(client, secret["id"], drives[1][1]["root_id"])
    as_user(member)
    # Still a member of both: the file moved but is readable, the ZIP has the issued version.
    ok = await client.get(url)
    assert ok.status_code == 200
    assert zipfile.ZipFile(io.BytesIO(ok.content)).read("box/secret.txt") == b"CONFIDENTIAL"
    as_user(owner)
    await move(client, secret["id"], box)
    as_user(member)
    url = await make_zip(client, [box])
    as_user(owner)
    await move(client, secret["id"], drives[1][1]["root_id"])
    removed = await client.delete(f"{API}/channels/{drives[1][0]['id']}/members/{member.id}")
    assert removed.status_code in (200, 204), removed.text
    as_user(member)
    outdated(await client.get(url))


async def test_zip_keeps_the_issued_versions_of_readable_entries(
    app: FastAPI, client: AsyncClient, db: AsyncSession
) -> None:
    """A new version, a rename or a move inside the readable drive after the ticket: the ZIP
    still has what was fixed when it was made."""
    t = await zip_tree(app, client, db)
    url = await make_zip(client, [t["shared"]])
    await upload(client, t["shared"], "confidential.txt", b"NEWER", on_conflict="version")
    await move(client, t["grandchild"]["id"], t["root"])
    response = await client.get(url)
    assert response.status_code == 200, response.text
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert archive.read("shared/confidential.txt") == b"CONFIDENTIAL"
    assert archive.read("shared/sub/deeper.txt") == b"CONFIDENTIAL-2"
