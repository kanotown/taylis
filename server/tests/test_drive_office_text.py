"""Word / Excel / PowerPoint and OpenDocument files read straight from the package
(docs/DRIVE.md §29.6, office_text.py).

The packages are built here with zipfile and minimal XML (Japanese and English): what PowerPoint,
Word, Excel and LibreOffice write has more parts, none of which the extraction reads.
"""

import io
import os
import uuid
import zipfile
from collections.abc import AsyncIterator, Callable
from typing import Any
from xml.sax.saxutils import escape

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.modules.attachments.blobstore import MemoryBlobStore
from app.modules.drive import office_text, texts
from app.modules.drive.models import DriveText
from app.modules.users.models import User
from tests.drive_helpers import act_as, drive_settings, location, upload, workspace_root
from tests.helpers import make_user

API = "/api/v1"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


def rels(*items: tuple[str, str, str]) -> str:
    inner = "".join(
        f'<Relationship Id="{rid}" Type="{R}/{kind}" Target="{target}"/>'
        for rid, kind, target in items
    )
    return f'{HEAD}<Relationships xmlns="{PKG}">{inner}</Relationships>'


def drawing_paragraphs(paragraphs: list[str]) -> str:
    return "".join(f"<a:p><a:r><a:t>{escape(p)}</a:t></a:r></a:p>" for p in paragraphs)


def slide_xml(paragraphs: list[str], tag: str = "sld") -> str:
    return (
        f'{HEAD}<p:{tag} xmlns:a="{A}" xmlns:p="{P}" xmlns:r="{R}"><p:cSld><p:spTree>'
        f"<p:sp><p:txBody>{drawing_paragraphs(paragraphs)}"
        # The slide number field: generated, not the slide's text.
        '<a:p><a:fld id="{1}" type="slidenum"><a:t>999</a:t></a:fld></a:p>'
        f"</p:txBody></p:sp></p:spTree></p:cSld></p:{tag}>"
    )


def pptx(
    slides: list[list[str]],
    *,
    notes: dict[int, str] | None = None,
    order: list[int] | None = None,
    with_list: bool = True,
    media: bytes | None = None,
) -> bytes:
    """A presentation: `slides` (paragraphs each) stored as slide1.xml ..., shown in `order`
    (slide numbers; default as stored). `media`: a large stored member between the slides."""
    notes = notes or {}
    order = order or list(range(1, len(slides) + 1))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", f'{HEAD}<Types xmlns="x"/>')
        zf.writestr("_rels/.rels", rels(("rId1", "officeDocument", "ppt/presentation.xml")))
        ids = "".join(f'<p:sldId id="{255 + n}" r:id="rId{n}"/>' for n in order)
        listed = f"<p:sldIdLst>{ids}</p:sldIdLst>" if with_list else ""
        zf.writestr(
            "ppt/presentation.xml",
            f'{HEAD}<p:presentation xmlns:p="{P}" xmlns:r="{R}">{listed}</p:presentation>',
        )
        zf.writestr(
            "ppt/_rels/presentation.xml.rels",
            rels(
                *[(f"rId{n}", "slide", f"slides/slide{n}.xml") for n in range(1, len(slides) + 1)]
            ),
        )
        for n, paragraphs in enumerate(slides, start=1):
            zf.writestr(f"ppt/slides/slide{n}.xml", slide_xml(paragraphs))
            slide_rels: list[tuple[str, str, str]] = [
                ("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")
            ]
            if n in notes:
                slide_rels.append(("rId2", "notesSlide", f"../notesSlides/notesSlide{n}.xml"))
                zf.writestr(
                    f"ppt/notesSlides/notesSlide{n}.xml", slide_xml([notes[n]], tag="notes")
                )
            zf.writestr(f"ppt/slides/_rels/slide{n}.xml.rels", rels(*slide_rels))
            if media is not None and n == 1:
                zf.writestr(
                    zipfile.ZipInfo("ppt/media/video1.mp4"), media, compress_type=zipfile.ZIP_STORED
                )
    return out.getvalue()


def docx(paragraphs: list[str]) -> bytes:
    body = "".join(
        f"<w:p><w:r><w:t>{escape(p)}</w:t><w:tab/><w:t>tab</w:t></w:r></w:p>" for p in paragraphs
    )
    # A text box with its fallback copy (mc:Fallback): read once.
    box = (
        f'<w:p><mc:AlternateContent xmlns:mc="{MC}"><mc:Choice Requires="wps">'
        "<w:r><w:t>テキストボックス</w:t></w:r></mc:Choice>"
        "<mc:Fallback><w:r><w:t>テキストボックス</w:t></w:r></mc:Fallback>"
        "</mc:AlternateContent></w:p>"
    )
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", f'{HEAD}<Types xmlns="x"/>')
        zf.writestr("_rels/.rels", rels(("rId1", "officeDocument", "word/document.xml")))
        zf.writestr(
            "word/document.xml",
            f'{HEAD}<w:document xmlns:w="{W}"><w:body>{body}{box}</w:body></w:document>',
        )
    return out.getvalue()


def xlsx() -> bytes:
    shared = (
        f'{HEAD}<sst xmlns="{S}" count="3" uniqueCount="3">'
        "<si><t>装置名</t></si>"
        # A Japanese cell with its reading (rPh): the reading is not the cell's text.
        "<si><r><t>ちくわぶ</t></r><r><t>測定器</t></r>"
        '<rPh sb="0" eb="2"><t>チクワブ</t></rPh></si>'
        "<si><t>Quality factor</t></si>"
        "</sst>"
    )

    def sheet(rows: str) -> str:
        return f'{HEAD}<worksheet xmlns="{S}"><sheetData>{rows}</sheetData></worksheet>'

    first = sheet(
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12345</v></c></row>'
        '<row r="2"><c r="A2" t="s"><v>1</v></c>'
        '<c r="B2" t="inlineStr"><is><t>3階の実験室</t></is></c></row>'
    )
    second = sheet(
        '<row r="1"><c r="A1" t="s"><v>2</v></c>'
        '<c r="B1" t="str"><f>A1&amp;"!"</f><v>formula result</v></c></row>'
    )
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", f'{HEAD}<Types xmlns="x"/>')
        zf.writestr("_rels/.rels", rels(("rId1", "officeDocument", "xl/workbook.xml")))
        # Shown first: "概要" (sheet2.xml), then "一覧" (sheet1.xml).
        zf.writestr(
            "xl/workbook.xml",
            f'{HEAD}<workbook xmlns="{S}" xmlns:r="{R}"><sheets>'
            '<sheet name="概要" sheetId="2" r:id="rId2"/>'
            '<sheet name="一覧" sheetId="1" r:id="rId1"/>'
            "</sheets></workbook>",
        )
        zf.writestr(
            "xl/_rels/workbook.xml.rels",
            rels(
                ("rId1", "worksheet", "worksheets/sheet1.xml"),
                ("rId2", "worksheet", "/xl/worksheets/sheet2.xml"),
                ("rId3", "sharedStrings", "sharedStrings.xml"),
            ),
        )
        zf.writestr("xl/sharedStrings.xml", shared)
        zf.writestr("xl/worksheets/sheet1.xml", first)
        zf.writestr("xl/worksheets/sheet2.xml", second)
    return out.getvalue()


def odp(pages: list[str]) -> bytes:
    office = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    draw = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
    textns = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
    inner = "".join(
        f'<draw:page draw:name="p{n}"><draw:frame><draw:text-box>'
        f"<text:p>{escape(page)}<text:s/>end</text:p></draw:text-box></draw:frame></draw:page>"
        for n, page in enumerate(pages)
    )
    content = (
        f'{HEAD}<office:document-content xmlns:office="{office}" xmlns:draw="{draw}" '
        f'xmlns:text="{textns}"><office:body><office:presentation>{inner}'
        "</office:presentation></office:body></office:document-content>"
    )
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zf:
        zf.writestr("mimetype", "application/vnd.oasis.opendocument.presentation")
        zf.writestr("content.xml", content)
    return out.getvalue()


def settings_of(app: FastAPI) -> Settings:
    found: Settings = app.state.settings
    return found


def read(data: bytes, **limits: Any) -> office_text.PackageText:
    reader = office_text.RangedReader(
        lambda start, end: data[start : end + 1], len(data), max_fetch=1 << 30
    )
    return office_text.extract(
        reader,
        max_bytes=limits.get("max_bytes", 1 << 20),
        max_xml_bytes=limits.get("max_xml_bytes", 64 << 20),
    )


def page_of(found: office_text.PackageText, phrase: str) -> int:
    assert found.page_starts is not None
    at = found.body.index(phrase)
    return sum(1 for start in found.page_starts if start <= at)


# --- the packages -----------------------------------------------------------------------------


def test_pptx_slides_in_the_presentations_order_with_notes() -> None:
    data = pptx(
        [["最初に保存したスライド", "photonic crystal"], ["品質係数の測定", "Quality"]],
        notes={1: "発表者のノート speaker note"},
        order=[2, 1],  # slide2.xml is shown first
    )
    found = read(data)
    assert (found.status, found.page_unit, found.pages) == ("ready", "slide", 2)
    assert found.body.index("品質係数の測定") < found.body.index("最初に保存したスライド")
    assert page_of(found, "品質係数の測定") == 1
    assert page_of(found, "photonic crystal") == 2
    assert page_of(found, "発表者のノート") == 2  # the notes are their slide's
    assert "999" not in found.body  # the slide number field
    assert "品質係数の測定\nQuality" in found.body


def test_pptx_without_a_slide_list_takes_the_numeric_order() -> None:
    slides = [[f"slide {n} 本文"] for n in range(1, 12)]
    found = read(pptx(slides, with_list=False))
    assert found.pages == 11
    assert found.body.index("slide 2 本文") < found.body.index("slide 10 本文")
    assert page_of(found, "slide 10 本文") == 10


def test_docx_paragraphs_without_fallback_copies() -> None:
    found = read(docx(["研究計画について", "The resonator's Q"]))
    assert found.status == "ready"
    assert found.page_starts is None and found.page_unit is None and found.pages is None
    assert found.body == "研究計画について tab\nThe resonator's Q tab\nテキストボックス"


def test_xlsx_sheets_shared_strings_and_inline_strings() -> None:
    found = read(xlsx())
    assert (found.status, found.page_unit, found.pages) == ("ready", "sheet", 2)
    assert page_of(found, "Quality factor") == 1  # 概要, the first sheet shown
    assert page_of(found, "ちくわぶ測定器") == 2
    assert "formula result" in found.body and "3階の実験室" in found.body
    assert "チクワブ" not in found.body  # the reading
    assert "12345" not in found.body  # numbers are not text


def test_odp_pages_are_slides() -> None:
    found = read(odp(["一枚目 alpha", "二枚目 beta"]))
    assert (found.status, found.page_unit, found.pages) == ("ready", "slide", 2)
    assert page_of(found, "二枚目 beta end") == 2


def test_the_text_cap_and_the_xml_budget() -> None:
    slides = [["あいうえお" * 2000] for _ in range(20)]
    capped = read(pptx(slides), max_bytes=50_000)
    assert capped.truncated and len(capped.body.encode()) <= 50_000
    # A zip bomb: a member of 30 MB of XML compressed to a few dozen KB; parsing stops at the
    # budget (whatever the member says its size is).
    bomb = "<a:p><a:r><a:t>x</a:t></a:r></a:p>" * (30 * 1024 * 1024 // 34)
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr(
            "word/document.xml",
            f'{HEAD}<w:document xmlns:w="{W}" xmlns:a="{A}"><w:body>{bomb}</w:body></w:document>',
        )
    assert len(data.getvalue()) < 1024 * 1024
    found = read(data.getvalue(), max_xml_bytes=2 * 1024 * 1024, max_bytes=10 << 20)
    assert found.status == "ready" and found.truncated
    assert len(found.body) < 2 * 1024 * 1024


def test_encrypted_broken_and_hostile_packages() -> None:
    # Office's password protection wraps the package in a CFB (OLE) file.
    cfb = office_text.CFB_MAGIC + b"\x00" * 4096
    assert (read(cfb).status, read(cfb).reason) == ("skipped", "encrypted")
    assert read(b"PK\x03\x04 broken").status == "failed"
    assert read(b"not a zip at all").reason == "unreadable"
    # A zip that is no Office file.
    plain = io.BytesIO()
    with zipfile.ZipFile(plain, "w") as zf:
        zf.writestr("readme.txt", "hello")
    assert (read(plain.getvalue()).status, read(plain.getvalue()).reason) == (
        "skipped",
        "unsupported",
    )
    # A DTD (entity expansion) is never in OOXML: the file fails.
    hostile = io.BytesIO()
    with zipfile.ZipFile(hostile, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr(
            "word/document.xml",
            '<!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>'
            f'<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>&b;</w:t></w:r></w:p>'
            "</w:body></w:document>",
        )
    assert (read(hostile.getvalue()).status, read(hostile.getvalue()).reason) == (
        "failed",
        "unreadable",
    )
    # No text at all.
    empty = read(pptx([[]]))
    assert (empty.status, empty.reason) == ("skipped", "no_text")
    # Past the time limit (DRIVE_TEXT_TIMEOUT_SECONDS): failed.
    data = docx(["遅い"])
    reader = office_text.RangedReader(
        lambda start, end: data[start : end + 1], len(data), max_fetch=1 << 30
    )
    late = office_text.extract(reader, max_bytes=1 << 20, max_xml_bytes=1 << 20, deadline=0.0)
    assert (late.status, late.reason) == ("failed", "timeout")


def test_a_central_directory_too_large_is_not_read() -> None:
    data = pptx([["text"]])
    reader = office_text.RangedReader(
        lambda start, end: data[start : end + 1], len(data), max_fetch=1 << 30
    )
    with pytest.raises(office_text.Stop):
        reader.read(office_text.MAX_SINGLE_READ + 1)
    # The fetch limit.
    small = office_text.RangedReader(
        lambda start, end: data[start : end + 1], len(data), max_fetch=100
    )
    with pytest.raises(office_text.Stop):
        small.read(1000)


async def test_a_large_presentation_is_read_without_its_media(app: FastAPI) -> None:
    """A presentation of 40 MB, almost all of it a video between the slides: only the central
    directory and the slides' parts are fetched."""
    media = os.urandom(40 * 1024 * 1024)
    data = pptx(
        [["動画の前のスライド"], ["動画の後のスライド ending"]],
        notes={2: "ノート"},
        media=media,
    )
    blobs = MemoryBlobStore()
    await blobs.put("attachments/big", data, PPTX)
    result = await texts.read_package(blobs, "attachments/big", settings_of(app))
    assert result.extracted.status == "ready"
    assert result.extracted.page_unit == "slide" and result.extracted.pages == 2
    assert "動画の後のスライド ending" in result.extracted.body
    assert result.fetched < 512 * 1024, result.fetched
    assert result.requests < 20
    # The object store failing: a retry, not a result.

    class Failing(MemoryBlobStore):
        async def stream(
            self, key: str, start: int | None = None, end: int | None = None
        ) -> AsyncIterator[bytes]:
            if key:
                raise OSError("the store is down")
            yield b""

    failing = Failing()
    await failing.put("k", data, PPTX)
    with pytest.raises(texts.Retry):
        await texts.read_package(failing, "k", settings_of(app))


def test_kinds() -> None:
    assert texts.kind_of(PPTX, "a.pptx") == "package"
    assert texts.kind_of("application/zip", "slides.PPTX") == "package"
    assert texts.kind_of("application/octet-stream", "book.xlsm") == "package"
    assert texts.kind_of("application/x-ole-storage", "locked.docx") == "package"
    assert texts.kind_of("application/vnd.ms-excel.sheet.macroEnabled.12", "a.xlsm") == "package"
    assert texts.kind_of("application/vnd.oasis.opendocument.presentation", "a.odp") == "package"
    assert texts.kind_of("application/vnd.ms-powerpoint", "old.ppt") == "office"
    assert texts.kind_of("application/x-ole-storage", "old.doc") == "office"
    assert texts.kind_of("application/zip", "archive.zip") is None


# --- the loop, the waiting count and the search ---------------------------------------------------


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


async def index_all(app: FastAPI) -> int:
    done = 0
    while await texts.process_due(app.state.db.session_factory, settings_of(app), app.state.blobs):
        done += 1
        assert done < 100
    return done


async def search(client: AsyncClient, q: str, **params: Any) -> list[dict[str, Any]]:
    response = await client.get(f"{API}/search/drive", params={"q": q, "content": "true", **params})
    assert response.status_code == 200, response.text
    hits: list[dict[str, Any]] = response.json()["items"]
    return hits


async def row_of(db: AsyncSession, item_id: str) -> DriveText | None:
    db.expire_all()
    return (
        await db.execute(select(DriveText).where(DriveText.item_id == uuid.UUID(item_id)))
    ).scalar_one_or_none()


async def test_office_files_are_searched_by_slide_and_sheet(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    # Previews on with a converter that is never reached: OOXML files do not wait for theirs.
    drive_settings(app, previews_enabled=True, preview_converter_url="http://converter:3000")
    owner = await make_user(db, "owner")
    outsider = await make_user(db, "outsider")
    as_user(owner)
    mine = await location(client, "me")
    deck = await upload(
        client,
        mine["root_id"],
        "研究報告.pptx",
        pptx(
            [["表紙 2026年度"], ["背景"], ["共振器の品質係数は予想より高い", "photonic crystal"]],
            notes={2: "ここで実験装置を見せる"},
        ),
    )
    book = await upload(client, mine["root_id"], "装置一覧.xlsx", xlsx())
    doc = await upload(client, mine["root_id"], "議事録.docx", docx(["次回までに研究計画を書く"]))
    # Stored as application/zip (the sniffer could not tell): read by its name's extension.
    zipped = await upload(
        client, mine["root_id"], "zip型.pptx", pptx([["圧縮の型でも読めるスライド"]])
    )
    await db.execute(
        text(
            "UPDATE attachments SET content_type = 'application/zip', preview_status = 'none' "
            "WHERE id = (SELECT v.attachment_id FROM drive_items i "
            "JOIN drive_file_versions v ON v.id = i.current_version_id WHERE i.id = :id)"
        ),
        {"id": uuid.UUID(zipped["id"])},
    )
    await db.commit()
    assert await index_all(app) == 4

    hits = await search(client, "品質係数")
    assert [h["item"]["id"] for h in hits] == [deck["id"]]
    assert (hits[0]["page"], hits[0]["page_kind"]) == (3, "slide")
    notes = await search(client, "実験装置")
    assert (notes[0]["page"], notes[0]["page_kind"]) == (2, "slide")
    sheet = await search(client, "ちくわぶ測定器")
    assert [h["item"]["id"] for h in sheet] == [book["id"]]
    assert (sheet[0]["page"], sheet[0]["page_kind"]) == (2, "sheet")
    words = await search(client, "研究計画")
    assert [h["item"]["id"] for h in words] == [doc["id"]]
    assert (words[0]["page"], words[0]["page_kind"]) == (None, None)
    assert [h["item"]["id"] for h in await search(client, "圧縮の型")] == [zipped["id"]]
    # Name matches carry no page.
    named = await search(client, "議事録")
    assert named[0]["match"] == "name" and named[0]["page_kind"] is None
    # The permissions are the search's: another person does not see one's My Drive.
    as_user(outsider)
    assert await search(client, "品質係数") == []


async def test_files_without_a_coming_preview_do_not_wait(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(
        app,
        previews_enabled=True,
        preview_converter_url="http://converter:3000",
        preview_max_input_bytes=5000,
    )
    owner = await make_user(db, "owner")
    as_user(owner)
    root = await workspace_root(client)
    old = office_text.CFB_MAGIC + b"\x00" * 1000
    small = await upload(client, root, "小さい.ppt", old)
    large = await upload(client, root, "大きい.ppt", old + b"\x00" * 9000)
    big_deck = await upload(
        client, root, "大きい.pptx", pptx([["大きな発表"]], media=b"\x00" * 9000)
    )
    await db.execute(text("UPDATE attachments SET preview_status = 'none'"))
    await db.commit()
    factory, settings, blobs = app.state.db.session_factory, settings_of(app), app.state.blobs
    result = await texts.index_stored(factory, settings, blobs, limit=10)
    # The pptx is read from its package, the large ppt is skipped (too large for the
    # converter); only the small ppt waits for its preview.
    assert (result.tried, result.ready, result.skipped) == (2, 1, 1)
    assert result.waiting_for_previews == 1 and not result.remaining
    row = await row_of(db, large["id"])
    assert row is not None and (row.status, row.reason) == ("skipped", "too_large")
    assert (await row_of(db, big_deck["id"])).status == "ready"  # type: ignore[union-attr]
    assert await row_of(db, small["id"]) is None
    # Previews off: nothing waits.
    off = settings.model_copy(update={"previews_enabled": False})
    result = await texts.index_stored(factory, off, blobs, limit=10)
    assert result.tried == 1 and result.waiting_for_previews == 0
    row = await row_of(db, small["id"])
    assert row is not None and (row.status, row.reason) == ("skipped", "no_preview")
    # Asked again (a limit raised, previews back): these rows are read again.
    assert await texts.retry_failed(db) == 2
