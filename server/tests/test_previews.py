"""Document previews (M108, docs/PREVIEWS.md): queueing, the loop, retries, the API, the CLI."""

import io
import uuid
import zipfile
from collections.abc import Callable
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.attachments import previews
from app.modules.attachments import service as attachments
from app.modules.attachments.blobstore import MemoryBlobStore
from app.modules.attachments.models import Attachment
from app.modules.attachments.preview_kinds import source_kind, wants_preview
from app.modules.users.models import User
from tests.helpers import make_user

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def pdf_bytes(pages: int = 2, size: tuple[int, int] = (612, 792)) -> bytes:
    """A real PDF of `pages` pages (Pillow writes one page per image, 72 dpi = points)."""
    images = [Image.new("RGB", size, (255, 255, 255)) for _ in range(pages)]
    out = io.BytesIO()
    images[0].save(out, format="PDF", save_all=True, append_images=images[1:], resolution=72)
    return out.getvalue()


def docx_bytes() -> bytes:
    """A minimal Word file `filetype` recognises as DOCX."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/'
            'content-types"><Override PartName="/word/document.xml" ContentType="application/'
            'vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        )
        z.writestr("_rels/.rels", "<Relationships/>")
        z.writestr("word/document.xml", "<w:document/>")
    return out.getvalue()


class FakeConverter:
    """Stands in for Gotenberg: writes a PDF of `pages` pages, or raises what it is told to."""

    def __init__(self, pages: int = 3) -> None:
        self.pages = pages
        self.calls: list[str] = []
        self.error: previews.PreviewError | None = None

    async def to_pdf(self, source: Path, kind: str, dest: Path) -> None:
        self.calls.append(kind)
        assert source.read_bytes()  # noqa: ASYNC240 - the original was downloaded to a local file
        if self.error is not None:
            raise self.error
        dest.write_bytes(pdf_bytes(self.pages, size=(960, 540)))  # noqa: ASYNC240 - a slide


def enable(app: FastAPI, converter: FakeConverter | None) -> Settings:
    settings: Settings = app.state.settings.model_copy(
        update={
            "previews_enabled": True,
            "preview_converter_url": "http://converter:3000" if converter else "",
        }
    )
    app.state.settings = settings
    app.state.preview_converter = converter
    return settings


async def upload(client: AsyncClient, name: str, data: bytes, claimed: str) -> Any:
    response = await client.post("/api/v1/attachments", files={"file": (name, data, claimed)})
    assert response.status_code == 201, response.text
    return response.json()


async def run_loop(app: FastAPI, settings: Settings) -> int:
    """What the preview loop does until nothing is due."""
    done = 0
    while await previews.process_due(
        app.state.db, app.state.blobs, app.state.preview_converter, settings
    ):
        done += 1
    return done


async def row(db: AsyncSession, attachment_id: str) -> Attachment:
    # Not expire_all(): the acting user (as_user) lives in this session too.
    found = await db.get(Attachment, uuid.UUID(attachment_id))
    assert found is not None
    await db.refresh(found)
    return found


def test_source_kind_and_eligibility() -> None:
    assert source_kind("application/pdf", "x.bin") == "pdf"
    assert source_kind(DOCX, "whatever") == "docx"
    assert source_kind("application/vnd.ms-powerpoint", "a") == "ppt"
    assert source_kind("application/vnd.oasis.opendocument.spreadsheet", "a") == "ods"
    # A container the sniffer could not place: the name's extension, only an Office one.
    assert source_kind("application/zip", "report.XLSX") == "xlsx"
    assert source_kind("application/octet-stream", "old.doc") == "doc"
    assert source_kind("application/zip", "archive.zip") is None
    assert source_kind("application/octet-stream", "docx") is None
    assert source_kind("image/png", "a.pdf") is None

    def ok(content_type: str, size: int, converter: bool) -> bool:
        name = "a.pdf" if content_type == "application/pdf" else "a.docx"
        return wants_preview(
            content_type, name, size, enabled=True, converter=converter, max_bytes=1000
        )

    assert ok("application/pdf", 10, converter=False)
    assert not ok(DOCX, 10, converter=False)
    assert ok(DOCX, 10, converter=True)
    assert not ok(DOCX, 1001, converter=True)
    assert not wants_preview(
        "application/pdf", "a.pdf", 10, enabled=False, converter=True, max_bytes=1000
    )


async def test_office_file_preview_flow_and_endpoints(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    converter = FakeConverter(pages=3)
    settings = enable(app, converter)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    meta = await upload(client, "議事録.docx", docx_bytes(), "application/octet-stream")
    assert meta["content_type"] == DOCX
    assert meta["preview"] == {"status": "pending", "pages": None, "width": None, "height": None}
    assert app.state.preview_wake.is_set()  # the upload woke the loop; it did not convert
    assert converter.calls == []
    # Not ready yet: no thumbnail, no PDF.
    pending = await client.get(f"/api/v1/attachments/{meta['id']}/preview/thumbnail")
    assert pending.status_code == 404 and pending.json()["error"]["code"] == "preview_not_found"

    assert await run_loop(app, settings) == 1
    assert converter.calls == ["docx"]
    out = (await client.get(f"/api/v1/attachments/{meta['id']}")).json()
    assert out["preview"] == {"status": "ready", "pages": 3, "width": 800, "height": 450}
    stored = await row(db, meta["id"])
    assert stored.preview_pdf_key == f"attachments/{meta['id']}.preview.pdf"
    assert stored.preview_thumb_key == f"attachments/{meta['id']}.preview.webp"
    assert stored.preview_attempts == 1 and stored.preview_next_at is None

    thumb = await client.get(f"/api/v1/attachments/{meta['id']}/preview/thumbnail")
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/webp"
    assert thumb.headers["x-content-type-options"] == "nosniff"
    assert Image.open(io.BytesIO(thumb.content)).size == (800, 450)
    pdf = await client.get(f"/api/v1/attachments/{meta['id']}/preview/pdf")
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.headers["content-disposition"].startswith('inline; filename="')
    assert "filename*=UTF-8''%E8%AD%B0%E4%BA%8B%E9%8C%B2.pdf" in pdf.headers["content-disposition"]
    assert pdf.headers["content-security-policy"] == "sandbox"
    assert pdf.headers["x-content-type-options"] == "nosniff"
    # The original still downloads as an attachment, never inline.
    original = await client.get(f"/api/v1/attachments/{meta['id']}/content?inline=1")
    assert original.headers["content-disposition"].startswith("attachment;")

    # A pending upload's preview is the uploader's only, like the file.
    as_user(bob)
    for path in ("preview/thumbnail", "preview/pdf"):
        denied = await client.get(f"/api/v1/attachments/{meta['id']}/{path}")
        assert denied.status_code == 403

    # Nothing left to do: the loop finds nothing.
    assert await run_loop(app, settings) == 0

    # The GC removes the preview's objects with the file.
    blobs: MemoryBlobStore = app.state.blobs
    assert await attachments.verify(db, blobs) == []
    await attachments.gc(db, blobs, now=utcnow() + timedelta(hours=25), pending_ttl_hours=24)
    assert not [k for k in blobs.objects if meta["id"] in k]


async def test_pdf_preview_needs_no_converter_and_serves_the_original(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    settings = enable(app, None)
    alice = await make_user(db, "alice")
    as_user(alice)
    data = pdf_bytes(2)
    meta = await upload(client, "paper.pdf", data, "application/pdf")
    assert meta["preview"]["status"] == "pending"
    # An Office file without a converter gets no preview at all.
    doc = await upload(client, "a.docx", docx_bytes(), DOCX)
    assert doc["preview"] is None

    assert await run_loop(app, settings) == 1
    out = (await client.get(f"/api/v1/attachments/{meta['id']}")).json()
    assert out["preview"] == {"status": "ready", "pages": 2, "width": 800, "height": 1036}
    stored = await row(db, meta["id"])
    assert stored.preview_pdf_key is None  # the original is the preview
    pdf = await client.get(f"/api/v1/attachments/{meta['id']}/preview/pdf")
    assert pdf.content == data and pdf.headers["content-length"] == str(len(data))
    assert pdf.headers["content-disposition"].startswith('inline; filename="paper.pdf"')


async def test_preview_of_a_sent_file_is_announced(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    settings = enable(app, FakeConverter(pages=1))
    alice = await make_user(db, "alice")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    meta = await upload(client, "slides.docx", docx_bytes(), DOCX)
    posted = await client.post(
        f"/api/v1/channels/{channel['id']}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "資料", "attachment_ids": [meta["id"]]},
    )
    assert posted.status_code == 201
    message = posted.json()
    assert message["attachments"][0]["preview"]["status"] == "pending"

    assert await run_loop(app, settings) == 1
    events = list((await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars())
    updated = [e for e in events if e.event_type == "message.updated"]
    assert len(updated) == 1
    payload = updated[0].payload
    assert payload["change"] == "attachments"
    assert payload["message"]["attachments"][0]["preview"]["status"] == "ready"
    assert payload["message"]["updated_seq"] > message["seq"]
    assert updated[0].seq == payload["message"]["updated_seq"]
    history = (await client.get(f"/api/v1/channels/{channel['id']}/messages")).json()
    assert history["messages"][0]["attachments"][0]["preview"]["pages"] == 1


async def test_temporary_failures_back_off_then_fail(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    converter = FakeConverter()
    converter.error = previews.PreviewError("converter timed out", permanent=False)
    settings = enable(app, converter)
    alice = await make_user(db, "alice")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    meta = await upload(client, "a.docx", docx_bytes(), DOCX)
    await client.post(
        f"/api/v1/channels/{channel['id']}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "x", "attachment_ids": [meta["id"]]},
    )

    assert await run_loop(app, settings) == 1  # one try, then it waits
    stored = await row(db, meta["id"])
    assert stored.preview_status == "pending" and stored.preview_attempts == 1
    assert stored.preview_error == "converter timed out"
    assert stored.preview_next_at is not None and stored.preview_next_at > utcnow()
    assert await run_loop(app, settings) == 0  # not due yet

    for attempt in (2, 3):
        stored.preview_next_at = utcnow() - timedelta(seconds=1)
        await db.commit()
        assert await run_loop(app, settings) == 1
        stored = await row(db, meta["id"])
        assert stored.preview_attempts == attempt
    assert stored.preview_status == "failed" and stored.preview_next_at is None
    assert converter.calls == ["docx"] * 3
    # Failing is announced (the card stops saying 「作成中」); waiting was not.
    events = list((await db.execute(select(OutboxEvent))).scalars())
    updated = [e for e in events if e.event_type == "message.updated"]
    assert len(updated) == 1
    assert updated[0].payload["message"]["attachments"][0]["preview"]["status"] == "failed"
    out = (await client.get(f"/api/v1/attachments/{meta['id']}")).json()
    assert out["preview"]["status"] == "failed"
    assert (await client.get(f"/api/v1/attachments/{meta['id']}/preview/pdf")).status_code == 404


async def test_permanent_failures_and_unreadable_pdfs_fail_at_once(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    converter = FakeConverter()
    converter.error = previews.PreviewError("converter answered 400: bad file", permanent=True)
    settings = enable(app, converter)
    alice = await make_user(db, "alice")
    as_user(alice)
    doc = await upload(client, "a.docx", docx_bytes(), DOCX)
    broken = await upload(client, "b.pdf", b"%PDF-1.7\nnot really a pdf", "application/pdf")
    assert broken["preview"]["status"] == "pending"
    assert await run_loop(app, settings) == 2
    for attachment_id in (doc["id"], broken["id"]):
        stored = await row(db, attachment_id)
        assert stored.preview_status == "failed" and stored.preview_attempts == 1
    assert (await row(db, broken["id"])).preview_error == "the PDF could not be rendered"
    assert not [k for k in app.state.blobs.objects if ".preview." in k]


async def test_a_lease_that_runs_out_is_retried_and_finally_given_up(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    settings = enable(app, FakeConverter())
    alice = await make_user(db, "alice")
    as_user(alice)
    meta = await upload(client, "a.docx", docx_bytes(), DOCX)
    # A server that died during its last allowed try left the lease behind.
    stored = await row(db, meta["id"])
    stored.preview_attempts = settings.preview_max_attempts
    stored.preview_next_at = utcnow() - timedelta(seconds=1)
    await db.commit()
    claimed = await previews.claim_next(db, settings)
    assert claimed == (uuid.UUID(meta["id"]), True)
    # Claimed rows are leased: a second claim does not take it.
    assert await previews.claim_next(db, settings) is None
    status = await previews.process_one(
        db, app.state.blobs, app.state.preview_converter, settings, claimed[0], give_up=True
    )
    assert status == "failed"
    assert "gave up" in ((await row(db, meta["id"])).preview_error or "")


async def test_a_file_deleted_meanwhile_leaves_nothing_behind(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)

    class DeletingConverter(FakeConverter):
        async def to_pdf(self, source: Path, kind: str, dest: Path) -> None:
            await super().to_pdf(source, kind, dest)
            await attachments.mark_ids_deleted_in_tx(db, [uuid.UUID(meta["id"])])
            await db.commit()

    settings = enable(app, DeletingConverter())
    meta = await upload(client, "a.docx", docx_bytes(), DOCX)
    assert await run_loop(app, settings) == 1
    assert (await row(db, meta["id"])).preview_status == "pending"  # never recorded
    assert not [k for k in app.state.blobs.objects if ".preview." in k]


async def test_generate_previews_for_stored_files(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    # Uploaded while previews were off: no preview, nothing queued.
    off = enable(app, None)
    app.state.settings = off.model_copy(update={"previews_enabled": False})
    alice = await make_user(db, "alice")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    ids = []
    for name, data, claimed in (
        ("a.docx", docx_bytes(), DOCX),
        ("b.pdf", pdf_bytes(1), "application/pdf"),
        ("c.txt", b"plain", "text/plain"),
        ("d.docx", docx_bytes(), DOCX),
    ):
        meta = await upload(client, name, data, claimed)
        assert meta["preview"] is None
        ids.append(meta["id"])
    await client.post(
        f"/api/v1/channels/{channel['id']}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "x", "attachment_ids": ids[:2]},
    )

    converter = FakeConverter(pages=2)
    settings = enable(app, converter)
    blobs = app.state.blobs
    first = await previews.generate_stored(db, blobs, converter, settings, limit=2)
    assert (first.tried, first.ready, first.remaining) == (2, 2, True)
    rest = await previews.generate_stored(db, blobs, converter, settings, limit=10)
    assert (rest.tried, rest.ready, rest.remaining) == (1, 1, False)
    statuses = [(await row(db, i)).preview_status for i in ids]
    assert statuses == ["ready", "ready", "none", "ready"]
    # The two files already in a message were announced (one event each).
    events = list((await db.execute(select(OutboxEvent))).scalars())
    assert len([e for e in events if e.event_type == "message.updated"]) == 2
    again = await previews.generate_stored(db, blobs, converter, settings, limit=10)
    assert again.tried == 0

    # --retry-failed takes failed ones again; without it they stay.
    stored = await row(db, ids[3])
    stored.preview_status = "failed"
    await db.commit()
    assert (await previews.generate_stored(db, blobs, converter, settings)).tried == 0
    retried = await previews.generate_stored(db, blobs, converter, settings, retry_failed=True)
    assert (retried.tried, retried.ready) == (1, 1)

    with pytest.raises(RuntimeError):
        await previews.generate_stored(
            db, blobs, converter, settings.model_copy(update={"previews_enabled": False})
        )


async def test_gotenberg_converter_maps_answers(tmp_path: Path) -> None:
    source = tmp_path / "source.docx"
    source.write_bytes(docx_bytes())
    seen: list[httpx.Request] = []

    def answer(status: int, body: bytes) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(status, content=body)

        return httpx.MockTransport(handler)

    def converter(status: int, body: bytes, max_output: int = 10_000) -> Any:
        return previews.GotenbergConverter(
            "http://converter:3000/",
            timeout=5,
            max_output=max_output,
            transport=answer(status, body),
        )

    dest = tmp_path / "out.pdf"
    await converter(200, b"%PDF-1.7 ok").to_pdf(source, "docx", dest)
    assert dest.read_bytes() == b"%PDF-1.7 ok"
    request = seen[-1]
    assert str(request.url) == "http://converter:3000/forms/libreoffice/convert"
    body = request.read()
    assert b'name="files"; filename="document.docx"' in body  # our name, never the user's

    with pytest.raises(previews.PreviewError) as refused:
        await converter(400, b"invalid").to_pdf(source, "docx", dest)
    assert refused.value.permanent and "400" in refused.value.reason
    with pytest.raises(previews.PreviewError) as busy:
        await converter(503, b"timeout").to_pdf(source, "docx", dest)
    assert not busy.value.permanent
    with pytest.raises(previews.PreviewError) as huge:
        await converter(200, b"x" * 20_000).to_pdf(source, "docx", dest)
    assert huge.value.permanent

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route", request=request)

    down = previews.GotenbergConverter(
        "http://converter:3000", timeout=5, max_output=1, transport=httpx.MockTransport(unreachable)
    )
    with pytest.raises(previews.PreviewError) as gone:
        await down.to_pdf(source, "docx", dest)
    assert not gone.value.permanent
