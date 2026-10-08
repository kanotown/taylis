"""Notion import (M125, docs/WIKI.md §6): small synthetic exports through the whole import.

The exports are made here in the shape a real "Markdown & CSV" export has (checked on one in
2026-10-07): ``<title> <32 hex>.md`` pages, ``.csv`` / ``_all.csv`` databases, folders named by
the title (``<title> <4>-<4>`` when two siblings share it), URL-encoded relative links.
"""

import csv
import io
import zipfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.attachments.models import Attachment
from app.modules.importer.core import ImportFailed
from app.modules.importer.models import ImportRef
from app.modules.importer.notion_export import (
    ExportFiles,
    convert_markdown,
    guess_type,
    match_rows,
    parse_date,
    parse_relation,
    read_tree,
)
from app.modules.importer.notion_import import (
    NotionReport,
    Options,
    import_notion,
    parse_column_types,
)
from app.modules.users.models import User
from app.modules.wiki import access
from app.modules.wiki.models import WikiDatabase, WikiPage, WikiPageRevision
from tests.helpers import make_user
from tests.wiki_helpers import API, Actor, key, save

TOKYO = ZoneInfo("Asia/Tokyo")

# Notion ids of the synthetic export
HOME = "a" * 31 + "1"
GUIDE = "b" * 31 + "2"
SUB = "c" * 31 + "3"
PAPERS = "d" * 31 + "4"
PEOPLE_DB = "e" * 31 + "5"
ROW1 = "1" * 31 + "a"
ROW2 = "2" * 31 + "b"
ROW3 = "3" * 31 + "c"
TPL = "4" * 31 + "d"
P1 = "5" * 31 + "e"
P2 = "6" * 31 + "f"
SAME1 = "7" * 32
SAME2 = "8" * 32


def _png(width: int = 30, height: int = 20) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (10, 120, 200)).save(buffer, "PNG")
    return buffer.getvalue()


def q(path: str) -> str:
    """A link as Notion writes it: URL-encoded, parentheses left as they are."""
    return quote(path, safe="/()")


def csv_text(rows: list[list[str]]) -> str:
    out = io.StringIO()
    csv.writer(out, lineterminator="\n").writerows(rows)
    return out.getvalue()


def export_files() -> dict[str, bytes | str]:
    home = "Home"
    ann = f"Ann (People%20{PEOPLE_DB}/Ann%20{P1}.md)"
    bob = f"Bob (People%20{PEOPLE_DB}/Bob%20{P2}.md)"
    alpha = f"Alpha (Papers%20{PAPERS}/Alpha%20{ROW1}.md)"
    gamma = f"Gamma (Papers%20{PAPERS}/Gamma%20{ROW3}.md)"
    papers_csv_all = csv_text(
        [
            "Name,Done,Count,Ratio,When,Link,Owner,Tags,Stage,Note,Authors,Due".split(","),
            [
                "Alpha", "Yes", "1,200", "50%", "2026年10月7日 10:00 (JST)",
                "https://example.com/a", "Taro Yamada", "ml, vision", "draft", "first one", ann, "",
            ],
            [
                "Beta", "No", "3", "25%", "October 7, 2026 → October 9, 2026",
                "https://example.com/b", "", "ml", "draft", "", "", "",
            ],
            [
                "Gamma", "No", "4.5", "10%", "2026/10/08", "", "Taro Yamada, Hanako Sato",
                "vision", "done", "x", f"{ann}, {bob}", "",
            ],
        ]
    )  # fmt: skip
    # The columns of the default view (fewer, another order)
    papers_csv = "Name,Stage,Done\nAlpha,draft,Yes\nBeta,draft,No\nGamma,done,No\n"
    people_csv = csv_text([["Name", "Papers"], ["Ann", f"{alpha}, {gamma}"], ["Bob", gamma]])
    return {
        f"{home} {HOME}.md": (
            f"# {home}\n\n"
            "Intro with a [guide](" + q(f"{home}/Guide {GUIDE}.md") + ") inline.\n\n"
            "<aside>\n💡\n\nRemember **this**.\n\n</aside>\n\n"
            "[Papers](" + q(f"{home}/Papers {PAPERS}.csv") + ")\n\n"
            "[People](" + q(f"{home}/People {PEOPLE_DB}.csv") + ")\n\n"
            "[Guide](" + q(f"{home}/Guide {GUIDE}.md") + ")\n\n"
            "```\n[not a link](" + q(f"{home}/Guide {GUIDE}.md") + ")\n<aside>\n```\n\n"
            "Inline `[[code]](x.md)` stays.\n\n"
            "Elsewhere: https://www.notion.so/Guide-" + GUIDE + "\n\n"
            "Gone: [old](" + q(f"{home}/Old {'9' * 32}.md") + ")\n\n"
            "Ask @Taro Yamada please.\n\n"
            "<details>\n<summary>More</summary>\n\nhidden text\n\n</details>\n\n"
            'Some <span style="color:red">red</span> words<br>next line.\n'
        ),
        f"{home}/Guide {GUIDE}.md": (
            "# Guide\n\n![](Guide/diagram.png)\n\n"
            "[spec (v2).pdf](" + q("Guide/spec (v2).pdf") + ")\n\n"
            "![photo.heic](Guide/photo.heic)\n\n"
            "[Sub](" + q(f"Guide/Sub {SUB}.md") + ")\n\n"
            "$$\nE = mc^2\n$$\n"
        ),
        f"{home}/Guide/diagram.png": _png(),
        f"{home}/Guide/spec (v2).pdf": b"%PDF-1.4\n%fake\n",
        f"{home}/Guide/photo.heic": b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heicmif1" + b"0" * 32,
        f"{home}/Guide/notes.txt": b"left in the folder, not linked",
        f"{home}/Guide/Sub {SUB}.md": "# Sub\n\nBack to [Home]("
        + q(f"../../Home {HOME}.md")
        + ")\n",
        f"{home}/Papers {PAPERS}_all.csv": "﻿" + papers_csv_all,
        f"{home}/Papers {PAPERS}.csv": "﻿" + papers_csv,
        f"{home}/Papers/Alpha {ROW1}.md": (
            "# Alpha\n\nDone: Yes\nCount: 1,200\nStage: draft\n\nAlpha's notes.\n"
        ),
        f"{home}/Papers/Beta {ROW2}.md": "# Beta\n\nDone: No\nStage: draft\n",
        f"{home}/Papers/Gamma {ROW3}.md": "# Gamma\n\nStage: done\n\nSee [Alpha]("
        + q(f"Alpha {ROW1}.md")
        + ").\n",
        f"{home}/Papers/Template {TPL}.md": "# Template\n\nStage: draft\n\nFill me.\n",
        f"{home}/People {PEOPLE_DB}_all.csv": "﻿" + people_csv,
        f"{home}/People/Ann {P1}.md": "# Ann\n\nPapers: …\n",
        f"{home}/People/Bob {P2}.md": "# Bob\n",
    }


def write_zip(
    path: Path,
    files: Mapping[str, bytes | str],
    *,
    utf8_flag: bool = True,
    encoding: str = "utf-8",
) -> Path:
    class Info(zipfile.ZipInfo):
        def _encodeFilenameFlags(self) -> tuple[bytes, int]:
            return self.filename.encode(encoding), self.flag_bits & ~0x800

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            raw = data.encode() if isinstance(data, str) else data
            if utf8_flag:
                zf.writestr(name, raw)
            else:
                info = Info(name)
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, raw)
    return path


async def _people(db: AsyncSession) -> dict[str, User]:
    admin = await make_user(db, "admin", role="admin")
    taro = await make_user(db, "taro")
    taro.display_name = "Taro Yamada"
    hana = await make_user(db, "hanako")
    hana.display_name = "Hanako Sato"
    bob = await make_user(db, "bob")
    await db.commit()
    return {"admin": admin, "taro": taro, "hanako": hana, "bob": bob}


async def run_import(
    app: FastAPI,
    db: AsyncSession,
    path: Path,
    *,
    dry_run: bool = False,
    options: Options | None = None,
) -> NotionReport:
    return await import_notion(
        db,
        path,
        actor_username="admin",
        blobs=app.state.blobs,
        settings=app.state.settings,
        options=options or Options(),
        dry_run=dry_run,
    )


async def _page(db: AsyncSession, title: str, kind: str | None = None) -> WikiPage:
    stmt = select(WikiPage).where(WikiPage.title == title, WikiPage.deleted_at.is_(None))
    if kind is not None:
        stmt = stmt.where(WikiPage.kind == kind)
    page = (await db.execute(stmt)).scalars().one()
    await db.refresh(page)
    return page


async def _count(db: AsyncSession, model: Any) -> int:
    return int(await db.scalar(select(func.count()).select_from(model)) or 0)


# --- the format ----------------------------------------------------------------------------------


def test_names_without_the_utf8_flag_are_read_as_utf8(tmp_path: Path) -> None:
    files = {f"研究室 {HOME}.md": "# 研究室\n", f"研究室/手順 {GUIDE}.md": "# 手順\n"}
    for encoding in ("utf-8", "cp932"):
        path = write_zip(tmp_path / f"{encoding}.zip", files, utf8_flag=False, encoding=encoding)
        with zipfile.ZipFile(path) as zf:
            assert all(not i.flag_bits & 0x800 for i in zf.infolist())
            assert f"研究室 {HOME}.md" not in zf.namelist()  # mis-decoded as cp437
        export = ExportFiles.open(path)
        try:
            tree = read_tree(export)
        finally:
            export.close()
        assert tree.items[HOME].title == "研究室"
        assert tree.items[GUIDE].parent == HOME


def test_a_zip_of_zips_is_one_tree(tmp_path: Path) -> None:
    part1 = write_zip(tmp_path / "p1.zip", {f"Home {HOME}.md": "# Home\n"})
    part2 = write_zip(
        tmp_path / "p2.zip",
        {f"Home/Guide {GUIDE}.md": "# Guide\n", "Home/Guide/a.zip": b"PK\x05\x06" + b"\0" * 18},
    )
    outer = write_zip(
        tmp_path / "outer.zip",
        {
            "Export-1234-Part-1.zip": part1.read_bytes(),
            "Export-1234-Part-2.zip": part2.read_bytes(),
        },
    )
    export = ExportFiles.open(outer)
    try:
        tree = read_tree(export)
        assert export.parts == 2
        assert tree.items[GUIDE].parent == HOME
        # a ZIP inside a page's folder is a file of that page, not a part
        assert tree.items[GUIDE].files == ["Home/Guide/a.zip"]
    finally:
        export.close()


def test_tree_folders_rows_and_shared_names(tmp_path: Path) -> None:
    files = export_files()
    # Two sibling pages called "Same": the second one's folder carries the short id.
    files[f"Home/Same {SAME1}.md"] = "# Same\n"
    files[f"Home/Same {SAME2}.md"] = (
        "# Same\n\n![](" + q(f"Same {SAME2[:4]}-{SAME2[-4:]}/x.png") + ")\n"
    )
    files[f"Home/Same {SAME2[:4]}-{SAME2[-4:]}/x.png"] = _png()
    path = write_zip(tmp_path / "e.zip", files)
    export = ExportFiles.open(path)
    try:
        tree = read_tree(export)
    finally:
        export.close()
    items = tree.items
    assert tree.roots == [HOME]
    # children in the order the parent's body links them, the rest by title
    assert items[HOME].children[:3] == [GUIDE, PAPERS, PEOPLE_DB]
    assert items[PAPERS].kind == "database" and items[PAPERS].view_csv is not None
    assert {items[r].kind for r in (ROW1, ROW2, ROW3, TPL)} == {"row"}
    assert items[SUB].parent == GUIDE
    assert "Home/Guide/diagram.png" in items[GUIDE].files
    assert items[SAME2].files == [f"Home/Same {SAME2[:4]}-{SAME2[-4:]}/x.png"]
    assert items[SAME1].files == []


def test_rows_match_by_title_and_values() -> None:
    from app.modules.importer.notion_export import Item

    header = ["Name", "Stage", "Year"]
    rows = [["Mid review", "done", "2024"], ["Mid review", "draft", "2025"], ["", "", ""]]
    pages = [
        Item("1" * 32, "row", "Mid review", raw="# Mid review\n\nStage: draft\nYear: 2025\n"),
        Item("2" * 32, "row", "Mid review", raw="# Mid review\n\nStage: done\nYear: 2024\n"),
        Item("3" * 32, "row", "無題", raw="# 無題\n"),
        Item("4" * 32, "row", "Template", raw="# Template\n\nStage: draft\n"),
    ]
    matched, extra = match_rows(header, rows, pages)
    assert [m.nid for m in matched] == ["2" * 32, "1" * 32, "3" * 32]
    assert [m.nid for m in extra] == ["4" * 32]
    assert extra[0].values == ["Template", "draft", ""]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("2026年10月7日", {"start": "2026-10-07", "end": None, "time": False}),
        ("October 7, 2026", {"start": "2026-10-07", "end": None, "time": False}),
        ("2026/10/07", {"start": "2026-10-07", "end": None, "time": False}),
        (
            "October 7, 2026 → October 9, 2026",
            {"start": "2026-10-07", "end": "2026-10-09", "time": False},
        ),
        (
            "2026年10月7日 10:00 (JST)",
            {"start": "2026-10-07T10:00:00+09:00", "end": None, "time": True},
        ),
        (
            "2026年3月4日 13:40",  # created time: no zone (the --timezone)
            {"start": "2026-03-04T13:40:00+09:00", "end": None, "time": True},
        ),
        (
            "October 7, 2026 3:30 PM (GMT+2) → 5:00 PM",
            {
                "start": "2026-10-07T15:30:00+02:00",
                "end": "2026-10-07T17:00:00+02:00",
                "time": True,
            },
        ),
        (
            "October 7, 2026 3:30 PM → October 8, 2026 9:00 AM (GMT-5)",
            {
                "start": "2026-10-07T15:30:00-05:00",
                "end": "2026-10-08T09:00:00-05:00",
                "time": True,
            },
        ),
        (
            "2026年10月7日 → 2026年10月8日 9:00",
            {
                "start": "2026-10-07T00:00:00+09:00",
                "end": "2026-10-08T09:00:00+09:00",
                "time": True,
            },
        ),
        ("@October 7, 2026", {"start": "2026-10-07", "end": None, "time": False}),
    ],
)
def test_dates_as_notion_writes_them(raw: str, expected: dict[str, Any]) -> None:
    assert parse_date(raw, TOKYO) == expected


@pytest.mark.parametrize("raw", ["", "soon", "2026年13月1日", "October 9, 2026 → October 7, 2026"])
def test_not_dates(raw: str) -> None:
    assert parse_date(raw, TOKYO) is None


def test_relation_cells() -> None:
    cell = f"A (Db%20{ROW1}.md), B (https://www.notion.so/B-{ROW2}?pvs=21)"
    assert parse_relation(cell) == [("A", ROW1), ("B", ROW2)]
    assert parse_relation("plain, text") is None
    assert parse_relation("Foo (bar)") is None


def test_type_guessing_order() -> None:
    def guess(values: list[str], **kw: Any) -> str:
        args: dict[str, Any] = {"people": {}, "zone": TOKYO, "row_db": {}}
        args.update(kw)
        return guess_type(values, **args).type

    assert guess(["Yes", "No", ""]) == "checkbox"
    assert guess(["1,200", "3", "¥5"]) == "number"
    assert guess(["2026年10月7日", "October 7, 2026"]) == "date"
    assert guess(["https://a.example", "http://b.example/x"]) == "url"
    assert (
        guess(
            ["Taro Yamada", "taro, hanako"], people={"taro yamada": "1", "taro": "1", "hanako": "2"}
        )
        == "person"
    )
    assert guess(["a, b", "a", "b, c"]) == "multi_select"
    assert guess(["draft", "draft", "done"]) == "select"
    assert guess(["one", "two", "three"]) == "text"
    assert guess([f"A (x%20{ROW1}.md)"], row_db={ROW1: PAPERS}) == "relation"
    assert guess([f"A (x%20{ROW1}.md)"]) == "text"  # not a row of an imported database
    assert guess([], name="Date") == "date"
    assert guess([], name="Notes") == "text"


def test_markdown_conversion() -> None:
    body = (
        "<aside>\n💡\n\nRemember.\n\n</aside>\n"
        "<details>\n<summary>More</summary>\n\nInside\n\n</details>\n"
        "```\n<aside>\n[x](y.md)\n```\n"
        "a <u>b</u> `[c](d.md)` [e](f.md)\n"
    )
    seen: list[str] = []

    def link(link: Any, original: str) -> str:
        seen.append(link.url)
        return f"[{link.label}](page:X)"

    out = convert_markdown(body, link_fn=link, bare_fn=lambda s: s, mention_fn=lambda s: s)
    assert out.body == (
        "::: callout 💡\nRemember.\n:::\n::: toggle More\nInside\n:::\n"
        "```\n<aside>\n[x](y.md)\n```\n"
        "a b `[c](d.md)` [e](page:X)\n"
    )
    assert seen == ["f.md"]
    assert set(out.unsupported) == {"HTML のタグ（文字だけ残す）"}  # callouts and toggles fit


def test_column_types_file() -> None:
    assert parse_column_types(["# c", "", "Year = text", "Papers / Stage = select"]) == {
        "Year": "text",
        "Papers / Stage": "select",
    }


# --- the import ----------------------------------------------------------------------------------


async def test_dry_run_reports_and_writes_nothing(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    await _people(db)
    path = write_zip(tmp_path / "e.zip", export_files())
    report = await run_import(app, db, path, dry_run=True)
    assert report.dry_run
    assert report.counts["pages: new"] == 3
    assert report.counts["databases: new"] == 2
    assert report.counts["rows: new"] == 6  # 3 + a template, 2 people
    assert report.counts["files: new"] == 4  # diagram, pdf, heic (linked) + notes.txt (not)
    papers = next(d for d in report.databases if d.title == "Papers")
    types = {c.name: c.type for c in papers.columns}
    assert types == {
        "Done": "checkbox",
        "Count": "number",
        "Ratio": "number",
        "When": "date",
        "Link": "url",
        "Owner": "person",
        "Tags": "multi_select",
        "Stage": "select",
        "Note": "text",
        "Authors": "relation",
        "Due": "date",
    }
    assert papers.calendar and papers.extra_rows == 1
    assert any("Old" in line or "9" * 32 in line for line in report.unresolved_links)
    assert await _count(db, WikiPage) == 0
    assert await _count(db, ImportRef) == 0
    assert app.state.blobs.objects == {}


async def test_import_pages_databases_files_links(
    app: FastAPI, db: AsyncSession, tmp_path: Path, client: AsyncClient, as_user: Actor
) -> None:
    people = await _people(db)
    path = write_zip(tmp_path / "e.zip", export_files())
    report = await run_import(app, db, path)
    assert not report.dry_run and len(report.roots) == 1

    home = await _page(db, "Home")
    guide = await _page(db, "Guide")
    sub = await _page(db, "Sub")
    papers = await _page(db, "Papers", "database")
    people_db = await _page(db, "People", "database")
    alpha = await _page(db, "Alpha", "row")
    gamma = await _page(db, "Gamma", "row")
    assert home.parent_id is None and guide.parent_id == home.id and sub.parent_id == guide.id
    assert papers.parent_id == home.id and alpha.parent_id == papers.id
    assert home.created_by == people["admin"].id

    # links: pages, a database, notion.so URLs; code is left alone; mentions; HTML
    assert f"[guide](page:{guide.id})" in home.body
    assert f"[Papers](page:{papers.id})" in home.body
    assert f"(page:{guide.id})" in home.body.split("Elsewhere:")[1]
    assert "```\n[not a link](Home/Guide%20" in home.body
    assert "`[[code]](x.md)`" in home.body
    assert "Gone: old" in home.body
    assert f"Ask <@{people['taro'].id}> please." in home.body
    assert "::: callout 💡\nRemember **this**.\n:::" in home.body  # M149
    assert "::: toggle More\nhidden text\n:::" in home.body
    assert "<span" not in home.body and "red words\nnext line." in home.body
    assert f"Back to [Home](page:{home.id})" in sub.body
    assert f"See [Alpha](page:{alpha.id})." in gamma.body
    assert "Stage: done" not in gamma.body  # the property lines are the row's values now
    links = await db.execute(
        text("SELECT dst_page_id FROM wiki_links WHERE src_page_id = :p"), {"p": home.id}
    )
    assert {guide.id, papers.id, people_db.id} <= {r[0] for r in links.all()}

    # files: attachments of the page, checked like uploads
    files = {
        a.filename: a
        for a in (
            await db.execute(select(Attachment).where(Attachment.page_id == guide.id))
        ).scalars()
    }
    assert set(files) == {"diagram.png", "spec (v2).pdf", "photo.heic", "notes.txt"}
    diagram = files["diagram.png"]
    assert diagram.status == "attached" and diagram.thumbnail_key and diagram.width == 30
    assert await app.state.blobs.exists(diagram.storage_key)
    assert f"![](attachment:{diagram.id})" in guide.body
    assert f"[spec (v2).pdf](attachment:{files['spec (v2).pdf'].id})" in guide.body
    # an image Taylis does not show inline becomes a file chip
    assert f"[photo.heic](attachment:{files['photo.heic'].id})" in guide.body
    assert guide.body.rstrip().endswith(f"[notes.txt](attachment:{files['notes.txt'].id})")
    assert "$$\nE = mc^2\n$$" in guide.body

    # the database: typed properties, values, views (the view CSV's columns, a calendar)
    record = await db.get(WikiDatabase, papers.id)
    assert record is not None
    props = {p["name"]: p for p in record.schema_doc["properties"]}
    assert props["Name"]["type"] == "title"
    assert props["Ratio"]["number_format"] == "percent"
    table, calendar = record.views
    shown = [c["prop_id"] for c in table["columns"] if not c["hidden"]]
    assert shown == [props["Stage"]["id"], props["Done"]["id"]]
    assert calendar["type"] == "calendar" and calendar["date_prop_id"] == props["When"]["id"]
    values = alpha.props or {}
    option = {o["name"]: o["id"] for o in props["Tags"]["options"]}
    assert values[props["Done"]["id"]] is True
    assert values[props["Count"]["id"]] == 1200
    assert values[props["Ratio"]["id"]] == 0.5
    assert values[props["When"]["id"]] == {
        "start": "2026-10-07T10:00:00+09:00",
        "end": None,
        "time": True,
    }
    assert values[props["Owner"]["id"]] == [str(people["taro"].id)]
    assert values[props["Tags"]["id"]] == [option["ml"], option["vision"]]
    assert values[props["Note"]["id"]] == "first one"
    assert "Alpha's notes." in alpha.body
    beta = await _page(db, "Beta", "row")
    assert (beta.props or {})[props["When"]["id"]]["end"] == "2026-10-09"
    assert props["Done"]["id"] not in (beta.props or {})  # No: an empty box
    template = await _page(db, "Template", "row")
    assert template.parent_id == papers.id

    # relations: both CSVs say the same links the other way round → one two-way relation
    people_record = await db.get(WikiDatabase, people_db.id)
    assert people_record is not None
    authors = props["Authors"]
    reverse = next(p for p in people_record.schema_doc["properties"] if p["name"] == "Papers")
    assert authors["relation"] == {
        "database_id": str(people_db.id),
        "pair_id": reverse["id"],
        "primary": True,
    }
    assert reverse["relation"] == {
        "database_id": str(papers.id),
        "pair_id": authors["id"],
        "primary": False,
    }
    ann = await _page(db, "Ann", "row")
    bob = await _page(db, "Bob", "row")
    rows = await db.execute(
        text(
            "SELECT src_page_id, dst_page_id FROM wiki_relations WHERE prop_id = :p "
            "ORDER BY src_page_id, position"
        ),
        {"p": authors["id"]},
    )
    assert sorted(rows.all()) == sorted(
        [(alpha.id, ann.id), (gamma.id, ann.id), (gamma.id, bob.id)]
    )

    # the API reads it like any database (the reverse side too)
    as_user(people["bob"])
    response = await client.post(f"{API}/wiki/databases/{people_db.id}/query", json={"limit": 10})
    assert response.status_code == 200, response.text
    ann_row = next(r for r in response.json()["rows"] if r["title"] == "Ann")
    assert set(ann_row["relations"][reverse["id"]]) == {str(alpha.id), str(gamma.id)}
    # imported versions are of kind import, by the importing administrator
    revision = await db.get(WikiPageRevision, home.head_rev_id)
    assert revision is not None and revision.kind == "import"
    assert revision.author_id == people["admin"].id
    assert (await access.verify(db)) == []


async def test_access_defaults_and_private_import_does_not_leak(
    app: FastAPI, db: AsyncSession, tmp_path: Path, client: AsyncClient, as_user: Actor
) -> None:
    people = await _people(db)
    path = write_zip(tmp_path / "e.zip", export_files())
    await run_import(app, db, path, options=Options(access="private"))
    home = await _page(db, "Home")
    guide = await _page(db, "Guide")
    grants = await db.execute(
        text("SELECT principal_type, principal_id, level FROM wiki_grants WHERE page_id = :p"),
        {"p": home.id},
    )
    assert grants.all() == [("user", people["admin"].id, "full")]
    diagram = (
        await db.execute(select(Attachment).where(Attachment.filename == "diagram.png"))
    ).scalar_one()

    as_user(people["bob"])
    tree = await client.get(f"{API}/wiki/tree")
    assert tree.json()["pages"] == []
    for url in (
        f"{API}/wiki/pages/{guide.id}",
        f"{API}/attachments/{diagram.id}",
    ):
        assert (await client.get(url)).status_code == 404, url
    search = await client.get(f"{API}/search/pages", params={"q": "Remember"})
    assert search.status_code == 200 and search.json()["hits"] == []

    as_user(people["admin"])
    assert (await client.get(f"{API}/wiki/pages/{guide.id}")).status_code == 200


async def test_access_workspace_and_under_a_parent(
    app: FastAPI, db: AsyncSession, tmp_path: Path, client: AsyncClient, as_user: Actor
) -> None:
    people = await _people(db)
    path = write_zip(tmp_path / "e.zip", {f"Home {HOME}.md": "# Home\n\nhello\n"})
    await run_import(app, db, path)  # the default: the workspace edits, the admin manages
    home = await _page(db, "Home")
    grants = await db.execute(
        text("SELECT principal_type, level FROM wiki_grants WHERE page_id = :p ORDER BY 1"),
        {"p": home.id},
    )
    assert grants.all() == [("user", "full"), ("workspace", "edit")]
    as_user(people["bob"])
    response = await client.get(f"{API}/wiki/pages/{home.id}")
    assert response.status_code == 200 and response.json()["my_level"] == "edit"

    # under a parent: the imported pages inherit (nothing of their own) …
    as_user(people["admin"])
    parent = (
        await client.post(
            f"{API}/wiki/pages",
            json={"client_save_id": key(), "title": "Imports", "access": "private"},
        )
    ).json()
    other = write_zip(tmp_path / "o.zip", {f"Other {GUIDE}.md": "# Other\n"})
    import uuid

    await run_import(app, db, other, options=Options(parent_id=uuid.UUID(parent["id"])))
    imported = await _page(db, "Other")
    assert str(imported.parent_id) == parent["id"]
    assert (
        await db.scalar(
            text("SELECT count(*) FROM wiki_grants WHERE page_id = :p"), {"p": imported.id}
        )
        == 0
    )
    as_user(people["bob"])
    assert (await client.get(f"{API}/wiki/pages/{imported.id}")).status_code == 404
    # … unless --access says otherwise
    third = write_zip(tmp_path / "t.zip", {f"Third {SUB}.md": "# Third\n"})
    await run_import(
        app, db, third, options=Options(parent_id=uuid.UUID(parent["id"]), access="workspace-view")
    )
    response = await client.get(f"{API}/wiki/pages/{(await _page(db, 'Third')).id}")
    assert response.status_code == 200 and response.json()["my_level"] == "view"
    # a parent the administrator cannot edit is refused
    with pytest.raises(ImportFailed):
        await run_import(app, db, third, options=Options(parent_id=uuid.uuid4()))


async def test_run_again_adds_new_overwrites_unchanged_leaves_edited(
    app: FastAPI, db: AsyncSession, tmp_path: Path, client: AsyncClient, as_user: Actor
) -> None:
    people = await _people(db)
    path = write_zip(tmp_path / "e.zip", export_files())
    await run_import(app, db, path)
    pages, revisions, files = (
        await _count(db, WikiPage),
        await _count(db, WikiPageRevision),
        await _count(db, Attachment),
    )

    # the same export again: nothing new, nothing rewritten
    again = await run_import(app, db, path)
    assert again.counts["pages: same"] == 3 and again.counts["rows: same"] == 6
    assert (
        await _count(db, WikiPage),
        await _count(db, WikiPageRevision),
        await _count(db, Attachment),
    ) == (
        pages,
        revisions,
        files,
    )

    # someone edits Guide's body and Alpha's values in Taylis
    guide = await _page(db, "Guide")
    as_user(people["bob"])
    page = (await client.get(f"{API}/wiki/pages/{guide.id}")).json()
    assert (await save(client, page, page["body"] + "\nMy addition.\n")).status_code == 200
    alpha = await _page(db, "Alpha", "row")
    papers = await _page(db, "Papers", "database")
    record = await db.get(WikiDatabase, papers.id)
    assert record is not None
    note = next(p for p in record.schema_doc["properties"] if p["name"] == "Note")
    response = await client.patch(
        f"{API}/wiki/rows/{alpha.id}/props",
        json={"set": {note["id"]: "changed here"}, "client_op_id": key()},
    )
    assert response.status_code == 200, response.text

    # a newer export: Home, Guide, Alpha and Beta changed there; a page and a column are new
    changed = export_files()
    changed[f"Home {HOME}.md"] = str(changed[f"Home {HOME}.md"]).replace("Intro", "Introduction")
    changed[f"Home/Guide {GUIDE}.md"] = str(changed[f"Home/Guide {GUIDE}.md"]) + "\nNew line.\n"
    changed[f"Home/Papers/Beta {ROW2}.md"] = "# Beta\n\nDone: No\nStage: draft\n\nNow with notes.\n"
    changed[f"Home/New {'f' * 32}.md"] = "# New\n\nfresh\n"
    rows = list(csv.reader(io.StringIO(str(changed[f"Home/Papers {PAPERS}_all.csv"]))))
    rows[0].append("Extra")
    rows[1].append("x")
    rows[1][rows[0].index("Note")] = "first one, revised"
    for row in rows[2:]:
        row.append("")
    changed[f"Home/Papers {PAPERS}_all.csv"] = csv_text(rows)
    newer = write_zip(tmp_path / "newer.zip", changed)
    report = await run_import(app, db, newer)

    assert report.counts["pages: new"] == 1 and report.counts["pages: edited"] == 1
    assert report.counts["pages: update"] == 1  # Home
    assert report.counts["rows: edited"] == 1 and report.counts["rows: update"] == 1  # Beta
    assert any("Guide" in line for line in report.edited)
    assert any("Alpha" in line for line in report.edited)
    home = await _page(db, "Home")
    assert "Introduction" in home.body
    head = await db.get(WikiPageRevision, home.head_rev_id)
    assert head is not None and head.kind == "import" and head.version == 2
    guide = await _page(db, "Guide")
    assert "My addition." in guide.body and "New line." not in guide.body
    alpha = await _page(db, "Alpha", "row")
    assert (alpha.props or {})[note["id"]] == "changed here"
    beta = await _page(db, "Beta", "row")
    assert "Now with notes." in beta.body
    record = await db.get(WikiDatabase, papers.id)
    await db.refresh(record)
    assert record is not None and any(p["name"] == "Extra" for p in record.schema_doc["properties"])
    new = await _page(db, "New")
    assert new.parent_id == home.id
    assert (await access.verify(db)) == []


async def test_bad_input(app: FastAPI, db: AsyncSession, tmp_path: Path) -> None:
    await _people(db)
    not_zip = tmp_path / "x.zip"
    not_zip.write_bytes(b"nope")
    with pytest.raises(ImportFailed):
        await run_import(app, db, not_zip)
    empty = write_zip(tmp_path / "empty.zip", {"readme.txt": "hi"})
    with pytest.raises(ImportFailed):
        await run_import(app, db, empty)
    with pytest.raises(ImportFailed):
        await import_notion(
            db,
            empty,
            actor_username="taro",  # not an administrator
            blobs=app.state.blobs,
            settings=app.state.settings,
            options=Options(),
            dry_run=True,
        )


async def test_long_pages_go_on_in_continuations_and_row_subpages_move_up(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    await _people(db)
    paragraph = "あいうえお" * 19 + "\n\n"  # 97 characters a paragraph
    files: dict[str, bytes | str] = {
        f"Home {HOME}.md": "# Home\n\n" + paragraph * 2_100,  # about 204,000 characters
        f"Home/Db {PAPERS}_all.csv": "Name\nRow\n",
        f"Home/Db/Row {ROW1}.md": "# Row\n",
        f"Home/Db/Row/Child {SUB}.md": "# Child\n\nunder a row\n",
    }
    report = await run_import(app, db, write_zip(tmp_path / "e.zip", files))
    home = await _page(db, "Home")
    two = await _page(db, "Home（続き 2）")
    three = await _page(db, "Home（続き 3）")
    assert two.parent_id == home.id and three.parent_id == home.id
    total = len(home.body) + len(two.body) + len(three.body)
    assert total >= len(paragraph) * 2_100 - 10
    assert all(len(p.body) <= 100_000 for p in (home, two, three))
    child = await _page(db, "Child")
    assert child.parent_id == home.id  # rows hold no pages: placed under the database's page
    assert any("本文が長い" in w for w in report.warnings)
    assert any("Child" in w for w in report.warnings)
    again = await run_import(app, db, write_zip(tmp_path / "e2.zip", files))
    assert again.counts["pages: same"] == 4


async def test_large_files_are_reported_not_imported(
    app: FastAPI, db: AsyncSession, tmp_path: Path
) -> None:
    await _people(db)
    files: dict[str, bytes | str] = {
        f"Home {HOME}.md": "# Home\n\n[big.bin](Home/big.bin)\n\n[empty.txt](Home/empty.txt)\n",
        "Home/big.bin": b"x" * (app.state.settings.attachment_max_bytes + 1),
        "Home/empty.txt": b"",
    }
    report = await run_import(app, db, write_zip(tmp_path / "e.zip", files))
    assert report.counts["files failed"] == 2 and len(report.failed_files) == 2
    home = await _page(db, "Home")
    assert "big.bin" in home.body and "attachment:" not in home.body
    assert await _count(db, Attachment) == 0


async def test_cli_parses_import_notion() -> None:
    from app import cli

    args = cli.build_parser().parse_args(
        ["import-notion", "x.zip", "--actor", "admin", "--access", "private", "--dry-run"]
    )
    assert args.func is cli.cmd_import_notion and args.access == "private" and args.dry_run
    assert cli._notion_user_map(["Taro Yamada=taro"], []) == {"Taro Yamada": "taro"}
