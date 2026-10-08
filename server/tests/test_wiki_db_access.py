"""Who shapes a database (M144, docs/WIKI.md §22.2): edit access adds, renames and reorders
properties, adds options and changes their names and colours, a number's format and the views;
deleting a property or an option, changing a type and a two-way relation stay with full access.
Whoever makes a database gets full access to it."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit.models import AuditLog
from app.modules.users.models import User
from app.modules.wiki.models import WikiGrant
from tests.helpers import make_user
from tests.wiki_helpers import (
    API,
    Actor,
    assert_acl_consistent,
    create_database,
    create_page,
    option_id,
    prop_id,
    schema,
    set_access,
)


@dataclass
class Lab:
    alice: User  # full on the page (made it)
    ed: User  # edit
    vic: User  # view
    page: dict[str, Any]
    database: dict[str, Any]
    other: dict[str, Any]  # a second database, for relations


async def _lab(client: AsyncClient, db: AsyncSession, as_user: Actor) -> Lab:
    alice = await make_user(db, "alice")
    ed = await make_user(db, "ed")
    vic = await make_user(db, "vic")
    as_user(alice)
    page = await create_page(client, title="Lab", access_="private")
    await set_access(
        client,
        page["id"],
        [
            ("user", str(alice.id), "full"),
            ("user", str(ed.id), "edit"),
            ("user", str(vic.id), "view"),
        ],
    )
    database = await create_database(client, parent_id=page["id"])
    await schema(
        client,
        database,
        {"op": "add", "name": "Notes", "type": "text"},
        {"op": "add", "name": "Year", "type": "number"},
        {
            "op": "add",
            "name": "Stage",
            "type": "select",
            "options": [{"name": "A", "color": "blue"}, {"name": "B", "color": "green"}],
        },
    )
    other = await create_database(client, title="People", parent_id=page["id"])
    return Lab(alice, ed, vic, page, database, other)


Request = Callable[[Lab], tuple[str, str, dict[str, Any] | None]]


def _ops(*ops: Callable[[Lab], dict[str, Any]]) -> Request:
    def build(lab: Lab) -> tuple[str, str, dict[str, Any] | None]:
        return (
            "PATCH",
            f"{API}/wiki/databases/{lab.database['page_id']}/schema",
            {
                "base_schema_version": lab.database["schema_version"],
                "ops": [op(lab) for op in ops],
            },
        )

    return build


def _options(lab: Lab, *names: str, recolor: str | None = None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for name in names:
        if name in ("A", "B"):
            color = recolor or ("blue" if name == "A" else "green")
            out.append({"id": option_id(lab.database, "Stage", name), "name": name, "color": color})
        else:
            out.append({"name": name, "color": "red"})
    return out


def _reorder(lab: Lab) -> dict[str, Any]:
    ids = [p["id"] for p in lab.database["properties"]]
    return {"op": "reorder", "ids": [ids[0], *reversed(ids[1:])]}


def _view(view_id: str, body: dict[str, Any]) -> Request:
    def build(lab: Lab) -> tuple[str, str, dict[str, Any] | None]:
        return ("PUT", f"{API}/wiki/databases/{lab.database['page_id']}/views/{view_id}", body)

    return build


def _delete_view(lab: Lab) -> tuple[str, str, dict[str, Any] | None]:
    view_id = lab.database["views"][0]["id"]
    return ("DELETE", f"{API}/wiki/databases/{lab.database['page_id']}/views/{view_id}", None)


def _relation(two_way: bool) -> Callable[[Lab], dict[str, Any]]:
    return lambda lab: {
        "op": "add",
        "name": "People",
        "type": "relation",
        "relation": {"database_id": lab.other["page_id"], "two_way": two_way},
    }


# (name, request, the level it needs)
CASES: list[tuple[str, Request, str]] = [
    ("add a property", _ops(lambda lab: {"op": "add", "name": "New", "type": "text"}), "edit"),
    (
        "add a select with options",
        _ops(lambda lab: {"op": "add", "name": "Tags", "type": "multi_select", "options": []}),
        "edit",
    ),
    (
        "rename a property",
        _ops(lambda lab: {"op": "update", "id": prop_id(lab.database, "Notes"), "name": "Memo"}),
        "edit",
    ),
    (
        "add an option",
        _ops(
            lambda lab: {
                "op": "update",
                "id": prop_id(lab.database, "Stage"),
                "options": _options(lab, "A", "B", "C"),
            }
        ),
        "edit",
    ),
    (
        "rename and recolour options",
        _ops(
            lambda lab: {
                "op": "update",
                "id": prop_id(lab.database, "Stage"),
                "options": [
                    {**o, "name": o["name"] + "!"} for o in _options(lab, "A", "B", recolor="red")
                ],
            }
        ),
        "edit",
    ),
    (
        "a number's format",
        _ops(
            lambda lab: {
                "op": "update",
                "id": prop_id(lab.database, "Year"),
                "number_format": "percent",
            }
        ),
        "edit",
    ),
    (
        "a number's format through retype",
        _ops(
            lambda lab: {
                "op": "retype",
                "id": prop_id(lab.database, "Year"),
                "type": "number",
                "number_format": "yen",
            }
        ),
        "edit",
    ),
    ("reorder", _ops(_reorder), "edit"),
    ("a one-way relation", _ops(_relation(False)), "edit"),
    ("a new view", _view("mine", {"name": "Mine", "type": "table"}), "edit"),
    (
        "change a view",
        lambda lab: _view(lab.database["views"][0]["id"], {"name": "Renamed", "type": "table"})(
            lab
        ),
        "edit",
    ),
    ("delete a view", _delete_view, "edit"),
    (
        "remove an option",
        _ops(
            lambda lab: {
                "op": "update",
                "id": prop_id(lab.database, "Stage"),
                "options": _options(lab, "A"),
            }
        ),
        "full",
    ),
    (
        "change a type",
        _ops(lambda lab: {"op": "retype", "id": prop_id(lab.database, "Notes"), "type": "url"}),
        "full",
    ),
    (
        "delete a property",
        _ops(lambda lab: {"op": "delete", "id": prop_id(lab.database, "Notes")}),
        "full",
    ),
    ("a two-way relation", _ops(_relation(True)), "full"),
]


async def _send(client: AsyncClient, request: tuple[str, str, dict[str, Any] | None]) -> Any:
    method, url, body = request
    return await client.request(method, url, json=body)


async def _refresh(client: AsyncClient, lab: Lab) -> None:
    lab.database = (await client.get(f"{API}/wiki/databases/{lab.database['page_id']}")).json()


@pytest.mark.parametrize(("name", "request_", "needs"), CASES, ids=[c[0] for c in CASES])
async def test_who_may_shape_a_database(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Actor,
    name: str,
    request_: Request,
    needs: str,
) -> None:
    lab = await _lab(client, db, as_user)
    if name == "delete a view":
        # One view more, so the last one is not the reason for a refusal.
        await _send(client, _view("second", {"name": "Second", "type": "table"})(lab))
        await _refresh(client, lab)
    version = lab.database["schema_version"]

    as_user(lab.vic)
    refused = await _send(client, request_(lab))
    assert refused.status_code == 403, refused.text
    assert refused.json()["error"]["code"] == "page_edit_restricted"

    as_user(lab.ed)
    response = await _send(client, request_(lab))
    if needs == "edit":
        assert response.status_code == 200, response.text
        assert response.json()["schema_version"] == version + 1
        assert response.json()["my_level"] == "edit"
    else:
        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "page_manage_restricted"
        await _refresh(client, lab)
        assert lab.database["schema_version"] == version  # nothing was written
        as_user(lab.alice)
        done = await _send(client, request_(lab))
        assert done.status_code == 200, done.text
    await assert_acl_consistent(db)


async def test_changes_by_editors_are_audited(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    lab = await _lab(client, db, as_user)
    as_user(lab.ed)
    await schema(client, lab.database, {"op": "add", "name": "New", "type": "text"})
    await _send(client, _view("mine", {"name": "Mine", "type": "table"})(lab))
    await _send(
        client, ("DELETE", f"{API}/wiki/databases/{lab.database['page_id']}/views/mine", None)
    )
    logs = (
        (
            await db.execute(
                select(AuditLog)
                .where(AuditLog.target_id == lab.database["page_id"])
                .order_by(AuditLog.id)
            )
        )
        .scalars()
        .all()
    )
    mine = [(log.action, log.details) for log in logs if log.actor_id == lab.ed.id]
    assert mine == [
        ("wiki.schema_changed", {"ops": [{"op": "add", "type": "text"}]}),
        ("wiki.view_saved", {"view_id": "mine", "type": "table"}),
        ("wiki.view_deleted", {"view_id": "mine"}),
    ]


async def _own(db: AsyncSession, page_id: str) -> list[tuple[str, Any, str]]:
    rows = await db.execute(select(WikiGrant).where(WikiGrant.page_id == page_id))
    return sorted((g.principal_type, g.principal_id, g.level) for g in rows.scalars())


async def test_whoever_makes_a_database_gets_full_access(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    lab = await _lab(client, db, as_user)
    # alice has full access from the page: nothing of her own on her databases.
    assert await _own(db, lab.database["page_id"]) == []

    as_user(lab.ed)
    mine = await create_database(client, title="Ed's", parent_id=lab.page["id"])
    assert mine["my_level"] == "full"
    assert await _own(db, mine["page_id"]) == [("user", lab.ed.id, "full")]
    await schema(client, mine, {"op": "add", "name": "Notes", "type": "text"})
    await schema(client, mine, {"op": "retype", "id": prop_id(mine, "Notes"), "type": "url"})
    await schema(client, mine, {"op": "delete", "id": prop_id(mine, "Notes")})
    # Still inherits: the others keep their levels, nobody loses anything.
    access = (await client.get(f"{API}/wiki/pages/{mine['page_id']}/access")).json()
    assert access["inherit_access"] is True
    levels = {e["principal_id"]: e["level"] for e in access["effective"]}
    assert levels == {str(lab.alice.id): "full", str(lab.ed.id): "full", str(lab.vic.id): "view"}
    # A page made by an editor stays as it was (inherits, nothing of its own).
    page = await create_page(client, title="Ed's page", parent_id=lab.page["id"])
    assert page["my_level"] == "edit"
    assert await _own(db, page["id"]) == []
    # The page above is not touched.
    as_user(lab.vic)
    assert (await client.get(f"{API}/wiki/databases/{mine['page_id']}")).json()[
        "my_level"
    ] == "view"
    await assert_acl_consistent(db)
