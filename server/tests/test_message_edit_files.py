"""M186 (docs/CHANNEL_FILES.md §7.6): an edit changes a message's files. `attachment_ids` lists
what the message keeps and the author's new uploads; a file left out is taken off as a delete
takes its files (gone, or kept in / trashed from the channel's drive by the delete's auto rule);
a new one is bound and filed as a send does. Older clients (no attachment_ids) keep the files."""

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.audit.models import AuditLog
from app.modules.users.models import User
from tests.drive_helpers import act_as, upload
from tests.helpers import make_user
from tests.test_channel_files import PDF, item_row, make_channel, post, row, upload_file

API = "/api/v1"


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


async def edit(
    client: AsyncClient, message_id: str, body: str, attachment_ids: list[str] | None
) -> Any:
    payload: dict[str, Any] = {"body": body}
    if attachment_ids is not None:
        payload["attachment_ids"] = attachment_ids
    return await client.patch(f"{API}/messages/{message_id}", json=payload)


async def plain_channel(client: AsyncClient, name: str) -> dict[str, Any]:
    """A channel whose files stay plain attachments (the drive switch off)."""
    channel = await make_channel(client, name, [])
    switched = await client.patch(f"{API}/channels/{channel['id']}", json={"files_to_drive": False})
    assert switched.status_code == 200, switched.text
    return channel


async def test_an_edit_takes_a_file_off_and_adds_one(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await plain_channel(client, "lab")
    sent = await post(client, lab["id"], [("a.txt", b"a"), ("b.txt", b"b"), ("c.txt", b"c")])
    a, b, c = (f["id"] for f in sent["attachments"])
    new = await upload_file(client, "d.txt", b"d")

    edited = await edit(client, sent["id"], sent["body"], [a, c, new])
    assert edited.status_code == 200, edited.text
    out = edited.json()
    # The kept ones stay in their place; the new one follows.
    assert [f["id"] for f in out["attachments"]] == [a, c, new]
    assert out["edited_at"] is not None
    # The one taken off is gone at once (GC removes the bytes); the new one is the message's.
    gone = await row(db, b)
    assert gone.status == "deleted" and gone.deleted_at is not None
    assert (await client.get(f"{API}/attachments/{b}/content")).status_code == 404
    added = await row(db, new)
    assert added.status == "attached" and added.message_id == uuid.UUID(sent["id"])
    assert (await client.get(f"{API}/attachments/{new}/content")).content == b"d"
    # The same body keeps no revision (M14c); the event carries the files.
    assert (await client.get(f"{API}/messages/{sent['id']}/revisions")).json() == []
    events = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "message.updated")
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    last = events[-1].payload
    assert last["change"] == "body"
    assert [f["id"] for f in last["message"]["attachments"]] == [a, c, new]


async def test_files_only_and_the_older_clients(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await plain_channel(client, "lab")
    sent = await post(client, lab["id"], [("a.png", b"a"), ("b.png", b"b")])
    a, b = (f["id"] for f in sent["attachments"])

    # A message of files only: an empty body with files left is fine.
    kept = await edit(client, sent["id"], "", [b])
    assert kept.status_code == 200, kept.text
    assert kept.json()["body"] == "" and [f["id"] for f in kept.json()["attachments"]] == [b]
    # Nothing left would be a delete.
    assert (await edit(client, sent["id"], "", [])).status_code == 422
    assert (await edit(client, sent["id"], "  ", None)).status_code == 422

    # An older client sends the body only: the files stay.
    older = await edit(client, sent["id"], "a caption", None)
    assert older.status_code == 200, older.text
    assert [f["id"] for f in older.json()["attachments"]] == [b]
    assert (await row(db, a)).status == "deleted"


async def test_a_retried_edit_changes_nothing_more(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    sent = await post(client, lab["id"], [("a.txt", b"a")])
    a = sent["attachments"][0]["id"]
    new = await upload_file(client, "b.txt", b"b")
    first = await edit(client, sent["id"], "files", [new])
    again = await edit(client, sent["id"], "files", [new])
    assert first.status_code == again.status_code == 200, again.text
    assert [f["id"] for f in again.json()["attachments"]] == [new]
    # One drive item for the new file (filed once), the old one in the trash once.
    added = await row(db, new)
    assert added.drive_state == "available" and added.drive_item_id is not None
    trashed = (
        (await db.execute(select(AuditLog).where(AuditLog.action == "drive.trash"))).scalars().all()
    )
    assert len(trashed) == 1 and trashed[0].details["via"] == "message_edit"
    taken = await row(db, a)
    assert taken.message_id is None and taken.drive_state is None


async def test_the_channel_drive_follows_the_delete_rule(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    sent = await post(client, lab["id"], [("oops.pdf", PDF), ("data.txt", b"one")])
    oops, data = sent["attachments"]
    # data.txt changed in the drive since it was posted (a new version).
    item = await item_row(db, data["drive"]["item_id"])
    assert item is not None
    await upload(client, str(item.parent_id), "data.txt", b"two", on_conflict="version")
    new = await upload_file(client, "fixed.pdf", PDF)

    edited = await edit(client, sent["id"], "files", [new])
    assert edited.status_code == 200, edited.text
    [shown] = edited.json()["attachments"]
    assert shown["id"] == new and shown["drive"]["state"] == "available"
    assert shown["drive"]["version_number"] == 1  # filed in the month folder like a send

    # Mine and unchanged: in the drive's trash (30 days to bring it back), off the message.
    taken = await row(db, oops["id"])
    assert taken.message_id is None and taken.drive_state is None and taken.status == "attached"
    in_trash = await item_row(db, oops["drive"]["item_id"])
    assert in_trash is not None and in_trash.trashed_at is not None
    audit = (
        await db.execute(select(AuditLog).where(AuditLog.action == "drive.trash"))
    ).scalar_one()
    assert audit.details == {
        "via": "message_edit",
        "message_id": sent["id"],
        "location_id": str(in_trash.location_id),
        "name": "oops.pdf",
    }
    # Changed since: it stays in the drive, an ordinary older version now.
    stays = await item_row(db, item.id)
    assert stays is not None and stays.trashed_at is None
    old = await row(db, data["id"])
    assert old.message_id is None and old.drive_state is None and old.status == "attached"


async def test_what_an_edit_cannot_add(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    lab = await plain_channel(client, "lab")
    await client.post(f"{API}/channels/{lab['id']}/members", json={"user_id": str(bob.id)})
    mine = await post(client, lab["id"], [("a.txt", b"a")])
    other = await post(client, lab["id"], [("b.txt", b"b")])
    a = mine["attachments"][0]["id"]

    # A file of another message, someone else's upload, an id that is no upload.
    stolen = await edit(client, mine["id"], "x", [a, other["attachments"][0]["id"]])
    assert stolen.status_code == 400 and stolen.json()["error"]["code"] == "attachment_invalid"
    as_user(bob)
    his = await upload_file(client, "bob.txt", b"b")
    as_user(alice)
    assert (await edit(client, mine["id"], "x", [a, his])).status_code == 400
    assert (await edit(client, mine["id"], "x", [str(uuid.uuid4())])).status_code == 400
    # Nothing changed by the refused edits.
    assert (await row(db, a)).status == "attached"
    # More than 10 files.
    many = [await upload_file(client, f"{i}.txt", b"x") for i in range(10)]
    assert (await edit(client, mine["id"], "x", [a, *many])).status_code == 422
    # Only the author edits (the files too).
    as_user(bob)
    refused = await edit(client, mine["id"], "x", [])
    assert refused.status_code in (403, 422)
    assert (await edit(client, mine["id"], "x", [a])).status_code == 403


async def test_a_deleted_file_can_be_taken_off(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """A 「削除されたファイル」 (the drive purged it) is listed like a file; leaving it out removes
    the tombstone from the message."""
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    sent = await post(client, lab["id"], [("a.txt", b"a"), ("b.txt", b"b")])
    a, b = sent["attachments"]
    tomb = await row(db, a["id"])
    tomb.status = "purged"
    tomb.drive_state = "deleted"
    await db.commit()
    shown = (await client.get(f"{API}/messages/{sent['id']}")).json()["attachments"]
    assert [f["id"] for f in shown] == [a["id"], b["id"]]

    edited = await edit(client, sent["id"], "files", [b["id"]])
    assert edited.status_code == 200, edited.text
    assert [f["id"] for f in edited.json()["attachments"]] == [b["id"]]
    gone = await row(db, a["id"])
    assert gone.status == "deleted" and gone.drive_state is None
