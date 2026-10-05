"""M81 (TASKS.md §11): due times, subtasks, repeating tasks and board columns."""

import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any, cast
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.modules.tasks import service as tasks
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_push_planner import add_device
from tests.test_tasks import (
    API,
    TASKS,
    _alarm,
    _channel,
    _create,
    _drain,
    _join,
    _move,
    _outbox,
    _patch,
    _relay,
    _task_pushes,
)

COLUMNS = f"{TASKS}/columns"
TOKYO = ZoneInfo("Asia/Tokyo")


async def _mine(client: AsyncClient) -> list[dict[str, Any]]:
    response = await client.get(f"{TASKS}/mine")
    assert response.status_code == 200, response.text
    return cast(list[dict[str, Any]], response.json())


async def _columns(client: AsyncClient, channel_id: str) -> list[dict[str, Any]]:
    response = await client.get(COLUMNS, params={"channel_id": channel_id})
    assert response.status_code == 200, response.text
    return cast(list[dict[str, Any]], response.json())


# --- due times -----------------------------------------------------------------------------------


async def test_due_time_is_kept_with_its_date_and_zone(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    # 23:30:45 UTC on the 9th is 8:30 on the 10th in Tokyo: due_on is Tokyo's date.
    made = await _create(
        client, {"title": "提出", "due_at": "2030-01-09T23:30:45Z", "tz": "Asia/Tokyo"}
    )
    assert made["due_on"] == "2030-01-10" and made["due_tz"] == "Asia/Tokyo"
    assert made["due_at"].startswith("2030-01-09T23:30:00")
    # due_on alone keeps the wall-clock time (an older device moving the date).
    moved = await _patch(client, made["id"], {"due_on": "2030-01-15"})
    assert moved["due_on"] == "2030-01-15" and moved["due_at"].startswith("2030-01-14T23:30:00")
    # due_at wins over due_on; the zone stays the task's when none is sent.
    both = await _patch(
        client, made["id"], {"due_on": "2031-01-01", "due_at": "2030-02-01T05:00:00+00:00"}
    )
    assert both["due_on"] == "2030-02-01" and both["due_at"].startswith("2030-02-01T05:00:00")
    # due_at: null drops the time, due_on: null everything.
    dated = await _patch(client, made["id"], {"due_at": None})
    assert dated["due_on"] == "2030-02-01" and dated["due_at"] is None and dated["due_tz"] is None
    timed = await _patch(client, made["id"], {"due_at": "2030-03-01T01:00:00Z"})
    assert timed["due_tz"] == "Asia/Tokyo"
    cleared = await _patch(client, made["id"], {"due_on": None})
    assert cleared["due_on"] is None and cleared["due_at"] is None and cleared["due_tz"] is None
    # A due time needs an offset.
    naive = await client.post(TASKS, json={"title": "x", "due_at": "2030-01-10T10:00:00"})
    assert naive.status_code == 422
    # The calendar finds it by its date.
    await _patch(client, made["id"], {"due_at": "2030-01-09T23:30:00Z"})
    due = await client.get(f"{TASKS}/due", params={"from": "2030-01-10", "to": "2030-01-11"})
    assert [t["id"] for t in due.json()] == [made["id"]]


async def test_a_timed_due_alarm_fires_at_its_time(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    await add_device(db, alice, token="alice-tok")
    as_user(alice)
    at = datetime(2030, 1, 10, 5, 0, tzinfo=UTC)  # 14:00 in Tokyo
    made = await _create(client, {"title": "締切", "due_at": at.isoformat(), "tz": "Asia/Tokyo"})
    row = await _alarm(app, made["id"], alice.id)
    assert row is not None and row.fire_at == at and row.status == "pending"
    async with app.state.db.session_factory() as worker:
        assert await tasks.fire_due(worker, now=at - timedelta(minutes=1)) == 0
        assert await tasks.fire_due(worker, now=at + timedelta(seconds=30)) == 1
    [event] = await _outbox(db, "task.due")
    assert event.payload["due_at"].startswith("2030-01-10T05:00:00")
    await _drain(_relay(app, test_settings))
    assert [p["body"] for p in await _task_pushes(db)] == ["14:00 が期限：締切"]

    # Moving the time re-arms it; dropping it goes back to 8:00 of the day.
    await _patch(client, made["id"], {"due_at": "2030-01-10T06:00:00Z"})
    row = await _alarm(app, made["id"], alice.id)
    assert row is not None and row.status == "pending"
    assert row.fire_at == datetime(2030, 1, 10, 6, 0, tzinfo=UTC)
    await _patch(client, made["id"], {"due_at": None})
    row = await _alarm(app, made["id"], alice.id)
    assert row is not None and row.fire_at == datetime(2030, 1, 9, 23, 0, tzinfo=UTC)


# --- subtasks ------------------------------------------------------------------------------------


async def test_subtasks_replace_and_toggle(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    made = await _create(
        client,
        {"title": "準備", "subtasks": [{"title": " 資料 "}, {"title": "会場", "done": True}]},
    )
    items = made["subtasks"]
    assert [(i["title"], i["done"]) for i in items] == [("資料", False), ("会場", True)]
    first, second = items[0]["id"], items[1]["id"]
    # The whole list: known ids stay, the rest are new, the order is the one sent.
    replaced = await _patch(
        client,
        made["id"],
        {
            "subtasks": [
                {"id": second, "title": "会場", "done": True},
                {"title": "ポスター"},
                {"id": str(uuid.uuid4()), "title": "知らない id"},
            ]
        },
    )
    ids = [i["id"] for i in replaced["subtasks"]]
    assert ids[0] == second and first not in ids and len(set(ids)) == 3
    # One item: its checkbox, its title.
    third = ids[1]
    toggled = await client.patch(f"{TASKS}/{made['id']}/subtasks/{third}", json={"done": True})
    assert toggled.status_code == 200, toggled.text
    assert [i["done"] for i in toggled.json()["subtasks"]] == [True, True, False]
    renamed = await client.patch(f"{TASKS}/{made['id']}/subtasks/{third}", json={"title": "掲示"})
    assert renamed.json()["subtasks"][1]["title"] == "掲示"
    gone = await client.patch(f"{TASKS}/{made['id']}/subtasks/{first}", json={"done": True})
    assert gone.status_code == 404 and gone.json()["error"]["code"] == "task_subtask_not_found"
    blank = await client.patch(f"{TASKS}/{made['id']}", json={"subtasks": [{"title": "  "}]})
    assert blank.status_code == 422
    many = [{"title": f"項目 {i}"} for i in range(51)]
    assert (await client.patch(f"{TASKS}/{made['id']}", json={"subtasks": many})).status_code == 422
    events = await _outbox(db, "task.updated")
    assert events[-1].payload["task"]["subtasks"][1]["title"] == "掲示"
    # Someone who cannot see the task cannot touch its items.
    as_user(bob)
    hidden = await client.patch(f"{TASKS}/{made['id']}/subtasks/{third}", json={"done": False})
    assert hidden.status_code == 404 and hidden.json()["error"]["code"] == "task_not_found"


# --- repeats -------------------------------------------------------------------------------------


async def test_completing_a_repeating_task_makes_the_next_once(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = await _channel(client, "lab")
    await _join(client, as_user, general["id"], bob)
    as_user(alice)
    made = await _create(
        client,
        {
            "channel_id": general["id"],
            "title": "週報",
            "notes": "先週の分",
            "due_on": "2030-01-07",  # a Monday
            "rrule": "freq=weekly;byday=MO",
            "assignee_ids": [str(bob.id)],
            "subtasks": [{"title": "まとめる", "done": True}],
        },
    )
    assert made["rrule"] == "FREQ=WEEKLY;BYDAY=MO"
    assigned_before = len(await _outbox(db, "task.assigned"))
    done = await _patch(client, made["id"], {"status": "done"})
    assert done["status"] == "done"
    board = (await client.get(TASKS, params={"channel_id": general["id"]})).json()
    nxt = [t for t in board if t["id"] != made["id"]]
    assert len(nxt) == 1
    [follow] = nxt
    assert follow["title"] == "週報" and follow["notes"] == "先週の分"
    assert follow["due_on"] == "2030-01-14" and follow["status"] == "todo"
    assert follow["rrule"] == "FREQ=WEEKLY;BYDAY=MO" and follow["kind"] == "task"
    assert follow["assignee_ids"] == [str(bob.id)] and follow["owner_id"] == str(alice.id)
    assert [(i["title"], i["done"]) for i in follow["subtasks"]] == [("まとめる", False)]
    assert follow["subtasks"][0]["id"] != made["subtasks"][0]["id"]
    assert follow["source"] is None and follow["column_id"] is None
    # No assignment push for the next occurrence; its assignee gets the due alarm.
    assert len(await _outbox(db, "task.assigned")) == assigned_before
    row = await _alarm(app, follow["id"], bob.id)
    assert row is not None and row.status == "pending"

    # Reopening and completing again makes no second one; deleting the next one ends it.
    await _patch(client, made["id"], {"status": "todo"})
    await _move(client, made["id"], {"status": "done"})
    board = (await client.get(TASKS, params={"channel_id": general["id"]})).json()
    assert len(board) == 2


async def test_repeat_rules_and_ends(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    # COUNT counts down; the last one makes nothing.
    made = await _create(
        client, {"title": "点検", "due_on": "2030-01-31", "rrule": "FREQ=MONTHLY;COUNT=2"}
    )
    await _patch(client, made["id"], {"status": "done"})
    [follow] = [t for t in await _mine(client) if t["status"] == "todo"]
    # The 31st: February has none, so March.
    assert follow["due_on"] == "2030-03-31" and follow["rrule"] == "FREQ=MONTHLY;COUNT=1"
    await _patch(client, follow["id"], {"status": "done"})
    assert [t for t in await _mine(client) if t["status"] == "todo"] == []

    # Missed occurrences are skipped: the next is today or later.
    past = await _create(client, {"title": "水やり", "due_on": "2020-01-01", "rrule": "FREQ=DAILY"})
    await _patch(client, past["id"], {"status": "done"})
    today = utcnow().astimezone(TOKYO).date()
    [again] = [t for t in await _mine(client) if t["status"] == "todo"]
    assert date.fromisoformat(again["due_on"]) == today

    # A timed repeat keeps its wall-clock time.
    timed = await _create(
        client,
        {
            "title": "会議の準備",
            "due_at": "2030-03-29T00:30:00Z",
            "tz": "Europe/Berlin",
            "rrule": "FREQ=WEEKLY",
        },
    )
    assert timed["due_on"] == "2030-03-29"  # 1:30 in Berlin (winter time)
    await _patch(client, timed["id"], {"status": "done"})
    [weekly] = [
        t for t in await _mine(client) if t["title"] == "会議の準備" and t["status"] == "todo"
    ]
    assert weekly["due_on"] == "2030-04-05"
    assert weekly["due_at"].startswith("2030-04-04T23:30:00")  # 1:30 in Berlin (summer time)

    # Refused: no due date, a rule outside the subset, a review request, dropping the due date.
    for body in (
        {"title": "x", "rrule": "FREQ=DAILY"},
        {"title": "x", "due_on": "2030-01-01", "rrule": "FREQ=HOURLY"},
    ):
        response = await client.post(TASKS, json=body)
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "task_invalid_rrule"
    response = await client.patch(f"{TASKS}/{weekly['id']}", json={"due_on": None})
    assert response.status_code == 400
    stopped = await _patch(client, weekly["id"], {"due_on": None, "rrule": None})
    assert stopped["rrule"] is None and stopped["due_on"] is None
    # Created already done: nothing follows.
    await _create(
        client,
        {"title": "済み", "status": "done", "due_on": "2030-01-01", "rrule": "FREQ=DAILY"},
    )
    assert [t for t in await _mine(client) if t["title"] == "済み" and t["status"] == "todo"] == []


# --- columns -------------------------------------------------------------------------------------


async def test_board_columns(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")  # not a member
    as_user(alice)
    general = await _channel(client, "board")
    gid = general["id"]
    other = await _channel(client, "other")
    await _join(client, as_user, gid, bob)
    as_user(alice)

    builtin = await _columns(client, gid)
    assert [(c["name"], c["status"], c["builtin"]) for c in builtin] == [
        ("未着手", "todo", True),
        ("進行中", "doing", True),
        ("完了", "done", True),
    ]
    assert builtin == await _columns(client, gid)  # stable ids without rows
    todo_col, doing_col, done_col = (c["id"] for c in builtin)

    # Add a "doing" column between 進行中 and 完了, and a second done column at the end.
    made = await client.post(
        COLUMNS,
        json={
            "channel_id": gid,
            "name": " レビュー 待ち ",
            "status": "doing",
            "after_id": doing_col,
        },
    )
    assert made.status_code == 201, made.text
    review = made.json()
    assert review["name"] == "レビュー 待ち" and review["builtin"] is False
    shelved = (
        await client.post(COLUMNS, json={"channel_id": gid, "name": "見送り", "status": "done"})
    ).json()
    order = [c["id"] for c in await _columns(client, gid)]
    assert order == [todo_col, doing_col, review["id"], done_col, shelved["id"]]
    assert (await _columns(client, gid))[0]["id"] == todo_col  # built-in ids kept once written

    # A card into the added column: its status is the column's.
    card = await _create(client, {"channel_id": gid, "title": "原稿"})
    moved = await _move(client, card["id"], {"column_id": review["id"]})
    assert moved["status"] == "doing" and moved["column_id"] == review["id"]
    other_card = await _create(client, {"channel_id": gid, "title": "図", "status": "doing"})
    # An older device reorders within what it shows as one 進行中 column: the column stays.
    reordered = await _move(client, card["id"], {"status": "doing", "before_id": other_card["id"]})
    assert reordered["column_id"] == review["id"]
    # status and column_id must agree; another board's column is refused.
    bad = await client.post(
        f"{TASKS}/{card['id']}/move", json={"status": "todo", "column_id": review["id"]}
    )
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "task_invalid_column"
    elsewhere = tasks.builtin_column_id(uuid.UUID(other["id"]), "todo")
    bad = await client.post(f"{TASKS}/{card['id']}/move", json={"column_id": str(elsewhere)})
    assert bad.status_code == 400
    assert (await client.post(f"{TASKS}/{card['id']}/move", json={})).status_code == 400

    # A done column completes; a built-in id works as a target too.
    shelved_card = await _move(client, other_card["id"], {"column_id": shelved["id"]})
    assert shelved_card["status"] == "done" and shelved_card["completed_at"] is not None
    back = await _move(client, other_card["id"], {"column_id": todo_col})
    assert back["status"] == "todo" and back["column_id"] is None and back["completed_at"] is None
    # PATCH status goes to the built-in column of that status.
    patched = await _patch(client, card["id"], {"status": "done"})
    assert patched["column_id"] is None
    await _move(client, card["id"], {"column_id": review["id"]})

    # Rename and move columns (built-in ones too); after_id null is the left end.
    renamed = await client.patch(f"{COLUMNS}/{todo_col}", json={"name": "やること"})
    assert renamed.status_code == 200 and renamed.json()["name"] == "やること"
    first = await client.patch(f"{COLUMNS}/{review['id']}", json={"after_id": None})
    assert first.status_code == 200
    order = [c["id"] for c in await _columns(client, gid)]
    assert order == [review["id"], todo_col, doing_col, done_col, shelved["id"]]
    bad = await client.patch(f"{COLUMNS}/{review['id']}", json={"after_id": str(uuid.uuid4())})
    assert bad.status_code == 400

    # Deleting an added column: its cards go to the built-in one of the same status.
    assert (await client.delete(f"{COLUMNS}/{done_col}")).status_code == 409
    assert (await client.delete(f"{COLUMNS}/{review['id']}")).status_code == 204
    board = (await client.get(TASKS, params={"channel_id": gid})).json()
    kept = next(t for t in board if t["id"] == card["id"])
    assert kept["status"] == "doing" and kept["column_id"] is None
    assert [c["id"] for c in await _columns(client, gid)] == [
        todo_col,
        doing_col,
        done_col,
        shelved["id"],
    ]
    events = await _outbox(db, "task.columns.updated")
    assert events and events[-1].payload["channel_id"] == gid
    assert len(events[-1].payload["columns"]) == 4

    # Others: a member may change columns; a non-member cannot see them; DMs have none.
    as_user(bob)
    assert (
        await client.patch(f"{COLUMNS}/{shelved['id']}", json={"name": "保留"})
    ).status_code == 200
    as_user(carol)
    assert (await client.get(COLUMNS, params={"channel_id": gid})).status_code == 403
    hidden = await client.patch(f"{COLUMNS}/{shelved['id']}", json={"name": "x"})
    assert hidden.status_code == 404 and hidden.json()["error"]["code"] == "task_column_not_found"
    assert (await client.patch(f"{COLUMNS}/{todo_col}", json={"name": "x"})).status_code == 404
    as_user(alice)
    dm = (await client.post(f"{API}/dms", json={"user_ids": [str(bob.id)]})).json()
    response = await client.get(COLUMNS, params={"channel_id": dm["id"]})
    assert response.status_code == 400

    # At most 20 columns.
    for i in range(16):
        response = await client.post(
            COLUMNS, json={"channel_id": gid, "name": f"列{i}", "status": "todo"}
        )
        assert response.status_code == 201, response.text
    full = await client.post(COLUMNS, json={"channel_id": gid, "name": "多すぎ", "status": "todo"})
    assert full.status_code == 409 and full.json()["error"]["code"] == "task_column_limit"


async def test_a_repeating_task_moved_into_a_done_column_repeats(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    general = await _channel(client, "repeat-board")
    gid = general["id"]
    shelved = (
        await client.post(COLUMNS, json={"channel_id": gid, "name": "済み", "status": "done"})
    ).json()
    made = await _create(
        client, {"channel_id": gid, "title": "掃除", "due_on": "2030-01-01", "rrule": "FREQ=DAILY"}
    )
    await _move(client, made["id"], {"column_id": shelved["id"]})
    board = (await client.get(TASKS, params={"channel_id": gid})).json()
    assert sorted(t["due_on"] for t in board) == ["2030-01-01", "2030-01-02"]
    # Between done columns nothing changes (no second occurrence).
    done_col = tasks.builtin_column_id(uuid.UUID(gid), "done")
    await _move(client, made["id"], {"column_id": str(done_col)})
    assert len((await client.get(TASKS, params={"channel_id": gid})).json()) == 2
