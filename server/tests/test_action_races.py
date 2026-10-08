"""操作ボタン: a change of a button or the switch racing a press or a state read (docs/ACTIONS.md
§4.1, §12.6). The await points are held with events so the order is fixed: a press is sent only as
it was allowed, and a state read under an earlier configuration reaches neither the cache, nor
the people waiting for it, nor `actions.status_updated`."""

import asyncio
import json
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.actions import service, status
from app.modules.actions.models import Action, ActionInvocation
from app.modules.audit.models import AuditLog
from app.modules.groups.models import UserGroup, UserGroupMember
from app.modules.outbound import signed
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_actions import SECRET, _create, _enable, _json, _press

OTHER_URL = "https://other-relay.example.com/taylis"
SECRET_STATE = {"status": {"text": "CONFIDENTIAL faculty device state", "tone": "ok"}}
PUBLIC_STATE = {"status": {"text": "Public lab: locked", "tone": "ok", "state": "locked"}}


class HeldRelay:
    """Records every post. A post whose body contains `hold` waits for `release` (and `reached` is
    set when it starts); answers come from `answers` by URL (default 200, no body)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.answers: dict[str, signed.Answer] = {}
        self.hold: str | None = None
        self.held_answer: signed.Answer = signed.Answer(200)
        self.reached = asyncio.Event()
        self.release = asyncio.Event()

    async def __call__(self, url: str, headers: dict[str, str], body: bytes) -> signed.Answer:
        sent = json.loads(body)
        self.calls.append((url, sent))
        if self.hold is not None and self.hold in body.decode():
            self.hold = None
            self.reached.set()
            await self.release.wait()
            return self.held_answer
        return self.answers.get(url, signed.Answer(200))

    def of_type(self, kind: str) -> list[tuple[str, dict[str, Any]]]:
        return [(url, sent) for url, sent in self.calls if sent["type"] == kind]


@pytest.fixture
def relay(app: FastAPI, tmp_path: Path) -> HeldRelay:
    (tmp_path / "door").write_text(SECRET + "\n")
    (tmp_path / "other").write_text(SECRET + "-other\n")
    app.state.settings = app.state.settings.model_copy(
        update={"action_secrets_dir": str(tmp_path), "action_status_after_invoke_seconds": 0.0}
    )
    fake = HeldRelay()
    app.state.action_poster = fake
    return fake


class Gate:
    """Holds one await point of the service until released."""

    def __init__(self) -> None:
        self.reached = asyncio.Event()
        self.release = asyncio.Event()

    async def wait(self) -> None:
        self.reached.set()
        await self.release.wait()


def _hold_before(monkeypatch: pytest.MonkeyPatch, name: str, gate: Gate) -> None:
    """Holds the first call of service.<name> until the gate opens."""
    original: Callable[..., Awaitable[Any]] = getattr(service, name)
    held = {"done": False}

    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        if not held["done"]:
            held["done"] = True
            await gate.wait()
        return await original(*args, **kwargs)

    monkeypatch.setattr(service, name, wrapper)


# --- a press: sent only as it was allowed (§4.1) ------------------------------------------


async def _faculty(db: AsyncSession, root: User, *members: User) -> UserGroup:
    group = UserGroup(name=f"g-{uuid.uuid4().hex[:6]}", created_by=root.id)
    db.add(group)
    await db.flush()
    for member in members:
        db.add(UserGroupMember(group_id=group.id, user_id=member.id))
    await db.commit()
    return group


CHANGES = ["url", "action_key", "roles", "groups", "membership", "button_off", "switch_off"]


@pytest.mark.parametrize(
    "hold_at", ["_settle_repeat", "_send"]
)  # after the check / the pending row
@pytest.mark.parametrize("change", CHANGES)
async def test_a_change_after_the_press_was_allowed_stops_it(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: HeldRelay,
    monkeypatch: pytest.MonkeyPatch,
    change: str,
    hold_at: str,
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    lab = await _faculty(db, root, alice)
    other = await _faculty(db, root)
    as_user(root)
    await _enable(client)
    via_group = change in ("groups", "membership")
    door = await _create(
        client,
        allowed_roles=[] if via_group else ["member"],
        allowed_group_ids=[str(lab.id)] if via_group else [],
    )
    gate = Gate()
    _hold_before(monkeypatch, hold_at, gate)

    key = uuid.uuid4()
    as_user(alice)
    pressing = asyncio.create_task(_press(client, door["id"], key))
    await asyncio.wait_for(gate.reached.wait(), 5)

    as_user(root)
    patches: dict[str, dict[str, Any]] = {
        "url": {"url": OTHER_URL, "secret_name": "other"},
        "action_key": {"action_key": "faculty.unlock"},
        "roles": {"allowed_roles": ["admin"]},
        "groups": {"allowed_group_ids": [str(other.id)]},
        "button_off": {"enabled": False},
    }
    patch = patches.get(change, {})
    if patch:
        changed = await client.patch(f"/api/v1/admin/actions/{door['id']}", json=patch)
        assert changed.status_code == 200, changed.text
    elif change == "membership":
        await db.execute(delete(UserGroupMember).where(UserGroupMember.user_id == alice.id))
        await db.commit()
    else:
        off = await client.patch("/api/v1/admin/actions/settings", json={"enabled": False})
        assert off.status_code == 200
    gate.release.set()
    pressed = await pressing

    assert pressed.status_code == 200, pressed.text
    out = pressed.json()
    assert out["ok"] is False and out["status"] == "failed"
    assert out["error"] == "action_changed" and out["status_code"] is None
    assert relay.calls == []  # nothing signed, nothing sent
    row = await db.scalar(select(ActionInvocation).where(ActionInvocation.client_invoke_id == key))
    assert row is not None and row.status == "failed" and row.error == "action_changed"
    assert row.finished_at is not None
    audit = await db.scalar(
        select(AuditLog).where(
            AuditLog.action == "action.invoked", AuditLog.target_id == door["id"]
        )
    )
    assert audit is not None and audit.details["error"] == "action_changed"

    # The same press again (a network retry) never sends it later, even once allowed again.
    if change == "switch_off":
        as_user(root)
        await _enable(client)
    elif change == "button_off":
        as_user(root)
        await client.patch(f"/api/v1/admin/actions/{door['id']}", json={"enabled": True})
    elif change in ("roles", "groups", "membership"):
        as_user(root)
        await client.patch(
            f"/api/v1/admin/actions/{door['id']}",
            json={"allowed_roles": ["member"], "allowed_group_ids": []},
        )
    as_user(alice)
    again = await _press(client, door["id"], key)
    assert again.status_code == 200, again.text
    assert again.json()["repeated"] is True and again.json()["error"] == "action_changed"
    assert relay.calls == []


async def test_a_change_that_does_not_touch_what_is_sent_or_who_may_press_does_not_stop_it(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: HeldRelay,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _enable(client)
    door = await _create(client, allowed_roles=["member"])
    gate = Gate()
    _hold_before(monkeypatch, "_send", gate)
    as_user(alice)
    pressing = asyncio.create_task(_press(client, door["id"]))
    await asyncio.wait_for(gate.reached.wait(), 5)
    as_user(root)
    renamed = await client.patch(
        f"/api/v1/admin/actions/{door['id']}", json={"name": "解錠", "confirm": False}
    )
    assert renamed.status_code == 200
    gate.release.set()
    pressed = await pressing
    assert pressed.json()["ok"] is True
    [(url, sent)] = relay.of_type("action.invoked")
    assert url == "https://relay.example.com/taylis" and sent["action_key"] == "lab-door.unlock"


async def test_the_button_deleted_while_a_press_waits(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: HeldRelay,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _enable(client)
    door = await _create(client, allowed_roles=["member"])
    gate = Gate()
    _hold_before(monkeypatch, "_send", gate)
    as_user(alice)
    pressing = asyncio.create_task(_press(client, door["id"]))
    await asyncio.wait_for(gate.reached.wait(), 5)
    as_user(root)
    assert (await client.delete(f"/api/v1/admin/actions/{door['id']}")).status_code == 204
    gate.release.set()
    pressed = await pressing
    assert pressed.status_code == 404
    assert pressed.json()["error"]["code"] == "action_not_found"
    assert relay.calls == []


# --- a state read: an answer of an earlier configuration is dropped (§12.6) ---------------


async def _private_source(client: AsyncClient) -> dict[str, Any]:
    """The faculty room's lock, its state visible to administrators only."""
    return await _create(
        client,
        name="教員室",
        group_label="Private faculty room",
        action_key="faculty.lock",
        allowed_roles=["admin"],
        provides_status=True,
    )


PUBLIC = {
    "group_label": "Public lab",
    "action_key": "public.lab",
    "url": OTHER_URL,
    "secret_name": "other",
    "allowed_roles": ["member", "admin"],
}


async def _status_events(db: AsyncSession) -> list[OutboxEvent]:
    rows = await db.execute(
        select(OutboxEvent).where(OutboxEvent.event_type == "actions.status_updated")
    )
    return list(rows.scalars().all())


async def test_a_state_read_reconfigured_mid_await_is_not_used(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: HeldRelay,
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _enable(client)
    source = await _private_source(client)
    relay.hold = "faculty.lock"
    relay.held_answer = _json(200, SECRET_STATE)
    relay.answers[OTHER_URL] = _json(200, PUBLIC_STATE)

    # The administrator's read waits on the old relay; someone else of the same generation joins.
    reading = asyncio.create_task(client.get("/api/v1/actions/status"))
    await asyncio.wait_for(relay.reached.wait(), 5)
    joining = asyncio.create_task(client.get("/api/v1/actions/status"))
    await asyncio.sleep(0.05)
    assert len(relay.calls) == 1

    changed = await client.patch(f"/api/v1/admin/actions/{source['id']}", json=PUBLIC)
    assert changed.status_code == 200

    # A new viewer does not wait for the old read: their own, of the new button.
    as_user(alice)
    asked = await asyncio.wait_for(client.get("/api/v1/actions/status"), timeout=5)
    fresh = asked.json()["statuses"]
    assert [s["status"]["text"] for s in fresh] == ["Public lab: locked"]
    assert fresh[0]["group_label"] == "Public lab"

    relay.release.set()
    for response in (await reading, await joining):
        assert response.status_code == 200
        assert "CONFIDENTIAL" not in response.text and "Private faculty room" not in response.text
        assert response.json()["statuses"][0]["status"]["text"] == "Public lab: locked"

    seen = (await client.get("/api/v1/actions/status")).text
    assert "CONFIDENTIAL" not in seen and "Public lab: locked" in seen
    cache = app.state.action_status
    assert all("CONFIDENTIAL" not in e.out.model_dump_json() for e in cache.entries.values())
    assert cache.inflight == {}
    assert all("CONFIDENTIAL" not in json.dumps(e.payload) for e in await _status_events(db))
    # The old relay was asked once (before the change); every later read went to the new one.
    first, *later = [url for url, _ in relay.of_type("action.status")]
    assert first == "https://relay.example.com/taylis" and set(later) == {OTHER_URL}


async def test_the_re_read_after_a_press_reconfigured_mid_await_is_not_sent(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: HeldRelay,
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await _enable(client)
    source = await _private_source(client)
    relay.hold = "action.status"
    relay.held_answer = _json(200, SECRET_STATE)
    pressed = await _press(client, source["id"])
    assert pressed.json()["ok"] is True
    await asyncio.wait_for(relay.reached.wait(), 5)  # the re-read is asking the old relay

    changed = await client.patch(f"/api/v1/admin/actions/{source['id']}", json=PUBLIC)
    assert changed.status_code == 200
    relay.release.set()
    await app.state.action_status.drain()

    assert await _status_events(db) == []
    cache = app.state.action_status
    assert cache.entries == {} and cache.inflight == {}


async def test_a_state_read_whose_button_changed_before_the_cache_heard_is_not_sent(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: HeldRelay,
) -> None:
    """The change is committed but forget() has not run yet: the event is still not written."""
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await _enable(client)
    made = await _private_source(client)
    row = await db.get(Action, uuid.UUID(made["id"]))
    assert row is not None
    old = status.Source.of(row)
    await db.execute(
        update(Action).where(Action.id == row.id).values(url=OTHER_URL, action_key="public.lab")
    )
    await db.commit()
    relay.answers["https://relay.example.com/taylis"] = _json(200, SECRET_STATE)
    cache = app.state.action_status
    await status.fetch(
        cache,
        app.state.db.session_factory,
        old,
        {"id": str(root.id)},
        app.state.settings,
        relay,
        generation=cache.generation,
        refresh=True,
        announce=True,
    )
    assert await _status_events(db) == []


async def test_an_event_written_before_its_button_changed_goes_to_nobody(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: HeldRelay,
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _enable(client)
    source = await _private_source(client)
    relay.answers["https://relay.example.com/taylis"] = _json(200, SECRET_STATE)
    assert (await _press(client, source["id"])).json()["ok"] is True
    await app.state.action_status.drain()
    [event] = await _status_events(db)
    before = await app.state.relay.resolve_audience(db, event)
    assert root.id in before.ids and alice.id not in before.ids

    # Changed (now public) before the relay delivered it: the old state goes to nobody.
    assert (
        await client.patch(f"/api/v1/admin/actions/{source['id']}", json=PUBLIC)
    ).status_code == 200
    async with app.state.db.session_factory() as fresh:
        after = await app.state.relay.resolve_audience(fresh, event)
    assert after.ids == () and alice.id not in after.ids
