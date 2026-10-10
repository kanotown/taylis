"""M65 (docs/AI.md): AI bots that answer mentions, private summaries, limits and cost. The model
is always a FakeProvider: nothing here touches the network."""

import uuid
from collections.abc import Callable
from datetime import timedelta
from decimal import Decimal
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.ai import service as ai
from app.modules.ai.llm import AiRuntime, FakeProvider, LlmError, read_api_key
from app.modules.ai.models import AiRun
from app.modules.ai.pricing import cost_usd, price_model
from app.modules.ai.prompts import keep_newest
from app.modules.channels.models import Channel, ChannelMember
from app.modules.messages.models import Message
from app.modules.reads.models import ReadState
from app.modules.users.models import User
from tests.helpers import make_user

API = "/api/v1"


# --- helpers ------------------------------------------------------------------------------------


def _runtime(app: FastAPI) -> AiRuntime:
    runtime: AiRuntime = app.state.ai
    return runtime


def _fake(app: FastAPI, **kwargs: Any) -> FakeProvider:
    provider = FakeProvider(**kwargs)
    _runtime(app).provider = provider
    return provider


async def _drain(app: FastAPI) -> None:
    while await app.state.relay.process_batch():
        pass


async def _work(app: FastAPI, *, now: Any = None) -> int:
    return await ai.process_due(app.state.db, _runtime(app), now=now)


async def _agent(client: AsyncClient, username: str = "ai-chikuwa", **fields: Any) -> Any:
    payload = {
        "username": username,
        "name": "ちくわ AI",
        "character": "語尾に「ちく」を付けて話す。",
        "model": "claude-opus-5-5",
        **fields,
    }
    response = await client.post(f"{API}/admin/ai/agents", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _channel(client: AsyncClient, name: str, members: list[uuid.UUID], **extra: Any) -> str:
    created = await client.post(f"{API}/channels", json={"name": name, **extra})
    assert created.status_code == 201, created.text
    cid = str(created.json()["id"])
    for user_id in members:
        added = await client.post(f"{API}/channels/{cid}/members", json={"user_id": str(user_id)})
        assert added.status_code == 200, added.text
    return cid


async def _post(client: AsyncClient, cid: str, body: str, parent: str | None = None) -> Any:
    payload: dict[str, Any] = {"client_msg_id": str(uuid.uuid4()), "body": body}
    if parent:
        payload["parent_id"] = parent
    response = await client.post(f"{API}/channels/{cid}/messages", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _bot_posts(db: AsyncSession, bot_id: str) -> list[Message]:
    rows = await db.execute(
        select(Message)
        .where(Message.sender_id == uuid.UUID(bot_id))
        .order_by(Message.seq)
        .execution_options(populate_existing=True)
    )
    return list(rows.scalars().all())


async def _runs(db: AsyncSession) -> list[AiRun]:
    rows = await db.execute(
        select(AiRun).order_by(AiRun.created_at).execution_options(populate_existing=True)
    )
    return list(rows.scalars().all())


async def _setup(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> tuple[User, User, Any, str]:
    """An admin, a member, an AI bot, and a public channel with all three."""
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    agent = await _agent(client)
    cid = await _channel(client, "general", [alice.id, uuid.UUID(agent["bot_user_id"])])
    return root, alice, agent, cid


# --- pure parts ---------------------------------------------------------------------------------


def test_cost_from_the_price_table() -> None:
    # Opus 5.5: $4 in, $20 out, $0.20 cache read, cache write 1.25 x $4 per million tokens.
    got = cost_usd(
        "claude-opus-5-5",
        input_tokens=1000,
        output_tokens=200,
        cache_read_tokens=500,
        cache_write_tokens=100,
    )
    assert got == Decimal("0.008600")
    haiku = cost_usd(
        "claude-haiku-4-5",
        input_tokens=1_000_000,
        output_tokens=1_000_000,
        cache_read_tokens=1_000_000,
        cache_write_tokens=1_000_000,
    )
    assert haiku == Decimal("1") + Decimal("5") + Decimal("0.10") + Decimal("1.25")
    sonnet = cost_usd(
        "claude-sonnet-5-5",
        input_tokens=2_000_000,
        output_tokens=0,
        cache_read_tokens=0,
        cache_write_tokens=0,
    )
    assert sonnet == Decimal("4")
    # The model that answered decides (a dated id counts as its family); unknown → the one asked.
    assert price_model("claude-sonnet-5-5-20260901", "claude-opus-5-5") == "claude-sonnet-5-5"
    assert price_model("some-other-model", "claude-haiku-4-5") == "claude-haiku-4-5"


def test_keep_newest_within_the_limit() -> None:
    lines = [f"{i}: " + "あ" * 10 for i in range(10)]
    kept, omitted = keep_newest(lines, 42)
    assert kept == lines[-3:] and omitted == 7
    # The newest line alone is clipped rather than dropped.
    kept, omitted = keep_newest(["x" * 100], 10)
    assert len(kept[0]) == 10 and omitted == 0


def test_the_key_file(tmp_path: Any) -> None:
    assert read_api_key(str(tmp_path / "missing")) is None
    assert read_api_key(str(tmp_path)) is None  # a directory (docker's stand-in for a missing file)
    empty = tmp_path / "empty"
    empty.write_text("  \n")
    assert read_api_key(str(empty)) is None
    key = tmp_path / "key"
    key.write_text("sk-ant-test\n")
    assert read_api_key(str(key)) == "sk-ant-test"
    runtime = AiRuntime(str(key))
    opus = runtime.get_provider("claude-opus-5-5")
    assert runtime.available and opus is not None
    assert opus is runtime.get_provider("claude-opus-5-5")
    assert runtime.get_provider("gpt-6.1-sol") is None  # no OpenAI key file
    assert not AiRuntime(str(tmp_path / "missing")).available


# --- admin --------------------------------------------------------------------------------------


async def test_admin_crud_and_who_may(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(alice)
    denied = await client.post(
        f"{API}/admin/ai/agents",
        json={"username": "ai-x", "name": "X", "character": "", "model": "claude-opus-5-5"},
    )
    assert denied.status_code == 403
    assert (await client.get(f"{API}/admin/ai/agents")).status_code == 403
    assert (await client.get(f"{API}/admin/ai/usage")).status_code == 403

    as_user(root)
    agent = await _agent(client)
    assert agent["username"] == "ai-chikuwa" and agent["name"] == "ちくわ AI"
    assert agent["effort"] == "medium" and agent["allow_private"] is False and agent["enabled"]
    bot = await db.get(User, uuid.UUID(agent["bot_user_id"]))
    assert bot is not None and bot.role == "bot" and bot.display_name == "ちくわ AI"
    taken = await client.post(
        f"{API}/admin/ai/agents",
        json={"username": "ai-chikuwa", "name": "Y", "character": "", "model": "claude-opus-5-5"},
    )
    assert taken.status_code == 409 and taken.json()["error"]["code"] == "username_taken"
    taken = await client.post(
        f"{API}/admin/ai/agents",
        json={"username": "alice", "name": "Y", "character": "", "model": "claude-opus-5-5"},
    )
    assert taken.status_code == 409 and taken.json()["error"]["code"] == "username_taken"
    bad_model = await client.post(
        f"{API}/admin/ai/agents",
        json={"username": "ai-y", "name": "Y", "character": "", "model": "gpt-5"},
    )
    assert bad_model.status_code in (400, 422)

    patched = await client.patch(
        f"{API}/admin/ai/agents/{agent['id']}",
        json={"name": "ちくわ先生", "effort": "high", "username": "ignored", "allow_private": True},
    )
    assert patched.status_code == 200, patched.text
    body = patched.json()
    assert body["name"] == "ちくわ先生" and body["effort"] == "high" and body["allow_private"]
    assert body["username"] == "ai-chikuwa" and body["character"] == agent["character"]
    await db.refresh(bot)
    assert bot.display_name == "ちくわ先生"
    listed = (await client.get(f"{API}/admin/ai/agents")).json()
    assert [a["id"] for a in listed] == [agent["id"]]

    # Deleting: the bot leaves every conversation and is deactivated; not listed any more.
    cid = await _channel(client, "general", [bot.id])
    gone = await client.delete(f"{API}/admin/ai/agents/{agent['id']}")
    assert gone.status_code == 204
    await db.refresh(bot)
    assert bot.deactivated_at is not None
    member = await db.execute(
        select(ChannelMember).where(
            ChannelMember.channel_id == uuid.UUID(cid), ChannelMember.user_id == bot.id
        )
    )
    assert member.first() is None
    assert (await client.get(f"{API}/admin/ai/agents")).json() == []
    again = await client.patch(f"{API}/admin/ai/agents/{agent['id']}", json={"name": "Z"})
    assert again.status_code == 404 and again.json()["error"]["code"] == "ai_agent_not_found"


async def test_status_flags(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    status = (await client.get(f"{API}/ai/status")).json()
    assert status == {"available": False, "summary_available": False, "agents": []}
    agent = await _agent(client)
    # A bot but no key on this machine: still unavailable, the bots are listed for the badge.
    status = (await client.get(f"{API}/ai/status")).json()
    assert status["available"] is False and status["summary_available"] is False
    assert status["agents"] == [
        {
            "id": agent["id"],
            "bot_user_id": agent["bot_user_id"],
            "name": "ちくわ AI",
            "model": "claude-opus-5-5",
            "web_search": False,
        }
    ]
    _fake(app)
    status = (await client.get(f"{API}/ai/status")).json()
    assert status["available"] is True and status["summary_available"] is True
    # The month's budget used up: summaries are off, mentions still answer with a notice.
    await _spend(db, root, Decimal("30"))
    status = (await client.get(f"{API}/ai/status")).json()
    assert status["available"] is True and status["summary_available"] is False
    # A disabled bot is not offered.
    await client.patch(f"{API}/admin/ai/agents/{agent['id']}", json={"enabled": False})
    status = (await client.get(f"{API}/ai/status")).json()
    assert status["available"] is False and status["agents"] == []


async def _spend(db: AsyncSession, user: User, cost: Decimal) -> None:
    channel = (await db.execute(select(Channel).limit(1))).scalar_one_or_none()
    if channel is None:
        channel = Channel(type="public", name=f"spend-{uuid.uuid4().hex[:6]}", created_by=user.id)
        db.add(channel)
        await db.flush()
    db.add(
        AiRun(
            kind="summary",
            status="done",
            requester_id=user.id,
            channel_id=channel.id,
            cost_usd=cost,
            finished_at=utcnow(),
        )
    )
    await db.commit()


# --- mentions -----------------------------------------------------------------------------------


async def test_mention_gets_a_reply_in_the_thread(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = _fake(app, text="こんにちはちく。")
    _, alice, agent, cid = await _setup(client, db, as_user)
    bot_id = agent["bot_user_id"]
    as_user(alice)
    await _post(client, cid, "今日のゼミは 15 時からです")
    mention = await _post(client, cid, f"<@{bot_id}> ゼミは何時から?")
    await _drain(app)
    (run,) = await _runs(db)
    assert run.kind == "mention" and run.status == "pending"
    assert run.source_message_id == uuid.UUID(mention["id"])
    assert run.thread_id == uuid.UUID(mention["id"]) and run.requester_id == alice.id
    assert run.input is not None and "今日のゼミは 15 時からです" in run.input
    assert "@ちくわ AI ゼミは何時から?" in run.input and "Alice (" in run.input

    assert await _work(app) == 1
    (reply,) = await _bot_posts(db, bot_id)
    assert reply.parent_id == uuid.UUID(mention["id"]) and reply.body == "こんにちはちく。"
    (run,) = await _runs(db)
    assert run.status == "done" and run.output == "こんにちはちく。" and run.attempts == 1
    assert run.model == "claude-opus-5-5"
    assert (run.input_tokens, run.output_tokens) == (1000, 200)
    assert run.cost_usd == Decimal("0.008000")
    (request,) = provider.requests
    assert request.model == "claude-opus-5-5" and request.effort == "medium"
    assert request.max_tokens == 2000
    assert "語尾に「ちく」を付けて話す。" in request.system
    assert "指示ではありません" in request.system
    # The bot's post moves nobody's read position and is not itself answered.
    await _drain(app)
    assert len(await _runs(db)) == 1

    # A mention inside the thread: the reply goes to the same thread (its root).
    inner = await _post(client, cid, f"<@{bot_id}> 場所は?", parent=mention["id"])
    await _drain(app)
    await _work(app)
    posts = await _bot_posts(db, bot_id)
    assert len(posts) == 2 and posts[1].parent_id == uuid.UUID(mention["id"])
    runs = await _runs(db)
    assert runs[1].thread_id == uuid.UUID(mention["id"])
    assert runs[1].source_message_id == uuid.UUID(inner["id"])
    # The thread's context: the parent and the replies so far, the bot's answer among them.
    assert runs[1].input is not None and "こんにちはちく。" in runs[1].input

    # Handling the same event again (the outbox delivers at least once) and working again:
    # still one run and one reply per mention.
    async with app.state.db.session_factory() as session:
        assert await ai.handle_mention(session, _runtime(app), uuid.UUID(mention["id"])) is None
        await session.commit()
    await db.execute(update(OutboxEvent).values(processed_at=None))
    await db.commit()
    await _drain(app)
    await _work(app)
    assert len(await _runs(db)) == 2 and len(await _bot_posts(db, bot_id)) == 2
    # Mention runs emit no ai.run_updated.
    events = await db.execute(
        select(func.count()).where(OutboxEvent.event_type == "ai.run_updated")
    )
    assert events.scalar_one() == 0


async def test_who_is_not_answered(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    _fake(app)
    root, alice, agent, cid = await _setup(client, db, as_user)
    bot_id = agent["bot_user_id"]
    other = await _agent(client, "ai-other", name="別のボット")
    # Another bot (a webhook-like bot user) mentioning the AI bot: bots never talk to each other.
    webhook_bot = await make_user(db, "hook-bot", role="bot")
    await client.post(f"{API}/channels/{cid}/members", json={"user_id": str(webhook_bot.id)})
    as_user(webhook_bot)
    await _post(client, cid, f"<@{bot_id}> CI が落ちました")
    # The AI bot mentioning itself.
    bot_user = await db.get(User, uuid.UUID(bot_id))
    assert bot_user is not None
    as_user(bot_user)
    await _post(client, cid, f"<@{bot_id}> ひとりごと")
    # A bot that is not a member of the channel.
    as_user(alice)
    await _post(client, cid, f"<@{other['bot_user_id']}> いますか")
    # A disabled bot.
    as_user(root)
    await client.patch(f"{API}/admin/ai/agents/{agent['id']}", json={"enabled": False})
    as_user(alice)
    await _post(client, cid, f"<@{bot_id}> 起きてる?")
    await _drain(app)
    assert await _runs(db) == []
    assert await _work(app) == 0
    # The bot's only post is its own monologue; the other bot said nothing.
    assert [m.body for m in await _bot_posts(db, bot_id)] == [f"<@{bot_id}> ひとりごと"]
    assert await _bot_posts(db, other["bot_user_id"]) == []


async def test_private_conversations_need_allow_private(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    _fake(app)
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    agent = await _agent(client)
    bot_id = agent["bot_user_id"]
    cid = await _channel(client, "secret", [alice.id], type="private")
    refused = await client.post(f"{API}/channels/{cid}/members", json={"user_id": bot_id})
    assert refused.status_code == 400
    assert refused.json()["error"]["code"] == "ai_private_not_allowed"
    as_user(alice)
    dm = await client.post(f"{API}/dms", json={"user_ids": [bot_id]})
    assert dm.status_code == 400 and dm.json()["error"]["code"] == "ai_private_not_allowed"
    # Someone outside the private channel learns nothing about it.
    carol = await make_user(db, "carol")
    as_user(carol)
    outside = await client.post(f"{API}/channels/{cid}/members", json={"user_id": bot_id})
    assert outside.status_code == 403

    # A public channel with the bot that later becomes private: mentions are ignored there.
    as_user(root)
    pub = await _channel(client, "open", [alice.id, uuid.UUID(bot_id)])
    await db.execute(update(Channel).where(Channel.id == uuid.UUID(pub)).values(type="private"))
    await db.commit()
    as_user(alice)
    await _post(client, pub, f"<@{bot_id}> こんにちは")
    await _drain(app)
    assert await _runs(db) == []

    # With allow_private the bot joins private channels and DMs and answers there.
    as_user(root)
    await client.patch(f"{API}/admin/ai/agents/{agent['id']}", json={"allow_private": True})
    added = await client.post(f"{API}/channels/{cid}/members", json={"user_id": bot_id})
    assert added.status_code == 200, added.text
    as_user(alice)
    dm = await client.post(f"{API}/dms", json={"user_ids": [bot_id]})
    assert dm.status_code == 201, dm.text
    await _post(client, dm.json()["id"], f"<@{bot_id}> DM です")
    await _drain(app)
    await _work(app)
    (run,) = await _runs(db)
    assert run.status == "done" and run.input is not None and "ダイレクトメッセージ" in run.input
    assert len(await _bot_posts(db, bot_id)) == 1


async def test_limits_for_mentions_post_a_notice(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root, alice, agent, cid = await _setup(client, db, as_user)
    bot_id = agent["bot_user_id"]
    as_user(alice)
    # No key: a notice instead of a run.
    first = await _post(client, cid, f"<@{bot_id}> はじめまして")
    await _drain(app)
    assert await _runs(db) == []
    (notice,) = await _bot_posts(db, bot_id)
    assert notice.parent_id == uuid.UUID(first["id"])
    assert notice.body.startswith("応答できませんでした: ")
    # Processed again: still one notice (its client_msg_id comes from the message).
    await db.execute(update(OutboxEvent).values(processed_at=None))
    await db.commit()
    await _drain(app)
    assert len(await _bot_posts(db, bot_id)) == 1

    _fake(app)
    _runtime(app).user_daily_runs = 1
    await _post(client, cid, f"<@{bot_id}> 1 回目")
    await _drain(app)
    assert len(await _runs(db)) == 1
    over = await _post(client, cid, f"<@{bot_id}> 2 回目")
    await _drain(app)
    assert len(await _runs(db)) == 1
    posts = await _bot_posts(db, bot_id)
    assert posts[-1].parent_id == uuid.UUID(over["id"]) and "回数の上限" in posts[-1].body
    # Re-processing the first mention (which has its run) posts no limit notice.
    await db.execute(update(OutboxEvent).values(processed_at=None))
    await db.commit()
    await _drain(app)
    assert len(await _bot_posts(db, bot_id)) == 2

    _runtime(app).user_daily_runs = 50
    await _spend(db, root, Decimal("30"))
    broke = await _post(client, cid, f"<@{bot_id}> 3 回目")
    await _drain(app)
    assert len(await _runs(db)) == 2  # the spending row and the first mention
    posts = await _bot_posts(db, bot_id)
    assert posts[-1].parent_id == uuid.UUID(broke["id"]) and "今月" in posts[-1].body


async def test_retries_then_failure_posts_a_notice(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = _fake(app)
    provider.errors = [LlmError("API の利用が混み合っています", retryable=True) for _ in range(3)]
    _, alice, agent, cid = await _setup(client, db, as_user)
    bot_id = agent["bot_user_id"]
    as_user(alice)
    mention = await _post(client, cid, f"<@{bot_id}> 混んでる?")
    await _drain(app)
    assert await _work(app) == 1
    (run,) = await _runs(db)
    assert run.status == "pending" and run.attempts == 1 and run.next_attempt_at is not None
    assert await _work(app) == 0  # not before its time
    assert await _work(app, now=utcnow() + timedelta(seconds=31)) == 1
    (run,) = await _runs(db)
    assert run.status == "pending" and run.attempts == 2
    assert await _work(app, now=utcnow() + timedelta(seconds=200)) == 1
    (run,) = await _runs(db)
    assert run.status == "failed" and run.attempts == 3
    assert run.error == "API の利用が混み合っています" and run.finished_at is not None
    (notice,) = await _bot_posts(db, bot_id)
    assert notice.parent_id == uuid.UUID(mention["id"])
    assert notice.body == "応答できませんでした: API の利用が混み合っています"

    # A permanent error fails at once.
    provider.errors = [LlmError("API キーが使えません", retryable=False)]
    await _post(client, cid, f"<@{bot_id}> もう一度")
    await _drain(app)
    await _work(app)
    runs = await _runs(db)
    assert runs[1].status == "failed" and runs[1].attempts == 1
    assert (await _bot_posts(db, bot_id))[-1].body == "応答できませんでした: API キーが使えません"


async def test_refusal_and_max_tokens(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = _fake(app, stop_reason="refusal", text="")
    _, alice, agent, cid = await _setup(client, db, as_user)
    bot_id = agent["bot_user_id"]
    as_user(alice)
    await _post(client, cid, f"<@{bot_id}> 危ないこと")
    await _drain(app)
    await _work(app)
    (run,) = await _runs(db)
    assert run.status == "failed" and run.error is not None and "安全" in run.error
    assert run.cost_usd > 0  # a refusal is billed too
    assert (await _bot_posts(db, bot_id))[-1].body.startswith("応答できませんでした: ")

    provider.stop_reason, provider.text = "max_tokens", "長い答えの途中"
    await _post(client, cid, f"<@{bot_id}> 長い話")
    await _drain(app)
    await _work(app)
    runs = await _runs(db)
    assert runs[1].status == "done" and runs[1].output is not None
    assert runs[1].output.startswith("長い答えの途中") and "上限" in runs[1].output


async def test_a_crashed_run_is_picked_up_again(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    _fake(app)
    _, alice, agent, cid = await _setup(client, db, as_user)
    as_user(alice)
    await _post(client, cid, f"<@{agent['bot_user_id']}> やあ")
    await _drain(app)
    # A worker claimed it and died: the run stays running until its lease runs out.
    await db.execute(
        update(AiRun).values(
            status="running", attempts=1, locked_until=utcnow() + timedelta(minutes=5)
        )
    )
    await db.commit()
    assert await _work(app) == 0
    assert await _work(app, now=utcnow() + timedelta(minutes=6)) == 1
    (run,) = await _runs(db)
    assert run.status == "done" and run.attempts == 2


# --- summaries ----------------------------------------------------------------------------------


async def test_summaries_per_scope(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = _fake(app, text="- ゼミは 15 時")
    root, alice, agent, cid = await _setup(client, db, as_user)
    as_user(alice)
    early = await _post(client, cid, "読んだメッセージ")
    # Alice has read up to `early`; the rest is unread.
    await db.execute(
        update(ReadState)
        .where(ReadState.user_id == alice.id, ReadState.channel_id == uuid.UUID(cid))
        .values(last_read_seq=early["seq"])
    )
    await db.commit()
    as_user(root)
    parent = await _post(client, cid, "ゼミの時間を決めましょう")
    await _post(client, cid, "15 時でどうですか", parent=parent["id"])

    as_user(alice)
    created = await client.post(f"{API}/ai/summaries", json={"channel_id": cid, "scope": "unread"})
    assert created.status_code == 202, created.text
    run = created.json()
    assert run["kind"] == "summary" and run["status"] == "pending" and run["scope"] == "unread"
    assert run["omitted_count"] == 0 and run["output"] is None and run["finished_at"] is None
    await _work(app)
    done = (await client.get(f"{API}/ai/runs/{run['id']}")).json()
    assert done["status"] == "done" and done["output"] == "- ゼミは 15 時"
    assert done["finished_at"] is not None
    sent = provider.requests[-1]
    assert "読んだメッセージ" not in sent.user and "ゼミの時間を決めましょう" in sent.user
    assert "↳ Root (" in sent.user  # thread replies are marked
    assert sent.effort == "low" and sent.max_tokens == 4000
    assert "語尾" not in sent.system  # summaries do not use the bot's character
    # Nothing posted in the conversation.
    assert await _bot_posts(db, agent["bot_user_id"]) == []

    thread = await client.post(
        f"{API}/ai/summaries",
        json={"channel_id": cid, "scope": "thread", "thread_id": parent["id"]},
    )
    assert thread.status_code == 202 and thread.json()["thread_id"] == parent["id"]
    await _work(app)
    assert "読んだメッセージ" not in provider.requests[-1].user
    assert "スレッドの記録" in provider.requests[-1].user
    recent = await client.post(
        f"{API}/ai/summaries",
        json={"channel_id": cid, "scope": "recent", "days": 7, "tz_offset_minutes": 0},
    )
    assert recent.status_code == 202 and recent.json()["days"] == 7
    await _work(app)
    assert "読んだメッセージ" in provider.requests[-1].user
    assert "直近 7 日" in provider.requests[-1].user
    listed = (await client.get(f"{API}/ai/runs", params={"kind": "summary"})).json()
    assert [r["id"] for r in listed] == [recent.json()["id"], thread.json()["id"], run["id"]]
    assert all(r["status"] == "done" for r in listed)

    # Nothing unread: done at once, without a call.
    await db.execute(
        update(ReadState)
        .where(ReadState.user_id == alice.id, ReadState.channel_id == uuid.UUID(cid))
        .values(last_read_seq=10_000)
    )
    await db.commit()
    calls = len(provider.requests)
    empty = (
        await client.post(f"{API}/ai/summaries", json={"channel_id": cid, "scope": "unread"})
    ).json()
    assert empty["status"] == "done" and empty["output"] and len(provider.requests) == calls


async def test_summary_omits_the_oldest_beyond_the_limit(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = _fake(app)
    _, alice, _agent_out, cid = await _setup(client, db, as_user)
    as_user(alice)
    for i in range(8):
        await _post(client, cid, f"発言{i} " + "長" * 9_000)
    created = await client.post(
        f"{API}/ai/summaries", json={"channel_id": cid, "scope": "recent", "days": 1}
    )
    run = created.json()
    assert run["omitted_count"] == 2
    await _work(app)
    sent = provider.requests[-1].user
    assert "発言0 " not in sent and "発言1 " not in sent and "発言7 " in sent
    assert "古い 2 件は" in sent


async def test_summary_errors_and_permissions(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root, alice, _agent_out, cid = await _setup(client, db, as_user)
    as_user(alice)
    unavailable = await client.post(
        f"{API}/ai/summaries", json={"channel_id": cid, "scope": "unread"}
    )
    assert unavailable.status_code == 409
    assert unavailable.json()["error"]["code"] == "ai_unavailable"
    _fake(app)

    parent = await _post(client, cid, "親")
    reply = await _post(client, cid, "返信", parent=parent["id"])
    no_thread = await client.post(
        f"{API}/ai/summaries", json={"channel_id": cid, "scope": "thread"}
    )
    assert no_thread.status_code == 400
    assert no_thread.json()["error"]["code"] == "validation_error"
    not_parent = await client.post(
        f"{API}/ai/summaries",
        json={"channel_id": cid, "scope": "thread", "thread_id": reply["id"]},
    )
    assert not_parent.status_code == 400
    bad_days = await client.post(
        f"{API}/ai/summaries", json={"channel_id": cid, "scope": "recent", "days": 8}
    )
    assert bad_days.status_code in (400, 422)

    # Not a member (even of a public channel): 404.
    carol = await make_user(db, "carol")
    as_user(carol)
    hidden = await client.post(f"{API}/ai/summaries", json={"channel_id": cid, "scope": "unread"})
    assert hidden.status_code == 404 and hidden.json()["error"]["code"] == "channel_not_found"
    missing = await client.post(
        f"{API}/ai/summaries", json={"channel_id": str(uuid.uuid4()), "scope": "unread"}
    )
    assert missing.status_code == 404

    # Someone else's run is not found.
    as_user(alice)
    mine = (
        await client.post(f"{API}/ai/summaries", json={"channel_id": cid, "scope": "unread"})
    ).json()
    as_user(root)
    other = await client.get(f"{API}/ai/runs/{mine['id']}")
    assert other.status_code == 404 and other.json()["error"]["code"] == "ai_run_not_found"
    assert (await client.get(f"{API}/ai/runs")).json() == []

    # Limits: the daily count, then the month's budget.
    as_user(alice)
    _runtime(app).user_daily_runs = 1
    daily = await client.post(f"{API}/ai/summaries", json={"channel_id": cid, "scope": "unread"})
    assert daily.status_code == 429 and daily.json()["error"]["code"] == "ai_daily_limit"
    _runtime(app).user_daily_runs = 50
    await _spend(db, root, Decimal("30.5"))
    budget = await client.post(f"{API}/ai/summaries", json={"channel_id": cid, "scope": "unread"})
    assert budget.status_code == 429 and budget.json()["error"]["code"] == "ai_budget_exceeded"


async def test_run_updated_goes_to_the_requester(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = _fake(app)
    provider.errors = [LlmError("モデルが見つかりません", retryable=False)]
    _, alice, _agent_out, cid = await _setup(client, db, as_user)
    as_user(alice)
    await _post(client, cid, "話題")
    first = (
        await client.post(f"{API}/ai/summaries", json={"channel_id": cid, "scope": "recent"})
    ).json()
    await _work(app)
    second = (
        await client.post(f"{API}/ai/summaries", json={"channel_id": cid, "scope": "recent"})
    ).json()
    await _work(app)
    rows = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "ai.run_updated")
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    assert all(r.audience_type == "user" and r.audience_id == alice.id for r in rows)
    by_run: dict[str, list[str]] = {}
    for row in rows:
        by_run.setdefault(row.payload["run"]["id"], []).append(row.payload["run"]["status"])
    assert by_run[first["id"]] == ["running", "failed"]
    assert by_run[second["id"]] == ["running", "done"]
    failed = next(r for r in rows if r.payload["run"]["status"] == "failed")
    assert failed.payload["run"]["error"] == "モデルが見つかりません"
    # The relay resolves the audience to Alice alone.
    await _drain(app)


async def test_usage_and_purge(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    _fake(app)
    root, alice, agent, cid = await _setup(client, db, as_user)
    as_user(alice)
    await _post(client, cid, f"<@{agent['bot_user_id']}> 質問です")
    await _drain(app)
    await client.post(f"{API}/ai/summaries", json={"channel_id": cid, "scope": "recent"})
    await _work(app)
    as_user(root)
    usage = (await client.get(f"{API}/admin/ai/usage")).json()
    assert usage["month"] == utcnow().strftime("%Y-%m") and usage["budget_usd"] == 30
    assert usage["total_runs"] == 2 and usage["total_cost_usd"] == 0.016
    assert usage["by_agent"] == [
        {
            "agent_id": agent["id"],
            "name": "ちくわ AI",
            "runs": 2,
            "input_tokens": 2000,
            "output_tokens": 400,
            "cost_usd": 0.016,
            "web_search_requests": 0,
        }
    ]
    assert usage["by_user"] == [{"user_id": str(alice.id), "runs": 2, "cost_usd": 0.016}]
    old = (await client.get(f"{API}/admin/ai/usage", params={"month": "2020-01"})).json()
    assert old["total_runs"] == 0 and old["by_agent"] == [] and old["month"] == "2020-01"
    assert (await client.get(f"{API}/admin/ai/usage", params={"month": "2026-13"})).status_code in (
        400,
        422,
    )

    # 90 days later the prompt text goes; tokens and cost stay.
    async with app.state.db.session_factory() as session:
        assert await ai.purge_inputs(session, days=90) == 0
        assert await ai.purge_inputs(session, days=90, now=utcnow() + timedelta(days=91)) == 2
    runs = await _runs(db)
    assert all(r.input is None and r.cost_usd == Decimal("0.008") for r in runs)
