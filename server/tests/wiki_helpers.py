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
