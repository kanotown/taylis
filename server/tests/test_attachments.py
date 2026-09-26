"""Attachments (M9a): upload, sniffing, thumbnails, binding, access rules, deletion, GC, verify."""

import io
import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import MemoryBlobStore
from app.modules.attachments.models import Attachment
from app.modules.users.models import User
from tests.helpers import make_user


def png_bytes(width: int = 64, height: int = 48) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (200, 100, 50)).save(out, format="PNG")
    return out.getvalue()


async def upload(client: AsyncClient, name: str, data: bytes, claimed: str) -> Any:
    return await client.post("/api/v1/attachments", files={"file": (name, data, claimed)})


async def test_upload_sniffs_type_makes_thumbnails_and_enforces_limits(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)

    image = await upload(client, "../../photo.png", png_bytes(), "text/plain")
    assert image.status_code == 201, image.text
    meta = image.json()
    assert meta["filename"] == "photo.png"  # path separators stripped
    assert meta["content_type"] == "image/png"  # sniffed, not the claimed type
    assert (meta["width"], meta["height"]) == (64, 48)
    assert meta["has_thumbnail"] is True and meta["status"] == "pending"

    text = await upload(client, "notes.txt", b"plain text", "text/html")
    assert text.status_code == 201
    assert text.json()["content_type"] == "application/octet-stream"
    assert text.json()["filename"] == "notes.txt"
    assert text.json()["has_thumbnail"] is False
    assert attachments.sanitize_filename("notes\x00\x1f.txt") == "notes.txt"
    assert attachments.sanitize_filename("..\\evil\\x/y.png") == "y.png"
    assert attachments.sanitize_filename("") == "file"

    too_big = await upload(client, "big.bin", b"x" * 200_001, "application/octet-stream")
    assert too_big.status_code == 413 and too_big.json()["error"]["code"] == "attachment_too_large"
    empty = await upload(client, "empty.bin", b"", "application/octet-stream")
    assert empty.status_code == 400

    # Pending: the uploader can read it, nobody else can.
    thumb = await client.get(f"/api/v1/attachments/{meta['id']}/thumbnail")
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/jpeg"
    assert Image.open(io.BytesIO(thumb.content)).size == (64, 48)
    bob = await make_user(db, "bob")
    as_user(bob)
    denied = await client.get(f"/api/v1/attachments/{meta['id']}/content")
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_uploader"


async def test_bind_download_delete_and_gc(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{channel['id']}/join")

    as_user(alice)
    image_id = (await upload(client, "photo.png", png_bytes(), "image/png")).json()["id"]
    file_id = (await upload(client, "doc.html", b"<script>alert(1)</script>", "text/html")).json()[
        "id"
    ]
    as_user(bob)
    bobs_id = (await upload(client, "b.bin", b"bob's", "application/octet-stream")).json()["id"]

    as_user(alice)
    base = f"/api/v1/channels/{channel['id']}/messages"
    # Someone else's upload and an unknown id are rejected; the message is not created.
    rejected = await client.post(
        base, json={"client_msg_id": str(uuid.uuid4()), "body": "x", "attachment_ids": [bobs_id]}
    )
    assert rejected.status_code == 400 and rejected.json()["error"]["code"] == "attachment_invalid"
    unknown = await client.post(
        base,
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": "x",
            "attachment_ids": [str(uuid.uuid4())],
        },
    )
    assert unknown.status_code == 400
    too_many = await client.post(
        base,
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": "x",
            "attachment_ids": [str(uuid.uuid4())] * 11,
        },
    )
    assert too_many.status_code == 422
    no_body = await client.post(base, json={"client_msg_id": str(uuid.uuid4()), "body": "  "})
    assert no_body.status_code == 422

    # An attachment-only message binds both uploads.
    posted = await client.post(
        base,
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": "",
            "attachment_ids": [image_id, file_id],
        },
    )
    assert posted.status_code == 201, posted.text
    message = posted.json()
    assert [a["id"] for a in message["attachments"]] == [image_id, file_id]
    assert all(a["status"] == "attached" for a in message["attachments"])
    reuse = await client.post(
        base,
        json={"client_msg_id": str(uuid.uuid4()), "body": "again", "attachment_ids": [image_id]},
    )
    assert reuse.status_code == 400  # no longer pending

    history = (await client.get(base)).json()
    assert [a["filename"] for a in history["messages"][0]["attachments"]] == [
        "photo.png",
        "doc.html",
    ]
    events = list((await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars())
    created = next(e for e in events if e.event_type == "message.created")
    assert [a["id"] for a in created.payload["message"]["attachments"]] == [image_id, file_id]

    # Members download; inline only for images; HTML is always an attachment.
    as_user(bob)
    content = await client.get(f"/api/v1/attachments/{image_id}/content?inline=1")
    assert content.status_code == 200 and content.content == png_bytes()
    assert content.headers["content-disposition"].startswith("inline;")
    assert content.headers["x-content-type-options"] == "nosniff"
    html = await client.get(f"/api/v1/attachments/{file_id}/content?inline=1")
    assert html.headers["content-disposition"].startswith("attachment;")
    assert html.headers["content-type"] == "application/octet-stream"
    assert (await client.get(f"/api/v1/attachments/{image_id}")).json()["filename"] == "photo.png"
    as_user(carol)
    assert (await client.get(f"/api/v1/attachments/{image_id}/content")).status_code == 403

    # Deleting the message hides the files at once; GC removes the bytes and expired uploads.
    as_user(alice)
    assert (await client.delete(f"/api/v1/messages/{message['id']}")).status_code == 200
    as_user(bob)
    assert (await client.get(f"/api/v1/attachments/{image_id}/content")).status_code == 404
    blobs: MemoryBlobStore = app.state.blobs
    assert f"attachments/{image_id}" in blobs.objects
    removed, purged = await attachments.gc(
        db, blobs, now=utcnow() + timedelta(hours=25), pending_ttl_hours=24
    )
    assert (removed, purged) == (1, 2)  # bob's pending upload expired; the two attached ones purged
    assert f"attachments/{image_id}" not in blobs.objects
    assert f"attachments/{image_id}.thumb.jpg" not in blobs.objects
    assert f"attachments/{bobs_id}" not in blobs.objects
    assert list((await db.execute(select(Attachment))).scalars()) == []


async def test_verify_reports_missing_blobs(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    meta = (await upload(client, "a.bin", b"bytes", "application/octet-stream")).json()
    blobs: MemoryBlobStore = app.state.blobs
    assert await attachments.verify(db, blobs) == []
    del blobs.objects[f"attachments/{meta['id']}"]
    assert await attachments.verify(db, blobs) == [
        (uuid.UUID(meta["id"]), f"attachments/{meta['id']}")
    ]


async def test_thumbnail_honours_exif_orientation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """A portrait phone photo (landscape pixels + orientation tag) must come out upright."""
    from PIL import Image

    alice = await make_user(db, "alice")
    as_user(alice)
    source = Image.new("RGB", (120, 60), "red")
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90° clockwise to display
    raw = io.BytesIO()
    source.save(raw, format="JPEG", exif=exif.tobytes())
    uploaded = await client.post(
        "/api/v1/attachments", files={"file": ("portrait.jpg", raw.getvalue(), "image/jpeg")}
    )
    assert uploaded.status_code == 201, uploaded.text
    meta = uploaded.json()
    assert (meta["width"], meta["height"]) == (60, 120)
    thumb = await client.get(f"/api/v1/attachments/{meta['id']}/thumbnail")
    assert thumb.status_code == 200
    with Image.open(io.BytesIO(thumb.content)) as image:
        assert image.height > image.width
