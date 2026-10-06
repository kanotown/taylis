"""Shared steps for the wiki tests (M120, docs/WIKI.md)."""

import uuid
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from app.modules.wiki import access

API = "/api/v1"
Actor = Callable[[User], None]


def key() -> str:
    return str(uuid.uuid4())


async def create_page(
    client: AsyncClient,
    *,
    parent_id: str | None = None,
    title: str = "Page",
    body: str = "",
    access_: str = "workspace",
    expect: int = 201,
    **extra: Any,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "client_save_id": key(),
        "title": title,
        "body": body,
        "access": access_,
        **extra,
    }
    if parent_id is not None:
        payload["parent_id"] = parent_id
    response = await client.post(f"{API}/wiki/pages", json=payload)
    assert response.status_code == expect, response.text
    out: dict[str, Any] = response.json()
    return out


async def save(
    client: AsyncClient, page: dict[str, Any], body: str, *, base: str | None = None
) -> Any:
    return await client.put(
        f"{API}/wiki/pages/{page['id']}/content",
        json={
            "base_rev_id": base or page["head_rev_id"],
            "body": body,
            "client_save_id": key(),
        },
    )


async def set_access(
    client: AsyncClient,
    page_id: str,
    grants: list[tuple[str, str | None, str]],
    *,
    inherit: bool = True,
    expect: int = 200,
) -> dict[str, Any]:
    response = await client.put(
        f"{API}/wiki/pages/{page_id}/access",
        json={
            "inherit_access": inherit,
            "grants": [
                {"principal_type": t, "principal_id": p, "level": lv} for t, p, lv in grants
            ],
        },
    )
    assert response.status_code == expect, response.text
    out: dict[str, Any] = response.json()
    return out


async def assert_acl_consistent(db: AsyncSession) -> None:
    """wiki_effective_grants equals a full recomputation, and every path matches its parents."""
    db.expire_all()
    problems = await access.verify(db)
    await db.rollback()
    assert problems == [], problems[:5]


# --- databases (M123) ----------------------------------------------------------------------------


async def create_database(
    client: AsyncClient,
    *,
    title: str = "Papers",
    parent_id: str | None = None,
    access_: str = "workspace",
) -> dict[str, Any]:
    page = await create_page(
        client, title=title, parent_id=parent_id, access_=access_, kind="database"
    )
    response = await client.get(f"{API}/wiki/databases/{page['id']}")
    assert response.status_code == 200, response.text
    out: dict[str, Any] = response.json()
    return out


async def schema(
    client: AsyncClient, database: dict[str, Any], *ops: dict[str, Any], expect: int = 200
) -> dict[str, Any]:
    """Apply schema ops on the latest version; returns the new DatabaseOut (and updates it)."""
    current = (await client.get(f"{API}/wiki/databases/{database['page_id']}")).json()
    response = await client.patch(
        f"{API}/wiki/databases/{database['page_id']}/schema",
        json={"base_schema_version": current["schema_version"], "ops": list(ops)},
    )
    assert response.status_code == expect, response.text
    out: dict[str, Any] = response.json()
    if expect == 200:
        database.clear()
        database.update(out)
    return out


def prop_id(database: dict[str, Any], name: str) -> str:
    return str(next(p["id"] for p in database["properties"] if p["name"] == name))


def option_id(database: dict[str, Any], prop: str, name: str) -> str:
    found = next(p for p in database["properties"] if p["name"] == prop)
    return str(next(o["id"] for o in found["options"] if o["name"] == name))


async def add_row(
    client: AsyncClient,
    database: dict[str, Any],
    title: str,
    props: dict[str, Any] | None = None,
    *,
    expect: int = 201,
) -> dict[str, Any]:
    response = await client.post(
        f"{API}/wiki/databases/{database['page_id']}/rows",
        json={"title": title, "props": props or {}, "client_save_id": key()},
    )
    assert response.status_code == expect, response.text
    out: dict[str, Any] = response.json()
    return out["row"] if expect == 201 else out


async def set_cells(
    client: AsyncClient, row_id: str, values: dict[str, Any], *, expect: int = 200
) -> dict[str, Any]:
    response = await client.patch(
        f"{API}/wiki/rows/{row_id}/props", json={"set": values, "client_op_id": key()}
    )
    assert response.status_code == expect, response.text
    out: dict[str, Any] = response.json()
    return out


async def query(client: AsyncClient, database: dict[str, Any], **body: Any) -> dict[str, Any]:
    response = await client.post(f"{API}/wiki/databases/{database['page_id']}/query", json=body)
    assert response.status_code == 200, response.text
    out: dict[str, Any] = response.json()
    return out


async def titles(client: AsyncClient, database: dict[str, Any], **body: Any) -> list[str]:
    return [r["title"] for r in (await query(client, database, limit=1000, **body))["rows"]]
