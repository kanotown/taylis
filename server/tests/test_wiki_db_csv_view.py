"""Functional review v0.1.84 #2: a database's CSV holds exactly the rows its view shows — the
rows of hidden groups left out, in the view's order, with filters and an unsaved view (WIKI.md
§5.6) — and texts a spreadsheet would read as formulas are guarded (SECURITY.md §11)."""

import csv
import io
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from tests.helpers import make_user
from tests.wiki_helpers import (
    API,
    Actor,
    add_row,
    create_database,
    option_id,
    prop_id,
    query,
    schema,
)


async def _tasks(client: AsyncClient, db: AsyncSession, as_user: Actor) -> dict[str, Any]:
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
            "options": [{"name": "表示"}, {"name": "非表示"}, {"name": "保留"}],
        },
        {
            "op": "add",
            "name": "Tags",
            "type": "multi_select",
            "options": [{"name": "A"}, {"name": "B"}],
        },
        {"op": "add", "name": "Done", "type": "checkbox"},
        {"op": "add", "name": "Due", "type": "date"},
        {"op": "add", "name": "Score", "type": "number"},
        {"op": "add", "name": "Note", "type": "text"},
    )
    return database


async def _put_view(
    client: AsyncClient, database: dict[str, Any], view_id: str, **body: Any
) -> None:
    response = await client.put(
        f"{API}/wiki/databases/{database['page_id']}/views/{view_id}", json=body
    )
    assert response.status_code == 200, response.text


def _table(content: bytes) -> list[list[str]]:
    return list(csv.reader(io.StringIO(content.decode("utf-8-sig"))))


async def _csv_titles(
    client: AsyncClient,
    database: dict[str, Any],
    *,
    post: dict[str, Any] | None = None,
    **params: str,
) -> list[str]:
    url = f"{API}/wiki/databases/{database['page_id']}/export.csv"
    response = (
        await client.post(url, json=post)
        if post is not None
        else await client.get(url, params=params)
    )
    assert response.status_code == 200, response.text
    table = _table(response.content)
    title = table[0].index("名前") if "名前" in table[0] else 0
    return [line[title] for line in table[1:]]


async def _shown(client: AsyncClient, database: dict[str, Any], **body: Any) -> list[str]:
    """The rows the screen shows (a grouped query, as the clients ask), each once."""
    answer = await query(client, database, grouped=True, limit=1000, **body)
    return list(dict.fromkeys(r["title"] for r in answer["rows"]))


async def test_csv_leaves_out_hidden_groups_like_the_view(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    database = await _tasks(client, db, as_user)
    status, score = prop_id(database, "Status"), prop_id(database, "Score")
    shown, hidden, held = (option_id(database, "Status", n) for n in ("表示", "非表示", "保留"))
    await add_row(client, database, "表示する行", {status: shown, score: 2})
    await add_row(client, database, "隠したグループの行", {status: hidden, score: 1})
    await add_row(client, database, "保留の行", {status: held, score: 3})
    await add_row(client, database, "空の行", {score: 0})
    await _put_view(
        client,
        database,
        "board",
        type="board",
        group_by={"prop_id": status, "hidden": [hidden]},
        sort=[{"prop_id": score, "direction": "desc"}],
    )
    # The screen: groups in the options' order, then 「なし」; within a group by the sort.
    expected = ["表示する行", "保留の行", "空の行"]
    assert await _shown(client, database, view_id="board") == expected
    assert await _csv_titles(client, database, view_id="board") == expected
    assert await _csv_titles(client, database, post={"view_id": "board"}) == expected
    # With a filter (saved or not): both apply.
    low = {"conditions": [{"prop_id": score, "op": "lte", "value": 2}]}
    assert await _shown(client, database, view_id="board", filter=low) == ["表示する行", "空の行"]
    assert await _csv_titles(client, database, post={"view_id": "board", "filter": low}) == [
        "表示する行",
        "空の行",
    ]
    # An unsaved group_by (the reader shows the hidden group again, hides 「なし」).
    unsaved = {"prop_id": status, "hidden": [""]}
    assert await _shown(client, database, view_id="board", group_by=unsaved) == [
        "表示する行",
        "隠したグループの行",
        "保留の行",
    ]
    assert await _csv_titles(
        client, database, post={"view_id": "board", "grouped": True, "group_by": unsaved}
    ) == ["表示する行", "隠したグループの行", "保留の行"]
    # Every group hidden: only the header.
    every = {"prop_id": status, "hidden": [shown, hidden, held, ""]}
    assert await _shown(client, database, view_id="board", group_by=every) == []
    assert await _csv_titles(client, database, post={"view_id": "board", "group_by": every}) == []
    # `grouped: false` (a view without groups on the screen): every row, in the sort's order.
    assert await _csv_titles(client, database, post={"view_id": "board", "grouped": False}) == [
        "保留の行",
        "表示する行",
        "隠したグループの行",
        "空の行",
    ]


async def test_csv_groups_by_every_groupable_type(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    database = await _tasks(client, db, as_user)
    tags, done, due = (prop_id(database, n) for n in ("Tags", "Done", "Due"))
    a, b = option_id(database, "Tags", "A"), option_id(database, "Tags", "B")
    await add_row(client, database, "r1", {tags: [b, a], due: "2026-10-05"})
    await add_row(client, database, "r2", {tags: [a], done: True, due: "2026-10-11"})
    await add_row(client, database, "r3", {tags: [b], due: "2026-11-01"})
    await add_row(client, database, "r4", {})
    view = database["views"][0]["id"]
    cases: list[tuple[dict[str, Any], list[str]]] = [
        # A row in several groups is written once, in its first shown group.
        ({"prop_id": tags}, ["r1", "r2", "r3", "r4"]),
        ({"prop_id": tags, "hidden": [a]}, ["r1", "r3", "r4"]),
        ({"prop_id": tags, "hidden": [a, b]}, ["r4"]),
        ({"prop_id": done, "hidden": ["false"]}, ["r2"]),
        ({"prop_id": due, "date_unit": "month", "hidden": ["2026-10"]}, ["r3", "r4"]),
        ({"prop_id": due, "hidden": [""]}, ["r1", "r2", "r3"]),
    ]
    for group_by, expected in cases:
        assert await _shown(client, database, view_id=view, group_by=group_by) == expected
        got = await _csv_titles(
            client, database, post={"view_id": view, "grouped": True, "group_by": group_by}
        )
        assert got == expected, group_by
    # A saved table view with groups: the GET (older clients) leaves the hidden ones out too.
    await _put_view(client, database, "t2", type="table", group_by={"prop_id": tags, "hidden": [b]})
    assert await _csv_titles(client, database, view_id="t2") == ["r1", "r2", "r4"]
    bad = await client.get(
        f"{API}/wiki/databases/{database['page_id']}/export.csv",
        params={"view_id": "t2", "tz": "Mars/Base"},
    )
    assert bad.status_code == 422


async def test_csv_unsaved_columns_and_formula_guard(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    database = await _tasks(client, db, as_user)
    score, note = prop_id(database, "Score"), prop_id(database, "Note")
    await add_row(client, database, "=1+1", {score: -5, note: "@SUM(A1)"})
    response = await client.post(
        f"{API}/wiki/databases/{database['page_id']}/export.csv",
        json={
            "columns": [
                {"prop_id": "title"},
                {"prop_id": score},
                {"prop_id": note},
                *(
                    {"prop_id": p["id"], "hidden": True}
                    for p in database["properties"]
                    if p["id"] not in ("title", score, note)
                ),
            ]
        },
        headers={"Accept-Language": "ja"},
    )
    assert response.status_code == 200, response.text
    table = _table(response.content)
    assert table[0] == ["名前", "Score", "Note"]
    # A number stays a number; a text that starts like a formula gets a ' in front.
    assert table[1] == ["'=1+1", "-5", "'@SUM(A1)"]
