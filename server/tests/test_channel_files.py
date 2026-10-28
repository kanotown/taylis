"""CF1 (docs/CHANNEL_FILES.md): files posted in a public or private channel live in the channel's
drive — filed when sent (one row, one object), with the send never failing because of the drive;
who reads them (the drive's rule, or the message's while the file is in that channel's drive); the
posted version kept; the drive's moves, trash, restores and purges told to the message; a
message's delete with drive_files; the quota counted once; the impact of a move or a trash; the
switches; the search; the backfill of earlier attachments; and the old clients' view."""

import asyncio
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import MemoryBlobStore
from app.modules.attachments.models import Attachment
from app.modules.audit.models import AuditLog
from app.modules.drive import channel_files, names, versions
from app.modules.drive import events as drive_events
from app.modules.drive.models import DriveFileVersion, DriveItem, DriveLocation
from app.modules.messages.models import Message
from app.modules.users.models import User
from tests.drive_helpers import act_as, drive_settings, folder, location, upload, workspace_root
from tests.helpers import make_user

API = "/api/v1"
PDF = b"%PDF-1.4\n" + b"x" * 3000
JST = ZoneInfo("Asia/Tokyo")


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


async def make_channel(
    client: AsyncClient, name: str, members: list[User], kind: str = "public"
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


async def upload_file(client: AsyncClient, name: str, data: bytes) -> str:
    uploaded = await client.post(
        f"{API}/attachments", files={"file": (name, data, "application/octet-stream")}
    )
    assert uploaded.status_code == 201, uploaded.text
    return str(uploaded.json()["id"])


async def post(
    client: AsyncClient,
    channel_id: str,
    files: list[tuple[str, bytes]],
    *,
    parent_id: str | None = None,
    client_msg_id: str | None = None,
) -> dict[str, Any]:
    ids = [await upload_file(client, name, data) for name, data in files]
    body: dict[str, Any] = {
        "client_msg_id": client_msg_id or str(uuid.uuid4()),
        "body": "files",
        "attachment_ids": ids,
    }
    if parent_id is not None:
        body["parent_id"] = parent_id
    sent = await client.post(f"{API}/channels/{channel_id}/messages", json=body)
    assert sent.status_code in (200, 201), sent.text
    message: dict[str, Any] = sent.json()
    return message


async def message_in(client: AsyncClient, channel_id: str, message_id: str) -> dict[str, Any]:
    history = await client.get(f"{API}/channels/{channel_id}/messages")
    assert history.status_code == 200, history.text
    found = [m for m in history.json()["messages"] if m["id"] == message_id]
    if not found:  # a thread reply
        replies = await client.get(f"{API}/messages/{message_id}")
        assert replies.status_code == 200, replies.text
        return dict(replies.json())
    return dict(found[0])


async def row(db: AsyncSession, attachment_id: str) -> Attachment:
    found = (
        await db.execute(
            select(Attachment)
            .where(Attachment.id == uuid.UUID(attachment_id))
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    return found


async def item_row(db: AsyncSession, item_id: str | uuid.UUID) -> DriveItem | None:
    return (
        await db.execute(
            select(DriveItem)
            .where(DriveItem.id == uuid.UUID(str(item_id)))
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


async def channel_location(db: AsyncSession, channel_id: str) -> DriveLocation:
    found = (
        await db.execute(
            select(DriveLocation)
            .where(DriveLocation.channel_id == uuid.UUID(channel_id))
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    return found


def expected_month(at: datetime) -> str:
    return at.astimezone(JST).strftime("%Y-%m")


async def set_workspace_switch(db: AsyncSession, on: bool) -> None:
    await db.execute(text("UPDATE workspace_settings SET channel_files_to_drive = :on"), {"on": on})
    await db.commit()


# --- filing -------------------------------------------------------------------------------------


async def test_a_posted_file_becomes_version_1_of_an_item_in_the_month_folder(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    message = await post(client, lab["id"], [("修論.pdf", PDF), ("data.csv", b"a,b\n1,2\n")])
    shown = message["attachments"]
    assert [a["filename"] for a in shown] == ["修論.pdf", "data.csv"]
    first = await row(db, shown[0]["id"])
    assert first.message_id == uuid.UUID(message["id"]) and first.drive_state == "available"
    assert first.drive_item_id is not None and first.attached_at is not None
    assert shown[0]["drive"] == {
        "item_id": str(first.drive_item_id),
        "version_id": shown[0]["drive"]["version_id"],
        "version_number": 1,
        "state": "available",
    }
    # One row, one object: the item's version 1 is the attachment itself.
    version = (
        await db.execute(
            select(DriveFileVersion).where(DriveFileVersion.item_id == first.drive_item_id)
        )
    ).scalar_one()
    assert version.attachment_id == first.id and version.number == 1
    assert version.source == "message" and version.uploaded_by == alice.id
    assert version.sha256 == first.sha256 and version.processed_at is not None
    assert str(version.id) == shown[0]["drive"]["version_id"]

    # 「投稿のファイル」 at the root (system_role), the month folder under it.
    drive = await location(client, "channel", channel_id=lab["id"])
    root_children = (await client.get(f"{API}/drive/folders/{drive['root_id']}/children")).json()
    posts = next(i for i in root_children["items"] if i["system_role"] == "channel_posts")
    assert posts["name"] == channel_files.POSTS_FOLDER_NAME
    months = (await client.get(f"{API}/drive/folders/{posts['id']}/children")).json()["items"]
    assert [m["name"] for m in months] == [expected_month(first.attached_at)]
    files = (await client.get(f"{API}/drive/folders/{months[0]['id']}/children")).json()["items"]
    assert sorted(f["name"] for f in files) == ["data.csv", "修論.pdf"]
    assert all(f["posted"] for f in files)
    assert all(f["file"]["attachment_id"] in {a["id"] for a in shown} for f in files)

    # Counted once, in the channel's drive (folders and files), and no longer as a chat file.
    place = await channel_location(db, lab["id"])
    assert place.used_bytes == len(PDF) + len(b"a,b\n1,2\n")
    assert place.item_count == 4
    as_admin = await make_user(db, "boss", role="admin")
    as_user(as_admin)
    usage = (await client.get(f"{API}/admin/drive/usage")).json()
    assert usage["total"]["chat_attachments_bytes"] == 0
    lab_usage = next(loc for loc in usage["locations"] if loc["channel_id"] == lab["id"])
    assert lab_usage["posted_bytes"] == place.used_bytes

    # The details name the post; drive.changed told the drive's readers.
    as_user(alice)
    detail = (await client.get(f"{API}/drive/items/{first.drive_item_id}")).json()
    assert [p["message_id"] for p in detail["item"]["posts"]] == [message["id"]]
    assert detail["item"]["posts"][0]["version_number"] == 1
    assert [c["name"] for c in detail["path"]][1:] == [
        channel_files.POSTS_FOLDER_NAME,
        expected_month(first.attached_at),
    ]
    changed = (
        await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "drive.changed"))
    ).scalars()
    assert any(
        e.payload["folder_ids"] == sorted([months[0]["id"], posts["id"], drive["root_id"]])
        for e in changed
    )


async def test_later_posts_reuse_the_folders_and_number_clashing_names(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    lab = await make_channel(client, "lab", [bob])
    first = await post(client, lab["id"], [("report.pdf", PDF)])
    as_user(bob)
    reply = await post(client, lab["id"], [("report.pdf", PDF + b"2")], parent_id=first["id"])
    # The thread's reply goes to the same month folder, under a free name (not a new version).
    a = await row(db, first["attachments"][0]["id"])
    b = await row(db, reply["attachments"][0]["id"])
    item_a, item_b = (
        await item_row(db, a.drive_item_id or ""),
        await item_row(db, b.drive_item_id or ""),
    )
    assert item_a is not None and item_b is not None
    assert item_a.parent_id == item_b.parent_id and item_a.id != item_b.id
    assert (item_a.name, item_b.name) == ("report.pdf", "report (1).pdf")
    folders = (
        (await db.execute(select(DriveItem).where(DriveItem.system_role == "channel_posts")))
        .scalars()
        .all()
    )
    assert len(folders) == 1
    # The message keeps the name it was posted under.
    assert reply["attachments"][0]["filename"] == "report.pdf"


async def test_a_retried_send_files_once(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    attachment_id = await upload_file(client, "a.txt", b"hello")
    body = {"client_msg_id": str(uuid.uuid4()), "body": "x", "attachment_ids": [attachment_id]}
    first = await client.post(f"{API}/channels/{lab['id']}/messages", json=body)
    again = await client.post(f"{API}/channels/{lab['id']}/messages", json=body)
    assert first.json()["id"] == again.json()["id"]
    files = (await db.execute(select(DriveItem).where(DriveItem.kind == "file"))).scalars().all()
    assert len(files) == 1


async def test_two_sends_at_once_make_one_posts_folder_and_one_month_folder(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    ids = [await upload_file(client, f"f{i}.txt", b"x" * (i + 1)) for i in range(4)]

    async def send(attachment_id: str) -> int:
        sent = await client.post(
            f"{API}/channels/{lab['id']}/messages",
            json={
                "client_msg_id": str(uuid.uuid4()),
                "body": "x",
                "attachment_ids": [attachment_id],
            },
        )
        return sent.status_code

    assert set(await asyncio.gather(*(send(i) for i in ids))) == {201}
    folders = (
        (
            await db.execute(
                select(DriveItem).where(
                    DriveItem.kind == "folder", DriveItem.parent_id.is_not(None)
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(folders) == 2  # 「投稿のファイル」 and the month
    rows = [await row(db, i) for i in ids]
    assert all(r.drive_state == "available" for r in rows)
    place = await channel_location(db, lab["id"])
    assert place.used_bytes == 1 + 2 + 3 + 4 and place.item_count == 6


async def test_a_send_and_a_trash_of_the_month_folder_at_once_both_finish(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """§16: the send locks the drive before the channel, like the drive's own changes, so the
    two never deadlock; whichever waits sees what the other did."""
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    first = await post(client, lab["id"], [("a.txt", b"first")])
    month = await item_row(db, (await row(db, first["attachments"][0]["id"])).drive_item_id or "")
    assert month is not None and month.parent_id is not None
    attachment_id = await upload_file(client, "b.txt", b"second")

    async def send() -> int:
        sent = await client.post(
            f"{API}/channels/{lab['id']}/messages",
            json={
                "client_msg_id": str(uuid.uuid4()),
                "body": "x",
                "attachment_ids": [attachment_id],
            },
        )
        return sent.status_code

    async def trash() -> int:
        done = await client.post(
            f"{API}/drive/items/trash", json={"item_ids": [str(month.parent_id)]}
        )
        return done.status_code

    assert list(await asyncio.gather(send(), trash())) == [201, 200]
    # Whichever went first, the message says what the drive has: the send filed it into the
    # month folder before the trash took it (trashed), or into one made again after (available).
    second = await row(db, attachment_id)
    placed = await item_row(db, second.drive_item_id or "")
    assert placed is not None
    assert second.drive_state == ("trashed" if placed.trashed_at is not None else "available")
    assert (await row(db, first["attachments"][0]["id"])).drive_state == "trashed"


async def test_a_failure_in_the_drive_never_fails_the_send(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])

    async def broken(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("the drive is broken")

    monkeypatch.setattr(channel_files, "_file", broken)
    message = await post(client, lab["id"], [("a.txt", b"hello")])
    assert message["attachments"][0]["drive"] is None
    plain = await row(db, message["attachments"][0]["id"])
    assert plain.status == "attached" and plain.drive_item_id is None and plain.drive_state is None
    assert (await client.get(f"{API}/attachments/{plain.id}/content")).content == b"hello"
    monkeypatch.undo()

    # A failure at the very end (items and versions written, then rolled back), in a thread
    # reply: the reply and its parent's counters are as without the drive.
    async def late(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("the outbox is broken")

    monkeypatch.setattr(drive_events, "emit_changed", late)
    reply = await post(client, lab["id"], [("r.txt", b"reply")], parent_id=message["id"])
    assert reply["attachments"][0]["drive"] is None and reply["parent_id"] == message["id"]
    monkeypatch.undo()
    replied = await row(db, reply["attachments"][0]["id"])
    assert replied.drive_item_id is None and replied.drive_state is None
    assert (await db.execute(select(DriveFileVersion))).scalars().all() == []
    parent = await db.get(Message, uuid.UUID(message["id"]), populate_existing=True)
    assert parent is not None and parent.reply_count == 1

    # A full month folder (or a lock that cannot be prepared) is the same: a plain attachment.
    await post(client, lab["id"], [("b.txt", b"b")])
    monkeypatch.setattr(names, "MAX_CHILDREN", 1)
    full = await post(client, lab["id"], [("c.txt", b"c")])
    assert full["attachments"][0]["drive"] is None
    monkeypatch.undo()

    async def unprepared(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("no drive")

    monkeypatch.setattr(channel_files, "_lock_plan", unprepared)
    again = await post(client, lab["id"], [("d.txt", b"d")])
    assert again["attachments"][0]["drive"] is None


def test_names_and_months() -> None:
    assert channel_files.file_name("ok.pdf") == "ok.pdf"
    assert channel_files.file_name("..") == channel_files.FALLBACK_NAME
    assert channel_files.file_name("a" * 300 + ".pdf") == "ファイル.pdf"
    # The workspace's zone decides the month (JST is UTC+9).
    assert channel_files.month_name(datetime(2026, 10, 31, 14, 59, tzinfo=UTC)) == "2026-10"
    assert channel_files.month_name(datetime(2026, 10, 31, 15, 0, tzinfo=UTC)) == "2026-11"


async def test_dms_and_switched_off_channels_keep_plain_attachments(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    dm = (await client.post(f"{API}/dms", json={"user_ids": [str(bob.id)]})).json()
    group = (
        await client.post(f"{API}/dms", json={"user_ids": [str(bob.id), str(carol.id)]})
    ).json()
    for conversation in (dm, group):
        sent = await post(client, conversation["id"], [("a.txt", b"x")])
        assert sent["attachments"][0]["drive"] is None
        assert (await row(db, sent["attachments"][0]["id"])).drive_item_id is None

    # The workspace's switch, and a channel's own choice over it.
    lab = await make_channel(client, "lab", [bob])
    quiet = await make_channel(client, "chat", [bob])
    off = await client.patch(f"{API}/channels/{quiet['id']}", json={"files_to_drive": False})
    assert off.status_code == 200
    assert off.json()["files_to_drive"] is False and off.json()["files_to_drive_effective"] is False
    assert (await post(client, quiet["id"], [("a.txt", b"x")]))["attachments"][0]["drive"] is None
    assert (await post(client, lab["id"], [("a.txt", b"x")]))["attachments"][0]["drive"]

    await set_workspace_switch(db, False)
    got = (await client.get(f"{API}/channels/{lab['id']}")).json()
    assert got["files_to_drive"] is None and got["files_to_drive_effective"] is False
    assert (await post(client, lab["id"], [("b.txt", b"x")]))["attachments"][0]["drive"] is None
    on = await client.patch(f"{API}/channels/{lab['id']}", json={"files_to_drive": True})
    assert on.json()["files_to_drive_effective"] is True
    assert (await post(client, lab["id"], [("c.txt", b"x")]))["attachments"][0]["drive"]
    # null again: the workspace decides (off).
    back = await client.patch(f"{API}/channels/{lab['id']}", json={"files_to_drive": None})
    assert back.json()["files_to_drive"] is None
    assert (await post(client, lab["id"], [("d.txt", b"x")]))["attachments"][0]["drive"] is None

    # Only owners (or those who manage the channel) change it.
    as_user(bob)
    refused = await client.patch(f"{API}/channels/{lab['id']}", json={"files_to_drive": False})
    assert refused.status_code == 403

    # The administrator's switch.
    admin = await make_user(db, "boss", role="admin")
    as_user(admin)
    turned = await client.patch(
        f"{API}/admin/workspace-settings", json={"channel_files_to_drive": True}
    )
    assert turned.status_code == 200 and turned.json()["channel_files_to_drive"] is True
    boot = (await client.get(f"{API}/sync/bootstrap")).json()
    assert boot["workspace_settings"]["channel_files_to_drive"] is True


async def test_an_owners_only_channel_files_a_members_thread_reply(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    owner = await make_user(db, "owner")
    member = await make_user(db, "member")
    as_user(owner)
    news = await make_channel(client, "news", [member])
    await client.patch(f"{API}/channels/{news['id']}", json={"posting_policy": "owners"})
    parent = await post(client, news["id"], [("plan.pdf", PDF)])
    as_user(member)
    reply = await post(client, news["id"], [("answer.pdf", PDF)], parent_id=parent["id"])
    assert reply["attachments"][0]["drive"]["state"] == "available"
    # The member reads it in the drive, but cannot write there.
    item_id = reply["attachments"][0]["drive"]["item_id"]
    assert (await client.get(f"{API}/drive/items/{item_id}")).status_code == 200
    renamed = await client.patch(f"{API}/drive/items/{item_id}", json={"name": "x.pdf"})
    assert renamed.status_code == 403


async def test_posting_is_never_refused_for_the_quota(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app, drive_total_quota_bytes=10)
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    drive = await location(client, "channel", channel_id=lab["id"])
    await db.execute(
        update(DriveLocation)
        .where(DriveLocation.id == uuid.UUID(drive["id"]))
        .values(quota_bytes=5)
    )
    await db.commit()
    sent = await post(client, lab["id"], [("big.bin", b"z" * 100)])
    assert sent["attachments"][0]["drive"]["state"] == "available"
    place = await channel_location(db, lab["id"])
    assert place.used_bytes == 100  # over the quota of 5
    # The drive's own uploads stop.
    refused = await client.post(
        f"{API}/drive/uploads",
        json={
            "client_upload_id": str(uuid.uuid4()),
            "parent_id": drive["root_id"],
            "name": "more.bin",
            "size_bytes": 1,
        },
    )
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "drive_quota_exceeded"


# --- who reads it (§5) --------------------------------------------------------------------------


async def test_who_reads_a_posted_file_in_each_state(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """§5.1's table: the members (guests too), a public channel's visitor before joining and
    those who left it read it while it is in the channel's drive; a private channel's leaver
    never; moved, only who can read it where it is; trashed or purged, nobody."""
    drive_settings(app)
    alice = await make_user(db, "alice")  # posts
    gus = await make_user(db, "gus", role="guest")  # a guest member
    carol = await make_user(db, "carol")  # never joined the public channel
    dave = await make_user(db, "dave")  # left the public channel
    erin = await make_user(db, "erin")  # left the private channel
    visitor = await make_user(db, "visitor", role="guest")  # a guest outside
    as_user(alice)
    lab = await make_channel(client, "lab", [gus, dave])
    secret = await make_channel(client, "secret", [erin], kind="private")
    public_msg = await post(client, lab["id"], [("lab.txt", b"lab")])
    private_msg = await post(client, secret["id"], [("secret.txt", b"secret")])
    public_id = public_msg["attachments"][0]["id"]
    private_id = private_msg["attachments"][0]["id"]
    as_user(dave)
    assert (await client.post(f"{API}/channels/{lab['id']}/leave")).status_code == 204
    as_user(erin)
    assert (await client.post(f"{API}/channels/{secret['id']}/leave")).status_code == 204

    async def status(person: User, attachment_id: str) -> int:
        as_user(person)
        return (await client.get(f"{API}/attachments/{attachment_id}/content")).status_code

    async def statuses(attachment_id: str) -> dict[str, int]:
        people = [alice, gus, carol, dave, erin, visitor]
        return {p.username: await status(p, attachment_id) for p in people}

    # In the channel's drive: as any attachment of the channel (403 for those it refuses).
    assert await statuses(public_id) == {
        "alice": 200,
        "gus": 200,
        "carol": 200,
        "dave": 200,
        "erin": 200,
        "visitor": 403,
    }
    assert (await statuses(private_id))["erin"] == 403
    assert (await statuses(private_id))["alice"] == 200

    # Before joining, only while the preview is allowed.
    await db.execute(text("UPDATE workspace_settings SET preview_before_join = false"))
    await db.commit()
    assert await status(carol, public_id) == 403
    await db.execute(text("UPDATE workspace_settings SET preview_before_join = true"))
    await db.commit()

    # Moved to 研究室ドライブ: every person reads it there; the guest member does not any more.
    item_id = public_msg["attachments"][0]["drive"]["item_id"]
    as_user(alice)
    root = await workspace_root(client)
    moved = await client.post(
        f"{API}/drive/items/move", json={"item_ids": [item_id], "target_folder_id": root}
    )
    assert moved.json()["results"][0]["ok"], moved.text
    assert (await row(db, public_id)).drive_state == "moved"
    assert await statuses(public_id) == {
        "alice": 200,
        "gus": 404,
        "carol": 200,
        "dave": 200,
        "erin": 200,
        "visitor": 404,
    }

    # Moved on to alice's My Drive: alice only.
    as_user(alice)
    mine = await location(client, "me")
    await client.post(
        f"{API}/drive/items/move", json={"item_ids": [item_id], "target_folder_id": mine["root_id"]}
    )
    assert await statuses(public_id) == {
        "alice": 200,
        "gus": 404,
        "carol": 404,
        "dave": 404,
        "erin": 404,
        "visitor": 404,
    }

    # Back in the channel's drive (a folder of it): as at first.
    as_user(alice)
    drive = await location(client, "channel", channel_id=lab["id"])
    papers = await folder(client, drive["root_id"], "論文")
    await client.post(
        f"{API}/drive/items/move", json={"item_ids": [item_id], "target_folder_id": papers}
    )
    assert (await row(db, public_id)).drive_state == "available"
    assert (await statuses(public_id))["gus"] == 200 and (await statuses(public_id))["dave"] == 200

    # In the trash: nobody (alice either).
    as_user(alice)
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [item_id]})
    assert set((await statuses(public_id)).values()) == {404}

    # Purged: a tombstone, nobody.
    as_user(alice)
    assert (await client.delete(f"{API}/drive/items/{item_id}")).status_code == 204
    tomb = await row(db, public_id)
    assert tomb.drive_state == "deleted" and tomb.status == "deleted" and tomb.drive_item_id is None
    assert set((await statuses(public_id)).values()) == {404}

    # The other ways in follow the drive's rule only: a guest member cannot list or fetch the
    # drive's copy of a file that left the channel, and a public visitor never opens the drive.
    as_user(carol)
    other = private_msg["attachments"][0]["drive"]["item_id"]
    assert (await client.get(f"{API}/drive/items/{other}")).status_code == 404


async def test_a_deleted_message_no_longer_lets_its_readers_in(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    carol = await make_user(db, "carol")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    message = await post(client, lab["id"], [("a.txt", b"x")])
    attachment_id = message["attachments"][0]["id"]
    # Kept in the drive (keep): the visitor read it through the message, not any more.
    deleted = await client.delete(f"{API}/messages/{message['id']}?drive_files=keep")
    assert deleted.status_code == 200
    as_user(carol)
    assert (await client.get(f"{API}/attachments/{attachment_id}/content")).status_code == 404
    as_user(alice)
    assert (await client.get(f"{API}/attachments/{attachment_id}/content")).status_code == 200


# --- the posted version, names (§4) --------------------------------------------------------------


async def test_the_message_keeps_its_version_and_name(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app, drive_versions_max=1, drive_versions_days=0)
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    message = await post(client, lab["id"], [("draft.txt", b"version one")])
    attachment_id = message["attachments"][0]["id"]
    item_id = message["attachments"][0]["drive"]["item_id"]
    version_id = message["attachments"][0]["drive"]["version_id"]

    # A rename in the drive: the message keeps 「draft.txt」 (no event, nothing leaks).
    renamed = await client.patch(f"{API}/drive/items/{item_id}", json={"name": "final.txt"})
    assert renamed.status_code == 200
    assert (await client.get(f"{API}/attachments/{attachment_id}")).json()[
        "filename"
    ] == "draft.txt"
    content = await client.get(f"{API}/drive/items/{item_id}/content")
    assert "final.txt" in content.headers["content-disposition"]

    # A new version in the drive: the message still shows (and serves) version 1.
    parent = await item_row(db, item_id)
    assert parent is not None and parent.parent_id is not None
    await upload(client, str(parent.parent_id), "final.txt", b"version two", on_conflict="version")
    got = await client.get(f"{API}/attachments/{attachment_id}/content")
    assert got.content == b"version one"
    shown = await message_in(client, lab["id"], message["id"])
    assert shown["attachments"][0]["drive"]["version_number"] == 1
    assert shown["attachments"][0]["filename"] == "draft.txt"
    latest = await client.get(f"{API}/drive/items/{item_id}/content")
    assert latest.content == b"version two"

    # The posted version cannot be deleted by hand, nor by the retention.
    refused = await client.delete(f"{API}/drive/items/{item_id}/versions/{version_id}")
    assert refused.status_code == 409
    error = refused.json()["error"]
    assert error["code"] == "drive_version_posted"
    assert error["details"] == {"message_id": message["id"], "channel_id": lab["id"]}
    removed = await versions.prune(db, app.state.settings, now=utcnow() + timedelta(days=1))
    assert removed == 0
    assert await db.get(DriveFileVersion, uuid.UUID(version_id), populate_existing=True)

    # Once the message is deleted (kept in the drive), it is an ordinary older version.
    await client.delete(f"{API}/messages/{message['id']}?drive_files=keep")
    removed = await versions.prune(db, app.state.settings, now=utcnow() + timedelta(days=1))
    assert removed == 1


async def test_the_system_folder_cannot_be_renamed_moved_or_trashed(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    message = await post(client, lab["id"], [("a.txt", b"x")])
    item = await item_row(db, message["attachments"][0]["drive"]["item_id"])
    assert item is not None and item.parent_id is not None
    month = await item_row(db, item.parent_id)
    assert month is not None and month.parent_id is not None
    posts_id = str(month.parent_id)
    drive = await location(client, "channel", channel_id=lab["id"])
    other = await folder(client, drive["root_id"], "other")

    renamed = await client.patch(f"{API}/drive/items/{posts_id}", json={"name": "x"})
    assert renamed.status_code == 409 and renamed.json()["error"]["code"] == "drive_folder_system"
    moved = await client.post(
        f"{API}/drive/items/move", json={"item_ids": [posts_id], "target_folder_id": other}
    )
    assert moved.json()["results"][0]["error"] == "drive_folder_system"
    trashed = await client.post(f"{API}/drive/items/trash", json={"item_ids": [posts_id]})
    assert trashed.json()["results"][0]["error"] == "drive_folder_system"
    # The month folder is an ordinary folder: it moves (its files with it, still in the drive).
    moved_month = await client.post(
        f"{API}/drive/items/move", json={"item_ids": [str(month.id)], "target_folder_id": other}
    )
    assert moved_month.json()["results"][0]["ok"]
    assert (await row(db, message["attachments"][0]["id"])).drive_state == "available"
    # The next post makes the month folder again under 「投稿のファイル」.
    again = await post(client, lab["id"], [("b.txt", b"y")])
    placed = await item_row(db, again["attachments"][0]["drive"]["item_id"])
    assert placed is not None
    fresh_month = await item_row(db, placed.parent_id or "")
    assert fresh_month is not None and str(fresh_month.parent_id) == posts_id


# --- the drive's changes told to the message (§6.4, §6.5, §7.5) ----------------------------------


async def test_moves_trash_restore_and_purge_announce_the_message(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    message = await post(client, lab["id"], [("a.pdf", PDF)])
    attachment_id = message["attachments"][0]["id"]
    item_id = message["attachments"][0]["drive"]["item_id"]
    seqs = [message["updated_seq"]]

    async def state_and_event(expected: str) -> None:
        shown = await message_in(client, lab["id"], message["id"])
        assert shown["attachments"][0]["drive"]["state"] == expected
        assert shown["updated_seq"] > seqs[-1]
        seqs.append(shown["updated_seq"])
        events = (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "message.updated")
                .order_by(OutboxEvent.id.desc())
                .limit(1)
            )
        ).scalar_one()
        assert events.payload["change"] == "attachments"
        assert events.payload["message"]["id"] == message["id"]
        assert events.payload["message"]["attachments"][0]["drive"]["state"] == expected
        assert events.seq == shown["updated_seq"]

    root = await workspace_root(client)
    await client.post(
        f"{API}/drive/items/move", json={"item_ids": [item_id], "target_folder_id": root}
    )
    await state_and_event("moved")
    # Inside 研究室ドライブ: nothing changes for the message (no event).
    papers = await folder(client, root, "papers")
    before = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "message.updated")))
        .scalars()
        .all()
    )
    await client.post(
        f"{API}/drive/items/move", json={"item_ids": [item_id], "target_folder_id": papers}
    )
    after = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "message.updated")))
        .scalars()
        .all()
    )
    assert len(after) == len(before)

    await client.post(f"{API}/drive/items/trash", json={"item_ids": [item_id]})
    await state_and_event("trashed")
    audit = (
        await db.execute(select(AuditLog).where(AuditLog.action == "drive.trash"))
    ).scalar_one()
    assert audit.details["via"] == "drive" and audit.details["messages"] == 1
    restored = await client.post(f"{API}/drive/items/{item_id}/restore")
    assert restored.status_code == 200
    await state_and_event("moved")  # back in 研究室ドライブ's folder
    drive = await location(client, "channel", channel_id=lab["id"])
    await client.post(
        f"{API}/drive/items/move",
        json={"item_ids": [item_id], "target_folder_id": drive["root_id"]},
    )
    await state_and_event("available")

    # A folder above it in the trash, then purged: the message keeps a tombstone.
    holder = await folder(client, drive["root_id"], "holder")
    await client.post(
        f"{API}/drive/items/move", json={"item_ids": [item_id], "target_folder_id": holder}
    )
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [holder]})
    await state_and_event("trashed")
    assert (await client.delete(f"{API}/drive/items/{holder}")).status_code == 204
    await state_and_event("deleted")
    shown = await message_in(client, lab["id"], message["id"])
    assert shown["attachments"][0]["drive"] == {
        "item_id": None,
        "version_id": None,
        "version_number": None,
        "state": "deleted",
    }
    assert shown["attachments"][0]["filename"] == "a.pdf"  # an old client's row
    assert shown["attachments"][0]["status"] == "attached"
    purge = (
        await db.execute(select(AuditLog).where(AuditLog.action == "drive.delete"))
    ).scalar_one()
    assert purge.details["posted_messages"] == 1
    # The location gave the bytes back.
    assert (await channel_location(db, lab["id"])).used_bytes == 0
    del attachment_id


async def test_the_breadcrumbs_mark_the_posts_folder(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    message = await post(client, lab["id"], [("a.txt", b"x")])
    item_id = message["attachments"][0]["drive"]["item_id"]
    detail = await client.get(f"{API}/drive/items/{item_id}")
    assert detail.status_code == 200, detail.text
    path = detail.json()["path"]
    assert [c["system_role"] for c in path] == [None, "channel_posts", None]
    month_id = path[-1]["id"]
    listed = await client.get(f"{API}/drive/folders/{month_id}/children")
    assert [c["system_role"] for c in listed.json()["path"]] == [None, "channel_posts", None]


async def test_restoring_a_posted_file_whose_month_folder_is_in_the_trash(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """「戻す」 under a message whose file went to the trash with its month folder: the folder's
    group comes back (DRIVE.md §10.1), and every message in it shows its file again."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    lab = await make_channel(client, "lab", [bob])
    first = await post(client, lab["id"], [("a.pdf", PDF)])
    second = await post(client, lab["id"], [("b.txt", b"y")])
    item_id = first["attachments"][0]["drive"]["item_id"]
    item = await item_row(db, item_id)
    assert item is not None and item.parent_id is not None
    month_id = str(item.parent_id)
    trashed = await client.post(f"{API}/drive/items/trash", json={"item_ids": [month_id]})
    assert trashed.json()["results"][0]["ok"]
    for message in (first, second):
        shown = await message_in(client, lab["id"], message["id"])
        assert shown["attachments"][0]["drive"]["state"] == "trashed"
    seqs = {
        m["id"]: (await message_in(client, lab["id"], m["id"]))["updated_seq"]
        for m in (first, second)
    }

    as_user(bob)
    restored = await client.post(f"{API}/drive/items/{item_id}/restore", json={})
    assert restored.status_code == 200, restored.text
    assert restored.json()["id"] == item_id and restored.json()["parent_id"] == month_id
    month = await item_row(db, month_id)
    assert month is not None and month.trashed_at is None
    for message in (first, second):
        shown = await message_in(client, lab["id"], message["id"])
        assert shown["attachments"][0]["drive"]["state"] == "available"
        assert shown["updated_seq"] > seqs[message["id"]]
    events = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "message.updated")
                .order_by(OutboxEvent.id.desc())
                .limit(2)
            )
        )
        .scalars()
        .all()
    )
    assert {e.payload["message"]["id"] for e in events} == {first["id"], second["id"]}
    assert all(e.payload["change"] == "attachments" for e in events)
    changed = (
        await db.execute(
            select(OutboxEvent)
            .where(OutboxEvent.event_type == "drive.changed")
            .order_by(OutboxEvent.id.desc())
            .limit(1)
        )
    ).scalar_one()
    assert changed.id > max(e.id for e in events)
    assert changed.payload["folder_ids"] == [str(month.parent_id)]  # 「投稿のファイル」
    log = (
        await db.execute(select(AuditLog).where(AuditLog.action == "drive.restore"))
    ).scalar_one()
    assert log.actor_id == bob.id and str(log.target_id) == month_id
    assert log.details["asked_item_id"] == item_id and log.details["messages"] == 2
    # The month folder came back under 「投稿のファイル」 (still there, so no clash).
    detail = (await client.get(f"{API}/drive/items/{item_id}")).json()
    assert [c["system_role"] for c in detail["path"]] == [None, "channel_posts", None]


async def test_the_gc_keeps_a_tombstone_while_the_message_lives(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    png = await client.post(f"{API}/attachments", files={"file": ("p.png", _png(), "image/png")})
    image_id = png.json()["id"]
    sent = await client.post(
        f"{API}/channels/{lab['id']}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "x", "attachment_ids": [image_id]},
    )
    message = sent.json()
    item_id = message["attachments"][0]["drive"]["item_id"]
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [item_id]})
    await client.delete(f"{API}/drive/items/{item_id}")
    blobs: MemoryBlobStore = app.state.blobs
    assert f"attachments/{image_id}" in blobs.objects
    _, purged = await attachments.gc(db, blobs)
    assert purged == 1
    tomb = await row(db, image_id)
    assert tomb.status == "purged" and tomb.drive_state == "deleted" and tomb.thumbnail_key is None
    assert f"attachments/{image_id}" not in blobs.objects
    assert not any(k.startswith(f"attachments/{image_id}") for k in blobs.objects)
    assert await attachments.verify(db, blobs) == []  # a tombstone has no bytes to miss
    shown = await message_in(client, lab["id"], message["id"])
    assert shown["attachments"][0]["has_thumbnail"] is False
    # The files list leaves it out; deleting the message lets the GC remove the row.
    assert (await client.get(f"{API}/files", params={"channel_id": lab["id"]})).json()[
        "items"
    ] == []
    await client.delete(f"{API}/messages/{message['id']}")
    assert (await row(db, image_id)).status == "deleted"
    await attachments.gc(db, blobs)
    assert await db.get(Attachment, uuid.UUID(image_id), populate_existing=True) is None


def _png() -> bytes:
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (32, 24), (200, 10, 10)).save(buffer, format="PNG")
    return buffer.getvalue()


# --- deleting the message (§7.3) ----------------------------------------------------------------


async def test_deleting_a_message_follows_the_drive_files_rule(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    admin = await make_user(db, "boss", role="admin")
    as_user(alice)
    lab = await make_channel(client, "lab", [bob, admin])

    # Mine and unchanged (auto): to the drive's trash, taken off the message.
    mine = await post(client, lab["id"], [("oops.pdf", PDF)])
    rules = (await client.get(f"{API}/messages/{mine['id']}/drive-files")).json()["files"]
    assert [(r["trash"], r["reason"]) for r in rules] == [(True, None)]
    await client.delete(f"{API}/messages/{mine['id']}")
    taken = await row(db, mine["attachments"][0]["id"])
    assert taken.message_id is None and taken.channel_id is None and taken.drive_state is None
    assert taken.status == "attached"  # a drive version (in the trash), not a deleted attachment
    trashed = await item_row(db, mine["attachments"][0]["drive"]["item_id"])
    assert trashed is not None and trashed.trashed_at is not None
    audit = (
        await db.execute(select(AuditLog).where(AuditLog.action == "drive.trash"))
    ).scalar_one()
    assert audit.details["via"] == "message_delete" and audit.details["message_id"] == mine["id"]
    # 30 days to bring it back.
    restored = await client.post(f"{API}/drive/items/{trashed.id}/restore")
    assert restored.status_code == 200

    # Mine but changed since (a new version): it stays.
    changed = await post(client, lab["id"], [("data.txt", b"one")])
    item = await item_row(db, changed["attachments"][0]["drive"]["item_id"])
    assert item is not None
    await upload(client, str(item.parent_id), "data.txt", b"two", on_conflict="version")
    rules = (await client.get(f"{API}/messages/{changed['id']}/drive-files")).json()["files"]
    assert [(r["trash"], r["reason"]) for r in rules] == [(False, "changed")]
    await client.delete(f"{API}/messages/{changed['id']}?drive_files=trash")
    kept = await item_row(db, item.id)
    assert kept is not None and kept.trashed_at is None
    # Its posted version is now an ordinary older version (readable in the drive).
    old = await row(db, changed["attachments"][0]["id"])
    assert old.message_id is None and old.drive_state is None and old.status == "attached"
    assert (await client.get(f"{API}/attachments/{old.id}/content")).content == b"one"

    # keep: it stays.
    keep = await post(client, lab["id"], [("keep.txt", b"k")])
    await client.delete(f"{API}/messages/{keep['id']}?drive_files=keep")
    still = await item_row(db, keep["attachments"][0]["drive"]["item_id"])
    assert still is not None and still.trashed_at is None

    # Bob's file: bob sees his rule; a moderator deleting it puts it in the trash too.
    as_user(bob)
    his = await post(client, lab["id"], [("bob.txt", b"b")])
    as_user(alice)
    assert (await client.delete(f"{API}/messages/{his['id']}")).status_code == 403
    as_user(admin)
    rules = (await client.get(f"{API}/messages/{his['id']}/drive-files")).json()["files"]
    assert rules[0]["trash"] is True
    await client.delete(f"{API}/messages/{his['id']}")
    gone = await item_row(db, his["attachments"][0]["drive"]["item_id"])
    assert gone is not None and gone.trashed_at is not None

    # A file moved out of the channel's drive stays where it is.
    as_user(alice)
    moved = await post(client, lab["id"], [("moved.txt", b"m")])
    await client.post(
        f"{API}/drive/items/move",
        json={
            "item_ids": [moved["attachments"][0]["drive"]["item_id"]],
            "target_folder_id": await workspace_root(client),
        },
    )
    rules = (await client.get(f"{API}/messages/{moved['id']}/drive-files")).json()["files"]
    assert [(r["trash"], r["reason"], r["state"]) for r in rules] == [(False, "moved", "moved")]
    await client.delete(f"{API}/messages/{moved['id']}")
    elsewhere = await item_row(db, moved["attachments"][0]["drive"]["item_id"])
    assert elsewhere is not None and elsewhere.trashed_at is None

    # A plain attachment (switch off) goes as before.
    await client.patch(f"{API}/channels/{lab['id']}", json={"files_to_drive": False})
    plain = await post(client, lab["id"], [("plain.txt", b"p")])
    assert (await client.get(f"{API}/messages/{plain['id']}/drive-files")).json()["files"] == []
    await client.delete(f"{API}/messages/{plain['id']}")
    assert (await row(db, plain["attachments"][0]["id"])).status == "deleted"


async def test_a_moderator_rule_for_a_non_moderator_is_not_permitted(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """The rule for a file someone else posted, as seen by a member who cannot delete it."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    lab = await make_channel(client, "lab", [bob])
    mine = await post(client, lab["id"], [("a.txt", b"x")])
    as_user(bob)
    rules = (await client.get(f"{API}/messages/{mine['id']}/drive-files")).json()["files"]
    assert [(r["trash"], r["reason"]) for r in rules] == [(False, "not_permitted")]


# --- impact (§6.4) ------------------------------------------------------------------------------


async def test_impact_counts_the_members_who_would_lose_a_file(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    gus = await make_user(db, "gus", role="guest")
    other = await make_user(db, "other")
    await make_user(db, "robot", role="bot")
    as_user(alice)
    lab = await make_channel(client, "lab", [bob, gus])
    first = await post(client, lab["id"], [("a.txt", b"a"), ("b.txt", b"b")])
    second = await post(client, lab["id"], [("c.txt", b"c")])
    item_a = first["attachments"][0]["drive"]["item_id"]
    item_c = second["attachments"][0]["drive"]["item_id"]
    month = await item_row(db, item_a)
    assert month is not None
    root = await workspace_root(client)

    # To 研究室ドライブ: the guest would lose them.
    to_lab = await client.post(
        f"{API}/drive/items/impact",
        json={"item_ids": [str(month.parent_id)], "target_folder_id": root},
    )
    assert to_lab.status_code == 200, to_lab.text
    assert to_lab.json() == {
        "posted_messages": 2,
        "channels": [
            {"channel_id": lab["id"], "messages": 2, "unreadable_after": 1, "unreadable_guests": 1}
        ],
    }
    # To the trash: every member.
    trash = await client.post(f"{API}/drive/items/impact", json={"item_ids": [item_c]})
    assert trash.json()["channels"][0] == {
        "channel_id": lab["id"],
        "messages": 1,
        "unreadable_after": 3,
        "unreadable_guests": 1,
    }
    # Within the channel's drive: nothing.
    drive = await location(client, "channel", channel_id=lab["id"])
    inside = await client.post(
        f"{API}/drive/items/impact",
        json={"item_ids": [item_a], "target_folder_id": drive["root_id"]},
    )
    assert inside.json() == {"posted_messages": 0, "channels": []}
    # Nothing was changed.
    assert (await row(db, first["attachments"][0]["id"])).drive_state == "available"
    # An item someone cannot read: 404.
    as_user(other)
    assert (
        await client.post(f"{API}/drive/items/impact", json={"item_ids": [item_a]})
    ).status_code == 404


# --- search (§12.6) -----------------------------------------------------------------------------


async def test_search_finds_posted_files_once_and_by_origin(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    message = await post(client, lab["id"], [("quarterly-zebra.txt", b"x")])
    drive = await location(client, "channel", channel_id=lab["id"])
    await upload(client, drive["root_id"], "zebra-upload.txt", b"y")

    async def messages_found() -> list[str]:
        found = await client.get(f"{API}/search/messages", params={"q": "quarterly"})
        assert found.status_code == 200, found.text
        return [h["message"]["id"] for h in found.json()["hits"]]

    async def drive_found(origin: str) -> list[str]:
        found = await client.get(f"{API}/search/drive", params={"q": "zebra", "origin": origin})
        assert found.status_code == 200, found.text
        return sorted(h["item"]["name"] for h in found.json()["items"])

    assert await messages_found() == [message["id"]]
    assert await drive_found("all") == ["quarterly-zebra.txt", "zebra-upload.txt"]
    assert await drive_found("posts") == ["quarterly-zebra.txt"]
    assert await drive_found("uploads") == ["zebra-upload.txt"]
    # The files list shows it with its drive place.
    files = (await client.get(f"{API}/files", params={"channel_id": lab["id"]})).json()["items"]
    assert files[0]["attachment"]["drive"]["state"] == "available"

    # Trashed: the message's file-name branch and the files list leave it out.
    await client.post(
        f"{API}/drive/items/trash",
        json={"item_ids": [message["attachments"][0]["drive"]["item_id"]]},
    )
    assert await messages_found() == []
    assert (await client.get(f"{API}/files", params={"channel_id": lab["id"]})).json()[
        "items"
    ] == []
    assert await drive_found("posts") == []


# --- backfill (§10) -----------------------------------------------------------------------------


async def test_the_backfill_files_earlier_attachments_once(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    await set_workspace_switch(db, False)
    lab = await make_channel(client, "lab", [])
    quiet = await make_channel(client, "quiet", [])
    old = await post(client, lab["id"], [("old.pdf", PDF), ("old2.txt", b"two")])
    gone = await post(client, lab["id"], [("gone.txt", b"g")])
    await client.delete(f"{API}/messages/{gone['id']}")
    await post(client, quiet["id"], [("q.txt", b"q")])
    # Posted long ago: its month folder is the post's month.
    long_ago = datetime(2025, 4, 15, 3, 0, tzinfo=UTC)
    await db.execute(
        update(Attachment)
        .where(Attachment.id == uuid.UUID(old["attachments"][0]["id"]))
        .values(attached_at=long_ago)
    )
    # A canvas's image is not a message's.
    canvas_file = Attachment(
        uploader_id=alice.id,
        channel_id=uuid.UUID(lab["id"]),
        status="attached",
        filename="canvas.png",
        content_type="image/png",
        size_bytes=3,
        storage_key="attachments/canvas",
        attached_at=utcnow(),
    )
    db.add(canvas_file)
    await db.commit()
    canvas_id = canvas_file.id
    await set_workspace_switch(db, True)
    await client.patch(f"{API}/channels/{quiet['id']}", json={"files_to_drive": False})

    dry = await channel_files.backfill(db, channel_names=None, since=None, dry_run=True, limit=None)
    report = {c.name: (c.files, c.bytes, c.enabled, c.filed) for c in dry.channels}
    assert report == {"lab": (2, len(PDF) + 3, True, 0), "quiet": (1, 1, False, 0)}
    assert (await row(db, old["attachments"][0]["id"])).drive_item_id is None

    before = (await db.execute(select(OutboxEvent))).scalars().all()
    done = await channel_files.backfill(
        db, channel_names=["lab"], since=None, dry_run=False, limit=None
    )
    assert [(c.name, c.filed, c.failed) for c in done.channels] == [("lab", 2, 0)]
    first = await row(db, old["attachments"][0]["id"])
    assert first.drive_state == "available" and first.drive_item_id is not None
    item = await item_row(db, first.drive_item_id)
    assert item is not None
    month = await item_row(db, item.parent_id or "")
    assert month is not None and month.name == "2025-04"
    second = await row(db, old["attachments"][1]["id"])
    second_item = await item_row(db, second.drive_item_id or "")
    assert second_item is not None
    second_month = await item_row(db, second_item.parent_id or "")
    assert second_month is not None and second_month.name == expected_month(
        second.attached_at or utcnow()
    )
    assert (await channel_location(db, lab["id"])).used_bytes == len(PDF) + 3
    # No message.updated for the old messages (the next read shows `drive`).
    after = (await db.execute(select(OutboxEvent))).scalars().all()
    assert not [e for e in after[len(before) :] if e.event_type == "message.updated"]
    shown = await message_in(client, lab["id"], old["id"])
    assert shown["attachments"][0]["drive"]["state"] == "available"
    # The deleted message's file and the canvas's image stay out.
    assert (await row(db, gone["attachments"][0]["id"])).drive_item_id is None
    canvas_row = await db.get(Attachment, canvas_id, populate_existing=True)
    assert canvas_row is not None and canvas_row.drive_item_id is None

    # Again: nothing left to do.
    again = await channel_files.backfill(
        db, channel_names=["lab"], since=None, dry_run=False, limit=None
    )
    assert [(c.files, c.filed) for c in again.channels] == [(0, 0)]
    with pytest.raises(ValueError):
        await channel_files.backfill(
            db, channel_names=["nowhere"], since=None, dry_run=True, limit=None
        )


async def test_the_backfill_stops_at_its_limit_and_goes_on(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    await set_workspace_switch(db, False)
    lab = await make_channel(client, "lab", [])
    for i in range(3):
        await post(client, lab["id"], [(f"{i}.txt", b"x")])
    await set_workspace_switch(db, True)
    first = await channel_files.backfill(
        db, channel_names=["lab"], since=None, dry_run=False, limit=2
    )
    assert first.remaining and first.channels[0].filed == 2
    rest = await channel_files.backfill(
        db, channel_names=["lab"], since=None, dry_run=False, limit=2
    )
    assert not rest.remaining and rest.channels[0].filed == 1
    since = await channel_files.backfill(
        db, channel_names=["lab"], since=utcnow() + timedelta(days=1), dry_run=True, limit=None
    )
    assert since.channels[0].files == 0


# --- older clients (§11.2) ----------------------------------------------------------------------


class _OldAttachment(BaseModel):
    """AttachmentOut as the released clients decode it (no `drive`; unknown fields ignored)."""

    model_config = ConfigDict(extra="ignore")

    id: uuid.UUID
    filename: str
    content_type: str
    size_bytes: int
    width: int | None
    height: int | None
    has_thumbnail: bool
    has_poster: bool
    duration_ms: int | None
    status: str
    created_at: datetime


async def test_a_posted_file_still_reads_as_a_plain_attachment(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    message = await post(client, lab["id"], [("a.pdf", PDF)])
    shown = await message_in(client, lab["id"], message["id"])
    old = _OldAttachment.model_validate(shown["attachments"][0])
    assert old.filename == "a.pdf" and old.status == "attached" and old.size_bytes == len(PDF)
    # Its id, bytes and routes are an attachment's as before.
    assert (await client.get(f"{API}/attachments/{old.id}/content")).content == PDF
    # An old client's 「ドライブに保存」 makes a copy (no harm, twice the space).
    drive = await location(client, "channel", channel_id=lab["id"])
    saved = await client.post(
        f"{API}/drive/save-attachment",
        json={"attachment_id": str(old.id), "folder_id": drive["root_id"]},
    )
    assert saved.status_code == 201, saved.text
    assert saved.json()["id"] != message["attachments"][0]["drive"]["item_id"]
    # A posted message is a Message with sender, seq … untouched (drive only adds a field).
    stored = await db.get(Message, uuid.UUID(message["id"]))
    assert stored is not None and stored.seq == message["seq"]
