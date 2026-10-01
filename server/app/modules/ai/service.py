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
from app.modules.ai.llm import AiRuntime, LlmError, LlmRequest, LlmResult
from app.modules.ai.models import AiAgent, AiRun
from app.modules.ai.pricing import cost_usd, price_model
from app.modules.ai.schemas import (
    AiAgentCreate,
    AiAgentOut,
    AiAgentUpdate,
    AiRunOut,
    AiStatusOut,
    AiSummaryCreate,
    AiUsageByAgent,
    AiUsageByUser,
    AiUsageOut,
    to_agent_out,
    to_agent_public,
    to_run_out,
)
from app.modules.audit import service as audit
from app.modules.channels import service as channels
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


async def month_cost(db: AsyncSession, now: datetime) -> Decimal:
    start, end = _month_bounds(now)
    return await repo.cost_between(db, start, end)


async def _limit_problem(
    db: AsyncSession, runtime: AiRuntime, requester_id: uuid.UUID, now: datetime
) -> str | None:
    """`ai_budget_exceeded` or `ai_daily_limit` when a new run may not start (docs/AI.md §3)."""
    if await month_cost(db, now) >= Decimal(str(runtime.monthly_budget_usd)):
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
    for field in ("character", "model", "effort", "allow_private", "enabled"):
        value = getattr(data, field)
        if value is not None:
            setattr(agent, field, value)
    agent.updated_at = now
    await db.flush()
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


async def status(db: AsyncSession, runtime: AiRuntime) -> AiStatusOut:
    agents = await repo.list_agents(db, enabled_only=True)
    available = runtime.available and bool(agents)
    budget_left = await month_cost(db, utcnow()) < Decimal(str(runtime.monthly_budget_usd))
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
    try:
        channel, _ = await channels.require_member(db, actor.id, data.channel_id)
    except AppError as exc:  # a conversation one cannot read does not exist for them
        raise not_found("channel_not_found", "Channel not found") from exc
    now = utcnow()
    agents = await repo.list_agents(db, enabled_only=True)
    if not agents or not runtime.available:
        raise conflict("ai_unavailable", "AI is not available on this server")
    problem = await _limit_problem(db, runtime, actor.id, now)
    if problem is not None:
        raise AppError(429, problem, _LIMIT_NOTICES[problem])
    text, omitted, thread_id, days = await _summary_input(db, actor, channel, data, now)
    run = AiRun(
        kind="summary",
        agent_id=agents[0].id,
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
) -> bool:
    """A reply by the bot in a thread, inside the caller's transaction (a savepoint: a failure,
    e.g. the bot was removed or the channel archived meanwhile, is logged and leaves the rest)."""
    bot = await users.get_user(db, bot_user_id)
    if bot is None or not bot.is_active:
        return False
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
    except Exception:
        log.exception("AI bot %s could not post in channel %s", bot_user_id, channel_id)
        return False
    return True


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


async def handle_mention(
    db: AsyncSession, runtime: AiRuntime, message_id: uuid.UUID
) -> uuid.UUID | None:
    """docs/AI.md §2.2: a run for a human's mention of an enabled AI bot that is a member of the
    channel (a private channel or DM only with allow_private). Idempotent: one run per message;
    a notice instead of a run when the AI is unavailable or a limit is reached."""
    message = await messages.find_message(db, message_id)
    if message is None or message.type != "user" or not message.mentioned_user_ids:
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
    agent: AiAgent | None = None
    for user_id in message.mentioned_user_ids:  # the first mentioned bot that may answer
        candidate = agents.get(user_id)
        if candidate is None or candidate.bot_user_id == sender.id:
            continue
        if channel.type != "public" and not candidate.allow_private:
            continue
        if await channels.membership_of(db, candidate.bot_user_id, channel.id) is None:
            continue
        agent = candidate
        break
    if agent is None:
        return None
    if await repo.has_run_for(db, "mention", message.id):  # the event came again
        return None
    thread_root = message.parent_id or message.id
    now = utcnow()
    problem = None if runtime.available else "ai_unavailable"
    problem = problem or await _limit_problem(db, runtime, sender.id, now)
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
            "requester_id": sender.id,
            "channel_id": channel.id,
            "thread_id": thread_root,
            "source_message_id": message.id,
            "input": await _mention_input(db, message, sender, channel),
            "created_at": now,
        },
    )


class AiMentionHandler:
    """OutboxHandler on message.created (docs/AI.md §2.2). Idempotent (one run per message, the
    notice has a fixed client_msg_id)."""

    def __init__(self, runtime: AiRuntime) -> None:
        self.runtime = runtime

    async def handle(self, db: AsyncSession, event: OutboxEvent, audience: Audience) -> None:
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
        except Exception:
            log.exception("AI mention handling failed for message %s", message_id)


# --- the worker ---------------------------------------------------------------------------------


async def _finish(
    db: AsyncSession,
    run: AiRun,
    *,
    output: str | None,
    error: str | None,
    now: datetime,
) -> None:
    run.status = "failed" if error is not None else "done"
    run.output = output
    run.error = error
    run.finished_at = now
    run.locked_until = None
    run.next_attempt_at = None
    await db.flush()
    if run.kind == "summary":
        await _emit_run(db, run)
        return
    agent = await repo.get_agent_any(db, run.agent_id) if run.agent_id else None
    if agent is None or run.thread_id is None:
        return
    body = output if error is None and output else NOTICE_PREFIX + (error or "空の応答")
    await _post_as_bot(
        db,
        agent.bot_user_id,
        run.channel_id,
        run.thread_id,
        body,
        uuid.uuid5(_REPLY_NAMESPACE, str(run.id)),
    )


def _record_usage(run: AiRun, result: LlmResult) -> None:
    model = price_model(result.model, run.model or "")
    run.model = result.model or run.model
    run.input_tokens += result.input_tokens
    run.output_tokens += result.output_tokens
    run.cache_read_tokens += result.cache_read_tokens
    run.cache_write_tokens += result.cache_write_tokens
    run.cost_usd = Decimal(run.cost_usd or 0) + cost_usd(
        model,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        cache_read_tokens=result.cache_read_tokens,
        cache_write_tokens=result.cache_write_tokens,
    )


async def _prepare(
    database: Database, runtime: AiRuntime, run_id: uuid.UUID
) -> tuple[LlmRequest | None, str | None]:
    """The request for a claimed run, or the reason it cannot be made (the run is then failed
    by the caller). Reads only."""
    async with database.session_factory() as db:
        run = await repo.get_run(db, run_id)
        if run is None or run.status != "running":
            return None, None
        if run.attempts > MAX_ATTEMPTS:  # a run that kept crashing the process
            return None, "処理が完了しませんでした"
        if runtime.get_provider() is None:
            return None, _LIMIT_NOTICES["ai_unavailable"]
        if run.input is None:
            return None, "送る内容がありません"
        agent = await repo.get_agent_any(db, run.agent_id) if run.agent_id else None
        if run.kind == "summary":
            if agent is None or agent.deleted_at is not None or not agent.enabled:
                enabled = await repo.list_agents(db, enabled_only=True)
                agent = enabled[0] if enabled else None
            if agent is None:
                return None, "使える AI のボットがありません"
            return (
                LlmRequest(
                    model=agent.model,
                    effort="low",
                    system=prompts.summary_system(),
                    user=run.input,
                    max_tokens=prompts.SUMMARY_MAX_TOKENS,
                ),
                None,
            )
        if agent is None or agent.deleted_at is not None or not agent.enabled:
            return None, "このボットは無効になっています"
        return (
            LlmRequest(
                model=agent.model,
                effort=agent.effort,
                system=prompts.mention_system(agent.name, agent.character),
                user=run.input,
                max_tokens=prompts.REPLY_MAX_TOKENS,
            ),
            None,
        )


async def _execute(database: Database, runtime: AiRuntime, run_id: uuid.UUID) -> None:
    request, problem = await _prepare(database, runtime, run_id)
    result: LlmResult | None = None
    failure: LlmError | None = None
    if request is not None:
        provider = runtime.get_provider()
        assert provider is not None
        try:
            result = await provider.complete(request)
        except LlmError as exc:
            failure = exc
        except Exception as exc:  # an unexpected SDK error: try again later, then give up
            log.exception("AI run %s: the provider failed", run_id)
            failure = LlmError("予期しないエラー", retryable=True)
            failure.__cause__ = exc
    async with database.session_factory() as db:
        run = await repo.get_run(db, run_id, for_update=True)
        if run is None or run.status != "running":
            await db.commit()
            return
        now = utcnow()
        if request is None:
            if problem is None:
                await db.commit()
                return
            await _finish(db, run, output=None, error=problem, now=now)
        elif failure is not None:
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
            run.model = request.model
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
    """The worker: claims up to MAX_CONCURRENT open runs and carries them out together. Returns
    how many it claimed (the loop goes again at once while there are some)."""
    moment = now or utcnow()
    async with database.session_factory() as db:
        claimed = await repo.claim(db, moment, moment + LEASE, MAX_CONCURRENT)
        for run_id in claimed:
            run = await repo.get_run(db, run_id)
            if run is not None:
                await _emit_run(db, run)
        await db.commit()
    if claimed:
        results = await asyncio.gather(
            *(_execute(database, runtime, run_id) for run_id in claimed), return_exceptions=True
        )
        for run_id, outcome in zip(claimed, results, strict=True):
            if isinstance(outcome, BaseException):
                log.error("AI run %s crashed", run_id, exc_info=outcome)
    return len(claimed)


async def purge_inputs(db: AsyncSession, *, days: int, now: datetime | None = None) -> int:
    """docs/AI.md §4: the prompt text goes after `days` days; tokens and cost stay."""
    purged = await repo.purge_inputs(db, (now or utcnow()) - timedelta(days=days))
    await db.commit()
    return purged
