"""Post templates (M30): the workspace's and each person's own, names, who edits, events."""

from collections.abc import Callable
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.templates.models import MessageTemplate
from app.modules.users.models import User
from tests.helpers import make_user


@pytest.fixture(autouse=True)
async def _no_defaults(db: AsyncSession) -> None:
    """The migration's 日報 / 週報 last until the first truncation: start without them."""
    await db.execute(delete(MessageTemplate))
    await db.commit()


async def _create(client: AsyncClient, **body: Any) -> Any:
    return await client.post("/api/v1/templates", json={"body": "**日報 {date}**\n- ", **body})


async def _events(db: AsyncSession) -> list[OutboxEvent]:
    rows = await db.execute(
        select(OutboxEvent)
        .where(OutboxEvent.event_type == "template.updated")
        .order_by(OutboxEvent.id)
    )
    return list(rows.scalars().all())


async def test_personal_and_workspace_templates(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    admin = await make_user(db, "root", role="admin")

    as_user(admin)
    shared = await _create(client, scope="workspace", name="日報", suggest_in="times")
    assert shared.status_code == 201, shared.text
    assert shared.json()["scope"] == "workspace" and shared.json()["owner_id"] is None
    assert shared.json()["position"] == 0 and shared.json()["suggest_in"] == "times"
    weekly = await _create(client, scope="workspace", name="週報")
    assert weekly.json()["position"] == 1  # the end of the list when no position is given

    as_user(alice)
    # Only admins add the workspace's.
    assert (await _create(client, scope="workspace", name="議事録")).status_code == 403
    mine = await _create(client, name="日報")  # a personal one may share a workspace name
    assert mine.status_code == 201, mine.text
    assert mine.json()["scope"] == "user" and mine.json()["owner_id"] == str(alice.id)
    listed = (await client.get("/api/v1/templates")).json()
    assert [(t["scope"], t["name"]) for t in listed] == [
        ("workspace", "日報"),
        ("workspace", "週報"),
        ("user", "日報"),
    ]
    booted = (await client.get("/api/v1/sync/bootstrap")).json()
    assert [t["id"] for t in booted["templates"]] == [t["id"] for t in listed]

    as_user(bob)
    # Someone else's own templates are not seen, nor editable (not found, not forbidden).
    assert [t["name"] for t in (await client.get("/api/v1/templates")).json()] == ["日報", "週報"]
    assert (
        await client.patch(f"/api/v1/templates/{mine.json()['id']}", json={"body": "x"})
    ).status_code == 404
    assert (await client.delete(f"/api/v1/templates/{mine.json()['id']}")).status_code == 404
    # The workspace's are the admins'.
    assert (
        await client.patch(f"/api/v1/templates/{shared.json()['id']}", json={"body": "x"})
    ).status_code == 403

    as_user(alice)
    updated = await client.patch(
        f"/api/v1/templates/{mine.json()['id']}",
        json={
            "name": "My-日報_2",
            "body": "今日は {weekday}",
            "suggest_in": "times",
            "position": 5,
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "My-日報_2" and updated.json()["position"] == 5
    assert updated.json()["updated_at"] >= mine.json()["updated_at"]
    assert (await client.delete(f"/api/v1/templates/{mine.json()['id']}")).status_code == 204
    assert (await client.delete(f"/api/v1/templates/{mine.json()['id']}")).status_code == 404

    # A workspace template's events go to everyone, a personal one's to its owner only.
    audiences = [(e.audience_type, e.audience_id, e.payload["deleted"]) for e in await _events(db)]
    assert audiences == [
        ("all", None, False),
        ("all", None, False),
        ("user", alice.id, False),
        ("user", alice.id, False),
        ("user", alice.id, True),
    ]


async def test_names(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    first = await _create(client, name=" Seminar ")
    assert first.status_code == 201 and first.json()["name"] == "Seminar"
    # Unique per person, whatever the case.
    taken = await _create(client, name="seminar")
    assert taken.status_code == 409 and taken.json()["error"]["code"] == "template_name_taken"
    for bad in ("", "a b", "a/b", "x" * 21, "議事録!", "改\n行"):
        response = await _create(client, name=bad)
        assert response.status_code in (400, 422), (bad, response.text)
    # The clients' built-in commands keep their names.
    for reserved in ("poll", "HELP", "日程"):
        response = await _create(client, name=reserved)
        assert (
            response.status_code == 400
            and response.json()["error"]["code"] == "template_name_reserved"
        )
    blank = await _create(client, name="空", body="  \n ")
    assert blank.status_code == 400 and blank.json()["error"]["code"] == "template_body_empty"
    renamed = await client.patch(
        f"/api/v1/templates/{first.json()['id']}", json={"name": "SEMINAR"}
    )
    assert renamed.status_code == 200  # its own name in another case
    other = await _create(client, name="ゼミ")
    clash = await client.patch(f"/api/v1/templates/{other.json()['id']}", json={"name": "seminar"})
    assert clash.status_code == 409
    assert (
        await client.patch(f"/api/v1/templates/{other.json()['id']}", json={"scope": "workspace"})
    ).status_code == 422


async def test_guest_keeps_personal_templates(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "root", role="admin")
    guest = await make_user(db, "visitor", role="guest")
    as_user(admin)
    await _create(client, scope="workspace", name="議事録")
    as_user(guest)
    assert (await _create(client, name="メモ")).status_code == 201
    assert [t["name"] for t in (await client.get("/api/v1/templates")).json()] == ["議事録", "メモ"]


async def test_limit_per_person(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    for i in range(50):
        db.add(MessageTemplate(scope="user", owner_id=alice.id, name=f"t{i}", body="x", position=i))
    await db.commit()
    as_user(alice)
    response = await _create(client, name="one-more")
    assert response.status_code == 409 and response.json()["error"]["code"] == "template_limit"
