"""L6 (M59, RECURRING.md): recurring posts by a bot, collecting replies, and the nudge after the
due time."""

import json
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import event, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.messages import service as messages
from app.modules.messages.models import Message
from app.modules.recurring import service as recurring
from app.modules.recurring.models import Collection, RecurringPost
from app.modules.recurring.schedule import (
    due_at,
    due_label,
    expand_template,
    next_run_after,
)
from app.modules.reminders.models import Reminder
from app.modules.users.models import User
from tests.helpers import make_user

ROOT = Path(__file__).resolve().parents[2]
TOKYO = ZoneInfo("Asia/Tokyo")
NEW_YORK = ZoneInfo("America/New_York")


def jst(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=TOKYO)


# --- schedule math (pure) -----------------------------------------------------------------------


def test_weekly_on_several_weekdays() -> None:
    schedule = {"kind": "weekly", "weekdays": [0, 3], "time": "09:00"}  # Mon, Thu
    # 2026-10-01 is a Thursday.
    assert next_run_after(schedule, "Asia/Tokyo", jst(2026, 10, 1, 8, 59)) == jst(2026, 10, 1, 9)
    # Exactly at the time: strictly after, so the next one (Monday).
    assert next_run_after(schedule, "Asia/Tokyo", jst(2026, 10, 1, 9)) == jst(2026, 10, 5, 9)
    assert next_run_after(schedule, "Asia/Tokyo", jst(2026, 10, 5, 9, 1)) == jst(2026, 10, 8, 9)
    # Late in the UTC day is already the next day in Tokyo.
    after = datetime(2026, 10, 4, 23, 30, tzinfo=UTC)  # Mon 08:30 JST
    assert next_run_after(schedule, "Asia/Tokyo", after) == jst(2026, 10, 5, 9)
    # Sunday is 6.
    sunday = {"kind": "weekly", "weekdays": [6], "time": "23:59"}
    assert next_run_after(sunday, "Asia/Tokyo", jst(2026, 10, 1)) == jst(2026, 10, 4, 23, 59)


def test_monthly_clamps_to_the_month_end() -> None:
    last = {"kind": "monthly", "day": 31, "time": "18:00"}
    assert next_run_after(last, "Asia/Tokyo", jst(2026, 10, 1)) == jst(2026, 10, 31, 18)
    assert next_run_after(last, "Asia/Tokyo", jst(2026, 10, 31, 18)) == jst(2026, 11, 30, 18)
    assert next_run_after(last, "Asia/Tokyo", jst(2027, 2, 1)) == jst(2027, 2, 28, 18)
    assert next_run_after(last, "Asia/Tokyo", jst(2028, 2, 1)) == jst(2028, 2, 29, 18)  # leap
    thirtieth = {"kind": "monthly", "day": 30, "time": "00:00"}
    assert next_run_after(thirtieth, "Asia/Tokyo", jst(2027, 2, 1)) == jst(2027, 2, 28)
    assert next_run_after(thirtieth, "Asia/Tokyo", jst(2027, 2, 28)) == jst(2027, 3, 30)
    first = {"kind": "monthly", "day": 1, "time": "09:00"}
    assert next_run_after(first, "Asia/Tokyo", jst(2026, 12, 1, 9)) == jst(2027, 1, 1, 9)


def test_schedule_across_daylight_saving_changes() -> None:
    weekly = {"kind": "weekly", "weekdays": [6], "time": "09:00"}  # Sundays
    # 2026-03-08 (Sunday): New York springs forward at 02:00; 09:00 is EDT (UTC-4).
    got = next_run_after(weekly, "America/New_York", datetime(2026, 3, 2, tzinfo=UTC))
    assert got == datetime(2026, 3, 8, 13, tzinfo=UTC)
    # The Sunday before was EST (UTC-5): the same wall time, a different UTC hour.
    got = next_run_after(weekly, "America/New_York", datetime(2026, 2, 28, tzinfo=UTC))
    assert got == datetime(2026, 3, 1, 14, tzinfo=UTC)
    # A wall time the change skips runs after it (02:30 → 03:30 EDT).
    gap = {"kind": "weekly", "weekdays": [6], "time": "02:30"}
    got = next_run_after(gap, "America/New_York", datetime(2026, 3, 7, tzinfo=UTC))
    assert got == datetime(2026, 3, 8, 7, 30, tzinfo=UTC)
    assert got.astimezone(NEW_YORK).hour == 3
    # A wall time that happens twice (2026-11-01 01:30) runs once, at the first (EDT).
    twice = {"kind": "weekly", "weekdays": [6], "time": "01:30"}
    got = next_run_after(twice, "America/New_York", datetime(2026, 10, 31, tzinfo=UTC))
    assert got == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)
    assert next_run_after(twice, "America/New_York", got) == datetime(
        2026, 11, 8, 6, 30, tzinfo=UTC
    )


def test_due_time_and_label() -> None:
    posted = jst(2026, 10, 5, 9)  # Monday
    assert due_at(posted, 3, "18:00", "Asia/Tokyo") == jst(2026, 10, 8, 18)
    assert due_at(posted, 0, "18:00", "Asia/Tokyo") == jst(2026, 10, 5, 18)
    # A same-day due time that has passed (a late 今すぐ投稿) moves to the next day.
    assert due_at(jst(2026, 10, 5, 20), 0, "18:00", "Asia/Tokyo") == jst(2026, 10, 6, 18)
    assert due_label(jst(2026, 10, 9, 18), "Asia/Tokyo") == "10/9 (金) 18:00"
    assert due_label(datetime(2026, 10, 9, 9, tzinfo=UTC), "Asia/Tokyo") == "10/9 (金) 18:00"


def _shared_cases() -> list[dict[str, str]]:
    data = json.loads((ROOT / "apps" / "shared" / "templates.json").read_text())
    cases: list[dict[str, str]] = data["expand"]
    return cases


@pytest.mark.parametrize("case", _shared_cases(), ids=lambda c: c["name"])
def test_template_expansion_matches_the_clients(case: dict[str, str]) -> None:
    today = date.fromisoformat(case["today"])
    assert expand_template(case["input"], today) == case["output"]


# --- helpers ------------------------------------------------------------------------------------

WEEKLY = {"kind": "weekly", "weekdays": [0], "time": "09:00"}


async def _channel(client: AsyncClient, name: str, members: list[User], **extra: Any) -> str:
    created = await client.post("/api/v1/channels", json={"name": name, **extra})
    assert created.status_code == 201, created.text
    cid = str(created.json()["id"])
    for user in members:
        added = await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(user.id)})
        assert added.status_code == 200, added.text
    return cid


async def _create(client: AsyncClient, cid: str, **fields: Any) -> Any:
    payload = {
        "name": "週報",
        "body": "**週報 {date}** ({week})\nこのスレッドに返信してください",
        "schedule": WEEKLY,
        "tz": "Asia/Tokyo",
        **fields,
    }
    return await client.post(f"/api/v1/channels/{cid}/recurring-posts", json=payload)


async def _reply(
    client: AsyncClient, cid: str, parent: str, body: str = "提出します", **x: Any
) -> Any:
    payload = {"client_msg_id": str(uuid.uuid4()), "body": body, "parent_id": parent, **x}
    response = await client.post(f"/api/v1/channels/{cid}/messages", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def _events(db: AsyncSession, message_id: str, change: str) -> list[OutboxEvent]:
    rows = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "message.updated")
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    return [
        e
        for e in rows
        if e.payload["message"]["id"] == message_id and e.payload["change"] == change
    ]


async def _run(app: FastAPI, now: datetime) -> int:
    async with app.state.db.session_factory() as worker:
        return await recurring.run_due(worker, now=now)


async def _remind(app: FastAPI, now: datetime) -> int:
    async with app.state.db.session_factory() as worker:
        return await recurring.remind_due(worker, now=now)


async def _bot_posts(db: AsyncSession, bot_id: uuid.UUID) -> list[Message]:
    rows = await db.execute(
        select(Message)
        .where(Message.sender_id == bot_id)
        .order_by(Message.seq)
        .execution_options(populate_existing=True)
    )
    return list(rows.scalars().all())


# --- API ----------------------------------------------------------------------------------------


async def test_create_list_update_delete_and_who_may(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")  # the channel's owner
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")  # not a member
    root = await make_user(db, "root", role="admin")
    as_user(alice)
    cid = await _channel(client, "weekly", [bob, root], type="private")

    created = await _create(client, cid)
    assert created.status_code == 201, created.text
    post = created.json()
    assert post["name"] == "週報" and post["enabled"] and post["collect"] is None
    assert post["schedule"] == WEEKLY and post["tz"] == "Asia/Tokyo"
    next_run = datetime.fromisoformat(post["next_run_at"]).astimezone(TOKYO)
    assert next_run.weekday() == 0 and (next_run.hour, next_run.minute) == (9, 0)
    assert next_run > utcnow()
    # The bot joined the channel under the post's name.
    bot = await db.get(User, uuid.UUID(post["bot_user_id"]))
    assert bot is not None and bot.role == "bot" and bot.display_name == "週報"
    members = (await client.get(f"/api/v1/channels/{cid}/members")).json()
    assert post["bot_user_id"] in [m["user_id"] for m in members]

    # Members see the list; only owners and administrators change it.
    as_user(bob)
    listed = (await client.get(f"/api/v1/channels/{cid}/recurring-posts")).json()
    assert [p["id"] for p in listed] == [post["id"]]
    denied = await _create(client, cid, name="議題")
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "recurring_manage_restricted"
    for call in (
        client.patch(f"/api/v1/recurring-posts/{post['id']}", json={"enabled": False}),
        client.post(f"/api/v1/recurring-posts/{post['id']}/run"),
        client.delete(f"/api/v1/recurring-posts/{post['id']}"),
    ):
        response = await call
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "recurring_manage_restricted"
    # Someone outside a private channel neither reads nor learns the row exists.
    as_user(carol)
    assert (await client.get(f"/api/v1/channels/{cid}/recurring-posts")).status_code == 403
    hidden = await client.patch(f"/api/v1/recurring-posts/{post['id']}", json={"enabled": False})
    assert hidden.status_code == 404
    assert hidden.json()["error"]["code"] == "recurring_post_not_found"

    # An administrator who is a member manages it: rename (the bot follows), pause, resume.
    as_user(root)
    renamed = await client.patch(
        f"/api/v1/recurring-posts/{post['id']}", json={"name": "  週報  (B4) "}
    )
    assert renamed.status_code == 200 and renamed.json()["name"] == "週報 (B4)"
    await db.refresh(bot)
    assert bot.display_name == "週報 (B4)"
    paused = await client.patch(f"/api/v1/recurring-posts/{post['id']}", json={"enabled": False})
    assert paused.json()["enabled"] is False
    # Resuming computes the next time from now (nothing missed while paused is posted).
    await db.execute(update(RecurringPost).values(next_run_at=utcnow() - timedelta(days=30)))
    await db.commit()
    resumed = await client.patch(f"/api/v1/recurring-posts/{post['id']}", json={"enabled": True})
    assert datetime.fromisoformat(resumed.json()["next_run_at"]) > utcnow()
    monthly = await client.patch(
        f"/api/v1/recurring-posts/{post['id']}",
        json={
            "schedule": {"kind": "monthly", "day": 31, "time": "18:30"},
            "tz": "America/New_York",
        },
    )
    assert monthly.status_code == 200
    local = datetime.fromisoformat(monthly.json()["next_run_at"]).astimezone(NEW_YORK)
    assert (local.hour, local.minute) == (18, 30)

    # Deleting stops it: gone from the list, the bot leaves and is deactivated.
    as_user(alice)
    assert (await client.delete(f"/api/v1/recurring-posts/{post['id']}")).status_code == 204
    assert (await client.get(f"/api/v1/channels/{cid}/recurring-posts")).json() == []
    await db.refresh(bot)
    assert bot.deactivated_at is not None
    members = (await client.get(f"/api/v1/channels/{cid}/members")).json()
    assert post["bot_user_id"] not in [m["user_id"] for m in members]
    gone = await client.post(f"/api/v1/recurring-posts/{post['id']}/run")
    assert gone.status_code == 404


async def test_validation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "weekly", [bob])
    bad: list[dict[str, Any]] = [
        {"schedule": {"kind": "weekly", "weekdays": [], "time": "09:00"}},
        {"schedule": {"kind": "weekly", "weekdays": [7], "time": "09:00"}},
        {"schedule": {"kind": "weekly", "weekdays": [1], "time": "24:00"}},
        {"schedule": {"kind": "weekly", "weekdays": [1], "time": "9:00"}},
        {"schedule": {"kind": "monthly", "day": 0, "time": "09:00"}},
        {"schedule": {"kind": "monthly", "day": 32, "time": "09:00"}},
        {"schedule": {"kind": "daily", "time": "09:00"}},
        {"tz": "Mars/Olympus"},
        {"name": "   "},
        {"name": "あ" * 41},
        {"body": " \n "},
        {"body": "x" * 4001},
        {"collect": {"targets": {}, "due": {"after_days": 1, "time": "18:00"}}},
        {
            "collect": {
                "targets": {"user_ids": [str(bob.id)]},
                "due": {"after_days": 31, "time": "18:00"},
            }
        },
    ]
    for fields in bad:
        response = await _create(client, cid, **fields)
        assert response.status_code == 422, (fields, response.text)
    unknown_group = await _create(
        client,
        cid,
        collect={
            "targets": {"group_ids": [str(uuid.uuid4())]},
            "due": {"after_days": 1, "time": "18:00"},
        },
    )
    assert unknown_group.status_code == 404
    assert unknown_group.json()["error"]["code"] == "group_not_found"
    post = (await _create(client, cid)).json()
    nulls = await client.patch(f"/api/v1/recurring-posts/{post['id']}", json={"name": None})
    assert nulls.status_code == 422
    # Not in a DM.
    dm = await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})
    assert dm.status_code in (200, 201), dm.text
    in_dm = await _create(client, str(dm.json()["id"]))
    assert in_dm.status_code == 400
    assert in_dm.json()["error"]["code"] == "recurring_channel_unsupported"


async def test_at_most_twenty_per_channel(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "busy", [])
    for i in range(recurring.MAX_PER_CHANNEL):
        assert (await _create(client, cid, name=f"post {i}")).status_code == 201
    too_many = await _create(client, cid, name="one more")
    assert too_many.status_code == 409
    assert too_many.json()["error"]["code"] == "too_many_recurring_posts"


# --- the worker ---------------------------------------------------------------------------------


async def test_worker_posts_once_per_due_time_and_catches_up_once(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "weekly", [], posting_policy="owners")
    post = (await _create(client, cid)).json()
    bot_id = uuid.UUID(post["bot_user_id"])
    row = await db.get(RecurringPost, uuid.UUID(post["id"]))
    assert row is not None
    first = row.next_run_at

    # Not yet.
    assert await _run(app, first - timedelta(seconds=1)) == 0
    # Its time (a Monday 09:00 in Tokyo; the template reads that day).
    assert await _run(app, first + timedelta(seconds=5)) == 1
    posts = await _bot_posts(db, bot_id)
    day = first.astimezone(TOKYO).date()
    assert len(posts) == 1
    assert posts[0].body.startswith(f"**週報 {day:%Y/%m/%d} (月)** ({day.isocalendar()[0]}-W")
    await db.refresh(row)
    assert row.next_run_at == first + timedelta(days=7)
    assert row.last_run_at == first + timedelta(seconds=5)
    # Running again for the same time posts nothing (next_run_at moved with the post).
    assert await _run(app, first + timedelta(seconds=10)) == 0

    # The server was down for three weeks: one post, then the next future time.
    later = first + timedelta(days=7 * 3 + 2)
    assert await _run(app, later) == 1
    assert len(await _bot_posts(db, bot_id)) == 2
    await db.refresh(row)
    assert row.next_run_at == first + timedelta(days=7 * 4)
    assert await _run(app, later + timedelta(minutes=1)) == 0

    # Paused: nothing.
    await client.patch(f"/api/v1/recurring-posts/{post['id']}", json={"enabled": False})
    await db.execute(update(RecurringPost).values(next_run_at=utcnow() - timedelta(minutes=1)))
    await db.commit()
    assert await _run(app, utcnow()) == 0


async def test_archived_channel_pauses_the_post(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "weekly", [])
    post = (await _create(client, cid)).json()
    assert (await client.post(f"/api/v1/channels/{cid}/archive")).status_code == 200
    await db.execute(update(RecurringPost).values(next_run_at=utcnow() - timedelta(minutes=1)))
    await db.commit()
    assert await _run(app, utcnow()) == 0
    row = await db.get(RecurringPost, uuid.UUID(post["id"]))
    assert row is not None
    await db.refresh(row)
    assert row.enabled is False
    assert await _bot_posts(db, row.bot_user_id) == []
    # Managers cannot run or change it while archived.
    run = await client.post(f"/api/v1/recurring-posts/{post['id']}/run")
    assert run.status_code == 409 and run.json()["error"]["code"] == "channel_archived"


async def test_run_now_keeps_the_schedule(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "weekly", [])
    post = (await _create(client, cid, enabled=False, body="今日は {weekday} 曜日")).json()
    ran = await client.post(f"/api/v1/recurring-posts/{post['id']}/run")
    assert ran.status_code == 201, ran.text
    message = await db.get(Message, uuid.UUID(ran.json()["message_id"]))
    assert message is not None
    weekday = "月火水木金土日"[utcnow().astimezone(TOKYO).weekday()]
    assert message.body == f"今日は {weekday} 曜日"
    after = (await client.get(f"/api/v1/channels/{cid}/recurring-posts")).json()[0]
    assert after["next_run_at"] == post["next_run_at"] and after["last_run_at"] is not None
    history = (await client.get(f"/api/v1/channels/{cid}/messages")).json()
    assert [m["sender_id"] for m in history["messages"]] == [post["bot_user_id"]]


# --- collections --------------------------------------------------------------------------------


async def test_collection_snapshot_submissions_and_events(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")  # owner, not a target
    bob = await make_user(db, "bob")  # in the group
    carol = await make_user(db, "carol")  # named
    dave = await make_user(db, "dave")  # in the group, deactivated before the post
    erin = await make_user(db, "erin")  # in the group, not a member of the channel
    frank = await make_user(db, "frank")  # a member, not a target
    robot = await make_user(db, "robot", role="bot")  # named, but a bot
    root = await make_user(db, "root", role="admin")
    as_user(root)
    group = await client.post(
        "/api/v1/admin/groups",
        json={"name": "students", "member_ids": [str(bob.id), str(dave.id), str(erin.id)]},
    )
    assert group.status_code == 201, group.text
    as_user(alice)
    cid = await _channel(client, "weekly", [bob, carol, dave, frank, robot])
    post = (
        await _create(
            client,
            cid,
            collect={
                "targets": {
                    "group_ids": [group.json()["id"]],
                    "user_ids": [str(carol.id), str(robot.id)],
                },
                "due": {"after_days": 3, "time": "18:00"},
            },
        )
    ).json()
    assert post["collect"]["due"] == {"after_days": 3, "time": "18:00"}
    dave.deactivated_at = utcnow()
    await db.commit()

    row = await db.get(RecurringPost, uuid.UUID(post["id"]))
    assert row is not None
    posted_at = row.next_run_at + timedelta(seconds=3)
    assert await _run(app, posted_at) == 1
    [message] = await _bot_posts(db, row.bot_user_id)
    mid = str(message.id)
    collection = await db.get(Collection, message.id)
    assert collection is not None
    # Bob and Carol (display-name order); not Dave, Erin, the bot, Frank or the owner.
    assert collection.target_user_ids == [bob.id, carol.id]
    assert collection.due_at == row.next_run_at.astimezone(TOKYO).replace(
        hour=18, minute=0
    ) + timedelta(days=3)
    # The clients learn the collection at once (message.created had none).
    assert len(await _events(db, mid, "collection")) == 1

    def chip(out: dict[str, Any]) -> dict[str, Any]:
        value: dict[str, Any] = out["collection"]
        return value

    history = (await client.get(f"/api/v1/channels/{cid}/messages")).json()["messages"]
    [shown] = [m for m in history if m["id"] == mid]
    assert chip(shown)["target_count"] == 2
    assert chip(shown)["target_user_ids"] == [str(bob.id), str(carol.id)]
    assert chip(shown)["submitted_user_ids"] == [] and chip(shown)["reminded_at"] is None

    # A non-target's reply changes nothing about the collection.
    as_user(frank)
    await _reply(client, cid, mid, "おつかれさまです")
    assert len(await _events(db, mid, "collection")) == 1
    # Bob replies: submitted, and the parent's message.updated (change collection) says so.
    as_user(bob)
    first = await _reply(client, cid, mid)
    events = await _events(db, mid, "collection")
    assert len(events) == 2
    assert events[-1].payload["message"]["collection"]["submitted_user_ids"] == [str(bob.id)]
    assert events[-1].payload["message"]["reply_count"] == 2
    # The event's seq is newer than the reply's (clients keep the newest updated_seq).
    assert events[-1].payload["message"]["updated_seq"] > first["seq"]
    # A second reply by Bob changes nothing; deleting one of the two neither.
    second = await _reply(client, cid, mid, "追記")
    assert len(await _events(db, mid, "collection")) == 2
    assert (await client.delete(f"/api/v1/messages/{first['id']}")).status_code == 200
    assert len(await _events(db, mid, "collection")) == 2
    # Deleting the last one: not submitted again.
    assert (await client.delete(f"/api/v1/messages/{second['id']}")).status_code == 200
    events = await _events(db, mid, "collection")
    assert len(events) == 3
    assert events[-1].payload["message"]["collection"]["submitted_user_ids"] == []
    # Carol's reply sent to the channel too counts.
    as_user(carol)
    await _reply(client, cid, mid, "出しました", also_in_channel=True)
    one = await client.get(f"/api/v1/messages/{mid}/replies")
    assert one.status_code == 200
    out = await messages.message_out(db, message)
    assert out.collection is not None
    assert out.collection.submitted_user_ids == [carol.id]

    # Delta sync carries it too.
    delta = (await client.get(f"/api/v1/channels/{cid}/sync?since_seq=0")).json()
    [synced] = [m for m in delta["messages"] if m["id"] == mid]
    assert chip(synced)["submitted_user_ids"] == [str(carol.id)]


async def test_nudges_once_for_the_missing_only(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    dave = await make_user(db, "dave")  # a target who leaves the channel before the due time
    as_user(alice)
    cid = await _channel(client, "weekly", [bob, carol, dave])
    post = (
        await _create(
            client,
            cid,
            collect={
                "targets": {"all_members": True},
                "due": {"after_days": 3, "time": "18:00"},
            },
        )
    ).json()
    row = await db.get(RecurringPost, uuid.UUID(post["id"]))
    assert row is not None
    assert await _run(app, row.next_run_at) == 1
    [message] = await _bot_posts(db, row.bot_user_id)
    collection = await db.get(Collection, message.id)
    assert collection is not None
    assert collection.target_user_ids == [alice.id, bob.id, carol.id, dave.id]
    due = collection.due_at
    assert due_label(due, "Asia/Tokyo").endswith(" 18:00")

    as_user(bob)
    await _reply(client, cid, str(message.id))
    as_user(alice)
    assert (await client.delete(f"/api/v1/channels/{cid}/members/{dave.id}")).status_code == 204

    assert await _remind(app, due - timedelta(minutes=1)) == 0
    assert await _remind(app, due + timedelta(seconds=30)) == 2  # Alice and Carol
    assert await _remind(app, due + timedelta(minutes=1)) == 0  # once
    reminders = (await db.execute(select(Reminder).order_by(Reminder.user_id))).scalars().all()
    assert sorted(r.user_id for r in reminders) == sorted([alice.id, carol.id])
    note = f"週報 の提出をお願いします (締切 {due_label(due, 'Asia/Tokyo')})"
    assert {(r.kind, r.status, r.note) for r in reminders} == {("collect", "fired", note)}
    # Each event goes to its person only.
    nudges = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "reminder.updated")))
        .scalars()
        .all()
    )
    assert sorted(e.audience_id for e in nudges if e.audience_id) == sorted([alice.id, carol.id])
    assert {e.audience_type for e in nudges} == {"user"}
    await db.refresh(collection)
    assert collection.reminded_at == due + timedelta(seconds=30)
    shown = await messages.message_out(db, message)
    assert shown.collection is not None and shown.collection.reminded_at is not None

    # Carol's list shows the nudge until she submits.
    as_user(carol)
    listed = (await client.get("/api/v1/reminders")).json()
    assert [(r["kind"], r["note"]) for r in listed] == [("collect", note)]
    await _reply(client, cid, str(message.id))
    assert (await client.get("/api/v1/reminders")).json() == []


async def test_no_nudges_for_a_deleted_post_or_an_archived_channel(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice", role="admin")  # may delete the bot's post
    bob = await make_user(db, "bob")
    as_user(alice)
    collect = {"targets": {"user_ids": [str(bob.id)]}, "due": {"after_days": 0, "time": "23:59"}}
    first = await _channel(client, "one", [bob])
    second = await _channel(client, "two", [bob])
    for cid in (first, second):
        post = (await _create(client, cid, collect=collect)).json()
        assert (await client.post(f"/api/v1/recurring-posts/{post['id']}/run")).status_code == 201
    rows = (await db.execute(select(Collection))).scalars().all()
    assert len(rows) == 2
    by_channel = {str(r.channel_id): r for r in rows}
    # The first post's message is deleted; the second channel is archived.
    assert (
        await client.delete(f"/api/v1/messages/{by_channel[first].message_id}")
    ).status_code == 200
    assert (await client.post(f"/api/v1/channels/{second}/archive")).status_code == 200
    latest = max(r.due_at for r in rows)
    assert await _remind(app, latest + timedelta(minutes=1)) == 0
    assert (await db.execute(select(Reminder))).scalars().all() == []


async def test_history_pages_read_collections_in_constant_queries(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "weekly", [bob])
    collect = {"targets": {"user_ids": [str(bob.id)]}, "due": {"after_days": 1, "time": "18:00"}}
    post = (await _create(client, cid, collect=collect)).json()

    @contextmanager
    def counting() -> Iterator[list[str]]:
        statements: list[str] = []

        def record(*args: Any) -> None:
            statements.append(str(args[2]))

        engine = app.state.db.engine.sync_engine
        event.listen(engine, "before_cursor_execute", record)
        try:
            yield statements
        finally:
            event.remove(engine, "before_cursor_execute", record)

    async def page_queries() -> int:
        with counting() as statements:
            response = await client.get(f"/api/v1/channels/{cid}/messages")
            assert response.status_code == 200
        return len(statements)

    assert (await client.post(f"/api/v1/recurring-posts/{post['id']}/run")).status_code == 201
    one = await page_queries()
    for _ in range(4):
        await client.post(f"/api/v1/recurring-posts/{post['id']}/run")
    as_user(bob)
    history = (await client.get(f"/api/v1/channels/{cid}/messages")).json()["messages"]
    for message in history:
        await _reply(client, cid, message["id"])
    as_user(alice)
    assert await page_queries() == one
