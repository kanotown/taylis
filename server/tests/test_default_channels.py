"""M90 (docs/MEMBERSHIP.md §6): default channels set by the administrator."""

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.events.models import OutboxEvent
from app.modules.admin import service as admin
from app.modules.admin.schemas import AdminUserCreate
from app.modules.audit.models import AuditLog
from app.modules.auth.deps import get_current_user
from app.modules.channels.models import Channel, ChannelMember
from app.modules.messages.service import membership_text
from app.modules.users.models import User
from tests.helpers import make_user

API = "/api/v1"
SETTINGS = f"{API}/admin/workspace-settings"
APPLY = f"{SETTINGS}/apply-default-channels"


async def _lines_on(db: AsyncSession) -> None:
    await db.execute(text("UPDATE workspace_settings SET show_membership_messages = true"))
    await db.commit()


async def _channel(client: AsyncClient, name: str, **extra: Any) -> str:
    response = await client.post(f"{API}/channels", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    cid: str = response.json()["id"]
    return cid


async def _set_defaults(client: AsyncClient, ids: list[str]) -> dict[str, Any]:
    response = await client.patch(SETTINGS, json={"default_channel_ids": ids})
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def _channels_of(db: AsyncSession, user_id: uuid.UUID | str) -> set[str]:
    rows = await db.execute(
        select(ChannelMember.channel_id).where(ChannelMember.user_id == uuid.UUID(str(user_id)))
    )
    return {str(c) for c in rows.scalars().all()}


async def _system_lines(db: AsyncSession, cid: str) -> list[tuple[str, dict[str, Any]]]:
    rows = await db.execute(
        text(
            "SELECT body, system_event FROM messages WHERE channel_id = :c AND type = 'system' "
            "ORDER BY seq"
        ),
        {"c": cid},
    )
    return [(r[0], r[1]) for r in rows.all()]


@pytest.fixture
async def setup(
    db: AsyncSession, client: AsyncClient, as_user: Callable[[User], None]
) -> dict[str, Any]:
    """An admin, the two channels of the user's request as defaults, and one more channel."""
    root = await make_user(db, "root", role="admin")
    as_user(root)
    notices = await _channel(client, "全体連絡")
    lounge = await _channel(client, "談話スペース")
    other = await _channel(client, "other")
    await _set_defaults(client, [notices, lounge])
    return {"root": root, "notices": notices, "lounge": lounge, "other": other}


async def test_settings_list_names_validate_audit_and_event(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    member = await make_user(db, "alice")
    as_user(root)
    notices = await _channel(client, "全体連絡")
    lounge = await _channel(client, "談話スペース")
    secret = await _channel(client, "secret", type="private")
    archived = await _channel(client, "old")
    assert (await client.post(f"{API}/channels/{archived}/archive")).status_code == 200

    before = (await client.get(SETTINGS)).json()
    assert before["default_channels_set"] is False and before["default_channel_ids"] == []

    def code(response: Any) -> tuple[int, str]:
        return response.status_code, response.json()["error"]["code"]

    bad = await client.patch(SETTINGS, json={"default_channel_ids": [str(uuid.uuid4())]})
    assert code(bad) == (422, "default_channel_not_found")
    bad = await client.patch(SETTINGS, json={"default_channel_ids": [notices, secret]})
    assert code(bad) == (422, "default_channel_not_public")
    assert bad.json()["error"]["details"] == {"channel_id": secret}
    bad = await client.patch(SETTINGS, json={"default_channel_ids": [archived]})
    assert code(bad) == (422, "default_channel_archived")
    many = [str(uuid.uuid4()) for _ in range(21)]
    assert (await client.patch(SETTINGS, json={"default_channel_ids": many})).status_code == 422

    body = await _set_defaults(client, [lounge, notices, lounge])  # repeats dropped, order kept
    assert body["default_channel_ids"] == [lounge, notices]
    assert body["default_channels"] == [
        {"id": lounge, "name": "談話スペース"},
        {"id": notices, "name": "全体連絡"},
    ]
    assert body["default_channels_set"] is True and body["updated_by"] == str(root.id)
    audits = (
        (await db.execute(select(AuditLog).where(AuditLog.action == "workspace.settings_updated")))
        .scalars()
        .all()
    )
    assert [a.details for a in audits] == [
        {"default_channel_ids": {"from": None, "to": [lounge, notices]}}
    ]
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
    # The same list again changes nothing; [] clears it but stays "set".
    await _set_defaults(client, [lounge, notices])
    cleared = await _set_defaults(client, [])
    assert cleared["default_channel_ids"] == [] and cleared["default_channels_set"] is True
    count = await db.execute(
        select(AuditLog).where(AuditLog.action == "workspace.settings_updated")
    )
    assert len(count.scalars().all()) == 2

    as_user(member)
    assert (await client.patch(SETTINGS, json={"default_channel_ids": []})).status_code == 403
    assert (await client.post(APPLY, json={})).status_code == 403
    # Not in the settings everyone gets.
    boot = (await client.get(f"{API}/sync/bootstrap")).json()
    assert "default_channel_ids" not in boot["workspace_settings"]


async def test_admin_api_creates_a_member_in_the_defaults_but_not_a_guest(
    client: AsyncClient, db: AsyncSession, setup: dict[str, Any]
) -> None:
    await _lines_on(db)
    created = await client.post(
        f"{API}/admin/users", json={"username": "hanako", "display_name": "花子"}
    )
    assert created.status_code == 201, created.text
    uid = created.json()["user"]["id"]
    assert await _channels_of(db, uid) == {setup["notices"], setup["lounge"]}
    lines = await _system_lines(db, setup["lounge"])
    assert lines[-1][0] == "花子 が参加しました"
    assert lines[-1][1] == {"kind": "member_joined", "actor_id": uid, "user_ids": [uid]}
    # Their read position is after their own line.
    read = await db.execute(
        text("SELECT last_read_seq FROM read_states WHERE user_id = :u AND channel_id = :c"),
        {"u": uid, "c": setup["lounge"]},
    )
    seq = await db.execute(
        text("SELECT last_seq FROM channels WHERE id = :c"), {"c": setup["lounge"]}
    )
    assert read.scalar_one() == seq.scalar_one()

    guest = await client.post(
        f"{API}/admin/users",
        json={"username": "visitor", "display_name": "Visitor", "role": "guest"},
    )
    assert guest.status_code == 201
    assert await _channels_of(db, guest.json()["user"]["id"]) == set()
    admin_made = await client.post(
        f"{API}/admin/users", json={"username": "boss2", "display_name": "Boss", "role": "admin"}
    )
    assert await _channels_of(db, admin_made.json()["user"]["id"]) == {
        setup["notices"],
        setup["lounge"],
    }


async def test_join_lines_follow_the_m88_setting(
    client: AsyncClient, db: AsyncSession, setup: dict[str, Any]
) -> None:
    # The tests start with the lines off.
    created = await client.post(
        f"{API}/admin/users", json={"username": "quiet", "display_name": "Q"}
    )
    assert await _channels_of(db, created.json()["user"]["id"]) == {
        setup["notices"],
        setup["lounge"],
    }
    assert await _system_lines(db, setup["notices"]) == []


async def test_cli_create_user_and_admin_join_the_defaults(
    app: FastAPI,
    db: AsyncSession,
    setup: dict[str, Any],
    test_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app import cli
    from app.core import settings as settings_module

    monkeypatch.setattr(settings_module, "get_settings", lambda: test_settings)
    await cli._insert_user(
        username="cliadmin",
        display_name="CLI",
        password="correct horse battery",
        role="admin",
        must_change_password=False,
    )
    await cli._insert_user(
        username="cliguest",
        display_name="G",
        password=None,
        role="guest",
        must_change_password=True,
    )
    people = {
        u.username: u.id
        for u in (await db.execute(select(User))).scalars().all()
        if u.username.startswith("cli")
    }
    assert await _channels_of(db, people["cliadmin"]) == {setup["notices"], setup["lounge"]}
    assert await _channels_of(db, people["cliguest"]) == set()


async def test_invite_acceptance_joins_defaults_and_invite_channels_once(
    app: FastAPI, client: AsyncClient, db: AsyncSession, setup: dict[str, Any]
) -> None:
    await _lines_on(db)
    issued = await client.post(
        f"{API}/admin/invites", json={"channel_ids": [setup["lounge"], setup["other"]]}
    )
    guest_issued = await client.post(
        f"{API}/admin/invites", json={"channel_ids": [setup["other"]], "role": "guest"}
    )
    assert guest_issued.status_code == 201, guest_issued.text
    app.dependency_overrides.pop(get_current_user, None)
    accept = {
        "username": "tanaka",
        "display_name": "田中",
        "password": "correct horse battery",
        "device": {"platform": "ios"},
    }
    done = await client.post(f"{API}/invites/{issued.json()['token']}/accept", json=accept)
    assert done.status_code == 201, done.text
    uid = done.json()["user"]["id"]
    assert await _channels_of(db, uid) == {setup["notices"], setup["lounge"], setup["other"]}
    assert [b for b, _ in await _system_lines(db, setup["lounge"])] == ["田中 が参加しました"]

    done = await client.post(
        f"{API}/invites/{guest_issued.json()['token']}/accept",
        json={**accept, "username": "guest1"},
    )
    assert done.status_code == 201, done.text
    assert await _channels_of(db, done.json()["user"]["id"]) == {setup["other"]}


async def test_bots_and_imports_never_join(db: AsyncSession, setup: dict[str, Any]) -> None:
    bot = await admin.create_bot_in_tx(
        db, actor_id=setup["root"].id, username="hook-bot", display_name="Hook"
    )
    imported = await admin.create_user_in_tx(
        db,
        AdminUserCreate(username="imported", display_name="Imported"),
        password_hash=None,
        must_change_password=True,
        actor_id=setup["root"].id,
        join_default_channels=False,
    )
    await db.commit()
    assert await _channels_of(db, bot.id) == set()
    assert await _channels_of(db, imported.id) == set()


async def test_an_archived_or_private_default_is_dropped_and_a_stale_one_skipped(
    client: AsyncClient, db: AsyncSession, setup: dict[str, Any]
) -> None:
    assert (await client.post(f"{API}/channels/{setup['notices']}/archive")).status_code == 200
    got = (await client.get(SETTINGS)).json()
    assert got["default_channel_ids"] == [setup["lounge"]]
    raw = await db.execute(text("SELECT default_channel_ids FROM workspace_settings"))
    stored: list[uuid.UUID] = raw.scalar_one()
    assert [str(i) for i in stored] == [setup["lounge"]]
    dropped = (
        (await db.execute(select(AuditLog).where(AuditLog.action == "workspace.settings_updated")))
        .scalars()
        .all()
    )
    assert dropped[-1].details["reason"] == "channel_archived"
    # Unarchiving does not put it back.
    assert (await client.post(f"{API}/channels/{setup['notices']}/unarchive")).status_code == 200
    assert (await client.get(SETTINGS)).json()["default_channel_ids"] == [setup["lounge"]]

    # Made private: dropped too.
    await _set_defaults(client, [setup["lounge"], setup["other"]])
    made = await client.patch(f"{API}/channels/{setup['other']}", json={"type": "private"})
    assert made.status_code == 200, made.text
    assert (await client.get(SETTINGS)).json()["default_channel_ids"] == [setup["lounge"]]

    # A row changed behind the application's back (or a deleted channel) is skipped at use time.
    await _set_defaults(client, [setup["lounge"], setup["notices"]])
    await db.execute(
        text("UPDATE channels SET archived_at = now() WHERE id = :c"), {"c": setup["notices"]}
    )
    await db.execute(
        text(
            "UPDATE workspace_settings SET default_channel_ids = "
            "array_append(default_channel_ids, :gone)"
        ),
        {"gone": uuid.uuid4()},
    )
    await db.commit()
    created = await client.post(
        f"{API}/admin/users", json={"username": "late", "display_name": "L"}
    )
    assert created.status_code == 201, created.text
    assert await _channels_of(db, created.json()["user"]["id"]) == {setup["lounge"]}
    assert (await client.get(SETTINGS)).json()["default_channel_ids"] == [setup["lounge"]]


async def test_apply_to_everyone_is_idempotent_with_one_line_per_channel(
    client: AsyncClient, db: AsyncSession, setup: dict[str, Any]
) -> None:
    root = setup["root"]
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await make_user(db, "visitor", role="guest")
    await make_user(db, "robot", role="bot")
    gone = await make_user(db, "gone")
    gone.deactivated_at = gone.created_at
    await db.commit()
    await _lines_on(db)
    # Bob is already in the lounge.
    await db.execute(
        text("INSERT INTO channel_members (channel_id, user_id, role) VALUES (:c, :u, 'member')"),
        {"c": setup["lounge"], "u": bob.id},
    )
    await db.commit()

    dry = (await client.post(APPLY, json={"dry_run": True})).json()
    assert dry == {
        "dry_run": True,
        "users": 2,
        "memberships": 3,
        "channels": [
            {"id": setup["notices"], "name": "全体連絡", "added": 2},
            {"id": setup["lounge"], "name": "談話スペース", "added": 1},
        ],
    }
    assert await _channels_of(db, alice.id) == set()  # nothing changed

    done = await client.post(APPLY, json={})
    assert done.status_code == 200, done.text
    assert done.json()["memberships"] == 3 and done.json()["dry_run"] is False
    for user in (alice, bob):
        assert await _channels_of(db, user.id) == {setup["notices"], setup["lounge"]}
    notices_lines = await _system_lines(db, setup["notices"])
    assert notices_lines == [
        (
            "Root が Alice、Bob を追加しました",
            {
                "kind": "members_added",
                "actor_id": str(root.id),
                "user_ids": [str(alice.id), str(bob.id)],
            },
        )
    ]
    assert [b for b, _ in await _system_lines(db, setup["lounge"])] == [
        "Root が Alice を追加しました"
    ]
    for name in ("visitor", "robot", "gone"):
        person = (await db.execute(select(User).where(User.username == name))).scalar_one()
        assert await _channels_of(db, person.id) == set()
    audit = (
        await db.execute(
            select(AuditLog).where(AuditLog.action == "workspace.default_channels_applied")
        )
    ).scalar_one()
    assert audit.details["memberships"] == 3 and audit.actor_id == root.id

    again = (await client.post(APPLY, json={})).json()
    assert again["users"] == 0 and again["memberships"] == 0
    assert len(await _system_lines(db, setup["notices"])) == 1
    assert len(await _system_lines(db, setup["lounge"])) == 1
    audits = await db.execute(
        select(AuditLog).where(AuditLog.action == "workspace.default_channels_applied")
    )
    assert len(audits.scalars().all()) == 1
    assert (await client.post(APPLY, json={"unknown": 1})).status_code == 422


async def test_a_reactivated_account_is_not_added_again(
    client: AsyncClient, db: AsyncSession, setup: dict[str, Any]
) -> None:
    created = await client.post(
        f"{API}/admin/users", json={"username": "back", "display_name": "B"}
    )
    uid = created.json()["user"]["id"]
    await db.execute(
        text("DELETE FROM channel_members WHERE user_id = :u AND channel_id = :c"),
        {"u": uid, "c": setup["lounge"]},
    )
    await db.commit()
    for flag in (True, False):
        response = await client.patch(f"{API}/admin/users/{uid}", json={"deactivated": flag})
        assert response.status_code == 200
    assert await _channels_of(db, uid) == {setup["notices"]}


def test_a_long_list_of_names_is_summarized() -> None:
    names = [f"P{i}" for i in range(13)]
    assert membership_text("members_added", "A", names[:10]).count("、") == 9
    assert membership_text("members_added", "A", names) == (
        "A が P0、P1、P2、P3、P4、P5、P6、P7、P8、P9 ほか 3 人 を追加しました"
    )


async def test_without_defaults_nobody_joins_anything(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await _channel(client, "general")
    created = await client.post(
        f"{API}/admin/users", json={"username": "solo", "display_name": "S"}
    )
    assert await _channels_of(db, created.json()["user"]["id"]) == set()
    assert (await client.post(APPLY, json={})).json() == {
        "dry_run": False,
        "users": 0,
        "memberships": 0,
        "channels": [],
    }
    assert (await db.execute(select(Channel))).first() is not None
