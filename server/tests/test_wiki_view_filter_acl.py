"""REVIEW-v0.1.43 #2 (WIKI.md §5.7): a saved view's relation filter never shows the id of a row
the reader cannot read (database and row detail); it shows "restricted:<n>", the stored view
keeps the id, and a re-save by that reader keeps the hidden condition."""

from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user
from tests.wiki_helpers import (
    API,
    Actor,
    add_row,
    create_database,
    prop_id,
    schema,
    set_access,
    titles,
)


async def _setup(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> tuple[User, User, dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Alice's private database with a secret row, and a workspace database (Bob: full) whose
    "Secret refs" points there and "Refs" at itself. Returns (alice, bob, secret db, open db,
    the secret row, the open row linking to it)."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    secret = await create_database(client, title="SECRET-DB", access_="private")
    hidden = await add_row(client, secret, "SECRET-ROW")
    open_db = await create_database(client, title="Open")
    await set_access(
        client,
        open_db["page_id"],
        [
            ("workspace", None, "view"),
            ("user", str(alice.id), "full"),
            ("user", str(bob.id), "full"),
        ],
    )
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
    linked = await add_row(
        client, open_db, "Linked", {refs: [shown["id"]], secret_refs: [hidden["id"]]}
    )
    return alice, bob, secret, open_db, hidden, linked


def _view(database: dict[str, Any], view_id: str) -> dict[str, Any]:
    return next(v for v in database["views"] if v["id"] == view_id)


async def _put_view(
    client: AsyncClient, database: dict[str, Any], view_id: str, body: dict[str, Any]
) -> Any:
    return await client.put(
        f"{API}/wiki/databases/{database['page_id']}/views/{view_id}", json=body
    )


async def test_saved_filters_hide_unreadable_rows_and_survive_a_weaker_re_save(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice, bob, secret, open_db, hidden, linked = await _setup(client, db, as_user)
    refs, secret_refs = prop_id(open_db, "Refs"), prop_id(open_db, "Secret refs")
    shown_id = linked["relations"][refs][0]
    conditions = [
        {"prop_id": refs, "op": "contains", "value": shown_id},
        {"prop_id": secret_refs, "op": "contains", "value": hidden["id"]},
    ]
    saved = await _put_view(
        client, open_db, "linked", {"name": "Linked", "filter": {"conditions": conditions}}
    )
    assert saved.status_code == 200, saved.text
    assert _view(saved.json(), "linked")["filter"]["conditions"] == conditions
    assert await titles(client, open_db, view_id="linked") == ["Linked"]

    as_user(bob)
    database = (await client.get(f"{API}/wiki/databases/{open_db['page_id']}")).json()
    detail = (await client.get(f"{API}/wiki/rows/{linked['id']}")).json()
    for out in (database, detail["database"]):
        shown = _view(out, "linked")["filter"]["conditions"]
        assert shown == [conditions[0], {**conditions[1], "value": "restricted:1"}]
    for response in (database, detail):
        text_ = str(response)
        assert (
            hidden["id"] not in text_ and secret["page_id"] not in text_ and "SECRET" not in text_
        )
    # The saved view still applies for him: an unreadable row matches nothing, with the view's
    # filter or with the filter as he was shown it (no 422 for the marker).
    assert await titles(client, open_db, view_id="linked") == []
    assert await titles(client, open_db, view_id="linked", filter={"conditions": shown}) == []
    negated = [{**shown[1], "op": "not_contains"}]
    assert set(await titles(client, open_db, filter={"conditions": negated})) == {"Shown", "Linked"}

    # Bob renames the view and adds a column, sending back what he was shown: the hidden
    # condition is kept (it is not dropped, nor widened to "any row").
    body = {**_view(database, "linked"), "name": "Linked rows", "columns": [{"prop_id": refs}]}
    del body["id"]
    resaved = await _put_view(client, open_db, "linked", body)
    assert resaved.status_code == 200, resaved.text
    assert _view(resaved.json(), "linked")["filter"]["conditions"][1]["value"] == "restricted:1"
    assert hidden["id"] not in resaved.text
    # Reordered conditions still name the stored condition by its index.
    body["filter"]["conditions"] = list(reversed(body["filter"]["conditions"]))
    reordered = await _put_view(client, open_db, "linked", body)
    assert reordered.status_code == 200, reordered.text
    assert _view(reordered.json(), "linked")["filter"]["conditions"][0]["value"] == "restricted:0"

    # A marker that names no stored condition is refused (another index, another property,
    # another view).
    for view_id, cond in (
        ("linked", {"prop_id": secret_refs, "op": "contains", "value": "restricted:7"}),
        ("linked", {"prop_id": refs, "op": "contains", "value": "restricted:0"}),
        ("fresh", {"prop_id": secret_refs, "op": "contains", "value": "restricted:0"}),
    ):
        bad = await _put_view(client, open_db, view_id, {"filter": {"conditions": [cond]}})
        assert bad.status_code == 400, bad.text
        assert bad.json()["error"]["code"] == "wiki_invalid_view"

    as_user(alice)
    view = _view((await client.get(f"{API}/wiki/databases/{open_db['page_id']}")).json(), "linked")
    assert view["name"] == "Linked rows"
    assert view["filter"]["conditions"] == list(reversed(conditions))
    assert await titles(client, open_db, view_id="linked") == ["Linked"]


async def test_a_filter_saved_while_readable_is_hidden_after_the_share_is_revoked(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice, bob, secret, open_db, hidden, linked = await _setup(client, db, as_user)
    secret_refs = prop_id(open_db, "Secret refs")
    await set_access(
        client,
        secret["page_id"],
        [("user", str(alice.id), "full"), ("user", str(bob.id), "view")],
    )
    as_user(bob)
    cond = {"prop_id": secret_refs, "op": "contains", "value": hidden["id"]}
    saved = await _put_view(client, open_db, "mine", {"filter": {"conditions": [cond]}})
    assert saved.status_code == 200, saved.text
    assert _view(saved.json(), "mine")["filter"]["conditions"] == [cond]
    assert await titles(client, open_db, view_id="mine") == ["Linked"]

    as_user(alice)
    await set_access(client, secret["page_id"], [("user", str(alice.id), "full")])
    as_user(bob)
    database = (await client.get(f"{API}/wiki/databases/{open_db['page_id']}")).json()
    detail = (await client.get(f"{API}/wiki/rows/{linked['id']}")).json()
    for out in (database, detail["database"]):
        assert _view(out, "mine")["filter"]["conditions"] == [{**cond, "value": "restricted:0"}]
    assert hidden["id"] not in str(database) and hidden["id"] not in str(detail)
    assert await titles(client, open_db, view_id="mine") == []

    # A row in the trash is not shown by id either (to anyone who reads the view).
    as_user(alice)
    assert (await client.delete(f"{API}/wiki/pages/{hidden['id']}")).status_code in (200, 204)
    database = (await client.get(f"{API}/wiki/databases/{open_db['page_id']}")).json()
    assert _view(database, "mine")["filter"]["conditions"][0]["value"] == "restricted:0"
