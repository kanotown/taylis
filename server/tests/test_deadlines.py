"""M85 (L5, DEADLINES.md): deadlines on top of tasks — the kind, the rules, the advance notices
the deadline bot posts in the channel, and 「締切」 (GET /tasks/deadlines)."""

import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any, cast

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.messages.models import Message
from app.modules.tasks import deadlines
from app.modules.tasks.models import TaskDeadlineNotice
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_tasks import API, TASKS, _channel, _create, _join, _move, _patch, _post

DEADLINES = f"{TASKS}/deadlines"
# Far enough ahead that every notice is still to come.
DUE = date(2030, 1, 10)  # a Thursday


def _jst(day: date, hour: int = 9, minute: int = 0) -> datetime:
    """`hour:minute` on `day` in Tokyo, as UTC."""
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=UTC) - timedelta(hours=9)


async def _notices(app: FastAPI, task_id: str) -> list[TaskDeadlineNotice]:
    async with app.state.db.session_factory() as session:
        rows = await session.execute(
            select(TaskDeadlineNotice)
            .where(TaskDeadlineNotice.task_id == uuid.UUID(task_id))
            .order_by(TaskDeadlineNotice.fire_at, TaskDeadlineNotice.days_before)
        )
        return list(rows.scalars().all())


def _pending(rows: list[TaskDeadlineNotice]) -> list[tuple[int, datetime]]:
    return [(r.days_before, r.fire_at) for r in rows if r.status == "pending"]


async def _fire(app: FastAPI, now: datetime) -> int:
    async with app.state.db.session_factory() as worker:
        return await deadlines.fire_notices(worker, now=now)


async def _bot_posts(app: FastAPI, channel_id: str) -> list[Message]:
    async with app.state.db.session_factory() as session:
        bot_id = await deadlines.bot_user_id(session)
        if bot_id is None:
            return []
        rows = await session.execute(
            select(Message)
            .where(Message.sender_id == bot_id, Message.channel_id == uuid.UUID(channel_id))
            .order_by(Message.seq)
        )
        return list(rows.scalars().all())


async def _deadline(
    client: AsyncClient, channel_id: str, status: int = 201, **extra: Any
) -> dict[str, Any]:
    body = {
        "channel_id": channel_id,
        "kind": "deadline",
        "title": "全国大会 原稿",
        "due_on": DUE.isoformat(),
        "tz": "Asia/Tokyo",
        **extra,
    }
    return await _create(client, body, status)


async def _error(response: Any) -> str:
    return cast(str, response.json()["error"]["code"])


# --- the pure rules ------------------------------------------------------------------------------


def test_plan_label_and_body() -> None:
    plan = deadlines.notice_plan(DUE, None, "Asia/Tokyo", [7, 3, 1, 0])
    assert plan == {
        7: _jst(date(2030, 1, 3)),
        3: _jst(date(2030, 1, 7)),
        1: _jst(date(2030, 1, 9)),
        0: _jst(DUE),
    }
    # A timed deadline: a notice not before its time is left out (8:30 on the day: no day-0 one).
    timed = deadlines.notice_plan(DUE, _jst(DUE, 8, 30), "Asia/Tokyo", [1, 0])
    assert timed == {1: _jst(date(2030, 1, 9))}
    assert deadlines.notice_plan(DUE, _jst(DUE, 17), "Asia/Tokyo", [0]) == {0: _jst(DUE)}
    assert deadlines.deadline_end(DUE, None, "Asia/Tokyo") == _jst(date(2030, 1, 11), 0)
    assert deadlines.due_label(DUE, None, "Asia/Tokyo") == "1/10 (木)"
    assert deadlines.due_label(DUE, _jst(DUE, 17), "Asia/Tokyo") == "1/10 (木) 17:00"
    assert deadlines.notice_body("原稿", 3, "1/10 (木)", []) == (
        "⏰ 締切まであと 3 日です: **原稿** (1/10 (木))"
    )
    assert deadlines.notice_body("原稿", 1, "1/10 (木)", ["加納", "海老"]) == (
        "⏰ 明日が締切です: **原稿** (1/10 (木))\n担当: 加納、海老"
    )
    assert deadlines.notice_body("原稿", 0, "x", []).startswith("⏰ 今日が締切です")
    alice = uuid.uuid4()
    assert deadlines.plain_title(f"**原稿** <@{alice}> <!channel>", {alice: "Alice"}) == (
        "原稿 @Alice @channel"
    )


# --- the API -------------------------------------------------------------------------------------


async def test_create_rules_and_who_may(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    guest = await make_user(db, "guest", role="guest")
    as_user(alice)
    lab = await _channel(client, "lab")
    await _join(client, as_user, lab["id"], bob)
    as_user(alice)
    added = await client.post(
        f"{API}/channels/{lab['id']}/members", json={"user_id": str(guest.id)}
    )
    assert added.status_code in (200, 201), added.text

    made = await _deadline(client, lab["id"], assignee_ids=[str(bob.id)])
    assert made["kind"] == "deadline" and made["notice_days"] == [7, 3, 1, 0]
    assert made["due_on"] == DUE.isoformat() and made["assignee_ids"] == [str(bob.id)]
    # Days are distinct, largest first; a plain task has none.
    custom = await _deadline(client, lab["id"], notice_days=[0, 14, 1, 1])
    assert custom["notice_days"] == [14, 1, 0]
    plain = await _create(client, {"channel_id": lab["id"], "title": "t"})
    assert plain["kind"] == "task" and plain["notice_days"] is None

    # Not in my own list, not without a date, not repeating, not from a message, not on a task.
    base = {"kind": "deadline", "title": "x", "channel_id": lab["id"], "due_on": DUE.isoformat()}
    for extra, code in (
        ({"channel_id": None}, "task_invalid_deadline"),
        ({"due_on": None}, "task_invalid_deadline"),
        ({"rrule": "FREQ=WEEKLY"}, "task_invalid_rrule"),
    ):
        response = await client.post(TASKS, json={**base, **extra})
        assert response.status_code == 400 and await _error(response) == code, response.text
    message = await _post(client, lab["id"], "原稿の締切")
    response = await client.post(
        TASKS,
        json={
            "kind": "deadline",
            "title": "x",
            "channel_id": lab["id"],
            "due_on": DUE.isoformat(),
            "source_message_id": message["id"],
        },
    )
    assert response.status_code == 400 and await _error(response) == "task_invalid_source"
    response = await client.post(TASKS, json={"title": "x", "notice_days": [1]})
    assert response.status_code == 400 and await _error(response) == "task_invalid_deadline"
    response = await client.post(
        TASKS,
        json={"kind": "deadline", "title": "x", "channel_id": lab["id"], "notice_days": [61]},
    )
    assert response.status_code == 422
    response = await client.patch(f"{TASKS}/{plain['id']}", json={"notice_days": [1]})
    assert response.status_code == 400 and await _error(response) == "task_invalid_deadline"
    # A deadline keeps its date.
    response = await client.patch(f"{TASKS}/{made['id']}", json={"due_on": None})
    assert response.status_code == 400 and await _error(response) == "task_invalid_deadline"
    # A DM has no board.
    dm = await client.post(f"{API}/dms", json={"user_ids": [str(bob.id)]})
    assert dm.status_code in (200, 201), dm.text
    response = await client.post(
        TASKS,
        json={
            "kind": "deadline",
            "title": "x",
            "channel_id": dm.json()["id"],
            "due_on": DUE.isoformat(),
        },
    )
    assert response.status_code == 400 and await _error(response) == "task_channel_unsupported"

    # Members who may post set them; a guest does not (the bot posts them).
    as_user(bob)
    by_bob = await _deadline(client, lab["id"], title="奨学金")
    edited = await _patch(client, by_bob["id"], {"notice_days": [], "title": "奨学金 書類"})
    assert edited["notice_days"] == [] and edited["kind"] == "deadline"
    as_user(guest)
    response = await client.post(
        TASKS,
        json={
            "kind": "deadline",
            "title": "x",
            "channel_id": lab["id"],
            "due_on": DUE.isoformat(),
        },
    )
    assert response.status_code == 403 and await _error(response) == "guest_restricted"
    # An announcement channel: only its owners (and administrators) change the board.
    as_user(alice)
    await client.patch(f"{API}/channels/{lab['id']}", json={"posting_policy": "owners"})
    as_user(bob)
    response = await client.post(
        TASKS,
        json={
            "kind": "deadline",
            "title": "x",
            "channel_id": lab["id"],
            "due_on": DUE.isoformat(),
        },
    )
    assert response.status_code == 403 and await _error(response) == "posting_restricted"


async def test_notices_are_planned_and_replanned(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await _channel(client, "lab")
    made = await _deadline(client, lab["id"])
    plan = [
        (7, _jst(date(2030, 1, 3))),
        (3, _jst(date(2030, 1, 7))),
        (1, _jst(date(2030, 1, 9))),
        (0, _jst(DUE)),
    ]
    assert _pending(await _notices(app, made["id"])) == plan

    # Moving it plans the new dates (the old ones are cancelled).
    later = date(2030, 1, 20)
    await _patch(client, made["id"], {"due_on": later.isoformat()})
    rows = await _notices(app, made["id"])
    assert _pending(rows) == [
        (7, _jst(date(2030, 1, 13))),
        (3, _jst(date(2030, 1, 17))),
        (1, _jst(date(2030, 1, 19))),
        (0, _jst(later)),
    ]
    assert len([r for r in rows if r.status == "cancelled"]) == 4
    # Back again: the first plan's rows come back (nothing was posted yet).
    await _patch(client, made["id"], {"due_on": DUE.isoformat()})
    assert _pending(await _notices(app, made["id"])) == plan
    # Fewer days.
    await _patch(client, made["id"], {"notice_days": [1]})
    assert _pending(await _notices(app, made["id"])) == [(1, _jst(date(2030, 1, 9)))]
    # A due time: the notices follow its zone, and one not before the time is dropped.
    timed = await _patch(
        client,
        made["id"],
        {"due_at": "2030-01-10T08:00:00+09:00", "notice_days": [1, 0], "tz": "Asia/Tokyo"},
    )
    assert timed["due_tz"] == "Asia/Tokyo"
    assert _pending(await _notices(app, made["id"])) == [(1, _jst(date(2030, 1, 9)))]
    # Done: nothing pending. Reopened: back.
    await _patch(client, made["id"], {"status": "done"})
    assert _pending(await _notices(app, made["id"])) == []
    await _move(client, made["id"], {"status": "todo"})
    assert _pending(await _notices(app, made["id"])) == [(1, _jst(date(2030, 1, 9)))]
    # Deleted: nothing pending.
    assert (await client.delete(f"{TASKS}/{made['id']}")).status_code == 204
    assert _pending(await _notices(app, made["id"])) == []

    # Made close to the date: the notices already past are not sent after the fact.
    today = utcnow().astimezone(UTC).date()
    soon = await _deadline(client, lab["id"], due_on=(today + timedelta(days=2)).isoformat())
    days = [d for d, _ in _pending(await _notices(app, soon["id"]))]
    assert 7 not in days and 3 not in days and 0 in days


async def test_the_bot_posts_each_notice_once(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    lab = await _channel(client, "lab")
    await _join(client, as_user, lab["id"], bob)
    as_user(alice)
    made = await _deadline(client, lab["id"], assignee_ids=[str(bob.id)])

    assert await _fire(app, _jst(date(2030, 1, 3), 8, 59)) == 0
    assert await _fire(app, _jst(date(2030, 1, 3))) == 1
    posts = await _bot_posts(app, lab["id"])
    assert [p.body for p in posts] == [
        "⏰ 締切まであと 7 日です: **全国大会 原稿** (1/10 (木))\n担当: Bob"
    ]
    # Once: running again posts nothing.
    assert await _fire(app, _jst(date(2030, 1, 3), 9, 5)) == 0
    rows = await _notices(app, made["id"])
    fired = [r for r in rows if r.status == "fired"]
    assert [(r.days_before, r.message_id) for r in fired] == [(7, posts[0].id)]
    # The bot is 「締切」, a member of the channel now; it did not move anyone's read position.
    members = (await client.get(f"{API}/channels/{lab['id']}/members")).json()
    bot = next(m for m in members if m["user_id"] == str(posts[0].sender_id))
    assert bot is not None
    async with app.state.db.session_factory() as session:
        account = await session.get(User, posts[0].sender_id)
        assert account is not None and account.role == "bot" and account.display_name == "締切"

    # A server that was down past the 3-day and 1-day times posts once, the nearest.
    assert await _fire(app, _jst(date(2030, 1, 9), 12)) == 1
    posts = await _bot_posts(app, lab["id"])
    assert posts[-1].body.startswith("⏰ 明日が締切です") and len(posts) == 2
    statuses = {r.days_before: r.status for r in await _notices(app, made["id"])}
    assert statuses == {7: "fired", 3: "cancelled", 1: "fired", 0: "pending"}

    # Moving it posts again for the new date; nothing after the deadline itself.
    await _patch(client, made["id"], {"due_on": "2030-01-12", "notice_days": [0]})
    assert await _fire(app, _jst(date(2030, 1, 13), 0, 1)) == 0  # the day is over
    assert len(await _bot_posts(app, lab["id"])) == 2
    await _patch(client, made["id"], {"due_on": "2030-01-14"})
    assert await _fire(app, _jst(date(2030, 1, 14), 10)) == 1
    assert (await _bot_posts(app, lab["id"]))[-1].body.startswith("⏰ 今日が締切です")


async def test_no_notice_when_done_archived_or_removed_bot_rejoins(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice", role="admin")
    as_user(alice)
    lab = await _channel(client, "lab")
    done = await _deadline(client, lab["id"], title="済み", notice_days=[1])
    await _patch(client, done["id"], {"status": "done"})
    kept = await _deadline(client, lab["id"], title="残り", notice_days=[1])
    # An announcement channel: the bot posts there too (only owners set its deadlines).
    await client.patch(f"{API}/channels/{lab['id']}", json={"posting_policy": "owners"})
    assert await _fire(app, _jst(date(2030, 1, 9))) == 1
    posts = await _bot_posts(app, lab["id"])
    assert [p.body.split("\n")[0] for p in posts] == ["⏰ 明日が締切です: **残り** (1/10 (木))"]

    # Removed from the channel, the bot comes back for the next notice.
    bot_id = posts[0].sender_id
    removed = await client.delete(f"{API}/channels/{lab['id']}/members/{bot_id}")
    assert removed.status_code in (200, 204), removed.text
    await _patch(client, kept["id"], {"notice_days": [1, 0]})
    assert await _fire(app, _jst(DUE, 9, 1)) == 1
    members = [
        m["user_id"] for m in (await client.get(f"{API}/channels/{lab['id']}/members")).json()
    ]
    assert str(bot_id) in members

    # Archived: no notice (and it does not come back later).
    other = await _channel(client, "other")
    late = await _deadline(client, other["id"], notice_days=[0])
    assert (await client.post(f"{API}/channels/{other['id']}/archive")).status_code in (200, 204)
    assert await _fire(app, _jst(DUE, 9, 2)) == 0
    statuses = [r.status for r in await _notices(app, late["id"])]
    assert statuses == ["cancelled"]


async def test_deadlines_list(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    lab = await _channel(client, "lab")
    secret = await _channel(client, "secret", type="private")
    await _join(client, as_user, lab["id"], bob)
    as_user(alice)
    today = utcnow().astimezone(UTC).date()
    far = await _deadline(
        client, lab["id"], title="far", due_on=(today + timedelta(days=40)).isoformat()
    )
    near = await _deadline(
        client, lab["id"], title="near", due_on=(today + timedelta(days=2)).isoformat()
    )
    timed = await _deadline(
        client,
        lab["id"],
        title="timed",
        due_on=None,
        due_at=f"{(today + timedelta(days=2)).isoformat()}T05:00:00Z",
    )
    past = await _deadline(
        client, lab["id"], title="past", due_on=(today - timedelta(days=3)).isoformat()
    )
    await _deadline(client, lab["id"], title="old", due_on=(today - timedelta(days=31)).isoformat())
    hidden = await _deadline(client, secret["id"], title="hidden")
    await _create(client, {"channel_id": lab["id"], "title": "task", "due_on": DUE.isoformat()})
    await _patch(client, past["id"], {"status": "done"})

    mine = (await client.get(DEADLINES)).json()
    assert [t["title"] for t in mine] == ["past", "timed", "near", "far", "hidden"]
    assert mine[-1]["id"] == hidden["id"]
    assert {t["kind"] for t in mine} == {"deadline"}
    assert [t["id"] for t in mine[:4]] == [past["id"], timed["id"], near["id"], far["id"]]
    only = (await client.get(DEADLINES, params={"channel_id": secret["id"]})).json()
    assert [t["id"] for t in only] == [hidden["id"]]
    # Bob is not in the private channel.
    as_user(bob)
    assert [t["title"] for t in (await client.get(DEADLINES)).json()] == [
        "past",
        "timed",
        "near",
        "far",
    ]
    response = await client.get(DEADLINES, params={"channel_id": secret["id"]})
    assert response.status_code == 403
