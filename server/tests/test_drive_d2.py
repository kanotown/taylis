"""The drive's additions of phase D2 (M161, docs/DRIVE.md §7.3, §12, §20): download tickets for the
Web's own downloads, the file-name search /search/drive, and the file time in an upload session."""

import uuid
from collections.abc import Callable

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import redact_path
from app.modules.drive.tickets import DownloadTickets
from app.modules.drive.uploads import DriveRuntime
from app.modules.users.models import User
from tests.drive_helpers import (
    act_as,
    drive_settings,
    folder,
    location,
    start,
    upload,
    workspace_root,
)
from tests.helpers import make_user

API = "/api/v1"


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


def runtime(app: FastAPI) -> DriveRuntime:
    found = app.state.drive
    assert isinstance(found, DriveRuntime)
    return found


# --- download tickets (§7.3) ---------------------------------------------------------------------


def test_tickets_expire_when_idle_and_at_their_limit() -> None:
    now = [1000.0]
    tickets = DownloadTickets(clock=lambda: now[0], idle_seconds=10, max_seconds=25, per_user=2)
    user, item, version = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    token = tickets.issue(user, item, version)
    assert len(token) >= 43
    assert tickets.use("nope") is None
    now[0] += 9
    assert tickets.use(token) is not None  # used in time: extended by 10 s
    now[0] += 9
    assert tickets.use(token) is not None
    now[0] += 9  # 27 s after it was issued: past its hard limit
    assert tickets.use(token) is None
    # Idle too long.
    other = tickets.issue(user, item, version)
    now[0] += 11
    assert tickets.use(other) is None
    # A person holds a few at most: the oldest goes first.
    first = tickets.issue(user, item, version)
    now[0] += 1
    second = tickets.issue(user, item, version)
    now[0] += 1
    third = tickets.issue(user, item, version)
    assert tickets.use(first) is None
    assert tickets.use(second) is not None and tickets.use(third) is not None
    # The token is never kept, only its hash.
    assert all(isinstance(key, bytes) and len(key) == 32 for key in tickets._tickets)


async def test_a_ticket_downloads_without_the_token_while_access_lasts(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    owner = await make_user(db, "owner")
    member = await make_user(db, "member")
    as_user(owner)
    lab = (await client.post(f"{API}/channels", json={"name": "lab", "type": "private"})).json()
    await client.post(f"{API}/channels/{lab['id']}/members", json={"user_id": str(member.id)})
    root = (await location(client, "channel", channel_id=lab["id"]))["root_id"]
    data = bytes(range(256)) * 20
    item = await upload(client, root, "データ.bin", data)

    as_user(member)
    answer = await client.post(f"{API}/drive/items/{item['id']}/download-ticket")
    assert answer.status_code == 200, answer.text
    ticket = answer.json()
    assert ticket["url"].startswith("/api/v1/drive/download/") and ticket["expires_in"] == 300
    # A folder has no ticket; neither has an item I cannot read.
    assert (await client.post(f"{API}/drive/items/{root}/download-ticket")).status_code == 404

    app.dependency_overrides.clear()  # no bearer token from here on
    whole = await client.get(ticket["url"])
    assert whole.status_code == 200 and whole.content == data
    assert whole.headers["content-disposition"].startswith("attachment;")
    assert "%E3%83%87" in whole.headers["content-disposition"]  # the current name, UTF-8
    assert whole.headers["cache-control"] == "private, no-store"
    assert whole.headers["accept-ranges"] == "bytes"
    part = await client.get(ticket["url"], headers={"Range": "bytes=100-199"})
    assert part.status_code == 206 and part.content == data[100:200]
    assert (await client.get(f"{API}/drive/download/{'x' * 43}")).status_code == 404
    assert redact_path(ticket["url"]) == "/api/v1/drive/download/***"

    # Out of the channel: the same ticket stops at once.
    as_user(owner)
    removed = await client.delete(f"{API}/channels/{lab['id']}/members/{member.id}")
    assert removed.status_code in (200, 204), removed.text
    app.dependency_overrides.clear()
    gone = await client.get(ticket["url"])
    assert gone.status_code == 404
    assert gone.json()["error"]["code"] == "drive_item_not_found"


async def test_a_ticket_names_the_version_and_ends_with_the_trash(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    member = await make_user(db, "member")
    as_user(member)
    root = await workspace_root(client)
    first = await upload(client, root, "a.txt", b"one")
    await upload(client, root, "a.txt", b"two!", on_conflict="version")
    versions = (await client.get(f"{API}/drive/items/{first['id']}")).json()["item"]
    assert versions["version_count"] == 2
    old = first["file"]["version_id"]
    ticket = (
        await client.post(f"{API}/drive/items/{first['id']}/download-ticket?version_id={old}")
    ).json()
    latest = (await client.post(f"{API}/drive/items/{first['id']}/download-ticket")).json()
    assert (await client.get(ticket["url"])).content == b"one"
    assert (await client.get(latest["url"])).content == b"two!"
    wrong = await client.post(
        f"{API}/drive/items/{first['id']}/download-ticket?version_id={uuid.uuid4()}"
    )
    assert wrong.status_code == 404
    trashed = await client.post(f"{API}/drive/items/trash", json={"item_ids": [first["id"]]})
    assert trashed.status_code == 200
    assert (await client.get(latest["url"])).status_code == 404
    assert len(runtime(app).tickets) >= 2


async def test_a_ticket_of_a_deactivated_person_stops(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    member = await make_user(db, "member")
    as_user(member)
    root = (await location(client, "me"))["root_id"]
    item = await upload(client, root, "mine.txt", b"private")
    ticket = (await client.post(f"{API}/drive/items/{item['id']}/download-ticket")).json()
    assert (await client.get(ticket["url"])).content == b"private"
    found = await db.get(User, member.id, populate_existing=True)
    assert found is not None
    from app.core.time import utcnow

    found.deactivated_at = utcnow()
    await db.commit()
    assert (await client.get(ticket["url"])).status_code == 404


# --- the file-name search (§12) ------------------------------------------------------------------


async def test_search_finds_names_in_readable_drives_only(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    owner = await make_user(db, "owner")
    guest = await make_user(db, "guest", role="guest")
    outsider = await make_user(db, "outsider")
    as_user(owner)
    workspace = await workspace_root(client)
    seminar = await folder(client, workspace, "ゼミ資料")
    await upload(client, seminar, "修論_最終版.pdf", b"%PDF-1.4 a")
    await upload(client, workspace, "Report final.docx", b"docx")
    lab = (await client.post(f"{API}/channels", json={"name": "lab", "type": "private"})).json()
    await client.post(f"{API}/channels/{lab['id']}/members", json={"user_id": str(guest.id)})
    channel = await location(client, "channel", channel_id=lab["id"])
    await upload(client, channel["root_id"], "修論_メモ.txt", b"memo")
    mine = await location(client, "me")
    await upload(client, mine["root_id"], "修論_下書き.txt", b"draft")
    trashed = await upload(client, workspace, "修論_古い.txt", b"old")
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [trashed["id"]]})

    async def names(q: str, **params: str) -> list[str]:
        response = await client.get(f"{API}/search/drive", params={"q": q, **params})
        assert response.status_code == 200, response.text
        return sorted(hit["item"]["name"] for hit in response.json()["items"])

    assert await names("修論") == ["修論_メモ.txt", "修論_下書き.txt", "修論_最終版.pdf"]
    assert await names("最終") == ["修論_最終版.pdf"]
    assert await names("report") == ["Report final.docx"]  # case-insensitive, a word of it
    assert await names("ゼミ") == ["ゼミ資料"]
    assert await names("ゼミ", kind="file") == []
    assert await names("修論", location_id=channel["id"]) == ["修論_メモ.txt"]
    assert await names("") == []
    hit = (await client.get(f"{API}/search/drive", params={"q": "最終"})).json()["items"][0]
    assert hit["location_kind"] == "workspace"
    assert [crumb["name"] for crumb in hit["path"]] == ["研究室ドライブ", "ゼミ資料"]

    # A guest: the channel's drive only. Someone else: 研究室ドライブ, not my My Drive.
    as_user(guest)
    assert await names("修論") == ["修論_メモ.txt"]
    as_user(outsider)
    assert await names("修論") == ["修論_最終版.pdf"]
    assert await names("修論", location_id=mine["id"]) == []

    # Pages by cursor.
    as_user(owner)
    first = (await client.get(f"{API}/search/drive", params={"q": "修論", "limit": 2})).json()
    assert len(first["items"]) == 2 and first["next_cursor"] == "2"
    rest = (
        await client.get(f"{API}/search/drive", params={"q": "修論", "limit": 2, "cursor": "2"})
    ).json()
    assert len(rest["items"]) == 1 and rest["next_cursor"] is None
    bad = await client.get(f"{API}/search/drive", params={"q": "修論", "cursor": "x"})
    assert bad.status_code == 400


async def test_search_uses_the_name_index(db: AsyncSession) -> None:
    from sqlalchemy import text

    from app.modules.search import repository

    statement = repository.drive_search_statement(
        "修論", [uuid.uuid4()], kind=None, limit=10, offset=0
    )
    compiled = statement.compile(compile_kwargs={"literal_binds": True})
    await db.execute(text("SET LOCAL enable_seqscan = off"))
    plan = "\n".join(row[0] for row in (await db.execute(text(f"EXPLAIN {compiled}"))).all())
    assert "drive_items_name_pgroonga_idx" in plan


# --- the upload session's file time ------------------------------------------------------------


async def test_upload_sessions_carry_the_file_time(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    member = await make_user(db, "member")
    as_user(member)
    root = await workspace_root(client)
    body = {
        "client_upload_id": str(uuid.uuid4()),
        "parent_id": root,
        "name": "t.txt",
        "size_bytes": 3,
        "content_modified_ms": 1_700_000_000_000,
    }
    made = (await client.post(f"{API}/drive/uploads", json=body)).json()
    assert made["content_modified_at"].startswith("2023-11-14T22:13:20")
    listed = (await client.get(f"{API}/drive/uploads", params={"status": "active"})).json()
    assert listed["uploads"][0]["content_modified_at"] == made["content_modified_at"]
    plain = (await start(client, root, "u.txt", 1)).json()
    assert plain["content_modified_at"] is None
