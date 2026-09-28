"""times channels and quiet unread (M24, DATA_MODEL.md channels, SYNC_PROTOCOL.md §10.5)."""

import json
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.reads import rules
from app.modules.users.models import User
from tests.helpers import make_user

VECTORS = Path(__file__).resolve().parents[2] / "apps" / "shared" / "unread-rules.json"


@pytest.mark.parametrize(
    "case", json.loads(VECTORS.read_text())["cases"], ids=lambda case: case["name"]
)
def test_unread_rules_follow_the_shared_vectors(case: dict[str, Any]) -> None:
    conversation = rules.Conversation(
        is_dm=case["type"] in ("dm", "group_dm"),
        others_times=case["times"] == "others",
        level=case["level"],
        muted=case["muted"],
        unread=case["unread"],
        mentions=case["mentions"],
    )
    assert rules.has_unread(conversation) == case["expect"]["has_unread"]
    assert rules.badge(conversation) == case["expect"]["badge"]
    assert rules.is_quiet(conversation) == case["expect"]["quiet"]


async def _post(client: AsyncClient, channel_id: str, body: str) -> None:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body},
    )
    assert response.status_code == 201, response.text


async def _member_ids(client: AsyncClient, channel_id: str) -> set[str]:
    return {
        m["user_id"] for m in (await client.get(f"/api/v1/channels/{channel_id}/members")).json()
    }


async def test_times_is_made_once_and_supervisors_follow_it(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    prof = await make_user(db, "prof")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(root)
    await client.put(f"/api/v1/lab/roster/{prof.id}", json={"affiliation": "faculty"})
    await client.put(
        f"/api/v1/lab/roster/{alice.id}",
        json={"affiliation": "student", "grade": "M1", "supervisor_id": str(prof.id)},
    )
    await client.post("/api/v1/channels", json={"name": "times-carol"})  # the name is taken

    as_user(alice)
    made = await client.post("/api/v1/times")
    assert made.status_code == 201, made.text
    times = made.json()
    assert times["name"] == "times-alice" and times["type"] == "public"
    assert times["times_owner_id"] == str(alice.id) and times["membership"]["role"] == "owner"
    assert await _member_ids(client, times["id"]) == {str(alice.id), str(prof.id)}
    again = await client.post("/api/v1/times")
    assert again.status_code == 200 and again.json()["id"] == times["id"]
    # Having left it, asking again brings me back in as its owner.
    assert (await client.post(f"/api/v1/channels/{times['id']}/leave")).status_code == 204
    back = await client.post("/api/v1/times")
    assert back.status_code == 200 and back.json()["membership"]["role"] == "owner"

    # A supervisor assigned later joins the student's times too.
    as_user(bob)
    bobs = (await client.post("/api/v1/times")).json()
    assert await _member_ids(client, bobs["id"]) == {str(bob.id)}
    as_user(root)
    await client.put(
        f"/api/v1/lab/roster/{bob.id}",
        json={"affiliation": "student", "grade": "B4", "supervisor_id": str(prof.id)},
    )
    as_user(bob)
    assert str(prof.id) in await _member_ids(client, bobs["id"])

    as_user(carol)
    assert (await client.post("/api/v1/times")).json()["name"] == "times-carol-2"


async def test_an_administrator_marks_an_existing_channel_as_someones_times(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    guest = await make_user(db, "guest", role="guest")
    as_user(root)
    imported = (await client.post("/api/v1/channels", json={"name": "times_alice"})).json()
    other = (await client.post("/api/v1/channels", json={"name": "random"})).json()

    marked = await client.patch(
        f"/api/v1/channels/{imported['id']}", json={"times_owner_id": str(alice.id)}
    )
    assert marked.status_code == 200 and marked.json()["times_owner_id"] == str(alice.id)
    members = (await client.get(f"/api/v1/channels/{imported['id']}/members")).json()
    assert {m["user_id"]: m["role"] for m in members}[str(alice.id)] == "owner"
    twice = await client.patch(
        f"/api/v1/channels/{other['id']}", json={"times_owner_id": str(alice.id)}
    )
    assert twice.status_code == 409 and twice.json()["error"]["code"] == "times_exists"
    for_guest = await client.patch(
        f"/api/v1/channels/{other['id']}", json={"times_owner_id": str(guest.id)}
    )
    assert for_guest.status_code == 403

    # Her own times is now that channel; as its owner she may make it threads only, not unmark it.
    as_user(alice)
    assert (await client.post("/api/v1/times")).json()["id"] == imported["id"]
    threads_only = await client.patch(
        f"/api/v1/channels/{imported['id']}", json={"posting_policy": "owners"}
    )
    assert threads_only.status_code == 200
    unmark = await client.patch(f"/api/v1/channels/{imported['id']}", json={"times_owner_id": None})
    assert unmark.status_code == 403
    as_user(guest)
    assert (await client.post("/api/v1/times")).status_code == 403

    as_user(root)
    cleared = await client.patch(
        f"/api/v1/channels/{imported['id']}", json={"times_owner_id": None}
    )
    assert cleared.status_code == 200 and cleared.json()["times_owner_id"] is None


async def test_someone_elses_times_is_quiet_unread_in_the_summary(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(bob)
    times = (await client.post("/api/v1/times")).json()
    as_user(alice)
    await client.post(f"/api/v1/channels/{times['id']}/join")

    as_user(bob)
    await _post(client, times["id"], "今日は実験の準備")
    await _post(client, times["id"], "結果が出た")
    as_user(alice)
    summary = await client.get("/api/v1/sync/summary")
    assert summary.json() == {"badge": 0, "has_unread": False}  # quiet: no mention, not unread

    as_user(bob)
    await _post(client, times["id"], f"<@{alice.id}> 見てほしい")
    as_user(alice)
    assert (await client.get("/api/v1/sync/summary")).json() == {"badge": 1, "has_unread": True}
    await client.put(f"/api/v1/channels/{times['id']}/read", json={"last_read_seq": 100})
    as_user(bob)
    await _post(client, times["id"], "続き")
    as_user(alice)
    await client.put(
        f"/api/v1/channels/{times['id']}/notification-preference", json={"level": "all"}
    )
    # At level all it is an ordinary channel again: unread without a mention.
    assert (await client.get("/api/v1/sync/summary")).json() == {"badge": 0, "has_unread": True}

    # The owner reads their own times as any channel.
    as_user(alice)
    await _post(client, times["id"], "がんばって")
    as_user(bob)
    assert (await client.get("/api/v1/sync/summary")).json()["has_unread"] is True
