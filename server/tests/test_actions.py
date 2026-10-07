"""操作ボタン (actions, M143, docs/ACTIONS.md): the switch, who may press (roles, groups, people;
never guests or bots), the signed request, the relay's answer, no retries, idempotent repeats,
the rate limit, SSRF, secrets never shown, the notice, retention and anonymization."""

import asyncio
import hashlib
import hmac
import json
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.actions import service
from app.modules.actions.models import Action, ActionInvocation
from app.modules.audit.models import AuditLog
from app.modules.channels.service import resolve_event_audience
from app.modules.groups.models import UserGroup, UserGroupMember
from app.modules.messages.models import Message
from app.modules.outbound import signed
from app.modules.users.models import User
from tests.helpers import make_user

SECRET = "relay-secret-0123456789abcdef-XYZ"


class FakeRelay:
    """Records what would be posted; answers with the queued answers (default 200, no body)."""

    def __init__(self, *answers: signed.Answer, delay: float = 0.0) -> None:
        self.answers = list(answers)
        self.calls: list[tuple[str, dict[str, str], bytes]] = []
        self.delay = delay

    async def __call__(self, url: str, headers: dict[str, str], body: bytes) -> signed.Answer:
        self.calls.append((url, headers, body))
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.answers.pop(0) if self.answers else signed.Answer(200)


def _json(status: int, data: Any) -> signed.Answer:
    return signed.Answer(status, None, json.dumps(data, ensure_ascii=False).encode())


@pytest.fixture
def relay(app: FastAPI, tmp_path: Path) -> FakeRelay:
    (tmp_path / "door").write_text(SECRET + "\n")
    app.state.settings = app.state.settings.model_copy(update={"action_secrets_dir": str(tmp_path)})
    fake = FakeRelay()
    app.state.action_poster = fake
    return fake


async def _enable(client: AsyncClient, **extra: Any) -> None:
    response = await client.patch("/api/v1/admin/actions/settings", json={"enabled": True, **extra})
    assert response.status_code == 200, response.text


async def _create(client: AsyncClient, **fields: Any) -> dict[str, Any]:
    body = {
        "name": "開ける",
        "group_label": "研究室の鍵",
        "emoji": "🔓",
        "action_key": "lab-door.unlock",
        "url": "https://relay.example.com/taylis",
        "secret_name": "door",
        "allowed_roles": ["member", "manager", "admin"],
        **fields,
    }
    made = await client.post("/api/v1/admin/actions", json=body)
    assert made.status_code == 201, made.text
    data: dict[str, Any] = made.json()
    return data


async def _press(
    client: AsyncClient, action_id: str, client_invoke_id: uuid.UUID | None = None
) -> Any:
    return await client.post(
        f"/api/v1/actions/{action_id}/invoke",
        json={"client_invoke_id": str(client_invoke_id or uuid.uuid4())},
    )


# --- the switch ----------------------------------------------------------------------------


async def test_off_by_default(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    door = await _create(client)

    as_user(alice)
    assert (await client.get("/api/v1/actions")).json() == {
        "enabled": False,
        "show_on_attendance": False,
        "actions": [],
    }
    assert (await client.get("/api/v1/sync/bootstrap")).json()["actions"] is None
    off = await _press(client, door["id"])
    assert off.status_code == 409 and off.json()["error"]["code"] == "actions_disabled"
    denied = await client.patch("/api/v1/admin/actions/settings", json={"enabled": True})
    assert denied.status_code == 403
    assert (await client.get("/api/v1/admin/actions")).status_code == 403
    assert relay.calls == []

    as_user(root)
    await _enable(client, show_on_attendance=True)
    as_user(alice)
    listed = (await client.get("/api/v1/actions")).json()
    assert listed["enabled"] is True and listed["show_on_attendance"] is True
    assert [a["name"] for a in listed["actions"]] == ["開ける"]
    # What a person sees: no URL, key or rights.
    assert set(listed["actions"][0]) == {
        "id",
        "name",
        "group_label",
        "icon",
        "emoji",
        "confirm",
        "confirm_text",
        "position",
    }
    booted = (await client.get("/api/v1/sync/bootstrap")).json()["actions"]
    assert booted == listed

    # A manager (not an administrator) cannot manage the buttons (integrations.manage).
    manager = await make_user(db, "mgr", role="manager")
    as_user(manager)
    assert (await client.get("/api/v1/admin/actions")).status_code == 403


async def test_disabled_button_and_feature(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _enable(client)
    door = await _create(client)
    await client.patch(f"/api/v1/admin/actions/{door['id']}", json={"enabled": False})
    as_user(alice)
    assert (await client.get("/api/v1/actions")).json()["actions"] == []
    stopped = await _press(client, door["id"])
    assert stopped.status_code == 409 and stopped.json()["error"]["code"] == "action_disabled"
    missing = await _press(client, str(uuid.uuid4()))
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "action_not_found"
    assert relay.calls == []


# --- who may press -------------------------------------------------------------------------


async def test_permission_matrix(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    manager = await make_user(db, "mgr", role="manager")
    member = await make_user(db, "member")
    student = await make_user(db, "student")
    professor = await make_user(db, "prof")
    guest = await make_user(db, "guest", role="guest")
    bot = await make_user(db, "bot", role="bot")
    gone = await make_user(db, "gone")
    gone.deactivated_at = utcnow()
    students = UserGroup(name="students", created_by=root.id, managed_key="students")
    db.add(students)
    await db.flush()
    # A guest in the group still never presses.
    for person in (student, guest):
        db.add(UserGroupMember(group_id=students.id, user_id=person.id))
    await db.commit()

    as_user(root)
    await _enable(client)
    members = await _create(client, name="members", allowed_roles=["member"])
    managers = await _create(client, name="managers", allowed_roles=["manager", "admin"])
    group = await _create(
        client, name="group", allowed_roles=[], allowed_group_ids=[str(students.id)]
    )
    own = await _create(
        client,
        name="prof",
        allowed_roles=[],
        allowed_user_ids=[str(professor.id), str(guest.id), str(bot.id), str(gone.id)],
    )
    nobody = await _create(client, name="nobody", allowed_roles=[])
    every = [members, managers, group, own, nobody]
    expected = {
        root: {"managers"},
        manager: {"managers"},
        member: {"members"},
        student: {"members", "group"},
        professor: {"members", "prof"},
        guest: set(),
        bot: set(),
        gone: set(),
    }
    for person, allowed in expected.items():
        as_user(person)
        listed = {a["name"] for a in (await client.get("/api/v1/actions")).json()["actions"]}
        assert listed == allowed, person.username
        for action in every:
            answer = await _press(client, action["id"])
            if action["name"] in allowed:
                assert answer.status_code == 200, (person.username, action["name"], answer.text)
                assert answer.json()["ok"] is True
            else:
                assert answer.status_code == 403, (person.username, action["name"])
                assert answer.json()["error"]["code"] == "action_not_allowed"
    assert len(relay.calls) == sum(len(a) for a in expected.values())
    # Guests never get the list in the bootstrap.
    as_user(guest)
    assert (await client.get("/api/v1/sync/bootstrap")).json()["actions"] is None


async def test_validation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    for url in (
        "http://relay.example.com/x",
        "https://127.0.0.1/x",
        "https://10.0.0.5/x",
        "https://localhost/x",
        "https://user:pw@relay.example.com/x",
    ):
        refused = await client.post(
            "/api/v1/admin/actions",
            json={"name": "x", "action_key": "k", "url": url, "secret_name": "door"},
        )
        assert refused.status_code == 400, url
        assert refused.json()["error"]["code"] == "action_url_not_allowed"
    for bad in (
        {"secret_name": "../etc/passwd"},
        {"action_key": "has space"},
        {"icon": "padlock"},
        {"allowed_roles": ["guest"]},
        {"allowed_roles": ["bot"]},
        {"name": "   "},
    ):
        body = {
            "name": "x",
            "action_key": "k",
            "url": "https://relay.example.com/x",
            "secret_name": "door",
            **bad,
        }
        assert (await client.post("/api/v1/admin/actions", json=body)).status_code == 422, bad
    unknown = await client.post(
        "/api/v1/admin/actions",
        json={
            "name": "x",
            "action_key": "k",
            "url": "https://relay.example.com/x",
            "secret_name": "door",
            "allowed_group_ids": [str(uuid.uuid4())],
        },
    )
    assert unknown.status_code == 400


# --- the request and the answer ------------------------------------------------------------


def test_signature_matches_the_recorded_vector() -> None:
    """docs/ACTIONS.md §5: relays can check their implementation against this."""
    body = signed.body_bytes({"type": "action.test"})
    assert body == b'{"type":"action.test"}'
    assert signed.signature(b"test-secret-0123456789", 1760000000, body) == (
        "sha256=7e345874dae511795dddf6218ee0c2cdb320f1cb120c17b39c1e1ee1e97dff59"
    )


async def test_the_signed_request(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: FakeRelay,
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    alice.email = "alice@example.ac.jp"
    await db.commit()
    as_user(root)
    await _enable(client)
    door = await _create(client)
    relay.answers.append(_json(200, {"message": "解錠しました"}))

    as_user(alice)
    pressed = await _press(client, door["id"])
    assert pressed.status_code == 200, pressed.text
    out = pressed.json()
    assert out["ok"] is True and out["status"] == "succeeded" and out["status_code"] == 200
    assert out["message"] == "解錠しました" and out["error"] is None and out["repeated"] is False

    [(url, headers, body)] = relay.calls
    assert url == "https://relay.example.com/taylis"
    assert headers["X-Taylis-Event"] == "action.invoked"
    assert headers["X-Taylis-Delivery"] == out["invoke_id"]
    timestamp = headers["X-Taylis-Timestamp"]
    assert abs(int(timestamp) - time.time()) < 60
    expected = hmac.new(SECRET.encode(), timestamp.encode() + b"." + body, hashlib.sha256)
    assert headers["X-Taylis-Signature"] == "sha256=" + expected.hexdigest()
    sent = json.loads(body)
    assert sent["type"] == "action.invoked"
    assert sent["invoke_id"] == out["invoke_id"] and sent["action_id"] == door["id"]
    assert sent["action_key"] == "lab-door.unlock"
    assert sent["user"] == {
        "id": str(alice.id),
        "username": "alice",
        "email": "alice@example.ac.jp",
        "display_name": "Alice",
        "role": "member",
    }
    assert sent["at"].endswith("Z") and "workspace" in sent
    # Logged and audited.
    row = await db.get(ActionInvocation, uuid.UUID(out["invoke_id"]))
    assert row is not None and row.status == "succeeded" and row.kind == "invoke"
    assert row.user_id == alice.id and row.latency_ms is not None
    audited = (
        await db.execute(select(AuditLog).where(AuditLog.action == "action.invoked"))
    ).scalar_one()
    assert audited.actor_id == alice.id and audited.details["ok"] is True


async def test_relay_answers(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await _enable(client)
    door = await _create(client)
    relay.answers.extend(
        [
            _json(503, {"message": "電池が\n切れています\u0000"}),
            signed.Answer(500, None, b"<html>oops</html>"),
            _json(200, {"message": "x" * 500}),
            _json(200, {"message": 42}),
            signed.Answer(None, "timeout"),
            signed.Answer(None, "network: ConnectError"),
            signed.Answer(None, "dns_failed"),
            signed.Answer(302),
        ]
    )
    results = [(await _press(client, door["id"])).json() for _ in range(8)]
    # One per press, no retries in between (the rate limit is per person; the fixture's limiter
    # is replaced for this test below).
    assert [(r["ok"], r["status_code"], r["error"]) for r in results] == [
        (False, 503, "relay_error"),
        (False, 500, "relay_error"),
        (True, 200, None),
        (True, 200, None),
        (False, None, "timeout"),
        (False, None, "network"),
        (False, None, "network"),
        (False, 302, "relay_error"),
    ]
    assert results[0]["message"] == "電池が 切れています"
    assert results[1]["message"] is None
    assert results[2]["message"] == "x" * 200
    assert results[3]["message"] is None
    assert len(relay.calls) == 8
    pending = await db.scalar(
        select(func.count())
        .select_from(ActionInvocation)
        .where(ActionInvocation.status == "pending")
    )
    assert pending == 0


@pytest.fixture(autouse=True)
def _no_rate_limit_unless_asked(app: FastAPI, request: pytest.FixtureRequest) -> None:
    """Most tests press quickly; the rate limit has its own test."""
    if request.node.name != "test_rate_limit":

        class Unlimited:
            def try_acquire(self, key: str) -> bool:
                return True

            def retry_after_seconds(self, key: str) -> int:
                return 1

        app.state.limiters["action_invoke"] = Unlimited()


async def test_secret_missing_sends_nothing(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: FakeRelay,
    tmp_path: Path,
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await _enable(client)
    (tmp_path / "short").write_text("tooshort")
    missing = await _create(client, name="missing", secret_name="nofile")
    short = await _create(client, name="short", secret_name="short")
    present = await _create(client, name="present")
    listed = {a["name"]: a for a in (await client.get("/api/v1/admin/actions")).json()}
    assert listed["missing"]["secret_present"] is False
    assert listed["short"]["secret_present"] is False
    assert listed["present"]["secret_present"] is True
    for action in (missing, short):
        out = (await _press(client, action["id"])).json()
        assert out["ok"] is False and out["error"] == "secret_missing"
    assert relay.calls == []
    assert (await _press(client, present["id"])).json()["ok"] is True


async def test_secrets_are_never_returned(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await _enable(client)
    door = await _create(client)
    await client.patch(f"/api/v1/admin/actions/{door['id']}", json={"name": "解錠"})
    await _press(client, door["id"])
    await client.post(f"/api/v1/admin/actions/{door['id']}/test")
    texts = [
        (await client.get("/api/v1/admin/actions")).text,
        (await client.get("/api/v1/actions")).text,
        (await client.get(f"/api/v1/admin/actions/{door['id']}/invocations")).text,
        (await client.get("/api/v1/admin/actions/settings")).text,
        (await client.get("/api/v1/sync/bootstrap")).text,
    ]
    audits: list[Any] = list((await db.execute(select(AuditLog.details))).scalars().all())
    texts += [json.dumps(d, ensure_ascii=False) for d in audits]
    for text in texts:
        assert SECRET not in text


# --- no retries, idempotency, the rate limit -----------------------------------------------


async def test_a_timeout_is_not_retried(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: FakeRelay,
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await _enable(client)
    door = await _create(client)
    relay.answers.append(signed.Answer(None, "timeout"))
    out = (await _press(client, door["id"])).json()
    assert out["ok"] is False and out["status"] == "failed" and out["error"] == "timeout"
    # Nothing queued for later: the relay loop and the outbox carry no press.
    while await app.state.relay.process_batch():
        pass
    await asyncio.sleep(0.05)
    assert len(relay.calls) == 1
    types = (await db.execute(select(OutboxEvent.event_type))).scalars().all()
    assert set(types) <= {"actions.updated"}


async def test_the_same_client_invoke_id_calls_once(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _enable(client)
    door = await _create(client)
    lock = await _create(client, name="閉める", action_key="lab-door.lock")
    relay.answers.append(_json(200, {"message": "解錠しました"}))
    as_user(alice)
    key = uuid.uuid4()
    first = (await _press(client, door["id"], key)).json()
    again = (await _press(client, door["id"], key)).json()
    assert len(relay.calls) == 1
    assert again["repeated"] is True and again["invoke_id"] == first["invoke_id"]
    assert again["message"] == "解錠しました" and again["ok"] is True
    reused = await _press(client, lock["id"], key)
    assert reused.status_code == 409
    assert reused.json()["error"]["code"] == "action_invoke_id_reused"
    # Another person's same id is their own press.
    as_user(root)
    assert (await _press(client, door["id"], key)).json()["repeated"] is False
    assert len(relay.calls) == 2


async def test_concurrent_repeats_call_once(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    relay: FakeRelay,
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await _enable(client)
    door = await _create(client)
    relay.delay = 0.4
    key = uuid.uuid4()
    one, two = await asyncio.gather(
        _press(client, door["id"], key), _press(client, door["id"], key)
    )
    assert one.status_code == 200 and two.status_code == 200
    assert len(relay.calls) == 1
    outs = sorted([one.json(), two.json()], key=lambda o: o["repeated"])
    assert [o["repeated"] for o in outs] == [False, True]
    assert outs[1]["ok"] is True and outs[0]["invoke_id"] == outs[1]["invoke_id"]


async def test_a_press_cut_off_by_a_crash_is_reported_not_resent(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await _enable(client)
    door = await _create(client)
    key = uuid.uuid4()
    db.add(
        ActionInvocation(
            id=uuid.uuid4(),
            action_id=uuid.UUID(door["id"]),
            user_id=root.id,
            client_invoke_id=key,
            kind="invoke",
            status="pending",
            created_at=utcnow() - timedelta(minutes=5),
        )
    )
    await db.commit()
    out = (await _press(client, door["id"], key)).json()
    assert out["repeated"] is True and out["ok"] is False and out["error"] == "interrupted"
    assert relay.calls == []


async def test_rate_limit(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _enable(client)
    door = await _create(client)
    lock = await _create(client, name="閉める")
    as_user(alice)
    key = uuid.uuid4()
    assert (await _press(client, door["id"], key)).status_code == 200
    limited = await _press(client, door["id"])
    assert limited.status_code == 429 and limited.json()["error"]["code"] == "rate_limited"
    assert "Retry-After" in limited.headers
    # A repeat of the same request is not a new press; another button has its own limit.
    assert (await _press(client, door["id"], key)).json()["repeated"] is True
    assert (await _press(client, lock["id"])).status_code == 200
    # Someone else is not held back by alice.
    as_user(root)
    assert (await _press(client, door["id"])).status_code == 200
    assert len(relay.calls) == 3


# --- the real sender: SSRF and the whole-send timeout --------------------------------------


Handler = Callable[[asyncio.StreamReader, asyncio.StreamWriter], Awaitable[None]]


async def _read_request(reader: asyncio.StreamReader) -> None:
    head = await reader.readuntil(b"\r\n\r\n")
    length = 0
    for line in head.split(b"\r\n"):
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":", 1)[1])
    await reader.readexactly(length)


@asynccontextmanager
async def _receiver(handler: Handler) -> AsyncIterator[str]:
    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}/relay"
    finally:
        server.close()
        server.close_clients()
        await server.wait_closed()


def _answer(raw: bytes, *, trickle: float = 0.0) -> Handler:
    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await _read_request(reader)
            if trickle:
                for i in range(len(raw)):
                    writer.write(raw[i : i + 1])
                    await writer.drain()
                    await asyncio.sleep(trickle)
            else:
                writer.write(raw)
                await writer.drain()
            writer.close()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass

    return handle


async def test_the_real_sender(app: FastAPI) -> None:
    production = app.state.settings.model_copy(
        update={"action_allow_private": True, "environment": "production"}
    )
    # The dev flag does nothing in production: private targets are refused at send time.
    post = service.build_poster(production)
    refused = await post("https://127.0.0.1/relay", {}, b"{}")
    assert refused == signed.Answer(None, "url_not_allowed")
    assert (await post("http://relay.example.com/x", {}, b"{}")).error == "url_not_allowed"
    with pytest.raises(Exception, match="https"):
        service.check_target("http://127.0.0.1:9000/relay", production)

    dev = app.state.settings.model_copy(
        update={"action_allow_private": True, "action_timeout_seconds": 0.4}
    )
    service.check_target("http://127.0.0.1:9000/relay", dev)
    post = service.build_poster(dev)
    body = json.dumps({"message": "解錠しました"}).encode()
    ok = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(
        body
    )
    async with _receiver(_answer(ok + body)) as url:
        answer = await post(url, {}, b"{}")
    assert answer.ok and json.loads(answer.body) == {"message": "解錠しました"}
    # An answer that trickles in is cut off at the timeout, as a whole.
    async with _receiver(_answer(ok + body, trickle=0.05)) as url:
        started = time.monotonic()
        answer = await post(url, {}, b"{}")
        elapsed = time.monotonic() - started
    assert answer == signed.Answer(None, "timeout") and elapsed < 0.4 + 0.5
    # Redirects are not followed.
    moved = b"HTTP/1.1 302 Found\r\nLocation: https://example.com/\r\nContent-Length: 0\r\n\r\n"
    async with _receiver(_answer(moved)) as url:
        answer = await post(url, {}, b"{}")
    assert answer.status_code == 302 and not answer.ok


async def test_through_the_api_with_a_slow_relay(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    tmp_path: Path,
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    (tmp_path / "door").write_text(SECRET)
    app.state.settings = app.state.settings.model_copy(
        update={
            "action_secrets_dir": str(tmp_path),
            "action_allow_private": True,
            "action_timeout_seconds": 0.3,
        }
    )
    app.state.action_poster = service.build_poster(app.state.settings)
    await _enable(client)
    slow = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"
    received: list[bool] = []

    async def counting(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        received.append(True)
        await _answer(slow, trickle=0.05)(reader, writer)

    async with _receiver(counting) as url:
        door = await _create(client, url=url)
        out = (await _press(client, door["id"])).json()
        await asyncio.sleep(0.5)
    assert out["ok"] is False and out["error"] == "timeout"
    assert received == [True]  # sent once, never again


# --- the test button, the log, notices -----------------------------------------------------


async def test_test_send_and_invocations(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    door = await _create(client)  # the feature is still off: a test still goes out
    tested = await client.post(f"/api/v1/admin/actions/{door['id']}/test")
    assert tested.status_code == 200 and tested.json()["ok"] is True
    [(_, headers, body)] = relay.calls
    assert headers["X-Taylis-Event"] == "action.test" and json.loads(body)["type"] == "action.test"
    await _enable(client)
    await _press(client, door["id"])
    log = (await client.get(f"/api/v1/admin/actions/{door['id']}/invocations")).json()
    assert [i["kind"] for i in log] == ["invoke", "test"]
    assert all(i["user_id"] == str(root.id) and i["status"] == "succeeded" for i in log)
    listed = (await client.get("/api/v1/admin/actions")).json()
    assert listed[0]["last_invoked_at"] is not None


async def test_success_notice(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await _enable(client)
    channel = (await client.post("/api/v1/channels", json={"name": "lab-door"})).json()
    door = await _create(client, notice_channel_id=channel["id"])
    quiet = await _create(client, name="閉める", emoji="🔒")
    relay.answers.extend([signed.Answer(503), signed.Answer(200), signed.Answer(200)])
    await _press(client, door["id"])  # failed: no notice
    await _press(client, door["id"])
    await _press(client, quiet["id"])  # no channel chosen
    bodies = (
        (
            await db.execute(
                select(Message.body).where(Message.channel_id == uuid.UUID(channel["id"]))
            )
        )
        .scalars()
        .all()
    )
    assert [b for b in bodies if "実行" in b] == ["🔓 Root が 研究室の鍵：開ける を実行"]


# --- events, ordering, retention, anonymization --------------------------------------------


async def test_events_reorder_and_delete(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    guest = await make_user(db, "guest", role="guest")
    as_user(root)
    await _enable(client)
    first = await _create(client, name="一")
    second = await _create(client, name="二")
    order = await client.put(
        "/api/v1/admin/actions/order", json={"ids": [second["id"], first["id"]]}
    )
    assert [a["name"] for a in order.json()] == ["二", "一"]
    events = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "actions.updated")))
        .scalars()
        .all()
    )
    assert len(events) == 4  # enabled, two created, reordered
    audience = await resolve_event_audience(db, events[-1])
    assert alice.id in audience.ids and guest.id not in audience.ids
    await _press(client, first["id"])
    assert (await client.delete(f"/api/v1/admin/actions/{first['id']}")).status_code == 204
    assert await db.scalar(select(func.count()).select_from(ActionInvocation)) == 0
    assert [a["name"] for a in (await client.get("/api/v1/admin/actions")).json()] == ["二"]


async def test_retention_and_anonymization(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], relay: FakeRelay
) -> None:
    root = await make_user(db, "root", role="admin")
    prof = await make_user(db, "prof")
    as_user(root)
    await _enable(client, log_retention_days=30)
    door = await _create(client, allowed_roles=[], allowed_user_ids=[str(prof.id)])
    as_user(prof)
    await _press(client, door["id"])
    await _press(client, door["id"])
    await db.execute(
        update(ActionInvocation)
        .where(ActionInvocation.id == select(ActionInvocation.id).limit(1).scalar_subquery())
        .values(created_at=utcnow() - timedelta(days=40))
    )
    await db.commit()
    assert await service.purge(db, now=utcnow()) == 1

    as_user(root)
    done = await client.post(f"/api/v1/admin/users/{prof.id}/anonymize")
    assert done.status_code == 200, done.text
    row = await db.get(Action, uuid.UUID(door["id"]), populate_existing=True)
    assert row is not None and row.allowed_user_ids == []
