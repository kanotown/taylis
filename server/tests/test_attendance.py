"""在室状況 (attendance, M140, docs/PRESENCE.md): states, the board, the log, events, webhooks
(signing, the outbox planner, retries, idempotency, SSRF) and the inbound API."""

import hashlib
import hmac
import importlib.util
import json
import uuid
from collections.abc import Callable
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.attendance import service, webhooks
from app.modules.attendance.models import AttendanceDelivery, AttendanceLog, AttendanceState
from app.modules.attendance.schemas import ICON_KEYS
from app.modules.channels.service import resolve_event_audience
from app.modules.users.models import User
from tests.helpers import make_user

SECRET = "0123456789abcdef0123456789abcdef"


async def _enable(client: AsyncClient, **extra: Any) -> dict[str, Any]:
    response = await client.patch(
        "/api/v1/admin/attendance/settings", json={"enabled": True, **extra}
    )
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


async def _drain(app: FastAPI) -> None:
    while await app.state.relay.process_batch():
        pass


async def _events(db: AsyncSession, event_type: str) -> list[OutboxEvent]:
    rows = await db.execute(
        select(OutboxEvent).where(OutboxEvent.event_type == event_type).order_by(OutboxEvent.id)
    )
    return list(rows.scalars().all())


def _state_id(settings: dict[str, Any], kind: str) -> str:
    return str(next(s["id"] for s in settings["states"] if s["kind"] == kind))


class FakeSender:
    """Records what would be posted; answers with the queued status codes (default 200)."""

    def __init__(self, *codes: int | None) -> None:
        self.codes = list(codes)
        self.calls: list[tuple[str, dict[str, str], bytes]] = []

    async def __call__(self, url: str, headers: dict[str, str], body: bytes) -> webhooks.SendResult:
        self.calls.append((url, headers, body))
        code = self.codes.pop(0) if self.codes else 200
        if code is None:
            return webhooks.SendResult(None, "timeout")
        return webhooks.SendResult(code, None if 200 <= code < 300 else "nope")


def _with_secrets(settings: Settings, folder: Path) -> Settings:
    (folder / "site").write_text(SECRET + "\n")
    return settings.model_copy(update={"attendance_webhook_secrets_dir": str(folder)})


# --- the switch, defaults, the board -------------------------------------------------------


async def test_off_by_default_then_enabled_with_default_states(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")

    as_user(alice)
    board = await client.get("/api/v1/attendance")
    assert board.status_code == 200 and board.json() == {
        "enabled": False,
        "states": [],
        "entries": [],
        "can_personalize": False,
    }
    assert (await client.get("/api/v1/sync/bootstrap")).json()["attendance"] is None
    denied = await client.patch("/api/v1/admin/attendance/settings", json={"enabled": True})
    assert denied.status_code == 403
    off = await client.put("/api/v1/attendance/me", json={"state_id": str(uuid.uuid4())})
    assert off.status_code == 409 and off.json()["error"]["code"] == "attendance_disabled"

    as_user(root)
    settings = await _enable(client)
    assert settings["enabled"] is True
    assert [(s["label"], s["kind"], s["color"], s["icon"]) for s in settings["states"]] == [
        ("在室", "in_room", "green", "in_room"),
        ("学内", "on_site", "blue", "on_site"),
        ("学外", "off_site", "purple", "off_site"),
        ("帰宅", "gone", "red", "gone"),
    ]
    # Turning it off and on again does not make a second set.
    await client.patch("/api/v1/admin/attendance/settings", json={"enabled": False})
    again = await _enable(client)
    assert len(again["states"]) == 4
    assert len(await _events(db, "attendance.config_updated")) == 3

    as_user(alice)
    booted = (await client.get("/api/v1/sync/bootstrap")).json()["attendance"]
    assert booted["enabled"] is True and len(booted["states"]) == 4
    assert booted["entries"] == [] and booted["can_personalize"] is False


async def test_english_admin_gets_english_defaults(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    root.locale = "en"
    await db.commit()
    as_user(root)
    settings = await _enable(client)
    assert [(s["label"], s["color"], s["icon"]) for s in settings["states"]] == [
        ("In the room", "green", "in_room"),
        ("On site", "blue", "on_site"),
        ("Off site", "purple", "off_site"),
        ("Gone home", "red", "gone"),
    ]


SHARED = Path(__file__).resolve().parents[2] / "apps" / "shared"
MIGRATION_0101 = (
    Path(__file__).resolve().parents[1] / "migrations" / "versions" / "0101_attendance_icons.py"
)


def test_icon_keys_match_the_shared_catalogue() -> None:
    """apps/shared/attendance-icons.json: the server takes exactly its keys; the defaults agree."""
    catalogue = json.loads((SHARED / "attendance-icons.json").read_text())
    assert tuple(icon["key"] for icon in catalogue["icons"]) == ICON_KEYS
    for icon in catalogue["icons"]:
        assert icon["lucide"] and icon["sf"] and icon["material"]
        assert set(icon["label"]) == {"ja", "en", "zh-Hans"}
    assert catalogue["defaults"] == {kind: icon for kind, icon, _e, _c in service.DEFAULT_STATES}


async def test_state_icons_are_validated_and_cleared(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _enable(client, personal_rule="everyone")

    unknown = await client.post(
        "/api/v1/admin/attendance/states",
        json={"label": "会議", "icon": "rocket", "kind": "on_site"},
    )
    assert unknown.status_code == 422
    made = await client.post(
        "/api/v1/admin/attendance/states",
        json={"label": "会議", "icon": "meeting", "emoji": "🗣️", "kind": "on_site"},
    )
    assert made.status_code == 201 and made.json()["icon"] == "meeting"
    path = f"/api/v1/admin/attendance/states/{made.json()['id']}"
    # Leaving icon out keeps it; null clears it (the emoji stays as the fallback).
    kept = await client.patch(path, json={"label": "会議中"})
    assert kept.json()["icon"] == "meeting"
    cleared = await client.patch(path, json={"icon": None})
    assert cleared.json()["icon"] is None and cleared.json()["emoji"] == "🗣️"
    assert (await client.patch(path, json={"icon": "Meeting"})).status_code == 422

    as_user(alice)
    mine = await client.post(
        "/api/v1/attendance/my-states", json={"label": "出張", "icon": "trip", "kind": "off_site"}
    )
    assert mine.status_code == 201 and mine.json()["icon"] == "trip"
    changed = await client.patch(
        f"/api/v1/attendance/my-states/{mine.json()['id']}", json={"icon": "vacation"}
    )
    assert changed.json()["icon"] == "vacation"
    empty = await client.post(
        "/api/v1/attendance/my-states", json={"label": "x", "icon": "", "kind": "gone"}
    )
    assert empty.status_code == 422
    board = (await client.get("/api/v1/attendance")).json()
    assert {s["label"]: s["icon"] for s in board["states"]}["出張"] == "vacation"


async def test_migration_backfills_only_untouched_default_states(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """0101: a workspace state still with its kind's default emoji gets the default icon (renamed
    or not); one whose emoji changed, and personal states, are left alone; colours never change."""
    spec = importlib.util.spec_from_file_location("migration_0101", MIGRATION_0101)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    settings = await _enable(client, personal_rule="everyone")
    ids = {s["kind"]: s["id"] for s in settings["states"]}
    admin_path = "/api/v1/admin/attendance/states"
    await client.patch(f"{admin_path}/{ids['in_room']}", json={"label": "部屋"})
    await client.patch(f"{admin_path}/{ids['off_site']}", json={"emoji": "🚗"})
    as_user(alice)
    own = await client.post(
        "/api/v1/attendance/my-states", json={"label": "家", "emoji": "🏠", "kind": "gone"}
    )
    assert own.status_code == 201, own.text
    # As before 0101: no icons anywhere, and an old colour.
    await db.execute(update(AttendanceState).values(icon=None))
    await db.execute(
        update(AttendanceState)
        .where(AttendanceState.id == uuid.UUID(ids["gone"]))
        .values(color="gray")
    )
    await db.commit()

    await db.execute(migration.BACKFILL)
    await db.commit()
    db.expire_all()
    rows = {
        str(row.id): (row.icon, row.color)
        for row in (await db.execute(select(AttendanceState))).scalars().all()
    }
    assert rows[ids["in_room"]] == ("in_room", "green")
    assert rows[ids["on_site"]] == ("on_site", "blue")
    assert rows[ids["off_site"]] == (None, "purple")
    assert rows[ids["gone"]] == ("gone", "gray")
    assert rows[str(own.json()["id"])][0] is None


async def test_set_my_state_log_events_and_since(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    guest = await make_user(db, "visitor", role="guest")
    as_user(root)
    settings = await _enable(client)
    in_room, gone = _state_id(settings, "in_room"), _state_id(settings, "gone")

    as_user(alice)
    first = await client.put("/api/v1/attendance/me", json={"state_id": in_room, "note": " 実験 "})
    assert first.status_code == 200, first.text
    entry = first.json()
    assert entry["state_id"] == in_room and entry["note"] == "実験" and entry["source"] == "app"
    # The same again: nothing happens (no event, no log row).
    same = await client.put("/api/v1/attendance/me", json={"state_id": in_room, "note": "実験"})
    assert same.json() == entry
    # Only the note: since stays.
    noted = (
        await client.put("/api/v1/attendance/me", json={"state_id": in_room, "note": "会議室"})
    ).json()
    assert noted["since"] == entry["since"] and noted["note"] == "会議室"
    moved = (await client.put("/api/v1/attendance/me", json={"state_id": gone})).json()
    assert moved["since"] > entry["since"] and moved["note"] is None

    events = await _events(db, "attendance.updated")
    assert [e.payload["state_id"] for e in events] == [in_room, in_room, gone]
    assert events[-1].payload["user_id"] == str(alice.id)
    # Everyone but guests receives them.
    audience = await resolve_event_audience(db, events[-1])
    assert alice.id in audience.ids and root.id in audience.ids and guest.id not in audience.ids

    log = (await client.get("/api/v1/attendance/log")).json()
    assert [(i["from_state_id"], i["to_state_id"]) for i in log["items"]] == [
        (in_room, gone),
        (in_room, in_room),
        (None, in_room),
    ]
    page = (await client.get("/api/v1/attendance/log?limit=2")).json()
    assert len(page["items"]) == 2 and page["next_before_id"] is not None
    rest = (
        await client.get(f"/api/v1/attendance/log?limit=2&before_id={page['next_before_id']}")
    ).json()
    assert len(rest["items"]) == 1 and rest["next_before_id"] is None

    board = (await client.get("/api/v1/attendance")).json()
    assert [(e["user_id"], e["state_id"]) for e in board["entries"]] == [(str(alice.id), gone)]
    # A state that is not mine cannot be chosen.
    bad = await client.put("/api/v1/attendance/me", json={"state_id": str(uuid.uuid4())})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "attendance_state_invalid"


async def test_guests_never_see_the_board(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    guest = await make_user(db, "visitor", role="guest")
    as_user(root)
    settings = await _enable(client)
    as_user(guest)
    assert (await client.get("/api/v1/attendance")).status_code == 403
    assert (await client.get("/api/v1/sync/bootstrap")).json()["attendance"] is None
    denied = await client.put(
        "/api/v1/attendance/me", json={"state_id": _state_id(settings, "in_room")}
    )
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "guest_restricted"


async def test_admin_sets_someone_else_audited_and_reads_their_log(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(root)
    settings = await _enable(client)
    gone = _state_id(settings, "gone")

    as_user(bob)
    denied = await client.put(f"/api/v1/admin/attendance/users/{alice.id}", json={"state_id": gone})
    assert denied.status_code == 403
    other_log = await client.get(f"/api/v1/attendance/log?user_id={alice.id}")
    assert other_log.status_code == 403

    as_user(root)
    done = await client.put(f"/api/v1/admin/attendance/users/{alice.id}", json={"state_id": gone})
    assert done.status_code == 200 and done.json()["source"] == "admin"
    missing = await client.put(
        f"/api/v1/admin/attendance/users/{uuid.uuid4()}", json={"state_id": gone}
    )
    assert missing.status_code == 404
    log = (await client.get(f"/api/v1/attendance/log?user_id={alice.id}")).json()["items"]
    assert log[0]["actor_id"] == str(root.id) and log[0]["source"] == "admin"
    from app.modules.audit.models import AuditLog

    actions = (
        await db.execute(select(AuditLog.action).where(AuditLog.target_id == str(alice.id)))
    ).scalars()
    assert "attendance.set_by_admin" in list(actions)


# --- states ---------------------------------------------------------------------------------


async def test_workspace_states_crud_order_and_archive(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    settings = await _enable(client)
    ids = [s["id"] for s in settings["states"]]

    made = await client.post(
        "/api/v1/admin/attendance/states",
        json={"label": "出張", "emoji": "✈️", "color": "purple", "kind": "off_site"},
    )
    assert made.status_code == 201 and made.json()["position"] == 4
    dup = await client.post(
        "/api/v1/admin/attendance/states", json={"label": "在室", "kind": "in_room"}
    )
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "attendance_label_taken"
    renamed = await client.patch(
        f"/api/v1/admin/attendance/states/{made.json()['id']}", json={"label": "出張中"}
    )
    assert renamed.json()["label"] == "出張中" and renamed.json()["emoji"] == "✈️"
    order = [made.json()["id"], *ids]
    reordered = await client.put("/api/v1/admin/attendance/states/order", json={"ids": order})
    assert [s["id"] for s in reordered.json()["states"]] == order
    wrong = await client.put("/api/v1/admin/attendance/states/order", json={"ids": ids})
    assert wrong.status_code == 400

    # Alice is in 学外; it is deleted (archived) and she stays, shown as archived.
    as_user(alice)
    await client.put("/api/v1/attendance/me", json={"state_id": ids[2]})
    as_user(root)
    assert (await client.delete(f"/api/v1/admin/attendance/states/{ids[2]}")).status_code == 204
    board = (await client.get("/api/v1/attendance")).json()
    archived = next(s for s in board["states"] if s["id"] == ids[2])
    assert archived["archived"] is True and board["entries"][0]["state_id"] == ids[2]
    as_user(alice)
    gone = await client.put("/api/v1/attendance/me", json={"state_id": ids[2], "note": "x"})
    assert gone.status_code == 422
    as_user(root)
    for state_id in [made.json()["id"], ids[0], ids[1]]:
        deleted = await client.delete(f"/api/v1/admin/attendance/states/{state_id}")
        assert deleted.status_code == 204
    last = await client.delete(f"/api/v1/admin/attendance/states/{ids[3]}")
    assert last.status_code == 409 and last.json()["error"]["code"] == "attendance_last_state"
    # Archived and unused: no longer on the board.
    board = (await client.get("/api/v1/attendance")).json()
    assert made.json()["id"] not in [s["id"] for s in board["states"]]


async def test_personal_states_follow_the_rule(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    prof = await make_user(db, "prof")
    student = await make_user(db, "student")
    as_user(root)
    group = await client.post(
        "/api/v1/admin/groups", json={"name": "faculty", "member_ids": [str(prof.id)]}
    )
    assert group.status_code == 201
    settings = await _enable(client)

    body = {"label": "会議", "emoji": "🗣️", "color": "red", "kind": "on_site"}
    as_user(prof)
    nobody = await client.post("/api/v1/attendance/my-states", json=body)
    assert nobody.status_code == 403
    assert nobody.json()["error"]["code"] == "attendance_personal_not_allowed"

    as_user(root)
    await client.patch(
        "/api/v1/admin/attendance/settings",
        json={"personal_rule": "groups", "personal_group_ids": [group.json()["id"]]},
    )
    unknown = await client.patch(
        "/api/v1/admin/attendance/settings", json={"personal_group_ids": [str(uuid.uuid4())]}
    )
    assert unknown.status_code == 400

    as_user(student)
    assert (await client.get("/api/v1/attendance")).json()["can_personalize"] is False
    assert (await client.post("/api/v1/attendance/my-states", json=body)).status_code == 403

    as_user(prof)
    assert (await client.get("/api/v1/attendance")).json()["can_personalize"] is True
    made = await client.post("/api/v1/attendance/my-states", json=body)
    assert made.status_code == 201, made.text
    mine = made.json()
    assert mine["owner_id"] == str(prof.id)
    clash = await client.post(
        "/api/v1/attendance/my-states", json={"label": "在室", "kind": "in_room"}
    )
    assert clash.status_code == 409
    chosen = await client.put("/api/v1/attendance/me", json={"state_id": mine["id"]})
    assert chosen.status_code == 200
    for n in range(9):
        extra = await client.post(
            "/api/v1/attendance/my-states", json={"label": f"予定{n}", "kind": "off_site"}
        )
        assert extra.status_code == 201
    over = await client.post("/api/v1/attendance/my-states", json={"label": "多い", "kind": "gone"})
    assert over.status_code == 409 and over.json()["error"]["code"] == "attendance_state_limit"

    # The student sees the professor's own state on the board but cannot choose it.
    as_user(student)
    board = (await client.get("/api/v1/attendance")).json()
    assert any(s["id"] == mine["id"] and s["owner_id"] == str(prof.id) for s in board["states"])
    theirs = await client.put("/api/v1/attendance/me", json={"state_id": mine["id"]})
    assert theirs.status_code == 422
    not_mine = await client.patch(
        f"/api/v1/attendance/my-states/{mine['id']}", json={"label": "乗っ取り"}
    )
    assert not_mine.status_code == 404

    as_user(prof)
    renamed = await client.patch(
        f"/api/v1/attendance/my-states/{mine['id']}", json={"label": "教授会", "emoji": None}
    )
    assert renamed.json()["label"] == "教授会" and renamed.json()["emoji"] is None
    assert (await client.delete(f"/api/v1/attendance/my-states/{mine['id']}")).status_code == 204
    board = (await client.get("/api/v1/attendance")).json()
    kept = next(s for s in board["states"] if s["id"] == mine["id"])
    assert kept["archived"] is True  # still in use by the professor
    assert settings["states"][0]["owner_id"] is None


# --- webhooks -------------------------------------------------------------------------------


def test_signature_matches_the_recorded_vector() -> None:
    """docs/PRESENCE.md §5.3: receivers can check their implementation against this."""
    body = b'{"event":"attendance.test"}'
    assert webhooks.signature(b"test-secret-0123456789", 1760000000, body) == (
        "sha256=b9a576549822b5bacf6f6676ed58759787609f141356628a2b14a37f582c255e"
    )
    assert webhooks.body_bytes({"event": "attendance.test"}) == body
    assert webhooks.body_bytes({"b": "在室", "a": None}) == '{"a":null,"b":"在室"}'.encode()


async def test_integration_urls_are_checked(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    for url in (
        "http://example.com/hook",
        "https://127.0.0.1/hook",
        "https://10.1.2.3/hook",
        "https://localhost/hook",
        "https://user:pw@example.com/hook",
    ):
        refused = await client.post(
            "/api/v1/admin/attendance/integrations",
            json={"name": "site", "url": url, "secret_name": "site"},
        )
        assert refused.status_code == 400, url
        assert refused.json()["error"]["code"] == "attendance_url_not_allowed"
    no_secret = await client.post(
        "/api/v1/admin/attendance/integrations",
        json={"name": "site", "url": "https://example.com/hook"},
    )
    assert no_secret.status_code == 422
    bad_name = await client.post(
        "/api/v1/admin/attendance/integrations",
        json={"name": "site", "url": "https://example.com/hook", "secret_name": "../etc/passwd"},
    )
    assert bad_name.status_code == 422
    made = await client.post(
        "/api/v1/admin/attendance/integrations",
        json={"name": "site", "url": "https://example.com/hook", "secret_name": "site"},
    )
    assert made.status_code == 201 and made.json()["token"] is None

    # The send-time check (DNS / literal) refuses private targets even if one got stored.
    send = webhooks.build_sender(app.state.settings)
    result = await send("https://127.0.0.1/hook", {}, b"{}")
    assert result.status_code is None and result.error == "url_not_allowed"
    assert not result.retryable

    # The dev flag allows local receivers (not in production).
    dev = app.state.settings.model_copy(update={"attendance_webhook_allow_private": True})
    service.check_target("http://127.0.0.1:9000/hook", dev)
    prod = dev.model_copy(update={"environment": "production"})
    with pytest.raises(Exception, match="https"):
        service.check_target("http://127.0.0.1:9000/hook", prod)


async def _integration(client: AsyncClient, name: str, *, inbound: bool = False) -> dict[str, Any]:
    made = await client.post(
        "/api/v1/admin/attendance/integrations",
        json={
            "name": name,
            "url": f"https://{name}.example.com/hook",
            "secret_name": "site",
            "inbound": inbound,
        },
    )
    assert made.status_code == 201, made.text
    data: dict[str, Any] = made.json()
    return data


async def test_changes_become_signed_deliveries_with_retries(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    tmp_path: Path,
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    alice.email = "alice@example.com"
    await db.commit()
    as_user(root)
    settings = await _enable(client)
    site = await _integration(client, "site")
    in_room, gone = _state_id(settings, "in_room"), _state_id(settings, "gone")
    secrets_settings = _with_secrets(app.state.settings, tmp_path)

    as_user(alice)
    await client.put("/api/v1/attendance/me", json={"state_id": in_room})
    await _drain(app)
    # The relay running the same row again plans nothing new (unique per event and integration).
    event = (await _events(db, "attendance.updated"))[0]
    from app.events.envelope import Audience

    planner = webhooks.AttendanceWebhookPlanner("Lab")
    async with app.state.db.session_factory() as session:
        await planner.handle(session, event, Audience(kind="all"))
        await session.commit()
    count = await db.scalar(select(func.count()).select_from(AttendanceDelivery))
    assert count == 1

    sender = FakeSender(500, None)
    factory = app.state.db.session_factory
    assert await webhooks.process_due(factory, secrets_settings, sender) == 1
    url, headers, body = sender.calls[0]
    assert url == "https://site.example.com/hook"
    payload = json.loads(body)
    assert payload["event"] == "attendance.changed"
    assert payload["delivery_id"] == headers["X-Taylis-Delivery"]
    assert payload["user"] == {
        "id": str(alice.id),
        "email": "alice@example.com",
        "username": "alice",
        "display_name": "Alice",
    }
    assert payload["from"] is None and payload["to"]["label"] == "在室"
    assert payload["to"]["kind"] == "in_room" and payload["source"] == "app"
    assert payload["integration_id"] is None
    expected = hmac.new(
        SECRET.encode(), headers["X-Taylis-Timestamp"].encode() + b"." + body, hashlib.sha256
    ).hexdigest()
    assert headers["X-Taylis-Signature"] == f"sha256={expected}"
    assert headers["X-Taylis-Event"] == "attendance.changed"

    delivery = (await db.execute(select(AttendanceDelivery))).scalar_one()
    await db.refresh(delivery)
    assert delivery.status == "pending" and delivery.attempts == 1
    assert delivery.last_status_code == 500
    # Not due yet: nothing is sent.
    assert await webhooks.process_due(factory, secrets_settings, sender) == 0
    await db.execute(update(AttendanceDelivery).values(next_attempt_at=utcnow()))
    await db.commit()
    assert await webhooks.process_due(factory, secrets_settings, sender) == 1  # timeout
    await db.execute(update(AttendanceDelivery).values(next_attempt_at=utcnow()))
    await db.commit()
    assert await webhooks.process_due(factory, secrets_settings, sender) == 1  # 200
    await db.refresh(delivery)
    assert delivery.status == "delivered" and delivery.attempts == 3
    # The same delivery id and body each time; a new timestamp and signature.
    assert {c[1]["X-Taylis-Delivery"] for c in sender.calls} == {str(delivery.id)}
    assert len({c[2] for c in sender.calls}) == 1

    # A 4xx other than 408 / 429 fails at once.
    await client.put("/api/v1/attendance/me", json={"state_id": gone})
    await _drain(app)
    rejecting = FakeSender(404)
    assert await webhooks.process_due(factory, secrets_settings, rejecting) == 1
    newest = (
        (
            await db.execute(
                select(AttendanceDelivery).order_by(AttendanceDelivery.created_at.desc())
            )
        )
        .scalars()
        .first()
    )
    assert newest is not None
    await db.refresh(newest)
    assert newest.status == "failed" and newest.last_status_code == 404
    assert json.loads(rejecting.calls[0][2])["from"]["label"] == "在室"

    as_user(root)
    site_url = f"/api/v1/admin/attendance/integrations/{site['integration']['id']}"
    listed = (await client.get(f"{site_url}/deliveries")).json()
    assert [d["status"] for d in listed] == ["failed", "delivered"]
    assert listed[1]["to_label"] == "在室" and listed[1]["attempts"] == 3


async def test_retries_give_up_and_missing_secret_fails(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    tmp_path: Path,
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    settings = await _enable(client)
    await _integration(client, "site")
    await client.put("/api/v1/attendance/me", json={"state_id": _state_id(settings, "in_room")})
    await _drain(app)
    factory = app.state.db.session_factory

    # No key file: not sent, failed with secret_missing.
    no_key = app.state.settings.model_copy(update={"attendance_webhook_secrets_dir": "/nonexist"})
    sender = FakeSender()
    assert await webhooks.process_due(factory, no_key, sender) == 1
    assert sender.calls == []
    row = (await db.execute(select(AttendanceDelivery))).scalar_one()
    await db.refresh(row)
    assert row.status == "failed" and row.last_error == "secret_missing"

    # Always 503: gives up after MAX_ATTEMPTS.
    await db.execute(update(AttendanceDelivery).values(status="pending", attempts=0))
    await db.commit()
    with_key = _with_secrets(app.state.settings, tmp_path)
    failing = FakeSender(*([503] * webhooks.MAX_ATTEMPTS))
    for _ in range(webhooks.MAX_ATTEMPTS):
        await db.execute(update(AttendanceDelivery).values(next_attempt_at=utcnow()))
        await db.commit()
        assert await webhooks.process_due(factory, with_key, failing) == 1
    await db.refresh(row)
    assert row.status == "failed" and row.attempts == webhooks.MAX_ATTEMPTS


async def test_older_delivery_is_superseded_by_a_newer_delivered_one(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    tmp_path: Path,
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    settings = await _enable(client)
    await _integration(client, "site")
    factory = app.state.db.session_factory
    with_key = _with_secrets(app.state.settings, tmp_path)
    await client.put("/api/v1/attendance/me", json={"state_id": _state_id(settings, "in_room")})
    await _drain(app)
    assert await webhooks.process_due(factory, with_key, FakeSender(500)) == 1  # backs off
    await client.put("/api/v1/attendance/me", json={"state_id": _state_id(settings, "gone")})
    await _drain(app)
    assert await webhooks.process_due(factory, with_key, FakeSender(200)) == 1  # the newer
    await db.execute(update(AttendanceDelivery).values(next_attempt_at=utcnow()))
    await db.commit()
    sender = FakeSender()
    assert await webhooks.process_due(factory, with_key, sender) == 0
    assert sender.calls == []
    statuses = (
        await db.execute(select(AttendanceDelivery.status).order_by(AttendanceDelivery.log_id))
    ).scalars()
    assert list(statuses) == ["superseded", "delivered"]


async def test_turning_the_board_off_cancels_pending_deliveries(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    tmp_path: Path,
) -> None:
    """Review v0.1.43 #3: nothing is sent once the board is off, at any stage, and what was
    pending is cancelled (not sent after re-enabling: its state would be stale)."""
    root = await make_user(db, "root", role="admin")
    as_user(root)
    settings = await _enable(client)
    site_id = (await _integration(client, "site"))["integration"]["id"]
    await _integration(client, "other")
    factory = app.state.db.session_factory
    with_key = _with_secrets(app.state.settings, tmp_path)
    in_room, gone = _state_id(settings, "in_room"), _state_id(settings, "gone")

    async def statuses() -> list[tuple[str, str | None]]:
        rows = await db.execute(
            select(AttendanceDelivery.status, AttendanceDelivery.last_error).order_by(
                AttendanceDelivery.created_at, AttendanceDelivery.id
            )
        )
        return [(r[0], r[1]) for r in rows.all()]

    async def switch(on: bool) -> None:
        response = await client.patch("/api/v1/admin/attendance/settings", json={"enabled": on})
        assert response.status_code == 200, response.text

    # 1. Waiting for the first send.
    await client.put("/api/v1/attendance/me", json={"state_id": in_room})
    await _drain(app)
    assert [s for s, _ in await statuses()] == ["pending", "pending"]
    await switch(False)
    await switch(True)
    sender = FakeSender()
    assert await webhooks.process_due(factory, with_key, sender) == 0
    assert sender.calls == []
    assert await statuses() == [("cancelled", "attendance_disabled")] * 2

    # 2. Waiting for a retry.
    await db.execute(update(AttendanceDelivery).values(status="delivered"))
    await db.commit()
    await client.put("/api/v1/attendance/me", json={"state_id": gone})
    await _drain(app)
    assert await webhooks.process_due(factory, with_key, FakeSender(500, 500)) == 2
    await switch(False)
    await db.execute(update(AttendanceDelivery).values(next_attempt_at=utcnow()))
    await db.commit()
    sender = FakeSender()
    assert await webhooks.process_due(factory, with_key, sender) == 0
    assert sender.calls == []
    assert [s for s, _ in await statuses()][2:] == ["cancelled", "cancelled"]
    await switch(True)
    await db.execute(update(AttendanceDelivery).values(next_attempt_at=utcnow()))
    await db.commit()
    assert await webhooks.process_due(factory, with_key, sender) == 0
    assert sender.calls == []

    # 3. Turned off after the worker claimed the batch, while it sends the first of two.
    await client.put("/api/v1/attendance/me", json={"state_id": in_room})
    await _drain(app)
    turned_off: list[bytes] = []

    async def turning_off(url: str, headers: dict[str, str], body: bytes) -> webhooks.SendResult:
        turned_off.append(body)
        as_user(root)
        await switch(False)
        return webhooks.SendResult(503, "busy")  # the first fails: not retried either

    assert await webhooks.process_due(factory, with_key, turning_off) == 2
    assert len(turned_off) == 1
    assert [s for s, _ in await statuses()][4:] == ["cancelled", "cancelled"]
    await switch(True)
    await db.execute(update(AttendanceDelivery).values(next_attempt_at=utcnow()))
    await db.commit()
    sender = FakeSender()
    assert await webhooks.process_due(factory, with_key, sender) == 0
    assert sender.calls == []
    deliveries_url = f"/api/v1/admin/attendance/integrations/{site_id}/deliveries"
    listed = (await client.get(deliveries_url)).json()
    assert listed[0]["status"] == "cancelled" and listed[0]["next_attempt_at"] is None


async def test_test_send_records_a_delivery(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    tmp_path: Path,
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await _enable(client)
    site = await _integration(client, "site")
    app.state.settings = _with_secrets(app.state.settings, tmp_path)
    sender = FakeSender(204)
    app.state.attendance_sender = sender
    site_url = f"/api/v1/admin/attendance/integrations/{site['integration']['id']}"
    sent = await client.post(f"{site_url}/test")
    assert sent.status_code == 200, sent.text
    assert sent.json()["delivery"]["status"] == "delivered"
    assert sent.json()["delivery"]["last_status_code"] == 204
    body = json.loads(sender.calls[0][2])
    assert body["event"] == "attendance.test" and body["user"]["username"] == "root"
    assert body["to"]["label"] == "在室"
    inbound_only = await client.post(
        "/api/v1/admin/attendance/integrations", json={"name": "in", "inbound": True}
    )
    no_url = await client.post(
        f"/api/v1/admin/attendance/integrations/{inbound_only.json()['integration']['id']}/test"
    )
    assert no_url.status_code == 409


# --- inbound --------------------------------------------------------------------------------


async def test_inbound_api_auth_mapping_and_loop_prevention(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    alice.email = "Alice@Example.com"
    await db.commit()
    as_user(root)
    settings = await _enable(client, personal_rule="everyone")
    site = await _integration(client, "site", inbound=True)
    other = await _integration(client, "other")
    token = site["token"]
    assert token and site["integration"]["inbound"] is True
    url = "/api/v1/integrations/attendance"
    app.dependency_overrides.clear()  # the inbound API has no signed-in user

    assert (await client.post(url, json={"email": "x", "state": "在室"})).status_code == 401
    wrong = await client.post(
        url, json={"email": "x", "state": "在室"}, headers={"Authorization": "Bearer nope"}
    )
    assert wrong.status_code == 401 and wrong.json()["error"]["code"] == "invalid_token"
    auth = {"Authorization": f"Bearer {token}"}

    both = await client.post(
        url, json={"email": "a@x", "username": "alice", "state": "在室"}, headers=auth
    )
    assert both.status_code == 422
    nobody = await client.post(url, json={"email": "nobody@x", "state": "在室"}, headers=auth)
    assert nobody.status_code == 404
    unknown = await client.post(
        url, json={"email": "alice@example.com", "state": "宇宙"}, headers=auth
    )
    assert unknown.status_code == 422
    assert unknown.json()["error"]["code"] == "attendance_state_unknown"

    applied = await client.post(
        url,
        json={"email": "alice@example.com", "state": " 在室 ", "note": "from site"},
        headers=auth,
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["applied"] is True
    assert applied.json()["state_id"] == _state_id(settings, "in_room")
    unchanged = await client.post(
        url, json={"username": "ALICE", "state": "在室", "note": "from site"}, headers=auth
    )
    assert unchanged.json() == {**applied.json(), "applied": False, "reason": "unchanged"}
    stale = await client.post(
        url,
        json={
            "user_id": str(alice.id),
            "state": "帰宅",
            "at": (utcnow() - timedelta(hours=1)).isoformat(),
        },
        headers=auth,
    )
    assert stale.json()["applied"] is False and stale.json()["reason"] == "stale"
    too_old = await client.post(
        url,
        json={"user_id": str(alice.id), "state": "帰宅", "at": "2020-01-01T00:00:00Z"},
        headers=auth,
    )
    assert too_old.status_code == 422

    # A personal state is found by its name (the person's own).
    as_user(alice)
    meeting = (
        await client.post(
            "/api/v1/attendance/my-states", json={"label": "Meeting", "kind": "on_site"}
        )
    ).json()
    app.dependency_overrides.clear()
    by_label = await client.post(
        url, json={"email": "alice@example.com", "state": "meeting"}, headers=auth
    )
    assert by_label.json()["state_id"] == meeting["id"]

    # The changes from `site` go to `other` only, marked as coming from `site`.
    await _drain(app)
    rows = (await db.execute(select(AttendanceDelivery))).scalars().all()
    assert {r.integration_id for r in rows} == {uuid.UUID(other["integration"]["id"])}
    assert all(r.body["source"] == "integration" for r in rows)
    assert all(r.body["integration_id"] == site["integration"]["id"] for r in rows)
    log = (await db.execute(select(AttendanceLog).order_by(AttendanceLog.id))).scalars().all()
    assert [r.source for r in log] == ["integration", "integration"]

    # A disabled integration or a revoked token is refused.
    as_user(root)
    rotated = await client.post(
        f"/api/v1/admin/attendance/integrations/{site['integration']['id']}/token"
    )
    new_auth = {"Authorization": f"Bearer {rotated.json()['token']}"}
    app.dependency_overrides.clear()
    old = await client.post(url, json={"email": "alice@example.com", "state": "在室"}, headers=auth)
    assert old.status_code == 401
    ok = await client.post(
        url, json={"email": "alice@example.com", "state": "在室"}, headers=new_auth
    )
    assert ok.status_code == 200
    as_user(root)
    await client.patch(
        f"/api/v1/admin/attendance/integrations/{site['integration']['id']}",
        json={"enabled": False},
    )
    await client.patch("/api/v1/admin/attendance/settings", json={"enabled": True})
    app.dependency_overrides.clear()
    off = await client.post(
        url, json={"email": "alice@example.com", "state": "在室"}, headers=new_auth
    )
    assert off.status_code == 401


async def test_anonymizing_forgets_the_person(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _enable(client, personal_rule="everyone")
    as_user(alice)
    own = (
        await client.post("/api/v1/attendance/my-states", json={"label": "会議", "kind": "on_site"})
    ).json()
    await client.put("/api/v1/attendance/me", json={"state_id": own["id"]})
    as_user(root)
    done = await client.post(f"/api/v1/admin/users/{alice.id}/anonymize")
    assert done.status_code == 200, done.text
    board = (await client.get("/api/v1/attendance")).json()
    assert board["entries"] == [] and own["id"] not in [s["id"] for s in board["states"]]
    assert await db.scalar(select(func.count()).select_from(AttendanceLog)) == 0


async def test_retention_purges_old_log_rows(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    settings = await _enable(client, log_retention_days=30)
    await client.put("/api/v1/attendance/me", json={"state_id": _state_id(settings, "in_room")})
    await client.put("/api/v1/attendance/me", json={"state_id": _state_id(settings, "gone")})
    await db.execute(
        update(AttendanceLog)
        .where(AttendanceLog.from_state_id.is_(None))
        .values(at=utcnow() - timedelta(days=40))
    )
    await db.commit()
    logs, _ = await service.purge(db, now=utcnow(), delivery_days=30)
    assert logs == 1
    assert await db.scalar(select(func.count()).select_from(AttendanceLog)) == 1
