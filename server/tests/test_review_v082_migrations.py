"""REVIEW-v0.1.82 #1, #2: the downgrades of 0126 (channel files) and 0127 (albums) leave nothing
that the server before them would break: posted files that are drive versions too (#1), share
links that hand out no originals (#2). Each test migrates its worker's database down and back up
(as test_reservation_walkins.py does); the downgrade runs in one transaction, so a refused one
changes nothing."""

import argparse
import os
import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import MemoryBlobStore
from app.modules.users.models import User
from tests.conftest import SERVER_DIR, _run_in_thread
from tests.drive_helpers import act_as, drive_settings, folder, upload, workspace_root
from tests.helpers import make_user
from tests.test_albums import jpeg, make_album, run_media, upload_photo, visitor
from tests.test_channel_files import make_channel, post

API = "/api/v1"


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


def _config(database_url: str, *x: str) -> Config:
    cfg = Config(str(SERVER_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVER_DIR / "migrations"))
    cfg.cmd_opts = argparse.Namespace(x=list(x))
    os.environ["DATABASE_URL"] = database_url
    return cfg


async def _revision(app: FastAPI) -> str:
    async with app.state.db.engine.connect() as conn:
        return str((await conn.execute(text("SELECT version_num FROM alembic_version"))).scalar())


async def _ok(response: Any, status: int = 200) -> Any:
    assert response.status_code == status, response.text
    return response.json()


# --- #1: 0126 -------------------------------------------------------------------------------------


async def _old_delete_and_gc(app: FastAPI, blobs: MemoryBlobStore, message_ids: list[str]) -> None:
    """What the server before 0126 does (9b376db2): `messages.delete_message` marks the message's
    attachments `deleted` (`attachments.mark_deleted_in_tx`), and the GC removes each deleted
    row's bytes and derived objects, then the row."""
    async with app.state.db.engine.begin() as conn:
        for message_id in message_ids:
            await conn.execute(
                text(
                    "UPDATE attachments SET status = 'deleted', deleted_at = now() "
                    "WHERE message_id = :m"
                ),
                {"m": uuid.UUID(message_id)},
            )
    async with app.state.db.engine.begin() as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT id, storage_key, thumbnail_key, preview_pdf_key, preview_thumb_key "
                    "FROM attachments WHERE status = 'deleted'"
                )
            )
        ).all()
        for row in rows:
            for key in row[1:]:
                if key:
                    await blobs.delete(key)
            await conn.execute(text("DELETE FROM attachments WHERE id = :id"), {"id": row[0]})


async def test_0126_downgrade_keeps_the_drive_versions_of_posted_files(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    migrated_database: str,
) -> None:
    drive_settings(app)
    blobs = app.state.blobs
    assert isinstance(blobs, MemoryBlobStore)
    alice = await make_user(db, "alice", role="admin")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    plain = await post(client, lab["id"], [("plain.txt", b"plain")])
    moved = await post(client, lab["id"], [("moved.txt", b"moved")])
    versioned = await post(client, lab["id"], [("draft.txt", b"version one")])
    trashed = await post(client, lab["id"], [("trashed.txt", b"trashed")])
    purged = await post(client, lab["id"], [("purged.txt", b"purged")])
    posts = [plain, moved, versioned, trashed, purged]

    def drive_of(message: dict[str, Any]) -> str:
        return str(message["attachments"][0]["drive"]["item_id"])

    root = await workspace_root(client)
    await _ok(
        await client.post(
            f"{API}/drive/items/move",
            json={"item_ids": [drive_of(moved)], "target_folder_id": root},
        )
    )
    month = (await _ok(await client.get(f"{API}/drive/items/{drive_of(versioned)}")))["item"]
    await upload(client, month["parent_id"], "draft.txt", b"version two", on_conflict="version")
    await _ok(await client.post(f"{API}/drive/items/trash", json={"item_ids": [drive_of(trashed)]}))
    await _ok(await client.post(f"{API}/drive/items/trash", json={"item_ids": [drive_of(purged)]}))
    assert (await client.delete(f"{API}/drive/items/{drive_of(purged)}")).status_code == 204
    async with app.state.db.session_factory() as session:
        await attachments.gc(session, blobs, now=utcnow() + timedelta(days=2))
    await db.close()

    async def drive_state() -> tuple[list[tuple[str, int]], dict[str, int], list[str]]:
        async with app.state.db.engine.connect() as conn:
            versions = (
                await conn.execute(
                    text(
                        "SELECT a.storage_key, v.size_bytes FROM drive_file_versions v "
                        "JOIN attachments a ON a.id = v.attachment_id ORDER BY a.storage_key"
                    )
                )
            ).all()
            used = (await conn.execute(text("SELECT id, used_bytes FROM drive_locations"))).all()
            items = (
                await conn.execute(text("SELECT id FROM drive_items WHERE kind = 'file'"))
            ).all()
        return (
            [(r[0], int(r[1])) for r in versions],
            {str(r[0]): int(r[1]) for r in used},
            sorted(str(r[0]) for r in items),
        )

    before = await drive_state()
    assert len(before[0]) == 5  # plain, moved, two of draft.txt, trashed
    head = await _revision(app)
    try:
        # Refused while a posted file is a drive version too: nothing changes.
        with pytest.raises(RuntimeError, match="0126 downgrade refused: 4 posted file"):
            _run_in_thread(lambda: command.downgrade(_config(migrated_database), "0125"))
        await app.state.db.engine.dispose()
        assert await _revision(app) == head
        assert await drive_state() == before
        # Detached: the drive keeps every version; the server before 0126 then deletes the
        # messages and runs its GC without touching them.
        _run_in_thread(
            lambda: command.downgrade(_config(migrated_database, "channel_files=detach"), "0125")
        )
        await app.state.db.engine.dispose()
        assert await _revision(app) == "0125"
        await _old_delete_and_gc(app, blobs, [m["id"] for m in posts])
        after = await drive_state()
        assert after == before
        for key, size in after[0]:
            assert len(blobs.objects[key][0]) == size
        async with app.state.db.engine.connect() as conn:
            shown = (
                await conn.execute(
                    text("SELECT count(*) FROM attachments WHERE message_id IS NOT NULL")
                )
            ).scalar()
        assert shown == 0  # the messages no longer show the files (their text stays)
    finally:
        _run_in_thread(lambda: command.upgrade(_config(migrated_database), "head"))
        await app.state.db.engine.dispose()
    assert await _revision(app) == head


async def test_0126_downgrade_without_posted_files_needs_nothing(
    app: FastAPI, client: AsyncClient, db: AsyncSession, migrated_database: str
) -> None:
    """A message deleted (kept in the drive) or a file never posted: nothing to refuse."""
    await db.close()
    try:
        _run_in_thread(lambda: command.downgrade(_config(migrated_database), "0125"))
        await app.state.db.engine.dispose()
        assert await _revision(app) == "0125"
    finally:
        _run_in_thread(lambda: command.upgrade(_config(migrated_database), "head"))
        await app.state.db.engine.dispose()


# --- #2: 0127 -------------------------------------------------------------------------------------


async def test_0127_downgrade_revokes_links_without_originals(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    migrated_database: str,
) -> None:
    drive_settings(app)
    as_user(await make_user(db, "aiko"))
    root = await workspace_root(client)
    album = await _ok(await make_album(client, parent_id=root, name="合宿"), 201)
    album_id = album["folder"]["id"]
    photo = await upload_photo(
        client, album_id, "IMG_0001.JPG", jpeg(original="2026:08:01 10:00:00", gps=True)
    )
    plain_folder = await folder(client, root, "資料")
    await run_media(app)

    async def link(item_id: str, **body: Any) -> dict[str, Any]:
        made = await _ok(await client.post(f"{API}/drive/items/{item_id}/links", json=body), 201)
        return {"id": made["link"]["id"], "token": made["path"].removeprefix("/s/")}

    closed = {
        "default": await link(album_id),
        "password": await link(album_id, password="correct horse 42"),
        "expires": await link(album_id, expires_at=(utcnow() + timedelta(days=3)).isoformat()),
        "photo": await link(photo["id"], originals=False),
    }
    opened = {
        "album_originals": await link(album_id, originals=True),
        "folder": await link(plain_folder),
    }
    await db.close()

    async def revoked() -> dict[str, bool]:
        async with app.state.db.engine.connect() as conn:
            rows = (await conn.execute(text("SELECT id, revoked_at FROM drive_share_links"))).all()
        return {str(r[0]): r[1] is not None for r in rows}

    head = await _revision(app)
    try:
        with pytest.raises(RuntimeError, match="0127 downgrade refused: 4 share link"):
            _run_in_thread(lambda: command.downgrade(_config(migrated_database), "0126"))
        await app.state.db.engine.dispose()
        assert await _revision(app) == head
        assert not any((await revoked()).values())
        _run_in_thread(
            lambda: command.downgrade(_config(migrated_database, "album_links=revoke"), "0126")
        )
        await app.state.db.engine.dispose()
        assert await _revision(app) == "0126"
        # The server before 0127 honours revoked_at (shares.link_state since 0119): those links
        # hand out nothing, the ones that allowed originals stay.
        state = await revoked()
        assert {name: state[made["id"]] for name, made in closed.items()} == dict.fromkeys(
            closed, True
        )
        assert {name: state[made["id"]] for name, made in opened.items()} == dict.fromkeys(
            opened, False
        )
    finally:
        _run_in_thread(lambda: command.upgrade(_config(migrated_database), "head"))
        await app.state.db.engine.dispose()
    assert await _revision(app) == head
    # Back on this version: the revoked links answer nothing (the original, Range, the ZIP).
    async with visitor(app) as v:
        for made in closed.values():
            token = made["token"]
            assert (await v.get(f"{API}/shares/{token}")).status_code in (404, 410)
            got = await v.get(
                f"{API}/shares/{token}/items/{photo['id']}/content",
                headers={"Range": "bytes=0-99"},
            )
            assert got.status_code in (404, 410)
            assert (await v.get(f"{API}/shares/{token}/zip")).status_code in (404, 410)
        kept = await v.get(f"{API}/shares/{opened['album_originals']['token']}")
        assert kept.status_code == 200
