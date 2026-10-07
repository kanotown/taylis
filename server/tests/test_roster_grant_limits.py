"""REVIEW-v0.1.43 #1 (docs/ROLES.md §4.2): a manager changes people's roster groups only within
the groups they are in themselves ("you can't grant what you don't have"; a student manager may
place students in any grade). Neither an invite preset nor a later roster edit lets an account
the manager controls into @faculty, so the faculty-only pages stay unreadable to them."""

import uuid
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.deps import get_current_user
from app.modules.groups.models import UserGroup, UserGroupMember
from app.modules.lab.models import LabProfile
from app.modules.users.models import User
from tests.helpers import make_user
from tests.wiki_helpers import create_page, set_access

API = "/api/v1"
Actor = Callable[[User], None]


def _accept(username: str) -> dict[str, Any]:
    return {
        "username": username,
        "display_name": username,
        "password": "correct horse battery",
        "device": {"platform": "desktop"},
    }


async def _put_line(client: AsyncClient, user_id: uuid.UUID, line: dict[str, Any]) -> Any:
    return await client.put(f"{API}/lab/roster/{user_id}", json=line)


async def _group_members(db: AsyncSession, key: str) -> set[uuid.UUID]:
    rows = await db.execute(
        select(UserGroupMember.user_id)
        .join(UserGroup, UserGroup.id == UserGroupMember.group_id)
        .where(UserGroup.managed_key == key)
    )
    return set(rows.scalars().all())


async def _setup(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> tuple[User, User, User, dict[str, Any]]:
    """An admin, a professor and a D1 manager on the roster; a page shared with @faculty only."""
    admin = await make_user(db, "admin", role="admin")
    professor = await make_user(db, "prof")
    manager = await make_user(db, "manager", role="manager")
    as_user(admin)
    for person, line in (
        (professor, {"affiliation": "faculty", "rank": "professor"}),
        (manager, {"affiliation": "student", "grade": "D1"}),
    ):
        assert (await _put_line(client, person.id, line)).status_code == 200
    faculty = await db.scalar(select(UserGroup.id).where(UserGroup.managed_key == "faculty"))
    assert faculty is not None
    page = await create_page(client, title="教員会議メモ", body="FACULTY-ONLY", access_="private")
    await set_access(
        client, page["id"], [("user", str(admin.id), "full"), ("group", str(faculty), "view")]
    )
    as_user(professor)
    assert (await client.get(f"{API}/wiki/pages/{page['id']}")).status_code == 200
    return admin, professor, manager, page


async def test_a_manager_cannot_reach_faculty_pages_through_an_account_they_control(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    _, professor, manager, page = await _setup(client, db, as_user)
    as_user(manager)
    assert (await client.get(f"{API}/wiki/pages/{page['id']}")).status_code == 404
    own = await _put_line(client, manager.id, {"affiliation": "faculty"})
    assert own.status_code == 409 and own.json()["error"]["code"] == "cannot_modify_self"

    # The invite preset: refused (and nothing is created).
    for role in ("member", "guest"):
        preset = await client.post(
            f"{API}/admin/invites",
            json={"role": role, "lab": {"affiliation": "faculty", "rank": "lecturer"}},
        )
        assert preset.status_code == 403, preset.text
        error = preset.json()["error"]
        assert error["code"] == "roster_group_not_held"
        assert error["details"] == {"groups": ["faculty"]}
    assert (await client.get(f"{API}/admin/invites")).json() == []

    # A plain invite the manager accepts themselves, then a roster edit of that account: refused.
    created = await client.post(f"{API}/admin/invites", json={"role": "member"})
    assert created.status_code == 201, created.text
    app.dependency_overrides.pop(get_current_user, None)
    accepted = await client.post(
        f"{API}/invites/{created.json()['token']}/accept", json=_accept("sock")
    )
    assert accepted.status_code == 201, accepted.text
    sock_id = uuid.UUID(accepted.json()["user"]["id"])
    bearer = {"Authorization": f"Bearer {accepted.json()['access_token']}"}
    as_user(manager)
    for line in (
        {"affiliation": "faculty"},
        {"affiliation": "faculty", "rank": "professor", "reading": "そっく"},
        {"affiliation": "alumni"},
    ):
        refused = await _put_line(client, sock_id, line)
        assert refused.status_code == 403, refused.text
        assert refused.json()["error"]["code"] == "roster_group_not_held"
    # Nor can the manager take the professor out of @faculty (or off the roster).
    demoted = await _put_line(client, professor.id, {"affiliation": "student", "grade": "M1"})
    assert demoted.status_code == 403
    removed = await client.delete(f"{API}/lab/roster/{professor.id}")
    assert removed.status_code == 403
    assert removed.json()["error"]["code"] == "roster_group_not_held"
    # Changing a faculty line without changing the groups (the reading, the rank) is fine.
    reading = await _put_line(
        client,
        professor.id,
        {"affiliation": "faculty", "rank": "professor", "reading": "きょうじゅ"},
    )
    assert reading.status_code == 200, reading.text

    assert sock_id not in await _group_members(db, "faculty")
    assert professor.id in await _group_members(db, "faculty")
    # The account the manager controls, with its real session: the page stays unreadable.
    app.dependency_overrides.pop(get_current_user, None)
    read = await client.get(f"{API}/wiki/pages/{page['id']}", headers=bearer)
    assert read.status_code == 404
    assert "FACULTY-ONLY" not in read.text


async def test_a_student_manager_still_onboards_students_of_any_grade(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    _, _, manager, _ = await _setup(client, db, as_user)
    as_user(manager)
    created = await client.post(
        f"{API}/admin/invites",
        json={
            "role": "member",
            "max_uses": 2,
            "lab": {"affiliation": "student", "grade": "B4", "times": True},
        },
    )
    assert created.status_code == 201, created.text
    app.dependency_overrides.pop(get_current_user, None)
    accepted = await client.post(
        f"{API}/invites/{created.json()['token']}/accept", json=_accept("newb4")
    )
    assert accepted.status_code == 201, accepted.text
    new_id = uuid.UUID(accepted.json()["user"]["id"])
    assert new_id in await _group_members(db, "b4")
    assert new_id in await _group_members(db, "students")

    as_user(manager)
    for line in (
        {"affiliation": "student", "grade": "M1"},
        {"affiliation": "student", "grade": "D2"},
        {"affiliation": "other"},
    ):
        moved = await _put_line(client, new_id, line)
        assert moved.status_code == 200, moved.text
    assert (await client.delete(f"{API}/lab/roster/{new_id}")).status_code == 204
    # "other" puts nobody in a group: a manager who is not on the roster can still give it.
    other = await client.post(
        f"{API}/admin/invites", json={"role": "guest", "lab": {"affiliation": "other"}}
    )
    assert other.status_code == 201, other.text


async def test_the_issuers_right_is_checked_again_on_acceptance(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    """The manager is no longer a student when the invite is accepted: the account is made
    without the roster line (an administrator sets it), not put in the student groups."""
    admin, _, manager, _ = await _setup(client, db, as_user)
    as_user(manager)
    created = await client.post(
        f"{API}/admin/invites",
        json={"role": "member", "lab": {"affiliation": "student", "grade": "M1"}},
    )
    assert created.status_code == 201, created.text
    as_user(admin)
    assert (await _put_line(client, manager.id, {"affiliation": "other"})).status_code == 200
    app.dependency_overrides.pop(get_current_user, None)
    accepted = await client.post(
        f"{API}/invites/{created.json()['token']}/accept", json=_accept("late")
    )
    assert accepted.status_code == 201, accepted.text
    new_id = uuid.UUID(accepted.json()["user"]["id"])
    assert await db.get(LabProfile, new_id) is None
    assert new_id not in await _group_members(db, "m1")


async def test_an_admin_gives_any_group(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    admin, _, _, page = await _setup(client, db, as_user)
    as_user(admin)
    created = await client.post(
        f"{API}/admin/invites",
        json={"role": "member", "lab": {"affiliation": "faculty", "rank": "lecturer"}},
    )
    assert created.status_code == 201, created.text
    app.dependency_overrides.pop(get_current_user, None)
    accepted = await client.post(
        f"{API}/invites/{created.json()['token']}/accept", json=_accept("lecturer")
    )
    assert accepted.status_code == 201, accepted.text
    bearer = {"Authorization": f"Bearer {accepted.json()['access_token']}"}
    assert (await client.get(f"{API}/wiki/pages/{page['id']}", headers=bearer)).status_code == 200
