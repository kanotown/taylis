"""L4 (M31, LAB.md H / J): who has not acknowledged and reminding them, channel owners, making a
channel public only as a member, and hiding one's presence."""

import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.reminders.models import Reminder
from app.modules.users.models import User
from app.realtime.hub import RealtimeHub
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> Any:
    payload = {"client_msg_id": str(uuid.uuid4()), "body": body, **extra}
    return await client.post(f"/api/v1/channels/{channel_id}/messages", json=payload)


async def _channel(client: AsyncClient, name: str, members: list[User], **extra: Any) -> str:
    cid = str((await client.post("/api/v1/channels", json={"name": name, **extra})).json()["id"])
    for user in members:
        added = await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(user.id)})
        assert added.status_code == 200, added.text
    return cid


async def test_unacknowledged_members_and_reminding_them(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    dave = await make_user(db, "dave")
    bot = await make_user(db, "robot", role="bot")
    admin = await make_user(db, "root", role="admin")
    as_user(alice)
    cid = await _channel(client, "ops", [bob, carol, dave, bot])
    dave.deactivated_at = utcnow()
    await db.commit()
    message = (await _post(client, cid, "18 時に止めます", ack_requested=True)).json()
    plain = (await _post(client, cid, "ふつうの投稿")).json()

    as_user(bob)
    assert (await client.put(f"/api/v1/messages/{message['id']}/ack")).status_code == 200
    pending = await client.get(f"/api/v1/messages/{message['id']}/ack/pending")
    # Not the author, the bot, the deactivated member, nor bob who has acknowledged.
    assert pending.status_code == 200 and pending.json() == {"user_ids": [str(carol.id)]}
    assert (await client.get(f"/api/v1/messages/{plain['id']}/ack/pending")).status_code == 409
    # Only the author or an administrator reminds.
    denied = await client.post(f"/api/v1/messages/{message['id']}/ack/remind")
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "ack_remind_forbidden"

    as_user(admin)  # not a member: cannot see the message at all
    assert (await client.get(f"/api/v1/messages/{message['id']}/ack/pending")).status_code == 403

    as_user(alice)
    reminded = await client.post(f"/api/v1/messages/{message['id']}/ack/remind")
    assert reminded.status_code == 200 and reminded.json() == {"reminded": 1}
    rows = (
        (await db.execute(select(Reminder).where(Reminder.message_id == uuid.UUID(message["id"]))))
        .scalars()
        .all()
    )
    assert [(r.user_id, r.kind, r.status) for r in rows] == [(carol.id, "ack", "fired")]
    assert rows[0].note == "Alice さんから確認のお願い"
    events = (
        (
            await db.execute(
                select(OutboxEvent).where(
                    OutboxEvent.event_type == "reminder.updated",
                    OutboxEvent.audience_id == carol.id,
                )
            )
        )
        .scalars()
        .all()
    )
    assert [e.payload["reminder"]["kind"] for e in events] == ["ack"]
    # Once an hour per message.
    again = await client.post(f"/api/v1/messages/{message['id']}/ack/remind")
    assert again.status_code == 429 and again.json()["error"]["code"] == "ack_remind_too_soon"
    await db.execute(update(Reminder).values(created_at=utcnow() - timedelta(hours=2)))
    await db.commit()
    # Carol's nudge is still open: she is not nudged twice.
    assert (await client.post(f"/api/v1/messages/{message['id']}/ack/remind")).json() == {
        "reminded": 0
    }

    as_user(carol)
    listed = (await client.get("/api/v1/reminders")).json()
    assert [(r["kind"], r["note"]) for r in listed] == [("ack", "Alice さんから確認のお願い")]
    assert (await client.put(f"/api/v1/messages/{message['id']}/ack")).status_code == 200
    # Acknowledged: the request leaves her list.
    assert (await client.get("/api/v1/reminders")).json() == []


async def test_channel_owners(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    guest = await make_user(db, "visitor", role="guest")
    as_user(alice)
    cid = await _channel(client, "announce", [bob, carol, guest])
    url = f"/api/v1/channels/{cid}/members"
    made = await client.patch(f"{url}/{bob.id}", json={"role": "owner"})
    assert made.status_code == 200 and made.json()["role"] == "owner"
    events = (
        (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.event_type == "channel.member_updated")
            )
        )
        .scalars()
        .all()
    )
    assert [(e.audience_type, e.payload["user_id"], e.payload["role"]) for e in events] == [
        ("channel", str(bob.id), "owner")
    ]
    guest_owner = await client.patch(f"{url}/{guest.id}", json={"role": "owner"})
    assert (
        guest_owner.status_code == 403
        and guest_owner.json()["error"]["code"] == "owner_not_allowed"
    )
    assert (await client.patch(f"{url}/{uuid.uuid4()}", json={"role": "owner"})).status_code == 404
    assert (await client.patch(f"{url}/{bob.id}", json={"role": "admin"})).status_code == 422

    as_user(carol)  # a member manages nothing
    assert (await client.patch(f"{url}/{carol.id}", json={"role": "owner"})).status_code == 403

    as_user(bob)  # a new owner may step the old one down, but the last owner stays
    assert (await client.patch(f"{url}/{alice.id}", json={"role": "member"})).status_code == 200
    last = await client.patch(f"{url}/{bob.id}", json={"role": "member"})
    assert last.status_code == 409 and last.json()["error"]["code"] == "last_owner"
    members = {m["user_id"]: m["role"] for m in (await client.get(url)).json()}
    assert members[str(alice.id)] == "member" and members[str(bob.id)] == "owner"

    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(carol.id)]})).json()
    # A DM has no owners, so nobody manages its members.
    assert (
        await client.patch(
            f"/api/v1/channels/{dm['id']}/members/{carol.id}", json={"role": "owner"}
        )
    ).status_code == 403


async def test_only_a_member_admin_makes_a_channel_public(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    student = await make_user(db, "student")
    staff = await make_user(db, "staff", role="admin")
    teacher = await make_user(db, "teacher", role="admin")
    as_user(student)
    cid = await _channel(client, "students", [teacher], type="private")
    as_user(staff)  # an administrator outside the channel
    refused = await client.patch(f"/api/v1/channels/{cid}", json={"type": "public"})
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "admin_not_member"
    as_user(teacher)  # a member who is an administrator
    converted = await client.patch(f"/api/v1/channels/{cid}", json={"type": "public"})
    assert converted.status_code == 200 and converted.json()["type"] == "public"
    as_user(staff)  # public → private stays open to any owner or administrator
    assert (
        await client.patch(f"/api/v1/channels/{cid}", json={"type": "private"})
    ).status_code == 200


async def test_presence_hidden_setting(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], app: Any
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    hub: RealtimeHub = app.state.hub
    hub.new_connection(alice.id, uuid.uuid4())
    assert hub.presence_status(alice.id) == "online"
    hidden = await client.patch("/api/v1/users/me", json={"presence_hidden": True})
    assert hidden.status_code == 200 and hidden.json()["presence_hidden"] is True
    assert hub.presence_status(alice.id) == "offline"
    stored = await db.scalar(select(User.presence_hidden).where(User.id == alice.id))
    assert stored is True
    shown = await client.patch("/api/v1/users/me", json={"presence_hidden": False})
    assert shown.json()["presence_hidden"] is False and hub.presence_status(alice.id) == "online"


def test_hub_hides_presence() -> None:
    hub = RealtimeHub()
    hidden_user, watcher = uuid.uuid4(), uuid.uuid4()
    seen = hub.new_connection(watcher, uuid.uuid4())
    hub.new_connection(hidden_user, uuid.uuid4(), presence_hidden=True)
    assert hub.presence_status(hidden_user) == "offline"
    assert hidden_user not in [user_id for user_id, _ in hub.presence_snapshot()]
    frames = []
    while not seen.queue.empty():
        frames.append(seen.queue.get_nowait())
    assert not any(
        f.get("user_id") == str(hidden_user) for f in frames if f.get("type") == "presence"
    )
    hub.set_presence_hidden(hidden_user, False)
    announced = [seen.queue.get_nowait() for _ in range(seen.queue.qsize())]
    assert {"type": "presence", "user_id": str(hidden_user), "status": "online"} in announced
    hub.set_presence_hidden(hidden_user, True)
    announced = [seen.queue.get_nowait() for _ in range(seen.queue.qsize())]
    assert {"type": "presence", "user_id": str(hidden_user), "status": "offline"} in announced
