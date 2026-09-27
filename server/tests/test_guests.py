"""Guest accounts (M13e): only their channels and the people in them."""

import uuid
from collections.abc import Callable

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user


async def test_guests_are_confined_to_their_channels(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    stranger = await make_user(db, "stranger")
    guest = await make_user(db, "guest", role="guest")

    as_user(root)
    public = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    project = (
        await client.post("/api/v1/channels", json={"name": "project-x", "type": "private"})
    ).json()
    for user in (alice, guest):
        await client.post(
            f"/api/v1/channels/{project['id']}/members", json={"user_id": str(user.id)}
        )

    as_user(guest)
    # No creating, browsing or joining.
    created = await client.post("/api/v1/channels", json={"name": "mine"})
    assert created.status_code == 403 and created.json()["error"]["code"] == "guest_restricted"
    listed = await client.get("/api/v1/channels", params={"include": "public"})
    assert [c["name"] for c in listed.json()] == ["project-x"]
    joined = await client.post(f"/api/v1/channels/{public['id']}/join")
    assert joined.status_code == 403
    added = await client.post(
        f"/api/v1/channels/{project['id']}/members", json={"user_id": str(stranger.id)}
    )
    assert added.status_code == 403
    # Only the people in shared channels are visible, and only they can be messaged.
    people = await client.get("/api/v1/users")
    assert {u["username"] for u in people.json()} == {"root", "alice", "guest"}
    booted = await client.get("/api/v1/sync/bootstrap")
    assert {u["username"] for u in booted.json()["users"]} == {"root", "alice", "guest"}
    assert booted.json()["me"]["role"] == "guest"
    blocked = await client.post("/api/v1/dms", json={"user_ids": [str(stranger.id)]})
    assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "guest_restricted"
    dm = await client.post("/api/v1/dms", json={"user_ids": [str(alice.id)]})
    assert dm.status_code in (200, 201), dm.text
    # Posting in their channel works as for anyone.
    posted = await client.post(
        f"/api/v1/channels/{project['id']}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "こんにちは"},
    )
    assert posted.status_code == 201
    emoji = await client.post(
        "/api/v1/emoji", files={"file": ("x.png", b"", "image/png")}, data={"name": "nope"}
    )
    assert emoji.status_code == 403

    # Members can still message the guest, and an administrator can promote them.
    as_user(stranger)
    reverse = await client.post("/api/v1/dms", json={"user_ids": [str(guest.id)]})
    assert reverse.status_code in (200, 201)
    as_user(root)
    promoted = await client.patch(f"/api/v1/admin/users/{guest.id}", json={"role": "member"})
    assert promoted.status_code == 200 and promoted.json()["role"] == "member"
    invited = await client.post("/api/v1/admin/invites", json={"role": "guest"})
    assert invited.status_code == 201 and invited.json()["invite"]["role"] == "guest"


async def test_public_channel_creation_is_not_announced_to_guests(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    from sqlalchemy import select

    from app.events.models import OutboxEvent
    from app.modules.channels.service import resolve_event_audience

    root = await make_user(db, "root", role="admin")
    member = await make_user(db, "member")
    guest = await make_user(db, "guest", role="guest")
    as_user(root)
    await client.post("/api/v1/channels", json={"name": "town-square"})
    row = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "channel.created")
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .first()
    )
    assert row is not None and row.audience_type == "all"
    audience = await resolve_event_audience(db, row)
    assert audience.kind == "users"
    assert set(audience.ids) == {root.id, member.id}
    assert guest.id not in audience.ids
