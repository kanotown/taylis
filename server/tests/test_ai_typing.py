"""docs/AI.md §2.2: an AI bot is shown as typing (the ordinary volatile `typing` frame) while its
mention run is open, to the conversation's members, in the reply's thread."""

import asyncio
import uuid
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.bus import Subscriber, Unsubscribe
from app.events.envelope import Envelope
from app.modules.ai import bot_typing
from app.modules.ai import service as ai
from app.modules.ai.llm import AiRuntime, FakeProvider, LlmRequest, LlmResult
from app.modules.ai.models import AiRun
from app.modules.users.models import User
from app.realtime.hub import RealtimeHub
from tests.helpers import make_user

API = "/api/v1"


class RecordingBus:
    def __init__(self) -> None:
        self.published: list[Envelope] = []

    async def publish(self, envelope: Envelope) -> None:
        self.published.append(envelope)

    def subscribe(self, subscriber: Subscriber) -> Unsubscribe:  # pragma: no cover - unused
        return lambda: None


class GatedProvider(FakeProvider):
    """Answers only once `gate` is set, so a run stays `running` meanwhile."""

    def __init__(self) -> None:
        super().__init__(text="はい。")
        self.gate = asyncio.Event()
        self.called = asyncio.Event()

    async def complete(self, request: LlmRequest) -> LlmResult:
        self.called.set()
        await self.gate.wait()
        return await super().complete(request)


def _runtime(app: FastAPI) -> AiRuntime:
    runtime: AiRuntime = app.state.ai
    return runtime


async def _drain(app: FastAPI) -> None:
    while await app.state.relay.process_batch():
        pass


async def _tick(app: FastAPI) -> list[Envelope]:
    bus = RecordingBus()
    sent = await bot_typing.publish_typing(app.state.db, bus)
    assert sent == len(bus.published)
    return bus.published


async def _post(client: AsyncClient, cid: str, body: str, parent: str | None = None) -> Any:
    payload: dict[str, Any] = {"client_msg_id": str(uuid.uuid4()), "body": body}
    if parent:
        payload["parent_id"] = parent
    response = await client.post(f"{API}/channels/{cid}/messages", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _setup(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> tuple[User, User, User, str, str]:
    """root (admin), alice and an AI bot in #general; carol only in #other (with the bot)."""
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    carol = await make_user(db, "carol")
    as_user(root)
    agent = await client.post(
        f"{API}/admin/ai/agents",
        json={
            "username": "ai-chikuwa",
            "name": "ちくわ AI",
            "character": "丁寧に話す。",
            "model": "claude-opus-5-5",
        },
    )
    assert agent.status_code == 201, agent.text
    bot_id = str(agent.json()["bot_user_id"])
    cids = []
    for name, members in (("general", [alice.id]), ("other", [carol.id])):
        created = await client.post(f"{API}/channels", json={"name": name})
        assert created.status_code == 201, created.text
        cid = str(created.json()["id"])
        for user_id in [*members, uuid.UUID(bot_id)]:
            added = await client.post(
                f"{API}/channels/{cid}/members", json={"user_id": str(user_id)}
            )
            assert added.status_code == 200, added.text
        cids.append(cid)
    return root, alice, carol, bot_id, cids[0]


def _shape(envelopes: list[Envelope]) -> set[tuple[str, str | None, str]]:
    return {
        (e.frame()["channel_id"], e.frame()["parent_id"], e.frame()["user_id"]) for e in envelopes
    }


async def _status(db: AsyncSession) -> list[str]:
    rows = await db.execute(
        select(AiRun.status).order_by(AiRun.created_at).execution_options(populate_existing=True)
    )
    return list(rows.scalars().all())


async def test_typing_while_pending_and_running_then_stops(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = GatedProvider()
    _runtime(app).provider = provider
    root, alice, _carol, bot_id, cid = await _setup(client, db, as_user)
    assert await _tick(app) == []  # nothing open: no frames

    as_user(alice)
    mention = await _post(client, cid, f"<@{bot_id}> ゼミは何時から?")
    await _drain(app)
    assert await _status(db) == ["pending"]

    # Pending: a top-level mention shows in the conversation and in the reply's thread.
    pending = await _tick(app)
    assert _shape(pending) == {(cid, None, bot_id), (cid, mention["id"], bot_id)}
    for envelope in pending:
        assert envelope.frame() == {
            "type": "typing",
            "channel_id": cid,
            "parent_id": envelope.frame()["parent_id"],
            "user_id": bot_id,
        }
        assert envelope.audience.kind == "users"
        # The conversation's members, not the bot, not carol (only in #other).
        assert set(envelope.audience.ids) == {root.id, alice.id}
        assert envelope.seq is None

    # Running (the model has not answered yet): still typing, every tick.
    work = asyncio.create_task(ai.process_due(app.state.db, _runtime(app)))
    await asyncio.wait_for(provider.called.wait(), timeout=5)
    assert await _status(db) == ["running"]
    assert _shape(await _tick(app)) == _shape(pending)
    assert _shape(await _tick(app)) == _shape(pending)

    # Done: the reply is posted, the frames stop (clients drop the typer; the reply clears it).
    provider.gate.set()
    assert await asyncio.wait_for(work, timeout=5) == 1
    assert await _status(db) == ["done"]
    assert await _tick(app) == []


async def test_a_mention_in_a_thread_types_in_that_thread_only(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    _runtime(app).provider = FakeProvider()
    _, alice, _, bot_id, cid = await _setup(client, db, as_user)
    as_user(alice)
    root_message = await _post(client, cid, "スレッドの親")
    await _post(client, cid, f"<@{bot_id}> 場所は?", parent=root_message["id"])
    await _drain(app)
    assert _shape(await _tick(app)) == {(cid, root_message["id"], bot_id)}

    # A failed run stops too.
    _runtime(app).provider = FakeProvider(stop_reason="refusal")
    await ai.process_due(app.state.db, _runtime(app))
    assert await _status(db) == ["failed"]
    assert await _tick(app) == []


async def test_a_removed_bot_stops_typing(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    _runtime(app).provider = FakeProvider()
    root, alice, _, bot_id, cid = await _setup(client, db, as_user)
    as_user(alice)
    await _post(client, cid, f"<@{bot_id}> こんにちは")
    await _drain(app)
    assert len(await _tick(app)) == 2
    as_user(root)
    removed = await client.delete(f"{API}/channels/{cid}/members/{bot_id}")
    assert removed.status_code in (200, 204), removed.text
    # Not a member any more: no frame even before the relay cancels the run…
    assert await _tick(app) == []
    await _drain(app)
    assert await _status(db) == ["failed"]  # …and the run is cancelled
    assert await _tick(app) == []


async def test_the_hub_delivers_the_frame_to_members_only(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    _runtime(app).provider = FakeProvider()
    _, alice, carol, bot_id, cid = await _setup(client, db, as_user)
    hub = RealtimeHub()
    conns = {
        user: hub.new_connection(user, uuid.uuid4())
        for user in (alice.id, carol.id, uuid.UUID(bot_id))
    }
    for conn in conns.values():  # presence frames from connecting
        while not conn.queue.empty():
            conn.queue.get_nowait()
    as_user(alice)
    mention = await _post(client, cid, f"<@{bot_id}> 質問です", parent=None)
    await _drain(app)
    for envelope in await _tick(app):
        await hub.on_event(envelope)
    got = []
    while not conns[alice.id].queue.empty():
        got.append(conns[alice.id].queue.get_nowait())
    assert sorted(got, key=lambda f: str(f["parent_id"])) == sorted(
        [
            {"type": "typing", "channel_id": cid, "parent_id": p, "user_id": bot_id}
            for p in (None, mention["id"])
        ],
        key=lambda f: str(f["parent_id"]),
    )
    assert conns[carol.id].queue.empty() and conns[uuid.UUID(bot_id)].queue.empty()
