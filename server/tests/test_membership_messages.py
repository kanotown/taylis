"""M88 (docs/MEMBERSHIP.md): join / leave lines and the two workspace settings."""

import json
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.events.models import OutboxEvent
from app.modules.audit.models import AuditLog
from app.modules.channels import service as channels
from app.modules.channels.schemas import ChannelCreate
from app.modules.messages import service as messages
from app.modules.messages.schemas import MessageCreate
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_push_planner import add_device, deliveries, relay_with_planner

API = "/api/v1"
VECTORS = Path(__file__).resolve().parents[2] / "apps" / "shared" / "notify-rules.json"


async def _lines_on(db: AsyncSession, on: bool = True) -> None:
    """The tests start with the lines off (conftest.py); these turn them on."""
    await db.execute(
        text("UPDATE workspace_settings SET show_membership_messages = :on"), {"on": on}
    )
    await db.commit()


async def _preview(db: AsyncSession, on: bool) -> None:
    await db.execute(text("UPDATE workspace_settings SET preview_before_join = :on"), {"on": on})
    await db.commit()


async def _post(client: AsyncClient, cid: str, body: str, **extra: Any) -> dict[str, Any]:
    response = await client.post(
        f"{API}/channels/{cid}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body, **extra},
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


async def _history(client: AsyncClient, cid: str) -> list[dict[str, Any]]:
    """Oldest first (the API pages newest first)."""
    response = await client.get(f"{API}/channels/{cid}/messages")
    assert response.status_code == 200, response.text
    return sorted(response.json()["messages"], key=lambda m: int(m["seq"]))


async def _state(client: AsyncClient, cid: str) -> dict[str, Any]:
    boot = (await client.get(f"{API}/sync/bootstrap")).json()
    channel = next(c for c in boot["channels"] if c["id"] == cid)
    return dict(channel["read_state"])


async def test_join_leave_lines_are_system_messages_that_are_never_unread(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    await _lines_on(db)
    alice = await make_user(db, "alice", notification_default="all")
    bob = await make_user(db, "bob")
    await add_device(db, alice)
    as_user(alice)
    cid = (await client.post(f"{API}/channels", json={"name": "general"})).json()["id"]
    await _post(client, cid, "hello")  # seq 1, alice has read it
    active_at = (await client.get(f"{API}/channels/{cid}")).json()["last_message_at"]

    as_user(bob)
    joined = await client.post(f"{API}/channels/{cid}/join")
    assert joined.status_code == 200 and joined.json()["last_seq"] == 2  # the line included
    rows = await _history(client, cid)
    line = rows[-1]
    assert line["type"] == "system" and line["seq"] == 2
    assert line["sender_id"] == str(bob.id)
    assert line["body"] == "Bob が参加しました"
    assert line["system_event"] == {
        "kind": "member_joined",
        "actor_id": str(bob.id),
        "user_ids": [str(bob.id)],
    }
    assert line["mentioned_user_ids"] == [] and line["mention_all"] is False
    # The joiner's position is after their own line; nothing is unread for them.
    assert (await _state(client, cid))["last_read_seq"] == 2
    assert (await _state(client, cid))["unread_count"] == 0
    assert rows[0]["system_event"] is None  # people's posts carry none

    assert (await client.post(f"{API}/channels/{cid}/leave")).status_code == 204
    as_user(alice)
    rows = await _history(client, cid)
    assert [(m["seq"], m["body"]) for m in rows[1:]] == [
        (2, "Bob が参加しました"),
        (3, "Bob が退出しました"),
    ]
    assert rows[2]["system_event"]["kind"] == "member_left"
    # Alice's position did not move and the lines are not unread (counts, first_unread_at).
    state = await _state(client, cid)
    assert state["last_read_seq"] == 1 and state["unread_count"] == 0
    assert state["first_unread_at"] is None
    # They do not move the channel's activity time either (the sidebar's recent order).
    listed = (await client.get(f"{API}/channels/{cid}")).json()
    assert listed["last_seq"] == 3 and listed["last_message_at"] == active_at

    # Never pushed, even at level all.
    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    assert await deliveries(db) == []

    # Not searchable.
    found = await client.get(f"{API}/search/messages", params={"q": "参加しました"})
    assert found.status_code == 200 and found.json()["hits"] == []


async def test_adding_several_is_one_line_and_removing_says_who(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    await _lines_on(db)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    cid = (await client.post(f"{API}/channels", json={"name": "lab", "type": "private"})).json()[
        "id"
    ]
    added = await client.post(
        f"{API}/channels/{cid}/members/batch",
        json={"user_ids": [str(bob.id), str(carol.id), str(alice.id)]},
    )
    assert added.status_code == 200, added.text
    assert [m["user_id"] for m in added.json()] == [str(bob.id), str(carol.id), str(alice.id)]
    rows = await _history(client, cid)
    assert [m["body"] for m in rows] == ["Alice が Bob、Carol を追加しました"]
    assert rows[0]["system_event"] == {
        "kind": "members_added",
        "actor_id": str(alice.id),
        "user_ids": [str(bob.id), str(carol.id)],
    }
    # Adding again (already members) writes nothing.
    again = await client.post(f"{API}/channels/{cid}/members", json={"user_id": str(bob.id)})
    assert again.status_code == 200
    assert len(await _history(client, cid)) == 1

    as_user(bob)
    assert (await _state(client, cid))["last_read_seq"] == 1  # after the line that added him

    as_user(alice)
    removed = await client.delete(f"{API}/channels/{cid}/members/{carol.id}")
    assert removed.status_code == 204
    # An owner removing themselves left.
    assert (await client.delete(f"{API}/channels/{cid}/members/{alice.id}")).status_code == 204
    as_user(bob)
    assert [m["body"] for m in await _history(client, cid)] == [
        "Alice が Bob、Carol を追加しました",
        "Alice が Carol を外しました",
        "Alice が退出しました",
    ]
    kinds = [m["system_event"]["kind"] for m in await _history(client, cid)]
    assert kinds == ["members_added", "member_removed", "member_left"]


async def test_no_lines_when_off_in_dms_for_bots_or_archived_channels(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    bot = await make_user(db, "hookbot", role="bot")
    as_user(alice)
    cid = (await client.post(f"{API}/channels", json={"name": "general"})).json()["id"]
    as_user(bob)
    await client.post(f"{API}/channels/{cid}/join")  # off (the tests' start)
    await client.post(f"{API}/channels/{cid}/leave")
    as_user(alice)
    assert await _history(client, cid) == []

    await _lines_on(db)
    # A bot coming or going is plumbing (webhooks, recurring posts, the AI).
    record = await channels.require_channel(db, uuid.UUID(cid))
    await channels.add_member_in_tx(db, record, bot.id, announce=True)
    await db.commit()
    assert await client.post(f"{API}/channels/{cid}/members", json={"user_id": str(bot.id)})
    assert await _history(client, cid) == []
    # A DM has no lines.
    dm = (await client.post(f"{API}/dms", json={"user_ids": [str(bob.id)]})).json()["id"]
    assert await _history(client, dm) == []
    # Nor has an archived channel.
    assert (await client.post(f"{API}/channels/{cid}/archive")).status_code == 200
    await client.delete(f"{API}/channels/{cid}/members/{bot.id}")
    assert await _history(client, cid) == []

    # Turning the lines off keeps the ones written.
    other = (await client.post(f"{API}/channels", json={"name": "other"})).json()["id"]
    as_user(bob)
    await client.post(f"{API}/channels/{other}/join")
    await _lines_on(db, False)
    await client.post(f"{API}/channels/{other}/leave")
    as_user(alice)
    assert [m["body"] for m in await _history(client, other)] == ["Bob が参加しました"]


async def test_a_line_cannot_be_changed_and_only_an_admin_deletes_it(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    await _lines_on(db)
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    admin = await make_user(db, "boss", role="admin")
    as_user(alice)
    cid = (await client.post(f"{API}/channels", json={"name": "general"})).json()["id"]
    as_user(bob)
    await client.post(f"{API}/channels/{cid}/join")
    line = (await _history(client, cid))[-1]
    mid = line["id"]

    def code(response: Any) -> tuple[int, str]:
        return response.status_code, response.json()["error"]["code"]

    readonly = (400, "system_message_readonly")
    assert code(await client.patch(f"{API}/messages/{mid}", json={"body": "x"})) == readonly
    assert code(await client.put(f"{API}/messages/{mid}/reactions/👍")) == readonly
    assert code(await client.put(f"{API}/messages/{mid}/pin")) == readonly
    reply = await client.post(
        f"{API}/channels/{cid}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "r", "parent_id": mid},
    )
    assert code(reply) == readonly
    assert code(await client.delete(f"{API}/messages/{mid}")) == (403, "not_message_owner")
    as_user(admin)
    await client.post(f"{API}/channels/{cid}/join")
    assert (await client.delete(f"{API}/messages/{mid}")).status_code == 200


async def test_invites_and_the_service_announce_joins(
    db: AsyncSession, client: AsyncClient, as_user: Callable[[User], None]
) -> None:
    """Joining through add_member_in_tx(announce=True) (invites, SSO's default channels, a
    supervisor following a times) reads as a join; a scheduled post is unaffected."""
    await _lines_on(db)
    alice = await make_user(db, "alice")
    newcomer = await make_user(db, "newcomer")
    as_user(alice)
    cid = (await client.post(f"{API}/channels", json={"name": "general"})).json()["id"]
    record = await channels.require_channel(db, uuid.UUID(cid))
    assert await channels.add_member_in_tx(db, record, newcomer.id, announce=True)
    await db.commit()
    rows = await _history(client, cid)
    assert [m["body"] for m in rows] == ["Newcomer が参加しました"]
    # A people's post after it is counted as usual.
    await messages.create_message(
        db, alice, uuid.UUID(cid), MessageCreate(client_msg_id=uuid.uuid4(), body="welcome")
    )
    as_user(newcomer)
    state = await _state(client, cid)
    assert state["last_read_seq"] == 1 and state["unread_count"] == 1


async def test_admin_settings_api_audit_event_and_bootstrap(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    member = await make_user(db, "alice")
    admin = await make_user(db, "boss", role="admin")
    as_user(member)
    assert (await client.get(f"{API}/admin/workspace-settings")).status_code == 403
    denied = await client.patch(
        f"{API}/admin/workspace-settings", json={"preview_before_join": False}
    )
    assert denied.status_code == 403
    boot = (await client.get(f"{API}/sync/bootstrap")).json()
    assert boot["workspace_settings"] == {
        "show_membership_messages": False,  # the tests' start (conftest.py)
        "preview_before_join": True,
        "icon_version": None,  # M93
        "calls_enabled": True,  # M117
        "meeting_base_url": "https://meet.jit.si/",
    }

    as_user(admin)
    await db.execute(text("DELETE FROM workspace_settings"))  # a missing row reads as defaults
    await db.commit()
    got = (await client.get(f"{API}/admin/workspace-settings")).json()
    assert got["show_membership_messages"] is True and got["preview_before_join"] is True
    bad = await client.patch(f"{API}/admin/workspace-settings", json={"unknown": True})
    assert bad.status_code == 422
    changed = await client.patch(
        f"{API}/admin/workspace-settings",
        json={"preview_before_join": False, "show_membership_messages": True},
    )
    assert changed.status_code == 200, changed.text
    body = changed.json()
    assert body["preview_before_join"] is False and body["show_membership_messages"] is True
    assert body["updated_by"] == str(admin.id) and body["updated_at"]
    audits = (
        (await db.execute(select(AuditLog).where(AuditLog.action == "workspace.settings_updated")))
        .scalars()
        .all()
    )
    assert len(audits) == 1
    assert audits[0].details == {"preview_before_join": {"from": True, "to": False}}
    events = (
        (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.event_type == "workspace.settings_updated")
            )
        )
        .scalars()
        .all()
    )
    assert len(events) == 1 and events[0].audience_type == "all"
    assert events[0].payload == {
        "settings": {
            "show_membership_messages": True,
            "preview_before_join": False,
            "icon_version": None,
            "calls_enabled": True,
            "meeting_base_url": "https://meet.jit.si/",
        }
    }
    # Nothing changed: no audit, no event.
    await client.patch(f"{API}/admin/workspace-settings", json={"preview_before_join": False})
    assert (
        len(
            (
                await db.execute(
                    select(AuditLog).where(AuditLog.action == "workspace.settings_updated")
                )
            )
            .scalars()
            .all()
        )
        == 1
    )
    as_user(member)
    boot = (await client.get(f"{API}/sync/bootstrap")).json()
    assert boot["workspace_settings"]["preview_before_join"] is False


async def test_without_the_preview_only_members_read_a_public_channel(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    admin = await make_user(db, "boss", role="admin")
    as_user(alice)
    cid = (
        await client.post(f"{API}/channels", json={"name": "open", "topic": "t", "purpose": "p"})
    ).json()["id"]
    parent = await _post(client, cid, "公開の話題")
    await _post(client, cid, "返信", parent_id=parent["id"])
    times = (await client.post(f"{API}/times")).json()["id"]
    await _post(client, times, "作業メモ")

    await _preview(db, False)
    for reader in (bob, admin):  # administrators are no exception
        as_user(reader)
        for path, params in (
            (f"{API}/channels/{cid}/messages", {}),
            (f"{API}/channels/{cid}/sync", {"since_seq": 0}),
            (f"{API}/messages/{parent['id']}", {}),
            (f"{API}/messages/{parent['id']}/replies", {}),
            (f"{API}/messages/{parent['id']}/context", {}),
        ):
            refused = await client.get(path, params=params)
            assert refused.status_code == 403, path
            assert refused.json()["error"]["code"] == "preview_disabled", path
        assert (await client.get(f"{API}/channels/{cid}/pins")).status_code == 403
        # The name, topic, purpose and member count stay in the browser.
        listed = (await client.get(f"{API}/channels", params={"include": "public"})).json()
        open_row = next(c for c in listed if c["id"] == cid)
        assert (open_row["topic"], open_row["purpose"], open_row["member_count"]) == ("t", "p", 1)
        one = await client.get(f"{API}/channels/{cid}")
        assert one.status_code == 200 and one.json()["member_count"] == 1
        # Search keeps to my channels, is:times too.
        found = await client.get(f"{API}/search/messages", params={"q": "作業メモ is:times"})
        assert found.status_code == 200 and found.json()["hits"] == []
        assert found.json()["channels"] == []
        narrowed = await client.get(
            f"{API}/search/messages", params={"q": "話題", "channel_id": cid}
        )
        assert narrowed.status_code == 403

    as_user(bob)
    assert (await client.post(f"{API}/channels/{cid}/join")).status_code == 200
    assert [m["body"] for m in await _history(client, cid)] == ["公開の話題"]
    await _preview(db, True)
    as_user(admin)
    assert (await client.get(f"{API}/channels/{cid}/messages")).status_code == 200
    found = await client.get(f"{API}/search/messages", params={"q": "作業メモ is:times"})
    assert [h["message"]["body"] for h in found.json()["hits"]] == ["作業メモ"]


async def test_attachments_of_a_public_channel_need_membership_without_the_preview(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = (await client.post(f"{API}/channels", json={"name": "open"})).json()["id"]
    upload = await client.post(
        f"{API}/attachments",
        files={"file": ("a.txt", b"hello", "text/plain")},
    )
    assert upload.status_code == 201, upload.text
    attachment = upload.json()
    await _post(client, cid, "file", attachment_ids=[attachment["id"]])
    await _preview(db, False)
    as_user(bob)
    refused = await client.get(f"{API}/attachments/{attachment['id']}")
    assert refused.status_code == 403
    assert refused.json()["error"]["code"] == "preview_disabled"


@pytest.mark.parametrize(
    "case",
    json.loads(VECTORS.read_text())["system_messages"]["cases"],
    ids=lambda case: case["name"],
)
async def test_system_lines_never_notify_whatever_the_rules_say(
    case: dict[str, Any], app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    """apps/shared/notify-rules.json "system_messages": a join line pushes no one, at any level."""
    assert case["type"] == "system" and case["expect"]["notify"] is False
    await _lines_on(db)
    alice = await make_user(db, "alice", notification_default=case["level"])
    bob = await make_user(db, "bob")
    await add_device(db, alice)
    channel = await channels.create_channel(db, alice, ChannelCreate(name="general"))
    await channels.join_channel(db, bob, channel.id)
    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    assert await deliveries(db) == []
