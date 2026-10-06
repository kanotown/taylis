"""M117 (docs/CALLS.md): calls by meeting link — the workspace setting and the calls endpoint."""

import re
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.settings import Settings
from app.events.models import OutboxEvent
from app.modules.calls import service as calls
from app.modules.channels import service as channels
from app.modules.users.models import User
from app.modules.workspace import service as workspace
from tests.helpers import make_user
from tests.test_push_planner import add_device, deliveries, relay_with_planner

API = "/api/v1"
ROOM = re.compile(r"^https://meet\.jit\.si/taylis-[a-z2-7]{24}$")


async def _call(client: AsyncClient, channel_id: str, key: str | None = None) -> Any:
    return await client.post(
        f"{API}/channels/{channel_id}/calls", json={"client_msg_id": key or str(uuid.uuid4())}
    )


async def _set_meeting(client: AsyncClient, value: Any) -> Any:
    return await client.patch(f"{API}/admin/workspace-settings", json={"meeting_base_url": value})


def test_room_names_are_random_and_never_from_ids() -> None:
    names = {calls.room_name() for _ in range(500)}
    assert len(names) == 500
    for name in names:
        assert re.fullmatch(r"taylis-[a-z2-7]{24}", name)
    assert calls.call_body("https://x/r") == "📞 通話を始めました\nhttps://x/r"


@pytest.mark.parametrize(
    ("value", "debug", "expected"),
    [
        ("https://meet.jit.si/", False, "https://meet.jit.si/"),
        ("https://jitsi.example.org", False, "https://jitsi.example.org/"),
        ("  https://jitsi.example.org/lab  ", False, "https://jitsi.example.org/lab/"),
        ("", False, None),
        (None, False, None),
        ("http://localhost:8443", True, "http://localhost:8443/"),
    ],
)
def test_meeting_url_is_cleaned(value: str | None, debug: bool, expected: str | None) -> None:
    assert workspace.clean_meeting_base_url(value, debug=debug) == expected


@pytest.mark.parametrize(
    ("value", "debug"),
    [
        ("http://jitsi.example.org/", False),
        ("http://jitsi.example.org/", True),
        ("http://localhost:8443/", False),
        ("javascript:alert(1)", False),
        ("ftp://jitsi.example.org/", False),
        ("https://", False),
        ("https://user:pw@jitsi.example.org/", False),
        ("https://jitsi.example.org/?room=", False),
        ("https://jitsi.example.org/#x", False),
        ("https://jitsi.example.org/a b", False),
        ("https://jitsi.example.org:99999/", False),
        ("https://jitsi.example.org/" + "a" * 200, False),
    ],
)
def test_meeting_url_rejects(value: str, debug: bool) -> None:
    with pytest.raises(AppError) as caught:
        workspace.clean_meeting_base_url(value, debug=debug)
    assert caught.value.status == 422 and caught.value.code == "meeting_url_invalid"


async def test_setting_defaults_to_jitsi_and_admins_change_it(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "admin", role="admin")
    member = await make_user(db, "member")
    as_user(member)
    boot = (await client.get(f"{API}/sync/bootstrap")).json()["workspace_settings"]
    assert boot["calls_enabled"] is True
    assert boot["meeting_base_url"] == "https://meet.jit.si/"
    assert (await _set_meeting(client, "")).status_code == 403

    as_user(admin)
    changed = await _set_meeting(client, "https://jitsi.example.org")
    assert changed.status_code == 200, changed.text
    assert changed.json()["meeting_base_url"] == "https://jitsi.example.org/"
    bad = await _set_meeting(client, "http://jitsi.example.org/")
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "meeting_url_invalid"
    too_long = await _set_meeting(client, "https://a.example/" + "a" * 300)
    assert too_long.status_code == 422
    # Leaving the field out keeps it; "" or null turns calls off.
    other = await client.patch(
        f"{API}/admin/workspace-settings", json={"preview_before_join": False}
    )
    assert other.json()["meeting_base_url"] == "https://jitsi.example.org/"
    off = await _set_meeting(client, None)
    assert off.json()["calls_enabled"] is False and off.json()["meeting_base_url"] is None
    assert (await _set_meeting(client, "https://meet.jit.si/")).json()["calls_enabled"] is True
    assert (await _set_meeting(client, "")).json()["calls_enabled"] is False

    events = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "workspace.settings_updated")
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    assert [e.payload["settings"]["meeting_base_url"] for e in events] == [
        "https://jitsi.example.org/",
        "https://jitsi.example.org/",  # the preview change
        None,
        "https://meet.jit.si/",
        None,
    ]
    as_user(member)
    boot = (await client.get(f"{API}/sync/bootstrap")).json()["workspace_settings"]
    assert boot["calls_enabled"] is False and boot["meeting_base_url"] is None


async def test_starting_a_call_posts_a_call_message(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    dm = (await client.post(f"{API}/dms", json={"user_ids": [str(bob.id)]})).json()
    key = str(uuid.uuid4())
    started = await _call(client, dm["id"], key)
    assert started.status_code == 201, started.text
    out = started.json()
    assert ROOM.match(out["url"])
    message = out["message"]
    assert message["call"] == {"url": out["url"], "started_by": str(alice.id)}
    assert message["type"] == "user" and message["sender_id"] == str(alice.id)
    assert message["body"] == f"📞 通話を始めました\n{out['url']}"
    assert message["seq"] == 1 and message["client_msg_id"] == key

    # A retry gets the same call; a new call gets a new room.
    again = await _call(client, dm["id"], key)
    assert again.status_code == 200 and again.json()["url"] == out["url"]
    assert again.json()["message"]["id"] == message["id"]
    other = await _call(client, dm["id"])
    assert other.status_code == 201 and other.json()["url"] != out["url"]

    # The others see it through history, sync and the event like any message.
    as_user(bob)
    history = (await client.get(f"{API}/channels/{dm['id']}/messages")).json()["messages"]
    assert [m["call"]["url"] for m in history] == [other.json()["url"], out["url"]]
    boot = (await client.get(f"{API}/sync/bootstrap")).json()
    state = next(c for c in boot["channels"] if c["id"] == dm["id"])["read_state"]
    assert state["unread_count"] == 2
    created = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "message.created")
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    assert [e.payload["message"]["call"]["url"] for e in created] == [
        out["url"],
        other.json()["url"],
    ]

    # A client_msg_id used for an ordinary message is not a call.
    as_user(alice)
    plain_key = str(uuid.uuid4())
    await client.post(
        f"{API}/channels/{dm['id']}/messages", json={"client_msg_id": plain_key, "body": "hi"}
    )
    reused = await _call(client, dm["id"], plain_key)
    assert reused.status_code == 409 and reused.json()["error"]["code"] == "idempotency_conflict"

    # Deleting the message drops the call (a retry still answers with the stored room).
    assert (await client.delete(f"{API}/messages/{message['id']}")).status_code in (200, 204)
    gone = (await client.get(f"{API}/channels/{dm['id']}/sync?since_seq=0")).json()["messages"]
    assert next(m for m in gone if m["id"] == message["id"])["call"] is None
    retried = await _call(client, dm["id"], key)
    assert retried.status_code == 200 and retried.json()["message"]["deleted"] is True


async def test_who_can_start_a_call(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice", role="admin")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    general = (await client.post(f"{API}/channels", json={"name": "general"})).json()
    group = (
        await client.post(f"{API}/dms", json={"user_ids": [str(bob.id), str(carol.id)]})
    ).json()
    assert (await _call(client, general["id"])).status_code == 201
    assert (await _call(client, group["id"])).status_code == 201

    # Not a member (also of a public channel), an unknown channel.
    as_user(carol)
    denied = await _call(client, general["id"])
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_a_member"
    assert (await _call(client, str(uuid.uuid4()))).status_code == 404
    bad = await client.post(f"{API}/channels/{general['id']}/calls", json={})
    assert bad.status_code == 422

    # Archived.
    as_user(alice)
    assert (await client.post(f"{API}/channels/{general['id']}/archive")).status_code == 200
    archived = await _call(client, general["id"])
    assert archived.status_code == 409 and archived.json()["error"]["code"] == "channel_archived"

    # Calls off: 409 calls_disabled, and nothing is posted.
    await _set_meeting(client, "")
    disabled = await _call(client, group["id"])
    assert disabled.status_code == 409 and disabled.json()["error"]["code"] == "calls_disabled"
    assert (await client.get(f"{API}/channels/{group['id']}")).json()["last_seq"] == 1
    # A self-hosted service: the room is made there.
    await _set_meeting(client, "https://jitsi.example.org/lab")
    hosted = await _call(client, group["id"])
    hosted_url = hosted.json()["url"]
    assert re.fullmatch(r"https://jitsi\.example\.org/lab/taylis-[a-z2-7]{24}", hosted_url)


async def test_call_push_says_who_started_it(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    message, created = await calls.start_call(db, alice, dm.id, uuid.uuid4())
    assert created and message.call_url is not None

    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    rows = await deliveries(db)
    assert len(rows) == 1
    assert rows[0].payload["title"] == "Alice"
    assert rows[0].payload["body"] == "📞 Alice さんが通話を始めました"

    # In the device's language.
    await db.execute(text("UPDATE users SET locale = 'en' WHERE id = :id"), {"id": bob.id})
    await db.commit()
    await calls.start_call(db, alice, dm.id, uuid.uuid4())
    while await relay.process_batch():
        pass
    rows = await deliveries(db)
    assert rows[-1].payload["body"] == "📞 Alice started a call"
