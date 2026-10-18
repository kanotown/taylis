"""The 「予定」 bot's line when an event is added to a channel's calendar (CALENDAR.md §11)."""

import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.admin import service as admin
from app.modules.calendar import announce
from app.modules.calendar.models import CalendarEvent
from app.modules.messages.models import Message
from app.modules.reads import service as reads
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_calendar import EVENTS, _channel, _create, all_day, timed

# 2030-01-10 is a Thursday; 14:00 in Tokyo is 05:00 UTC.
AT_14_JST = datetime(2030, 1, 10, 5, 0, tzinfo=UTC)
NOW = datetime(2030, 1, 1, 0, 0, tzinfo=UTC)
TOKYO = "Asia/Tokyo"


async def _lines(db: AsyncSession, channel_id: str) -> list[Message]:
    stmt = (
        select(Message)
        .where(Message.channel_id == uuid.UUID(channel_id), Message.system_event.is_(None))
        .order_by(Message.seq)
        .execution_options(populate_existing=True)
    )
    return list((await db.execute(stmt)).scalars().all())


async def _setup(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> tuple[User, User, dict[str, Any]]:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    lab = await _channel(client, "lab")
    as_user(bob)
    assert (await client.post(f"/api/v1/channels/{lab['id']}/join")).status_code == 200
    as_user(alice)
    return alice, bob, lab


async def test_a_channel_event_is_announced_once_by_the_bot(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice, bob, lab = await _setup(client, db, as_user)
    key = str(uuid.uuid4())
    body = timed("研究ミーティング", AT_14_JST, 60, channel_id=lab["id"], tz=TOKYO)
    made = await _create(client, body | {"client_event_id": key})
    [line] = await _lines(db, lab["id"])
    assert line.body.split("\n") == [
        "📅 Alice さんが「研究ミーティング」を 2030/1/10 (木) 14:00〜15:00 に追加しました",
        f"http://testserver/e/{made['id']}",
    ]
    bot = await db.get(User, line.sender_id)
    assert bot is not None and bot.role == "bot" and bot.display_name == "予定"
    # The creator has read their own line (no unread mark, no push); the others have not.
    assert await reads.is_read(db, alice.id, line.channel_id, line.seq)
    assert not await reads.is_read(db, bob.id, line.channel_id, line.seq)

    # A retry (same client_event_id) answers with the event and posts nothing more.
    again = await _create(client, body | {"client_event_id": key}, status=200)
    assert again["id"] == made["id"]
    # Changing or deleting it posts nothing.
    url = f"{EVENTS}/{made['id']}"
    assert (await client.patch(url, json={"title": "ミーティング"})).status_code == 200
    assert (await client.delete(url)).status_code == 204
    assert len(await _lines(db, lab["id"])) == 1

    # A second event reuses the same bot.
    await _create(client, all_day("学会", date(2030, 1, 20), channel_id=lab["id"], tz=TOKYO))
    lines = await _lines(db, lab["id"])
    assert [m.sender_id for m in lines] == [bot.id, bot.id]
    assert lines[1].body.startswith("📅 Alice さんが「学会」を 2030/1/20 (日) に追加しました\n")


async def test_unread_before_the_event_stays_unread(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice, bob, lab = await _setup(client, db, as_user)
    as_user(bob)
    said = await client.post(
        f"/api/v1/channels/{lab['id']}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": "hello"},
    )
    assert said.status_code in (200, 201), said.text
    as_user(alice)
    await _create(client, timed("ゼミ", AT_14_JST, channel_id=lab["id"], tz=TOKYO))
    hello, line = await _lines(db, lab["id"])
    # Alice had not read bob's message: her position does not jump over it.
    assert not await reads.is_read(db, alice.id, line.channel_id, hello.seq)
    assert not await reads.is_read(db, alice.id, line.channel_id, line.seq)


async def test_what_is_not_announced(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice, bob, lab = await _setup(client, db, as_user)
    # 「チャンネルに知らせる」 off.
    await _create(client, timed("静か", AT_14_JST, channel_id=lab["id"], announce=False))
    # A personal event never posts anywhere (announce is ignored).
    await _create(client, timed("自分", AT_14_JST, announce=True))
    assert await _lines(db, lab["id"]) == []

    # Archived or not writable: the same refusals as before, and no line.
    news = await _channel(client, "news")
    as_user(bob)
    assert (await client.post(f"/api/v1/channels/{news['id']}/join")).status_code == 200
    as_user(alice)
    policy = await client.patch(f"/api/v1/channels/{news['id']}", json={"posting_policy": "owners"})
    assert policy.status_code == 200, policy.text
    as_user(bob)
    refused = await client.post(EVENTS, json=timed("x", AT_14_JST, channel_id=news["id"]))
    assert refused.status_code == 403
    assert await _lines(db, news["id"]) == []
    # The owner may add there, and the bot posts in the announcement channel.
    as_user(alice)
    await _create(client, timed("お知らせ", AT_14_JST, channel_id=news["id"]))
    assert len(await _lines(db, news["id"])) == 1
    assert (await client.post(f"/api/v1/channels/{lab['id']}/archive")).status_code == 200
    archived = await client.post(EVENTS, json=timed("x", AT_14_JST, channel_id=lab["id"]))
    assert archived.status_code == 409
    assert archived.json()["error"]["code"] == "channel_archived"
    assert await _lines(db, lab["id"]) == []


async def test_a_deactivated_bot_stops_the_lines_not_the_events(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    _alice, _bob, lab = await _setup(client, db, as_user)
    await _create(client, timed("1", AT_14_JST, channel_id=lab["id"]))
    [line] = await _lines(db, lab["id"])
    await admin.deactivate_bot_in_tx(db, line.sender_id)
    await db.commit()
    made = await _create(client, timed("2", AT_14_JST, channel_id=lab["id"]))
    assert made["title"] == "2"
    assert len(await _lines(db, lab["id"])) == 1


async def test_a_bot_adding_an_event_posts_nothing(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    _alice, _bob, lab = await _setup(client, db, as_user)
    robot = await make_user(db, "robot", role="bot")
    joined = await client.post(
        f"/api/v1/channels/{lab['id']}/members", json={"user_id": str(robot.id)}
    )
    assert joined.status_code == 200, joined.text
    as_user(robot)
    await _create(client, timed("自動", AT_14_JST, channel_id=lab["id"]))
    assert [m.sender_id for m in await _lines(db, lab["id"])] == []


# --- the words -----------------------------------------------------------------------------------


def _event(**fields: Any) -> CalendarEvent:
    return CalendarEvent(id=uuid.UUID(int=1), title="ゼミ", **fields)


def _timed(start: datetime, end: datetime, **fields: Any) -> CalendarEvent:
    return _event(all_day=False, starts_at=start, ends_at=end, **fields)


def _day(start: date, end: date | None = None, **fields: Any) -> CalendarEvent:
    return _event(all_day=True, start_date=start, end_date=end or start, **fields)


def _text(event: CalendarEvent, base_url: str = "") -> str:
    return announce.body(event, "田中 一郎", TOKYO, NOW, base_url)


def test_one_off_events_in_words() -> None:
    at = datetime(2030, 10, 20, 4, 0, tzinfo=UTC)  # 13:00 in Tokyo, a Sunday
    assert (
        _text(_timed(at, at.replace(hour=5)), "https://chat.example/")
        == "📅 田中 一郎 さんが「ゼミ」を 10/20 (日) 13:00〜14:00 に追加しました\n"
        "https://chat.example/e/00000000-0000-0000-0000-000000000001"
    )
    # Past midnight: the end's day too; in the creator's zone (not UTC).
    late = datetime(2030, 10, 20, 14, 0, tzinfo=UTC)  # 23:00 in Tokyo
    assert "10/20 (日) 23:00〜10/21 (月) 1:00 に" in _text(_timed(late, late.replace(hour=16)))
    assert "10/21 (月) 9:05〜10:00" in _text(
        _timed(datetime(2030, 10, 21, 0, 5, tzinfo=UTC), datetime(2030, 10, 21, 1, tzinfo=UTC))
    )
    assert "を 10/20 (日) に追加しました" in _text(_day(date(2030, 10, 20)))
    assert "を 10/20 (日)〜10/22 (火) に" in _text(_day(date(2030, 10, 20), date(2030, 10, 22)))
    # Another year than now says it.
    assert "を 2031/1/5 (日) に" in _text(_day(date(2031, 1, 5)))
    # Nothing in a title or a name calls anyone or turns bold.
    sneaky = _day(date(2030, 10, 20))
    sneaky.title = "<!channel> **大事**"
    text = announce.body(sneaky, "<@x>", TOKYO, NOW, "")
    assert "<" not in text and "*" not in text


def test_recurring_events_say_their_rule_once() -> None:
    at = datetime(2030, 10, 21, 4, 0, tzinfo=UTC)  # Monday 13:00 in Tokyo
    weekly = _timed(at, at.replace(hour=5), rrule="FREQ=WEEKLY;BYDAY=MO", tz=TOKYO)
    assert _text(weekly) == (
        "📅 田中 一郎 さんが「ゼミ」を 毎週 月曜日 13:00〜14:00 に追加しました（10/21 (月) から）"
    )
    days = _timed(at, at.replace(hour=5), rrule="FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH", tz=TOKYO)
    assert "を 2 週間ごと 月・木曜日 13:00〜14:00 に" in _text(days)
    until = _timed(at, at.replace(hour=5), rrule="FREQ=WEEKLY;UNTIL=20301222", tz=TOKYO)
    assert _text(until).endswith("（10/21 (月) から 12/22 (日) まで）")
    count = _timed(at, at.replace(hour=5), rrule="FREQ=DAILY;COUNT=10", tz=TOKYO)
    assert "を 毎日 13:00〜14:00 に追加しました（10/21 (月) から 10 回）" in _text(count)
    late = datetime(2030, 10, 21, 14, 0, tzinfo=UTC)
    night = _timed(late, late.replace(hour=16), rrule="FREQ=WEEKLY", tz=TOKYO)
    assert "毎週 月曜日 23:00〜翌1:00 に" in _text(night)
    # All-day: the rule alone.
    assert "を 毎月 第 3 月曜日 に追加しました（10/21 (月) から）" in _text(
        _day(date(2030, 10, 21), rrule="FREQ=MONTHLY;BYDAY=3MO", tz=TOKYO)
    )
    assert "を 毎月 最終 木曜日 に" in _text(
        _day(date(2030, 10, 31), rrule="FREQ=MONTHLY;BYDAY=-1TH", tz=TOKYO)
    )
    assert "を 毎月 月末 に" in _text(
        _day(date(2030, 10, 31), rrule="FREQ=MONTHLY;BYMONTHDAY=-1", tz=TOKYO)
    )
    assert "を 毎月 21 日 に" in _text(_day(date(2030, 10, 21), rrule="FREQ=MONTHLY", tz=TOKYO))
    assert "を 毎年 10月21日 に" in _text(_day(date(2030, 10, 21), rrule="FREQ=YEARLY", tz=TOKYO))
    assert "を 3 日ごと に" in _text(_day(date(2030, 10, 21), rrule="FREQ=DAILY;INTERVAL=3"))
