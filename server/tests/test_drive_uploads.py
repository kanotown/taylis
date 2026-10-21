"""Drive uploads (M160, docs/DRIVE.md §6): sessions, parts, completion and its recovery, the three
name-conflict modes, folder uploads, quota reservations, expiry, Range downloads, the media loop,
and drive rows kept out of the chat's queries (§2)."""

import asyncio
import hashlib
import io
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.attachments import previews, video_backfill
from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import MemoryBlobStore
from app.modules.attachments.models import Attachment
from app.modules.drive import housekeeping, media, uploads
from app.modules.drive.models import DriveFileVersion, DriveItem, DriveLocation, DriveUpload
from app.modules.users.models import User
from tests.drive_helpers import (
    PART,
    act_as,
    complete,
    drive_settings,
    folder,
    names_in,
    put_part,
    send_parts,
    start,
    upload,
    workspace_root,
)
from tests.helpers import make_user

API = "/api/v1"


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    """The drive tests act with the user loaded in each request's session (drive_helpers)."""
    return act_as(app)


def blobs(app: FastAPI) -> MemoryBlobStore:
    store = app.state.blobs
    assert isinstance(store, MemoryBlobStore)
    return store


async def test_sessions_parts_and_completion_are_idempotent(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)
    data = bytes(range(256)) * 13  # 3328 bytes: parts of 1024, 1024, 1024, 256
    client_upload_id = str(uuid.uuid4())
    first = await start(client, root, "data.bin", len(data), client_upload_id=client_upload_id)
    assert first.status_code == 201, first.text
    session = first.json()
    assert (session["part_size"], session["parts_total"], session["received_parts"]) == (
        PART,
        4,
        [],
    )
    again = await start(client, root, "data.bin", len(data), client_upload_id=client_upload_id)
    assert again.status_code == 200 and again.json()["id"] == session["id"]
    upload_id = session["id"]

    # Checked parts: the number, the SHA-256 header, the size.
    assert (await put_part(client, upload_id, 0, data[:PART])).status_code == 422
    assert (await put_part(client, upload_id, 5, data[:PART])).status_code == 422
    no_hash = await client.put(f"{API}/drive/uploads/{upload_id}/parts/1", content=data[:PART])
    assert no_hash.status_code == 422 and no_hash.json()["error"]["code"] == "drive_part_invalid"
    wrong_hash = await client.put(
        f"{API}/drive/uploads/{upload_id}/parts/1",
        content=data[:PART],
        headers={"X-Content-SHA256": hashlib.sha256(b"other").hexdigest()},
    )
    assert wrong_hash.status_code == 422
    short = await put_part(client, upload_id, 1, data[:100])
    assert short.status_code == 422
    assert short.json()["error"]["details"] == {"expected_bytes": PART, "received_bytes": 100}
    assert (await put_part(client, upload_id, 4, data[:PART])).status_code == 422  # last: 256

    # Part 1 with other bytes, the rest, then part 1 again: the last one counts.
    assert (await put_part(client, upload_id, 1, b"\xff" * PART)).status_code == 200
    for number in (2, 3):
        assert (
            await put_part(client, upload_id, number, data[(number - 1) * PART : number * PART])
        ).status_code == 200
    missing = await complete(client, upload_id)
    assert missing.status_code == 409
    assert missing.json()["error"]["code"] == "drive_upload_incomplete"
    assert missing.json()["error"]["details"]["missing"] == [4]
    assert (await put_part(client, upload_id, 4, data[3 * PART :])).status_code == 200
    assert (await put_part(client, upload_id, 1, data[:PART])).status_code == 200
    state = (await client.get(f"{API}/drive/uploads/{upload_id}")).json()
    assert state["received_parts"] == [1, 2, 3, 4] and state["status"] == "active"
    resumable = (await client.get(f"{API}/drive/uploads", params={"status": "active"})).json()
    assert [u["id"] for u in resumable["uploads"]] == [upload_id]

    done = await complete(client, upload_id)
    assert done.status_code == 200, done.text
    item = done.json()["item"]
    assert (item["name"], item["size_bytes"], item["version_count"]) == ("data.bin", len(data), 1)
    resent = await complete(client, upload_id)
    assert resent.status_code == 200 and resent.json()["item"]["id"] == item["id"]
    replay = await start(client, root, "data.bin", len(data), client_upload_id=client_upload_id)
    assert replay.status_code == 200 and replay.json()["status"] == "completed"
    assert replay.json()["item_id"] == item["id"]
    assert await names_in(client, root) == ["data.bin"]
    late = await put_part(client, upload_id, 1, data[:PART])
    assert late.status_code == 409 and late.json()["error"]["code"] == "drive_upload_not_active"
    assert not blobs(app).uploads  # the multipart upload is joined

    body = await client.get(f"{API}/drive/items/{item['id']}/content")
    assert body.status_code == 200 and body.content == data
    assert body.headers["content-disposition"].startswith("attachment;")
    assert body.headers["content-security-policy"] == "sandbox"
    assert body.headers["x-content-type-options"] == "nosniff"
    # The media loop: the whole file's SHA-256.
    assert await media.process_due(app.state.db.session_factory, app.state.settings, blobs(app))
    version = await db.get(DriveFileVersion, uuid.UUID(item["file"]["version_id"]))
    assert version is not None and version.sha256 == hashlib.sha256(data).digest()
    assert version.processed_at is not None
    location = (
        await db.execute(select(DriveLocation).where(DriveLocation.kind == "workspace"))
    ).scalar_one()
    assert (location.used_bytes, location.item_count) == (len(data), 1)


async def test_a_completion_cut_off_is_finished_by_the_housekeeping(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)
    data = b"abc" * 1000

    # The process stops after the parts are joined, before the file is placed.
    real_place = uploads._place

    async def crash(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("the process stopped")

    monkeypatch.setattr(uploads, "_place", crash)
    session = (await start(client, root, "joined.bin", len(data))).json()
    await send_parts(client, session, data)
    cut = await complete(client, session["id"])
    assert cut.status_code == 202 and cut.json() == {
        "status": "completing",
        "item": None,
        "version_id": None,
    }
    assert (await client.get(f"{API}/drive/uploads/{session['id']}")).json()[
        "status"
    ] == "completing"
    monkeypatch.setattr(uploads, "_place", real_place)
    # Not yet stale: left alone.
    await housekeeping.run(app.state.drive, app.state.settings, blobs(app))
    assert await names_in(client, root) == []
    later = utcnow() + timedelta(minutes=11)
    done = await housekeeping.run(app.state.drive, app.state.settings, blobs(app), now=later)
    assert done.recovered == 1
    state = (await client.get(f"{API}/drive/uploads/{session['id']}")).json()
    assert state["status"] == "completed" and state["item_id"]
    assert await names_in(client, root) == ["joined.bin"]
    assert (await client.get(f"{API}/drive/items/{state['item_id']}/content")).content == data

    # The process stops while the store joins the parts.
    store = blobs(app)
    real_join = store.complete_multipart
    calls = 0

    async def flaky(key: str, upload_id: str, parts: list[tuple[int, str]]) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise TimeoutError("read timeout")
        await real_join(key, upload_id, parts)

    monkeypatch.setattr(store, "complete_multipart", flaky)
    other = (await start(client, root, "second.bin", len(data))).json()
    await send_parts(client, other, data)
    assert (await complete(client, other["id"])).status_code == 202
    await housekeeping.run(app.state.drive, app.state.settings, store, now=later)
    finished = await complete(client, other["id"])
    assert finished.status_code == 200 and finished.json()["item"]["name"] == "second.bin"
    assert calls == 2

    # An empty file: no parts, an empty object.
    empty = (await start(client, root, "empty.txt", 0)).json()
    assert empty["parts_total"] == 0
    placed = await complete(client, empty["id"])
    assert placed.status_code == 200 and placed.json()["item"]["size_bytes"] == 0
    assert (
        await client.get(f"{API}/drive/items/{placed.json()['item']['id']}/content")
    ).content == b""


async def test_name_conflicts_version_rename_fail(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)
    first = await upload(client, root, "report.pdf", b"v1" * 10)

    # fail: refused at once when the name is taken.
    refused = await start(client, root, "Report.pdf", 5, on_conflict="fail")
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "drive_name_taken"
    assert refused.json()["error"]["details"]["existing_id"] == first["id"]

    # version: a new version of the same item; both versions count.
    second = await upload(client, root, "report.pdf", b"v2" * 30, on_conflict="version")
    assert second["id"] == first["id"] and second["version_count"] == 2
    assert (await client.get(f"{API}/drive/items/{first['id']}/content")).content == b"v2" * 30
    old = await client.get(
        f"{API}/drive/items/{first['id']}/content",
        params={"version_id": first["file"]["version_id"]},
    )
    assert old.content == b"v1" * 10
    used = (
        await db.execute(select(DriveLocation.used_bytes).where(DriveLocation.kind == "workspace"))
    ).scalar_one()
    assert used == 20 + 60

    # rename: 「名前 (1).pdf」, then 「名前 (2).pdf」.
    renamed = await upload(client, root, "report.pdf", b"x", on_conflict="rename")
    assert renamed["name"] == "report (1).pdf"
    again = await upload(client, root, "REPORT.pdf", b"y", on_conflict="rename")
    assert again["name"] == "REPORT (2).pdf"

    # fail, with the name taken after the session started: 409 at completion, the session stays
    # active, and another way to settle it completes it.
    late = (await start(client, root, "late.txt", 3, on_conflict="fail")).json()
    await send_parts(client, late, b"new")
    await upload(client, root, "late.txt", b"old")
    clash = await complete(client, late["id"])
    assert clash.status_code == 409 and clash.json()["error"]["code"] == "drive_name_taken"
    assert (await client.get(f"{API}/drive/uploads/{late['id']}")).json()["status"] == "active"
    patched = await client.patch(
        f"{API}/drive/uploads/{late['id']}", json={"on_conflict": "rename"}
    )
    assert patched.status_code == 200
    settled = await complete(client, late["id"])
    assert settled.status_code == 200 and settled.json()["item"]["name"] == "late (1).txt"

    # version onto a folder of that name is a clash.
    await folder(client, root, "shelf")
    onto_folder = (await start(client, root, "shelf", 2, on_conflict="version")).json()
    await send_parts(client, onto_folder, b"zz")
    refused = await complete(client, onto_folder["id"])
    assert refused.status_code == 409
    renamed_name = await client.patch(
        f"{API}/drive/uploads/{onto_folder['id']}", json={"name": "shelf.txt"}
    )
    assert renamed_name.json()["name"] == "shelf.txt"
    assert (await complete(client, onto_folder["id"])).status_code == 200


async def test_folder_uploads_and_new_versions_by_target(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)
    one = await upload(client, root, "a.txt", b"1", relative_dir="photos/2026/trip")
    two = await upload(client, root, "b.txt", b"2", relative_dir="photos/2026/trip")
    assert one["parent_id"] == two["parent_id"]
    detail = (await client.get(f"{API}/drive/items/{one['id']}")).json()
    assert [c["name"] for c in detail["path"]] == ["研究室ドライブ", "photos", "2026", "trip"]
    location = (
        await db.execute(select(DriveLocation).where(DriveLocation.kind == "workspace"))
    ).scalar_one()
    assert location.item_count == 5
    bad = await start(client, root, "c.txt", 1, relative_dir="x//y")
    assert bad.status_code == 422

    # target_item_id: a new version of that file, wherever it moved meanwhile.
    session = (await start(client, root, "ignored.txt", 3, target_item_id=one["id"])).json()
    other = await folder(client, root, "moved")
    await client.post(
        f"{API}/drive/items/move", json={"item_ids": [one["id"]], "target_folder_id": other}
    )
    await send_parts(client, session, b"new")
    done = (await complete(client, session["id"])).json()["item"]
    assert (done["id"], done["name"], done["parent_id"], done["version_count"]) == (
        one["id"],
        "a.txt",
        other,
        2,
    )


async def test_quota_reservations_are_counted_at_once(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)
    await db.execute(text("UPDATE drive_locations SET quota_bytes = 1500 WHERE kind = 'workspace'"))
    await db.commit()

    too_big = await start(client, root, "huge.bin", 2000)
    assert too_big.status_code == 409
    details = too_big.json()["error"]["details"]
    assert too_big.json()["error"]["code"] == "drive_quota_exceeded"
    assert (details["quota_bytes"], details["used_bytes"], details["scope"]) == (
        1500,
        0,
        "location",
    )

    # Two at once that fit alone but not together: one of them is refused.
    tries = await asyncio.gather(*(start(client, root, f"half-{i}.bin", 1000) for i in range(2)))
    codes = sorted(r.status_code for r in tries)
    assert codes == [201, 409], [r.text for r in tries]
    winner = next(r.json() for r in tries if r.status_code == 201)
    # Cancelling gives the reservation back.
    assert (await client.delete(f"{API}/drive/uploads/{winner['id']}")).status_code == 204
    assert (await client.delete(f"{API}/drive/uploads/{winner['id']}")).status_code == 204
    assert (await put_part(client, winner["id"], 1, b"x" * PART)).status_code == 410
    retry = await start(client, root, "half-again.bin", 1000)
    assert retry.status_code == 201

    # The quota is checked again at completion (it may have been lowered meanwhile).
    await send_parts(client, retry.json(), b"y" * 1000)
    await db.execute(text("UPDATE drive_locations SET quota_bytes = 500 WHERE kind = 'workspace'"))
    await db.commit()
    over = await complete(client, retry.json()["id"])
    assert over.status_code == 409 and over.json()["error"]["code"] == "drive_quota_exceeded"
    assert (await client.get(f"{API}/drive/uploads/{retry.json()['id']}")).json()[
        "error"
    ] == "drive_quota_exceeded"

    # The whole drive's quota (DRIVE_TOTAL_QUOTA_BYTES) counts every location's reservations.
    await db.execute(text("UPDATE drive_locations SET quota_bytes = NULL"))
    await db.commit()
    drive_settings(app, drive_total_quota_bytes=2500)
    mine = (await client.post(f"{API}/drive/locations/resolve", json={"kind": "me"})).json()
    assert (await start(client, mine["root_id"], "m.bin", 1000)).status_code == 201
    total = await start(client, root, "w.bin", 600)
    assert total.status_code == 409 and total.json()["error"]["details"]["scope"] == "workspace"
    assert (await start(client, root, "w.bin", 400)).status_code == 201

    # The file size limit.
    drive_settings(app, drive_max_file_bytes=100)
    large = await start(client, root, "large.bin", 101)
    assert large.status_code == 413
    assert large.json()["error"]["details"] == {"limit_bytes": 100}


async def test_expiry_and_orphan_multipart_uploads(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)
    store = blobs(app)
    session = (await start(client, root, "stale.bin", 2000)).json()
    assert (await put_part(client, session["id"], 1, b"x" * PART)).status_code == 200
    assert len(store.uploads) == 1
    # A part pushes the expiry on.
    row = await db.get(DriveUpload, uuid.UUID(session["id"]))
    assert row is not None and row.expires_at > utcnow() + timedelta(hours=23)
    later = utcnow() + timedelta(hours=25)
    done = await housekeeping.run(app.state.drive, app.state.settings, store, now=later)
    assert done.expired == 1
    assert store.uploads == {}
    state = (await client.get(f"{API}/drive/uploads/{session['id']}")).json()
    assert state["status"] == "expired" and state["received_parts"] == []
    assert (await put_part(client, session["id"], 2, b"x" * (2000 - PART))).status_code == 410
    assert (await complete(client, session["id"])).status_code == 410
    expired_events = (
        await db.execute(
            select(func.count())
            .select_from(OutboxEvent)
            .where(OutboxEvent.event_type == "drive.upload.updated")
        )
    ).scalar_one()
    assert expired_events == 1

    # A multipart upload nobody knows (the app stopped before the session's row).
    orphan = await store.create_multipart("attachments/orphan", "application/octet-stream")
    key, content_type, _, parts = store.uploads[orphan]
    store.uploads[orphan] = (key, content_type, datetime.now(UTC) - timedelta(days=2), parts)
    fresh = await store.create_multipart("attachments/fresh", "application/octet-stream")
    app.state.drive.last_orphan_sweep = None
    done = await housekeeping.run(app.state.drive, app.state.settings, store, now=utcnow())
    assert done.orphans == 1
    assert list(store.uploads) == [fresh]
    # Finished sessions go after a week.
    done = await housekeeping.run(
        app.state.drive, app.state.settings, store, now=utcnow() + timedelta(days=9)
    )
    assert done.finished == 1


async def test_range_downloads(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)
    data = bytes(range(256)) * 8
    item = await upload(client, root, "range.bin", data)
    url = f"{API}/drive/items/{item['id']}/content"
    etag = f'"{item["file"]["version_id"]}"'

    whole = await client.get(url)
    assert whole.status_code == 200 and whole.headers["accept-ranges"] == "bytes"
    assert whole.headers["etag"] == etag and whole.headers["content-length"] == str(len(data))
    assert "last-modified" in whole.headers
    part = await client.get(url, headers={"Range": "bytes=10-19"})
    assert part.status_code == 206 and part.content == data[10:20]
    assert part.headers["content-range"] == f"bytes 10-19/{len(data)}"
    assert part.headers["content-length"] == "10"
    tail = await client.get(url, headers={"Range": "bytes=-5"})
    assert tail.status_code == 206 and tail.content == data[-5:]
    rest = await client.get(url, headers={"Range": "bytes=2000-"})
    assert rest.status_code == 206 and rest.content == data[2000:]
    clipped = await client.get(url, headers={"Range": "bytes=2040-99999"})
    assert clipped.status_code == 206 and clipped.content == data[2040:]
    several = await client.get(url, headers={"Range": "bytes=0-1,5-6"})
    assert several.status_code == 200 and several.content == data
    stale = await client.get(url, headers={"Range": "bytes=0-9", "If-Range": '"other"'})
    assert stale.status_code == 200 and stale.content == data
    fresh = await client.get(url, headers={"Range": "bytes=0-9", "If-Range": etag})
    assert fresh.status_code == 206
    outside = await client.get(url, headers={"Range": f"bytes={len(data)}-"})
    assert outside.status_code == 416
    assert outside.headers["content-range"] == f"bytes */{len(data)}"
    assert outside.json()["error"]["code"] == "range_not_satisfiable"

    # The attachments' /content too (a chat attachment and a drive version).
    sent = await client.post(
        f"{API}/attachments", files={"file": ("a.bin", data, "application/octet-stream")}
    )
    attachment_id = sent.json()["id"]
    chat = await client.get(
        f"{API}/attachments/{attachment_id}/content", headers={"Range": "bytes=100-199"}
    )
    assert chat.status_code == 206 and chat.content == data[100:200]
    assert chat.headers["etag"] == f'"{attachment_id}"'
    via_attachment = await client.get(
        f"{API}/attachments/{item['file']['attachment_id']}/content",
        headers={"Range": "bytes=0-3"},
    )
    assert via_attachment.status_code == 206 and via_attachment.content == data[:4]


def png_bytes() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (64, 48), (10, 120, 200)).save(out, format="PNG")
    return out.getvalue()


async def test_media_loop_previews_and_attachment_access(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    guest = await make_user(db, "gus", role="guest")
    as_user(alice)
    root = await workspace_root(client)
    image = await upload(client, root, "photo.png", png_bytes())
    assert image["content_type"] == "image/png"  # sniffed at completion
    assert image["file"]["has_thumbnail"] is False
    pdf = await upload(client, root, "paper.pdf", b"%PDF-1.4\n" + b"0" * 2000)
    assert pdf["file"]["preview"] == {
        "status": "pending",
        "pages": None,
        "width": None,
        "height": None,
    }

    before = (
        await db.execute(
            select(func.count())
            .select_from(OutboxEvent)
            .where(OutboxEvent.event_type == "drive.changed")
        )
    ).scalar_one()
    factory = app.state.db.session_factory
    while await media.process_due(factory, app.state.settings, blobs(app)):
        pass
    after = (
        await db.execute(
            select(func.count())
            .select_from(OutboxEvent)
            .where(OutboxEvent.event_type == "drive.changed")
        )
    ).scalar_one()
    assert after == before + 1  # the thumbnail (the PDF's preview announces itself later)
    shown = (await client.get(f"{API}/drive/items/{image['id']}")).json()["item"]
    assert shown["file"]["has_thumbnail"] is True
    assert (shown["file"]["width"], shown["file"]["height"]) == (64, 48)
    thumb = await client.get(f"{API}/attachments/{image['file']['attachment_id']}/thumbnail")
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/jpeg"
    inline = await client.get(f"{API}/drive/items/{image['id']}/content", params={"inline": 1})
    assert inline.headers["content-disposition"].startswith("inline;")
    pdf_inline = await client.get(f"{API}/drive/items/{pdf['id']}/content", params={"inline": 1})
    assert pdf_inline.headers["content-disposition"].startswith("attachment;")
    # The preview hook announces the file's folder.
    async with factory() as session:
        await previews._drive_changed(session, uuid.UUID(pdf["id"]))  # type: ignore[misc]
        await session.commit()
    # Not readable: 404 everywhere, the trash too.
    as_user(guest)
    for path in ("thumbnail", "content", "preview/thumbnail"):
        response = await client.get(f"{API}/attachments/{image['file']['attachment_id']}/{path}")
        assert response.status_code == 404, path
    as_user(alice)
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [image["id"]]})
    gone = await client.get(f"{API}/attachments/{image['file']['attachment_id']}/thumbnail")
    assert gone.status_code == 404


async def test_drive_rows_stay_out_of_the_chat(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """§2: attachments rows of drive files never show up as a channel's files, in message search,
    in the pending GC, the video backfill or generate-previews; the GC removes their bytes only
    once they are deleted."""
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    channel = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    root = await workspace_root(client)
    video = await upload(client, root, "clip-zebra.mp4", b"\x00\x00\x00\x18ftypmp42" + b"0" * 500)
    doc = await upload(client, root, "zebra-notes.pdf", b"%PDF-1.4\n" + b"1" * 100)
    await db.execute(text("UPDATE attachments SET preview_status = 'none'"))
    await db.commit()

    files = (await client.get(f"{API}/files")).json()
    assert files["items"] == []
    in_channel = (await client.get(f"{API}/files", params={"channel_id": channel["id"]})).json()
    assert in_channel["items"] == []
    found = await client.get(f"{API}/search/messages", params={"q": "zebra"})
    assert found.status_code == 200 and found.json()["hits"] == []
    assert await video_backfill._next_batch(db, None, 50) == []
    ids, _ = await previews._candidates(db, app.state.settings, ("none",), None)
    assert ids == []

    created = await db.execute(select(Attachment.created_at))
    assert created.scalars().all()
    removed, purged = await attachments.gc(
        db, blobs(app), now=utcnow() + timedelta(days=3), pending_ttl_hours=24
    )
    assert (removed, purged) == (0, 0)
    assert await attachments.verify(db, blobs(app)) == []
    await db.refresh(alice)  # _candidates rolled the test's session back
    as_user(alice)
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [doc["id"]]})
    admin = await make_user(db, "ada", role="admin")
    as_user(admin)
    assert (await client.delete(f"{API}/drive/items/{doc['id']}")).status_code == 204
    removed, purged = await attachments.gc(db, blobs(app))
    assert (removed, purged) == (0, 1)
    assert f"attachments/{doc['file']['attachment_id']}" not in blobs(app).objects
    assert await db.get(DriveItem, uuid.UUID(video["id"])) is not None
