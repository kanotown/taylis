"""Message priority and acknowledgements (M15e)."""

import uuid
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import build_settings
from app.events.models import OutboxEvent
from app.modules.channels import service as channels
from app.modules.channels.schemas import ChannelCreate
from app.modules.notifications.planner import PushPlanner
from app.modules.users.models import User
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> Any:
    payload = {"client_msg_id": str(uuid.uuid4()), "body": body, **extra}
    return await client.post(f"/api/v1/channels/{channel_id}/messages", json=payload)


async def test_priority_and_acknowledgements(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    cid = (await client.post("/api/v1/channels", json={"name": "ops"})).json()["id"]
    for user in (bob, carol):
        await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(user.id)})

    urgent = await _post(
        client, cid, "本番 DB を 18 時に止めます", priority="urgent", ack_requested=True
    )
    assert urgent.status_code == 201
    message = urgent.json()
    assert (message["priority"], message["ack_requested"], message["acks"]) == ("urgent", True, [])
    plain = (await _post(client, cid, "ふつうの投稿")).json()
    assert (plain["priority"], plain["ack_requested"]) == (None, False)

    # Only top-level posts carry them; unknown priorities are rejected.
    reply = await _post(client, cid, "x", parent_id=message["id"], priority="important")
    assert reply.status_code == 422
    assert (await _post(client, cid, "x", priority="critical")).status_code == 422

    # Readers acknowledge (idempotently) and can take it back; the author cannot.
    as_user(bob)
    acked = await client.put(f"/api/v1/messages/{message['id']}/ack")
    assert acked.status_code == 200 and [a["user_id"] for a in acked.json()["acks"]] == [
        str(bob.id)
    ]
    again = await client.put(f"/api/v1/messages/{message['id']}/ack")
    assert len(again.json()["acks"]) == 1
    as_user(carol)
    both = (await client.put(f"/api/v1/messages/{message['id']}/ack")).json()
    assert [a["user_id"] for a in both["acks"]] == [str(bob.id), str(carol.id)]
    undone = (await client.delete(f"/api/v1/messages/{message['id']}/ack")).json()
    assert [a["user_id"] for a in undone["acks"]] == [str(bob.id)]
    as_user(alice)
    own = await client.put(f"/api/v1/messages/{message['id']}/ack")
    assert own.status_code == 400 and own.json()["error"]["code"] == "ack_own_message"
    as_user(bob)
    none = await client.put(f"/api/v1/messages/{plain['id']}/ack")
    assert none.status_code == 409 and none.json()["error"]["code"] == "ack_not_requested"

    # History carries the acknowledgements; each change was announced as message.updated (ack).
    history = (await client.get(f"/api/v1/channels/{cid}/messages")).json()["messages"]
    shown = next(m for m in history if m["id"] == message["id"])
    assert [a["user_id"] for a in shown["acks"]] == [str(bob.id)]
    rows = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "message.updated")
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    assert [r.payload["change"] for r in rows] == ["ack", "ack", "ack"]


async def test_push_text_names_the_priority(db: AsyncSession) -> None:
    alice = await make_user(db, "alice")
    channel = await channels.create_channel(db, alice, ChannelCreate(name="ops"))
    planner = PushPlanner(build_settings(), lambda _: False)
    row = await channels.require_channel(db, channel.id)
    message: dict[str, object] = {"id": str(uuid.uuid4()), "body": "止めます", "priority": "urgent"}
    payload = planner.build_payload(row, alice, message, 1)
    assert payload.body.startswith("[緊急] ")
    plain = planner.build_payload(row, alice, {**message, "priority": None}, 1)
    assert not plain.body.startswith("[")
