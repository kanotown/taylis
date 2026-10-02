"""The server findings of the external review of v0.1.18 (docs/AI.md §8, the review fixes):
#2 the summary's target, #3 sending only while still allowed, #4 the budget reservation, #7 the
usage of failed attempts, #8 the daily count under concurrency, #9 stale workers, #10 mentions
that failed in the relay, #11 replies that failed to post. FakeProviders only: no network."""

import asyncio
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from openai.types.responses import Response
from sqlalchemy import func, select, update
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.ai import repository as ai_repo
from app.modules.ai import service as ai
from app.modules.ai.llm import (
    AiRuntime,
    FakeProvider,
    LlmError,
    LlmRequest,
    LlmResult,
    OpenAIProvider,
)
from app.modules.ai.models import AiAgent, AiMentionInbox, AiRun
from app.modules.ai.schemas import AiSummaryCreate
from app.modules.channels.models import Channel
from app.modules.messages import service as messages_service
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_ai import _agent, _bot_posts, _channel, _drain, _post, _runs, _spend, _work
from tests.test_ai_openai import _Client, _only

API = "/api/v1"


def _db_error() -> OperationalError:
    return OperationalError("SELECT 1", {}, Exception("the server closed the connection"))


async def _run(db: AsyncSession, run_id: Any) -> AiRun:
    row = await db.execute(
        select(AiRun)
        .where(AiRun.id == uuid.UUID(str(run_id)))
        .execution_options(populate_existing=True)
    )
    return row.scalar_one()


async def _summary(client: AsyncClient, cid: str) -> Any:
    return await client.post(f"{API}/ai/summaries", json={"channel_id": cid, "scope": "recent"})


# --- #2 the summary goes where the conversation's bot goes, fixed when asked ----------------------


async def test_summary_uses_the_conversations_bot_and_says_so(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    tmp_path: Any,
) -> None:
    claude_fake, gpt_fake = FakeProvider(text="Claude"), FakeProvider(text="GPT")
    _only(app, tmp_path, anthropic=claude_fake, openai=gpt_fake)
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    # The default bot (the first one) is Anthropic's and may not read private conversations.
    claude = await _agent(client, "ai-claude")
    gpt = await _agent(client, "ai-gpt", name="GPT 先生", model="gpt-6.1-sol", allow_private=True)
    secret = await _channel(
        client, "secret", [alice.id, uuid.UUID(gpt["bot_user_id"])], type="private"
    )
    open_ = await _channel(client, "open", [alice.id])

    as_user(alice)
    await _post(client, secret, "非公開の話")
    # Shown before asking: the conversation's bot, OpenAI.
    target = await client.get(f"{API}/ai/summaries/target", params={"channel_id": secret})
    assert target.status_code == 200, target.text
    assert target.json() == {
        "available": True,
        "provider": "openai",
        "model": "gpt-6.1-sol",
        "agent_name": "GPT 先生",
        "reason": None,
    }
    created = await _summary(client, secret)
    assert created.status_code == 202, created.text
    assert created.json()["provider"] == "openai" and created.json()["model"] == "gpt-6.1-sol"
    await _work(app)
    assert [r.model for r in gpt_fake.requests] == ["gpt-6.1-sol"]
    assert claude_fake.requests == []  # nothing private went to the other provider
    (run,) = await _runs(db)
    assert run.agent_id == uuid.UUID(gpt["id"]) and run.provider == "openai"

    # A conversation without a bot: the default bot, Anthropic.
    await _post(client, open_, "公開の話")
    target = (await client.get(f"{API}/ai/summaries/target", params={"channel_id": open_})).json()
    assert (target["provider"], target["model"], target["agent_name"]) == (
        "anthropic",
        "claude-opus-5-5",
        "ちくわ AI",
    )
    assert target["available"] is True
    created = await _summary(client, open_)
    assert created.json()["provider"] == "anthropic"
    await _work(app)
    assert len(claude_fake.requests) == 1

    # A DM without a bot: the default bot lacks allow_private → refused, and said so up front.
    carol = await make_user(db, "carol")
    dm = await client.post(f"{API}/dms", json={"user_ids": [str(carol.id)]})
    dm_id = dm.json()["id"]
    await _post(client, dm_id, "DM の話")
    target = (await client.get(f"{API}/ai/summaries/target", params={"channel_id": dm_id})).json()
    assert target["available"] is False and target["reason"] == "ai_private_not_allowed"
    assert target["provider"] == "anthropic" and target["agent_name"] == claude["name"]
    refused = await _summary(client, dm_id)
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "ai_private_not_allowed"
    assert len(claude_fake.requests) == 1 and len(gpt_fake.requests) == 1
    # A conversation one cannot read: 404, as for the summary itself.
    as_user(carol)
    hidden = await client.get(f"{API}/ai/summaries/target", params={"channel_id": secret})
    assert hidden.status_code == 404


async def test_a_waiting_summary_never_switches_provider(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    tmp_path: Any,
) -> None:
    claude_fake, gpt_fake = FakeProvider(), FakeProvider()
    runtime = _only(app, tmp_path, anthropic=claude_fake, openai=gpt_fake)
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _agent(client, "ai-claude")
    gpt = await _agent(client, "ai-gpt", model="gpt-6.1-sol")
    cid = await _channel(client, "general", [alice.id, uuid.UUID(gpt["bot_user_id"])])
    as_user(alice)
    await _post(client, cid, "話題")
    first = (await _summary(client, cid)).json()
    second = (await _summary(client, cid)).json()
    assert first["provider"] == second["provider"] == "openai"

    # The OpenAI key goes away while they wait: they fail, nothing goes to Anthropic.
    runtime.providers = {"anthropic": claude_fake}
    await _work(app)
    for run_id in (first["id"], second["id"]):
        done = (await client.get(f"{API}/ai/runs/{run_id}")).json()
        assert done["status"] == "failed" and "API キー" in done["error"]
    assert claude_fake.requests == [] and gpt_fake.requests == []

    # The bot is disabled while one waits: it fails at once with the reason (no switch).
    runtime.providers = {"anthropic": claude_fake, "openai": gpt_fake}
    third = (await _summary(client, cid)).json()
    as_user(root)
    await client.patch(f"{API}/admin/ai/agents/{gpt['id']}", json={"enabled": False})
    as_user(alice)
    await _work(app)
    done = (await client.get(f"{API}/ai/runs/{third['id']}")).json()
    assert done["status"] == "failed" and done["error"] == ai.AGENT_GONE
    assert claude_fake.requests == [] and gpt_fake.requests == []


# --- #3 a mention is sent only while the bot is still allowed there -----------------------------


async def test_a_waiting_mention_is_not_sent_once_no_longer_allowed(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = FakeProvider()
    app.state.ai.provider = provider
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    agent = await _agent(client, allow_private=True)
    bot_id = agent["bot_user_id"]
    secret = await _channel(client, "secret", [alice.id, uuid.UUID(bot_id)], type="private")
    general = await _channel(client, "general", [alice.id, uuid.UUID(bot_id)])

    # allow_private revoked while the mention waits: cancelled, nothing sent, the thread told.
    as_user(alice)
    mention = await _post(client, secret, f"<@{bot_id}> 秘密の相談")
    await _drain(app)
    (run,) = await _runs(db)
    assert run.status == "pending"
    as_user(root)
    await client.patch(f"{API}/admin/ai/agents/{agent['id']}", json={"allow_private": False})
    run = await _run(db, run.id)
    assert run.status == "failed" and run.error == ai.PRIVATE_REVOKED
    assert run.reserved_usd == 0
    await _work(app)
    assert provider.requests == []
    (notice,) = await _bot_posts(db, bot_id)
    assert notice.parent_id == uuid.UUID(mention["id"])
    assert notice.body == ai.NOTICE_PREFIX + ai.PRIVATE_REVOKED

    # Revoked behind the cancellation's back (e.g. a race): the worker checks before sending.
    await client.patch(f"{API}/admin/ai/agents/{agent['id']}", json={"allow_private": True})
    as_user(alice)
    await _post(client, secret, f"<@{bot_id}> もう一度")
    await _drain(app)
    await db.execute(update(AiAgent).values(allow_private=False))
    await db.commit()
    await _work(app)
    assert provider.requests == []
    assert (await _runs(db))[-1].error == ai.PRIVATE_REVOKED

    # A public channel that becomes private while the mention waits (the bot lacks allow_private).
    await _post(client, general, f"<@{bot_id}> 公開の質問")
    await _drain(app)
    await db.execute(update(Channel).where(Channel.id == uuid.UUID(general)).values(type="private"))
    await db.commit()
    await _work(app)
    assert provider.requests == []
    assert (await _runs(db))[-1].status == "failed"

    # The bot taken out of the conversation while the mention waits.
    await db.execute(update(Channel).where(Channel.id == uuid.UUID(general)).values(type="public"))
    await db.commit()
    await _post(client, general, f"<@{bot_id}> まだいる?")
    await _drain(app)
    as_user(root)
    removed = await client.delete(f"{API}/channels/{general}/members/{bot_id}")
    assert removed.status_code == 204, removed.text
    await _drain(app)  # channel.member_removed: the pending mention is cancelled
    last = (await _runs(db))[-1]
    assert last.status == "failed" and last.error == ai.BOT_REMOVED
    await _work(app)
    assert provider.requests == []
    assert last.id is not None and (await _run(db, last.id)).reply_state == "failed"


# --- #4 the budget is reserved when a run is made ------------------------------------------------


async def test_the_budget_is_reserved_and_checked_again(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = FakeProvider()
    runtime: AiRuntime = app.state.ai
    runtime.provider = provider
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _agent(client, model="gpt-6.1-sol")
    cid = await _channel(client, "general", [alice.id])
    as_user(alice)
    await _post(client, cid, "予算の話")
    first = await _summary(client, cid)
    assert first.status_code == 202
    run = await _run(db, first.json()["id"])
    # Conservative: the whole output allowance with OpenAI's reasoning room, three attempts.
    assert run.reserved_usd >= Decimal("0.27") * 3 and run.cost_usd == 0
    # Only room for one such run: the second (still waiting) does not fit beside the first.
    runtime.monthly_budget_usd = float(run.reserved_usd * Decimal("1.5"))
    second = await _summary(client, cid)
    assert second.status_code == 429
    assert second.json()["error"]["code"] == "ai_budget_exceeded"
    status = (await client.get(f"{API}/ai/status")).json()
    assert status["summary_available"] is True  # the reservation alone does not use it up

    # Settled to the actual cost when it ends: then there is room again.
    await _work(app)
    run = await _run(db, run.id)
    assert run.status == "done" and run.reserved_usd == 0 and run.cost_usd == Decimal("0.004")
    third = await _summary(client, cid)
    assert third.status_code == 202

    # The worker checks again before it sends: the budget lowered meanwhile → failed, no call.
    runtime.monthly_budget_usd = 0.001
    await _work(app)
    done = (await client.get(f"{API}/ai/runs/{third.json()['id']}")).json()
    assert done["status"] == "failed" and "上限" in done["error"]
    assert len(provider.requests) == 1

    # A run counts in the month it was created (UTC): last month's spending does not count now.
    runtime.monthly_budget_usd = 30
    await _spend(db, root, Decimal("100"))
    last_month = datetime.now(UTC).replace(day=1) - timedelta(days=1)
    await db.execute(
        update(AiRun).where(AiRun.cost_usd == Decimal("100")).values(created_at=last_month)
    )
    await db.commit()
    assert (await _summary(client, cid)).status_code == 202
    assert await ai.month_committed(db, last_month) == Decimal("100")


async def test_concurrent_pending_mentions_cannot_overrun_the_budget(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = FakeProvider()
    runtime: AiRuntime = app.state.ai
    runtime.provider = provider
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    agent = await _agent(client)
    bot_id = agent["bot_user_id"]
    cid = await _channel(client, "general", [alice.id, uuid.UUID(bot_id)])
    reserve = ai.estimate_run("mention", "claude-opus-5-5", "x" * 200, "y" * 400)
    runtime.monthly_budget_usd = float(reserve * 2)
    as_user(alice)
    for i in range(4):
        await _post(client, cid, f"<@{bot_id}> 質問 {i}")
    await _drain(app)
    runs = await _runs(db)
    # Two fit within the budget while waiting; the others get the notice instead.
    assert len(runs) == 2
    assert sum(1 for m in await _bot_posts(db, bot_id) if "今月" in m.body) == 2
    await _work(app)
    assert len(provider.requests) == 2


# --- #7 a failed attempt's usage is recorded ----------------------------------------------------


async def test_openai_failed_response_keeps_its_usage() -> None:
    usage = {
        "input_tokens": 1000,
        "input_tokens_details": {"cached_tokens": 0},
        "output_tokens": 700,
        "output_tokens_details": {"reasoning_tokens": 700},
        "total_tokens": 1700,
    }
    for status in ("failed", "cancelled"):
        response = Response.construct(
            id="r",
            model="gpt-6.1-sol",
            status=status,
            output=[],
            error={"code": "server_error"},
            usage=usage,
        )
        request = LlmRequest(model="gpt-6.1-sol", effort="low", system="s", user="u", max_tokens=1)
        with pytest.raises(LlmError) as info:
            await OpenAIProvider("k", client=_Client(response)).complete(request)
        assert info.value.usage is not None
        assert (info.value.usage.input_tokens, info.value.usage.output_tokens) == (1000, 700)
    without = Response.construct(id="r", model="gpt-6.1-sol", status="failed", output=[])
    with pytest.raises(LlmError) as info:
        await OpenAIProvider("k", client=_Client(without)).complete(request)
    assert info.value.usage is None


async def test_failed_attempts_add_their_usage_across_retries(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = FakeProvider()
    app.state.ai.provider = provider
    billed = LlmResult(text="", stop_reason=None, model="gpt-6.1-sol", output_tokens=700)
    provider.errors = [
        LlmError("API の応答が失敗しました (server_error)", retryable=True, usage=billed),
        LlmError("API の利用が混み合っています", retryable=True),  # no usage
    ]
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    await _agent(client, model="gpt-6.1-sol")
    cid = await _channel(client, "general", [alice.id])
    as_user(alice)
    await _post(client, cid, "話題")
    run_id = (await _summary(client, cid)).json()["id"]
    await _work(app)
    run = await _run(db, run_id)
    assert run.status == "pending" and run.output_tokens == 700
    assert run.cost_usd == Decimal("0.007")  # 700 x $10 per million
    await _work(app, now=utcnow() + timedelta(seconds=31))
    await _work(app, now=utcnow() + timedelta(seconds=200))
    run = await _run(db, run_id)
    # The success adds its own (1000 in, 200 out): $0.004 more.
    assert run.status == "done" and run.output_tokens == 900 and run.input_tokens == 1000
    assert run.cost_usd == Decimal("0.011") and run.reserved_usd == 0


# --- #8 the daily count holds under concurrent requests -----------------------------------------


@dataclass
class _Rendezvous:
    """Holds whoever has read the day's count until the other one has too (or 0.5 s passed):
    without the lock both read the same count before either inserts."""

    arrived: int = 0
    both: asyncio.Event = field(default_factory=asyncio.Event)

    def wrap(self, original: Any) -> Any:
        async def runs_since(*args: Any) -> int:
            count: int = await original(*args)
            self.arrived += 1
            if self.arrived >= 2:
                self.both.set()
            try:
                await asyncio.wait_for(self.both.wait(), 0.5)
            except TimeoutError:
                pass
            return count

        return runs_since


async def test_the_daily_count_holds_under_concurrency(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime: AiRuntime = app.state.ai
    runtime.provider = FakeProvider()
    runtime.user_daily_runs = 1
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    agent = await _agent(client)
    cid = await _channel(client, "general", [alice.id, uuid.UUID(agent["bot_user_id"])])
    as_user(alice)
    await _post(client, cid, "話題")
    original = ai_repo.runs_since
    monkeypatch.setattr(ai_repo, "runs_since", _Rendezvous().wrap(original))

    async def summarise() -> str:
        async with app.state.db.session_factory() as session:
            try:
                await ai.create_summary(
                    session,
                    runtime,
                    alice,
                    AiSummaryCreate(channel_id=uuid.UUID(cid), scope="recent"),
                )
            except AppError as exc:
                return exc.code
            return "ok"

    outcomes = await asyncio.gather(summarise(), summarise())
    assert sorted(outcomes) == ["ai_daily_limit", "ok"]
    assert len(await _runs(db)) == 1

    # A summary and a mention at once: the same lock, still one run between them.
    await db.execute(update(AiRun).values(created_at=utcnow() - timedelta(days=2)))
    await db.commit()
    mention = await _post(client, cid, f"<@{agent['bot_user_id']}> 質問")
    monkeypatch.setattr(ai_repo, "runs_since", _Rendezvous().wrap(original))

    async def mention_run() -> str:
        async with app.state.db.session_factory() as session:
            run_id = await ai.handle_mention(session, runtime, uuid.UUID(mention["id"]))
            await session.commit()
        return "ok" if run_id is not None else "refused"

    outcomes = await asyncio.gather(summarise(), mention_run())
    assert sorted(outcomes) in (["ai_daily_limit", "ok"], ["ok", "refused"])
    assert len(await _runs(db)) == 2  # the old one and one of these


# --- #9 a worker that lost its lease does not decide the run ------------------------------------


@dataclass
class _HeldProvider:
    """Each call waits until released; answers with the text given when releasing it."""

    calls: list[asyncio.Future[str]] = field(default_factory=list)
    requests: list[LlmRequest] = field(default_factory=list)

    async def complete(self, request: LlmRequest) -> LlmResult:
        self.requests.append(request)
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self.calls.append(future)
        text = await future
        return LlmResult(text=text, stop_reason="end_turn", model=request.model, input_tokens=1000)


async def _until(condition: Callable[[], bool]) -> None:
    for _ in range(200):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out")


async def test_a_stale_worker_does_not_finish_the_run(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    provider = _HeldProvider()
    runtime: AiRuntime = app.state.ai
    runtime.provider = provider
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    agent = await _agent(client)
    bot_id = agent["bot_user_id"]
    cid = await _channel(client, "general", [alice.id, uuid.UUID(bot_id)])
    as_user(alice)
    await _post(client, cid, f"<@{bot_id}> 質問")
    await _drain(app)
    database = app.state.db

    async def claim(at: datetime) -> list[tuple[uuid.UUID, int]]:
        async with database.session_factory() as session:
            claimed = await ai_repo.claim(session, at, at + ai.LEASE, 2)
            await session.commit()
        return claimed

    ((run_id, old),) = await claim(utcnow())
    stale = asyncio.create_task(ai._execute(database, runtime, run_id, old))
    await _until(lambda: len(provider.calls) == 1)
    # The old worker hangs past its lease; another claims the run and calls again.
    ((same_id, new),) = await claim(utcnow() + ai.LEASE + timedelta(minutes=1))
    assert same_id == run_id and new == old + 1
    fresh = asyncio.create_task(ai._execute(database, runtime, run_id, new))
    await _until(lambda: len(provider.calls) == 2)
    # The old one comes back first: its result is not used, its tokens are kept.
    provider.calls[0].set_result("古い答え")
    await stale
    run = await _run(db, run_id)
    assert run.status == "running" and run.output is None and run.input_tokens == 1000
    assert await _bot_posts(db, bot_id) == []
    provider.calls[1].set_result("新しい答え")
    await fresh
    run = await _run(db, run_id)
    assert run.status == "done" and run.output == "新しい答え"
    assert run.input_tokens == 2000 and run.cost_usd == Decimal("0.008")  # both calls billed
    assert [m.body for m in await _bot_posts(db, bot_id)] == ["新しい答え"]


# --- #10 a mention whose handling failed in the relay is tried again -----------------------------


async def test_a_failed_mention_enqueue_is_tried_again(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = FakeProvider(text="お答えします")
    app.state.ai.provider = provider
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    agent = await _agent(client)
    bot_id = agent["bot_user_id"]
    cid = await _channel(client, "general", [alice.id, uuid.UUID(bot_id)])
    original = ai_repo.insert_run_once
    failures = [_db_error()]

    async def flaky(*args: Any) -> Any:
        if failures:
            raise failures.pop(0)
        return await original(*args)

    monkeypatch.setattr(ai_repo, "insert_run_once", flaky)
    as_user(alice)
    mention = await _post(client, cid, f"<@{bot_id}> 質問です")
    await _drain(app)
    # The event itself went through (once, its pushes were not held back); the mention waits.
    event = (
        await db.execute(
            select(OutboxEvent)
            .where(OutboxEvent.event_type == "message.created", OutboxEvent.seq == mention["seq"])
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert event.processed_at is not None and event.attempts == 0
    assert await _runs(db) == []
    inbox = (await db.execute(select(AiMentionInbox))).scalars().all()
    assert [row.message_id for row in inbox] == [uuid.UUID(mention["id"])]

    assert await _work(app) == 0  # not before its pause
    assert await _work(app, now=utcnow() + timedelta(seconds=11)) == 1
    (run,) = await _runs(db)
    assert run.source_message_id == uuid.UUID(mention["id"]) and run.status == "done"
    assert [m.body for m in await _bot_posts(db, bot_id)] == ["お答えします"]
    assert (await db.execute(select(func.count()).select_from(AiMentionInbox))).scalar_one() == 0
    await _work(app, now=utcnow() + timedelta(minutes=5))
    assert len(await _runs(db)) == 1 and len(provider.requests) == 1

    # Failing every time: after the last try the thread is told, nothing is left behind.
    failures.extend(_db_error() for _ in range(ai.INBOX_MAX_ATTEMPTS + 1))
    second = await _post(client, cid, f"<@{bot_id}> もう一つ")
    await _drain(app)
    moment = utcnow()
    for _ in range(ai.INBOX_MAX_ATTEMPTS):
        moment += timedelta(hours=1)
        await _work(app, now=moment)
    assert len(await _runs(db)) == 1
    notice = (await _bot_posts(db, bot_id))[-1]
    assert notice.parent_id == uuid.UUID(second["id"])
    assert notice.body == ai.NOTICE_PREFIX + ai.MENTION_LOST
    assert (await db.execute(select(func.count()).select_from(AiMentionInbox))).scalar_one() == 0


# --- #11 a reply that failed to post is posted later, without calling the model again -----------


async def test_a_reply_that_failed_to_post_is_posted_later(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = FakeProvider(text="保存された答え")
    app.state.ai.provider = provider
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)
    agent = await _agent(client)
    bot_id = agent["bot_user_id"]
    cid = await _channel(client, "general", [alice.id, uuid.UUID(bot_id)])
    as_user(alice)
    mention = await _post(client, cid, f"<@{bot_id}> 質問")
    await _drain(app)
    original = messages_service.create_message
    failures = [_db_error()]

    async def flaky(*args: Any, **kwargs: Any) -> Any:
        if failures:
            raise failures.pop(0)
        return await original(*args, **kwargs)

    monkeypatch.setattr(messages_service, "create_message", flaky)
    await _work(app)
    (run,) = await _runs(db)
    assert run.status == "done" and run.output == "保存された答え"
    assert run.reply_state == "pending" and run.cost_usd == Decimal("0.008")
    assert await _bot_posts(db, bot_id) == []
    assert await _work(app) == 0  # not before its pause
    await _work(app, now=utcnow() + timedelta(seconds=31))
    (reply,) = await _bot_posts(db, bot_id)
    assert reply.body == "保存された答え" and reply.parent_id == uuid.UUID(mention["id"])
    run = await _run(db, run.id)
    assert run.reply_state == "posted" and run.cost_usd == Decimal("0.008")
    assert len(provider.requests) == 1  # the model was asked once
    await _work(app, now=utcnow() + timedelta(hours=1))
    assert len(await _bot_posts(db, bot_id)) == 1

    # Refused for good after a temporary failure (the channel archived meanwhile): failed.
    await _post(client, cid, f"<@{bot_id}> もう一つ")
    await _drain(app)
    failures.append(_db_error())
    await _work(app)
    await db.execute(
        update(Channel).where(Channel.id == uuid.UUID(cid)).values(archived_at=utcnow())
    )
    await db.commit()
    await _work(app, now=utcnow() + timedelta(seconds=31))
    last = (await _runs(db))[-1]
    assert last.status == "failed" and last.reply_state == "failed"
    assert last.error is not None and "アーカイブ" in last.error
    assert last.output == "保存された答え" and len(provider.requests) == 2
    assert len(await _bot_posts(db, bot_id)) == 1
