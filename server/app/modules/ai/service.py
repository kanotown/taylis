"""AI bots and summaries (docs/AI.md, M65).

A leaf module. An AI bot is a `bot` user with an `ai_agents` row; it answers a mention in the
mention's thread, through the ordinary message path (seq, outbox, pushes and search need nothing
special). A summary is shown only to the person who asked (`ai.run_updated`, `GET /ai/runs/{id}`).

Flow: the outbox handler `AiMentionHandler` (message.created) or `POST /ai/summaries` writes an
`ai_runs` row with the prompt text already built (what the requester could read at that moment);
the worker (`process_due`, its own loop in main.py) claims open rows under a lease, calls the
provider outside any transaction, and records the result, the tokens and the cost. A run that
fails for good says so: a mention gets a short reply 「応答できませんでした: …」, a summary
`status = failed` with `error`.

Review v0.1.18 (docs/AI.md §8): a run's target (bot, provider, model) is fixed when it is made;
its estimated cost is reserved against the month's budget under a lock; the worker checks again
before it sends anything (the bot still allowed there, the budget) and its results count only
while it still holds the run (generation); a mention's reply is posted apart from getting it; a
mention whose handling failed in the relay waits in `ai_mention_inbox` for another try.
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import Database
from app.core.errors import AppError, bad_request, conflict, not_found
from app.core.ids import uuid7
from app.core.time import utcnow
from app.events.envelope import Audience
from app.events.models import OutboxEvent
from app.events.outbox import write_outbox
from app.modules.admin import service as admin
from app.modules.ai import prompts
from app.modules.ai import repository as repo
from app.modules.ai.events import AI_RUN_UPDATED, AiRunUpdatedData
from app.modules.ai.llm import (
    MODEL_PROVIDERS,
    OPENAI,
    OPENAI_REASONING_ROOM,
    PROVIDERS,
    AiRuntime,
    LlmError,
    LlmRequest,
    LlmResult,
    provider_of,
)
from app.modules.ai.models import AiAgent, AiRun
from app.modules.ai.pricing import cost_usd, estimate_usd, price_model
from app.modules.ai.schemas import (
    AiAgentCreate,
    AiAgentOut,
    AiAgentUpdate,
    AiProviderOut,
    AiRunOut,
    AiStatusOut,
    AiSummaryCreate,
    AiSummaryTargetOut,
    AiUsageByAgent,
    AiUsageByUser,
    AiUsageOut,
    to_agent_out,
    to_agent_public,
    to_run_out,
)
from app.modules.audit import service as audit
from app.modules.channels import service as channels
from app.modules.channels.events import CHANNEL_MEMBER_REMOVED
from app.modules.channels.models import Channel
from app.modules.messages import service as messages
from app.modules.messages.events import MESSAGE_CREATED
from app.modules.messages.models import Message
from app.modules.messages.schemas import MAX_BODY_LENGTH, MessageCreate
from app.modules.reads import service as reads
from app.modules.users import service as users
from app.modules.users.events import USER_UPDATED, emit_user_event
from app.modules.users.models import User

log = logging.getLogger("app.ai")

MAX_ATTEMPTS = 3
# Seconds before the 2nd and the 3rd attempt after a temporary failure.
BACKOFF = (30, 120)
# A run's lease: longer than the SDK's worst case (120 s, 3 tries); a crash frees it after this.
LEASE = timedelta(minutes=10)
MAX_CONCURRENT = 2
RECENT_RUNS = 20
# A bot's reply / notice: client_msg_id = uuid5(namespace, run id) or (…, "notice:" + message id).
_REPLY_NAMESPACE = uuid.UUID("0b6d1f2c-8e43-4a57-9c1e-2f7a5d3b9e61")

NOTICE_PREFIX = "応答できませんでした: "

# Posting a mention's reply again after a temporary failure (review v0.1.18 #11): seconds before
# the 2nd … 5th try, then the run fails.
REPLY_BACKOFF = (30, 120, 300, 900)
REPLY_MAX_ATTEMPTS = 5
# A mention whose handling failed in the relay (review v0.1.18 #10): seconds before each try.
INBOX_BACKOFF = (10, 60, 300, 900, 1800)
INBOX_MAX_ATTEMPTS = 5

# Why a run stops before anything is sent (review v0.1.18 #2, #3).
AGENT_GONE = "このボットは無効になっています"
SUMMARY_AGENT_GONE = "要約に使うボットが無効になりました"
BOT_REMOVED = "ボットがこの会話から外されました"
CHANNEL_ARCHIVED = "この会話はアーカイブされています"
PRIVATE_REVOKED = "このボットは非公開の会話を扱えなくなりました"
AGENT_DELETED = "このボットは削除されました"
MENTION_LOST = "一時的なエラーで依頼を受け付けられませんでした"
# A reply the server refuses to post for good (review v0.1.18 #11), by error code.
_POST_REFUSALS = {
    "channel_archived": "会話がアーカイブされたため、返事を投稿できませんでした",
    "not_a_member": "ボットが会話から外されたため、返事を投稿できませんでした",
    "message_not_found": "スレッドが削除されたため、返事を投稿できませんでした",
    "channel_not_found": "会話が削除されたため、返事を投稿できませんでした",
}
BOT_INACTIVE = "ボットが無効のため、返事を投稿できませんでした"


def _month_bounds(now: datetime) -> tuple[datetime, datetime]:
    start = datetime(now.year, now.month, 1, tzinfo=UTC)
    end = datetime(now.year + (now.month == 12), now.month % 12 + 1, 1, tzinfo=UTC)
    return start, end


def _channel_label(channel: Channel) -> str:
    if channel.is_dm:
        return "ダイレクトメッセージ"
    kind = "非公開チャンネル" if channel.type == "private" else "チャンネル"
    return f"{kind} #{channel.name}"


async def _username(db: AsyncSession, user_id: uuid.UUID) -> str:
    user = await users.get_user(db, user_id)
    return user.username if user is not None else ""


async def _emit_run(db: AsyncSession, run: AiRun) -> None:
    """ai.run_updated to the requester's devices (summaries only)."""
    if run.kind != "summary":
        return
    await write_outbox(
        db,
        event_type=AI_RUN_UPDATED,
        audience_type="user",
        audience_id=run.requester_id,
        channel_id=run.channel_id,
        payload=AiRunUpdatedData(run=to_run_out(run)).model_dump(mode="json"),
    )


# --- limits -------------------------------------------------------------------------------------


async def month_committed(db: AsyncSession, moment: datetime) -> Decimal:
    """docs/AI.md §3: the month (UTC) of `moment`: the cost recorded by the runs created in it,
    plus what its open runs hold in reserve. A run counts in the month it was created, whenever
    it is carried out."""
    start, end = _month_bounds(moment)
    return await repo.committed_between(db, start, end)


def _budget(runtime: AiRuntime) -> Decimal:
    return Decimal(str(runtime.monthly_budget_usd))


def estimate_run(kind: str, model: str, input_text: str | None, system: str) -> Decimal:
    """The reservation of a new run (docs/AI.md §3): the most one attempt is expected to cost
    (pricing.estimate_usd: the input and system prompt at two tokens a character, the whole
    output allowance, OpenAI's reasoning room included), times the attempts it may make."""
    if input_text is None:
        return Decimal(0)
    max_output = prompts.REPLY_MAX_TOKENS if kind == "mention" else prompts.SUMMARY_MAX_TOKENS
    if provider_of(model) == OPENAI:
        max_output += OPENAI_REASONING_ROOM
    per_attempt = estimate_usd(
        model, input_chars=len(input_text) + len(system), max_output_tokens=max_output
    )
    return per_attempt * MAX_ATTEMPTS


async def _admit(
    db: AsyncSession,
    runtime: AiRuntime,
    requester_id: uuid.UUID,
    now: datetime,
    reserve: Decimal,
) -> str | None:
    """`ai_budget_exceeded` or `ai_daily_limit` when a new run may not start (docs/AI.md §3).
    Takes the locks that keep the check and the caller's insert together (until the caller's
    transaction ends): the month's budget with `reserve` added must stay within it, and the
    requester's runs of the last 24 hours below the daily count."""
    await repo.lock_new_runs(db, requester_id)
    if await month_committed(db, now) + reserve > _budget(runtime):
        return "ai_budget_exceeded"
    if await repo.runs_since(db, requester_id, now - timedelta(days=1)) >= (
        runtime.user_daily_runs
    ):
        return "ai_daily_limit"
    return None


_LIMIT_NOTICES = {
    "ai_budget_exceeded": "今月の AI の利用上限に達しました",
    "ai_daily_limit": "今日の AI の利用回数の上限に達しました",
    "ai_unavailable": "AI の API キーが設定されていません",
}


# --- admin: agents ------------------------------------------------------------------------------


async def list_agents(db: AsyncSession) -> list[AiAgentOut]:
    agents = await repo.list_agents(db)
    bots = await users.get_users(db, [a.bot_user_id for a in agents])
    return [
        to_agent_out(a, bots[a.bot_user_id].username if a.bot_user_id in bots else "")
        for a in agents
    ]


async def create_agent(db: AsyncSession, actor: User, data: AiAgentCreate) -> AiAgentOut:
    try:
        bot = await admin.create_bot_in_tx(
            db, actor_id=actor.id, username=data.username, display_name=data.name
        )
        agent = AiAgent(
            bot_user_id=bot.id,
            name=data.name,
            character=data.character,
            model=data.model,
            effort=data.effort,
            allow_private=data.allow_private,
            enabled=data.enabled,
            created_by=actor.id,
        )
        db.add(agent)
        await db.flush()
        await audit.record_in_tx(
            db,
            actor_id=actor.id,
            action="ai.agent_created",
            target_type="ai_agent",
            target_id=agent.id,
            details={"name": agent.name, "model": agent.model, "bot_user_id": str(bot.id)},
        )
        username = bot.username
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise conflict("username_taken", "Username is already in use") from exc
    return to_agent_out(agent, username)


async def _require_agent(db: AsyncSession, agent_id: uuid.UUID) -> AiAgent:
    agent = await repo.get_agent(db, agent_id, for_update=True)
    if agent is None:
        raise not_found("ai_agent_not_found", "AI agent not found")
    return agent


async def update_agent(
    db: AsyncSession, actor: User, agent_id: uuid.UUID, data: AiAgentUpdate
) -> AiAgentOut:
    agent = await _require_agent(db, agent_id)
    now = utcnow()
    if data.name is not None and data.name != agent.name:
        agent.name = data.name
        bot = await users.require_user(db, agent.bot_user_id)
        bot.display_name = data.name
        bot.updated_at = now
        await db.flush()
        await emit_user_event(db, USER_UPDATED, bot)
    was_private, was_enabled = agent.allow_private, agent.enabled
    for field in ("character", "model", "effort", "allow_private", "enabled"):
        value = getattr(data, field)
        if value is not None:
            setattr(agent, field, value)
    agent.updated_at = now
    await db.flush()
    # Review v0.1.18 #3: what the bot may no longer do is not sent from the queue either.
    if was_enabled and not agent.enabled:
        await _cancel_open_runs(db, agent.id, AGENT_GONE, now=now)
    elif was_private and not agent.allow_private:
        await _cancel_open_runs(db, agent.id, PRIVATE_REVOKED, now=now, private_only=True)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="ai.agent_updated",
        target_type="ai_agent",
        target_id=agent.id,
        details={"fields": sorted(data.model_fields_set)},
    )
    username = await _username(db, agent.bot_user_id)
    await db.commit()
    return to_agent_out(agent, username)


async def delete_agent(db: AsyncSession, actor: User, agent_id: uuid.UUID) -> None:
    """The bot leaves every conversation and is deactivated; its posts stay under its name."""
    agent = await _require_agent(db, agent_id)
    now = utcnow()
    agent.deleted_at = now
    agent.enabled = False
    agent.updated_at = now
    await _cancel_open_runs(db, agent.id, AGENT_DELETED, now=now)
    for channel_id in await channels.member_channel_ids(db, agent.bot_user_id):
        channel = await channels.require_channel(db, channel_id)
        await channels.remove_member_in_tx(db, channel, agent.bot_user_id)
    await admin.deactivate_bot_in_tx(db, agent.bot_user_id)
    await audit.record_in_tx(
        db,
        actor_id=actor.id,
        action="ai.agent_deleted",
        target_type="ai_agent",
        target_id=agent.id,
        details={"name": agent.name},
    )
    await db.commit()


async def usage(db: AsyncSession, runtime: AiRuntime, month: str | None) -> AiUsageOut:
    if month is None:
        now = utcnow()
        start, end = _month_bounds(now)
    else:
        try:
            parsed = datetime.strptime(month, "%Y-%m").replace(tzinfo=UTC)
        except ValueError as exc:
            raise bad_request("validation_error", "month must be YYYY-MM") from exc
        start, end = _month_bounds(parsed)
    by_agent = await repo.usage_by_agent(db, start, end)
    by_user = await repo.usage_by_user(db, start, end)
    return AiUsageOut(
        month=start.strftime("%Y-%m"),
        budget_usd=runtime.monthly_budget_usd,
        total_cost_usd=float(await repo.cost_between(db, start, end)),
        total_runs=await repo.count_between(db, start, end),
        by_agent=[
            AiUsageByAgent(
                agent_id=agent_id,
                name=name,
                runs=runs,
                input_tokens=inp,
                output_tokens=out,
                cost_usd=float(cost),
            )
            for agent_id, name, runs, inp, out, cost in by_agent
        ],
        by_user=[
            AiUsageByUser(user_id=user_id, runs=runs, cost_usd=float(cost))
            for user_id, runs, cost in by_user
        ],
    )


def providers(runtime: AiRuntime) -> list[AiProviderOut]:
    """docs/AI.md §12: which providers have a key (admin only; the key itself never leaves)."""
    return [
        AiProviderOut(
            name=name,  # type: ignore[arg-type]
            configured=runtime.configured(name),
            models=[m for m, p in MODEL_PROVIDERS.items() if p == name],  # type: ignore[misc]
        )
        for name in PROVIDERS
    ]


# --- bots in conversations ----------------------------------------------------------------------


async def check_private_allowed(
    db: AsyncSession, channel_type: str, user_ids: list[uuid.UUID]
) -> None:
    """Called by the channels router (injected through app.state, channels does not depend on
    ai) before a member joins a private channel or a DM is made: an AI bot without
    allow_private stays out (400 ai_private_not_allowed)."""
    if channel_type == "public" or not user_ids:
        return
    for agent in await repo.agents_for_bots(db, user_ids):
        if not agent.allow_private:
            raise bad_request(
                "ai_private_not_allowed",
                "This AI bot may only join public channels",
                details={"user_id": str(agent.bot_user_id)},
            )


# --- status, summaries and runs -----------------------------------------------------------------


async def _usable_agents(db: AsyncSession, runtime: AiRuntime) -> list[AiAgent]:
    """Enabled bots whose provider has a key, oldest first (the first is the default bot)."""
    return [a for a in await repo.list_agents(db, enabled_only=True) if runtime.serves(a.model)]


async def _summary_agent(
    db: AsyncSession, runtime: AiRuntime, channel: Channel
) -> tuple[AiAgent | None, str | None]:
    """docs/AI.md §2.3 (review v0.1.18 #2): the bot a summary of `channel` uses, and why it may
    not be asked (`ai_unavailable`, `ai_private_not_allowed`). The first usable bot (enabled, its
    provider has a key; oldest first) that is a member of the conversation, else the default bot
    (the first usable one). A private channel, DM or group DM only with a bot that has
    allow_private."""
    usable = await _usable_agents(db, runtime)
    if not usable:
        return None, "ai_unavailable"
    agent = usable[0]
    for candidate in usable:
        if await channels.membership_of(db, candidate.bot_user_id, channel.id) is not None:
            agent = candidate
            break
    if channel.type != "public" and not agent.allow_private:
        return agent, "ai_private_not_allowed"
    return agent, None


async def _readable_channel(db: AsyncSession, actor: User, channel_id: uuid.UUID) -> Channel:
    try:
        channel, _ = await channels.require_member(db, actor.id, channel_id)
    except AppError as exc:  # a conversation one cannot read does not exist for them
        raise not_found("channel_not_found", "Channel not found") from exc
    return channel


async def summary_target(
    db: AsyncSession, runtime: AiRuntime, actor: User, channel_id: uuid.UUID
) -> AiSummaryTargetOut:
    """GET /ai/summaries/target: where a summary of this conversation would go, before asking."""
    channel = await _readable_channel(db, actor, channel_id)
    agent, problem = await _summary_agent(db, runtime, channel)
    if problem is None and await month_committed(db, utcnow()) >= _budget(runtime):
        problem = "ai_budget_exceeded"
    return AiSummaryTargetOut(
        available=problem is None,
        provider=provider_of(agent.model) if agent else None,  # type: ignore[arg-type]
        model=agent.model if agent else None,
        agent_name=agent.name if agent else None,
        reason=problem,
    )


async def status(db: AsyncSession, runtime: AiRuntime) -> AiStatusOut:
    agents = await repo.list_agents(db, enabled_only=True)
    available = any(runtime.serves(a.model) for a in agents)
    budget_left = await month_committed(db, utcnow()) < _budget(runtime)
    return AiStatusOut(
        available=available,
        summary_available=available and budget_left,
        agents=[to_agent_public(a) for a in agents],
    )


async def _summary_input(
    db: AsyncSession, actor: User, channel: Channel, data: AiSummaryCreate, now: datetime
) -> tuple[str | None, int, uuid.UUID | None, int | None]:
    """(prompt or None when there is nothing to summarise, omitted_count, thread_id, days)."""
    visible = await channels.visible_user_ids(db, actor)
    tz = data.tz_offset_minutes if data.tz_offset_minutes is not None else prompts.DEFAULT_TZ_OFFSET
    thread_id: uuid.UUID | None = None
    days: int | None = None
    if data.scope == "thread":
        if data.thread_id is None:
            raise bad_request("validation_error", "thread_id is required for scope=thread")
        parent = await messages.find_message(db, data.thread_id)
        if parent is None or parent.channel_id != channel.id or parent.parent_id is not None:
            raise bad_request("validation_error", "thread_id must be a thread's parent message")
        thread_id = parent.id
        rows: list[Message] = await repo.thread_upto(db, parent.id, None)
        total = len(rows)
        what = "スレッド"
    else:
        if data.scope == "unread":
            last_read = (await reads.last_read_seqs(db, [actor.id], channel.id)).get(actor.id)
            if last_read is not None:
                rows, total = await repo.channel_range(
                    db, channel.id, after_seq=last_read, since=None, limit=prompts.SUMMARY_FETCH
                )
            else:
                rows, total = await repo.channel_range(
                    db,
                    channel.id,
                    after_seq=None,
                    since=now - timedelta(days=1),
                    limit=prompts.SUMMARY_FETCH,
                )
            what = "未読のメッセージ"
        else:
            days = data.days or 1
            rows, total = await repo.channel_range(
                db,
                channel.id,
                after_seq=None,
                since=now - timedelta(days=days),
                limit=prompts.SUMMARY_FETCH,
            )
            what = f"直近 {days} 日のメッセージ"
    if not rows:
        return None, 0, thread_id, days
    lines = await prompts.render_lines(
        db, rows, tz_offset_minutes=tz, visible=visible, mark_replies=data.scope != "thread"
    )
    kept, dropped = prompts.keep_newest(lines, prompts.SUMMARY_CHARS)
    omitted = dropped + (total - len(rows))
    return (
        prompts.summary_prompt(_channel_label(channel), what, kept, omitted),
        omitted,
        thread_id,
        days,
    )


async def create_summary(
    db: AsyncSession,
    runtime: AiRuntime,
    actor: User,
    data: AiSummaryCreate,
) -> AiRunOut:
    channel = await _readable_channel(db, actor, data.channel_id)
    now = utcnow()
    agent, problem = await _summary_agent(db, runtime, channel)
    if problem == "ai_private_not_allowed":
        raise conflict(
            "ai_private_not_allowed",
            "The AI bot for this conversation may not read private conversations",
        )
    if agent is None or problem is not None:
        raise conflict("ai_unavailable", "AI is not available on this server")
    text, omitted, thread_id, days = await _summary_input(db, actor, channel, data, now)
    # The target is fixed now (review v0.1.18 #2) and its estimated cost reserved (#4).
    reserve = estimate_run("summary", agent.model, text, prompts.summary_system())
    problem = await _admit(db, runtime, actor.id, now, reserve)
    if problem is not None:
        raise AppError(429, problem, _LIMIT_NOTICES[problem])
    run = AiRun(
        kind="summary",
        agent_id=agent.id,
        model=agent.model,
        provider=provider_of(agent.model),
        reserved_usd=reserve,
        requester_id=actor.id,
        channel_id=channel.id,
        thread_id=thread_id,
        scope=data.scope,
        days=days,
        input=text,
        omitted_count=omitted,
        created_at=now,
    )
    if text is None:  # nothing to read: done at once, no call
        run.status = "done"
        run.output = "要約するメッセージはありません。"
        run.finished_at = now
    db.add(run)
    await db.flush()
    await db.commit()
    return to_run_out(run)


async def get_run(db: AsyncSession, actor: User, run_id: uuid.UUID) -> AiRunOut:
    run = await repo.get_run(db, run_id)
    if run is None or run.requester_id != actor.id:
        raise not_found("ai_run_not_found", "AI run not found")
    return to_run_out(run)


async def list_runs(db: AsyncSession, actor: User, kind: str | None) -> list[AiRunOut]:
    return [to_run_out(r) for r in await repo.recent_runs(db, actor.id, kind, RECENT_RUNS)]


# --- mentions -----------------------------------------------------------------------------------


async def _post_as_bot(
    db: AsyncSession,
    bot_user_id: uuid.UUID,
    channel_id: uuid.UUID,
    parent_id: uuid.UUID,
    body: str,
    client_msg_id: uuid.UUID,
) -> str | None:
    """A reply by the bot in a thread, inside the caller's transaction (a savepoint). None when
    it is posted (or already was: the client_msg_id is fixed); the reason when the server refuses
    it for good (the bot was removed or deactivated, the channel archived, the thread deleted).
    Any other failure (a temporary one) propagates: the caller tries again later."""
    bot = await users.get_user(db, bot_user_id)
    if bot is None or not bot.is_active:
        return BOT_INACTIVE
    if len(body) > MAX_BODY_LENGTH:
        body = body[: MAX_BODY_LENGTH - 1] + "…"
    try:
        async with db.begin_nested():
            await messages.create_message(
                db,
                bot,
                channel_id,
                MessageCreate(client_msg_id=client_msg_id, body=body, parent_id=parent_id),
                advance_read=False,
                commit=False,
            )
    except AppError as exc:
        log.warning("AI bot %s may not post in channel %s: %s", bot_user_id, channel_id, exc.code)
        return _POST_REFUSALS.get(exc.code, f"返事を投稿できませんでした ({exc.code})")
    return None


async def _mention_input(db: AsyncSession, message: Message, sender: User, channel: Channel) -> str:
    visible = await channels.visible_user_ids(db, sender)
    if message.parent_id is not None:
        rows = await repo.thread_upto(db, message.parent_id, message.seq)
        in_thread = True
    else:
        rows = [
            *await repo.timeline_before(db, channel.id, message.seq, prompts.MENTION_TIMELINE),
            message,
        ]
        in_thread = False
    lines = await prompts.render_lines(
        db, rows, tz_offset_minutes=prompts.DEFAULT_TZ_OFFSET, visible=visible
    )
    kept, _ = prompts.keep_newest(lines, prompts.MENTION_CHARS)
    return prompts.mention_prompt(_channel_label(channel), kept, sender.display_name, in_thread)


async def _answering_agent(
    db: AsyncSession, message: Message
) -> tuple[AiAgent, User, Channel] | None:
    """docs/AI.md §2.2: the bot that answers a message (the first mentioned one that is enabled,
    a member of the channel, and allowed there), with the sender and the channel; None when no
    bot answers it."""
    if message.type != "user" or not message.mentioned_user_ids:
        return None
    agents = {
        a.bot_user_id: a
        for a in await repo.agents_for_bots(db, list(message.mentioned_user_ids))
        if a.enabled
    }
    if not agents:
        return None
    sender = await users.get_user(db, message.sender_id)
    if sender is None or sender.role == "bot" or not sender.is_active:
        return None  # bots never talk to each other (nor to themselves)
    channel = await channels.find_channel(db, message.channel_id)
    if channel is None or channel.is_archived:
        return None
    for user_id in message.mentioned_user_ids:  # the first mentioned bot that may answer
        candidate = agents.get(user_id)
        if candidate is None or candidate.bot_user_id == sender.id:
            continue
        if channel.type != "public" and not candidate.allow_private:
            continue
        if await channels.membership_of(db, candidate.bot_user_id, channel.id) is None:
            continue
        return candidate, sender, channel
    return None


async def handle_mention(
    db: AsyncSession, runtime: AiRuntime, message_id: uuid.UUID
) -> uuid.UUID | None:
    """docs/AI.md §2.2: a run for a human's mention of an enabled AI bot that is a member of the
    channel (a private channel or DM only with allow_private). Idempotent: one run per message;
    a notice instead of a run when the AI is unavailable or a limit is reached. Raises on a
    temporary failure (the caller keeps the mention for another try)."""
    message = await messages.find_message(db, message_id)
    if message is None:
        return None
    found = await _answering_agent(db, message)
    if found is None:
        return None
    agent, sender, channel = found
    if await repo.has_run_for(db, "mention", message.id):  # the event came again
        return None
    thread_root = message.parent_id or message.id
    now = utcnow()
    problem: str | None = None
    text: str | None = None
    reserve = Decimal(0)
    if not runtime.serves(agent.model):
        problem = "ai_unavailable"
    else:
        text = await _mention_input(db, message, sender, channel)
        system = prompts.mention_system(agent.name, agent.character)
        reserve = estimate_run("mention", agent.model, text, system)
        problem = await _admit(db, runtime, sender.id, now, reserve)
    if problem is not None:
        await _post_as_bot(
            db,
            agent.bot_user_id,
            channel.id,
            thread_root,
            NOTICE_PREFIX + _LIMIT_NOTICES[problem],
            uuid.uuid5(_REPLY_NAMESPACE, f"notice:{message.id}"),
        )
        return None
    return await repo.insert_run_once(
        db,
        {
            "id": uuid7(),
            "kind": "mention",
            "status": "pending",
            "agent_id": agent.id,
            # The target is fixed now (review v0.1.18 #2); its estimated cost is reserved (#4).
            "model": agent.model,
            "provider": provider_of(agent.model),
            "reserved_usd": reserve,
            "requester_id": sender.id,
            "channel_id": channel.id,
            "thread_id": thread_root,
            "source_message_id": message.id,
            "input": text,
            "created_at": now,
        },
    )


async def _give_up_mention(db: AsyncSession, message_id: uuid.UUID) -> None:
    """The last try of a mention failed: tell the thread (best effort, the same client_msg_id as
    the limit notices, so at most one notice per message)."""
    try:
        async with db.begin_nested():
            message = await messages.find_message(db, message_id)
            found = await _answering_agent(db, message) if message is not None else None
            if message is None or found is None:
                return
            agent, _, channel = found
            await _post_as_bot(
                db,
                agent.bot_user_id,
                channel.id,
                message.parent_id or message.id,
                NOTICE_PREFIX + MENTION_LOST,
                uuid.uuid5(_REPLY_NAMESPACE, f"notice:{message.id}"),
            )
    except Exception:
        log.exception("AI: could not tell the thread of message %s", message_id)


async def retry_mentions(database: Database, runtime: AiRuntime, now: datetime) -> int:
    """Mentions kept in `ai_mention_inbox` after a failure in the relay (review v0.1.18 #10):
    handled again (a run, or a notice); on failure again later, and after INBOX_MAX_ATTEMPTS
    tries the thread is told. Returns how many were tried."""
    async with database.session_factory() as db:
        due = await repo.due_inbox(db, now, 10)
        for message_id, attempts in due:
            try:
                async with db.begin_nested():
                    await handle_mention(db, runtime, message_id)
            except Exception as exc:
                tried = attempts + 1
                log.warning("AI mention %s failed again (try %d): %r", message_id, tried, exc)
                if tried >= INBOX_MAX_ATTEMPTS:
                    await _give_up_mention(db, message_id)
                    await repo.remove_from_inbox(db, message_id)
                else:
                    pause = INBOX_BACKOFF[min(tried, len(INBOX_BACKOFF) - 1)]
                    await repo.postpone_inbox(
                        db, message_id, tried, repr(exc)[:500], now + timedelta(seconds=pause)
                    )
                continue
            await repo.remove_from_inbox(db, message_id)
        await db.commit()
    return len(due)


async def _bot_left(db: AsyncSession, user_id: uuid.UUID, channel_id: uuid.UUID) -> None:
    """Review v0.1.18 #3: a bot taken out of a conversation drops the mentions it has not sent."""
    agents = await repo.agents_for_bots(db, [user_id])
    if not agents or await channels.membership_of(db, user_id, channel_id) is not None:
        return  # a person, or back in the channel since
    for agent in agents:
        await _cancel_open_runs(
            db, agent.id, BOT_REMOVED, now=utcnow(), channel_id=channel_id, kind="mention"
        )


class AiMentionHandler:
    """OutboxHandler on message.created (docs/AI.md §2.2). Idempotent (one run per message, the
    notice has a fixed client_msg_id). Also on channel.member_removed: a bot's pending mentions
    there are cancelled (review v0.1.18 #3)."""

    def __init__(self, runtime: AiRuntime) -> None:
        self.runtime = runtime

    async def handle(self, db: AsyncSession, event: OutboxEvent, audience: Audience) -> None:
        if event.event_type == CHANNEL_MEMBER_REMOVED:
            if event.audience_type == "user" and event.channel_id is not None:
                await _bot_left(db, uuid.UUID(str(event.payload["user_id"])), event.channel_id)
            return
        if event.event_type != MESSAGE_CREATED:
            return
        raw = (event.payload.get("message") or {}).get("mentioned_user_ids") or []
        if not raw:  # most messages: no lookup at all
            return
        message_id = uuid.UUID(str(event.payload["message"]["id"]))
        try:
            # A savepoint of its own: a failure here must not hold back the event's pushes.
            async with db.begin_nested():
                await handle_mention(db, self.runtime, message_id)
        except Exception as exc:
            # Review v0.1.18 #10: not dropped. Kept for the AI worker in the relay's transaction,
            # so it exists exactly when the event is marked processed (if even this insert fails,
            # the handler raises and the relay tries the whole event again; its pushes were
            # rolled back with it, so nothing is sent twice).
            log.exception(
                "AI mention handling failed for message %s; tried again later", message_id
            )
            async with db.begin_nested():
                await repo.add_to_inbox(
                    db, message_id, repr(exc)[:500], utcnow() + timedelta(seconds=INBOX_BACKOFF[0])
                )


# --- the worker ---------------------------------------------------------------------------------


async def _cancel_open_runs(
    db: AsyncSession,
    agent_id: uuid.UUID,
    reason: str,
    *,
    now: datetime,
    channel_id: uuid.UUID | None = None,
    kind: str | None = None,
    private_only: bool = False,
) -> int:
    """Review v0.1.18 #3: a bot's pending and running runs end as failed with `reason`, before
    anything (more) is sent. A running one's result, when it comes, is then stale (not used).
    A mention's notice is posted by the worker (when the bot still can)."""
    cancelled = 0
    for run in await repo.open_runs(db, agent_id, channel_id=channel_id, kind=kind):
        if private_only:
            channel = await channels.find_channel(db, run.channel_id)
            if channel is not None and channel.type == "public":
                continue
        await _finish(db, run, output=None, error=reason, now=now, post_now=False)
        cancelled += 1
    if cancelled:
        log.info("AI: cancelled %d run(s) of agent %s: %s", cancelled, agent_id, reason)
    return cancelled


async def _finish(
    db: AsyncSession,
    run: AiRun,
    *,
    output: str | None,
    error: str | None,
    now: datetime,
    post_now: bool = True,
) -> None:
    """The run's outcome (the reservation settles: cost_usd is what it cost). A summary tells
    its requester; a mention's reply or notice is posted (now, or by the worker later)."""
    run.status = "failed" if error is not None else "done"
    run.output = output
    run.error = error
    run.finished_at = now
    run.locked_until = None
    run.next_attempt_at = None
    run.reserved_usd = Decimal(0)
    await db.flush()
    if run.kind == "summary":
        await _emit_run(db, run)
        return
    run.reply_state = "pending"
    run.reply_attempts = 0
    run.reply_next_at = None
    await db.flush()
    if post_now:
        await _post_reply(db, run, now)


async def _post_reply(db: AsyncSession, run: AiRun, now: datetime) -> None:
    """Review v0.1.18 #11: post a finished mention run's reply (its output, or the notice of its
    error) from what is stored, without calling the model again. Posted → `posted`; refused for
    good → `failed` (a done run becomes failed with the reason); a temporary failure → tried
    again after REPLY_BACKOFF, up to REPLY_MAX_ATTEMPTS."""
    run_id, attempts = run.id, run.reply_attempts + 1
    agent = await repo.get_agent_any(db, run.agent_id) if run.agent_id else None
    refused: str | None
    if agent is None or run.thread_id is None:
        refused = BOT_INACTIVE
    else:
        if run.status == "done" and run.output:
            body = run.output
        else:
            body = NOTICE_PREFIX + (run.error or "空の応答")
        run.reply_attempts = attempts
        await db.flush()
        try:
            refused = await _post_as_bot(
                db,
                agent.bot_user_id,
                run.channel_id,
                run.thread_id,
                body,
                uuid.uuid5(_REPLY_NAMESPACE, str(run_id)),
            )
        except Exception:
            log.exception("AI run %s: posting the reply failed (try %d)", run_id, attempts)
            await db.refresh(run)
            if attempts < REPLY_MAX_ATTEMPTS:
                run.reply_next_at = now + timedelta(seconds=REPLY_BACKOFF[attempts - 1])
                await db.flush()
                return
            refused = "返事を投稿できませんでした"
    run.reply_next_at = None
    if refused is None:
        run.reply_state = "posted"
    else:
        run.reply_state = "failed"
        if run.status == "done":
            run.status = "failed"
            run.error = refused
        log.warning("AI run %s: the reply was not posted: %s", run_id, refused)
    await db.flush()


async def post_due_replies(database: Database, now: datetime) -> int:
    """The replies whose posting failed for a while (review v0.1.18 #11), and the notices of
    cancelled runs. Returns how many were tried."""
    async with database.session_factory() as db:
        due = await repo.due_replies(db, now, 20)
        for run in due:
            await _post_reply(db, run, now)
        await db.commit()
    return len(due)


def _record_usage(run: AiRun, result: LlmResult) -> None:
    """Adds an attempt's tokens and cost to the run (every attempt that reported usage, failed
    ones and stale ones included: review v0.1.18 #7, #9). The reservation shrinks by what was
    spent, so recorded + reserved stays what was admitted."""
    model = price_model(result.model, run.model or "")
    run.input_tokens += result.input_tokens
    run.output_tokens += result.output_tokens
    run.cache_read_tokens += result.cache_read_tokens
    run.cache_write_tokens += result.cache_write_tokens
    spent = cost_usd(
        model,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        cache_read_tokens=result.cache_read_tokens,
        cache_write_tokens=result.cache_write_tokens,
    )
    run.cost_usd = Decimal(run.cost_usd or 0) + spent
    run.reserved_usd = max(Decimal(run.reserved_usd or 0) - spent, Decimal(0))


async def _mention_problem(db: AsyncSession, agent: AiAgent | None, run: AiRun) -> str | None:
    """Review v0.1.18 #3: right before a mention is sent, the bot must still be enabled, a
    member of the conversation, and (in a private channel or DM) allowed there."""
    if agent is None or agent.deleted_at is not None or not agent.enabled:
        return AGENT_GONE
    bot = await users.get_user(db, agent.bot_user_id)
    if bot is None or not bot.is_active:
        return AGENT_GONE
    channel = await channels.find_channel(db, run.channel_id)
    if channel is None or channel.is_archived:
        return CHANNEL_ARCHIVED
    if await channels.membership_of(db, agent.bot_user_id, channel.id) is None:
        return BOT_REMOVED
    if channel.type != "public" and not agent.allow_private:
        return PRIVATE_REVOKED
    return None


async def _summary_problem(db: AsyncSession, agent: AiAgent | None, run: AiRun) -> str | None:
    """Review v0.1.18 #2: a summary goes to the bot fixed when it was asked for, or nowhere."""
    if agent is None or agent.deleted_at is not None or not agent.enabled:
        return SUMMARY_AGENT_GONE
    channel = await channels.find_channel(db, run.channel_id)
    if channel is not None and channel.type != "public" and not agent.allow_private:
        return PRIVATE_REVOKED
    return None


async def _prepare(
    database: Database, runtime: AiRuntime, run_id: uuid.UUID, generation: int
) -> tuple[LlmRequest | None, str | None]:
    """The request for a claimed run, or the reason it cannot be made (the run is then failed
    by the caller; nothing is sent). Reads only."""
    async with database.session_factory() as db:
        run = await repo.get_run(db, run_id)
        if run is None or run.status != "running" or run.attempts != generation:
            return None, None
        if run.attempts > MAX_ATTEMPTS:  # a run that kept crashing the process
            return None, "処理が完了しませんでした"
        if run.input is None:
            return None, "送る内容がありません"
        agent = await repo.get_agent_any(db, run.agent_id) if run.agent_id else None
        if run.kind == "summary":
            problem = await _summary_problem(db, agent, run)
        else:
            problem = await _mention_problem(db, agent, run)
        if problem is not None:
            return None, problem
        assert agent is not None
        # The stored target (runs from before 0062 without one: the bot's model).
        model = run.model or agent.model
        if not runtime.serves(model):  # its provider lost its key: no switch to another one
            return None, _LIMIT_NOTICES["ai_unavailable"]
        if await month_committed(db, run.created_at) > _budget(runtime):
            return None, _LIMIT_NOTICES["ai_budget_exceeded"]
        if run.kind == "summary":
            return (
                LlmRequest(
                    model=model,
                    effort="low",
                    system=prompts.summary_system(),
                    user=run.input,
                    max_tokens=prompts.SUMMARY_MAX_TOKENS,
                ),
                None,
            )
        return (
            LlmRequest(
                model=model,
                effort=agent.effort,
                system=prompts.mention_system(agent.name, agent.character),
                user=run.input,
                max_tokens=prompts.REPLY_MAX_TOKENS,
            ),
            None,
        )


async def _execute(
    database: Database, runtime: AiRuntime, run_id: uuid.UUID, generation: int
) -> None:
    """One claimed run: prepare, call the provider (outside any transaction), record. The record
    applies only while the run is still this claim's (`generation`, review v0.1.18 #9); a stale
    attempt's tokens are still added to the run, nothing else changes."""
    request, problem = await _prepare(database, runtime, run_id, generation)
    result: LlmResult | None = None
    failure: LlmError | None = None
    if request is not None:
        provider = runtime.get_provider(request.model)
        try:
            if provider is None:  # the key went away since _prepare
                raise LlmError(_LIMIT_NOTICES["ai_unavailable"], retryable=False)
            result = await provider.complete(request)
        except LlmError as exc:
            failure = exc
        except Exception as exc:  # an unexpected SDK error: try again later, then give up
            log.exception("AI run %s: the provider failed", run_id)
            failure = LlmError("予期しないエラー", retryable=True)
            failure.__cause__ = exc
    usage = result if result is not None else (failure.usage if failure is not None else None)
    async with database.session_factory() as db:
        run = await repo.get_run(db, run_id, for_update=True)
        if run is None:
            await db.commit()
            return
        if run.status != "running" or run.attempts != generation:
            if usage is not None and usage.has_tokens:
                _record_usage(run, usage)
                log.warning(
                    "AI run %s: a stale attempt (%d) finished; tokens kept", run_id, generation
                )
            await db.commit()
            return
        now = utcnow()
        if request is None:
            if problem is None:
                await db.commit()
                return
            await _finish(db, run, output=None, error=problem, now=now)
        elif failure is not None:
            if failure.usage is not None:
                _record_usage(run, failure.usage)
            if failure.retryable and run.attempts < MAX_ATTEMPTS:
                run.status = "pending"
                run.locked_until = None
                run.next_attempt_at = now + timedelta(
                    seconds=BACKOFF[min(run.attempts, len(BACKOFF)) - 1]
                )
                log.warning("AI run %s: %s (attempt %d)", run.id, failure.reason, run.attempts)
            else:
                log.warning("AI run %s failed: %s", run.id, failure.reason)
                await _finish(db, run, output=None, error=failure.reason, now=now)
        else:
            assert result is not None
            _record_usage(run, result)
            text = result.text.strip()
            if result.stop_reason == "refusal":
                refused = "安全のための判断で応答が止められました"
                await _finish(db, run, output=None, error=refused, now=now)
            elif not text:
                await _finish(db, run, output=None, error="空の応答が返りました", now=now)
            else:
                if result.stop_reason == "max_tokens":
                    text += "\n\n(長さの上限に達したため、ここまでです)"
                await _finish(db, run, output=text, error=None, now=now)
        await db.commit()


async def process_due(
    database: Database, runtime: AiRuntime, *, now: datetime | None = None
) -> int:
    """The worker: mentions to handle again and replies to post again first (no provider call),
    then claims up to MAX_CONCURRENT open runs and carries them out together. Returns how many
    runs it claimed (the loop goes again at once while there are some)."""
    moment = now or utcnow()
    await retry_mentions(database, runtime, moment)
    await post_due_replies(database, moment)
    async with database.session_factory() as db:
        claimed = await repo.claim(db, moment, moment + LEASE, MAX_CONCURRENT)
        for run_id, _ in claimed:
            run = await repo.get_run(db, run_id)
            if run is not None:
                await _emit_run(db, run)
        await db.commit()
    if claimed:
        results = await asyncio.gather(
            *(_execute(database, runtime, run_id, generation) for run_id, generation in claimed),
            return_exceptions=True,
        )
        for (run_id, _), outcome in zip(claimed, results, strict=True):
            if isinstance(outcome, BaseException):
                log.error("AI run %s crashed", run_id, exc_info=outcome)
    return len(claimed)


async def purge_inputs(db: AsyncSession, *, days: int, now: datetime | None = None) -> int:
    """docs/AI.md §4: the prompt text goes after `days` days; tokens and cost stay."""
    purged = await repo.purge_inputs(db, (now or utcnow()) - timedelta(days=days))
    await db.commit()
    return purged
