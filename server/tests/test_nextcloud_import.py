"""Nextcloud import (M164, docs/DRIVE.md §15): the mapping, the plan and its report, the run and
a run again, names that clash, a fake WebDAV server (PROPFIND depth 1 and paging, non-ASCII and
NFD names), a data directory, an interruption and the run that goes on."""

import hashlib
import os
import unicodedata
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from email.utils import format_datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlsplit

import httpx
import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.modules.attachments.blobstore import MemoryBlobStore
from app.modules.audit.models import AuditLog
from app.modules.drive.models import DriveFileVersion, DriveItem, DriveLocation
from app.modules.importer.core import ImportFailed
from app.modules.importer.models import ImportRef
from app.modules.importer.nextcloud_import import (
    NextcloudReport,
    Options,
    import_nextcloud,
    parse_mapping,
    ref_key,
)
from app.modules.importer.nextcloud_source import (
    DataDirSource,
    Entry,
    SourceError,
    WebDavSource,
    parse_multistatus,
    server_root,
)
from app.modules.users.models import User
from tests.drive_helpers import act_as, names_in, upload, workspace_root
from tests.helpers import make_user

API = "/api/v1"
PART = 1024
T1 = datetime(2024, 4, 1, 9, 30, 15, tzinfo=UTC)
T2 = datetime(2025, 1, 2, 3, 4, 5, tzinfo=UTC)

MAP = """
[[map]]
source = "/研究室共有"
target = "workspace:/"

[[map]]
source = "/研究室共有/教員"
target = "channel:faculty:/"

[[map]]
source = "/M2ゼミ"
target = "channel:m2-seminar:/ゼミ資料"

[[map]]
source = "/kano/個人"
target = "user:kano:/"

[[skip]]
source = "/研究室共有/古いバックアップ"
"""


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


def store(app: FastAPI) -> MemoryBlobStore:
    blobs = app.state.blobs
    assert isinstance(blobs, MemoryBlobStore)
    return blobs


def small_parts(app: FastAPI, **extra: Any) -> Settings:
    settings: Settings = app.state.settings.model_copy(update={"drive_part_bytes": PART, **extra})
    return settings


# --- the mapping -------------------------------------------------------------------------------


def test_the_longest_source_decides_and_skip_rules_count_too() -> None:
    mapping = parse_mapping(
        MAP
        + """
[[map]]
source = "/研究室共有/古いバックアップ/残す"
target = "workspace:/残したもの"
"""
    )
    rule, rest = mapping.match("/研究室共有/論文/a.pdf") or (None, ())
    assert rule is not None and rule.target is not None and rule.target.spec == "workspace:/"
    assert rest == ("論文", "a.pdf")
    rule, rest = mapping.match("/研究室共有/教員/会議/b.docx") or (None, ())
    assert rule is not None and rule.target is not None
    assert rule.target.spec == "channel:faculty:/" and rest == ("会議", "b.docx")
    rule, rest = mapping.match("/研究室共有/古いバックアップ/x.zip") or (None, ())
    assert rule is not None and rule.target is None
    rule, rest = mapping.match("/研究室共有/古いバックアップ/残す/y.txt") or (None, ())
    assert rule is not None and rule.target is not None
    assert rule.target.path == ("残したもの",) and rest == ("y.txt",)
    # Whole segments only: /M2ゼミ旧 is not under /M2ゼミ.
    assert mapping.match("/M2ゼミ旧/a.pdf") is None
    assert mapping.match("/写真/a.jpg") is None
    # The walk goes into what a map covers or holds a map below it, not into the rest.
    assert mapping.descend("/研究室共有")
    assert mapping.descend("/kano")  # /kano/個人 is mapped
    assert mapping.descend("/研究室共有/古いバックアップ")  # holds 残す
    assert not mapping.descend("/写真")
    assert not mapping.descend("/kano/写真")


def test_a_mapping_is_checked_before_anything_runs() -> None:
    def fails(source: str, message: str) -> None:
        with pytest.raises(ImportFailed, match=message):
            parse_mapping(source)

    fails("[[map]]\nsource = '/a'\n", "needs target")
    fails("[[map]]\nsource = 'a'\ntarget = 'workspace:/'\n", "must start with /")
    fails("[[map]]\nsource = '/a'\ntarget = 'room:/'\n", "workspace, channel or user")
    fails("[[map]]\nsource = '/a'\ntarget = 'channel:/x'\n", "channel:NAME:/path")
    fails("[[map]]\nsource = '/a'\ntarget = 'workspace:x'\n", "must start with /")
    fails(
        "[[map]]\nsource = '/a'\ntarget = 'workspace:/'\n[[skip]]\nsource = '/a/'\n",
        "appears twice",
    )
    fails("[[skip]]\nsource = '/a'\n", "no \\[\\[map\\]\\]")
    fails("[[maps]]\nsource = '/a'\n", "unknown keys")
    fails("[[map]]\nsource = '/a'\ntarget = 'workspace:/'\nowner = 'x'\n", "unknown keys")
    fails("[[map]]\nsource = '/a/../b'\ntarget = 'workspace:/'\n", "has . or ..")
    fails("not toml = = =", "--map")
    # NFD in the file is the same path as NFC.
    nfd = unicodedata.normalize("NFD", "/ゼミ")
    mapping = parse_mapping(f"[[map]]\nsource = '{nfd}'\ntarget = 'workspace:/ゼミ'\n")
    assert mapping.match("/ゼミ/a") is not None


# --- a data directory --------------------------------------------------------------------------


def write(root: Path, path: str, data: bytes = b"", *, at: datetime = T1) -> Path:
    target = root / path.lstrip("/")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    os.utime(target, (at.timestamp(), at.timestamp()))
    return target


def mkdir(root: Path, path: str) -> None:
    (root / path.lstrip("/")).mkdir(parents=True, exist_ok=True)


def tree(tmp_path: Path) -> Path:
    root = tmp_path / "kano" / "files"
    write(root, "/研究室共有/論文/2024/草稿 v1.pdf", b"%PDF-1.4 draft " * 200)
    write(root, "/研究室共有/論文/2024/図/fig1.png", b"\x89PNG\r\n\x1a\n" + b"x" * 3000)
    write(root, "/研究室共有/readme.txt", b"hello")
    mkdir(root, "/研究室共有/空のフォルダ")
    write(root, "/研究室共有/教員/会議/議事録.docx", b"PK\x03\x04minutes")
    write(root, "/研究室共有/古いバックアップ/old.zip", b"z" * 5000)
    write(root, "/M2ゼミ/第1回/資料.pptx", b"PK\x03\x04slides" * 50)
    write(root, "/kano/個人/メモ.md", b"# memo")
    write(root, "/kano/写真/IMG_0001.jpg", b"\xff\xd8\xff" + b"j" * 7000)
    write(root, "/写真/旅行/a.jpg", b"\xff\xd8\xff" + b"k" * 9000)
    write(root, "/top.txt", b"top")
    return root


async def setup_targets(client: AsyncClient, db: AsyncSession, as_user: Any) -> User:
    admin = await make_user(db, "admin", role="admin")
    await make_user(db, "kano")
    as_user(admin)
    for name in ("faculty", "m2-seminar"):
        response = await client.post(f"{API}/channels", json={"name": name, "type": "private"})
        assert response.status_code == 201, response.text
    return admin


async def run(
    db: AsyncSession,
    app: FastAPI,
    source: Any,
    *,
    mapping: str = MAP,
    dry_run: bool = False,
    settings: Settings | None = None,
    options: Options | None = None,
    user_map: dict[str, str] | None = None,
) -> NextcloudReport:
    return await import_nextcloud(
        db,
        source,
        parse_mapping(mapping),
        actor_username="admin",
        user_map=user_map or {},
        blobs=store(app),
        settings=settings or small_parts(app),
        options=options or Options(),
        dry_run=dry_run,
    )


async def counts(db: AsyncSession) -> tuple[int, int, int, int]:
    items = await db.scalar(select(func.count()).select_from(DriveItem))
    versions = await db.scalar(select(func.count()).select_from(DriveFileVersion))
    refs = await db.scalar(
        select(func.count()).select_from(ImportRef).where(ImportRef.source == "nextcloud")
    )
    used = await db.scalar(select(func.sum(DriveLocation.used_bytes)))
    await db.commit()
    return int(items or 0), int(versions or 0), int(refs or 0), int(used or 0)


async def find(db: AsyncSession, name: str) -> DriveItem:
    row = (
        await db.execute(
            select(DriveItem)
            .where(DriveItem.name == name, DriveItem.trashed_at.is_(None))
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    await db.commit()
    return row


async def test_a_data_directory_imports_by_the_mapping(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Any, tmp_path: Path
) -> None:
    await setup_targets(client, db, as_user)
    root = tree(tmp_path)
    source = DataDirSource(root)
    assert source.label == "kano"
    before = await counts(db)

    dry = await run(db, app, source, dry_run=True)
    assert dry.dry_run
    assert await counts(db) == before  # nothing written, not even the locations
    assert dry.counts["files new"] == 6
    assert dry.counts["folders new"] == 6  # 論文, 2024, 図, 空のフォルダ, 会議, 第1回
    unmapped = {path: (size, files) for path, size, files in dry.unmapped}
    assert unmapped["/写真"] == (9003, 1)
    assert unmapped["/kano/写真"] == (7003, 1)
    assert unmapped["/top.txt"] == (3, 1)
    assert [(p, why) for p, why, _ in dry.skipped] == [("/研究室共有/古いバックアップ", "[[skip]]")]
    places = {use.label: use for use in dry.places.values()}
    assert places["研究室ドライブ"].files == 3
    assert places["#faculty"].files == 1
    assert places["マイドライブ (kano)"].files == 1

    report = await run(db, app, source)
    assert not report.failed and report.stopped is None
    assert report.counts["done: files"] == 6
    root_id = await workspace_root(client)
    assert await names_in(client, root_id) == ["空のフォルダ", "論文", "readme.txt"]
    paper = await find(db, "草稿 v1.pdf")
    assert paper.content_modified_at == T1
    version = (
        await db.execute(select(DriveFileVersion).where(DriveFileVersion.item_id == paper.id))
    ).scalar_one()
    assert version.source == "import"
    data = (root / "研究室共有/論文/2024/草稿 v1.pdf").read_bytes()
    assert version.sha256 == hashlib.sha256(data).digest()
    assert version.processed_at is not None  # a PDF: nothing left for the media loop
    image = await find(db, "fig1.png")
    image_version = (
        await db.execute(select(DriveFileVersion).where(DriveFileVersion.item_id == image.id))
    ).scalar_one()
    assert image_version.processed_at is None  # the media loop makes its thumbnail
    response = await client.get(f"{API}/drive/items/{paper.id}/content")
    assert response.status_code == 200 and response.content == data
    # The channel's drive and the My Drive were made; the target folder too.
    seminar = await find(db, "ゼミ資料")
    assert seminar.kind == "folder"
    folder = await find(db, "第1回")
    assert folder.parent_id == seminar.id
    memo = await find(db, "メモ.md")
    location = await db.get(DriveLocation, memo.location_id)
    assert location is not None and location.kind == "user"
    # Previews are left for generate-previews --drive.
    attachment_status = await db.scalar(
        select(func.count())
        .select_from(DriveFileVersion)
        .where(DriveFileVersion.item_id == paper.id)
    )
    assert attachment_status == 1
    audit = (
        await db.execute(select(AuditLog).where(AuditLog.action == "drive.import"))
    ).scalar_one()
    assert audit.details["counts"]["done: files"] == 6
    from app.modules.drive import usage

    assert await usage.verify(db) == []


async def test_a_run_again_adds_nothing_and_a_changed_file_becomes_a_version(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Any, tmp_path: Path
) -> None:
    await setup_targets(client, db, as_user)
    root = tree(tmp_path)
    source = DataDirSource(root)
    await run(db, app, source)
    after_first = await counts(db)
    objects = len(store(app).objects)

    again = await run(db, app, source)
    assert await counts(db) == after_first
    assert len(store(app).objects) == objects
    assert again.counts["files unchanged"] == 6 and again.counts["files new"] == 0
    # The comparison after a move: everything the mapping covers is there, unchanged.
    assert again.counts["nextcloud: files in the mapping"] == 6
    imported_bytes = sum(
        (root / p.lstrip("/")).stat().st_size
        for p in (
            "/研究室共有/論文/2024/草稿 v1.pdf",
            "/研究室共有/論文/2024/図/fig1.png",
            "/研究室共有/readme.txt",
            "/研究室共有/教員/会議/議事録.docx",
            "/M2ゼミ/第1回/資料.pptx",
            "/kano/個人/メモ.md",
        )
    )
    assert again.bytes["nextcloud: files in the mapping"] == imported_bytes == after_first[3]
    assert again.counts["folders unchanged"] == 6
    assert again.counts.get("done: files", 0) == 0

    # A changed file (size and time) and a new one in Nextcloud.
    write(root, "/研究室共有/readme.txt", b"hello again", at=T2)
    write(root, "/研究室共有/論文/2024/新しい.txt", b"new")
    third = await run(db, app, source)
    assert third.counts["files new version"] == 1 and third.counts["files new"] == 1
    readme = await find(db, "readme.txt")
    versions = list(
        (
            await db.execute(
                select(DriveFileVersion)
                .where(DriveFileVersion.item_id == readme.id)
                .order_by(DriveFileVersion.number)
            )
        ).scalars()
    )
    assert [v.number for v in versions] == [1, 2] and all(v.source == "import" for v in versions)
    assert readme.content_modified_at == T2 and readme.size_bytes == len(b"hello again")
    response = await client.get(f"{API}/drive/items/{readme.id}/content")
    assert response.content == b"hello again"
    items, version_count, refs, _ = await counts(db)
    assert (items, version_count, refs) == (
        after_first[0] + 1,
        after_first[1] + 2,
        after_first[2] + 1,
    )

    # Only the time changed: also a new version (Nextcloud says it changed).
    write(root, "/研究室共有/readme.txt", b"hello again", at=T1)
    assert (await run(db, app, source)).counts["files new version"] == 1

    # Deleted in Nextcloud: kept in Taylis, reported.
    (root / "研究室共有/readme.txt").unlink()
    gone = await run(db, app, source, dry_run=True)
    assert "file: readme.txt" in gone.gone


async def test_names_that_clash_become_numbered_and_are_reported(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Any
) -> None:
    # Over WebDAV: Nextcloud on Linux keeps names that differ only in case (a Mac's disk does
    # not, so not a data directory here).
    admin = await setup_targets(client, db, as_user)
    fake = FakeNextcloud(page=None)
    fake.add("研究室共有/Report.pdf", b"upper")
    fake.add("研究室共有/report.pdf", b"lower")
    fake.add("研究室共有/既存.txt", b"from nextcloud")
    fake.add("研究室共有/既存のフォルダ/中身.txt", b"inside")
    fake.add("研究室共有/Data/a.txt", b"a")
    fake.add("研究室共有/data/b.txt", b"b")
    fake.add("研究室共有/tab\there.txt", b"tab")
    # Made in Taylis before the import: a file and a folder of those names.
    as_user(admin)
    root_id = await workspace_root(client)
    await upload(client, root_id, "既存.txt", b"made in taylis")
    made = await client.post(
        f"{API}/drive/folders", json={"parent_id": root_id, "name": "既存のフォルダ"}
    )
    assert made.status_code == 201
    mapping = '[[map]]\nsource="/研究室共有"\ntarget="workspace:/"\n'

    dry = await run(db, app, webdav(fake), mapping=mapping, dry_run=True)
    renamed = {nc: (taylis, why) for nc, taylis, why in dry.renamed}
    assert renamed["/研究室共有/report.pdf"][0] == "研究室ドライブ/report (1).pdf"
    assert renamed["/研究室共有/既存.txt"][0] == "研究室ドライブ/既存 (1).txt"
    assert renamed["/研究室共有/data"][0] == "研究室ドライブ/data (1)"
    assert renamed["/研究室共有/tab\there.txt"] == (
        "研究室ドライブ/tab here.txt",
        "a name the drive refuses",
    )
    assert "/研究室共有/既存のフォルダ" not in renamed  # the Taylis folder is used
    assert len(renamed) == 4
    assert dry.counts["folders linked"] == 1

    report = await run(db, app, webdav(fake), mapping=mapping)
    assert not report.failed
    assert sorted(report.renamed) == sorted(dry.renamed)
    assert sorted(await names_in(client, root_id)) == sorted(
        [
            "data (1)",
            "Data",
            "既存のフォルダ",
            "既存 (1).txt",
            "既存.txt",
            "report (1).pdf",
            "Report.pdf",
            "tab here.txt",
        ]
    )
    lower = await find(db, "report (1).pdf")
    response = await client.get(f"{API}/drive/items/{lower.id}/content")
    assert response.content == b"lower"
    linked = await find(db, "既存のフォルダ")
    assert await names_in(client, str(linked.id)) == ["中身.txt"]
    # A run again keeps every name (the refs, not the names, decide).
    again = await run(db, app, webdav(fake), mapping=mapping)
    assert again.renamed == [] and again.counts["files unchanged"] == 7


async def test_a_missing_target_stops_before_anything_is_written(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Any, tmp_path: Path
) -> None:
    admin = await make_user(db, "admin", role="admin")
    await make_user(db, "guest1", role="guest")
    as_user(admin)
    root = tree(tmp_path)
    mapping = MAP + '\n[[map]]\nsource="/写真"\ntarget="user:guest1:/"\n'
    before = await counts(db)
    with pytest.raises(ImportFailed) as failed:
        await run(db, app, DataDirSource(root), mapping=mapping)
    message = str(failed.value)
    assert "channel:faculty:/: no channel named faculty" in message
    assert "channel:m2-seminar:/ゼミ資料: no channel named m2-seminar" in message
    assert "user:kano:/: no user named kano" in message
    assert "guest1 has no My Drive (guest)" in message
    assert await counts(db) == before
    # The dry run says the same, and still plans the rest.
    dry = await run(db, app, DataDirSource(root), mapping=mapping, dry_run=True)
    assert len(dry.missing_targets) == 4
    assert dry.counts["files new"] == 3  # the workspace's: readme.txt, the PDF, the PNG
    assert await counts(db) == before


async def test_quotas_are_respected(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Any, tmp_path: Path
) -> None:
    await setup_targets(client, db, as_user)
    root = tmp_path / "kano" / "files"
    for i in range(5):
        write(root, f"/研究室共有/f{i}.bin", bytes([i]) * 1000)
    mapping = '[[map]]\nsource="/研究室共有"\ntarget="workspace:/"\n'
    settings = small_parts(app, drive_total_quota_bytes=2500)
    dry = await run(db, app, DataDirSource(root), mapping=mapping, dry_run=True, settings=settings)
    assert any("DRIVE_TOTAL_QUOTA_BYTES" in line for line in dry.over_quota)
    report = await run(db, app, DataDirSource(root), mapping=mapping, settings=settings)
    assert report.counts["done: files"] == 2
    assert [why for _, why in report.failed] == ["drive_quota_exceeded"] * 3
    assert (await counts(db))[3] == 2000


async def test_limit_bytes_ends_a_run_and_the_next_goes_on(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Any, tmp_path: Path
) -> None:
    await setup_targets(client, db, as_user)
    root = tmp_path / "kano" / "files"
    for i in range(6):
        write(root, f"/研究室共有/f{i}.bin", bytes([i]) * 1000)
    mapping = '[[map]]\nsource="/研究室共有"\ntarget="workspace:/"\n'
    first = await run(
        db, app, DataDirSource(root), mapping=mapping, options=Options(limit_bytes=2500)
    )
    assert first.counts["done: files"] == 2 and first.stopped and "--limit-bytes" in first.stopped
    second = await run(
        db, app, DataDirSource(root), mapping=mapping, options=Options(limit_bytes=2500)
    )
    assert second.counts["files unchanged"] == 2 and second.counts["done: files"] == 2
    third = await run(db, app, DataDirSource(root), mapping=mapping)
    assert third.counts["done: files"] == 2 and third.stopped is None
    assert (await counts(db))[:3] == (7, 6, 6)  # the root + 6 files; 6 versions; 6 refs


class Interrupted(BaseException):
    """Like Ctrl-C: not an Exception, so nothing catches it on the way."""


class CutOff(DataDirSource):
    """A data directory whose reads stop (an interruption) at the `after`-th file, half-way."""

    def __init__(self, root: Path, after: int) -> None:
        super().__init__(root)
        self.after = after
        self.opened = 0

    @asynccontextmanager
    async def open(self, path: str) -> AsyncIterator[AsyncIterator[bytes]]:
        self.opened += 1
        if self.opened < self.after:
            async with super().open(path) as chunks:
                yield chunks
            return

        async def broken() -> AsyncIterator[bytes]:
            yield b"x" * (PART + 10)
            raise Interrupted

        yield broken()


async def test_an_interrupted_run_goes_on_from_where_it_stopped(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Any, tmp_path: Path
) -> None:
    await setup_targets(client, db, as_user)
    root = tmp_path / "kano" / "files"
    big = os.urandom(PART * 3 + 17)  # several parts: a multipart upload
    for i in range(4):
        write(root, f"/研究室共有/f{i}.bin", big[: PART * 3 + i])
    mapping = '[[map]]\nsource="/研究室共有"\ntarget="workspace:/"\n'
    with pytest.raises(Interrupted):
        await run(db, app, CutOff(root, after=3), mapping=mapping)
    items, versions, refs, _used = await counts(db)
    assert (items, versions, refs) == (3, 2, 2)  # the root and two files
    blobs = store(app)
    assert not blobs.uploads  # the cut-off multipart upload was aborted
    assert len(blobs.objects) == 2

    report = await run(db, app, DataDirSource(root), mapping=mapping)
    assert report.counts["files unchanged"] == 2 and report.counts["done: files"] == 2
    assert (await counts(db))[:3] == (5, 4, 4)
    for i in range(4):
        item = await find(db, f"f{i}.bin")
        response = await client.get(f"{API}/drive/items/{item.id}/content")
        assert response.content == big[: PART * 3 + i]
    assert len(blobs.objects) == 4


async def test_owners_changed_files_and_the_trash(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Any, tmp_path: Path
) -> None:
    admin = await setup_targets(client, db, as_user)
    kano_id = (await db.execute(select(User.id).where(User.username == "kano"))).scalar_one()
    admin_id = admin.id
    await db.commit()
    root = tmp_path / "kano" / "files"
    write(root, "/研究室共有/a.txt", b"a")
    write(root, "/研究室共有/b.txt", b"b")
    write(root, "/研究室共有/c/d.txt", b"d")
    mapping = '[[map]]\nsource="/研究室共有"\ntarget="workspace:/"\n'
    await run(db, app, DataDirSource(root), mapping=mapping, user_map={"kano": "kano"})
    a = await find(db, "a.txt")
    assert a.created_by == kano_id
    # In Taylis: a new version of a.txt, b.txt to the trash, folder c to the trash.
    as_user(admin)
    response = await client.post(
        f"{API}/drive/uploads",
        json={
            "client_upload_id": str(uuid.uuid4()),
            "parent_id": str(a.parent_id),
            "name": "a.txt",
            "size_bytes": 2,
            "on_conflict": "version",
        },
    )
    assert response.status_code == 201
    upload_id = response.json()["id"]
    await client.put(
        f"{API}/drive/uploads/{upload_id}/parts/1",
        content=b"aa",
        headers={"X-Content-SHA256": hashlib.sha256(b"aa").hexdigest()},
    )
    assert (await client.post(f"{API}/drive/uploads/{upload_id}/complete")).status_code == 200
    b = await find(db, "b.txt")
    c = await find(db, "c")
    trashed = await client.post(
        f"{API}/drive/items/trash", json={"item_ids": [str(b.id), str(c.id)]}
    )
    assert trashed.status_code == 200, trashed.text
    # In Nextcloud: all three changed.
    write(root, "/研究室共有/a.txt", b"a2", at=T2)
    write(root, "/研究室共有/b.txt", b"b2", at=T2)
    write(root, "/研究室共有/c/d.txt", b"d2", at=T2)
    report = await run(db, app, DataDirSource(root), mapping=mapping)
    reasons = {path: why for path, why, _ in report.skipped}
    assert reasons["/研究室共有/a.txt"].startswith("changed in Taylis since the import")
    assert reasons["/研究室共有/b.txt"] == "in the Taylis trash: not imported again"
    assert reasons["/研究室共有/c"] == "in the Taylis trash: not imported again"
    assert report.counts["skipped (in a folder that is not imported)"] == 1
    assert report.counts.get("done: files", 0) == 0
    # An owner without --user is the actor's, and is reported.
    write(root, "/研究室共有/e.txt", b"e")
    other = await run(db, app, DataDirSource(root), mapping=mapping)
    assert other.owners["kano"] == 1
    e = await find(db, "e.txt")
    assert e.created_by == admin_id


def test_import_keys_fit_import_refs() -> None:
    mapping = parse_mapping('[[map]]\nsource="/a"\ntarget="channel:x:/b"\n')
    rule = mapping.rules[0]
    assert rule.target is not None
    key = ref_key("kano", "/a/ファイル.pdf", rule.target)
    assert len(key) == 64 and key == ref_key("kano", "/a/ファイル.pdf", rule.target)
    assert key != ref_key("other", "/a/ファイル.pdf", rule.target)


# --- WebDAV ------------------------------------------------------------------------------------


class FakeNextcloud:
    """Enough of Nextcloud's WebDAV for the import: PROPFIND with Depth 1 (Depth infinity
    refused, as most servers do), Nextcloud's paged answers (X-NC-Paginate), GET, Basic auth,
    and the OCS shares API. Names are kept as given (one is NFD, as a Mac client can leave)."""

    def __init__(self, user: str = "kano", password: str = "app-pass", page: int | None = 2):
        self.user = user
        self.password = password
        self.page = page
        self.files: dict[str, tuple[bytes, datetime]] = {}
        self.folders: set[str] = {""}
        self.propfinds: list[tuple[str, str, dict[str, str]]] = []
        self.listings: dict[str, list[str]] = {}
        self.fail_get: set[str] = set()

    def add(self, path: str, data: bytes, at: datetime = T1) -> None:
        parts = path.strip("/").split("/")
        for i in range(1, len(parts)):
            self.folders.add("/".join(parts[:i]))
        self.files["/".join(parts)] = (data, at)

    def mkdir(self, path: str) -> None:
        parts = path.strip("/").split("/")
        for i in range(1, len(parts) + 1):
            self.folders.add("/".join(parts[:i]))

    @property
    def base(self) -> str:
        return f"/remote.php/dav/files/{self.user}/"

    def href(self, path: str, folder: bool) -> str:
        return self.base + quote(path) + ("/" if folder and path else "")

    def response(self, path: str) -> str:
        if path in self.folders:
            size = sum(len(d) for p, (d, _) in self.files.items() if p.startswith(path))
            props = (
                "<d:resourcetype><d:collection/></d:resourcetype>"
                f"<oc:size>{size}</oc:size>"
                f"<d:getlastmodified>{format_datetime(T1, usegmt=True)}</d:getlastmodified>"
            )
            missing = "<d:getcontentlength/>"
            folder = True
        else:
            data, at = self.files[path]
            props = (
                "<d:resourcetype/>"
                f"<d:getcontentlength>{len(data)}</d:getcontentlength>"
                f"<d:getlastmodified>{format_datetime(at, usegmt=True)}</d:getlastmodified>"
            )
            missing = "<oc:size/>"
            folder = False
        return (
            f"<d:response><d:href>{self.href(path, folder)}</d:href>"
            f"<d:propstat><d:prop>{props}<oc:owner-id>{self.user}</oc:owner-id></d:prop>"
            "<d:status>HTTP/1.1 200 OK</d:status></d:propstat>"
            f"<d:propstat><d:prop>{missing}</d:prop>"
            "<d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>"
        )

    def children(self, folder: str) -> list[str]:
        prefix = folder + "/" if folder else ""
        out = [
            p
            for p in sorted(self.folders | set(self.files))
            if p and p.startswith(prefix) and "/" not in p[len(prefix) :]
        ]
        return out

    def handler(self, request: httpx.Request) -> httpx.Response:
        expected = httpx.BasicAuth(self.user, self.password)
        auth = next(expected.auth_flow(httpx.Request("GET", "http://x"))).headers["Authorization"]
        if request.headers.get("Authorization") != auth:
            return httpx.Response(401)
        path = unquote(urlsplit(str(request.url)).path)
        if path.startswith("/ocs/v2.php/apps/files_sharing/api/v1/shares"):
            return self.shares(request)
        if not path.startswith(self.base):
            return httpx.Response(404)
        rel = path[len(self.base) :].strip("/")
        if request.method == "PROPFIND":
            self.propfinds.append((rel, request.headers.get("Depth", ""), dict(request.headers)))
            if request.headers.get("Depth") != "1":
                return httpx.Response(403)
            if rel not in self.folders:
                return httpx.Response(404)
            listing = [rel, *self.children(rel)]
            headers = {}
            offset = 0
            token = request.headers.get("X-NC-Paginate-Token")
            if self.page is not None and request.headers.get("X-NC-Paginate") == "true":
                if token is not None:
                    assert token == f"tok-{quote(rel)}"
                    offset = int(request.headers["X-NC-Paginate-Offset"])
                count = int(request.headers.get("X-NC-Paginate-Count", "0"))
                page = listing[offset : offset + min(count, self.page)]
                # As Nextcloud 31 answers: the token and the total on the first page only.
                headers = {"X-NC-Paginate": "true"}
                if token is None:
                    headers["X-NC-Paginate-Total"] = str(len(listing))
                    headers["X-NC-Paginate-Token"] = f"tok-{quote(rel)}"
            else:
                page = listing
            body = (
                '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" '
                'xmlns:oc="http://owncloud.org/ns">'
                + "".join(self.response(p) for p in page)
                + "</d:multistatus>"
            )
            return httpx.Response(207, content=body.encode(), headers=headers)
        if request.method == "GET":
            if rel in self.fail_get:
                return httpx.Response(503)
            if rel not in self.files:
                return httpx.Response(404)
            return httpx.Response(200, content=self.files[rel][0])
        return httpx.Response(405)

    def shares(self, request: httpx.Request) -> httpx.Response:
        assert request.headers.get("OCS-APIRequest") == "true"
        mine = request.url.params.get("shared_with_me") != "true"
        data = (
            [
                {
                    "share_type": 1,
                    "share_with": "faculty",
                    "share_with_displayname": "教員",
                    "path": "/研究室共有/教員",
                    "item_type": "folder",
                    "permissions": 31,
                    "uid_owner": self.user,
                    "expiration": None,
                },
                {
                    "share_type": 3,
                    "token": "SECRET-TOKEN",
                    "url": "https://cloud/s/SECRET-TOKEN",
                    "label": "学会",
                    "path": "/M2ゼミ/第1回/資料.pptx",
                    "item_type": "file",
                    "permissions": 1,
                    "uid_owner": self.user,
                    "expiration": "2026-12-31 00:00:00",
                    "password": "hashed",
                },
            ]
            if mine
            else [
                {
                    "share_type": 0,
                    "share_with": self.user,
                    "path": "/共同研究",
                    "file_target": "/共同研究",
                    "item_type": "folder",
                    "permissions": 1,
                    "uid_owner": "tanaka",
                }
            ]
        )
        return httpx.Response(200, json={"ocs": {"meta": {"status": "ok"}, "data": data}})


def webdav(fake: FakeNextcloud, **kwargs: Any) -> WebDavSource:
    return WebDavSource(
        f"https://cloud.example.ac.jp{fake.base}",
        fake.user,
        fake.password,
        transport=httpx.MockTransport(fake.handler),
        **kwargs,
    )


def fake_tree() -> FakeNextcloud:
    fake = FakeNextcloud()
    fake.add("研究室共有/論文/草稿 v1.pdf", b"%PDF-1.4 " * 300)
    fake.add("研究室共有/論文/% & #?.txt", b"odd")
    nfd = unicodedata.normalize("NFD", "研究室共有/データ/ばけがく.csv")
    fake.add(nfd, b"a,b\n1,2\n")
    fake.mkdir("研究室共有/空")
    for i in range(5):
        fake.add(f"研究室共有/多い/{i:02d}.txt", f"{i}".encode())
    fake.add("写真/大きい.jpg", b"\xff\xd8\xff" + b"j" * 5000)
    return fake


async def test_the_webdav_client_walks_folders_one_level_at_a_time() -> None:
    fake = fake_tree()
    source = webdav(fake)
    mapping = parse_mapping('[[map]]\nsource="/研究室共有"\ntarget="workspace:/"\n')
    walk = await source.walk(mapping.descend)
    await source.close()
    paths = [(e.path, e.kind) for e in walk.entries]
    assert ("/研究室共有/データ/ばけがく.csv", "file") in paths  # NFC for the plan …
    csv = next(e for e in walk.entries if e.path.endswith(".csv"))
    assert csv.source_path == "/" + unicodedata.normalize("NFD", "研究室共有/データ/ばけがく.csv")
    assert ("/研究室共有/空", "folder") in paths
    assert ("/研究室共有/論文/% & #?.txt", "file") in paths
    assert [e.path for e in walk.entries if "/多い/" in e.path] == [
        f"/研究室共有/多い/{i:02d}.txt" for i in range(5)
    ]
    pdf = next(e for e in walk.entries if e.path.endswith(".pdf"))
    assert (pdf.size, pdf.mtime, pdf.owner) == (2700, T1, "kano")
    # /写真 is not mapped: listed with its size, never opened.
    assert [(u.path, u.size) for u in walk.unvisited] == [("/写真", 5003)]
    assert all(depth == "1" for _, depth, _ in fake.propfinds)
    assert "写真" not in [rel for rel, _, _ in fake.propfinds]
    # Paged: 7 children of 多い + itself in pages of 2.
    pages = [h for rel, _, h in fake.propfinds if rel == "研究室共有/多い"]
    assert len(pages) == 3
    assert pages[0].get("x-nc-paginate") == "true" and "x-nc-paginate-token" not in pages[0]
    assert [p.get("x-nc-paginate-offset") for p in pages[1:]] == ["2", "4"]


async def test_the_webdav_client_without_paging_and_its_errors() -> None:
    fake = fake_tree()
    fake.page = None
    source = webdav(fake)
    walk = await source.walk(lambda _: True)
    assert len([e for e in walk.entries if e.kind == "file"]) == 9
    assert len([r for r, _, _ in fake.propfinds if r == "研究室共有/多い"]) == 1
    async with source.open("/研究室共有/論文/% & #?.txt") as chunks:
        assert b"".join([c async for c in chunks]) == b"odd"
    with pytest.raises(SourceError, match="HTTP 404"):
        async with source.open("/nothing.txt") as chunks:
            pass
    await source.close()
    wrong = WebDavSource(
        f"https://cloud.example.ac.jp{fake.base}",
        "kano",
        "wrong",
        transport=httpx.MockTransport(fake.handler),
    )
    with pytest.raises(SourceError) as failed:
        await wrong.walk(lambda _: True)
    assert "HTTP 401" in str(failed.value) and "wrong" not in str(failed.value)
    await wrong.close()
    with pytest.raises(SourceError, match="must not contain a user"):
        WebDavSource("https://kano:pw@cloud/remote.php/dav/files/kano/", "kano", "pw")
    assert server_root("https://cloud.example/nc/remote.php/dav/files/kano/") == (
        "https://cloud.example/nc"
    )
    assert webdav(fake).label == "kano"


def test_a_multistatus_with_missing_properties() -> None:
    body = (
        b'<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">'
        b"<d:response><d:href>/remote.php/dav/files/kano/%E8%AB%96%E6%96%87/a%20b.pdf</d:href>"
        b"<d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12</d:getcontentlength>"
        b"<d:getlastmodified>Mon, 01 Apr 2024 09:30:15 GMT</d:getlastmodified></d:prop>"
        b"<d:status>HTTP/1.1 200 OK</d:status></d:propstat>"
        b"<d:propstat><d:prop><oc:owner-id/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status>"
        b"</d:propstat></d:response></d:multistatus>"
    )
    [row] = parse_multistatus(body)
    assert row == {
        "href": "/remote.php/dav/files/kano/論文/a b.pdf",
        "folder": False,
        "size": 12,
        "mtime": T1,
        "owner": None,
    }
    with pytest.raises(SourceError, match="not XML"):
        parse_multistatus(b"<html>")


async def test_list_shares_reads_the_ocs_api_and_shows_no_secret() -> None:
    fake = fake_tree()
    source = webdav(fake)
    shares = await source.list_shares()
    await source.close()
    assert [(s["direction"], s["path"], s["type"], s["with"]) for s in shares] == [
        ("by me", "/研究室共有/教員", "group", "教員"),
        ("by me", "/M2ゼミ/第1回/資料.pptx", "public link", "学会"),
        ("with me", "/共同研究", "user", "kano"),
    ]
    assert shares[0]["permissions"] == "rwcds" and shares[1]["password"] is True
    assert shares[1]["expires"] == "2026-12-31"
    assert "SECRET-TOKEN" not in repr(shares)


async def test_an_import_over_webdav_and_a_run_again(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Any
) -> None:
    await setup_targets(client, db, as_user)
    fake = fake_tree()
    big = os.urandom(PART * 4 + 3)
    fake.add("研究室共有/大きな.bin", big)
    mapping = '[[map]]\nsource="/研究室共有"\ntarget="workspace:/"\n'
    report = await run(db, app, webdav(fake), mapping=mapping)
    assert not report.failed and report.counts["done: files"] == 9
    item = await find(db, "ばけがく.csv")  # stored NFC, read through the NFD href
    response = await client.get(f"{API}/drive/items/{item.id}/content")
    assert response.content == b"a,b\n1,2\n"
    big_item = await find(db, "大きな.bin")
    response = await client.get(f"{API}/drive/items/{big_item.id}/content")
    assert hashlib.sha256(response.content).digest() == hashlib.sha256(big).digest()
    assert unmapped_sizes(report) == {"/写真": 5003}
    first = await counts(db)
    again = await run(db, app, webdav(fake), mapping=mapping)
    assert again.counts["files unchanged"] == 9 and await counts(db) == first
    # A read that fails is reported, retried next time, and does not stop the run.
    fake.add("研究室共有/論文/草稿 v1.pdf", b"%PDF-1.4 v2", at=T2)
    fake.add("研究室共有/新.txt", b"new")
    fake.fail_get.add("研究室共有/論文/草稿 v1.pdf")
    third = await run(db, app, webdav(fake), mapping=mapping)
    assert [path for path, _ in third.failed] == ["/研究室共有/論文/草稿 v1.pdf"]
    assert third.counts["done: files"] == 1
    fake.fail_get.clear()
    fourth = await run(db, app, webdav(fake), mapping=mapping)
    assert fourth.counts["files new version"] == 1 and not fourth.failed


def unmapped_sizes(report: NextcloudReport) -> dict[str, int]:
    return {path: size for path, size, _ in report.unmapped}


async def test_a_data_directory_lists_what_it_cannot_take(tmp_path: Path) -> None:
    root = tmp_path / "files"
    write(root, "/a/real.txt", b"x")
    write(root, "/a/.ocTransferId123.part", b"partial")
    (root / "a" / "link").symlink_to(root / "a" / "real.txt")
    nfd = unicodedata.normalize("NFD", "ぱ.txt")
    write(root, f"/a/{nfd}", b"p")
    source = DataDirSource(root, label="kano")
    walk = await source.walk(lambda _: True)
    files = {e.path: e for e in walk.entries if e.kind == "file"}
    assert set(files) == {"/a/real.txt", "/a/ぱ.txt"}
    assert files["/a/ぱ.txt"].source_path.endswith(nfd)
    async with source.open(files["/a/ぱ.txt"].source_path) as chunks:
        assert b"".join([c async for c in chunks]) == b"p"
    assert sorted(why for _, why in walk.skipped) == [
        "a symbolic link",
        "an unfinished Nextcloud upload (.part)",
    ]
    with pytest.raises(SourceError, match="not a directory"):
        DataDirSource(tmp_path / "missing")


def test_entries_name() -> None:
    assert Entry("/a/b c.pdf", "file", 1, None).name == "b c.pdf"


# --- generate-previews --drive -------------------------------------------------------------------


async def test_generate_previews_for_the_drive_lets_the_chat_go_first(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Any, tmp_path: Path
) -> None:
    from app.modules.attachments import previews
    from app.modules.attachments.models import Attachment
    from tests.test_previews import enable, pdf_bytes

    admin = await setup_targets(client, db, as_user)
    root = tmp_path / "kano" / "files"
    for name in ("a.pdf", "b.pdf", "c.pdf"):
        write(root, f"/研究室共有/{name}", pdf_bytes(1))
    mapping = '[[map]]\nsource="/研究室共有"\ntarget="workspace:/"\n'
    settings = enable(app, None)
    await run(db, app, DataDirSource(root), mapping=mapping, settings=settings)
    # Imported without a preview; b.pdf gets a second version, c.pdf goes to the trash.
    write(root, "/研究室共有/b.pdf", pdf_bytes(2), at=T2)
    await run(db, app, DataDirSource(root), mapping=mapping, settings=settings)
    c = await find(db, "c.pdf")
    as_user(admin)
    trashed = await client.post(f"{API}/drive/items/trash", json={"item_ids": [str(c.id)]})
    assert trashed.status_code == 200
    statuses = {
        row.filename + f" v{n}": row.preview_status
        for row, n in (
            await db.execute(
                select(Attachment, DriveFileVersion.number).join(
                    DriveFileVersion, DriveFileVersion.attachment_id == Attachment.id
                )
            )
        ).all()
    }
    await db.commit()
    assert set(statuses.values()) == {"none"} and len(statuses) == 4

    # A chat file waiting for the server's loop: the backfill waits for it.
    chat = await client.post(
        f"{API}/attachments", files={"file": ("chat.pdf", pdf_bytes(1), "application/pdf")}
    )
    assert chat.status_code == 201, chat.text
    chat_id = uuid.UUID(chat.json()["id"])
    slept: list[float] = []

    async def sleep(seconds: float) -> None:
        slept.append(seconds)
        if len(slept) == 3:  # the loop took it meanwhile
            row = await db.get(Attachment, chat_id)
            assert row is not None
            row.preview_status = "ready"
            await db.commit()

    # Without --drive nothing of the drive is taken.
    plain = await previews.generate_stored(db, app.state.blobs, None, settings, limit=10)
    assert plain.tried == 0  # the chat file is pending (the loop's), not "none"

    result = await previews.generate_stored(
        db, app.state.blobs, None, settings, limit=10, drive=True, sleep=sleep
    )
    assert (result.tried, result.ready, result.remaining) == (2, 2, False)
    assert slept == [2.0, 2.0, 2.0] and result.waited_seconds == 6.0
    statuses = {
        row.filename + f" v{n}": row.preview_status
        for row, n in (
            await db.execute(
                select(Attachment, DriveFileVersion.number)
                .join(DriveFileVersion, DriveFileVersion.attachment_id == Attachment.id)
                .execution_options(populate_existing=True)
            )
        ).all()
    }
    await db.commit()
    assert statuses == {
        "a.pdf v1": "ready",
        "b.pdf v1": "none",  # not the current version
        "b.pdf v2": "ready",
        "c.pdf v1": "none",  # in the trash
    }
    again = await previews.generate_stored(
        db, app.state.blobs, None, settings, limit=10, drive=True, sleep=sleep
    )
    assert again.tried == 0
    # The wait has a ceiling.
    row = await db.get(Attachment, chat_id)
    assert row is not None
    row.preview_status = "pending"
    await db.commit()
    waited = await previews._let_the_chat_go_first(db, 5.0, sleep)
    assert waited == 5.0


# --- 2026-10-22 (docs/DRIVE.md §27): the preview asked for when an imported file is opened ------


async def test_opening_an_imported_file_asks_for_its_preview(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Any, tmp_path: Path
) -> None:
    from app.modules.attachments import previews
    from app.modules.attachments.models import Attachment
    from tests.test_previews import enable, pdf_bytes

    admin = await setup_targets(client, db, as_user)
    root = tmp_path / "kano" / "files"
    write(root, "/研究室共有/a.pdf", pdf_bytes(2))
    # A PDF with bytes before its header: the sniffer calls it octet-stream, PDFium reads it.
    write(root, "/研究室共有/scan.pdf", b"\r\n" * 8 + pdf_bytes(1))
    write(root, "/研究室共有/notes.txt", b"plain text")
    mapping = '[[map]]\nsource="/研究室共有"\ntarget="workspace:/"\n'
    settings = enable(app, None)
    await run(db, app, DataDirSource(root), mapping=mapping, settings=settings)
    a = await find(db, "a.pdf")
    scan = await find(db, "scan.pdf")
    notes = await find(db, "notes.txt")
    assert scan.content_type == "application/octet-stream"
    as_user(admin)
    shown = (await client.get(f"{API}/drive/items/{a.id}")).json()["item"]
    assert shown["file"]["preview"] is None  # imported without one

    asked = await client.post(f"{API}/drive/items/{a.id}/preview")
    assert asked.status_code == 200, asked.text
    assert asked.json()["preview"]["status"] == "pending"
    again = await client.post(f"{API}/drive/items/{a.id}/preview")
    assert again.json()["preview"]["status"] == "pending"  # asked twice: queued once
    scanned = await client.post(f"{API}/drive/items/{scan.id}/preview")
    assert scanned.json()["preview"]["status"] == "pending"
    # Not a document: nothing to make. A folder is not a file.
    plain = await client.post(f"{API}/drive/items/{notes.id}/preview")
    assert plain.json() == {"preview": None}
    folder = await client.post(f"{API}/drive/items/{shown['parent_id']}/preview")
    assert folder.status_code == 404

    # The preview loop makes both (the octet-stream PDF too).
    while await previews.process_due(app.state.db, app.state.blobs, None, settings):
        pass
    for item in (a, scan):
        out = (await client.post(f"{API}/drive/items/{item.id}/preview")).json()["preview"]
        assert out["status"] == "ready", item.name
    detail = (await client.get(f"{API}/drive/items/{scan.id}")).json()["item"]
    pdf = await client.get(f"{API}/attachments/{detail['file']['attachment_id']}/preview/pdf")
    assert pdf.status_code == 200 and pdf.headers["content-type"] == "application/pdf"
    assert pdf.headers["content-disposition"].startswith("inline")

    # A failed preview is not queued again by asking.
    row = (
        await db.execute(
            select(Attachment)
            .where(Attachment.drive_item_id == a.id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    row.preview_status = "failed"
    await db.commit()
    out = (await client.post(f"{API}/drive/items/{a.id}/preview")).json()["preview"]
    assert out["status"] == "failed"
