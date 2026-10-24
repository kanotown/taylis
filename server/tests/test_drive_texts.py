"""The text inside drive files and the content search (docs/DRIVE.md §29, migration 0121).

Fixtures (tests/fixtures/drive_text): report.docx (two pages, Japanese and English, written by
hand as a minimal Word file), report.pdf (that file converted by Gotenberg's LibreOffice, as
the preview does), encrypted.pdf (report.pdf with a user password, AES-128). A scanned PDF is
made here (Pillow writes image-only pages).
"""

import io
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.modules.attachments import previews
from app.modules.attachments.pdf_text import clean, cut
from app.modules.drive import texts
from app.modules.drive.models import DriveText
from app.modules.search.snippet import mark, window_snippet
from app.modules.users.models import User
from tests.drive_helpers import act_as, drive_settings, location, upload, workspace_root
from tests.helpers import make_user

API = "/api/v1"
FIXTURES = Path(__file__).parent / "fixtures" / "drive_text"
# Full-width letters, written as escapes (the linter flags them as look-alikes).
FULL_ABC = "\uff21\uff22\uff23"
FULL_QUALITY = "\uff31\uff35\uff21\uff2c\uff29\uff34\uff39"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def scanned_pdf(pages: int = 2) -> bytes:
    images = [Image.new("RGB", (612, 792), (255, 255, 255)) for _ in range(pages)]
    out = io.BytesIO()
    images[0].save(out, format="PDF", save_all=True, append_images=images[1:], resolution=72)
    return out.getvalue()


def settings_of(app: FastAPI) -> Settings:
    found: Settings = app.state.settings
    return found


async def index_all(app: FastAPI) -> int:
    """What the media loop's text step does until nothing is due."""
    done = 0
    while await texts.process_due(app.state.db.session_factory, settings_of(app), app.state.blobs):
        done += 1
        assert done < 100
    return done


async def search(client: AsyncClient, q: str, **params: Any) -> dict[str, Any]:
    response = await client.get(f"{API}/search/drive", params={"q": q, "content": "true", **params})
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def names(client: AsyncClient, q: str, **params: Any) -> list[str]:
    return sorted(hit["item"]["name"] for hit in (await search(client, q, **params))["items"])


async def row_of(db: AsyncSession, item_id: str) -> DriveText | None:
    db.expire_all()
    return (
        await db.execute(select(DriveText).where(DriveText.item_id == uuid.UUID(item_id)))
    ).scalar_one_or_none()


def snippet_text(hit: dict[str, Any]) -> str:
    return "".join(part["text"] for part in hit["snippet"])


def marked(hit: dict[str, Any]) -> list[str]:
    return [part["text"] for part in hit["snippet"] if part["hit"]]


# --- the pieces ------------------------------------------------------------------------------


def test_clean_joins_japanese_lines_and_folds_widths() -> None:
    assert clean("研究計\n画について\nand the\nresult", join_lines=True) == (
        "研究計画について and the result"
    )
    assert clean("photo-\nnic crystal", join_lines=True) == "photonic crystal"
    # NFKC: full-width letters and half-width kana, as PGroonga folds them; controls go.
    assert clean(FULL_ABC + "\u3000" + "ｶﾀｶﾅ\x00\x07 x", join_lines=False) == "ABC カタカナ x"
    assert clean("a\r\n\r\n\r\n\r\nb", join_lines=False) == "a\n\nb"
    assert cut("あいう", 7) == "あい"  # never half a character


def test_kinds_and_decoding() -> None:
    assert texts.kind_of("application/pdf", "a.PDF") == "pdf"
    assert texts.kind_of("application/octet-stream", "paper.pdf") == "pdf"
    assert texts.kind_of(DOCX, "a.docx") == "office"
    assert texts.kind_of("application/zip", "old.docx") == "office"
    assert texts.kind_of("application/octet-stream", "memo.md") == "text"
    assert texts.kind_of("application/octet-stream", "data.CSV") == "text"
    assert texts.kind_of("application/zip", "memo.txt") is None
    assert texts.kind_of("image/png", "a.png") is None
    assert texts.decode_text("日本語".encode(), complete=True) == "日本語"
    assert texts.decode_text("日本語,東京".encode("cp932"), complete=True) == "日本語,東京"
    assert texts.decode_text(b"\xff\xfe" + "あ".encode("utf-16-le"), complete=True) == "あ"
    assert texts.decode_text(b"\x89PNG\x00\x00\x00", complete=True) is None
    # Only the start was read: a character cut at the end is dropped, not an error.
    assert texts.decode_text("あい".encode()[:-1], complete=False) == "あ"


def test_snippets_mark_the_words() -> None:
    assert mark("Photonic CRYSTAL と結晶", ["crystal", "結晶"]) == [
        ("Photonic ", False),
        ("CRYSTAL", True),
        (" と", False),
        ("結晶", True),
    ]
    # Full-width letters match the half-width keyword (NFKC), the longest word wins.
    assert mark(FULL_QUALITY + " factor", ["quality", "qual"]) == [
        (FULL_QUALITY, True),
        (" factor", False),
    ]
    snippet = window_snippet(
        "あ  い\n品質係数 う", cut_before=True, cut_after=True, keywords=["品質"]
    )
    assert snippet == [
        ("…あ い ", False),
        ("品質", True),
        ("係数 う…", False),
    ]
    # English words cut at the ends go; the word found stays.
    snippet = window_snippet(
        "sults. The photonic crystal experi", cut_before=True, cut_after=True, keywords=["crystal"]
    )
    assert snippet == [("…The photonic ", False), ("crystal", True), ("…", False)]
    whole = window_snippet("The crystal", cut_before=False, cut_after=False, keywords=["crystal"])
    assert whole == [("The ", False), ("crystal", True)]


async def test_pdf_text_from_the_child(tmp_path: Path, app: FastAPI) -> None:
    settings = settings_of(app)
    source = tmp_path / "a.pdf"
    source.write_bytes(fixture("report.pdf"))
    found = await texts.read_pdf(source, settings)
    assert found.status == "ready" and found.pages == 2
    assert found.page_starts is not None and found.page_starts[0] == 0
    assert "フォトニック結晶" in found.body and "品質係数" in found.body
    assert found.body.index("品質係数") > found.page_starts[1]
    # Encrypted: skipped, not failed. A scan has no text layer (no OCR): skipped.
    source.write_bytes(fixture("encrypted.pdf"))
    assert (await texts.read_pdf(source, settings)).reason == "encrypted"
    source.write_bytes(scanned_pdf())
    scanned = await texts.read_pdf(source, settings)
    assert (scanned.status, scanned.reason) == ("skipped", "no_text")
    source.write_bytes(b"%PDF-1.4 not really")
    assert (await texts.read_pdf(source, settings)).status == "failed"
    # The cap: at most this many bytes of text.
    source.write_bytes(fixture("report.pdf"))
    capped = await texts.read_pdf(source, settings.model_copy(update={"drive_text_max_bytes": 100}))
    assert capped.truncated and len(capped.body.encode()) <= 100


# --- the loop and the search ---------------------------------------------------------------------


async def test_content_search_finds_japanese_and_english_with_pages(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    owner = await make_user(db, "owner")
    as_user(owner)
    root = await workspace_root(client)
    report = await upload(client, root, "四半期報告.pdf", fixture("report.pdf"))
    named = await upload(client, root, "品質係数のメモ.txt", "測定のメモ。".encode())
    await upload(client, root, "scan.pdf", scanned_pdf())
    await upload(client, root, "locked.pdf", fixture("encrypted.pdf"))
    table = "名前,場所\nちくわぶ測定器,3階\n".encode("cp932")
    csv = await upload(client, root, "装置一覧.csv", table)
    await upload(client, root, "photo.png", b"\x89PNG\r\n\x1a\n" + b"0" * 64)

    # Not read yet: the content search finds names only.
    assert await names(client, "品質係数") == ["品質係数のメモ.txt"]
    assert await index_all(app) == 5  # the image has nothing to read: no row
    assert (await row_of(db, report["id"])).status == "ready"  # type: ignore[union-attr]

    body = await search(client, "品質係数")
    found = [hit["item"]["name"] for hit in body["items"]]
    assert found == ["品質係数のメモ.txt", "四半期報告.pdf"]
    first, second = body["items"]
    assert first["match"] == "name" and first["snippet"] is None
    assert second["match"] == "content" and second["page"] == 2
    assert marked(second) == ["品質係数"]
    assert "共振器の品質係数は予想よりも高く" in snippet_text(second)
    assert body["keywords"] == ["品質係数"]

    english = (await search(client, "photonic crystal"))["items"]
    assert [hit["item"]["name"] for hit in english] == ["四半期報告.pdf"]
    assert english[0]["page"] == 1 and set(marked(english[0])) == {"photonic", "crystal"}
    # A phrase cut by the PDF's line ends is found whole; Shift_JIS CSVs are read.
    assert await names(client, "研究計画") == ["四半期報告.pdf"]
    hit = (await search(client, "ちくわぶ測定器"))["items"]
    assert [h["item"]["id"] for h in hit] == [csv["id"]]
    assert hit[0]["page"] is None and marked(hit[0]) == ["ちくわぶ測定器"]
    # Without content=true: the name search of before, nothing more in the answer.
    old = (await client.get(f"{API}/search/drive", params={"q": "品質係数"})).json()
    assert [h["item"]["name"] for h in old["items"]] == ["品質係数のメモ.txt"]
    assert old["items"][0]["match"] == "name" and old["keywords"] == []
    # Both the name and the text.
    both = await upload(client, root, "結晶の報告.txt", "フォトニック結晶の話".encode())
    await index_all(app)
    hits = (await search(client, "結晶"))["items"]
    assert hits[0]["item"]["id"] == both["id"] and hits[0]["match"] == "both"

    rows = {r.reason for r in (await db.execute(select(DriveText))).scalars()}
    assert {"encrypted", "no_text"} <= rows
    assert named["name"] == "品質係数のメモ.txt"


async def test_content_search_respects_the_drives_one_can_read(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    owner = await make_user(db, "owner")
    guest = await make_user(db, "guest", role="guest")
    outsider = await make_user(db, "outsider")
    as_user(owner)
    root = await workspace_root(client)
    await upload(client, root, "lab.txt", "共有の合言葉 alpha".encode())
    lab = (await client.post(f"{API}/channels", json={"name": "lab", "type": "private"})).json()
    await client.post(f"{API}/channels/{lab['id']}/members", json={"user_id": str(guest.id)})
    channel = await location(client, "channel", channel_id=lab["id"])
    await upload(client, channel["root_id"], "chan.txt", "共有の合言葉 beta".encode())
    mine = await location(client, "me")
    await upload(client, mine["root_id"], "mine.txt", "共有の合言葉 gamma".encode())
    trashed = await upload(client, root, "old.txt", "共有の合言葉 delta".encode())
    await index_all(app)
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [trashed["id"]]})

    assert await names(client, "合言葉") == ["chan.txt", "lab.txt", "mine.txt"]
    assert await names(client, "合言葉", location_id=channel["id"]) == ["chan.txt"]
    assert await names(client, "合言葉", kind="folder") == []
    as_user(guest)
    assert await names(client, "合言葉") == ["chan.txt"]
    as_user(outsider)
    assert await names(client, "合言葉") == ["lab.txt"]
    assert await names(client, "合言葉", location_id=mine["id"]) == []
    # Restored from the trash: found again (its text was kept).
    as_user(owner)
    await client.post(f"{API}/drive/items/{trashed['id']}/restore")
    assert "old.txt" in await names(client, "delta")


async def test_new_versions_restores_and_purges(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    owner = await make_user(db, "owner")
    as_user(owner)
    mine = await location(client, "me")
    root = mine["root_id"]
    first = await upload(client, root, "notes.md", "# 初版の議事録 apple".encode())
    await index_all(app)
    assert await names(client, "apple") == ["notes.md"]
    # A new version: the old text goes at once, the new one is read by the loop.
    second = "# 第二版の議事録 banana".encode()
    await upload(client, root, "notes.md", second, on_conflict="version")
    assert await names(client, "apple") == []
    assert await names(client, "banana") == []
    await index_all(app)
    assert await names(client, "banana") == ["notes.md"]
    of_item = select(DriveText).where(DriveText.item_id == uuid.UUID(first["id"]))
    rows = (await db.execute(of_item)).all()
    assert len(rows) == 1
    # Restoring the first version makes it current again: read again.
    versions = (await client.get(f"{API}/drive/items/{first['id']}/versions")).json()["versions"]
    oldest = min(versions, key=lambda v: v["number"])
    restored = await client.post(f"{API}/drive/items/{first['id']}/versions/{oldest['id']}/restore")
    assert restored.status_code == 200, restored.text
    assert await names(client, "banana") == []
    await index_all(app)
    assert await names(client, "apple") == ["notes.md"]
    # Deleted for good: the rows go with the versions.
    await client.post(f"{API}/drive/items/trash", json={"item_ids": [first["id"]]})
    deleted = await client.delete(f"{API}/drive/items/{first['id']}")
    assert deleted.status_code == 204, deleted.text
    assert await row_of(db, first["id"]) is None


async def test_office_files_are_read_through_their_preview(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    class Converter:
        async def to_pdf(self, source: Path, kind: str, dest: Path) -> None:
            assert kind == "docx"
            dest.write_bytes(fixture("report.pdf"))  # noqa: ASYNC240 - a local temporary file

    drive_settings(app, previews_enabled=True, preview_converter_url="http://converter:3000")
    app.state.preview_converter = Converter()
    owner = await make_user(db, "owner")
    as_user(owner)
    root = await workspace_root(client)
    doc = await upload(client, root, "報告書.docx", fixture("report.docx"))
    # The preview is not made yet: the file waits (no row), nothing else is read.
    assert await index_all(app) == 0
    result = await texts.index_stored(
        app.state.db.session_factory, settings_of(app), app.state.blobs, limit=10
    )
    assert result.tried == 0 and result.waiting_for_previews == 1
    while await previews.process_due(
        app.state.db, app.state.blobs, app.state.preview_converter, settings_of(app)
    ):
        pass
    assert await index_all(app) == 1
    hit = (await search(client, "品質係数"))["items"]
    assert [h["item"]["id"] for h in hit] == [doc["id"]] and hit[0]["page"] == 2


async def test_backfill_is_resumable_and_idempotent(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    owner = await make_user(db, "owner")
    as_user(owner)
    root = await workspace_root(client)
    for n in range(3):
        await upload(client, root, f"f{n}.txt", f"backfill word{n}".encode())
    factory, settings, blobs = app.state.db.session_factory, settings_of(app), app.state.blobs
    first = await texts.index_stored(factory, settings, blobs, limit=2)
    assert (first.tried, first.ready, first.remaining) == (2, 2, True)
    rest = await texts.index_stored(factory, settings, blobs, limit=10)
    assert (rest.tried, rest.ready, rest.remaining) == (1, 1, False)
    again = await texts.index_stored(factory, settings, blobs, limit=10)
    assert again.tried == 0
    assert await texts.counts(db) == {"ready": 3}
    # A failed row is read again only when asked.
    await db.execute(text("UPDATE drive_texts SET status = 'failed', reason = 'unreadable'"))
    await db.commit()
    assert (await texts.index_stored(factory, settings, blobs, limit=10)).tried == 0
    assert await texts.retry_failed(db) == 3
    assert (await texts.index_stored(factory, settings, blobs, limit=10)).ready == 3


async def test_a_lease_that_ran_out_is_taken_again_and_given_up(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    owner = await make_user(db, "owner")
    as_user(owner)
    root = await workspace_root(client)
    item = await upload(client, root, "a.txt", b"lease words")
    async with app.state.db.session_factory() as session:
        claimed = await texts.claim(session, settings_of(app))
    assert claimed is not None and claimed.attempt == 1
    # Leased: nobody else takes it.
    async with app.state.db.session_factory() as session:
        assert await texts.claim(session, settings_of(app)) is None
    await db.execute(text("UPDATE drive_texts SET next_at = now() - interval '1 second'"))
    await db.commit()
    assert await index_all(app) == 1
    row = await row_of(db, item["id"])
    assert row is not None and row.status == "ready" and row.attempts == 2
    # The first try finishing late writes nothing (the row is no longer its own).
    assert (
        await texts.process_one(
            app.state.db.session_factory, settings_of(app), app.state.blobs, claimed
        )
        == "gone"
    )
    # Out of tries: failed.
    await db.execute(
        text("UPDATE drive_texts SET status = 'working', attempts = 3, next_at = now()")
    )
    await db.commit()
    async with app.state.db.session_factory() as session:
        assert await texts.claim(session, settings_of(app)) is None
    row = await row_of(db, item["id"])
    assert row is not None and (row.status, row.reason) == ("failed", "gave_up")


async def test_the_search_uses_the_text_index(db: AsyncSession) -> None:
    from app.modules.search import repository

    statement = repository.drive_search_statement(
        "品質", [uuid.uuid4()], kind=None, limit=10, offset=0, content=True
    )
    compiled = statement.compile(compile_kwargs={"literal_binds": True})
    await db.execute(text("SET LOCAL enable_seqscan = off"))
    plan = "\n".join(row[0] for row in (await db.execute(text(f"EXPLAIN {compiled}"))).all())
    assert "drive_texts_body_pgroonga_idx" in plan
    assert "drive_items_name_pgroonga_idx" in plan


async def test_the_chat_previews_go_first(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app, previews_enabled=True)
    owner = await make_user(db, "owner")
    as_user(owner)
    root = await workspace_root(client)
    await upload(client, root, "a.txt", b"chat first")
    # A PDF sent in a conversation waits for its preview: the drive's text waits too.
    sent = await client.post(
        f"{API}/attachments", files={"file": ("a.pdf", fixture("report.pdf"), "application/pdf")}
    )
    assert sent.status_code == 201, sent.text
    # Due now by the database's clock (the container's may lag the test's by a moment).
    await db.execute(
        text(
            "UPDATE attachments SET preview_next_at = now() - interval '1 minute' "
            "WHERE drive_item_id IS NULL AND preview_status = 'pending'"
        )
    )
    await db.commit()
    assert await index_all(app) == 0
    await db.execute(text("UPDATE attachments SET preview_status = 'none'"))
    await db.commit()
    assert await index_all(app) == 1


def test_the_backfill_command_parses() -> None:
    from app.cli import build_parser

    args = build_parser().parse_args(["drive-index", "--limit", "50", "--retry-failed"])
    assert (args.limit, args.retry_failed, args.chat_wait_seconds) == (50, True, 600.0)
