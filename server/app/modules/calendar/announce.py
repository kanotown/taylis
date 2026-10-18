"""The 「予定」 bot's line in a channel when an event is added to its calendar (CALENDAR.md §11).

「📅 田中 一郎 さんが「研究ミーティング」を 10/20 (火) 13:00〜14:00 に追加しました」 and, on the
next line, the event's link `<server>/e/<id>` (the apps open the event from it). A recurring event
says its rule once: 「…を 毎週 月曜日 13:00〜14:00 に追加しました（10/20 (月) から）」.

Only `create` posts (never an edit or a delete, never a personal event, never a scheduling poll's
decision, which answers in its own thread, and never an event a bot adds). The post is an ordinary
message from one shared system bot (`system_bots` key "calendar", like the deadline bot): it joins
the channel the first time, posts through the message path in the event's own transaction (its
outbox rows carry the push and the sync), never mentions anyone, and its idempotency key comes from
the event's id. An administrator who deactivates the bot stops every announcement.

The texts are Japanese: a channel's line is shared, as the other bots' lines are.
"""

import logging
import uuid
from datetime import date, datetime
from zoneinfo import ZoneInfo

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.calendar import recurrence
from app.modules.calendar.models import CalendarEvent
from app.modules.channels.models import Channel
from app.modules.users.models import User

log = logging.getLogger(__name__)

BOT_KEY = "calendar"
BOT_NAME = "予定"
WEEKDAYS_JA = ("月", "火", "水", "木", "金", "土", "日")
# The post's client_msg_id: uuid5(this, "<event id>"), so the same event never posts twice.
_POST_NAMESPACE = uuid.UUID("6c1f0d3e-9b2a-4e57-8d14-2a7b5c9e0f63")
_FULL_LT, _FULL_STAR = chr(0xFF1C), chr(0xFF0A)


# --- the words (pure) ----------------------------------------------------------------------------


def plain(text: str) -> str:
    """A title or a name as plain text: no `<…>` token (a mention) and no `*` emphasis comes out
    of it (the deadline bot's rule, Review v0.1.22 #8)."""
    return text.replace("<", _FULL_LT).replace("*", _FULL_STAR)


def day_label(day: date, this_year: int) -> str:
    """「10/20 (火)」, with the year when it is not this year (「2027/1/5 (火)」)."""
    head = f"{day.month}/{day.day}"
    if day.year != this_year:
        head = f"{day.year}/{head}"
    return f"{head} ({WEEKDAYS_JA[day.weekday()]})"


def clock(moment: datetime) -> str:
    return f"{moment.hour}:{moment.minute:02d}"


def when_label(event: CalendarEvent, tz: str, this_year: int) -> str:
    """A one-off event's time: 「10/20 (火)」, 「10/20 (火)〜10/22 (木)」,
    「10/20 (火) 13:00〜14:00」, and the end's day when it ends on another day
    (「10/20 (火) 23:00〜10/21 (水) 1:00」)."""
    if event.all_day:
        assert event.start_date is not None and event.end_date is not None
        first = day_label(event.start_date, this_year)
        if event.end_date == event.start_date:
            return first
        return f"{first}〜{day_label(event.end_date, this_year)}"
    assert event.starts_at is not None and event.ends_at is not None
    zone = ZoneInfo(tz)
    start, end = event.starts_at.astimezone(zone), event.ends_at.astimezone(zone)
    head = f"{day_label(start.date(), this_year)} {clock(start)}"
    if end.date() == start.date():
        return f"{head}〜{clock(end)}"
    return f"{head}〜{day_label(end.date(), this_year)} {clock(end)}"


def rule_label(rule: recurrence.Rule, first: date) -> str:
    """The rule in the apps' words (Desktop's describeRrule, without its end): 「毎日」「3 日ごと」
    「毎週 火・木曜日」「2 週間ごと 月曜日」「毎月 10 日」「毎月 月末」「毎月 第 2 火曜日」
    「毎月 最終 金曜日」「毎年 1月10日」."""
    n = rule.interval
    if rule.freq == "DAILY":
        return "毎日" if n == 1 else f"{n} 日ごと"
    if rule.freq == "WEEKLY":
        days = [wd for _, wd in rule.byday] or [first.weekday()]
        every = "毎週" if n == 1 else f"{n} 週間ごと"
        return f"{every} {'・'.join(WEEKDAYS_JA[d] for d in days)}曜日"
    if rule.freq == "MONTHLY":
        every = "毎月" if n == 1 else f"{n} か月ごと"
        if rule.byday:
            nth, weekday = rule.byday[0]
            name = f"{WEEKDAYS_JA[weekday]}曜日"
            which = f"最終 {name}" if nth is not None and nth < 0 else f"第 {nth} {name}"
        elif rule.bymonthday == -1:
            which = "月末"
        else:
            which = f"{rule.bymonthday or first.day} 日"
        return f"{every} {which}"
    every = "毎年" if n == 1 else f"{n} 年ごと"
    return f"{every} {first.month}月{first.day}日"


def series_label(event: CalendarEvent, tz: str, this_year: int) -> tuple[str, str]:
    """A recurring event: the rule with its times (「毎週 月曜日 13:00〜14:00」, all-day: the rule
    alone) and the note of when it runs (「10/20 (月) から」, 「… から 12/22 (月) まで」,
    「… から 10 回」)."""
    assert event.rrule is not None
    if event.all_day:
        assert event.start_date is not None
        first = event.start_date
        what = rule_label(recurrence.parse(event.rrule), first)
    else:
        assert event.starts_at is not None and event.ends_at is not None
        zone = ZoneInfo(tz)
        start, end = event.starts_at.astimezone(zone), event.ends_at.astimezone(zone)
        first = start.date()
        days = (end.date() - start.date()).days
        later = "" if days == 0 else ("翌" if days == 1 else f"{days} 日後 ")
        times = f"{clock(start)}〜{later}{clock(end)}"
        what = f"{rule_label(recurrence.parse(event.rrule), first)} {times}"
    rule = recurrence.parse(event.rrule)
    note = f"{day_label(first, this_year)} から"
    if rule.until is not None:
        note += f" {day_label(rule.until, this_year)} まで"
    elif rule.count is not None:
        note += f" {rule.count} 回"
    return what, note


def body(event: CalendarEvent, creator: str, tz: str, now: datetime, base_url: str) -> str:
    """The bot's post (the module's note); the link is left out without a server address."""
    this_year = now.astimezone(ZoneInfo(tz)).year
    title, name = plain(event.title), plain(creator)
    if event.rrule:
        what, note = series_label(event, tz, this_year)
        text = f"📅 {name} さんが「{title}」を {what} に追加しました（{note}）"
    else:
        text = f"📅 {name} さんが「{title}」を {when_label(event, tz, this_year)} に追加しました"
    if base_url:
        text += f"\n{base_url.rstrip('/')}/e/{event.id}"
    return text


# --- the post ------------------------------------------------------------------------------------


async def calendar_bot(db: AsyncSession, actor_id: uuid.UUID) -> User | None:
    """The 「予定」 bot, made the first time (`actor_id` is in its audit row). None when an
    administrator deactivated it: that stops every announcement."""
    from app.modules.admin import service as admin
    from app.modules.tasks.models import SystemBot
    from app.modules.users import service as users

    row = await db.get(SystemBot, BOT_KEY)
    if row is None:
        bot = await admin.create_bot_in_tx(
            db,
            actor_id=actor_id,
            username=f"calendar-bot-{uuid.uuid4().hex[:8]}",
            display_name=BOT_NAME,
        )
        await db.execute(
            pg_insert(SystemBot)
            .values(key=BOT_KEY, user_id=bot.id, created_at=utcnow())
            .on_conflict_do_nothing()
        )
        row = await db.get(SystemBot, BOT_KEY, populate_existing=True)
        if row is None:  # pragma: no cover - the insert above or a concurrent one wrote it
            return None
    user = await users.get_user(db, row.user_id)
    if user is None or not user.is_active:
        return None
    return user


async def post(
    db: AsyncSession,
    actor: User,
    event: CalendarEvent,
    channel: Channel,
    *,
    tz: str,
    base_url: str,
) -> uuid.UUID | None:
    """Posts the line in the caller's transaction (a savepoint: a failure is logged and the event
    is still made); the message's id, or None. The creator's read position follows the post when
    they had read everything before it (they need no unread mark or push for their own event)."""
    from app.modules.channels import service as channels
    from app.modules.messages import service as messages
    from app.modules.messages.schemas import MessageCreate
    from app.modules.reads import service as reads

    try:
        async with db.begin_nested():
            bot = await calendar_bot(db, actor.id)
            if bot is None:
                return None
            if await channels.membership_of(db, bot.id, channel.id) is None:
                await channels.add_member_in_tx(db, channel, bot.id)
            text = body(event, actor.display_name, tz, utcnow(), base_url)
            message, created = await messages.create_message(
                db,
                bot,
                channel.id,
                MessageCreate(client_msg_id=uuid.uuid5(_POST_NAMESPACE, str(event.id)), body=text),
                advance_read=False,
                commit=False,
                mentions=False,
            )
            if created:
                seq = message.seq
                read = (await reads.last_read_seqs(db, [actor.id], channel.id)).get(actor.id, 0)
                if read >= seq - 1:
                    await reads.advance_in_tx(db, actor.id, channel.id, seq, last_seq=seq)
            return message.id
    except Exception:
        log.exception("calendar event %s: the channel line failed", event.id)
        return None
