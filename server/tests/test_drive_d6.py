"""The drive's phase D6 (M165, docs/DRIVE.md §13, §25): the drive and the conversations — a drive
file copied as a message attachment (who may, the limit, what the message's readers get), a
message attachment saved into a drive (an attachment I cannot read, a folder I cannot write, names,
the same request again, independence from the message), the reach of a link (how many members of a
conversation cannot read an item), and the item's location kind for the `/d/<id>` card."""

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.attachments.models import Attachment
from app.modules.drive.models import DriveFileVersion
from app.modules.users.models import User
from tests.drive_helpers import act_as, drive_settings, folder, location, upload, workspace_root
from tests.helpers import make_user

API = "/api/v1"
PDF = b"%PDF-1.4\n" + b"x" * 3000


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


async def channel_with(
    client: AsyncClient, name: str, members: list[User], kind: str = "private"
) -> dict[str, Any]:
    made = await client.post(f"{API}/channels", json={"name": name, "type": kind})
    assert made.status_code == 201, made.text
    channel: dict[str, Any] = made.json()
    for person in members:
        added = await client.post(
            f"{API}/channels/{channel['id']}/members", json={"user_id": str(person.id)}
        )
        assert added.status_code == 200, added.text
    return channel


async def post_with_file(
    client: AsyncClient, channel_id: str, name: str, data: bytes
) -> tuple[dict[str, Any], str]:
    uploaded = await client.post(
        f"{API}/attachments", files={"file": (name, data, "application/octet-stream")}
    )
    assert uploaded.status_code == 201, uploaded.text
    attachment_id = str(uploaded.json()["id"])
    sent = await client.post(
        f"{API}/channels/{channel_id}/messages",
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": "file",
            "attachment_ids": [attachment_id],
        },
    )
    assert sent.status_code == 201, sent.text
    return sent.json(), attachment_id


async def save(client: AsyncClient, attachment_id: str, folder_id: str, **extra: Any) -> Any:
    return await client.post(
        f"{API}/drive/save-attachment",
        json={"attachment_id": attachment_id, "folder_id": folder_id, **extra},
    )


# --- a drive file as a copy -----------------------------------------------------------------------


async def test_attach_copy_makes_a_pending_attachment_the_message_readers_get(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    guest = await make_user(db, "gus", role="guest")
    as_user(alice)
    lab = await channel_with(client, "lab", [guest])
    item = await upload(client, await workspace_root(client), "修論_最終.pdf", PDF)

    copied = await client.post(f"{API}/drive/items/{item['id']}/attach-copy")
    assert copied.status_code == 201, copied.text
    attachment = copied.json()
    assert attachment["filename"] == "修論_最終.pdf"
    assert attachment["size_bytes"] == len(PDF)
    row = await db.get(Attachment, uuid.UUID(attachment["id"]))
    assert row is not None and row.status == "pending" and row.drive_item_id is None
    assert row.uploader_id == alice.id and row.storage_key != f"attachments/{item['id']}"

    sent = await client.post(
        f"{API}/channels/{lab['id']}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "copy", "attachment_ids": [str(row.id)]},
    )
    assert sent.status_code == 201, sent.text

    # The guest cannot read 研究室ドライブ, but reads the copy like any attachment.
    as_user(guest)
    assert (await client.get(f"{API}/drive/items/{item['id']}")).status_code == 404
    got = await client.get(f"{API}/attachments/{attachment['id']}/content")
    assert got.status_code == 200 and got.content == PDF

    # A later version of the drive file does not change the copy that was sent.
    as_user(alice)
    await upload(
        client, await workspace_root(client), "修論_最終.pdf", PDF + b"v2", on_conflict="version"
    )
    as_user(guest)
    again = await client.get(f"{API}/attachments/{attachment['id']}/content")
    assert again.content == PDF


async def test_attach_copy_refuses_what_cannot_be_read_folders_and_large_files(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app, attachment_max_bytes=2000)
    alice = await make_user(db, "alice")
    guest = await make_user(db, "gus", role="guest")
    as_user(alice)
    root = await workspace_root(client)
    small = await upload(client, root, "a.txt", b"hello")
    large = await upload(client, root, "big.bin", b"z" * 2001)
    papers = await folder(client, root, "論文")

    as_user(guest)
    refused = await client.post(f"{API}/drive/items/{small['id']}/attach-copy")
    assert refused.status_code == 404
    assert refused.json()["error"]["code"] == "drive_item_not_found"

    as_user(alice)
    too_large = await client.post(f"{API}/drive/items/{large['id']}/attach-copy")
    assert too_large.status_code == 413
    assert too_large.json()["error"]["code"] == "attachment_too_large"
    assert (await client.post(f"{API}/drive/items/{papers}/attach-copy")).status_code == 404
    trashed = await client.post(f"{API}/drive/items/trash", json={"item_ids": [small["id"]]})
    assert trashed.status_code == 200
    assert (await client.post(f"{API}/drive/items/{small['id']}/attach-copy")).status_code == 404


# --- saving an attachment -------------------------------------------------------------------------


async def test_save_attachment_copies_it_into_a_folder(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    lab = await channel_with(client, "lab", [bob])
    message, attachment_id = await post_with_file(client, lab["id"], "議事録.txt", b"minutes")

    as_user(bob)
    target = await folder(client, await workspace_root(client), "資料")
    op = str(uuid.uuid4())
    saved = await save(client, attachment_id, target, client_op_id=op)
    assert saved.status_code == 201, saved.text
    item = saved.json()
    assert item["name"] == "議事録.txt" and item["size_bytes"] == len(b"minutes")
    assert item["created_by"] == str(bob.id) and item["parent_id"] == target
    version = (
        await db.execute(
            select(DriveFileVersion).where(DriveFileVersion.item_id == uuid.UUID(item["id"]))
        )
    ).scalar_one()
    assert version.source == "attachment" and version.number == 1
    assert version.attachment_id != uuid.UUID(attachment_id)
    content = await client.get(f"{API}/drive/items/{item['id']}/content")
    assert content.status_code == 200 and content.content == b"minutes"

    # The same request again answers the same file; the location counted it once.
    again = await save(client, attachment_id, target, client_op_id=op)
    assert again.status_code == 200 and again.json()["id"] == item["id"]
    locations = (await client.get(f"{API}/drive/locations")).json()["locations"]
    workspace = next(loc for loc in locations if loc["kind"] == "workspace")
    assert workspace["used_bytes"] == len(b"minutes")

    # Names: renamed by default, refused with `fail`, a name of my own.
    second = await save(client, attachment_id, target)
    assert second.status_code == 201 and second.json()["name"] == "議事録 (1).txt"
    taken = await save(client, attachment_id, target, on_conflict="fail")
    assert taken.status_code == 409 and taken.json()["error"]["code"] == "drive_name_taken"
    named = await save(client, attachment_id, target, name="  第3回.txt ")
    assert named.status_code == 201 and named.json()["name"] == "第3回.txt"
    bad = await save(client, attachment_id, target, name="a/b")
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "drive_name_invalid"

    # Independent of the message from then on.
    as_user(alice)
    assert (await client.delete(f"{API}/messages/{message['id']}")).status_code == 200
    as_user(bob)
    kept = await client.get(f"{API}/drive/items/{item['id']}/content")
    assert kept.status_code == 200 and kept.content == b"minutes"


async def test_save_attachment_needs_a_readable_attachment_and_a_writable_folder(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    guest = await make_user(db, "gus", role="guest")
    as_user(alice)
    secret = await channel_with(client, "secret", [bob, guest])
    _, attachment_id = await post_with_file(client, secret["id"], "a.txt", b"secret")
    pending = (
        await client.post(f"{API}/attachments", files={"file": ("p.txt", b"pending", "text/plain")})
    ).json()["id"]
    root = await workspace_root(client)
    drive_file = await upload(client, root, "d.txt", b"drive")
    drive_attachment = drive_file["file"]["attachment_id"]

    # An attachment I cannot read (not in the private channel): it does not exist for me.
    as_user(carol)
    unreadable = await save(client, attachment_id, await workspace_root(client))
    assert unreadable.status_code == 404
    assert unreadable.json()["error"]["code"] == "attachment_not_found"
    as_user(alice)
    # A pending upload and a drive file's version are not conversation attachments.
    for other in (pending, drive_attachment):
        refused = await save(client, other, root)
        assert refused.status_code == 404, refused.text
        assert refused.json()["error"]["code"] == "attachment_not_found"

    # A folder I cannot write: a guest and 研究室ドライブ (not readable: 404), an owners-only
    # channel's drive (403 drive_read_only), an archived channel's drive, a file as the target.
    as_user(guest)
    assert (await save(client, attachment_id, root)).json()["error"]["code"] == (
        "drive_item_not_found"
    )
    as_user(alice)
    secret_drive = await location(client, "channel", channel_id=secret["id"])
    await client.patch(f"{API}/channels/{secret['id']}", json={"posting_policy": "owners"})
    as_user(bob)
    read_only = await save(client, attachment_id, secret_drive["root_id"])
    assert read_only.status_code == 403
    assert read_only.json()["error"]["code"] == "drive_read_only"
    as_user(alice)
    await client.patch(f"{API}/channels/{secret['id']}", json={"posting_policy": "everyone"})
    as_user(bob)
    assert (await save(client, attachment_id, secret_drive["root_id"])).status_code == 201
    as_user(alice)
    assert (await client.post(f"{API}/channels/{secret['id']}/archive")).status_code == 200
    as_user(bob)
    archived = await save(client, attachment_id, secret_drive["root_id"])
    assert archived.status_code == 403
    assert archived.json()["error"]["code"] == "drive_read_only"
    not_a_folder = await save(client, attachment_id, drive_file["id"])
    assert not_a_folder.status_code == 404


async def test_save_attachment_respects_the_quota(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app, drive_total_quota_bytes=10)
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await channel_with(client, "lab", [])
    _, attachment_id = await post_with_file(client, lab["id"], "a.txt", b"more than ten bytes")
    full = await save(client, attachment_id, await workspace_root(client))
    assert full.status_code == 409 and full.json()["error"]["code"] == "drive_quota_exceeded"
    # No copy was made (the posted file itself is in the channel's drive, CF1: over the quota
    # too, since posting is never refused).
    rows = await db.execute(
        select(Attachment).where(
            Attachment.drive_item_id.is_not(None), Attachment.drive_state.is_(None)
        )
    )
    assert rows.scalars().all() == []


# --- reach ----------------------------------------------------------------------------------------


async def test_reach_counts_the_members_who_cannot_read_the_item(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """研究室ドライブ: the guests; its own channel's drive: nobody; another channel's: those not in
    it; a My Drive: everyone else. Bots and deactivated members are not counted."""
    drive_settings(app)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    guest = await make_user(db, "gus", role="guest")
    bot = await make_user(db, "helper", role="bot")
    gone = await make_user(db, "gone")
    outsider = await make_user(db, "olga")
    as_user(alice)
    lab = await channel_with(client, "lab", [bob, guest, bot, gone])
    other = await channel_with(client, "other", [outsider])
    gone.deactivated_at = utcnow()
    await db.commit()

    workspace_file = await upload(client, await workspace_root(client), "w.txt", b"w")
    lab_drive = await location(client, "channel", channel_id=lab["id"])
    lab_file = await upload(client, lab_drive["root_id"], "l.txt", b"l")
    other_drive = await location(client, "channel", channel_id=other["id"])
    other_file = await upload(client, other_drive["root_id"], "o.txt", b"o")
    mine = await location(client, "me")
    my_file = await upload(client, mine["root_id"], "m.txt", b"m")

    async def reach(item_id: str, channel_id: str = lab["id"]) -> Any:
        response = await client.get(
            f"{API}/drive/items/{item_id}/reach", params={"channel_id": channel_id}
        )
        assert response.status_code == 200, response.text
        return response.json()

    # lab: alice, bob, the guest (the bot and the deactivated member are left out).
    assert await reach(workspace_file["id"]) == {"readable": 2, "unreadable": 1}
    assert await reach(lab_file["id"]) == {"readable": 3, "unreadable": 0}
    assert await reach(other_file["id"]) == {"readable": 1, "unreadable": 2}
    assert await reach(my_file["id"]) == {"readable": 1, "unreadable": 2}
    assert await reach(lab_file["id"], other["id"]) == {"readable": 1, "unreadable": 1}

    # A conversation I am not in, an item I cannot read.
    as_user(bob)
    not_member = await client.get(
        f"{API}/drive/items/{workspace_file['id']}/reach", params={"channel_id": other["id"]}
    )
    assert not_member.status_code == 403
    unreadable = await client.get(
        f"{API}/drive/items/{my_file['id']}/reach", params={"channel_id": lab["id"]}
    )
    assert unreadable.status_code == 404
    assert unreadable.json()["error"]["code"] == "drive_item_not_found"


async def test_an_item_names_its_location_kind_for_the_card(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    guest = await make_user(db, "gus", role="guest")
    as_user(alice)
    item = await upload(client, await workspace_root(client), "w.txt", b"w")
    detail = (await client.get(f"{API}/drive/items/{item['id']}")).json()
    assert detail["location_kind"] == "workspace"
    assert detail["path"][0]["name"] == "研究室ドライブ"
    as_user(guest)
    hidden = await client.get(f"{API}/drive/items/{item['id']}")
    assert hidden.status_code == 404 and "w.txt" not in hidden.text
