"""L7 (M32, LAB.md I): invite links with a lab preset; the yearly rollover, graduation, undo."""

import uuid
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.channels.models import Channel, ChannelMember
from app.modules.groups.models import UserGroup, UserGroupMember
from app.modules.lab.models import LabProfile
from app.modules.users.models import User
from tests.helpers import make_user

ACCEPT = {
    "username": "shinnyu",
    "display_name": "新入",
    "password": "correct horse battery",
    "device": {"platform": "ios", "device_name": "iPhone"},
}


async def _line(client: AsyncClient, user: User, **line: Any) -> None:
    response = await client.put(f"/api/v1/lab/roster/{user.id}", json=line)
    assert response.status_code == 200, response.text


async def _group_members(db: AsyncSession, key: str) -> set[uuid.UUID]:
    group = await db.scalar(select(UserGroup).where(UserGroup.managed_key == key))
    if group is None:
        return set()
    rows = await db.execute(
        select(UserGroupMember.user_id).where(UserGroupMember.group_id == group.id)
    )
    return set(rows.scalars().all())


async def _member_role(db: AsyncSession, channel_id: str, user_id: uuid.UUID) -> str | None:
    return await db.scalar(
        select(ChannelMember.role).where(
            ChannelMember.channel_id == uuid.UUID(channel_id), ChannelMember.user_id == user_id
        )
    )


async def test_invite_with_a_lab_preset(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    prof = await make_user(db, "prof")
    as_user(root)
    await _line(client, prof, affiliation="faculty", rank="professor")
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    student = await make_user(db, "student")
    await _line(client, student, affiliation="student", grade="M1")

    # Only faculty on the roster supervise; a guest gets no times.
    bad = await client.post(
        "/api/v1/admin/invites",
        json={"lab": {"affiliation": "student", "grade": "B4", "supervisor_id": str(student.id)}},
    )
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_supervisor"
    guest_times = await client.post(
        "/api/v1/admin/invites",
        json={"role": "guest", "lab": {"affiliation": "other", "times": True}},
    )
    assert guest_times.status_code == 400
    assert (
        await client.post(
            "/api/v1/admin/invites", json={"lab": {"affiliation": "faculty", "grade": "B4"}}
        )
    ).status_code == 422

    issued = await client.post(
        "/api/v1/admin/invites",
        json={
            "channel_ids": [general["id"]],
            "max_uses": 10,
            "note": "2027 年度 B4",
            "lab": {
                "affiliation": "student",
                "grade": "B4",
                "supervisor_id": str(prof.id),
                "times": True,
            },
        },
    )
    assert issued.status_code == 201, issued.text
    assert issued.json()["invite"]["lab"]["grade"] == "B4"
    token = issued.json()["token"]
    preview = (await client.get(f"/api/v1/invites/{token}")).json()
    assert preview["lab"] == {
        "affiliation": "student",
        "rank": None,
        "grade": "B4",
        "supervisor_name": "Prof",
        "times": True,
    }

    accepted = await client.post(f"/api/v1/invites/{token}/accept", json=ACCEPT)
    assert accepted.status_code == 201, accepted.text
    new_id = uuid.UUID(accepted.json()["user"]["id"])
    line = await db.scalar(select(LabProfile).where(LabProfile.user_id == new_id))
    assert line is not None and (line.affiliation, line.grade, line.supervisor_id) == (
        "student",
        "B4",
        prof.id,
    )
    assert new_id in await _group_members(db, "b4") and new_id in await _group_members(
        db, "students"
    )
    times = await db.scalar(select(Channel).where(Channel.times_owner_id == new_id))
    assert times is not None and times.name == "times-shinnyu"
    assert await _member_role(db, str(times.id), new_id) == "owner"
    assert await _member_role(db, str(times.id), prof.id) == "member"  # the supervisor follows it
    assert await _member_role(db, general["id"], new_id) == "member"


async def test_rollover_graduation_and_undo(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    prof = await make_user(db, "prof")
    b4 = await make_user(db, "bfour")
    m2 = await make_user(db, "mtwo")
    d3 = await make_user(db, "dthree")
    m1 = await make_user(db, "mone")
    prof_id, b4_id, m2_id, d3_id, m1_id = (u.id for u in (prof, b4, m2, d3, m1))
    as_user(root)
    await _line(client, prof, affiliation="faculty", rank="professor")
    for user, grade in ((b4, "B4"), (m2, "M2"), (d3, "D3"), (m1, "M1")):
        await _line(client, user, affiliation="student", grade=grade, supervisor_id=str(prof_id))
    lab = (await client.post("/api/v1/channels", json={"name": "lab"})).json()
    paper = (
        await client.post("/api/v1/channels", json={"name": "paper", "type": "private"})
    ).json()
    alumni = (await client.post("/api/v1/channels", json={"name": "alumni"})).json()
    for user in (b4, m2, d3, m1):
        await client.post(f"/api/v1/channels/{lab['id']}/members", json={"user_id": str(user.id)})
    await client.post(f"/api/v1/channels/{paper['id']}/members", json={"user_id": str(m2_id)})
    await client.patch(f"/api/v1/channels/{paper['id']}/members/{m2_id}", json={"role": "owner"})
    as_user(m2)
    times = (await client.post("/api/v1/times")).json()
    as_user(root)

    preview = await client.post("/api/v1/lab/rollover/preview", json={"academic_year": 2026})
    assert preview.status_code == 200, preview.text
    proposals = {
        i["user_id"]: (i["grade"], i["action"], i["next_grade"]) for i in preview.json()["items"]
    }
    assert proposals == {
        str(d3_id): ("D3", "graduate", None),
        str(m2_id): ("M2", "graduate", "D1"),
        str(m1_id): ("M1", "advance", "M2"),
        str(b4_id): ("B4", "advance", "M1"),
    }
    m2_row = next(i for i in preview.json()["items"] if i["user_id"] == str(m2_id))
    assert m2_row["times_channel_id"] == times["id"]
    assert {c["name"] for c in m2_row["channels"]} == {"lab", "paper"}  # not their own times

    body = {
        "academic_year": 2026,
        "alumni_channel_id": alumni["id"],
        "items": [
            {"user_id": str(b4_id), "action": "advance"},
            {"user_id": str(m1_id), "action": "stay"},
            {
                "user_id": str(m2_id),
                "action": "graduate",
                "guest": True,
                "keep_channel_ids": [paper["id"]],
            },
            {"user_id": str(d3_id), "action": "graduate"},
        ],
    }
    bad = await client.post(
        "/api/v1/lab/rollovers",
        json={**body, "items": [{"user_id": str(prof_id), "action": "advance"}]},
    )
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "rollover_not_student"
    applied = await client.post("/api/v1/lab/rollovers", json=body)
    assert applied.status_code == 200, applied.text
    assert (applied.json()["advanced"], applied.json()["stayed"], applied.json()["graduated"]) == (
        1,
        1,
        2,
    )
    lines = {
        r.user_id: r
        for r in (await db.execute(select(LabProfile).execution_options(populate_existing=True)))
        .scalars()
        .all()
    }
    assert lines[b4_id].grade == "M1" and lines[m1_id].grade == "M1"
    assert (lines[m2_id].affiliation, lines[m2_id].grade) == ("alumni", None)
    assert {m2_id, d3_id} <= await _group_members(db, "alumni")
    assert m2_id not in await _group_members(db, "m2") and b4_id in await _group_members(db, "m1")
    assert await db.scalar(select(User.role).where(User.id == m2_id)) == "guest"
    assert await db.scalar(select(User.role).where(User.id == d3_id)) == "member"
    # Out of the lab's channels, in the kept one and #alumni; their own times archived but theirs.
    assert await _member_role(db, lab["id"], m2_id) is None
    assert await _member_role(db, paper["id"], m2_id) == "owner"
    assert await _member_role(db, alumni["id"], m2_id) == "member"
    assert await _member_role(db, times["id"], m2_id) == "owner"
    assert (
        await db.scalar(select(Channel.archived_at).where(Channel.id == uuid.UUID(times["id"])))
        is not None
    )
    assert (
        await _member_role(db, lab["id"], d3_id) is None
        and await _member_role(db, lab["id"], b4_id) == "member"
    )

    again = await client.post("/api/v1/lab/rollovers", json=body)
    assert again.status_code == 409 and again.json()["error"]["code"] == "rollover_applied"
    assert (await client.post("/api/v1/lab/rollover/preview", json={"academic_year": 2026})).json()[
        "applied_at"
    ]

    undone = await client.post("/api/v1/lab/rollovers/2026/undo")
    assert undone.status_code == 200 and undone.json()["undone_at"] is not None
    lines = {
        r.user_id: r
        for r in (await db.execute(select(LabProfile).execution_options(populate_existing=True)))
        .scalars()
        .all()
    }
    assert [lines[u].grade for u in (b4_id, m1_id, m2_id, d3_id)] == ["B4", "M1", "M2", "D3"]
    assert lines[m2_id].affiliation == "student" and lines[m2_id].supervisor_id == prof_id
    assert await db.scalar(select(User.role).where(User.id == m2_id)) == "member"
    assert await _member_role(db, lab["id"], m2_id) == "member"
    assert await _member_role(db, alumni["id"], m2_id) is None
    assert (
        await db.scalar(select(Channel.archived_at).where(Channel.id == uuid.UUID(times["id"])))
        is None
    )
    assert m2_id in await _group_members(db, "m2") and m2_id not in await _group_members(
        db, "alumni"
    )
    assert (await client.post("/api/v1/lab/rollovers/2026/undo")).status_code == 409
    history = (await client.get("/api/v1/lab/rollovers")).json()
    assert [(h["academic_year"], h["undone_at"] is not None) for h in history] == [(2026, True)]
    # Undone: the year can be applied again.
    assert (await client.post("/api/v1/lab/rollovers", json=body)).status_code == 200

    as_user(m1)
    assert (
        await client.post("/api/v1/lab/rollover/preview", json={"academic_year": 2026})
    ).status_code == 403


async def test_graduates_stay_in_the_common_channels(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """The OB/OG and all-hands channels: every graduate joins and stays; the rest are left."""
    root = await make_user(db, "root", role="admin")
    grad = await make_user(db, "grad")
    grad_id = grad.id
    as_user(root)
    await _line(client, grad, affiliation="student", grade="M2")
    lab = (await client.post("/api/v1/channels", json={"name": "lab"})).json()
    obog = (await client.post("/api/v1/channels", json={"name": "obog"})).json()
    everyone = (await client.post("/api/v1/channels", json={"name": "zentai"})).json()
    for channel in (lab, everyone):
        await client.post(
            f"/api/v1/channels/{channel['id']}/members", json={"user_id": str(grad_id)}
        )
    body = {
        "academic_year": 2027,
        "stay_channel_ids": [obog["id"], everyone["id"]],
        "items": [{"user_id": str(grad_id), "action": "graduate", "guest": True}],
    }
    applied = await client.post("/api/v1/lab/rollovers", json=body)
    assert applied.status_code == 200, applied.text
    assert await _member_role(db, lab["id"], grad_id) is None
    assert await _member_role(db, obog["id"], grad_id) == "member"
    assert await _member_role(db, everyone["id"], grad_id) == "member"
    assert (await client.post("/api/v1/lab/rollovers/2027/undo")).status_code == 200
    # Back in the lab; out of the OB/OG channel it joined; still in the all-hands one it was in.
    assert await _member_role(db, lab["id"], grad_id) == "member"
    assert await _member_role(db, obog["id"], grad_id) is None
    assert await _member_role(db, everyone["id"], grad_id) == "member"
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(grad_id)]})).json()
    bad = await client.post("/api/v1/lab/rollovers", json={**body, "stay_channel_ids": [dm["id"]]})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_alumni_channel"
