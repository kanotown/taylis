"""備品 L7 (M173, docs/LENDING.md §5.4, §11, §13.3, §13.5, §17.7): the CSV export (keepers, UTF-8
with a BOM, formulas defused, the borrower and the due date) and the import (dry run, then
applied in one transaction; matched by control number, else by name; categories created; a second
import of the same file, and of an export, reports everything unchanged; per-row errors keep the
whole file out; Shift_JIS; the file limits), `GET /lending/summary`, the morning's single
`lending.updated`, and the `/eq/<id>` landing page."""

import csv
import io
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.audit.models import AuditLog
from app.modules.lending import notices
from app.modules.lending.models import LendingCategory, LendingItem, LendingItemEvent
from app.modules.users.models import User
from tests.lending_helpers import API, LoanLab, _code, _ok, freeze, make_lab

HEADER = "管理番号,名前,分類,置き場所,状態,許可が要る,最長の日数,付属品とメモ,借りている人,返す日"


def _csv(*lines: str, header: str = HEADER) -> bytes:
    return ("\r\n".join([header, *lines]) + "\r\n").encode("utf-8")


async def _import(
    lab: LoanLab, data: bytes, *, dry_run: bool = True, user: User | None = None
) -> Response:
    lab.as_user(user or lab.keeper)
    return await lab.client.post(
        f"{API}/lending/items/import",
        params={"dry_run": str(dry_run).lower()},
        files={"file": ("items.csv", data, "text/csv")},
    )


async def _export(lab: LoanLab, user: User | None = None, **params: Any) -> Response:
    lab.as_user(user or lab.keeper)
    return await lab.client.get(f"{API}/lending/items/export.csv", params=params)


def _rows(response: Response) -> list[list[str]]:
    assert response.content.startswith(b"\xef\xbb\xbf")  # the BOM
    return list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))


async def _lab(
    db: AsyncSession,
    client: AsyncClient,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> LoanLab:
    freeze(monkeypatch)
    return await make_lab(db, client, as_user)


async def _count(db: AsyncSession, model: Any) -> int:
    return int(await db.scalar(select(func.count()).select_from(model)) or 0)


# --- the export --------------------------------------------------------------------------------


async def test_export_columns_formulas_loans_and_who_may(
    db: AsyncSession,
    client: AsyncClient,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab = await _lab(db, client, as_user, monkeypatch)
    as_user(lab.keeper)
    camera = await _ok(await client.post(f"{API}/lending/categories", json={"name": "カメラ"}), 201)
    cam = await lab.item(
        name="カメラ A",
        code="CAM-02",
        category_id=camera["id"],
        location="301 棚 2",
        notes="充電器・ケース\nSD 64 GB",
        requires_permission=False,
        max_days=7,
    )
    await lab.item(name='=HYPERLINK("http://evil")', code="-01", location="@here")
    retired = await lab.item(name="古い PC", code="PC-00")
    await _ok(
        await client.post(f"{API}/lending/items/{retired['id']}/status", json={"status": "retired"})
    )
    await lab.borrow(lab.member, cam["id"], due=3)

    response = await _export(lab)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert (
        response.headers["content-disposition"]
        == f'attachment; filename="equipment-{datetime.now(UTC):%Y%m%d}.csv"'
    )
    rows = _rows(response)
    assert rows[0] == HEADER.split(",")
    assert rows[1:] == [
        ["'-01", '\'=HYPERLINK("http://evil")', "", "'@here", "貸出可", "", "", "", "", ""],
        [
            "CAM-02",
            "カメラ A",
            "カメラ",
            "301 棚 2",
            "貸出中",
            "要らない",
            "7",
            "充電器・ケース\nSD 64 GB",
            "Alice",
            "2026-10-29",
        ],
    ]
    everything = _rows(await _export(lab, include_retired="true"))
    assert [r[1] for r in everything[1:]][-1] == "古い PC" and everything[-1][4] == "廃棄"

    member = await _export(lab, lab.member)
    assert member.status_code == 403 and _code(member) == "lending_keeper_required"
    guest = await _export(lab, lab.guest)
    assert guest.status_code == 403 and _code(guest) == "guest_restricted"


# --- the import --------------------------------------------------------------------------------


async def test_import_dry_run_apply_and_again_unchanged(
    db: AsyncSession,
    client: AsyncClient,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab = await _lab(db, client, as_user, monkeypatch)
    existing = await lab.item(name="三脚", code="TRI-1", location="棚 A")
    data = _csv(
        'CAM-01,カメラ A,カメラ,301 棚 2,貸出可,要る,7,"充電器\nケース",,',
        "cam-02,カメラ B,カメラ,301 棚 2,,,,,,",
        "TRI-1,三脚,,棚 B,,要らない,,,,",
        ",延長コード,ケーブル,,,,,,,",
        "OLD-1,古いもの,,,廃棄,,,,,",
        ",,,,,,,,,",
    )
    dry = await _ok(await _import(lab, data))
    assert (dry["dry_run"], dry["created"], dry["updated"], dry["unchanged"], dry["skipped"]) == (
        True,
        3,
        1,
        0,
        1,
    )
    assert dry["errors"] == [] and dry["new_categories"] == ["カメラ", "ケーブル"]
    by_line = {r["line"]: r for r in dry["rows"]}
    assert sorted(by_line) == [2, 4, 5, 6, 7]  # the camera's notes take lines 2-3; blank rows go
    assert by_line[2]["action"] == "created" and by_line[2]["item_id"] is None
    assert by_line[5]["action"] == "updated" and by_line[5]["item_id"] == existing["id"]
    assert by_line[5]["changes"] == [
        {"field": "location", "before": "棚 A", "after": "棚 B"},
        {"field": "requires_permission", "before": None, "after": "false"},
    ]
    assert by_line[7] == {
        "line": 7,
        "action": "skipped",
        "item_id": None,
        "name": "古いもの",
        "code": "OLD-1",
        "changes": [],
    }
    assert await _count(db, LendingItem) == 1  # a dry run writes nothing
    assert await _count(db, LendingCategory) == 0

    applied = await _ok(await _import(lab, data, dry_run=False))
    assert (applied["created"], applied["updated"], applied["skipped"]) == (3, 1, 1)
    created = [r["item_id"] for r in applied["rows"] if r["action"] == "created"]
    assert len(created) == 3 and all(created)
    as_user(lab.member)
    items = {i["code"] or i["name"]: i for i in await _ok(await client.get(f"{API}/lending/items"))}
    cam = items["CAM-01"]
    assert (cam["notes"], cam["max_days"], cam["max_days_source"]) == ("充電器\nケース", 7, "item")
    assert cam["requires_permission"] is True and cam["requires_permission_source"] == "item"
    assert items["cam-02"]["requires_permission_source"] == "category"
    assert items["TRI-1"]["location"] == "棚 B" and items["TRI-1"]["requires_permission"] is False
    categories = await _ok(await client.get(f"{API}/lending/categories"))
    assert [(c["name"], c["position"]) for c in categories] == [("カメラ", 0), ("ケーブル", 1)]
    assert items["延長コード"]["category_id"] == categories[1]["id"]

    history = await db.scalars(
        select(LendingItemEvent).where(LendingItemEvent.item_id == uuid.UUID(existing["id"]))
    )
    updated = [e for e in history.all() if e.kind == "updated"]
    assert updated and updated[-1].details["via"] == "import"
    assert updated[-1].details["fields"] == ["location", "requires_permission"]
    audit = (
        await db.scalars(select(AuditLog).where(AuditLog.action == "lending_import.applied"))
    ).one()
    assert audit.details["created"] == 3 and audit.details["categories_created"] == [
        "カメラ",
        "ケーブル",
    ]
    events = (
        await db.scalars(
            select(OutboxEvent)
            .where(OutboxEvent.event_type == "lending.updated")
            .order_by(OutboxEvent.id.desc())
        )
    ).first()
    assert events is not None and events.payload["categories"] is True
    assert len(events.payload["item_ids"]) == 4

    # The same file again, and the export of the ledger: nothing to do.
    again = await _ok(await _import(lab, data, dry_run=False))
    assert (again["created"], again["updated"], again["unchanged"], again["skipped"]) == (
        0,
        0,
        4,
        1,
    )
    exported = (await _export(lab)).content
    assert exported.startswith(b"\xef\xbb\xbf")
    round_trip = await _ok(await _import(lab, exported, dry_run=False))
    assert (round_trip["created"], round_trip["updated"], round_trip["unchanged"]) == (0, 0, 4)
    assert await _count(db, LendingItem) == 4
    assert (
        await db.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.action == "lending_import.applied")
        )
        == 1
    )


async def test_round_trip_keeps_formula_like_values_and_loans_alone(
    db: AsyncSession,
    client: AsyncClient,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab = await _lab(db, client, as_user, monkeypatch)
    item = await lab.item(name="+ケーブル", code="=A1", location="-棚", notes="@メモ")
    await lab.borrow(lab.member, item["id"], due=2)
    exported = (await _export(lab)).content
    out = await _ok(await _import(lab, exported, dry_run=False))
    assert (out["created"], out["updated"], out["unchanged"]) == (0, 0, 1)
    as_user(lab.member)
    after = await _ok(await client.get(f"{API}/lending/items/{item['id']}"))
    assert (after["name"], after["code"], after["location"], after["notes"]) == (
        "+ケーブル",
        "=A1",
        "-棚",
        "@メモ",
    )
    assert after["status"] == "on_loan"  # the status and the loan are never imported


async def test_round_trip_keeps_leading_apostrophes(
    db: AsyncSession,
    client: AsyncClient,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """REVIEW-v0.1.82 #8: a value that starts with `'` (before a formula's first character, before
    another `'`, or before anything) comes back as it was; a formula-like value stays defused."""
    lab = await _lab(db, client, as_user, monkeypatch)
    lab.as_user(lab.keeper)
    category = await _ok(
        await client.post(f"{API}/lending/categories", json={"name": "'+分類"}), 201
    )
    values = {"name": "''二重", "code": "'=CAM-1", "location": "'棚", "notes": "'=original"}
    item = await lab.item(category_id=category["id"], **values)
    plain = await lab.item(name="=SUM(A1)", code="-2", notes="'@x")
    first = (await _export(lab)).content
    rows = {r[1]: r for r in _rows(await _export(lab))[1:]}
    # Every cell that starts with `'` or a formula's first character gets one more `'`: a
    # spreadsheet shows text, never a formula.
    assert rows["'''二重"][:4] == ["''=CAM-1", "'''二重", "''+分類", "''棚"]
    assert rows["'''二重"][7] == "''=original"
    assert (rows["'=SUM(A1)"][0], rows["'=SUM(A1)"][7]) == ("'-2", "''@x")
    out = await _ok(await _import(lab, first, dry_run=False))
    assert (out["created"], out["updated"], out["unchanged"]) == (0, 0, 2)
    as_user(lab.member)
    after = await _ok(await client.get(f"{API}/lending/items/{item['id']}"))
    assert {k: after[k] for k in values} == values
    assert after["category_id"] == category["id"]
    again = await _ok(await client.get(f"{API}/lending/items/{plain['id']}"))
    assert (again["name"], again["code"], again["notes"]) == ("=SUM(A1)", "-2", "'@x")
    assert (await _export(lab)).content == first  # export → import → export: the same file
    # A hand-written `'abc` (no formula after the `'`) is not the export's guard: it stays.
    out = await _ok(await _import(lab, _csv(",'手書き,,,,,,,,"), dry_run=False))
    assert out["created"] == 1
    assert "''手書き" in {r[1] for r in _rows(await _export(lab))[1:]}


async def test_row_errors_keep_the_whole_file_out(
    db: AsyncSession,
    client: AsyncClient,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab = await _lab(db, client, as_user, monkeypatch)
    await lab.item(name="延長コード")
    await lab.item(name="延長コード")
    data = _csv(
        "A-1,カメラ,,,,,,,,",
        "A-1,カメラ 2,,,,,,,,",
        "B-1,,,,,,,,,",
        "C-1,本,,,,たぶん,,,,",
        "D-1,PC,,,,,400,,,",
        ",延長コード,,,,,,,,",
        f"E-1,{'あ' * 81},,,,,,,,",
        ",ケーブル,,,,,,,,",
        ",ケーブル,,,,,,,,",
    )
    dry = await _ok(await _import(lab, data))
    errors = [(e["line"], e["code"]) for e in dry["errors"]]
    assert errors == [
        (3, "code_duplicate"),
        (4, "name_required"),
        (5, "permission_invalid"),
        (6, "max_days_invalid"),
        (7, "name_ambiguous"),
        (8, "too_long"),
        (10, "name_duplicate"),
    ]
    messages = {e["code"]: e["message"] for e in dry["errors"]}
    assert messages["code_duplicate"] == "管理番号「A-1」が 2 行目にもあります。"
    assert messages["permission_invalid"].startswith("「許可が要る」は「要る」「要らない」か空欄")
    assert [r["line"] for r in dry["rows"]] == [2, 9]

    applied = await _import(lab, data, dry_run=False)
    assert applied.status_code == 400 and _code(applied) == "lending_csv_invalid"
    assert len(applied.json()["error"]["details"]["errors"]) == 7
    assert await _count(db, LendingItem) == 2

    # English for an English reader; a keeper only.
    lab.as_user(lab.keeper)
    english = await client.post(
        f"{API}/lending/items/import",
        files={"file": ("items.csv", _csv("A-1,,,,,,,,,"), "text/csv")},
        headers={"Accept-Language": "en"},
    )
    assert (await _ok(english))["errors"][0]["message"] == "“名前” is empty."
    member = await _import(lab, data, user=lab.member)
    assert member.status_code == 403 and _code(member) == "lending_keeper_required"


async def test_shift_jis_english_headers_and_partial_columns(
    db: AsyncSession,
    client: AsyncClient,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab = await _lab(db, client, as_user, monkeypatch)
    item = await lab.item(name="統計学入門", code="図-0123", location="本棚 B", notes="付箋あり")
    sjis = "名前,管理番号,置き場所\r\n統計学入門,図-0123,本棚 C\r\nカメラ,CAM-9,棚\r\n".encode(
        "cp932"
    )
    out = await _ok(await _import(lab, sjis, dry_run=False))
    assert (out["created"], out["updated"]) == (1, 1)
    as_user(lab.member)
    after = await _ok(await client.get(f"{API}/lending/items/{item['id']}"))
    assert (after["location"], after["notes"]) == ("本棚 C", "付箋あり")  # no notes column: kept

    english = b"Name,Code,Max days,Requires permission\r\nTripod,TRI-9,10 days,yes\r\n"
    out = await _ok(await _import(lab, english, dry_run=False))
    assert out["created"] == 1
    items = {i["code"]: i for i in await _ok(await client.get(f"{API}/lending/items"))}
    assert (items["TRI-9"]["max_days"], items["TRI-9"]["requires_permission"]) == (10, True)


async def test_file_errors(
    db: AsyncSession,
    client: AsyncClient,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab = await _lab(db, client, as_user, monkeypatch)

    async def file_error(data: bytes) -> str:
        response = await _import(lab, data)
        assert response.status_code == 400 and _code(response) == "lending_csv_invalid"
        (error,) = response.json()["error"]["details"]["errors"]
        assert error["line"] == 0 and error["message"]
        return str(error["code"])

    assert await file_error(b"code,place\r\nA,B\r\n") == "no_name_column"
    assert await file_error(HEADER.encode() + b"\r\n") == "empty"
    assert await file_error(b"\xff\xfe\x00\x81\x00") == "encoding"
    assert await file_error(b"name\r\n" + b"x" * (1024 * 1024)) == "too_large"
    rows = "\r\n".join(f"ITEM-{n},備品 {n}" for n in range(2001))
    assert await file_error(f"管理番号,名前\r\n{rows}\r\n".encode()) == "too_many_rows"


async def test_three_hundred_rows(
    db: AsyncSession,
    client: AsyncClient,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab = await _lab(db, client, as_user, monkeypatch)
    lines = [f"PC-{n:03},ノート PC {n},PC,302 机,,,30,充電器,," for n in range(300)]
    data = _csv(*lines)
    out = await _ok(await _import(lab, data, dry_run=False))
    assert out["created"] == 300 and out["new_categories"] == ["PC"]
    again = await _ok(await _import(lab, data))
    assert again["unchanged"] == 300


# --- GET /lending/summary ------------------------------------------------------------------------


async def test_summary_is_the_bootstraps_lending(
    db: AsyncSession,
    client: AsyncClient,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab = await _lab(db, client, as_user, monkeypatch)
    item = await lab.item()
    await lab.borrow(lab.member, item["id"], due=0)
    for user in (lab.member, lab.keeper, lab.bob):
        as_user(user)
        boot = (await _ok(await client.get(f"{API}/sync/bootstrap")))["lending"]
        assert await _ok(await client.get(f"{API}/lending/summary")) == boot
    as_user(lab.member)
    assert (await _ok(await client.get(f"{API}/lending/summary")))["my_active_count"] == 1
    as_user(lab.guest)
    guest = await client.get(f"{API}/lending/summary")
    assert guest.status_code == 403 and _code(guest) == "guest_restricted"
    as_user(lab.admin)
    await _ok(await client.patch(f"{API}/admin/lending/settings", json={"enabled": False}))
    as_user(lab.member)
    off = await client.get(f"{API}/lending/summary")
    assert off.status_code == 409 and _code(off) == "lending_disabled"


# --- the morning's lending.updated ---------------------------------------------------------------


def _jst(month: int, day: int, hour: int) -> datetime:
    return datetime(2026, month, day, hour, tzinfo=UTC) - timedelta(hours=9)


async def _tick(app: FastAPI, now: datetime) -> int:
    async with app.state.db.session_factory() as session:
        return await notices.tick(session, now=now)


async def _updates(db: AsyncSession) -> list[dict[str, Any]]:
    rows = await db.scalars(
        select(OutboxEvent)
        .where(OutboxEvent.event_type == "lending.updated")
        .order_by(OutboxEvent.id)
        .execution_options(populate_existing=True)
    )
    return [r.payload for r in rows.all()]


async def test_the_morning_tells_clients_once_when_loans_fall_due(
    app: FastAPI,
    db: AsyncSession,
    client: AsyncClient,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab = await _lab(db, client, as_user, monkeypatch)
    a = await lab.item(name="カメラ A")
    b = await lab.item(name="カメラ B")
    await lab.borrow(lab.member, a["id"], due=1)  # 10/27
    await lab.borrow(lab.bob, b["id"], due=2)  # 10/28
    before = len(await _updates(db))
    # 10/27 9:00: A is due today (it counts), B's day-before reminder does not; one event.
    assert await _tick(app, _jst(10, 27, 9)) == 2
    updates = await _updates(db)
    assert len(updates) == before + 1 and updates[-1]["item_ids"] == [a["id"]]
    # The next tick that day writes nothing and says nothing.
    assert await _tick(app, _jst(10, 27, 10)) == 0
    assert len(await _updates(db)) == before + 1
    # 10/28: A overdue, B due: one event naming both.
    assert await _tick(app, _jst(10, 28, 9)) == 2
    updates = await _updates(db)
    assert len(updates) == before + 2
    assert sorted(updates[-1]["item_ids"]) == sorted([a["id"], b["id"]])


# --- the label's link ----------------------------------------------------------------------------


async def test_equipment_link_landing_page(client: AsyncClient) -> None:
    item_id = uuid.uuid4()
    page = await client.get(f"/eq/{item_id}")
    assert page.status_code == 200 and "Taylis の備品" in page.text
    assert page.headers["x-robots-tag"] == "noindex"
    assert (await client.get("/eq/not-an-id")).status_code == 404
