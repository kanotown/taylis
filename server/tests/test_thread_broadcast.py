"""Thread replies also sent to the channel (M15c)."""

import uuid
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> Any:
    payload = {"client_msg_id": str(uuid.uuid4()), "body": body, **extra}
    return await client.post(f"/api/v1/channels/{channel_id}/messages", json=payload)


async def _unread(client: AsyncClient, channel_id: str) -> int:
    boot = (await client.get("/api/v1/sync/bootstrap")).json()
    state = next(c for c in boot["channels"] if c["id"] == channel_id)["read_state"]
    return int(state["unread_count"])


async def test_reply_also_sent_to_the_channel(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = (await client.post("/api/v1/channels", json={"name": "general"})).json()["id"]
    as_user(bob)
    await client.post(f"/api/v1/channels/{cid}/join")

    as_user(alice)
    parent = (await _post(client, cid, "リリース日を決めましょう")).json()
    as_user(bob)
    await client.put(f"/api/v1/channels/{cid}/read", json={"last_read_seq": parent["seq"]})
    as_user(alice)
    quiet = (await _post(client, cid, "候補は金曜", parent_id=parent["id"])).json()
    key = str(uuid.uuid4())
    loud = await client.post(
        f"/api/v1/channels/{cid}/messages",
        json={
            "client_msg_id": key,
            "body": "金曜に決定",
            "parent_id": parent["id"],
            "also_in_channel": True,
        },
    )
    assert loud.status_code == 201
    shared = loud.json()
    assert shared["also_in_channel"] is True and shared["parent_id"] == parent["id"]
    assert quiet["also_in_channel"] is False

    # A retry returns the same message (idempotency is unchanged).
    retry = await client.post(
        f"/api/v1/channels/{cid}/messages",
        json={
            "client_msg_id": key,
            "body": "金曜に決定",
            "parent_id": parent["id"],
            "also_in_channel": True,
        },
    )
    assert retry.status_code == 200 and retry.json()["id"] == shared["id"]

    # The channel timeline shows the parent and the shared reply, not the plain one.
    history = (await client.get(f"/api/v1/channels/{cid}/messages")).json()["messages"]
    assert [m["id"] for m in history] == [shared["id"], parent["id"]]
    # The thread still has both replies.
    replies = (await client.get(f"/api/v1/messages/{parent['id']}/replies")).json()
    assert [m["id"] for m in replies] == [quiet["id"], shared["id"]]
    # The permalink context around the parent includes it too.
    context = (await client.get(f"/api/v1/messages/{parent['id']}/context")).json()
    assert shared["id"] in [m["id"] for m in context]

    # Only the shared reply counts as unread in the channel.
    as_user(bob)
    assert await _unread(client, cid) == 1

    # The event carries the flag so that clients can place the reply in both views.
    row = (
        await db.execute(
            select(OutboxEvent).where(
                OutboxEvent.event_type == "message.created", OutboxEvent.seq == shared["seq"]
            )
        )
    ).scalar_one()
    assert row.payload["message"]["also_in_channel"] is True
    assert row.payload["parent_thread"]["id"] == parent["id"]


async def test_also_in_channel_rules(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    owner = await make_user(db, "owner")
    member = await make_user(db, "member")
    as_user(owner)
    cid = (await client.post("/api/v1/channels", json={"name": "news"})).json()["id"]
    await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(member.id)})
    parent = (await _post(client, cid, "お知らせ")).json()

    # Only a reply can be sent to the channel as well.
    top = await _post(client, cid, "x", also_in_channel=True)
    assert top.status_code == 422

    # In an announcement channel (M15a) the reply stays in the thread for ordinary members.
    await client.patch(f"/api/v1/channels/{cid}", json={"posting_policy": "owners"})
    as_user(member)
    assert (await _post(client, cid, "質問", parent_id=parent["id"])).status_code == 201
    blocked = await _post(client, cid, "全員へ", parent_id=parent["id"], also_in_channel=True)
    assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "posting_restricted"
    as_user(owner)
    assert (
        await _post(client, cid, "補足", parent_id=parent["id"], also_in_channel=True)
    ).status_code == 201
