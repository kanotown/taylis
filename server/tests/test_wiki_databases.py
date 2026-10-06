"""Wiki databases, the server (M123, docs/WIKI.md §5): property types and values, type changes,
the last write per cell, sort / filter / views, the calendar range, CSV, relations both ways and
who can see what through them, events, search and the rows' place outside the tree."""

import csv
import io
import uuid
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from app.modules.wiki import dbschema, events
from app.modules.wiki.models import WikiPageRevision, WikiPropLegacy
from tests.helpers import make_user
from tests.wiki_helpers import (
    API,
    Actor,
    add_row,
    assert_acl_consistent,
    create_database,
    create_page,
    key,
    option_id,
    prop_id,
    query,
    schema,
    set_access,
    set_cells,
    titles,
)

ALL_TYPES: list[dict[str, Any]] = [
    {"op": "add", "name": "Notes", "type": "text"},
    {"op": "add", "name": "Year", "type": "number", "number_format": "integer"},
    {
        "op": "add",
        "name": "Stage",
        "type": "select",
        "options": [{"name": "読む", "color": "blue"}, {"name": "読んだ", "color": "green"}],
    },
    {
        "op": "add",
        "name": "Tags",
        "type": "multi_select",
        "options": [{"name": "ML"}, {"name": "HCI"}],
    },
    {"op": "add", "name": "Due", "type": "date"},
    {"op": "add", "name": "Readers", "type": "person"},
    {"op": "add", "name": "Done", "type": "checkbox"},
    {"op": "add", "name": "Link", "type": "url"},
    {"op": "add", "name": "Made", "type": "created_time"},
    {"op": "add", "name": "Maker", "type": "created_by"},
]


async def _setup(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> tuple[User, dict[str, Any]]:
    alice = await make_user(db, "alice")
    as_user(alice)
    database = await create_database(client)
    await schema(client, database, *ALL_TYPES)
    return alice, database


# --- the database and its rows -------------------------------------------------------------------


async def test_a_database_is_a_page_and_its_rows_stay_out_of_the_tree(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    parent = await create_page(client, title="Lab")
    database = await create_database(client, parent_id=parent["id"])
    assert [p["type"] for p in database["properties"]] == ["title"]
    assert database["properties"][0]["name"] == ""
    assert len(database["views"]) == 1 and database["views"][0]["type"] == "table"
    assert database["my_level"] == "full" and database["row_count"] == 0
    row = await add_row(client, database, "First paper")
    tree = (await client.get(f"{API}/wiki/tree")).json()
    kinds = {p["id"]: p["kind"] for p in tree["pages"]}
    assert kinds[database["page_id"]] == "database"
    assert row["id"] not in kinds
    changes = (await client.get(f"{API}/wiki/changes", params={"since": 0})).json()
    assert row["id"] not in {p["id"] for p in changes["pages"]}
    page = (await client.get(f"{API}/wiki/pages/{row['id']}")).json()
    assert page["kind"] == "row"
    assert [c["id"] for c in page["breadcrumbs"]] == [parent["id"], database["page_id"]]
    db_page = (await client.get(f"{API}/wiki/pages/{database['page_id']}")).json()
    assert db_page["children"] == []
    # Pages do not go under a database; rows do not move or take their own access.
    under = await client.post(
        f"{API}/wiki/pages", json={"client_save_id": key(), "parent_id": database["page_id"]}
    )
    assert under.status_code == 400
    moved = await client.post(f"{API}/wiki/pages/{row['id']}/move", json={"parent_id": None})
    assert moved.status_code == 400
    shared = await client.put(
        f"{API}/wiki/pages/{row['id']}/access", json={"inherit_access": False, "grants": []}
    )
    assert shared.status_code == 400 and shared.json()["error"]["code"] == "wiki_row_access"
    await assert_acl_consistent(db)


async def test_row_create_is_idempotent_and_capped(
    client: AsyncClient, db: AsyncSession, as_user: Actor, monkeypatch: pytest.MonkeyPatch
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    database = await create_database(client)
    payload = {"title": "Once", "client_save_id": key()}
    first = await client.post(f"{API}/wiki/databases/{database['page_id']}/rows", json=payload)
    again = await client.post(f"{API}/wiki/databases/{database['page_id']}/rows", json=payload)
    assert first.status_code == 201 and again.status_code == 200
    assert first.json()["row"]["id"] == again.json()["row"]["id"]
    monkeypatch.setattr(dbschema, "MAX_ROWS", 2)
    await add_row(client, database, "Twice")
    full = await add_row(client, database, "Thrice", expect=409)
    assert full["error"]["code"] == "wiki_too_many_rows"


async def test_values_of_every_type(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice, database = await _setup(client, db, as_user)
    pid = {p["name"]: p["id"] for p in database["properties"]}
    stage = option_id(database, "Stage", "読む")
    tags = [option_id(database, "Tags", "ML"), option_id(database, "Tags", "HCI")]
    row = await add_row(
        client,
        database,
        "Attention",
        {
            pid["Notes"]: "  good  ",
            pid["Year"]: 2017,
            pid["Stage"]: stage,
            pid["Tags"]: tags,
            pid["Due"]: {"start": "2026-10-07", "end": "2026-10-09", "time": False},
            pid["Readers"]: [str(alice.id)],
            pid["Done"]: True,
            pid["Link"]: "https://arxiv.org/abs/1706.03762",
        },
    )
    assert row["props"] == {
        pid["Notes"]: "good",
        pid["Year"]: 2017.0,
        pid["Stage"]: stage,
        pid["Tags"]: tags,
        pid["Due"]: {"start": "2026-10-07", "end": "2026-10-09", "time": False},
        pid["Readers"]: [str(alice.id)],
        pid["Done"]: True,
        pid["Link"]: "https://arxiv.org/abs/1706.03762",
    }
    timed = await set_cells(
        client, row["id"], {pid["Due"]: {"start": "2026-10-07T09:30:00+09:00", "time": True}}
    )
    assert timed["row"]["props"][pid["Due"]]["start"] == "2026-10-07T09:30:00+09:00"
    cleared = await set_cells(client, row["id"], {pid["Notes"]: None, pid["Done"]: False})
    assert (
        pid["Notes"] not in cleared["row"]["props"] and pid["Done"] not in cleared["row"]["props"]
    )
    bad = {
        pid["Year"]: "twelve",
        pid["Stage"]: "nope",
        pid["Tags"]: ["nope"],
        pid["Due"]: {"start": "2026-10-09", "end": "2026-10-01"},
        pid["Readers"]: [str(uuid.uuid4())],
        pid["Done"]: "yes",
        pid["Link"]: "javascript:alert(1)",
        pid["Notes"]: "x" * 2001,
        pid["Made"]: "2026-01-01",
        "missing": "x",
    }
    for key_, value in bad.items():
        refused = await set_cells(client, row["id"], {key_: value}, expect=422)
        assert refused["error"]["code"] == "wiki_invalid_property_value", key_


async def test_the_last_write_wins_per_cell_and_a_retry_changes_nothing(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice, database = await _setup(client, db, as_user)
    bob = await make_user(db, "bob")
    notes, year = prop_id(database, "Notes"), prop_id(database, "Year")
    row = await add_row(client, database, "Row")
    op = key()
    first = await client.patch(
        f"{API}/wiki/rows/{row['id']}/props", json={"set": {notes: "alice"}, "client_op_id": op}
    )
    assert first.status_code == 200
    as_user(bob)
    await set_cells(client, row["id"], {year: 3})
    await set_cells(client, row["id"], {notes: "bob"})
    as_user(alice)
    retry = await client.patch(
        f"{API}/wiki/rows/{row['id']}/props", json={"set": {notes: "alice"}, "client_op_id": op}
    )
    assert retry.json()["row"]["props"] == {notes: "bob", year: 3.0}
    versions = (
        (
            await db.execute(
                select(WikiPageRevision).where(
                    WikiPageRevision.page_id == uuid.UUID(row["id"]),
                    WikiPageRevision.kind == "props",
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(versions) == 3
    assert {"before": {notes: "alice"}, "after": {notes: "bob"}} in [v.props for v in versions]
    listed = (await client.get(f"{API}/wiki/pages/{row['id']}/revisions")).json()["items"]
    assert [v["kind"] for v in listed][:3] == ["props", "props", "props"]


# --- type changes --------------------------------------------------------------------------------


async def test_type_changes_convert_and_keep_what_they_cannot(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice, database = await _setup(client, db, as_user)
    notes = prop_id(database, "Notes")
    values = ["12", "¥1,200", "abc", "50%"]
    rows = [await add_row(client, database, v, {notes: v}) for v in values]

    async def cells() -> list[Any]:
        out = await query(client, database, limit=100)
        by_id = {r["id"]: r["props"].get(notes) for r in out["rows"]}
        return [by_id[r["id"]] for r in rows]

    await schema(client, database, {"op": "retype", "id": notes, "type": "number"})
    assert await cells() == [12.0, 1200.0, None, 0.5]
    kept = (await db.execute(select(WikiPropLegacy))).scalars().all()
    assert [(k.prop_type, k.value) for k in kept] == [("text", "abc")]
    await schema(client, database, {"op": "retype", "id": notes, "type": "text"})
    assert await cells() == ["12", "1200", "abc", "0.5"]
    await schema(client, database, {"op": "retype", "id": notes, "type": "select"})
    prop = next(p for p in database["properties"] if p["id"] == notes)
    assert [o["name"] for o in prop["options"]] == ["12", "1200", "abc", "0.5"]
    await schema(client, database, {"op": "retype", "id": notes, "type": "multi_select"})
    assert all(isinstance(c, list) and len(c) == 1 for c in await cells())
    await schema(client, database, {"op": "retype", "id": notes, "type": "text"})
    assert await cells() == ["12", "1200", "abc", "0.5"]

    due = prop_id(database, "Due")
    await set_cells(client, rows[0]["id"], {notes: "2026年10月7日"})
    await set_cells(client, rows[1]["id"], {notes: "2026/10/08 → 2026/10/10"})
    await schema(client, database, {"op": "retype", "id": notes, "type": "date"})
    got = await cells()
    assert got[0] == {"start": "2026-10-07", "end": None, "time": False}
    assert got[1] == {"start": "2026-10-08", "end": "2026-10-10", "time": False}
    assert got[2] is None
    assert due != notes

    readers = prop_id(database, "Readers")
    await set_cells(client, rows[0]["id"], {readers: [str(alice.id)]})
    await schema(client, database, {"op": "retype", "id": readers, "type": "text"})
    assert (await query(client, database))["rows"][0]["props"][readers] == "Alice"
    await schema(client, database, {"op": "retype", "id": readers, "type": "person"})
    assert (await query(client, database))["rows"][0]["props"][readers] == [str(alice.id)]

    title_change = await schema(
        client, database, {"op": "retype", "id": "title", "type": "text"}, expect=400
    )
    assert title_change["error"]["code"] == "wiki_title_property"


async def test_deleting_a_property_and_options(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    _, database = await _setup(client, db, as_user)
    stage, tags = prop_id(database, "Stage"), prop_id(database, "Tags")
    ml, hci = option_id(database, "Tags", "ML"), option_id(database, "Tags", "HCI")
    row = await add_row(
        client, database, "R", {stage: option_id(database, "Stage", "読む"), tags: [ml, hci]}
    )
    view_id = database["views"][0]["id"]
    saved = await client.put(
        f"{API}/wiki/databases/{database['page_id']}/views/{view_id}",
        json={
            "type": "table",
            "sort": [{"prop_id": stage}],
            "filter": {"conditions": [{"prop_id": tags, "op": "contains", "value": ml}]},
            "columns": [{"prop_id": stage, "width": 200}],
        },
    )
    assert saved.status_code == 200, saved.text
    await schema(
        client, database, {"op": "update", "id": tags, "options": [{"id": hci, "name": "HCI!"}]}
    )
    out = await query(client, database)
    assert out["rows"][0]["props"][tags] == [hci]
    await schema(client, database, {"op": "delete", "id": stage})
    view = database["views"][0]
    assert view["sort"] == [] and view["columns"] == [] and view["filter"]["conditions"] == []
    out = await query(client, database)
    assert stage not in out["rows"][0]["props"]
    assert row["id"] == out["rows"][0]["id"]


async def test_a_schema_change_on_an_old_version_is_refused(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    database = await create_database(client)
    old = database["schema_version"]
    await schema(client, database, {"op": "add", "name": "A", "type": "text"})
    stale = await client.patch(
        f"{API}/wiki/databases/{database['page_id']}/schema",
        json={"base_schema_version": old, "ops": [{"op": "add", "name": "B", "type": "text"}]},
    )
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "wiki_schema_conflict"
    # Only full access changes the schema and views; edit adds and changes rows.
    as_user(bob)
    refused = await schema(client, database, {"op": "add", "name": "C", "type": "text"}, expect=403)
    assert refused["error"]["code"] == "page_manage_restricted"
    view = await client.put(
        f"{API}/wiki/databases/{database['page_id']}/views/mine", json={"name": "Mine"}
    )
    assert view.status_code == 403
    row = await add_row(client, database, "bob's")
    await set_cells(client, row["id"], {prop_id(database, "A"): "ok"})
    trashed = await client.delete(f"{API}/wiki/pages/{row['id']}")
    assert trashed.status_code == 204
    assert row["id"] in {p["id"] for p in (await client.get(f"{API}/wiki/trash")).json()}
    back = await client.post(f"{API}/wiki/pages/{row['id']}/restore")
    assert back.status_code == 200


async def test_view_only_people_read_but_do_not_write(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    vic = await make_user(db, "vic")
    as_user(alice)
    database = await create_database(client, access_="private")
    await set_access(
        client,
        database["page_id"],
        [("user", str(alice.id), "full"), ("user", str(vic.id), "view")],
    )
    row = await add_row(client, database, "Row")
    as_user(vic)
    assert (await query(client, database))["total"] == 1
    refused = await set_cells(client, row["id"], {"title": "mine"}, expect=403)
    assert refused["error"]["code"] == "page_edit_restricted"
    assert (await add_row(client, database, "x", expect=403))["error"]["code"] == (
        "page_edit_restricted"
    )
    assert (await client.delete(f"{API}/wiki/pages/{row['id']}")).status_code == 403


# --- sorting, filtering, views -------------------------------------------------------------------


async def test_sort_and_filter(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice, database = await _setup(client, db, as_user)
    bob = await make_user(db, "bob")
    year, stage, done = (
        prop_id(database, "Year"),
        prop_id(database, "Stage"),
        prop_id(database, "Done"),
    )
    tags, due, readers = (
        prop_id(database, "Tags"),
        prop_id(database, "Due"),
        prop_id(database, "Readers"),
    )
    read, done_reading = (
        option_id(database, "Stage", "読む"),
        option_id(database, "Stage", "読んだ"),
    )
    ml = option_id(database, "Tags", "ML")
    await add_row(
        client, database, "修論", {year: 2025, stage: done_reading, tags: [ml], done: True}
    )
    await add_row(
        client,
        database,
        "院ゼミ",
        {year: 2026, stage: read, due: "2026-10-07", readers: [str(bob.id)]},
    )
    await add_row(client, database, "Bert", {year: 2018, readers: [str(alice.id)]})
    await add_row(client, database, "2論文", {due: {"start": "2026-10-01", "end": "2026-10-10"}})
    await add_row(client, database, "10論文", {year: 2026})

    by_title = [{"prop_id": "title"}]
    assert await titles(client, database, sort=by_title) == [
        "2論文",
        "10論文",
        "Bert",
        "院ゼミ",
        "修論",
    ]
    assert await titles(
        client, database, sort=[{"prop_id": year, "direction": "desc"}, *by_title]
    ) == [
        "10論文",
        "院ゼミ",
        "修論",
        "Bert",
        "2論文",  # empty last, both directions
    ]
    assert await titles(client, database, sort=[{"prop_id": year}]) == [
        "Bert",
        "修論",
        "院ゼミ",
        "10論文",
        "2論文",
    ]
    assert (await titles(client, database, sort=[{"prop_id": stage}]))[:2] == ["院ゼミ", "修論"]

    def where(*conditions: dict[str, Any], combinator: str = "and") -> dict[str, Any]:
        return {"combinator": combinator, "conditions": list(conditions)}

    cases = [
        (where({"prop_id": "title", "op": "contains", "value": "論"}), {"修論", "2論文", "10論文"}),
        (where({"prop_id": year, "op": "gte", "value": 2026}), {"院ゼミ", "10論文"}),
        (where({"prop_id": year, "op": "is_empty"}), {"2論文"}),
        (where({"prop_id": stage, "op": "equals", "value": read}), {"院ゼミ"}),
        (where({"prop_id": tags, "op": "contains", "value": ml}), {"修論"}),
        (
            where({"prop_id": done, "op": "equals", "value": False}),
            {"院ゼミ", "Bert", "2論文", "10論文"},
        ),
        (where({"prop_id": readers, "op": "contains", "value": "me"}), {"Bert"}),
        (where({"prop_id": due, "op": "equals", "value": "2026-10-07"}), {"院ゼミ", "2論文"}),
        (where({"prop_id": due, "op": "after", "value": "2026-10-08"}), {"2論文"}),
        (
            where(
                {"prop_id": year, "op": "lt", "value": 2019},
                {"prop_id": stage, "op": "equals", "value": read},
                combinator="or",
            ),
            {"Bert", "院ゼミ"},
        ),
    ]
    for group, expected in cases:
        assert set(await titles(client, database, filter=group)) == expected, group
    bad = await client.post(
        f"{API}/wiki/databases/{database['page_id']}/query",
        json={"filter": where({"prop_id": year, "op": "contains", "value": "x"})},
    )
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "wiki_invalid_view"


async def test_paging_and_saved_views(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    _, database = await _setup(client, db, as_user)
    year = prop_id(database, "Year")
    for n in range(7):
        await add_row(client, database, f"r{n}", {year: n})
    first = await query(client, database, limit=3, sort=[{"prop_id": year, "direction": "desc"}])
    assert first["total"] == 7 and [r["title"] for r in first["rows"]] == ["r6", "r5", "r4"]
    rest = await query(
        client,
        database,
        limit=10,
        cursor=first["next_cursor"],
        sort=[{"prop_id": year, "direction": "desc"}],
    )
    assert [r["title"] for r in rest["rows"]] == ["r3", "r2", "r1", "r0"] and rest[
        "next_cursor"
    ] is None
    view = {
        "name": "Recent",
        "type": "table",
        "sort": [{"prop_id": year, "direction": "desc"}],
        "filter": {"conditions": [{"prop_id": year, "op": "gte", "value": 4}]},
        "columns": [{"prop_id": year, "width": 120}, {"prop_id": "title", "hidden": False}],
    }
    saved = await client.put(f"{API}/wiki/databases/{database['page_id']}/views/recent", json=view)
    assert saved.status_code == 200, saved.text
    assert [v["id"] for v in saved.json()["views"]][-1] == "recent"
    assert await titles(client, database, view_id="recent") == ["r6", "r5", "r4"]
    # The request's own sort wins over the view's (an unsaved sort).
    assert await titles(client, database, view_id="recent", sort=[{"prop_id": year}]) == [
        "r4",
        "r5",
        "r6",
    ]
    calendar = await client.put(
        f"{API}/wiki/databases/{database['page_id']}/views/cal", json={"type": "calendar"}
    )
    assert calendar.status_code == 400 and calendar.json()["error"]["code"] == "wiki_invalid_view"
    for view_id in [v["id"] for v in saved.json()["views"]]:
        await client.delete(f"{API}/wiki/databases/{database['page_id']}/views/{view_id}")
    last = await client.get(f"{API}/wiki/databases/{database['page_id']}")
    assert len(last.json()["views"]) == 1
    only = last.json()["views"][0]["id"]
    refused = await client.delete(f"{API}/wiki/databases/{database['page_id']}/views/{only}")
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "wiki_last_view"


async def test_calendar_range(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    _, database = await _setup(client, db, as_user)
    due = prop_id(database, "Due")
    await add_row(client, database, "Sept", {due: "2026-09-30"})
    await add_row(client, database, "Across", {due: {"start": "2026-09-28", "end": "2026-10-02"}})
    await add_row(
        client, database, "Oct 7", {due: {"start": "2026-10-07T23:30:00+09:00", "time": True}}
    )
    await add_row(client, database, "Last day", {due: "2026-10-31"})
    await add_row(client, database, "Nov", {due: "2026-11-01"})
    await add_row(client, database, "None")
    saved = await client.put(
        f"{API}/wiki/databases/{database['page_id']}/views/cal",
        json={
            "name": "Calendar",
            "type": "calendar",
            "date_prop_id": due,
            "sort": [{"prop_id": due}],
        },
    )
    assert saved.status_code == 200, saved.text
    october = {"prop_id": due, "start": "2026-10-01", "end": "2026-10-31"}
    assert await titles(client, database, view_id="cal", range=october) == [
        "Across",
        "Oct 7",
        "Last day",
    ]
    week = {"prop_id": due, "start": "2026-09-27", "end": "2026-10-03"}
    assert await titles(client, database, view_id="cal", range=week) == ["Across", "Sept"]
    made = prop_id(database, "Made")
    today = (await query(client, database))["rows"][0]["created_at"][:10]
    created = await titles(client, database, range={"prop_id": made, "start": today, "end": today})
    assert len(created) == 6 or len(created) == 0  # the server's day may differ near midnight


async def test_csv_export(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice, database = await _setup(client, db, as_user)
    stage, readers, due = (
        prop_id(database, "Stage"),
        prop_id(database, "Readers"),
        prop_id(database, "Due"),
    )
    await add_row(
        client,
        database,
        "Paper, with comma",
        {
            stage: option_id(database, "Stage", "読んだ"),
            readers: [str(alice.id)],
            due: {"start": "2026-10-07", "end": "2026-10-09"},
        },
    )
    response = await client.get(
        f"{API}/wiki/databases/{database['page_id']}/export.csv",
        headers={"Accept-Language": "ja"},
    )
    assert response.status_code == 200
    assert response.content.startswith("﻿".encode())
    table = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert table[0][:4] == ["名前", "Notes", "Year", "Stage"]
    record = dict(zip(table[0], table[1], strict=True))
    assert record["名前"] == "Paper, with comma"
    assert record["Stage"] == "読んだ" and record["Readers"] == "Alice"
    assert record["Due"] == "2026-10-07 → 2026-10-09"


# --- relations -----------------------------------------------------------------------------------


async def test_two_way_relations(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    papers = await create_database(client, title="Papers")
    people = await create_database(client, title="Authors")
    await schema(
        client,
        papers,
        {
            "op": "add",
            "name": "Authors",
            "type": "relation",
            "relation": {"database_id": people["page_id"], "two_way": True, "pair_name": "Papers"},
        },
    )
    authors = prop_id(papers, "Authors")
    people = (await client.get(f"{API}/wiki/databases/{people['page_id']}")).json()
    reverse = next(p for p in people["properties"] if p["type"] == "relation")
    assert reverse["name"] == "Papers"
    assert reverse["relation"] == {
        "database_id": papers["page_id"],
        "database_title": "Papers",
        "pair_id": authors,
        "primary": False,
    }
    ada = await add_row(client, people, "Ada")
    bob = await add_row(client, people, "Bob")
    p1 = await add_row(client, papers, "P1", {authors: [bob["id"], ada["id"]]})
    assert p1["relations"][authors] == [bob["id"], ada["id"]]
    out = await query(client, papers)
    assert {r["title"] for r in out["refs"]} == {"Ada", "Bob"}
    # The other side reads the same links.
    from_people = await query(client, people, sort=[{"prop_id": "title"}])
    cells = {r["title"]: r["relations"].get(reverse["id"], []) for r in from_people["rows"]}
    assert cells == {"Ada": [p1["id"]], "Bob": [p1["id"]]}
    # Written from the other side.
    p2 = await add_row(client, papers, "P2")
    await set_cells(client, ada["id"], {reverse["id"]: [p1["id"], p2["id"]]})
    out = await query(client, papers, sort=[{"prop_id": "title"}])
    assert [r["relations"].get(authors, []) for r in out["rows"]] == [
        [bob["id"], ada["id"]],
        [ada["id"]],
    ]
    filtered = await titles(
        client,
        papers,
        filter={"conditions": [{"prop_id": authors, "op": "contains", "value": bob["id"]}]},
    )
    assert filtered == ["P1"]
    detail = (await client.get(f"{API}/wiki/rows/{ada['id']}")).json()
    assert detail["row"]["relations"][reverse["id"]] == [p1["id"], p2["id"]]
    assert detail["database"]["page_id"] == people["page_id"]
    # A renamed row comes to the tables that show it.
    await db.execute(delete(OutboxEvent))
    await db.commit()
    await set_cells(client, ada["id"], {"title": "Ada L."})
    changed = (
        (
            await db.execute(
                select(OutboxEvent.audience_id).where(
                    OutboxEvent.event_type == events.WIKI_ROWS_CHANGED
                )
            )
        )
        .scalars()
        .all()
    )
    assert {str(c) for c in changed} == {papers["page_id"], people["page_id"]}
    # Deleting the source property takes the reverse one and the links with it.
    await schema(client, papers, {"op": "delete", "id": authors})
    people = (await client.get(f"{API}/wiki/databases/{people['page_id']}")).json()
    assert [p["type"] for p in people["properties"]] == ["title"]


async def test_one_way_relation_within_one_database(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    tasks = await create_database(client, title="Tasks")
    await schema(
        client,
        tasks,
        {
            "op": "add",
            "name": "Blocked by",
            "type": "relation",
            "relation": {"database_id": tasks["page_id"]},
        },
    )
    blocked = prop_id(tasks, "Blocked by")
    a = await add_row(client, tasks, "A")
    b = await add_row(client, tasks, "B", {blocked: [a["id"]]})
    assert b["relations"][blocked] == [a["id"]]
    detail = (await client.get(f"{API}/wiki/rows/{a['id']}")).json()
    assert detail["referenced_by"] == [
        {
            "database_id": tasks["page_id"],
            "database_title": "Tasks",
            "prop_id": blocked,
            "prop_name": "Blocked by",
            "rows": [{"id": b["id"], "database_id": tasks["page_id"], "title": "B", "icon": None}],
        }
    ]
    candidates = await client.get(
        f"{API}/wiki/databases/{tasks['page_id']}/properties/{blocked}/candidates",
        params={"q": "b"},
    )
    assert [r["title"] for r in candidates.json()] == ["B"]
    # Retyping a relation drops its links (nothing to keep as text: the titles are not its).
    await schema(client, tasks, {"op": "retype", "id": blocked, "type": "text"})
    assert all(not r["relations"] for r in (await query(client, tasks))["rows"])
    # A row in the trash is not shown in cells.
    await schema(
        client,
        tasks,
        {
            "op": "add",
            "name": "Next",
            "type": "relation",
            "relation": {"database_id": tasks["page_id"]},
        },
    )
    nxt = prop_id(tasks, "Next")
    await set_cells(client, a["id"], {nxt: [b["id"]]})
    await client.delete(f"{API}/wiki/pages/{b['id']}")
    row_a = next(r for r in (await query(client, tasks))["rows"] if r["id"] == a["id"])
    assert row_a["relations"] == {} and row_a["hidden_relations"] == []


async def test_relations_show_only_rows_the_reader_can_read(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    secret = await create_database(client, title="SECRET-DB", access_="private")
    hidden_row = await add_row(client, secret, "SECRET-ROW")
    other_secret = await add_row(client, secret, "SECRET-TWO")
    open_db = await create_database(client, title="Open")
    shown = await add_row(client, open_db, "Shown")
    await schema(
        client,
        open_db,
        {
            "op": "add",
            "name": "Refs",
            "type": "relation",
            "relation": {"database_id": open_db["page_id"]},
        },
        {
            "op": "add",
            "name": "Secret refs",
            "type": "relation",
            "relation": {"database_id": secret["page_id"]},
        },
    )
    refs, secret_refs = prop_id(open_db, "Refs"), prop_id(open_db, "Secret refs")
    row = await add_row(
        client,
        open_db,
        "Mixed",
        {secret_refs: [hidden_row["id"], other_secret["id"]], refs: [shown["id"]]},
    )
    secret_ids = {secret["page_id"], hidden_row["id"], other_secret["id"]}

    as_user(bob)
    responses: list[Any] = []
    out = await query(client, open_db)
    responses.append(out)
    mixed = next(r for r in out["rows"] if r["id"] == row["id"])
    assert mixed["relations"] == {refs: [shown["id"]]}
    assert mixed["hidden_relations"] == [secret_refs]
    database = (await client.get(f"{API}/wiki/databases/{open_db['page_id']}")).json()
    responses.append(database)
    relation = next(p for p in database["properties"] if p["id"] == secret_refs)["relation"]
    assert relation["database_id"] is None and relation["database_title"] is None
    detail = (await client.get(f"{API}/wiki/rows/{row['id']}")).json()
    responses.append(detail)
    assert detail["row"]["hidden_relations"] == [secret_refs]
    csv_text = (
        await client.get(
            f"{API}/wiki/databases/{open_db['page_id']}/export.csv",
            headers={"Accept-Language": "ja"},
        )
    ).content.decode("utf-8-sig")
    assert "アクセスできないページ" in csv_text
    responses.append(csv_text)
    # Filtering by an unreadable row finds nothing; is_empty sees the hidden link as a link.
    by_secret = await titles(
        client,
        open_db,
        filter={
            "conditions": [{"prop_id": secret_refs, "op": "contains", "value": hidden_row["id"]}]
        },
    )
    assert by_secret == []
    empty = await titles(
        client, open_db, filter={"conditions": [{"prop_id": secret_refs, "op": "is_empty"}]}
    )
    assert "Mixed" not in empty
    candidates = await client.get(
        f"{API}/wiki/databases/{open_db['page_id']}/properties/{secret_refs}/candidates"
    )
    assert candidates.status_code == 200 and candidates.json() == []
    # Bob cannot link to a row he cannot read: the same answer as a row that is not there.
    for target in (hidden_row["id"], str(uuid.uuid4())):
        refused = await set_cells(client, row["id"], {secret_refs: [target]}, expect=422)
        assert refused["error"]["code"] == "wiki_invalid_property_value"
        responses.append(refused)
    # Writing the cell keeps the links he cannot see.
    await set_cells(client, row["id"], {secret_refs: []})
    for page in (hidden_row, other_secret):
        assert (await client.get(f"{API}/wiki/rows/{page['id']}")).status_code == 404
        assert (await client.get(f"{API}/wiki/pages/{page['id']}")).status_code == 404
    search = (await client.get(f"{API}/search/pages", params={"q": "SECRET"})).json()
    responses.append(search["hits"])
    for response in responses:
        text_ = str(response)
        assert "SECRET" not in text_, text_[:300]
        assert not any(i in text_ for i in secret_ids), text_[:300]
    as_user(alice)
    mixed = (await client.get(f"{API}/wiki/rows/{row['id']}")).json()["row"]
    assert mixed["relations"][secret_refs] == [hidden_row["id"], other_secret["id"]]
    # Bob could see a relation's two-way side only with full access there.
    two_way = await schema(
        client,
        open_db,
        {
            "op": "add",
            "name": "x",
            "type": "relation",
            "relation": {"database_id": secret["page_id"], "two_way": True},
        },
    )
    assert any(p["name"] == "x" for p in two_way["properties"])
    # A relation to a database Bob cannot read: that database does not exist for him.
    as_user(bob)
    mine = await create_database(client, title="Bob's")
    await schema(
        client,
        mine,
        {
            "op": "add",
            "name": "y",
            "type": "relation",
            "relation": {"database_id": secret["page_id"]},
        },
        expect=404,
    )


# --- events, search ------------------------------------------------------------------------------


async def test_row_events_go_to_whoever_reads_the_database(
    client: AsyncClient, db: AsyncSession, as_user: Actor, app: FastAPI
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await make_user(db, "carol")
    as_user(alice)
    database = await create_database(client, access_="private")
    await set_access(
        client,
        database["page_id"],
        [("user", str(alice.id), "full"), ("user", str(bob.id), "edit")],
    )
    row = await add_row(client, database, "Row")
    await set_cells(client, row["id"], {"title": "Row 2"})
    rows_changed = (
        (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.event_type == events.WIKI_ROWS_CHANGED)
            )
        )
        .scalars()
        .all()
    )
    assert len(rows_changed) >= 2
    resolve = events.audience_resolver(app.state.relay.resolve_audience)
    for event in rows_changed:
        assert event.audience_type == "page" and str(event.audience_id) == database["page_id"]
        assert set((await resolve(db, event)).ids) == {alice.id, bob.id}
    seqs = [e.payload["seq"] for e in rows_changed]
    assert seqs == sorted(seqs)
    updated = (
        (
            await db.execute(
                select(OutboxEvent).where(
                    OutboxEvent.event_type == events.WIKI_PAGE_UPDATED,
                    OutboxEvent.audience_id == uuid.UUID(row["id"]),
                )
            )
        )
        .scalars()
        .all()
    )
    assert "props" in {e.payload["change"] for e in updated}
    # A row's change is not a change of the tree.
    feed_before = (await client.get(f"{API}/wiki/changes", params={"since": 0})).json()["pages"]
    assert row["id"] not in {p["id"] for p in feed_before}


async def test_search_finds_rows_by_their_values(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    _, database = await _setup(client, db, as_user)
    stage, notes = prop_id(database, "Stage"), prop_id(database, "Notes")
    row = await add_row(
        client,
        database,
        "Paper",
        {stage: option_id(database, "Stage", "読んだ"), notes: "transformer"},
    )
    found = (await client.get(f"{API}/search/pages", params={"q": "transformer"})).json()
    assert [h["page"]["id"] for h in found["hits"]] == [row["id"]]
    assert found["hits"][0]["page"]["kind"] == "row"
