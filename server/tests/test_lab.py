"""The lab roster and the groups kept from it (M23, DATA_MODEL.md lab_profiles)."""

from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from tests.helpers import make_user


async def _put(client: AsyncClient, user: User, **line: Any) -> dict[str, Any]:
    response = await client.put(f"/api/v1/lab/roster/{user.id}", json=line)
    assert response.status_code == 200, response.text
    return dict(response.json())


async def _groups(client: AsyncClient) -> dict[str, dict[str, Any]]:
    return {g["name"]: g for g in (await client.get("/api/v1/groups")).json()}


async def _events(db: AsyncSession, event_type: str) -> list[OutboxEvent]:
    stmt = select(OutboxEvent).where(OutboxEvent.event_type == event_type).order_by(OutboxEvent.id)
    return list((await db.execute(stmt)).scalars().all())


async def test_the_roster_orders_people_and_keeps_the_grade_groups(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    prof = await make_user(db, "prof")
    assoc = await make_user(db, "assoc")
    d1 = await make_user(db, "doc")
    m1a = await make_user(db, "m1a")
    m1b = await make_user(db, "m1b")
    b4 = await make_user(db, "four")
    old = await make_user(db, "old")
    as_user(root)
    await _put(client, b4, affiliation="student", grade="B4")
    await _put(client, old, affiliation="alumni")
    await _put(client, m1b, affiliation="student", grade="M1", reading="あおき")
    await _put(client, assoc, affiliation="faculty", rank="associate_professor")
    await _put(client, prof, affiliation="faculty", rank="professor")
    await _put(client, m1a, affiliation="student", grade="M1", reading="いとう")
    line = await _put(
        client,
        d1,
        affiliation="student",
        grade="D1",
        supervisor_id=str(prof.id),
        research_topic="  拡散モデル  ",
    )
    assert line["supervisor_id"] == str(prof.id) and line["research_topic"] == "拡散モデル"

    roster = (await client.get("/api/v1/lab/roster")).json()
    order = [r["user_id"] for r in roster]
    assert order == [str(u.id) for u in (prof, assoc, d1, m1b, m1a, b4, old)]
    booted = (await client.get("/api/v1/sync/bootstrap")).json()
    assert [r["user_id"] for r in booted["roster"]] == order

    groups = await _groups(client)
    assert set(groups) == {"faculty", "students", "alumni", "b4", "m1", "d"}  # no M2 yet: not made
    assert all(g["managed"] for g in groups.values())
    assert set(groups["m1"]["member_ids"]) == {str(m1a.id), str(m1b.id)}
    assert set(groups["faculty"]["member_ids"]) == {str(prof.id), str(assoc.id)}
    assert groups["d"]["member_ids"] == [str(d1.id)]

    # A year on: the M1s move up, the B4 leaves the roster; only changed groups announce it.
    before = len(await _events(db, "group.updated"))
    await _put(client, m1a, affiliation="student", grade="M2")
    await _put(client, m1b, affiliation="student", grade="M2")
    assert (await client.delete(f"/api/v1/lab/roster/{b4.id}")).status_code == 204
    groups = await _groups(client)
    assert groups["m1"]["member_ids"] == [] and groups["b4"]["member_ids"] == []
    assert set(groups["m2"]["member_ids"]) == {str(m1a.id), str(m1b.id)}
    changed = [e.payload["group"]["name"] for e in (await _events(db, "group.updated"))[before:]]
    assert sorted(changed) == sorted(["m1", "m2", "m1", "m2", "b4", "students"])
    # The reading and topic an admin did not send are kept.
    kept = await _put(client, m1b, affiliation="student", grade="M2")
    assert kept["reading"] == "あおき"


async def test_managed_groups_cannot_be_changed_by_hand_and_take_over_a_group_of_that_name(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(root)
    by_hand = (
        await client.post("/api/v1/admin/groups", json={"name": "m1", "member_ids": [str(bob.id)]})
    ).json()
    await _put(client, alice, affiliation="student", grade="M1")
    groups = await _groups(client)
    assert groups["m1"]["id"] == by_hand["id"] and groups["m1"]["managed"] is True
    assert groups["m1"]["member_ids"] == [str(alice.id)]

    edited = await client.patch(f"/api/v1/admin/groups/{by_hand['id']}", json={"member_ids": []})
    assert edited.status_code == 409 and edited.json()["error"]["code"] == "group_managed"
    deleted = await client.delete(f"/api/v1/admin/groups/{by_hand['id']}")
    assert deleted.status_code == 409
    # A user named like a managed group: that group is not made (@name must stay unique).
    await make_user(db, "d")
    await _put(client, bob, affiliation="student", grade="D2")
    assert "d" not in await _groups(client)


async def test_who_may_change_what(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    prof = await make_user(db, "prof")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    refused = await client.put(f"/api/v1/lab/roster/{alice.id}", json={"affiliation": "faculty"})
    assert refused.status_code == 403
    missing = await client.patch("/api/v1/lab/roster/me", json={"research_topic": "x"})
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "roster_entry_not_found"

    as_user(root)
    wrong = await client.put(
        f"/api/v1/lab/roster/{alice.id}", json={"affiliation": "alumni", "grade": "M1"}
    )
    assert wrong.status_code == 422
    not_faculty = await client.put(
        f"/api/v1/lab/roster/{alice.id}",
        json={"affiliation": "student", "grade": "M1", "supervisor_id": str(bob.id)},
    )
    assert not_faculty.status_code == 422
    assert not_faculty.json()["error"]["code"] == "invalid_supervisor"
    await _put(client, prof, affiliation="faculty", rank="professor")
    await _put(client, alice, affiliation="student", grade="M1", supervisor_id=str(prof.id))

    as_user(alice)
    mine = await client.patch(
        "/api/v1/lab/roster/me", json={"research_topic": "音声合成", "reading": "ありす"}
    )
    assert mine.status_code == 200
    assert mine.json()["research_topic"] == "音声合成" and mine.json()["grade"] == "M1"
    extra = await client.patch("/api/v1/lab/roster/me", json={"grade": "D3"})
    assert extra.status_code == 422  # the place in the roster is the administrators'
    events = await _events(db, "roster.updated")
    assert events[-1].payload["profile"]["research_topic"] == "音声合成"
    assert {e.audience_type for e in events} == {"all"}


async def test_guests_see_only_the_lines_of_people_they_share_a_channel_with(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    from app.modules.channels.service import resolve_event_audience

    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    stranger = await make_user(db, "stranger")
    guest = await make_user(db, "guest", role="guest")
    as_user(root)
    project = (
        await client.post("/api/v1/channels", json={"name": "project", "type": "private"})
    ).json()
    for user in (alice, guest):
        await client.post(
            f"/api/v1/channels/{project['id']}/members", json={"user_id": str(user.id)}
        )
    await _put(client, alice, affiliation="student", grade="M1", research_topic="秘密ではない")
    await _put(client, stranger, affiliation="student", grade="M2", research_topic="見せない")

    as_user(guest)
    seen = {r["user_id"] for r in (await client.get("/api/v1/lab/roster")).json()}
    assert seen == {str(alice.id)}
    booted = (await client.get("/api/v1/sync/bootstrap")).json()
    assert {r["user_id"] for r in booted["roster"]} == {str(alice.id)}
    event = (await _events(db, "roster.updated"))[-1]
    audience = await resolve_event_audience(db, event)
    assert audience.kind == "users" and guest.id not in audience.ids and alice.id in audience.ids


async def test_anonymizing_drops_the_line_and_the_groups_follow(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _put(client, alice, affiliation="student", grade="B4", research_topic="個人の研究")
    assert (await client.post(f"/api/v1/admin/users/{alice.id}/anonymize")).status_code == 200
    assert (await client.get("/api/v1/lab/roster")).json() == []
    assert (await _groups(client))["b4"]["member_ids"] == []
    last = (await _events(db, "roster.updated"))[-1]
    assert last.payload == {"user_id": str(alice.id), "profile": None}
