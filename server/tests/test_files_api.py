"""GET /files (M11i): attached files in my channels, newest first, with a keyset cursor."""

import uuid
from collections.abc import Callable

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_attachments import png_bytes, upload


async def _post_with(client: AsyncClient, channel_id: str, body: str, ids: list[str]) -> dict:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body, "attachment_ids": ids},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def test_files_list_filters_pages_and_hides_deleted(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    private = (
        await client.post("/api/v1/channels", json={"name": "ops", "type": "private"})
    ).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{general['id']}/join")

    as_user(alice)
    photo = (await upload(client, "photo.png", png_bytes(), "image/png")).json()["id"]
    notes = (await upload(client, "release-notes.txt", b"v0.9", "text/plain")).json()["id"]
    first = await _post_with(client, general["id"], "two files", [photo, notes])
    secret = (await upload(client, "secret.txt", b"shh", "text/plain")).json()["id"]
    await _post_with(client, private["id"], "private file", [secret])
    pending = await upload(client, "pending.txt", b"never sent", "text/plain")
    assert pending.status_code == 201

    # Alice sees everything attached in her channels, newest first; the pending upload is absent.
    listed = (await client.get("/api/v1/files")).json()
    names = [item["attachment"]["filename"] for item in listed["items"]]
    assert names == ["secret.txt", "photo.png", "release-notes.txt"]
    row = listed["items"][1]
    assert row["message_id"] == first["id"]
    assert row["channel_id"] == general["id"]
    assert row["uploader_id"] == str(alice.id)
    assert row["parent_id"] is None
    assert row["attachment"]["has_thumbnail"] is True
    assert listed["next_cursor"] is None

    # Channel scope and a filename filter (case-insensitive substring, `%` is literal).
    scoped = (await client.get("/api/v1/files", params={"channel_id": general["id"]})).json()
    assert [i["attachment"]["filename"] for i in scoped["items"]] == [
        "photo.png",
        "release-notes.txt",
    ]
    found = (await client.get("/api/v1/files", params={"q": "NOTES"})).json()
    assert [i["attachment"]["filename"] for i in found["items"]] == ["release-notes.txt"]
    assert (await client.get("/api/v1/files", params={"q": "%"})).json()["items"] == []

    # Keyset paging keeps the two attachments of one message apart.
    page1 = (await client.get("/api/v1/files", params={"limit": 2})).json()
    assert [i["attachment"]["filename"] for i in page1["items"]] == ["secret.txt", "photo.png"]
    assert page1["next_cursor"]
    page2 = (
        await client.get("/api/v1/files", params={"limit": 2, "cursor": page1["next_cursor"]})
    ).json()
    assert [i["attachment"]["filename"] for i in page2["items"]] == ["release-notes.txt"]
    assert page2["next_cursor"] is None
    bad = await client.get("/api/v1/files", params={"cursor": "nonsense"})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid_cursor"

    # Bob is only in #general; Carol is in nothing; scoping to a foreign channel yields nothing.
    as_user(bob)
    bobs = (await client.get("/api/v1/files")).json()
    assert [i["attachment"]["filename"] for i in bobs["items"]] == [
        "photo.png",
        "release-notes.txt",
    ]
    foreign = (await client.get("/api/v1/files", params={"channel_id": private["id"]})).json()
    assert foreign["items"] == []
    as_user(carol)
    assert (await client.get("/api/v1/files")).json()["items"] == []

    # A file on a thread reply carries the parent id so clients can open the thread.
    as_user(alice)
    reply_file = (await upload(client, "reply.txt", b"in thread", "text/plain")).json()["id"]
    reply = await client.post(
        f"/api/v1/channels/{general['id']}/messages",
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": "see attached",
            "parent_id": first["id"],
            "attachment_ids": [reply_file],
        },
    )
    assert reply.status_code == 201, reply.text
    newest = (await client.get("/api/v1/files", params={"limit": 1})).json()["items"][0]
    assert newest["attachment"]["filename"] == "reply.txt"
    assert newest["parent_id"] == first["id"]

    # Deleting the message drops its files from the list.
    as_user(alice)
    assert (await client.delete(f"/api/v1/messages/{first['id']}")).status_code == 200
    after = (await client.get("/api/v1/files")).json()
    assert [i["attachment"]["filename"] for i in after["items"]] == ["reply.txt", "secret.txt"]
