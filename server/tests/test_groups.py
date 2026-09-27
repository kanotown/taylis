"""User groups and @group mentions (M12k)."""

import uuid
from collections.abc import Callable

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.messages.mentions import extract_group_mentions, notification_text
from app.modules.users.models import User
from tests.helpers import make_user


def test_group_tokens_are_parsed_and_named() -> None:
    gid = uuid.UUID("01a0df3f-14b2-7d1a-8759-53c8a8d8a198")
    body = f"<@group:{gid}> 明日のレビューお願いします <@group:{gid}>"
    assert extract_group_mentions(body) == [gid]
    assert extract_group_mentions("<@group:not-a-uuid>") == []
    assert notification_text(body, {gid: "design"}) == "@design 明日のレビューお願いします @design"
    assert notification_text(body, {}) == "@メンバー 明日のレビューお願いします @メンバー"


async def _post(client: AsyncClient, channel_id: str, body: str) -> dict[str, object]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body},
    )
    assert response.status_code == 201, response.text
    data: dict[str, object] = response.json()
    return data


async def test_group_mentions_expand_to_members(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")

    as_user(alice)
    denied = await client.post("/api/v1/admin/groups", json={"name": "design"})
    assert denied.status_code == 403

    as_user(root)
    created = await client.post(
        "/api/v1/admin/groups",
        json={
            "name": "design",
            "description": "デザイン担当",
            "member_ids": [str(alice.id), str(bob.id)],
        },
    )
    assert created.status_code == 201, created.text
    group = created.json()
    assert group["name"] == "design" and set(group["member_ids"]) == {str(alice.id), str(bob.id)}
    reserved = await client.post("/api/v1/admin/groups", json={"name": "channel"})
    assert reserved.status_code == 422
    dup = await client.post("/api/v1/admin/groups", json={"name": "design"})
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "name_taken"
    shadow = await client.post("/api/v1/admin/groups", json={"name": "alice"})
    assert shadow.status_code == 409
    # and the other way round: no user may take a group's name
    user_clash = await client.post(
        "/api/v1/admin/users", json={"username": "design", "display_name": "x"}
    )
    assert user_clash.status_code == 409

    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    for user in (alice, bob, carol):
        await client.post(
            f"/api/v1/channels/{channel['id']}/members", json={"user_id": str(user.id)}
        )

    # Everyone sees the groups (list and bootstrap); the composer needs them.
    as_user(carol)
    listed = await client.get("/api/v1/groups")
    assert listed.status_code == 200 and [g["name"] for g in listed.json()] == ["design"]
    booted = await client.get("/api/v1/sync/bootstrap")
    assert [g["name"] for g in booted.json()["groups"]] == ["design"]

    # A mention of the group counts for its members, not for the sender.
    as_user(alice)
    posted = await _post(client, channel["id"], f"<@group:{group['id']}> レビューお願いします")
    assert posted["mentioned_user_ids"] == [str(bob.id)]
    as_user(bob)
    booted = await client.get("/api/v1/sync/bootstrap")
    mine = next(c for c in booted.json()["channels"] if c["id"] == channel["id"])
    assert mine["read_state"]["mention_count"] == 1
    mentions = await client.get("/api/v1/mentions")
    assert [m["id"] for m in mentions.json()["items"]] == [posted["id"]]
    as_user(carol)
    booted = await client.get("/api/v1/sync/bootstrap")
    mine = next(c for c in booted.json()["channels"] if c["id"] == channel["id"])
    assert mine["read_state"]["mention_count"] == 0

    # Members change; an edit re-expands; a deleted group stops matching.
    as_user(root)
    updated = await client.patch(
        f"/api/v1/admin/groups/{group['id']}",
        json={"member_ids": [str(carol.id)], "description": None},
    )
    assert updated.status_code == 200 and updated.json()["member_ids"] == [str(carol.id)]
    assert updated.json()["description"] is None
    as_user(alice)
    edited = await client.patch(
        f"/api/v1/messages/{posted['id']}", json={"body": f"<@group:{group['id']}> 修正しました"}
    )
    assert edited.status_code == 200 and edited.json()["mentioned_user_ids"] == [str(carol.id)]
    as_user(root)
    gone = await client.delete(f"/api/v1/admin/groups/{group['id']}")
    assert gone.status_code == 204
    assert (await client.get("/api/v1/groups")).json() == []
    assert (await client.delete(f"/api/v1/admin/groups/{group['id']}")).status_code == 404
    as_user(alice)
    orphan = await _post(client, channel["id"], f"<@group:{group['id']}> もういない")
    assert orphan["mentioned_user_ids"] == []


async def test_group_events_reach_everyone(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    from sqlalchemy import select

    from app.events.models import OutboxEvent

    root = await make_user(db, "root", role="admin")
    as_user(root)
    group = (await client.post("/api/v1/admin/groups", json={"name": "ops"})).json()
    await client.delete(f"/api/v1/admin/groups/{group['id']}")
    rows = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "group.updated")
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    assert [r.audience_type for r in rows] == ["all", "all"]
    assert [r.payload["deleted"] for r in rows] == [False, True]
    assert rows[0].payload["group"]["name"] == "ops"
