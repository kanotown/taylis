"""Announcement channels (M15a) and public / private conversion (M15b)."""

import uuid
from collections.abc import Callable
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str, parent: str | None = None) -> Any:
    payload: dict[str, Any] = {"client_msg_id": str(uuid.uuid4()), "body": body}
    if parent:
        payload["parent_id"] = parent
    return await client.post(f"/api/v1/channels/{channel_id}/messages", json=payload)


async def test_announcement_channels(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    owner = await make_user(db, "owner")
    member = await make_user(db, "member")
    root = await make_user(db, "root", role="admin")
    as_user(owner)
    channel = (await client.post("/api/v1/channels", json={"name": "announcements"})).json()
    assert channel["posting_policy"] == "everyone"
    for user in (member, root):
        await client.post(
            f"/api/v1/channels/{channel['id']}/members", json={"user_id": str(user.id)}
        )

    as_user(member)
    denied = await client.patch(
        f"/api/v1/channels/{channel['id']}", json={"posting_policy": "owners"}
    )
    assert denied.status_code == 403
    as_user(owner)
    updated = await client.patch(
        f"/api/v1/channels/{channel['id']}", json={"posting_policy": "owners"}
    )
    assert updated.status_code == 200 and updated.json()["posting_policy"] == "owners"
    bad = await client.patch(f"/api/v1/channels/{channel['id']}", json={"posting_policy": "nobody"})
    assert bad.status_code == 422

    notice = await _post(client, channel["id"], "来週の全体会議は火曜です")
    assert notice.status_code == 201
    as_user(member)
    blocked = await _post(client, channel["id"], "質問です")
    assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "posting_restricted"
    reply = await _post(client, channel["id"], "了解です", parent=notice.json()["id"])
    assert reply.status_code == 201  # thread replies stay open
    reaction = await client.put(f"/api/v1/messages/{notice.json()['id']}/reactions/👍")
    assert reaction.status_code == 201
    as_user(root)
    assert (await _post(client, channel["id"], "管理者から")).status_code == 201

    # A webhook's bot may post into an announcement channel.
    hook = (
        await client.post(
            "/api/v1/admin/webhooks", json={"name": "CI", "channel_id": channel["id"]}
        )
    ).json()
    client.headers.pop("Authorization", None)
    via_hook = await client.post(f"/api/v1/hooks/{hook['token']}", json={"text": "deploy done"})
    assert via_hook.status_code == 201

    as_user(owner)
    reopened = await client.patch(
        f"/api/v1/channels/{channel['id']}", json={"posting_policy": "everyone"}
    )
    assert reopened.json()["posting_policy"] == "everyone"
    as_user(member)
    assert (await _post(client, channel["id"], "やっと書ける")).status_code == 201


async def test_public_private_conversion(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    owner = await make_user(db, "owner")
    outsider = await make_user(db, "outsider")
    root = await make_user(db, "root", role="admin")
    guest = await make_user(db, "guest", role="guest")
    as_user(owner)
    channel = (await client.post("/api/v1/channels", json={"name": "planning"})).json()

    as_user(outsider)
    browse = await client.get("/api/v1/channels", params={"include": "public"})
    assert channel["id"] in [c["id"] for c in browse.json()]

    as_user(owner)
    private = await client.patch(f"/api/v1/channels/{channel['id']}", json={"type": "private"})
    assert private.status_code == 200 and private.json()["type"] == "private"
    as_user(outsider)
    browse = await client.get("/api/v1/channels", params={"include": "public"})
    assert channel["id"] not in [c["id"] for c in browse.json()]
    assert (await client.post(f"/api/v1/channels/{channel['id']}/join")).status_code == 403

    # Back to public: an administrator only.
    as_user(owner)
    refused = await client.patch(f"/api/v1/channels/{channel['id']}", json={"type": "public"})
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "admin_required"
    as_user(root)
    public = await client.patch(f"/api/v1/channels/{channel['id']}", json={"type": "public"})
    assert public.status_code == 200 and public.json()["type"] == "public"
    as_user(outsider)
    assert (await client.post(f"/api/v1/channels/{channel['id']}/join")).status_code == 200

    # DMs cannot be converted.
    as_user(owner)
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(outsider.id)]})).json()
    assert (
        await client.patch(f"/api/v1/channels/{dm['id']}", json={"type": "public"})
    ).status_code in (403, 409)

    # The visibility changes went to every non-guest user; other changes only to members.
    rows = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "channel.updated")
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    assert [r.audience_type for r in rows] == ["all", "all"]
    from app.modules.channels.service import resolve_event_audience

    audience = await resolve_event_audience(db, rows[0])
    assert guest.id not in audience.ids and outsider.id in audience.ids and root.id in audience.ids
