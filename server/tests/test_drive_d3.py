"""The drive's phase D3 (M162, docs/DRIVE.md §7.2, §10.2, §10.3, §11, §22): versions (the list, a
version's download, bringing one back, deleting one, the retention job), copies (limits,
permissions, names, the quota, the same request again), ZIPs (contents, names, UTF-8, empty
folders, ZIP64, the exact Content-Length, the one-time ticket, the limits), and the
administrators' usage and quotas (the screen, the counters' check)."""

import asyncio
import io
import os
import struct
import uuid
import zipfile
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import redact_path
from app.events.models import OutboxEvent
from app.modules.attachments.blobstore import MemoryBlobStore
from app.modules.audit.models import AuditLog
from app.modules.drive import events as drive_events
from app.modules.drive import housekeeping, usage, versions, zipstream
from app.modules.drive.models import DriveFileVersion, DriveLocation
from app.modules.drive.tickets import ZipSlots, ZipTickets
from app.modules.users.models import User
from tests.drive_helpers import (
    act_as,
    drive_settings,
    folder,
    location,
    names_in,
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


async def content(client: AsyncClient, item_id: str, version_id: str | None = None) -> bytes:
    params = {"version_id": version_id} if version_id else {}
    response = await client.get(f"{API}/drive/items/{item_id}/content", params=params)
    assert response.status_code == 200, response.text
    return response.content


async def used(db: AsyncSession, kind: str = "workspace") -> tuple[int, int]:
    row = (
        await db.execute(
            select(DriveLocation.used_bytes, DriveLocation.item_count)
            .where(DriveLocation.kind == kind)
            .execution_options(populate_existing=True)
        )
    ).one()
    await db.commit()
    return int(row[0]), int(row[1])


async def zip_of(client: AsyncClient, item_ids: list[str]) -> tuple[dict[str, Any], bytes]:
    made = await client.post(f"{API}/drive/zip", json={"item_ids": item_ids})
    assert made.status_code == 200, made.text
    out: dict[str, Any] = made.json()
    response = await client.get(out["url"])
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    assert int(response.headers["content-length"]) == len(response.content) == out["zip_bytes"]
    return out, response.content


# --- the ZIP writer ------------------------------------------------------------------------------


async def _chunks(data: bytes) -> AsyncIterator[bytes]:
    for at in range(0, len(data), 7):
        yield data[at : at + 7]


async def test_the_zip_writer_knows_its_length_and_zipfile_reads_it() -> None:
    when = datetime(2026, 2, 1, 9, 12, 30, tzinfo=UTC)
    sources = {"a": "修論_最終 データ".encode() * 50, "b": b"", "c": bytes(range(256)) * 3}
    entries = [
        zipstream.ZipEntry(name="研究室/", size=0, modified=when, is_dir=True),
        zipstream.ZipEntry(name="研究室/空のフォルダ/", size=0, modified=when, is_dir=True),
        zipstream.ZipEntry(
            name="研究室/修論.pdf", size=len(sources["a"]), modified=when, source="a"
        ),
        zipstream.ZipEntry(name="研究室/empty.txt", size=0, modified=when, source="b"),
        zipstream.ZipEntry(
            name="ｶﾅ と 濁点の ガ.bin", size=len(sources["c"]), modified=when, source="c"
        ),
    ]
    plan = zipstream.plan(entries)
    out = b"".join([c async for c in zipstream.stream(plan, lambda key: _chunks(sources[key]))])
    assert len(out) == plan.length
    with zipfile.ZipFile(io.BytesIO(out)) as archive:
        assert archive.testzip() is None  # every CRC-32 matches
        infos = archive.infolist()
        assert [i.filename for i in infos] == [e.name for e in entries]
        assert all(i.flag_bits & 0x800 for i in infos)  # UTF-8 names
        assert all(i.compress_type == zipfile.ZIP_STORED for i in infos)
        assert infos[1].is_dir()
        assert archive.read("研究室/修論.pdf") == sources["a"]
        assert archive.read("研究室/empty.txt") == b""
        assert infos[2].date_time == (2026, 2, 1, 9, 12, 30)  # the plan's zone: UTC here
    # Not a ZIP64 archive: small archives stay plain ZIP.
    assert b"PK\x06\x06" not in out


async def test_the_zip_writer_uses_zip64_past_4_gib(tmp_path: Any) -> None:
    """An entry of 4 GiB + 1 MiB (zeros streamed, never held) and a small one after it at an
    offset beyond 4 GiB: ZIP64 sizes, offsets and end records; the length still exact."""
    big = 4 * 1024**3 + 1024**2
    chunk = bytes(16 * 1024 * 1024)
    when = datetime(2026, 10, 21, tzinfo=UTC)

    async def source(key: str) -> AsyncIterator[bytes]:
        if key == "small":
            yield b"after the big one"
            return
        left = big
        while left:
            part = chunk[: min(left, len(chunk))]
            left -= len(part)
            yield part

    entries = [
        zipstream.ZipEntry(name="大きな.bin", size=big, modified=when, source="big"),
        zipstream.ZipEntry(name="小さな.txt", size=17, modified=when, source="small"),
    ]
    plan = zipstream.plan(entries)
    assert plan.zip64_end and entries[1].offset > zipstream.LIMIT32
    # The zeros are counted, not kept; everything else is kept where it belongs.
    parts: list[bytes | int] = []
    async for part in zipstream.stream(plan, source):
        parts.append(len(part) if part == chunk else part)
    _check_big_zip(os.path.join(tmp_path, "big.zip"), parts, plan, entries, big)


def _check_big_zip(
    path: str,
    parts: list[bytes | int],
    plan: zipstream.ZipPlan,
    entries: list[zipstream.ZipEntry],
    big: int,
) -> None:
    with open(path, "wb") as sink:  # a sparse file: the zeros are skipped over
        for part in parts:
            if isinstance(part, int):
                sink.seek(part, 1)
            else:
                sink.write(part)
        sink.truncate()
    written = sum(p if isinstance(p, int) else len(p) for p in parts)
    assert written == plan.length == os.path.getsize(path)
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        assert [(i.filename, i.file_size) for i in infos] == [
            ("大きな.bin", big),
            ("小さな.txt", 17),
        ]
        assert infos[1].header_offset == entries[1].offset
        assert archive.read("小さな.txt") == b"after the big one"
    with open(path, "rb") as raw:
        raw.seek(-22 - 20 - 56, 2)
        assert raw.read(4) == b"PK\x06\x06"  # the ZIP64 end of central directory record
        raw.seek(-22, 2)
        end = raw.read(22)
        assert struct.unpack("<I", end[16:20])[0] == zipstream.LIMIT32  # offset in ZIP64


async def test_a_source_of_another_length_breaks_the_stream() -> None:
    entries = [zipstream.ZipEntry(name="x", size=10, modified=datetime.now(UTC), source="x")]
    plan = zipstream.plan(entries)
    with pytest.raises(zipstream.SourceChanged):
        _ = [c async for c in zipstream.stream(plan, lambda key: _chunks(b"short"))]


def test_zip_tickets_are_used_once_and_slots_are_counted() -> None:
    now = [0.0]
    tickets = ZipTickets(clock=lambda: now[0], seconds=300, per_user=2)
    user = uuid.uuid4()
    token = tickets.issue(user, "job")
    assert tickets.peek(token) is not None and tickets.peek(token) is not None
    assert tickets.take(token) is not None
    assert tickets.take(token) is None and tickets.peek(token) is None
    late = tickets.issue(user, "job")
    now[0] += 301
    assert tickets.take(late) is None
    assert all(len(key) == 32 for key in tickets._tickets)  # hashes only
    slots = ZipSlots()
    other = uuid.uuid4()
    assert slots.try_acquire(user, per_user=2, total=3)
    assert slots.try_acquire(user, per_user=2, total=3)
    assert not slots.try_acquire(user, per_user=2, total=3)  # two for one person
    assert slots.try_acquire(other, per_user=2, total=3)
    assert not slots.try_acquire(other, per_user=2, total=3)  # three in all
    slots.release(user)
    assert slots.try_acquire(other, per_user=2, total=3)
    assert redact_path("/api/v1/drive/zip/secret-token") == "/api/v1/drive/zip/***"
    assert redact_path("/api/v1/drive/zip") == "/api/v1/drive/zip"


# --- ZIPs over the API ---------------------------------------------------------------------------


async def test_a_folder_and_a_selection_as_zip(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)
    seminar = await folder(client, root, "ゼミ資料")
    sub = await folder(client, seminar, "2026年度")
    await folder(client, seminar, "空のフォルダ")
    report = await upload(client, sub, "報告書.pdf", b"%PDF-1.4 report" * 100)
    await upload(client, seminar, "メモ.txt", b"memo")
    odd = await upload(client, root, 'a:b?"c".txt', b"windows")
    gone = await upload(client, seminar, "捨てた.txt", b"trash")
    assert (await client.post(f"{API}/drive/items/trash", json={"item_ids": [gone["id"]]})).json()[
        "results"
    ][0]["ok"]

    out, body = await zip_of(client, [seminar])
    assert out["filename"] == "ゼミ資料.zip"
    assert out["entries"] == 5 and out["size_bytes"] == 1500 + 4
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        assert archive.testzip() is None
        assert sorted(archive.namelist()) == sorted(
            [
                "ゼミ資料/",
                "ゼミ資料/2026年度/",
                "ゼミ資料/空のフォルダ/",
                "ゼミ資料/2026年度/報告書.pdf",
                "ゼミ資料/メモ.txt",
            ]
        )
        assert archive.read("ゼミ資料/2026年度/報告書.pdf") == b"%PDF-1.4 report" * 100
        # Depth first; in each folder the folders first, as in the listing.
        assert archive.namelist() == [
            "ゼミ資料/",
            "ゼミ資料/2026年度/",
            "ゼミ資料/2026年度/報告書.pdf",
            "ゼミ資料/空のフォルダ/",
            "ゼミ資料/メモ.txt",
        ]

    # A selection: the items at the top; a Windows-unsafe name made safe; the root's name.
    out, body = await zip_of(client, [report["id"], odd["id"]])
    assert out["filename"] == "drive.zip"
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        assert sorted(archive.namelist()) == ["a_b__c_.txt", "報告書.pdf"]
    out, _ = await zip_of(client, [seminar, odd["id"]])
    assert out["filename"] == "研究室ドライブ.zip"

    # The ticket is used once; an unknown one is 404 as well.
    made = (await client.post(f"{API}/drive/zip", json={"item_ids": [seminar]})).json()
    assert (await client.get(made["url"])).status_code == 200
    again = await client.get(made["url"])
    assert again.status_code == 404 and again.json()["error"]["code"] == "drive_item_not_found"
    assert (await client.get(f"{API}/drive/zip/nope")).status_code == 404
    # In the trash, or not readable: 404 when asking.
    trashed = await client.post(f"{API}/drive/zip", json={"item_ids": [gone["id"]]})
    assert trashed.status_code == 404


async def test_zip_limits_slots_and_lost_access(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app, drive_zip_max_entries=3, drive_zip_max_bytes=100)
    owner = await make_user(db, "owner")
    member = await make_user(db, "member")
    as_user(owner)
    lab = (await client.post(f"{API}/channels", json={"name": "lab", "type": "private"})).json()
    joined = await client.post(
        f"{API}/channels/{lab['id']}/members", json={"user_id": str(member.id)}
    )
    assert joined.status_code in (200, 201, 204), joined.text
    drive = await location(client, "channel", channel_id=lab["id"])
    box = await folder(client, drive["root_id"], "box")
    await upload(client, box, "a.bin", b"a" * 60)
    await upload(client, box, "b.bin", b"b" * 60)
    too_big = await client.post(f"{API}/drive/zip", json={"item_ids": [box]})
    assert too_big.status_code == 413
    error = too_big.json()["error"]
    assert error["code"] == "drive_zip_too_large"
    assert error["details"] == {"limit_bytes": 100, "limit_entries": 3}
    many = await folder(client, drive["root_id"], "many")
    for name in ("1", "2", "3"):
        await folder(client, many, name)
    assert (await client.post(f"{API}/drive/zip", json={"item_ids": [many]})).status_code == 413

    # Two at once per person: a third waits (429) and its ticket stays valid.
    drive_settings(app, drive_zip_max_entries=100, drive_zip_max_bytes=1000)
    runtime = app.state.drive
    assert runtime.zip_slots.try_acquire(owner.id, per_user=2, total=4)
    assert runtime.zip_slots.try_acquire(owner.id, per_user=2, total=4)
    made = (await client.post(f"{API}/drive/zip", json={"item_ids": [box]})).json()
    busy = await client.get(made["url"])
    assert busy.status_code == 429 and busy.json()["error"]["code"] == "rate_limited"
    runtime.zip_slots.release(owner.id)
    assert (await client.get(made["url"])).status_code == 200
    runtime.zip_slots.release(owner.id)
    assert runtime.zip_slots._running == {}  # the finished ZIP gave its slot back

    # The member leaves between the ticket and the download: 404.
    as_user(member)
    made = (await client.post(f"{API}/drive/zip", json={"item_ids": [box]})).json()
    as_user(owner)
    assert (await client.delete(f"{API}/channels/{lab['id']}/members/{member.id}")).status_code in (
        200,
        204,
    )
    assert (await client.get(made["url"])).status_code == 404
    # Someone else's folder: as if it did not exist.
    stranger = await make_user(db, "stranger")
    as_user(stranger)
    assert (await client.post(f"{API}/drive/zip", json={"item_ids": [box]})).status_code == 404


# --- versions ------------------------------------------------------------------------------------


async def test_versions_list_download_restore_and_delete(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    admin = await make_user(db, "ada", role="admin")
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)
    first = await upload(client, root, "draft.txt", b"one")
    await upload(client, root, "draft.txt", b"two!", on_conflict="version")
    third = await upload(client, root, "draft.txt", b"three", on_conflict="version")
    assert third["id"] == first["id"] and third["version_count"] == 3
    listed = (await client.get(f"{API}/drive/items/{first['id']}/versions")).json()
    assert (listed["keep_versions"], listed["keep_days"]) == (10, 30)
    numbers = [(v["number"], v["current"], v["size_bytes"]) for v in listed["versions"]]
    assert numbers == [(3, True, 5), (2, False, 4), (1, False, 3)]
    one = listed["versions"][2]
    assert await content(client, first["id"], one["id"]) == b"one"
    assert await used(db) == (12, 1)
    objects = len(blobs(app).objects)

    restored = await client.post(f"{API}/drive/items/{first['id']}/versions/{one['id']}/restore")
    assert restored.status_code == 200, restored.text
    assert restored.json()["version_count"] == 4 and restored.json()["size_bytes"] == 3
    assert await content(client, first["id"]) == b"one"
    listed = (await client.get(f"{API}/drive/items/{first['id']}/versions")).json()["versions"]
    assert [(v["number"], v["source"], v["current"]) for v in listed][:2] == [
        (4, "restore", True),
        (3, "upload", False),
    ]
    # A copy of the object, not a shared one.
    assert len(blobs(app).objects) == objects + 1
    restored_attachment = (await client.get(f"{API}/drive/items/{first['id']}")).json()["item"][
        "file"
    ]["attachment_id"]
    rows = (
        await db.execute(
            select(DriveFileVersion.attachment_id).where(
                DriveFileVersion.item_id == uuid.UUID(first["id"])
            )
        )
    ).scalars()
    assert len(set(rows)) == 4 and restored_attachment
    assert await used(db) == (15, 1)
    current = listed[0]["id"]
    again = await client.post(f"{API}/drive/items/{first['id']}/versions/{current}/restore")
    assert again.status_code == 409 and again.json()["error"]["code"] == "drive_version_current"

    # Deleting an older version: who may delete for good (研究室ドライブ: admins).
    old = listed[1]["id"]
    refused = await client.delete(f"{API}/drive/items/{first['id']}/versions/{old}")
    assert refused.status_code == 403
    assert refused.json()["error"]["code"] == "drive_manage_restricted"
    as_user(admin)
    assert (
        await client.delete(f"{API}/drive/items/{first['id']}/versions/{current}")
    ).status_code == 409
    assert (
        await client.delete(f"{API}/drive/items/{first['id']}/versions/{old}")
    ).status_code == 204
    assert (
        await client.delete(f"{API}/drive/items/{first['id']}/versions/{old}")
    ).status_code == 404
    assert await used(db) == (10, 1)
    audit = (
        await db.execute(select(AuditLog.action).where(AuditLog.action.like("drive.version%")))
    ).scalars()
    assert sorted(audit) == ["drive.version_deleted", "drive.version_restored"]
    assert await usage.verify(db) == []

    # A stranger's My Drive file: no versions to see.
    mine = await location(client, "me")
    secret = await upload(client, mine["root_id"], "secret.txt", b"s")
    as_user(alice)
    assert (await client.get(f"{API}/drive/items/{secret['id']}/versions")).status_code == 404


async def test_restoring_respects_the_quota_and_leaves_no_object(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)
    item = await upload(client, root, "big.bin", b"x" * 600)
    await upload(client, root, "big.bin", b"y" * 10, on_conflict="version")
    await db.execute(text("UPDATE drive_locations SET quota_bytes = 1000 WHERE kind = 'workspace'"))
    await db.commit()
    versions_ = (await client.get(f"{API}/drive/items/{item['id']}/versions")).json()["versions"]
    objects = len(blobs(app).objects)
    over = await client.post(
        f"{API}/drive/items/{item['id']}/versions/{versions_[1]['id']}/restore"
    )
    assert over.status_code == 409 and over.json()["error"]["code"] == "drive_quota_exceeded"
    assert len(blobs(app).objects) == objects
    # The whole drive's quota too.
    drive_settings(app, drive_total_quota_bytes=700)
    await db.execute(text("UPDATE drive_locations SET quota_bytes = NULL"))
    await db.commit()
    over = await client.post(
        f"{API}/drive/items/{item['id']}/versions/{versions_[1]['id']}/restore"
    )
    assert over.status_code == 409
    assert over.json()["error"]["details"]["scope"] == "workspace"
    # Making room is always allowed: deleting an old version needs no quota.
    drive_settings(app, drive_total_quota_bytes=None)
    ok = await client.post(f"{API}/drive/items/{item['id']}/versions/{versions_[1]['id']}/restore")
    assert ok.status_code == 200


async def test_the_retention_job_keeps_ten_versions_and_thirty_days(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)
    item = await upload(client, root, "log.txt", b"v1")
    for n in range(2, 13):
        await upload(client, root, "log.txt", f"v{n}".encode(), on_conflict="version")
    other = await upload(client, root, "old.txt", b"a")
    await upload(client, root, "old.txt", b"bb", on_conflict="version")
    await upload(client, root, "old.txt", b"ccc", on_conflict="version")
    now = datetime.now(UTC)
    # old.txt: version 2 replaced version 1 40 days ago, version 3 replaced version 2 10 days ago.
    await db.execute(
        text(
            "UPDATE drive_file_versions SET created_at = :at "
            "WHERE item_id = :item AND number = :number"
        ),
        [
            {"at": now - timedelta(days=60), "item": uuid.UUID(other["id"]), "number": 1},
            {"at": now - timedelta(days=40), "item": uuid.UUID(other["id"]), "number": 2},
            {"at": now - timedelta(days=10), "item": uuid.UUID(other["id"]), "number": 3},
        ],
    )
    await db.commit()
    before = await used(db)
    due = await versions.due_versions(db, keep=10, days=30, now=now)
    await db.rollback()
    assert len(due) == 3  # log.txt's 1 and 2, old.txt's 1

    done = await housekeeping.run(app.state.drive, app.state.settings, blobs(app), now=now)
    assert done.versions_pruned == 3
    log = (await client.get(f"{API}/drive/items/{item['id']}/versions")).json()["versions"]
    assert [v["number"] for v in log] == list(range(12, 2, -1))
    kept = (await client.get(f"{API}/drive/items/{other['id']}/versions")).json()["versions"]
    assert [v["number"] for v in kept] == [3, 2]
    assert await used(db) == (before[0] - len(b"v1") - len(b"v2") - len(b"a"), before[1])
    assert await usage.verify(db) == []
    # Their attachments are gone (the GC removes the bytes).
    deleted = await db.execute(
        text(
            "SELECT count(*) FROM attachments "
            "WHERE drive_item_id IS NOT NULL AND status = 'deleted'"
        )
    )
    assert deleted.scalar_one() == 3
    await db.rollback()
    # Run again: nothing more; the current version stays however old.
    await db.execute(
        text("UPDATE drive_file_versions SET created_at = now() - interval '400 days'")
    )
    await db.commit()
    again = await housekeeping.run(app.state.drive, app.state.settings, blobs(app))
    assert again.versions_pruned == 10  # all but each file's current version
    assert [
        v["number"]
        for v in (await client.get(f"{API}/drive/items/{item['id']}/versions")).json()["versions"]
    ] == [12]


# --- copies --------------------------------------------------------------------------------------


async def test_copying_files_and_folders(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)
    src = await folder(client, root, "元")
    inner = await folder(client, src, "中")
    await folder(client, src, "空")
    paper = await upload(client, inner, "論文.pdf", b"%PDF paper")
    await upload(client, inner, "論文.pdf", b"%PDF paper v2", on_conflict="version")
    junk = await upload(client, inner, "捨てる.txt", b"junk")
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [junk["id"]]})
    dest = await folder(client, root, "先")
    before = await used(db)
    op = str(uuid.uuid4())

    copied = await client.post(
        f"{API}/drive/items/copy",
        json={"item_ids": [src, paper["id"]], "target_folder_id": dest, "client_op_id": op},
    )
    assert copied.status_code == 200, copied.text
    results = copied.json()["results"]
    assert [r["ok"] for r in results] == [True, True] and all(r["new_id"] for r in results)
    assert sorted(await names_in(client, dest)) == ["元", "論文.pdf"]
    new_src = results[0]["new_id"]
    assert sorted(await names_in(client, new_src)) == ["中", "空"]
    new_inner = next(
        i
        for i in (await client.get(f"{API}/drive/folders/{new_src}/children")).json()["items"]
        if i["name"] == "中"
    )
    files = (await client.get(f"{API}/drive/folders/{new_inner['id']}/children")).json()["items"]
    assert [f["name"] for f in files] == ["論文.pdf"]  # the trash is not copied
    assert files[0]["version_count"] == 1  # only the current version
    assert await content(client, files[0]["id"]) == b"%PDF paper v2"
    assert files[0]["created_by"] == str(alice.id)
    assert files[0]["file"]["attachment_id"] != paper["file"]["attachment_id"]
    after = await used(db)
    assert after == (before[0] + 2 * len(b"%PDF paper v2"), before[1] + 5)
    assert await usage.verify(db) == []

    # The same request again: the same copies, nothing new.
    again = await client.post(
        f"{API}/drive/items/copy",
        json={"item_ids": [src, paper["id"]], "target_folder_id": dest, "client_op_id": op},
    )
    assert [r["new_id"] for r in again.json()["results"]] == [r["new_id"] for r in results]
    assert await used(db) == after

    # Names: rename (the default) numbers them, fail refuses.
    dup = await client.post(
        f"{API}/drive/items/copy", json={"item_ids": [paper["id"]], "target_folder_id": inner}
    )
    assert dup.json()["results"][0]["ok"]
    assert sorted(await names_in(client, inner)) == ["論文 (1).pdf", "論文.pdf"]
    clash = await client.post(
        f"{API}/drive/items/copy",
        json={"item_ids": [paper["id"]], "target_folder_id": inner, "on_conflict": "fail"},
    )
    assert clash.json()["results"][0] == {
        "id": paper["id"],
        "ok": False,
        "error": "drive_name_taken",
        "new_id": None,
    }
    # Into itself or below: refused; the top folder cannot be copied.
    cycle = await client.post(
        f"{API}/drive/items/copy", json={"item_ids": [src], "target_folder_id": inner}
    )
    assert cycle.json()["results"][0]["error"] == "drive_cycle"
    top = await client.post(
        f"{API}/drive/items/copy", json={"item_ids": [root], "target_folder_id": dest}
    )
    assert top.json()["results"][0]["error"] == "drive_root_immutable"
    # Into My Drive: across locations, counted there.
    mine = await location(client, "me")
    across = await client.post(
        f"{API}/drive/items/copy",
        json={"item_ids": [paper["id"]], "target_folder_id": mine["root_id"]},
    )
    assert across.json()["results"][0]["ok"]
    assert await used(db, "user") == (len(b"%PDF paper v2"), 1)


async def test_copy_limits_permissions_and_quota(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app, drive_copy_max_items=3, drive_copy_max_bytes=100)
    owner = await make_user(db, "owner")
    member = await make_user(db, "member")
    as_user(owner)
    root = await workspace_root(client)
    box = await folder(client, root, "box")
    await upload(client, box, "a.bin", b"a" * 40)
    await upload(client, box, "b.bin", b"b" * 40)
    big = await upload(client, root, "big.bin", b"c" * 101)
    dest = await folder(client, root, "dest")
    objects = len(blobs(app).objects)

    many = await client.post(
        f"{API}/drive/items/copy",
        json={"item_ids": [box, big["id"]], "target_folder_id": dest},
    )
    assert many.status_code == 413
    assert many.json()["error"] == {
        "code": "drive_copy_too_large",
        "message": many.json()["error"]["message"],
        "details": {"limit_bytes": 100, "limit_items": 3},
    }
    heavy = await client.post(
        f"{API}/drive/items/copy", json={"item_ids": [big["id"]], "target_folder_id": dest}
    )
    assert heavy.status_code == 413
    assert len(blobs(app).objects) == objects  # nothing copied

    # Reading the source is enough; the target must be writable.
    lab = (await client.post(f"{API}/channels", json={"name": "lab", "type": "public"})).json()
    await client.post(f"{API}/channels/{lab['id']}/members", json={"user_id": str(member.id)})
    drive = await location(client, "channel", channel_id=lab["id"])
    as_user(member)
    ok = await client.post(
        f"{API}/drive/items/copy", json={"item_ids": [box], "target_folder_id": drive["root_id"]}
    )
    assert ok.json()["results"][0]["ok"], ok.text
    as_user(owner)
    assert (await client.post(f"{API}/channels/{lab['id']}/archive")).status_code == 200
    as_user(member)
    read_only = await client.post(
        f"{API}/drive/items/copy", json={"item_ids": [box], "target_folder_id": drive["root_id"]}
    )
    assert read_only.status_code == 403 and read_only.json()["error"]["code"] == "drive_read_only"
    # Someone else's My Drive: neither a source nor a target.
    as_user(owner)
    mine = await location(client, "me")
    private = await upload(client, mine["root_id"], "private.txt", b"p")
    as_user(member)
    hidden = await client.post(
        f"{API}/drive/items/copy", json={"item_ids": [private["id"]], "target_folder_id": dest}
    )
    assert hidden.json()["results"][0]["error"] == "drive_item_not_found"
    assert (
        await client.post(
            f"{API}/drive/items/copy",
            json={"item_ids": [box], "target_folder_id": mine["root_id"]},
        )
    ).status_code == 404

    # The quota: two copies at once where one fits, one is refused.
    as_user(owner)
    drive_settings(app, drive_copy_max_items=100, drive_copy_max_bytes=10_000)
    used_now = (await used(db))[0]
    await db.execute(
        text("UPDATE drive_locations SET quota_bytes = :q WHERE kind = 'workspace'"),
        {"q": used_now + 100},
    )
    await db.commit()
    objects = len(blobs(app).objects)
    tries = await asyncio.gather(
        *(
            client.post(
                f"{API}/drive/items/copy", json={"item_ids": [box], "target_folder_id": dest}
            )
            for _ in range(2)
        )
    )
    oks = [r for r in tries if r.status_code == 200 and r.json()["results"][0]["ok"]]
    assert len(oks) == 1, [r.text for r in tries]
    loser = next(r for r in tries if r is not oks[0])
    if loser.status_code == 200:
        assert loser.json()["results"][0]["error"] == "drive_quota_exceeded"
    else:
        assert loser.status_code == 409
        assert loser.json()["error"]["code"] == "drive_quota_exceeded"
    assert (await used(db))[0] == used_now + 80
    assert len(blobs(app).objects) == objects + 2  # the loser's copies were removed
    assert await usage.verify(db) == []


# --- usage and quotas ----------------------------------------------------------------------------


async def test_admin_usage_quota_and_the_counters_check(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app, drive_user_default_quota_bytes=5000, drive_total_quota_bytes=10**9)
    admin = await make_user(db, "ada", role="admin")
    alice = await make_user(db, "alice")
    as_user(alice)
    root = await workspace_root(client)
    doc = await upload(client, root, "doc.txt", b"12345")
    await upload(client, root, "doc.txt", b"1234567", on_conflict="version")
    gone = await upload(client, root, "gone.txt", b"xyz")
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [gone["id"]]})
    mine = await location(client, "me")
    await upload(client, mine["root_id"], "mine.txt", b"mine")
    assert (await client.get(f"{API}/admin/drive/usage")).status_code == 403

    as_user(admin)
    out = (await client.get(f"{API}/admin/drive/usage")).json()
    total = out["total"]
    assert (total["current_bytes"], total["old_versions_bytes"], total["trash_bytes"]) == (11, 5, 3)
    assert total["used_bytes"] == 19 and total["total_quota_bytes"] == 10**9
    assert total["user_default_quota_bytes"] == 5000
    by_kind = {loc["kind"]: loc for loc in out["locations"]}
    assert by_kind["workspace"]["name"] == "研究室ドライブ"
    assert by_kind["workspace"]["used_bytes"] == 15 and by_kind["workspace"]["item_count"] == 2
    assert by_kind["user"]["name"] == "Alice"
    assert (
        by_kind["user"]["effective_quota_bytes"] == 5000 and by_kind["user"]["quota_bytes"] is None
    )
    assert out["people"] == [{"user_id": str(alice.id), "bytes": 19, "versions": 4}]
    assert "doc.txt" not in str(out)  # nothing inside a location

    workspace_id = by_kind["workspace"]["id"]
    changed = await client.patch(
        f"{API}/admin/drive/locations/{workspace_id}", json={"quota_bytes": 16}
    )
    assert changed.status_code == 200 and changed.json()["quota_bytes"] == 16
    assert changed.json()["effective_quota_bytes"] == 16
    event = (
        await db.execute(
            select(OutboxEvent).where(OutboxEvent.event_type == drive_events.DRIVE_LOCATION_UPDATED)
        )
    ).scalar_one()
    assert event.payload == {"location_id": workspace_id} and event.audience_type == "drive"
    record = (
        await db.execute(select(AuditLog).where(AuditLog.action == "drive.quota_changed"))
    ).scalar_one()
    assert record.details == {"kind": "workspace", "before": None, "after": 16}
    bad = await client.patch(
        f"{API}/admin/drive/locations/{workspace_id}", json={"quota_bytes": -1}
    )
    assert bad.status_code == 422
    assert (
        await client.patch(f"{API}/admin/drive/locations/{uuid.uuid4()}", json={"quota_bytes": 1})
    ).status_code == 404

    # Over the lowered quota: adding is refused, freeing space is not.
    as_user(alice)
    full = await client.post(
        f"{API}/drive/items/copy", json={"item_ids": [doc["id"]], "target_folder_id": root}
    )
    assert full.status_code == 409 and full.json()["error"]["code"] == "drive_quota_exceeded"
    assert (await client.post(f"{API}/drive/items/trash", json={"item_ids": [doc["id"]]})).json()[
        "results"
    ][0]["ok"]
    assert (await client.get(f"{API}/drive/locations")).json()["locations"][0]["quota_bytes"] == 16

    # The counters' check finds and repairs a drift.
    as_user(admin)
    assert (
        await client.patch(
            f"{API}/admin/drive/locations/{workspace_id}", json={"quota_bytes": None}
        )
    ).json()["quota_bytes"] is None
    await db.execute(text("UPDATE drive_locations SET used_bytes = 999, item_count = 7"))
    await db.commit()
    drift = await usage.verify(db)
    assert len(drift) == 2 and "used_bytes 999" in str(drift[0])
    assert await usage.rebuild(db) == 2
    await db.commit()
    assert await usage.verify(db) == []
    assert await used(db) == (15, 2)


def test_the_cli_has_drive_usage() -> None:
    from app.cli import build_parser

    args = build_parser().parse_args(["drive-usage", "--verify"])
    assert args.func.__name__ == "cmd_drive_usage" and not args.rebuild
    with pytest.raises(SystemExit):
        build_parser().parse_args(["drive-usage"])
