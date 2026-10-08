"""View types of wiki databases (M147, docs/WIKI.md §22.4): board, list and gallery, groups for
every view but the calendar (checked against the schema, the query in groups with counts and
hidden groups, the order an older client gets), a board's move (cells and place in one write),
the gallery's picture, the views after a schema change, and who may do what."""

import io
from typing import Any

from httpx import AsyncClient
from PIL import Image
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from app.modules.wiki import dbschema
from app.modules.wiki.models import WikiPageRevision
from tests.helpers import make_user
from tests.wiki_helpers import (
    API,
    Actor,
    add_row,
    create_database,
    create_page,
    key,
    option_id,
    prop_id,
    query,
    save,
    schema,
    set_access,
)


async def _put_view(
    client: AsyncClient, database: dict[str, Any], view_id: str, *, expect: int = 200, **body: Any
) -> dict[str, Any]:
    response = await client.put(
        f"{API}/wiki/databases/{database['page_id']}/views/{view_id}", json=body
    )
    assert response.status_code == expect, response.text
    out: dict[str, Any] = response.json()
    return out


async def _move(
    client: AsyncClient, row_id: str, *, expect: int = 200, **body: Any
) -> dict[str, Any]:
    body.setdefault("client_op_id", key())
    response = await client.post(f"{API}/wiki/rows/{row_id}/move", json=body)
    assert response.status_code == expect, response.text
    out: dict[str, Any] = response.json()
    return out


def _columns(answer: dict[str, Any]) -> list[tuple[str, list[str]]]:
    """(group key, row titles) of a grouped answer, in order (hidden groups have no rows)."""
    by_group: dict[str, list[str]] = {g["key"]: [] for g in answer["groups"]}
    for row, group in zip(answer["rows"], answer["row_groups"], strict=True):
        by_group[group].append(row["title"])
    return list(by_group.items())


async def _tasks(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> tuple[User, dict[str, Any]]:
    alice = await make_user(db, "alice")
    as_user(alice)
    database = await create_database(client, title="Tasks")
    await schema(
        client,
        database,
        {
            "op": "add",
            "name": "Status",
            "type": "select",
            "options": [{"name": "未着手"}, {"name": "進行中"}, {"name": "完了"}],
        },
        {
            "op": "add",
            "name": "Tags",
            "type": "multi_select",
            "options": [{"name": "A"}, {"name": "B"}],
        },
        {"op": "add", "name": "Owner", "type": "person"},
        {"op": "add", "name": "Done", "type": "checkbox"},
        {"op": "add", "name": "Due", "type": "date"},
        {"op": "add", "name": "Score", "type": "number"},
    )
    return alice, database


# --- the view's settings --------------------------------------------------------------------------


async def test_view_types_and_their_settings_are_checked(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    _, database = await _tasks(client, db, as_user)
    status = prop_id(database, "Status")
    due = prop_id(database, "Due")
    tags = prop_id(database, "Tags")
    out = await _put_view(
        client,
        database,
        "board1",
        type="board",
        group_by={"prop_id": status, "hidden": [""]},
        columns=[{"prop_id": prop_id(database, "Owner")}],
    )
    board = next(v for v in out["views"] if v["id"] == "board1")
    assert board["type"] == "board"
    assert board["group_by"] == {
        "prop_id": status,
        "date_unit": None,
        "hidden": [""],
        "hide_empty": False,
    }
    assert (board["cover"], board["card_size"]) == ("body", "medium")
    # The first view (saved before M147) reads with the new fields' defaults.
    first = out["views"][0]
    assert first["group_by"] is None and first["cover"] == "body"
    await _put_view(client, database, "list1", type="list", columns=[])
    await _put_view(client, database, "gal1", type="gallery", cover="none", card_size="large")
    await _put_view(
        client, database, "tbl2", type="table", group_by={"prop_id": due, "date_unit": "week"}
    )
    await _put_view(client, database, "tbl3", type="table", group_by={"prop_id": tags})
    # A board without groups is kept (its property may have been deleted): it asks for one.
    await _put_view(client, database, "board2", type="board")
    refused = [
        {"type": "board", "group_by": {"prop_id": tags}},  # a multi-select board
        {"type": "board", "group_by": {"prop_id": due}},
        {"type": "board", "group_by": {"prop_id": "title"}},
        {"type": "table", "group_by": {"prop_id": prop_id(database, "Score")}},
        {"type": "table", "group_by": {"prop_id": "nope"}},
        {"type": "table", "group_by": {"prop_id": status, "date_unit": "month"}},
        {"type": "calendar", "date_prop_id": due, "group_by": {"prop_id": status}},
    ]
    for body in refused:
        bad = await _put_view(client, database, "bad", expect=400, **body)
        assert bad["error"]["code"] == "wiki_invalid_view", body
    unknown = await _put_view(client, database, "bad", expect=422, type="timeline")
    assert unknown["error"]["code"] == "validation_error"
    many = await _put_view(
        client,
        database,
        "bad",
        expect=422,
        type="board",
        group_by={"prop_id": status, "hidden": ["x"] * 251},
    )
    assert many["error"]["code"] == "validation_error"


# --- the query in groups --------------------------------------------------------------------------


async def test_board_groups_with_counts_hidden_and_empty_groups(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    _, database = await _tasks(client, db, as_user)
    status = prop_id(database, "Status")
    todo, doing, done = (option_id(database, "Status", n) for n in ("未着手", "進行中", "完了"))
    score = prop_id(database, "Score")
    await add_row(client, database, "a", {status: doing, score: 2})
    await add_row(client, database, "b", {status: todo, score: 3})
    await add_row(client, database, "c", {score: 1})
    await add_row(client, database, "d", {status: doing, score: 1})
    await _put_view(
        client,
        database,
        "board",
        type="board",
        group_by={"prop_id": status},
        sort=[{"prop_id": score, "direction": "asc"}],
    )
    answer = await query(client, database, view_id="board", grouped=True, limit=1000)
    # Every option is a column (in the options' order, rows or not), 「なし」 last.
    assert _columns(answer) == [(todo, ["b"]), (doing, ["d", "a"]), (done, []), ("", ["c"])]
    assert [(g["key"], g["count"], g["hidden"]) for g in answer["groups"]] == [
        (todo, 1, False),
        (doing, 2, False),
        (done, 0, False),
        ("", 1, False),
    ]
    assert answer["total"] == 4
    # Hidden groups are counted, not listed; hide_empty leaves out the groups without rows.
    await _put_view(
        client,
        database,
        "board",
        type="board",
        group_by={"prop_id": status, "hidden": [doing], "hide_empty": True},
    )
    answer = await query(client, database, view_id="board", grouped=True)
    assert [(g["key"], g["count"], g["hidden"]) for g in answer["groups"]] == [
        (todo, 1, False),
        (doing, 2, True),
        ("", 1, False),
    ]
    assert [r["title"] for r in answer["rows"]] == ["b", "c"] and answer["total"] == 2
    # A client before M147 (no `grouped`): one list in the groups' order, hidden groups left out,
    # no group fields; `grouped: false`: everything, in the rows' order.
    legacy = await query(client, database, view_id="board")
    assert [r["title"] for r in legacy["rows"]] == ["b", "c"]
    assert legacy["groups"] is None and legacy["row_groups"] is None
    plain = await query(client, database, view_id="board", grouped=False)
    assert [r["title"] for r in plain["rows"]] == ["a", "b", "c", "d"]
    # Filters apply before the groups; an unsaved group_by replaces the view's.
    filtered = await query(
        client,
        database,
        view_id="board",
        grouped=True,
        filter={"conditions": [{"prop_id": score, "op": "lte", "value": 2}]},
        group_by={"prop_id": status},
    )
    assert _columns(filtered) == [(todo, []), (doing, ["a", "d"]), (done, []), ("", ["c"])]
    # Pages of a grouped answer keep each row's group.
    first = await query(
        client, database, view_id="board", grouped=True, group_by={"prop_id": status}, limit=2
    )
    assert first["row_groups"] == [todo, doing] and first["next_cursor"] == "o:2"
    rest = await query(
        client, database, view_id="board", grouped=True, group_by={"prop_id": status}, cursor="o:2"
    )
    assert rest["row_groups"] == [doing, ""] and rest["next_cursor"] is None
    # A board may not be grouped by a multi-select even unsaved.
    bad = await client.post(
        f"{API}/wiki/databases/{database['page_id']}/query",
        json={
            "view_id": "board",
            "grouped": True,
            "group_by": {"prop_id": prop_id(database, "Tags")},
        },
    )
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "wiki_invalid_view"


async def test_table_groups_by_every_groupable_type(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice, database = await _tasks(client, db, as_user)
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    tags, owner, done_prop, due = (prop_id(database, n) for n in ("Tags", "Owner", "Done", "Due"))
    a, b = option_id(database, "Tags", "A"), option_id(database, "Tags", "B")
    await add_row(client, database, "r1", {tags: [b, a], owner: [str(carol.id)], due: "2026-10-05"})
    await add_row(
        client,
        database,
        "r2",
        {tags: [a], owner: [str(bob.id), str(carol.id)], done_prop: True, due: "2026-10-11"},
    )
    await add_row(
        client, database, "r3", {due: {"start": "2026-11-01", "end": None, "time": False}}
    )
    view = database["views"][0]["id"]

    async def grouped(**group_by: Any) -> list[tuple[str, list[str]]]:
        return _columns(
            await query(client, database, view_id=view, grouped=True, group_by=group_by)
        )

    # A row with several values is in each of their groups (the options' order).
    assert await grouped(prop_id=tags) == [(a, ["r1", "r2"]), (b, ["r1"]), ("", ["r3"])]
    # People by name, then 「なし」.
    assert await grouped(prop_id=owner) == [
        (str(bob.id), ["r2"]),
        (str(carol.id), ["r1", "r2"]),
        ("", ["r3"]),
    ]
    assert await grouped(prop_id=done_prop) == [("false", ["r1", "r3"]), ("true", ["r2"])]
    assert await grouped(prop_id=due) == [
        ("2026-10-05", ["r1"]),
        ("2026-10-11", ["r2"]),
        ("2026-11-01", ["r3"]),
        ("", []),
    ]
    # Weeks by their Monday (10/5 is a Monday, 10/11 its Sunday), months.
    assert await grouped(prop_id=due, date_unit="week") == [
        ("2026-10-05", ["r1", "r2"]),
        ("2026-10-26", ["r3"]),
        ("", []),
    ]
    assert await grouped(prop_id=due, date_unit="month") == [
        ("2026-10", ["r1", "r2"]),
        ("2026-11", ["r3"]),
        ("", []),
    ]
    # Who made the rows; the time of making in the asker's zone.
    made_by = await schema(client, database, {"op": "add", "name": "By", "type": "created_by"})
    made = await schema(client, database, {"op": "add", "name": "Made", "type": "created_time"})
    by = prop_id(made_by, "By")
    assert await grouped(prop_id=by) == [(str(alice.id), ["r1", "r2", "r3"]), ("", [])]
    tokyo = await query(
        client,
        database,
        view_id=view,
        grouped=True,
        tz="Asia/Tokyo",
        group_by={"prop_id": prop_id(made, "Made"), "date_unit": "month"},
    )
    assert len(tokyo["groups"]) == 2 and tokyo["groups"][0]["count"] == 3


def test_group_rows_without_the_database() -> None:
    """The pure parts: a select value whose option is gone is in 「なし」; dates by unit."""
    prop = {"id": "s", "type": "select", "options": [{"id": "x", "name": "X"}]}
    from datetime import UTC, datetime
    from uuid import uuid4

    def row(value: Any) -> dbschema.Row:
        now = datetime.now(UTC)
        return dbschema.Row(
            uuid4(), "t", None, {"s": value}, "V", 1, uuid4(), now, uuid4(), now, uuid4()
        )

    assert dbschema.group_keys(prop, row("gone")) == [""]
    assert dbschema.group_keys(prop, row("x")) == ["x"]
    date_prop = {"id": "s", "type": "date"}
    timed = row({"start": "2026-10-31T23:30:00+00:00", "end": None, "time": True})
    from zoneinfo import ZoneInfo

    assert dbschema.group_keys(date_prop, timed, unit="month", zone=ZoneInfo("UTC")) == ["2026-10"]
    assert dbschema.group_keys(date_prop, timed, unit="month", zone=ZoneInfo("Asia/Tokyo")) == [
        "2026-11"
    ]
    grouped = dbschema.group_rows(
        [row("x"), row(None)], prop, {"prop_id": "s", "hidden": ["x"]}, dbschema.Ctx()
    )
    assert grouped.order == ["x", ""] and grouped.counts == {"x": 1, "": 1}
    assert [k for k, _ in grouped.entries] == [""]


# --- a board's move -------------------------------------------------------------------------------


async def test_move_sets_the_column_and_the_place_in_one_write(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    _, database = await _tasks(client, db, as_user)
    status = prop_id(database, "Status")
    todo, doing = option_id(database, "Status", "未着手"), option_id(database, "Status", "進行中")
    rows = {t: await add_row(client, database, t, {status: todo}) for t in ("a", "b", "c")}
    await _put_view(client, database, "board", type="board", group_by={"prop_id": status})
    # c to the top of 未着手: before a.
    await _move(client, rows["c"]["id"], before_id=rows["a"]["id"])
    answer = await query(client, database, view_id="board", grouped=True)
    assert _columns(answer)[0] == (todo, ["c", "a", "b"])
    # a to 進行中 (its value), placed after b in the rows' order: one version of kind props.
    op = key()
    moved = await _move(
        client, rows["a"]["id"], set={status: doing}, after_id=rows["b"]["id"], client_op_id=op
    )
    assert moved["row"]["props"][status] == doing
    answer = await query(client, database, view_id="board", grouped=True)
    assert _columns(answer)[:2] == [(todo, ["c", "b"]), (doing, ["a"])]
    assert [r["title"] for r in (await query(client, database, grouped=False))["rows"]] == [
        "c",
        "b",
        "a",
    ]
    # A retry with the same op id changes no cell again (the version is not made twice).
    await _move(
        client, rows["a"]["id"], set={status: doing}, after_id=rows["b"]["id"], client_op_id=op
    )
    versions = await db.scalar(
        select(func.count()).where(
            WikiPageRevision.page_id == rows["a"]["id"], WikiPageRevision.kind == "props"
        )
    )
    assert versions == 1
    # Back to 「なし」 (null clears it), at the end of the rows.
    await _move(client, rows["a"]["id"], set={status: None})
    answer = await query(client, database, view_id="board", grouped=True)
    assert _columns(answer)[-1] == ("", ["a"])
    # Moving after itself keeps it; the values are checked as PATCH …/props.
    await _move(client, rows["b"]["id"], after_id=rows["b"]["id"])
    bad = await _move(client, rows["b"]["id"], expect=422, set={status: "nope"})
    assert bad["error"]["code"] == "wiki_invalid_property_value"
    both = await _move(
        client, rows["b"]["id"], expect=422, before_id=rows["a"]["id"], after_id=rows["c"]["id"]
    )
    assert both["error"]["code"] == "validation_error"
    assert (await _move(client, rows["b"]["id"], expect=422))["error"]["code"] == "validation_error"


async def test_move_refuses_neighbours_outside_the_database(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    _, database = await _tasks(client, db, as_user)
    other = await create_database(client, title="Other")
    mine = await add_row(client, database, "mine")
    theirs = await add_row(client, other, "theirs")
    template = (
        await client.post(
            f"{API}/wiki/databases/{database['page_id']}/rows",
            json={"title": "T", "is_template": True, "client_save_id": key()},
        )
    ).json()["row"]
    trashed = await add_row(client, database, "gone")
    assert (await client.delete(f"{API}/wiki/pages/{trashed['id']}")).status_code in (200, 204)
    page = await create_page(client, title="Page")
    for anchor in (theirs["id"], template["id"], trashed["id"], page["id"]):
        bad = await _move(client, mine["id"], expect=400, after_id=anchor)
        assert bad["error"]["code"] == "wiki_invalid_move"
    bad = await _move(client, template["id"], expect=400, after_id=mine["id"])
    assert bad["error"]["code"] == "wiki_invalid_move"


async def test_who_may_make_views_and_move_cards(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice, database = await _tasks(client, db, as_user)
    ed = await make_user(db, "ed")
    vic = await make_user(db, "vic")
    eve = await make_user(db, "eve")
    await set_access(
        client,
        database["page_id"],
        [
            ("user", str(alice.id), "full"),
            ("user", str(ed.id), "edit"),
            ("user", str(vic.id), "view"),
        ],
        inherit=False,
    )
    status = prop_id(database, "Status")
    todo = option_id(database, "Status", "未着手")
    first = await add_row(client, database, "a")
    second = await add_row(client, database, "b")
    # M144: edit access makes and changes views (a board too) and moves cards.
    as_user(ed)
    await _put_view(client, database, "board", type="board", group_by={"prop_id": status})
    await _move(client, first["id"], set={status: todo}, after_id=second["id"])
    # View access reads the board (in groups) but neither saves views nor moves.
    as_user(vic)
    answer = await query(client, database, view_id="board", grouped=True)
    assert _columns(answer)[0] == (todo, ["a"])
    denied = await _put_view(
        client, database, "board", expect=403, type="board", group_by={"prop_id": status}
    )
    assert denied["error"]["code"] == "page_edit_restricted"
    moved = await _move(client, first["id"], expect=403, after_id=second["id"])
    assert moved["error"]["code"] == "page_edit_restricted"
    # No access: the database and its rows do not exist.
    as_user(eve)
    assert (
        await client.post(
            f"{API}/wiki/databases/{database['page_id']}/query", json={"grouped": True}
        )
    ).status_code == 404
    assert (await _move(client, first["id"], expect=404, after_id=second["id"]))["error"][
        "code"
    ] == "page_not_found"


# --- the views after a schema change -------------------------------------------------------------


async def test_schema_changes_keep_the_groups_valid(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    _, database = await _tasks(client, db, as_user)
    status, tags, owner = (prop_id(database, n) for n in ("Status", "Tags", "Owner"))
    todo, doing = option_id(database, "Status", "未着手"), option_id(database, "Status", "進行中")
    await _put_view(
        client,
        database,
        "board",
        type="board",
        group_by={"prop_id": status, "hidden": [todo, doing]},
    )
    await _put_view(client, database, "tags", type="table", group_by={"prop_id": tags})
    await _put_view(client, database, "people", type="board", group_by={"prop_id": owner})

    def view(out: dict[str, Any], view_id: str) -> dict[str, Any]:
        return next(v for v in out["views"] if v["id"] == view_id)

    # Removing an option drops it from the hidden groups.
    status_prop = next(p for p in database["properties"] if p["id"] == status)
    out = await schema(
        client,
        database,
        {
            "op": "update",
            "id": status,
            "options": [o for o in status_prop["options"] if o["id"] != todo],
        },
    )
    assert view(out, "board")["group_by"]["hidden"] == [doing]
    # A multi-select turned select still groups the table (hidden reset); a person turned text
    # cannot group the board any more.
    out = await schema(client, database, {"op": "retype", "id": tags, "type": "select"})
    assert view(out, "tags")["group_by"] == {
        "prop_id": tags,
        "date_unit": None,
        "hidden": [],
        "hide_empty": False,
    }
    out = await schema(client, database, {"op": "retype", "id": owner, "type": "text"})
    assert view(out, "people")["group_by"] is None
    # Deleting the property: the board waits for another one.
    out = await schema(client, database, {"op": "delete", "id": status})
    assert view(out, "board")["group_by"] is None and view(out, "board")["type"] == "board"
    answer = await query(client, database, view_id="board", grouped=True)
    assert answer["groups"] == [] and answer["row_groups"] == []


# --- the gallery's picture ------------------------------------------------------------------------


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 30), (1, 2, 3)).save(out, format="PNG")
    return out.getvalue()


async def _upload(
    client: AsyncClient, name: str = "x.png", data: bytes | None = None, kind: str = "image/png"
) -> str:
    response = await client.post(f"{API}/attachments", files={"file": (name, data or _png(), kind)})
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


async def test_gallery_covers_are_the_rows_first_image(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    _, database = await _tasks(client, db, as_user)
    pictured = await add_row(client, database, "pictured")
    plain = await add_row(client, database, "plain")
    borrowed = await add_row(client, database, "borrowed")
    filed = await add_row(client, database, "filed")
    first, second = await _upload(client), await _upload(client)
    page = (await client.get(f"{API}/wiki/pages/{pictured['id']}")).json()
    saved = await save(
        client, page, f"intro\n\n![one](attachment:{first})\n\n![two](attachment:{second})\n"
    )
    assert saved.status_code == 200, saved.text
    # An image of another row's body is not this row's picture.
    page = (await client.get(f"{API}/wiki/pages/{borrowed['id']}")).json()
    assert (await save(client, page, f"![x](attachment:{first})\n")).status_code == 200
    # A file that is not an image is no picture.
    pdf = await _upload(client, "a.txt", b"hello", "text/plain")
    page = (await client.get(f"{API}/wiki/pages/{filed['id']}")).json()
    assert (await save(client, page, f"![x](attachment:{pdf})\n")).status_code == 200
    answer = await query(client, database, covers=True, grouped=False)
    covers = {r["title"]: r["cover"] for r in answer["rows"]}
    assert covers["pictured"] == {
        "attachment_id": first,
        "thumbnail": True,
        "width": 40,
        "height": 30,
    }
    assert covers["plain"] is None and covers["borrowed"] is None and covers["filed"] is None
    # Without `covers` the answer has none (old clients, tables).
    assert all(r["cover"] is None for r in (await query(client, database))["rows"])
    assert plain["id"]
