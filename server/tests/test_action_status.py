"""The state of what the 操作ボタン operate (M143, docs/ACTIONS.md §12): one status button per
group, the signed `action.status` request, the cleaned answer, the cache and the refresh limit,
who sees which group, the re-read after a press and `actions.status_updated`."""

import asyncio
import hashlib
import hmac
import json
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ratelimit import RateLimiter
from app.events.models import OutboxEvent
from app.modules.actions import status
from app.modules.actions.models import ActionInvocation
from app.modules.audit.models import AuditLog
from app.modules.groups.models import UserGroup, UserGroupMember
from app.modules.outbound import signed
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_actions import SECRET, FakeRelay, _create, _enable, _json, _press

LOCKED = {
    "status": {
        "text": "施錠中・ドア閉",
        "tone": "ok",
        "state": "locked",
        "details": [{"label": "電池", "value": "85%"}],
    }
}
OPEN = {"status": {"text": "解錠中", "tone": "warn", "state": "unlocked"}}


@pytest.fixture
def relay(app: FastAPI, tmp_path: Path) -> FakeRelay:
    (tmp_path / "door").write_text(SECRET + "\n")
    app.state.settings = app.state.settings.model_copy(
        update={"action_secrets_dir": str(tmp_path), "action_status_after_invoke_seconds": 0.0}
    )
    fake = FakeRelay()
    app.state.action_poster = fake
    return fake


async def _statuses(client: AsyncClient, *, refresh: bool = False) -> Any:
    url = "/api/v1/actions/status" + ("?refresh=true" if refresh else "")
    return await client.get(url)


def _status_calls(relay: FakeRelay) -> list[dict[str, Any]]:
    return [json.loads(body) for _, _, body in relay.calls if b'"action.status"' in body]


# --- the answer ----------------------------------------------------------------------------


def test_parse_status() -> None:
    parsed = status.parse_status(
        {
            "text": " 施錠中\n・ドア閉 " + "あ" * 100,
            "tone": "bright",
            "state": "Locked",
            "details": [{"label": "電池", "value": "85%"}, {"label": "", "value": "x"}, "junk"]
            + [{"label": f"l{i}", "value": "v"} for i in range(10)],
        }
    )
    assert parsed is not None
    assert parsed.text.startswith("施錠中 ・ドア閉 あ") and len(parsed.text) == 80
    assert parsed.tone == "neutral" and parsed.state == "locked"
    assert [d.label for d in parsed.details] == ["電池", "l0", "l1", "l2", "l3", "l4"]
    assert status.parse_status({"text": "", "tone": "ok"}) is None
    assert status.parse_status({"tone": "ok"}) is None
    assert status.parse_status("locked") is None
    weird = status.parse_status({"text": "?", "tone": "alert", "state": "<b>x</b>"})
    assert weird is not None and weird.state is None and weird.tone == "alert"


# --- one status button per group -----------------------------------------------------------


async def test_one_status_button_per_group(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    opener = await _create(client, provides_status=True)
    assert opener["provides_status"] is True
    taken = await client.post(
        "/api/v1/admin/actions",
        json={
            "name": "閉める",
            "group_label": "研究室の鍵",
            "action_key": "lab-door.lock",
            "url": "https://relay.example.com/taylis",
            "secret_name": "door",
            "provides_status": True,
        },
    )
    assert taken.status_code == 409
    assert taken.json()["error"]["code"] == "action_status_source_taken"
    closer = await _create(client, name="閉める", action_key="lab-door.lock")
    refused = await client.patch(
        f"/api/v1/admin/actions/{closer['id']}", json={"provides_status": True}
    )
    assert refused.status_code == 409
    # Another group, and buttons without a group (each its own), may each have one.
    other = await _create(client, group_label="教授室の鍵", provides_status=True)
    loose = [await _create(client, group_label=None, provides_status=True) for _ in range(2)]
    assert all(b["provides_status"] for b in loose)
    # Moving a status button into a group that has one is refused too.
    moved = await client.patch(
        f"/api/v1/admin/actions/{other['id']}", json={"group_label": "研究室の鍵"}
    )
    assert moved.status_code == 409
    # Handing it over: off on one, then on on the other.
    await client.patch(f"/api/v1/admin/actions/{opener['id']}", json={"provides_status": False})
    handed = await client.patch(
        f"/api/v1/admin/actions/{closer['id']}", json={"provides_status": True}
    )
    assert handed.status_code == 200 and handed.json()["provides_status"] is True


# --- reading the state ---------------------------------------------------------------------


async def test_the_signed_status_request_and_cache(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: FakeRelay,
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    door = await _create(client, provides_status=True)
    await _create(client, name="閉める", action_key="lab-door.lock")

    as_user(alice)
    off = (await _statuses(client)).json()
    assert off == {"enabled": False, "statuses": []} and relay.calls == []

    as_user(root)
    await _enable(client)
    as_user(alice)
    relay.answers.append(_json(200, LOCKED))
    listed = (await client.get("/api/v1/actions")).json()["actions"]
    assert [a["provides_status"] for a in listed] == [True, False]
    out = (await _statuses(client)).json()
    assert out["enabled"] is True
    [entry] = out["statuses"]
    assert entry["action_id"] == door["id"] and entry["group_label"] == "研究室の鍵"
    assert entry["ok"] is True and entry["error"] is None and entry["message"] is None
    assert entry["status"] == {
        "text": "施錠中・ドア閉",
        "tone": "ok",
        "state": "locked",
        "details": [{"label": "電池", "value": "85%"}],
    }
    assert entry["fetched_at"].endswith("Z")

    [(url, headers, body)] = relay.calls
    assert url == "https://relay.example.com/taylis"
    assert headers["X-Taylis-Event"] == "action.status"
    timestamp = headers["X-Taylis-Timestamp"]
    expected = hmac.new(SECRET.encode(), timestamp.encode() + b"." + body, hashlib.sha256)
    assert headers["X-Taylis-Signature"] == "sha256=" + expected.hexdigest()
    sent = json.loads(body)
    assert sent["type"] == "action.status" and sent["request_id"] == headers["X-Taylis-Delivery"]
    assert sent["action_id"] == door["id"] and sent["action_key"] == "lab-door.unlock"
    assert sent["user"]["username"] == "alice" and sent["at"].endswith("Z")
    assert "invoke_id" not in sent

    # From the cache: the relay is not asked again however many look.
    bob = await make_user(db, "bob")
    as_user(bob)
    assert (await _statuses(client)).json()["statuses"][0]["status"]["state"] == "locked"
    assert len(relay.calls) == 1

    # A refresh asks now; a second one at once is refused.
    relay.answers.append(_json(200, OPEN))
    fresh = (await _statuses(client, refresh=True)).json()["statuses"][0]
    assert fresh["status"]["state"] == "unlocked" and len(relay.calls) == 2
    again = await _statuses(client, refresh=True)
    assert again.status_code == 429 and again.json()["error"]["code"] == "rate_limited"
    # Someone else's refresh is their own.
    as_user(alice)
    assert (await _statuses(client, refresh=True)).status_code == 200

    # Not presses: nothing recorded or audited.
    assert await db.scalar(select(func.count()).select_from(ActionInvocation)) == 0
    assert (
        await db.scalar(
            select(func.count()).select_from(AuditLog).where(AuditLog.action == "action.invoked")
        )
        == 0
    )

    # The cache expires.
    app.state.action_status.forget()
    relay.answers.append(_json(200, LOCKED))
    assert (await _statuses(client)).json()["statuses"][0]["status"]["state"] == "locked"


async def test_failures(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: FakeRelay,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await _enable(client)
    await _create(client, provides_status=True)
    cache = app.state.action_status

    relay.answers.append(_json(503, {"message": "ハブがオフラインです"}))
    warnings: list[str] = []
    monkeypatch.setattr(status.log, "warning", lambda msg, *args: warnings.append(msg % args))
    failed = (await _statuses(client)).json()["statuses"][0]
    assert failed["ok"] is False and failed["status"] is None
    assert failed["error"] == "relay_error" and failed["message"] == "ハブがオフラインです"
    assert len(warnings) == 1 and "relay_error" in warnings[0]

    cache.forget()
    relay.answers.append(_json(200, {"status": {"tone": "ok"}}))
    invalid = (await _statuses(client)).json()["statuses"][0]
    assert invalid["ok"] is False and invalid["error"] == "invalid_answer"

    cache.forget()
    relay.answers.append(signed.Answer(None, "timeout"))
    timed_out = (await _statuses(client)).json()["statuses"][0]
    assert timed_out["error"] == "timeout"

    cache.forget()
    gone = {"action_secrets_dir": "/nonexistent"}
    app.state.settings = app.state.settings.model_copy(update=gone)
    calls = len(relay.calls)
    missing = (await _statuses(client)).json()["statuses"][0]
    assert missing["error"] == "secret_missing" and len(relay.calls) == calls


async def test_many_lookers_ask_once(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await _enable(client)
    await _create(client, provides_status=True)
    relay.delay = 0.2
    relay.answers.append(_json(200, LOCKED))
    results = await asyncio.gather(*(_statuses(client) for _ in range(4)))
    assert all(r.json()["statuses"][0]["status"]["state"] == "locked" for r in results)
    assert len(relay.calls) == 1


async def test_who_sees_which_group(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    prof = await make_user(db, "prof")
    guest = await make_user(db, "guest", role="guest")
    faculty = UserGroup(name="faculty", created_by=root.id)
    db.add(faculty)
    await db.flush()
    db.add(UserGroupMember(group_id=faculty.id, user_id=prof.id))
    await db.commit()

    as_user(root)
    await _enable(client)
    # The lab door: members press 開ける; its state comes from an admins-only button.
    lab_state = await _create(
        client, name="状態", action_key="lab-door.status", allowed_roles=["admin"]
    )
    await client.patch(f"/api/v1/admin/actions/{lab_state['id']}", json={"provides_status": True})
    await _create(client, allowed_roles=["member"])
    # The professor's door: the professor's group only.
    prof_door = await _create(
        client,
        group_label="教授室の鍵",
        action_key="prof-door.unlock",
        allowed_roles=[],
        allowed_group_ids=[str(faculty.id)],
        provides_status=True,
    )
    # A turned-off status button provides nothing.
    off = await _create(client, group_label="照明", action_key="light", provides_status=True)
    await client.patch(f"/api/v1/admin/actions/{off['id']}", json={"enabled": False})

    for _ in range(4):
        relay.answers.append(_json(200, LOCKED))

    async def seen(user: User) -> list[str]:
        as_user(user)
        return [s["action_id"] for s in (await _statuses(client)).json()["statuses"]]

    assert await seen(alice) == [lab_state["id"]]
    assert await seen(prof) == [lab_state["id"], prof_door["id"]]
    assert await seen(guest) == []
    assert await seen(root) == [lab_state["id"]]

    viewers = set(await status.viewers(db, uuid.UUID(prof_door["id"])))
    assert viewers == {prof.id}
    lab_viewers = set(await status.viewers(db, uuid.UUID(lab_state["id"])))
    assert {alice.id, prof.id, root.id} <= lab_viewers and guest.id not in lab_viewers


async def test_after_a_press_the_state_is_read_again_and_sent(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: FakeRelay,
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    outsider = await make_user(db, "outsider", role="manager")
    as_user(root)
    await _enable(client)
    door = await _create(client, allowed_roles=["member", "admin"], provides_status=True)
    closer = await _create(
        client, name="閉める", action_key="lab-door.lock", allowed_roles=["member", "admin"]
    )

    as_user(alice)
    relay.answers.append(_json(200, OPEN))
    assert (await _statuses(client)).json()["statuses"][0]["status"]["state"] == "unlocked"
    relay.answers += [_json(200, {"message": "施錠しました"}), _json(200, LOCKED)]
    pressed = await _press(client, closer["id"])
    assert pressed.json()["ok"] is True
    await app.state.action_status.drain()
    kinds = [json.loads(body)["type"] for _, _, body in relay.calls]
    assert kinds == ["action.status", "action.invoked", "action.status"]
    # The status request names the group's status button (not the one pressed).
    assert _status_calls(relay)[-1]["action_id"] == door["id"]

    [event] = (
        (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.event_type == "actions.status_updated")
            )
        )
        .scalars()
        .all()
    )
    assert event.audience_type == "action" and event.audience_id == uuid.UUID(door["id"])
    assert event.payload["action_id"] == door["id"]
    assert event.payload["status"]["state"] == "locked" and event.payload["ok"] is True
    audience = await app.state.relay.resolve_audience(db, event)
    assert alice.id in audience.ids and root.id in audience.ids
    assert outsider.id not in audience.ids
    # The cache now holds the new state.
    assert (await _statuses(client)).json()["statuses"][0]["status"]["state"] == "locked"
    assert len(relay.calls) == 3

    # A failed press reads nothing again.
    relay.answers.append(_json(500, {}))
    app.state.limiters["action_invoke"] = RateLimiter(10_000)  # past the per-button press limit
    assert (await _press(client, closer["id"])).json()["ok"] is False
    await app.state.action_status.drain()
    assert len(relay.calls) == 4


async def test_a_changed_state_is_sent_and_an_unchanged_one_is_not(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: FakeRelay,
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await _enable(client)
    await _create(client, provides_status=True)
    cache = app.state.action_status

    async def events() -> int:
        count = await db.scalar(
            select(func.count())
            .select_from(OutboxEvent)
            .where(OutboxEvent.event_type == "actions.status_updated")
        )
        return int(count or 0)

    relay.answers.append(_json(200, LOCKED))
    await _statuses(client)
    assert await events() == 0  # the first read: nothing to compare with
    cache.entries[next(iter(cache.entries))].expires = 0
    relay.answers.append(_json(200, LOCKED))
    await _statuses(client)
    assert await events() == 0
    cache.entries[next(iter(cache.entries))].expires = 0
    relay.answers.append(_json(200, OPEN))
    await _statuses(client)
    assert await events() == 1
    # A failure is not sent out (the viewers keep the last state they were sent).
    cache.entries[next(iter(cache.entries))].expires = 0
    relay.answers.append(_json(503, {}))
    await _statuses(client)
    assert await events() == 1


async def test_the_admin_check(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    door = await _create(client, enabled=False)  # the feature off, the button off, no status
    relay.answers.append(_json(200, LOCKED))
    checked = await client.post(f"/api/v1/admin/actions/{door['id']}/status")
    assert checked.status_code == 200, checked.text
    assert checked.json()["status"]["text"] == "施錠中・ドア閉"
    assert _status_calls(relay)[0]["type"] == "action.status"
    missing = await client.post(f"/api/v1/admin/actions/{uuid.uuid4()}/status")
    assert missing.status_code == 404
    as_user(alice)
    assert (await client.post(f"/api/v1/admin/actions/{door['id']}/status")).status_code == 403
