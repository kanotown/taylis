"""Edit / delete / reactions / mentions (M8a): API rules, seq consumption, delta recovery."""

import uuid
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import build_settings
from app.events.models import OutboxEvent
from app.modules.channels import service as channels
from app.modules.channels.schemas import ChannelCreate
from app.modules.messages.mentions import extract_mentions
from app.modules.notifications.planner import PushPlanner
from app.modules.users.models import User
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body},
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


def _reaction_path(message_id: str, emoji: str) -> str:
    return f"/api/v1/messages/{message_id}/reactions/{quote(emoji, safe='')}"


async def test_edit_delete_and_reactions(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    admin = await make_user(db, "root", role="admin")

    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    as_user(bob)
    await client.post(f"/api/v1/channels/{channel['id']}/join")
    as_user(admin)
    await client.post(f"/api/v1/channels/{channel['id']}/join")

    as_user(alice)
    first = await _post(client, channel["id"], "hello")  # seq 1
    second = await _post(client, channel["id"], "bye")  # seq 2

    # Edit: author only, consumes a seq, sets edited_at.
    as_user(bob)
    denied = await client.patch(f"/api/v1/messages/{first['id']}", json={"body": "hacked"})
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_message_owner"
    as_user(alice)
    edited = await client.patch(f"/api/v1/messages/{first['id']}", json={"body": "hello *there*"})
    assert edited.status_code == 200
    assert edited.json()["body"] == "hello *there*"
    assert edited.json()["seq"] == 1 and edited.json()["updated_seq"] == 3
    assert edited.json()["edited_at"] is not None

    # Reactions: idempotent add, grouped counts, removal; unchanged calls consume no seq.
    as_user(bob)
    added = await client.put(_reaction_path(first["id"], "👍"))
    assert added.status_code == 201
    assert added.json()["updated_seq"] == 4
    assert added.json()["reactions"] == [{"emoji": "👍", "count": 1, "user_ids": [str(bob.id)]}]
    again = await client.put(_reaction_path(first["id"], "👍"))
    assert again.status_code == 200 and again.json()["updated_seq"] == 4
    as_user(alice)
    both = await client.put(_reaction_path(first["id"], "👍"))
    assert both.status_code == 201 and both.json()["reactions"][0]["count"] == 2
    shortcode = await client.put(_reaction_path(first["id"], ":+1:"))
    assert shortcode.status_code == 201
    assert [r["emoji"] for r in shortcode.json()["reactions"]] == ["👍", ":+1:"]
    invalid = await client.put(_reaction_path(first["id"], "thumbs up"))
    assert invalid.status_code == 422
    as_user(bob)
    removed = await client.delete(_reaction_path(first["id"], "👍"))
    assert removed.status_code == 200
    assert removed.json()["reactions"][0] == {
        "emoji": "👍",
        "count": 1,
        "user_ids": [str(alice.id)],
    }
    removed_again = await client.delete(_reaction_path(first["id"], "👍"))
    assert removed_again.status_code == 200
    assert removed_again.json()["updated_seq"] == removed.json()["updated_seq"]

    # Delete: author or admin; tombstone hides the body, drops reactions, leaves history.
    as_user(bob)
    denied = await client.delete(f"/api/v1/messages/{second['id']}")
    assert denied.status_code == 403
    as_user(admin)
    deleted = await client.delete(f"/api/v1/messages/{second['id']}")
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] is True and deleted.json()["body"] == ""
    assert (await client.get(f"/api/v1/messages/{second['id']}")).status_code == 404
    as_user(alice)
    assert (
        await client.patch(f"/api/v1/messages/{second['id']}", json={"body": "x"})
    ).status_code == 404
    assert (await client.put(_reaction_path(second["id"], "👍"))).status_code == 404

    history = (await client.get(f"/api/v1/channels/{channel['id']}/messages")).json()
    assert [m["id"] for m in history["messages"]] == [first["id"]]
    assert history["messages"][0]["reactions"] == [
        {"emoji": "👍", "count": 1, "user_ids": [str(alice.id)]},
        {"emoji": ":+1:", "count": 1, "user_ids": [str(alice.id)]},
    ]

    # Delta sync from before the changes returns the current state of both messages (§8).
    delta = (
        await client.get(f"/api/v1/channels/{channel['id']}/sync", params={"since_seq": 2})
    ).json()
    by_id = {m["id"]: m for m in delta["messages"]}
    assert set(by_id) == {first["id"], second["id"]}
    assert by_id[second["id"]]["deleted"] is True and by_id[second["id"]]["reactions"] == []
    assert by_id[first["id"]]["body"] == "hello *there*"
    assert delta["next_since_seq"] == history["channel_last_seq"]

    # Outbox: every change is an event carrying the full message and consuming a seq.
    events = list((await db.execute(select(OutboxEvent).order_by(OutboxEvent.id))).scalars())
    kinds = [
        (e.event_type, e.seq, e.payload.get("change"))
        for e in events
        if e.event_type.startswith("message.")
    ]
    assert kinds == [
        ("message.created", 1, None),
        ("message.created", 2, None),
        ("message.updated", 3, "body"),
        ("message.updated", 4, "reactions"),
        ("message.updated", 5, "reactions"),
        ("message.updated", 6, "reactions"),
        ("message.updated", 7, "reactions"),
        ("message.deleted", 8, None),
    ]
    assert events[-1].payload["message"]["deleted"] is True


async def test_mentions_are_extracted_and_drive_push_targets(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    assert extract_mentions(f"<@{bob.id}> hi <@{bob.id}> <!here>") == ([bob.id], True)
    assert extract_mentions("plain <@not-a-uuid>") == ([], False)

    created = await channels.create_channel(db, alice, ChannelCreate(name="general", type="public"))
    for user in (bob, carol):
        await channels.join_channel(db, user, created.id)

    as_user(alice)
    posted = await _post(client, str(created.id), f"ping <@{bob.id}>")
    assert posted["mentioned_user_ids"] == [str(bob.id)] and posted["mention_all"] is False

    planner = PushPlanner(build_settings(), is_active=lambda _uid: False)
    channel = await channels.require_channel(db, created.id)
    # Channel default level is "mentions": only bob is a target; <!channel> reaches everyone.
    assert await planner.select_recipients(db, channel, [bob.id, carol.id], posted) == [bob.id]
    everyone = posted | {"mention_all": True}
    assert await planner.select_recipients(db, channel, [bob.id, carol.id], everyone) == [
        bob.id,
        carol.id,
    ]
    assert await planner.select_recipients(db, channel, [bob.id, carol.id], None) == []

    edited = await client.patch(f"/api/v1/messages/{posted['id']}", json={"body": "<!channel> all"})
    assert edited.json()["mentioned_user_ids"] == [] and edited.json()["mention_all"] is True
