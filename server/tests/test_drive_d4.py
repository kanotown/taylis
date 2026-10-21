"""The drive's phase D4 (M163, docs/DRIVE.md §9, §23): external share links.

The threat model of §9.1 / §23.3, one test (or more) per item: the token (only its SHA-256 kept,
never in a log), expiry, revocation, the password (the unlock cookie, wrong passwords, brute
force), the creator losing access, archived channels and the switches, the subtree (ids outside
it, items moved out, the trash, other locations), the download limit (counted atomically, HEAD,
Range, previews not counted, concurrent downloads), the headers, the ZIP's names, the admins'
list, the events and their retention.
"""

import asyncio
import hashlib
import io
import logging
import uuid
import zipfile
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import redact_path
from app.core.ratelimit import RateLimiter
from app.core.time import utcnow
from app.modules.attachments.models import Attachment
from app.modules.audit.models import AuditLog
from app.modules.drive import housekeeping, shares
from app.modules.drive.models import DriveItem, DriveShareEvent, DriveShareLink
from app.modules.users.models import User
from tests.drive_helpers import (
    act_as,
    drive_settings,
    folder,
    location,
    upload,
    workspace_root,
)
from tests.helpers import make_user

API = "/api/v1"
VISITOR_IP = "203.0.113.5"


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


@pytest.fixture
async def visitor(app: FastAPI) -> AsyncIterator[AsyncClient]:
    """A browser that is not signed in (its own cookie jar), from VISITOR_IP."""
    async with visitor_client(app) as c:
        yield c


def visitor_client(app: FastAPI, ip: str = VISITOR_IP) -> AsyncClient:
    return AsyncClient(
        transport=ASGITransport(app=app, client=(ip, 40000)), base_url="http://testserver"
    )


async def share(client: AsyncClient, item_id: str, **body: Any) -> dict[str, Any]:
    made = await client.post(f"{API}/drive/items/{item_id}/links", json=body)
    assert made.status_code == 201, made.text
    out: dict[str, Any] = made.json()
    return out


def token_of(created: dict[str, Any]) -> str:
    path: str = created["path"]
    assert path.startswith("/s/")
    return path.removeprefix("/s/")


def code(response: Response) -> str:
    return str(response.json()["error"]["code"])


async def pub(c: AsyncClient, token: str, tail: str = "", **kw: Any) -> Response:
    return await c.get(f"{API}/shares/{token}{tail}", **kw)


async def link_row(db: AsyncSession, link_id: str) -> DriveShareLink:
    db.expire_all()
    row = await db.get(DriveShareLink, uuid.UUID(link_id))
    assert row is not None
    return row


async def events_of(db: AsyncSession, link_id: str) -> list[str]:
    db.expire_all()
    rows = await db.execute(
        select(DriveShareEvent.kind)
        .where(DriveShareEvent.link_id == uuid.UUID(link_id))
        .order_by(DriveShareEvent.id)
    )
    return list(rows.scalars().all())


async def lab_channel(
    client: AsyncClient, as_user: Callable[[User], None], owner: User, *members: User
) -> tuple[dict[str, Any], dict[str, Any]]:
    as_user(owner)
    lab = (await client.post(f"{API}/channels", json={"name": "lab", "type": "private"})).json()
    for person in members:
        added = await client.post(
            f"{API}/channels/{lab['id']}/members", json={"user_id": str(person.id)}
        )
        assert added.status_code == 200, added.text
    return lab, await location(client, "channel", channel_id=lab["id"])


PUBLIC_HEADERS = {
    "x-robots-tag": "noindex, nofollow, noarchive",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
}


def assert_public_headers(response: Response) -> None:
    for name, value in PUBLIC_HEADERS.items():
        assert response.headers.get(name) == value, (name, response.headers.get(name))
    assert "sandbox" in response.headers.get("content-security-policy", "")


# --- making links ------------------------------------------------------------------------------


async def test_a_link_is_a_random_token_kept_as_its_hash(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    member = await make_user(db, "mia")
    as_user(member)
    root = await workspace_root(client)
    box = await folder(client, root, "共同研究")
    report = await upload(client, box, "報告.pdf", b"%PDF-1.4 report")

    before = utcnow()
    made = await share(client, report["id"], note="〇〇大の先生")
    token = token_of(made)
    assert len(token) == 43  # 32 bytes, base64url
    assert made["url"] == made["path"]  # no PUBLIC_BASE_URL: the client adds its origin
    link = made["link"]
    assert link["state"] == "active" and link["can_edit"] and link["can_revoke"]
    assert link["item_name"] == "報告.pdf" and link["location_kind"] == "workspace"
    assert link["has_password"] is False and link["note"] == "〇〇大の先生"
    expires = datetime.fromisoformat(link["expires_at"])
    assert (
        timedelta(days=7) - timedelta(minutes=1) < expires - before < timedelta(days=7, minutes=1)
    )

    # Only the SHA-256 is stored; the token is nowhere in the database's rows of the link,
    # its audit entry, or its events.
    row = await link_row(db, link["id"])
    assert row.token_hash == hashlib.sha256(token.encode()).digest()
    audit = (
        await db.execute(select(AuditLog).where(AuditLog.action == "drive.link_created"))
    ).scalar_one()
    assert token not in str(audit.details) and audit.details["note"] == "〇〇大の先生"
    dump = (await db.execute(text("SELECT row_to_json(l)::text FROM drive_share_links l"))).scalar()
    assert token not in str(dump)

    # With PUBLIC_BASE_URL the address is absolute.
    drive_settings(app, public_base_url="https://chat.example.com/")
    absolute = await share(client, report["id"])
    assert absolute["url"] == f"https://chat.example.com{absolute['path']}"

    # The listing marks shared items, and a folder under a shared one says so.
    listed = (await client.get(f"{API}/drive/folders/{box}/children")).json()
    assert [i["link_count"] for i in listed["items"]] == [2]
    assert listed["shared_above"] == 0
    await share(client, box)
    inner = await folder(client, box, "内側")
    below = (await client.get(f"{API}/drive/folders/{inner}/children")).json()
    assert below["shared_above"] == 1

    links = (await client.get(f"{API}/drive/items/{report['id']}/links")).json()
    assert len(links["links"]) == 2
    assert links["policy"] == {
        "enabled": True,
        "location_enabled": True,
        "can_share": True,
        "max_days": 90,
        "default_days": 7,
        "password_required": False,
    }
    mine = (await client.get(f"{API}/drive/links")).json()["links"]
    assert {m["item_name"] for m in mine} == {"報告.pdf", "共同研究"}

    # The top folder of a drive cannot be shared; an item in the trash does not exist.
    top = await client.post(f"{API}/drive/items/{root}/links", json={})
    assert top.status_code == 409 and code(top) == "drive_root_immutable"
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [inner]})
    gone = await client.post(f"{API}/drive/items/{inner}/links", json={})
    assert gone.status_code == 404 and code(gone) == "drive_item_not_found"


async def test_who_may_make_links_and_the_workspace_policy(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    admin = await make_user(db, "ada", role="admin")
    owner = await make_user(db, "olivia")
    guest = await make_user(db, "gus", role="guest")
    member = await make_user(db, "mia")
    lab, drive = await lab_channel(client, as_user, owner, guest, member)
    as_user(owner)
    data = await upload(client, drive["root_id"], "data.csv", b"a,b\n1,2\n")

    # A guest of the channel reads but may not make links.
    as_user(guest)
    refused = await client.post(f"{API}/drive/items/{data['id']}/links", json={})
    assert refused.status_code == 403 and code(refused) == "guest_restricted"
    locations = (await client.get(f"{API}/drive/locations")).json()["locations"]
    assert [loc["can_share"] for loc in locations] == [False]

    # The expiry: in the future, at most the workspace's longest (90 days), never "none".
    as_user(member)
    now = datetime.now(UTC)
    for body, wanted in (
        ({"expires_at": None}, "share_link_expiry_too_long"),
        ({"expires_at": (now + timedelta(days=91)).isoformat()}, "share_link_expiry_too_long"),
        ({"expires_at": (now - timedelta(minutes=1)).isoformat()}, "validation_error"),
        ({"expires_at": "2030-01-01T00:00:00"}, "validation_error"),
    ):
        bad = await client.post(f"{API}/drive/items/{data['id']}/links", json=body)
        assert bad.status_code == 422 and code(bad) == wanted, (body, bad.text)
    ok = await share(client, data["id"], expires_at=(now + timedelta(days=90)).isoformat())
    assert ok["link"]["state"] == "active"
    too_short = await client.post(f"{API}/drive/items/{data['id']}/links", json={"password": "abc"})
    assert too_short.status_code == 422

    # Administrators change the policy (audited); members may not.
    denied = await client.patch(f"{API}/admin/drive/settings", json={"link_max_days": None})
    assert denied.status_code == 403
    as_user(admin)
    changed = await client.patch(
        f"{API}/admin/drive/settings",
        json={"link_max_days": None, "link_password_required": True},
    )
    assert changed.status_code == 200, changed.text
    assert changed.json() == {
        "external_links_enabled": True,
        "link_max_days": None,
        "link_password_required": True,
        "default_days": 7,
    }
    audit = (
        await db.execute(select(AuditLog).where(AuditLog.action == "workspace.settings_updated"))
    ).scalar_one()
    assert audit.details["drive_link_max_days"] == {"from": 90, "to": None}
    as_user(member)
    needs = await client.post(f"{API}/drive/items/{data['id']}/links", json={"expires_at": None})
    assert needs.status_code == 422 and code(needs) == "share_link_password_required"
    forever = await share(client, data["id"], expires_at=None, password="secret-1")
    assert forever["link"]["expires_at"] is None and forever["link"]["has_password"]

    # The location's switch (its owner) and the workspace's (admins): off refuses new links.
    as_user(member)
    not_owner = await client.patch(
        f"{API}/drive/locations/{drive['id']}", json={"external_links": False}
    )
    assert not_owner.status_code == 403 and code(not_owner) == "drive_manage_restricted"
    as_user(owner)
    off = await client.patch(f"{API}/drive/locations/{drive['id']}", json={"external_links": False})
    assert off.status_code == 200 and off.json()["external_links"] is False
    assert off.json()["can_share"] is False
    as_user(member)
    blocked = await client.post(
        f"{API}/drive/items/{data['id']}/links", json={"password": "secret-1"}
    )
    assert blocked.status_code == 403 and code(blocked) == "drive_links_disabled"
    as_user(owner)
    await client.patch(f"{API}/drive/locations/{drive['id']}", json={"external_links": True})
    as_user(admin)
    await client.patch(f"{API}/admin/drive/settings", json={"external_links_enabled": False})
    as_user(member)
    blocked = await client.post(
        f"{API}/drive/items/{data['id']}/links", json={"password": "secret-1"}
    )
    assert blocked.status_code == 403 and code(blocked) == "drive_links_disabled"
    policy = (await client.get(f"{API}/drive/items/{data['id']}/links")).json()["policy"]
    assert policy["enabled"] is False and policy["can_share"] is False

    # An archived channel's drive is read-only: no new links there.
    as_user(admin)
    await client.patch(f"{API}/admin/drive/settings", json={"external_links_enabled": True})
    as_user(owner)
    await client.post(f"{API}/channels/{lab['id']}/archive")
    as_user(member)
    archived = await client.post(
        f"{API}/drive/items/{data['id']}/links", json={"password": "secret-1"}
    )
    assert archived.status_code == 403 and code(archived) == "drive_read_only"


async def test_making_links_is_rate_limited(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    app.state.limiters["drive_link_create"] = RateLimiter(3)
    member = await make_user(db, "mia")
    as_user(member)
    data = await upload(client, await workspace_root(client), "a.txt", b"a")
    for _ in range(3):
        await share(client, data["id"])
    limited = await client.post(f"{API}/drive/items/{data['id']}/links", json={})
    assert limited.status_code == 429 and code(limited) == "rate_limited"


# --- the public side ------------------------------------------------------------------------------


async def test_a_file_link_downloads_with_safe_headers(
    app: FastAPI,
    client: AsyncClient,
    visitor: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
) -> None:
    drive_settings(app)
    member = await make_user(db, "mia")
    as_user(member)
    root = await workspace_root(client)
    page = b"<html><script>alert(document.cookie)</script></html>"
    evil = await upload(client, root, "悪い.html", page)
    made = await share(client, evil["id"])
    token = token_of(made)

    info = await pub(visitor, token)
    assert info.status_code == 200, info.text
    assert_public_headers(info)
    body = info.json()
    assert body["kind"] == "file" and body["unlocked"] and not body["password_required"]
    assert body["item"]["name"] == "悪い.html" and body["root_id"] == evil["id"]
    assert body["downloads_left"] is None
    assert "created_by" not in body["item"] and "location_id" not in body["item"]

    # Never inline (not even with ?inline=1, it is not an image), sandboxed, never sniffed.
    for params in ({}, {"inline": "1"}):
        got = await pub(visitor, token, f"/items/{evil['id']}/content", params=params)
        assert got.status_code == 200 and got.content == page
        assert_public_headers(got)
        assert got.headers["content-security-policy"] == "sandbox"
        disposition = got.headers["content-disposition"]
        assert disposition.startswith("attachment;")
        assert "filename*=UTF-8''%E6%82%AA%E3%81%84.html" in disposition
        assert got.headers["etag"] and got.headers["accept-ranges"] == "bytes"

    # Errors carry the same headers.
    unknown = await pub(visitor, "x" * 43)
    assert unknown.status_code == 404 and code(unknown) == "share_link_not_found"
    assert_public_headers(unknown)
    assert await events_of(db, made["link"]["id"]) == ["open", "download", "download"]
    row = await link_row(db, made["link"]["id"])
    assert row.download_count == 2 and row.last_used_at is not None


async def test_only_the_shared_subtree_is_reachable(
    app: FastAPI,
    client: AsyncClient,
    visitor: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
) -> None:
    """Every id outside the shared folder is 404, whatever it is: the parent, a sibling, the
    location's top, another location, the trash, an item moved out, an unknown id; and only the
    current version is served."""
    drive_settings(app)
    member = await make_user(db, "mia")
    as_user(member)
    root = await workspace_root(client)
    shared = await folder(client, root, "shared")
    inner = await folder(client, shared, "inner")
    inside = await upload(client, inner, "in.txt", b"inside v1")
    sibling = await folder(client, root, "sibling")
    outside = await upload(client, sibling, "out.txt", b"outside")
    binned = await upload(client, shared, "binned.txt", b"binned")
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [binned["id"]]})
    mine = await location(client, "me")
    private = await upload(client, mine["root_id"], "private.txt", b"private")
    token = token_of(await share(client, shared))

    top = (await pub(visitor, token)).json()
    assert top["kind"] == "folder" and top["item"]["name"] == "shared"
    listed = (await pub(visitor, token, f"/folders/{shared}/children")).json()
    assert [i["name"] for i in listed["items"]] == ["inner"]  # not the one in the trash
    deeper = (await pub(visitor, token, f"/folders/{inner}/children")).json()
    assert [c["name"] for c in deeper["path"]] == ["shared", "inner"]  # never above the link
    assert [i["name"] for i in deeper["items"]] == ["in.txt"]
    assert (await pub(visitor, token, f"/items/{inside['id']}/content")).content == b"inside v1"

    for foreign in (root, sibling, mine["root_id"], str(uuid.uuid4())):
        refused = await pub(visitor, token, f"/folders/{foreign}/children")
        assert refused.status_code == 404 and code(refused) == "drive_item_not_found", foreign
        zipped = await pub(visitor, token, "/zip", params={"folder_id": foreign})
        assert zipped.status_code == 404, foreign
    for foreign_file in (outside["id"], private["id"], binned["id"]):
        for tail in ("/content", "/thumbnail", "/preview/pdf", "/preview/thumbnail"):
            refused = await pub(visitor, token, f"/items/{foreign_file}{tail}")
            assert refused.status_code == 404, (foreign_file, tail, refused.text)
        head = await visitor.head(f"{API}/shares/{token}/items/{foreign_file}/content")
        assert head.status_code == 404
    # A file is not a folder to list.
    assert (await pub(visitor, token, f"/folders/{inside['id']}/children")).status_code == 404

    # Moved out of the shared folder: gone from the link; moved back: there again.
    as_user(member)
    moved = await client.post(
        f"{API}/drive/items/move", json={"item_ids": [inside["id"]], "target_folder_id": sibling}
    )
    assert moved.json()["results"][0]["ok"]
    assert (await pub(visitor, token, f"/items/{inside['id']}/content")).status_code == 404
    await client.post(
        f"{API}/drive/items/move", json={"item_ids": [inside["id"]], "target_folder_id": inner}
    )
    assert (await pub(visitor, token, f"/items/{inside['id']}/content")).status_code == 200

    # A new version replaces the old one; an old version cannot be asked for.
    v2 = await upload(client, inner, "in.txt", b"inside v2", on_conflict="version")
    assert v2["id"] == inside["id"]
    old = await pub(
        visitor, token, f"/items/{inside['id']}/content", params={"version_id": str(uuid.uuid4())}
    )
    assert old.content == b"inside v2"

    # A folder put in the trash takes what is in it along.
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [inner]})
    assert (await pub(visitor, token, f"/folders/{inner}/children")).status_code == 404
    assert (await pub(visitor, token, f"/items/{inside['id']}/content")).status_code == 404


async def test_expired_revoked_and_unknown_links(
    app: FastAPI,
    client: AsyncClient,
    visitor: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
) -> None:
    drive_settings(app)
    member = await make_user(db, "mia")
    as_user(member)
    data = await upload(client, await workspace_root(client), "a.txt", b"a")
    expiring = await share(client, data["id"])
    revoked = await share(client, data["id"])

    await db.execute(
        text(
            "UPDATE drive_share_links SET expires_at = now() - interval '1 second' WHERE id = :id"
        ),
        {"id": expiring["link"]["id"]},
    )
    await db.commit()
    gone = await pub(visitor, token_of(expiring))
    assert gone.status_code == 410 and code(gone) == "share_link_unavailable"
    content = await pub(visitor, token_of(expiring), f"/items/{data['id']}/content")
    assert content.status_code == 410

    assert (await client.delete(f"{API}/drive/links/{revoked['link']['id']}")).status_code == 204
    after = await pub(visitor, token_of(revoked), f"/items/{data['id']}/content")
    assert after.status_code == 410 and code(after) == "share_link_unavailable"
    assert (await client.delete(f"{API}/drive/links/{revoked['link']['id']}")).status_code == 404
    audit = (
        await db.execute(select(AuditLog).where(AuditLog.action == "drive.link_revoked"))
    ).scalar_one()
    assert audit.details["by_admin"] is False

    states = {
        link["id"]: link["state"]
        for link in (await client.get(f"{API}/drive/items/{data['id']}/links")).json()["links"]
    }
    assert states == {expiring["link"]["id"]: "expired"}  # revoked links are not listed
    unknown = await pub(visitor, "A" * 43)
    assert unknown.status_code == 404 and code(unknown) == "share_link_not_found"
    assert (await pub(visitor, "A" * 500)).status_code == 404


async def test_a_link_works_only_while_its_creator_can_read_the_item(
    app: FastAPI,
    client: AsyncClient,
    visitor: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
) -> None:
    """§9.2: the creator left the channel, became a guest, was deactivated; the channel was
    archived; the location's or the workspace's switch; the item in the trash or moved to another
    location. Each stops the link (410, state paused) and undoing it brings the link back."""
    drive_settings(app)
    admin = await make_user(db, "ada", role="admin")
    owner = await make_user(db, "olivia")
    member = await make_user(db, "mia")
    lab, drive = await lab_channel(client, as_user, owner, member)
    as_user(member)
    data = await upload(client, drive["root_id"], "data.csv", b"1,2\n")
    made = await share(client, data["id"])
    token = token_of(made)

    async def works() -> bool:
        got = await pub(visitor, token, f"/items/{data['id']}/content")
        assert got.status_code in (200, 410), got.text
        if got.status_code == 410:
            assert code(got) == "share_link_unavailable"
        return got.status_code == 200

    async def state() -> str:
        as_user(member)
        links = (await client.get(f"{API}/drive/links")).json()["links"]
        return str(links[0]["state"])

    async def set_user(**values: Any) -> None:
        await db.execute(update(User).where(User.id == member.id).values(**values))
        await db.commit()

    assert await works()

    # Left the channel (removed by the owner), then added again.
    as_user(owner)
    await client.delete(f"{API}/channels/{lab['id']}/members/{member.id}")
    assert not await works()
    as_user(admin)
    listed = (await client.get(f"{API}/admin/drive/links")).json()["links"]
    assert [link["state"] for link in listed] == ["paused"]
    as_user(owner)
    await client.post(f"{API}/channels/{lab['id']}/members", json={"user_id": str(member.id)})
    assert await works()

    # Became a guest (still a member of the channel), then a member again.
    await set_user(role="guest")
    assert not await works()
    await set_user(role="member")
    assert await works()

    # Deactivated, then active again.
    await set_user(deactivated_at=utcnow())
    assert not await works()
    await set_user(deactivated_at=None)
    assert await works()

    # The channel archived, then unarchived (§19 Q6).
    as_user(owner)
    assert (await client.post(f"{API}/channels/{lab['id']}/archive")).status_code == 200
    assert not await works()
    assert await state() == "paused"
    as_user(owner)
    assert (await client.post(f"{API}/channels/{lab['id']}/unarchive")).status_code == 200
    assert await works()

    # The location's switch, then the workspace's.
    as_user(owner)
    await client.patch(f"{API}/drive/locations/{drive['id']}", json={"external_links": False})
    assert not await works()
    await client.patch(f"{API}/drive/locations/{drive['id']}", json={"external_links": True})
    assert await works()
    as_user(admin)
    await client.patch(f"{API}/admin/drive/settings", json={"external_links_enabled": False})
    assert not await works()
    await client.patch(f"{API}/admin/drive/settings", json={"external_links_enabled": True})
    assert await works()

    # The item in the trash, then restored.
    as_user(member)
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [data["id"]]})
    assert not await works()
    assert (await pub(visitor, token)).status_code == 410
    await client.post(f"{API}/drive/items/{data['id']}/restore", json={})
    assert await works()

    # Moved to another location: the link stays stopped there (its switch never allowed it).
    mine = await location(client, "me")
    moved = await client.post(
        f"{API}/drive/items/move",
        json={"item_ids": [data["id"]], "target_folder_id": mine["root_id"]},
    )
    assert moved.json()["results"][0]["ok"], moved.text
    assert not await works()


async def test_the_password_and_its_unlock_cookie(
    app: FastAPI,
    client: AsyncClient,
    visitor: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
) -> None:
    drive_settings(app)
    member = await make_user(db, "mia")
    as_user(member)
    root = await workspace_root(client)
    box = await folder(client, root, "秘密")
    inside = await upload(client, box, "x.txt", b"x")
    made = await share(client, box, password="correct horse")
    other = await share(client, box, password="other pass")
    token = token_of(made)
    assert made["link"]["has_password"]

    locked = (await pub(visitor, token)).json()
    assert locked["password_required"] and not locked["unlocked"]
    assert locked["item"] is None and locked["kind"] is None and locked["root_id"] is None
    for tail in (f"/folders/{box}/children", f"/items/{inside['id']}/content", "/zip"):
        refused = await pub(visitor, token, tail)
        assert refused.status_code == 401 and code(refused) == "share_password_required", tail

    wrong = await visitor.post(f"{API}/shares/{token}/unlock", json={"password": "nope"})
    assert wrong.status_code == 401 and code(wrong) == "share_password_invalid"
    assert "set-cookie" not in wrong.headers
    right = await visitor.post(f"{API}/shares/{token}/unlock", json={"password": "correct horse"})
    assert right.status_code == 204
    cookie = right.headers["set-cookie"]
    assert cookie.startswith("taylis_share=")
    lowered = cookie.lower()
    assert "httponly" in lowered and "samesite=lax" in lowered
    assert f"path=/api/v1/shares/{token.lower()}" in lowered
    assert token not in cookie.split(";")[0]  # the value is a signature, not the token
    opened = (await pub(visitor, token)).json()
    assert opened["unlocked"] and opened["item"]["name"] == "秘密"
    assert (await pub(visitor, token, f"/items/{inside['id']}/content")).status_code == 200
    assert await events_of(db, made["link"]["id"]) == ["password_failed", "open", "download"]

    # The cookie is for this link only, and cannot be forged or altered.
    value = cookie.split(";")[0].split("=", 1)[1]
    other_token = token_of(other)
    for forged in (value, value[:-1] + ("0" if value[-1] != "0" else "1")):
        async with visitor_client(app) as fresh:
            fresh.cookies.set("taylis_share", forged, path=f"/api/v1/shares/{other_token}")
            fresh.cookies.set("taylis_share", forged[:-2] + "00", path=f"/api/v1/shares/{token}")
            assert (await pub(fresh, other_token, f"/folders/{box}/children")).status_code == 401
            assert (await pub(fresh, token, f"/folders/{box}/children")).status_code == 401

    # A new password ends the unlocked browsers; no password opens the link to everyone.
    patched = await client.patch(
        f"{API}/drive/links/{made['link']['id']}", json={"password": "new password"}
    )
    assert patched.status_code == 200
    assert (await pub(visitor, token, f"/folders/{box}/children")).status_code == 401
    await client.patch(f"{API}/drive/links/{made['link']['id']}", json={"password": None})
    async with visitor_client(app) as fresh:
        assert (await pub(fresh, token, f"/folders/{box}/children")).status_code == 200
    updated = (
        await db.execute(select(AuditLog).where(AuditLog.action == "drive.link_updated"))
    ).scalars()
    assert [a.details["password_changed"] for a in updated] == [True, True]


async def test_passwords_cannot_be_guessed_quickly(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
) -> None:
    """10 tries per link in 10 minutes (then even the right password waits), 20 a minute from one
    address across links."""
    drive_settings(app)
    member = await make_user(db, "mia")
    as_user(member)
    data = await upload(client, await workspace_root(client), "a.txt", b"a")
    links = [token_of(await share(client, data["id"], password="right pass")) for _ in range(3)]

    async with visitor_client(app, "198.51.100.1") as one:
        for _ in range(10):
            tried = await one.post(f"{API}/shares/{links[0]}/unlock", json={"password": "guess"})
            assert tried.status_code == 401
        late = await one.post(f"{API}/shares/{links[0]}/unlock", json={"password": "right pass"})
        assert late.status_code == 429 and code(late) == "rate_limited"
    # The limit is the link's: another address waits too.
    async with visitor_client(app, "198.51.100.2") as two:
        blocked = await two.post(f"{API}/shares/{links[0]}/unlock", json={"password": "right pass"})
        assert blocked.status_code == 429
        # The address' limit: 20 a minute over every link.
        for _ in range(10):
            await two.post(f"{API}/shares/{links[1]}/unlock", json={"password": "guess"})
        for _ in range(10):
            await two.post(f"{API}/shares/{links[2]}/unlock", json={"password": "guess"})
        over = await two.post(f"{API}/shares/{links[2]}/unlock", json={"password": "right pass"})
        assert over.status_code == 429
    rows = (
        await db.execute(select(DriveShareEvent.kind).where(DriveShareEvent.kind == "refused"))
    ).all()
    assert len(rows) >= 3


async def test_unknown_tokens_are_slowed_down_without_an_oracle(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    member = await make_user(db, "mia")
    as_user(member)
    data = await upload(client, await workspace_root(client), "a.txt", b"a")
    token = token_of(await share(client, data["id"]))
    async with visitor_client(app, "198.51.100.7") as guesser:
        for n in range(20):
            missed = await pub(guesser, f"guess-{n:040d}")
            assert missed.status_code == 404
        assert (await pub(guesser, "guess-again")).status_code == 429
        # Even the right token is refused now: a 429 says nothing about a token.
        assert (await pub(guesser, token)).status_code == 429
    async with visitor_client(app, "198.51.100.8") as someone_else:
        assert (await pub(someone_else, token)).status_code == 200


async def test_every_public_request_is_rate_limited_per_address(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    app.state.limiters["share_ip"] = RateLimiter(5)
    member = await make_user(db, "mia")
    as_user(member)
    data = await upload(client, await workspace_root(client), "a.txt", b"a")
    token = token_of(await share(client, data["id"]))
    async with visitor_client(app) as v:
        for _ in range(5):
            assert (await pub(v, token)).status_code == 200
        assert (await pub(v, token)).status_code == 429


# --- the download limit --------------------------------------------------------------------------


async def test_the_download_limit_counts_downloads_only(
    app: FastAPI,
    client: AsyncClient,
    visitor: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
) -> None:
    """Listings, thumbnails, previews and HEAD are free; a download from byte 0 counts; a resumed
    range counts unless this address already downloaded this version; at the limit 410."""
    drive_settings(app)
    member = await make_user(db, "mia")
    as_user(member)
    box = await folder(client, await workspace_root(client), "box")
    body = bytes(range(256)) * 4
    doc = await upload(client, box, "doc.pdf", body)
    attachment_id = uuid.UUID(doc["file"]["attachment_id"])
    await app.state.blobs.put("thumbs/doc", b"jpeg", "image/jpeg")
    row = await db.get(Attachment, attachment_id)
    assert row is not None
    row.thumbnail_key = "thumbs/doc"
    row.preview_status = "ready"
    await db.commit()
    made = await share(client, box, max_downloads=3)
    token = token_of(made)

    async def count() -> int:
        return (await link_row(db, made["link"]["id"])).download_count

    assert (await pub(visitor, token)).json()["downloads_left"] == 3
    assert (await pub(visitor, token, f"/folders/{box}/children")).status_code == 200
    assert (await pub(visitor, token, f"/items/{doc['id']}/thumbnail")).content == b"jpeg"
    pdf = await pub(visitor, token, f"/items/{doc['id']}/preview/pdf")
    assert pdf.status_code == 200 and pdf.content == body
    assert pdf.headers["content-disposition"].startswith("inline;")
    assert pdf.headers["content-security-policy"] == "sandbox"
    head = await visitor.head(f"{API}/shares/{token}/items/{doc['id']}/content")
    assert head.status_code == 200 and head.headers["content-length"] == str(len(body))
    assert head.content == b""
    assert await count() == 0

    first = await pub(
        visitor, token, f"/items/{doc['id']}/content", headers={"Range": "bytes=0-99"}
    )
    assert first.status_code == 206 and first.content == body[:100]
    assert first.headers["content-range"] == f"bytes 0-99/{len(body)}"
    assert await count() == 1
    # The rest, resumed from the same address: not counted again.
    rest = await pub(visitor, token, f"/items/{doc['id']}/content", headers={"Range": "bytes=100-"})
    assert rest.status_code == 206 and rest.content == body[100:]
    assert await count() == 1
    # A range from the middle by someone who never downloaded it counts.
    async with visitor_client(app, "198.51.100.20") as other:
        middle = await pub(
            other, token, f"/items/{doc['id']}/content", headers={"Range": "bytes=500-"}
        )
        assert middle.status_code == 206
    assert await count() == 2
    past = await pub(
        visitor, token, f"/items/{doc['id']}/content", headers={"Range": "bytes=9999-"}
    )
    assert past.status_code == 416 and await count() == 2

    whole = await pub(visitor, token, f"/items/{doc['id']}/content")
    assert whole.status_code == 200 and await count() == 3
    used_up = await pub(visitor, token, f"/items/{doc['id']}/content")
    assert used_up.status_code == 410 and code(used_up) == "share_link_unavailable"
    assert (await pub(visitor, token)).status_code == 410  # everything stops at the limit
    links = (await client.get(f"{API}/drive/links")).json()["links"]
    assert links[0]["state"] == "exhausted"
    kinds = await events_of(db, made["link"]["id"])
    assert kinds.count("download") == 3 and "refused" in kinds


async def test_concurrent_downloads_never_pass_the_limit(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    member = await make_user(db, "mia")
    as_user(member)
    data = await upload(client, await workspace_root(client), "a.bin", b"z" * 2000)
    made = await share(client, data["id"], max_downloads=3)
    token = token_of(made)

    async def one(n: int) -> int:
        async with visitor_client(app, f"198.51.100.{n + 30}") as v:
            got = await pub(v, token, f"/items/{data['id']}/content")
            return got.status_code

    results = await asyncio.gather(*(one(n) for n in range(10)))
    assert sorted(results) == [200] * 3 + [410] * 7
    assert (await link_row(db, made["link"]["id"])).download_count == 3


async def test_a_folder_link_zips_safely_and_counts_once(
    app: FastAPI,
    client: AsyncClient,
    visitor: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
) -> None:
    drive_settings(app)
    member = await make_user(db, "mia")
    as_user(member)
    root = await workspace_root(client)
    box = await folder(client, root, "ゼミ資料")
    sub = await folder(client, box, "sub")
    await folder(client, box, "空")
    a = await upload(client, box, "a.txt", b"aaa")
    b = await upload(client, sub, "b.txt", b"bbbb")
    # Names a ZIP must never carry as paths (made outside the API's checks: a migrated file).
    for item_id, raw in ((a["id"], "../../etc/passwd"), (b["id"], "..\\..\\evil.bat")):
        await db.execute(
            text("UPDATE drive_items SET name = :n WHERE id = :id"), {"n": raw, "id": item_id}
        )
    await db.commit()
    made = await share(client, box, max_downloads=2)
    token = token_of(made)

    got = await pub(visitor, token, "/zip")
    assert got.status_code == 200, got.text
    assert_public_headers(got)
    assert got.headers["content-type"] == "application/zip"
    assert got.headers["content-length"] == str(len(got.content))
    assert "%E3%82%BC%E3%83%9F%E8%B3%87%E6%96%99.zip" in got.headers["content-disposition"]
    names = zipfile.ZipFile(io.BytesIO(got.content)).namelist()
    for name in names:
        parts = name.rstrip("/").split("/")
        assert ".." not in parts and "\\" not in name and not name.startswith("/"), name
    assert "ゼミ資料/空/" in names and "ゼミ資料/sub/" in names
    archive = zipfile.ZipFile(io.BytesIO(got.content))
    contents = sorted(archive.read(n) for n in names if not n.endswith("/"))
    assert contents == [b"aaa", b"bbbb"]
    assert (await link_row(db, made["link"]["id"])).download_count == 1

    # A folder under the link; a file link has no ZIP.
    part = await pub(visitor, token, "/zip", params={"folder_id": sub})
    assert part.status_code == 200
    assert zipfile.ZipFile(io.BytesIO(part.content)).namelist()[0] == "sub/"
    used_up = await pub(visitor, token, "/zip")
    assert used_up.status_code == 410
    file_token = token_of(await share(client, a["id"]))
    assert (await pub(visitor, file_token, "/zip")).status_code == 404
    assert await events_of(db, made["link"]["id"]) == ["zip", "zip", "refused"]


# --- logs, admins, events ------------------------------------------------------------------------


async def test_tokens_never_reach_the_logs(
    app: FastAPI,
    client: AsyncClient,
    visitor: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
) -> None:
    drive_settings(app)
    member = await make_user(db, "mia")
    as_user(member)
    box = await folder(client, await workspace_root(client), "box")
    data = await upload(client, box, "a.txt", b"a")
    token = token_of(await share(client, box, password="pass word"))

    records: list[logging.LogRecord] = []

    class Keep(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    keep = Keep(level=logging.DEBUG)
    loggers = [logging.getLogger(), logging.getLogger("app.access")]
    for logger in loggers:
        logger.addHandler(keep)
    old = loggers[0].level
    loggers[0].setLevel(logging.DEBUG)
    # Alembic's fileConfig (the test database's migration) disables the loggers made before it.
    was_disabled = loggers[1].disabled
    loggers[1].disabled = False
    try:
        await pub(visitor, token)
        await visitor.post(f"{API}/shares/{token}/unlock", json={"password": "wrong"})
        await visitor.post(f"{API}/shares/{token}/unlock", json={"password": "pass word"})
        await pub(visitor, token, f"/folders/{box}/children")
        await pub(visitor, token, f"/items/{data['id']}/content")
        await pub(visitor, token, "/zip")
        await pub(visitor, token, f"/items/{uuid.uuid4()}/content")
    finally:
        for logger in loggers:
            logger.removeHandler(keep)
        loggers[0].setLevel(old)
        loggers[1].disabled = was_disabled
    access = [r for r in records if r.name == "app.access"]
    assert len(access) >= 7
    for record in records:
        text_of = f"{record.getMessage()} {vars(record)}"
        assert token not in text_of, text_of
        assert "pass word" not in text_of
    assert any(getattr(r, "path", "").startswith("/api/v1/shares/***/") for r in access)
    assert redact_path(f"/s/{token}") == "/s/***"
    assert redact_path(f"/api/v1/shares/{token}/zip") == "/api/v1/shares/***/zip"


async def test_admins_see_every_link_and_events_are_kept_180_days(
    app: FastAPI,
    client: AsyncClient,
    visitor: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
) -> None:
    drive_settings(app)
    admin = await make_user(db, "ada", role="admin")
    owner = await make_user(db, "olivia")
    member = await make_user(db, "mia")
    other = await make_user(db, "otto")
    member_id = member.id
    _, drive = await lab_channel(client, as_user, owner, member, other)
    as_user(member)
    data = await upload(client, drive["root_id"], "data.csv", b"1")
    mine = await location(client, "me")
    private = await upload(client, mine["root_id"], "私.txt", b"p")
    channel_link = await share(client, data["id"], note="for X")
    private_link = await share(client, private["id"])
    await pub(visitor, token_of(channel_link))
    await pub(visitor, token_of(channel_link), f"/items/{data['id']}/content")

    # Another member sees only their own links of the item, cannot revoke or read the events.
    as_user(other)
    assert (await client.get(f"{API}/drive/items/{data['id']}/links")).json()["links"] == []
    assert (
        await client.delete(f"{API}/drive/links/{channel_link['link']['id']}")
    ).status_code == 404
    assert (
        await client.get(f"{API}/drive/links/{channel_link['link']['id']}/events")
    ).status_code == 404
    assert (await client.get(f"{API}/admin/drive/links")).status_code == 403

    # The creator sees the events with the address cut short.
    as_user(member)
    seen = (await client.get(f"{API}/drive/links/{channel_link['link']['id']}/events")).json()
    assert [e["kind"] for e in seen["events"]] == ["download", "open"]
    assert {e["ip"] for e in seen["events"]} == {"203.0.x.x"}
    assert seen["events"][0]["item_name"] == "data.csv"

    # The channel's owner sees every link of the item and may revoke it.
    as_user(owner)
    listed = (await client.get(f"{API}/drive/items/{data['id']}/links")).json()["links"]
    assert [(lk["id"], lk["can_edit"], lk["can_revoke"]) for lk in listed] == [
        (channel_link["link"]["id"], False, True)
    ]

    # Administrators: every link with names (a My Drive's owner too), full addresses, revoke.
    as_user(admin)
    every = (await client.get(f"{API}/admin/drive/links")).json()["links"]
    by_item = {lk["item_name"]: lk for lk in every}
    assert set(by_item) == {"data.csv", "私.txt"}
    assert by_item["私.txt"]["location_name"] == "マイドライブ（Mia）"
    assert by_item["data.csv"]["location_name"] == "lab" and by_item["data.csv"]["note"] == "for X"
    assert by_item["data.csv"]["created_by_name"] == "Mia"
    full = (await client.get(f"{API}/drive/links/{channel_link['link']['id']}/events")).json()
    assert {e["ip"] for e in full["events"]} == {VISITOR_IP}
    revoked = await client.delete(f"{API}/admin/drive/links/{private_link['link']['id']}")
    assert revoked.status_code == 204
    audit = (
        await db.execute(select(AuditLog).where(AuditLog.action == "drive.link_revoked"))
    ).scalar_one()
    assert audit.details["by_admin"] is True
    assert (await pub(visitor, token_of(private_link))).status_code == 410

    # Events older than 180 days go with the housekeeping.
    await db.execute(
        text(
            "UPDATE drive_share_events SET created_at = now() - interval '181 days' "
            "WHERE kind = 'open'"
        )
    )
    await db.commit()
    done = await housekeeping.run(app.state.drive, app.state.settings, app.state.blobs)
    assert done.share_events_pruned == 1
    assert await events_of(db, channel_link["link"]["id"]) == ["download"]

    # Anonymising the creator revokes their links for good.
    anonymised = await client.post(f"{API}/admin/users/{member_id}/anonymize")
    assert anonymised.status_code in (200, 204), anonymised.text
    db.expire_all()
    rows = (await db.execute(select(DriveShareLink))).scalars().all()
    assert all(row.revoked_at is not None for row in rows)


async def test_link_changes_by_their_creator(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    member = await make_user(db, "mia")
    other = await make_user(db, "otto")
    as_user(member)
    data = await upload(client, await workspace_root(client), "a.txt", b"a")
    made = await share(client, data["id"])
    link_id = made["link"]["id"]
    later = (datetime.now(UTC) + timedelta(days=30)).replace(microsecond=0)
    patched = await client.patch(
        f"{API}/drive/links/{link_id}",
        json={"expires_at": later.isoformat(), "max_downloads": 5, "note": "B 先生"},
    )
    assert patched.status_code == 200, patched.text
    out = patched.json()
    assert out["max_downloads"] == 5 and out["note"] == "B 先生"
    assert datetime.fromisoformat(out["expires_at"]) == later
    too_far = await client.patch(
        f"{API}/drive/links/{link_id}",
        json={"expires_at": (datetime.now(UTC) + timedelta(days=200)).isoformat()},
    )
    assert too_far.status_code == 422
    as_user(other)
    assert (
        await client.patch(f"{API}/drive/links/{link_id}", json={"note": "mine now"})
    ).status_code == 404
    entry = (
        await db.execute(select(AuditLog).where(AuditLog.action == "drive.link_updated"))
    ).scalar_one()
    assert entry.details["to"]["max_downloads"] == 5 and entry.details["from"]["note"] is None
    assert shares.mask_ip("2001:db8::1") == "2001:db8:x:x:x:x:x:x"
    assert shares.mask_ip("not an ip") is None


async def test_purging_an_item_takes_its_links_and_events(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    admin = await make_user(db, "ada", role="admin")
    member = await make_user(db, "mia")
    as_user(member)
    data = await upload(client, await workspace_root(client), "a.txt", b"a")
    made = await share(client, data["id"])
    async with visitor_client(app) as v:
        await pub(v, token_of(made))
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [data["id"]]})
    as_user(admin)
    assert (await client.delete(f"{API}/drive/items/{data['id']}")).status_code == 204
    assert (await db.execute(text("SELECT count(*) FROM drive_share_links"))).scalar_one() == 0
    assert (await db.execute(text("SELECT count(*) FROM drive_share_events"))).scalar_one() == 0
    assert await db.get(DriveItem, uuid.UUID(data["id"])) is None
    async with visitor_client(app) as v:
        assert (await pub(v, token_of(made))).status_code == 404
