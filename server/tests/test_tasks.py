"""Tasks and kanban (M55, TASKS.md): the API, authorization, ordering, events, the leave handler,
assignment pushes and due-date alarms."""

import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from itertools import pairwise
from typing import Any, cast

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.events.outbox import OutboxRelay
from app.modules.calendar import service as calendar
from app.modules.channels import service as channels
from app.modules.notifications.planner import PushPlanner
from app.modules.tasks import service as tasks
from app.modules.tasks.models import TaskDueAlarm
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_outbox import RecordingBus
from tests.test_push_planner import add_device, deliveries

API = "/api/v1"
TASKS = f"{API}/tasks"
DUE = date(2030, 1, 10)
# 8:00 in Tokyo on DUE is 23:00 UTC the day before.
DUE_8_JST = datetime(2030, 1, 9, 23, 0, tzinfo=UTC)


async def _create(client: AsyncClient, body: dict[str, Any], status: int = 201) -> dict[str, Any]:
    response = await client.post(TASKS, json=body)
    assert response.status_code == status, response.text
    return cast(dict[str, Any], response.json())


async def _patch(
    client: AsyncClient, task_id: str, body: dict[str, Any], status: int = 200
) -> dict[str, Any]:
    response = await client.patch(f"{TASKS}/{task_id}", json=body)
    assert response.status_code == status, response.text
    return cast(dict[str, Any], response.json())


async def _move(
    client: AsyncClient, task_id: str, body: dict[str, Any], status: int = 200
) -> dict[str, Any]:
    response = await client.post(f"{TASKS}/{task_id}/move", json=body)
    assert response.status_code == status, response.text
    return cast(dict[str, Any], response.json())


async def _board(client: AsyncClient, channel_id: str, **params: str) -> list[dict[str, Any]]:
    response = await client.get(TASKS, params={"channel_id": channel_id, **params})
    assert response.status_code == 200, response.text
    return cast(list[dict[str, Any]], response.json())


def _column(rows: list[dict[str, Any]], status: str) -> list[str]:
    return [t["title"] for t in rows if t["status"] == status]


async def _channel(client: AsyncClient, name: str, **extra: Any) -> dict[str, Any]:
    response = await client.post(f"{API}/channels", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return cast(dict[str, Any], response.json())


async def _join(
    client: AsyncClient, as_user: Callable[[User], None], channel: str, *who: User
) -> None:
    for user in who:
        as_user(user)
        assert (await client.post(f"{API}/channels/{channel}/join")).status_code == 200


async def _post(client: AsyncClient, channel_id: str, body: str) -> dict[str, Any]:
    response = await client.post(
        f"{API}/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body},
    )
    assert response.status_code in (200, 201), response.text
    return cast(dict[str, Any], response.json())


async def _outbox(db: AsyncSession, event_type: str) -> list[OutboxEvent]:
    stmt = select(OutboxEvent).where(OutboxEvent.event_type == event_type).order_by(OutboxEvent.id)
    return list((await db.execute(stmt)).scalars().all())


async def _alarm(app: FastAPI, task_id: str, user_id: uuid.UUID) -> TaskDueAlarm | None:
    async with app.state.db.session_factory() as session:
        row: TaskDueAlarm | None = await session.get(TaskDueAlarm, (uuid.UUID(task_id), user_id))
        return row


def _relay(app: FastAPI, settings: Settings, active: set[uuid.UUID] | None = None) -> OutboxRelay:
    planner = PushPlanner(settings, is_active=lambda uid: uid in (active or set()))
    return OutboxRelay(
        app.state.db,
        RecordingBus(),
        channels.resolve_event_audience,
        handlers=[
            planner,
            calendar.CalendarLeaveHandler(),
            tasks.TaskLeaveHandler(),
            tasks.TaskSourceHandler(),
        ],
    )


async def _drain(relay: OutboxRelay) -> None:
    while await relay.process_batch():
        pass


async def _task_pushes(db: AsyncSession) -> list[dict[str, Any]]:
    return [r.payload for r in await deliveries(db) if r.payload.get("kind") == "task"]


# --- the API -------------------------------------------------------------------------------------


async def test_personal_tasks_crud_and_validation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    key = str(uuid.uuid4())
    body = {"title": "  論文を  読む ", "notes": " 3 章まで \r\n", "client_task_id": key}
    made = await _create(client, body)
    assert made["title"] == "論文を 読む" and made["notes"] == "3 章まで"
    assert made["channel_id"] is None and made["channel_name"] is None
    assert made["owner_id"] == str(alice.id) and made["status"] == "todo"
    assert made["assignee_ids"] == [] and made["source"] is None and made["can_delete"] is True
    # A retry with the same key returns the same task (200), not a second one.
    again = await _create(client, body, status=200)
    assert again["id"] == made["id"]
    assert (await client.get(f"{TASKS}/{made['id']}")).json()["title"] == "論文を 読む"

    done = await _patch(client, made["id"], {"status": "done", "due_on": "2030-01-10"})
    assert done["status"] == "done" and done["completed_by"] == str(alice.id)
    assert done["completed_at"] is not None and done["due_on"] == "2030-01-10"
    back = await _patch(client, made["id"], {"status": "todo", "due_on": None, "notes": " "})
    assert back["completed_at"] is None and back["completed_by"] is None
    assert back["due_on"] is None and back["notes"] is None

    # A personal task has no assignees; blank or long titles are refused.
    me = [str(alice.id)]
    bad = await client.post(TASKS, json={"title": "x", "assignee_ids": me})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "task_invalid_assignee"
    bad = await client.patch(f"{TASKS}/{made['id']}", json={"assignee_ids": me})
    assert bad.status_code == 400
    assert (await client.post(TASKS, json={"title": "   "})).status_code == 422
    assert (await client.post(TASKS, json={"title": "x" * 201})).status_code == 422
    assert (await client.post(TASKS, json={"title": "x", "channel": "y"})).status_code == 422
    assert (await client.patch(f"{TASKS}/{made['id']}", json={"title": None})).status_code == 400

    # Someone else cannot tell it exists.
    as_user(bob)
    for call in (
        client.get(f"{TASKS}/{made['id']}"),
        client.patch(f"{TASKS}/{made['id']}", json={"title": "mine"}),
        client.post(f"{TASKS}/{made['id']}/move", json={"status": "doing"}),
        client.delete(f"{TASKS}/{made['id']}"),
    ):
        response = await call
        assert response.status_code == 404 and response.json()["error"]["code"] == "task_not_found"
    assert (await client.get(f"{TASKS}/mine")).json() == []

    as_user(alice)
    assert [t["id"] for t in (await client.get(f"{TASKS}/mine")).json()] == [made["id"]]
    assert (await client.delete(f"{TASKS}/{made['id']}")).status_code == 204
    assert (await client.get(f"{TASKS}/{made['id']}")).status_code == 404
    assert (await client.get(f"{TASKS}/mine")).json() == []
    # A retry of a creation whose task was deleted since: 404, not a second task.
    assert (await client.post(TASKS, json=body)).status_code == 404


async def test_board_authorization(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")  # the channel's owner
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")  # not a member
    dave = await make_user(db, "dave", role="admin")
    erin = await make_user(db, "erin")
    as_user(alice)
    general = await _channel(client, "general")
    gid = general["id"]
    await _join(client, as_user, gid, bob, dave, erin)

    as_user(bob)
    task = await _create(client, {"channel_id": gid, "title": "発表練習"})
    assert task["channel_name"] == "general" and task["can_delete"] is True
    assigned = await _create(
        client, {"channel_id": gid, "title": "資料", "assignee_ids": [str(erin.id)]}
    )
    assert assigned["assignee_ids"] == [str(erin.id)]

    # Not a member: no board, no task (404), no creating.
    as_user(carol)
    listed = await client.get(TASKS, params={"channel_id": gid})
    assert listed.status_code == 403 and listed.json()["error"]["code"] == "not_a_member"
    assert (await client.get(f"{TASKS}/{task['id']}")).status_code == 404
    assert (await client.patch(f"{TASKS}/{task['id']}", json={"title": "x"})).status_code == 404
    assert (await client.delete(f"{TASKS}/{task['id']}")).status_code == 404
    refused = await client.post(TASKS, json={"channel_id": gid, "title": "x"})
    assert refused.status_code == 403
    assert (
        await client.get(f"{TASKS}/due", params={"from": "2030-01-01", "to": "2030-02-01"})
    ).json() == []

    # Any member who may post changes and moves; deleting is for the creator, the assignees, the
    # channel's owners and administrators.
    as_user(erin)
    assert (await _patch(client, task["id"], {"title": "発表練習 2"}))["can_delete"] is False
    assert (await _move(client, task["id"], {"status": "doing"}))["status"] == "doing"
    no = await client.delete(f"{TASKS}/{task['id']}")
    assert no.status_code == 403 and no.json()["error"]["code"] == "task_delete_restricted"
    board = {t["title"]: t for t in await _board(client, gid)}
    assert board["資料"]["can_delete"] is True and board["発表練習 2"]["can_delete"] is False
    assert (await client.delete(f"{TASKS}/{assigned['id']}")).status_code == 204
    as_user(alice)
    assert (await client.get(f"{TASKS}/{task['id']}")).json()["can_delete"] is True
    as_user(dave)
    assert (await client.get(f"{TASKS}/{task['id']}")).json()["can_delete"] is True

    # Owners-only posting: members read, only owners and administrators change.
    as_user(alice)
    await client.patch(f"{API}/channels/{gid}", json={"posting_policy": "owners"})
    as_user(bob)
    refused = await client.patch(f"{TASKS}/{task['id']}", json={"title": "x"})
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "posting_restricted"
    assert (await client.post(TASKS, json={"channel_id": gid, "title": "x"})).status_code == 403
    assert (
        await client.post(f"{TASKS}/{task['id']}/move", json={"status": "done"})
    ).status_code == 403
    as_user(dave)
    assert (await _move(client, task["id"], {"status": "done"}))["status"] == "done"

    # Archived: readable, nothing changes, nobody deletes.
    as_user(alice)
    await client.patch(f"{API}/channels/{gid}", json={"posting_policy": "everyone"})
    await client.post(f"{API}/channels/{gid}/archive")
    as_user(bob)
    rows = await _board(client, gid)
    assert [t["title"] for t in rows] == ["発表練習 2"] and rows[0]["can_delete"] is False
    archived = await client.patch(f"{TASKS}/{task['id']}", json={"title": "x"})
    assert archived.status_code == 409 and archived.json()["error"]["code"] == "channel_archived"
    assert (await client.delete(f"{TASKS}/{task['id']}")).status_code == 409


async def test_dms_and_source_messages(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    dm = (await client.post(f"{API}/dms", json={"user_ids": [str(bob.id)]})).json()
    general = await _channel(client, "general")
    secret = await _channel(client, "secret", type="private")
    other = await _channel(client, "other")
    await _join(client, as_user, general["id"], bob)

    # A DM has no board.
    as_user(bob)
    no_board = await client.post(TASKS, json={"channel_id": dm["id"], "title": "x"})
    assert no_board.status_code == 400
    assert no_board.json()["error"]["code"] == "task_channel_unsupported"
    listed = await client.get(TASKS, params={"channel_id": dm["id"]})
    assert listed.status_code == 400

    # From a DM message: a personal task, with a one-line excerpt (names, no markdown).
    as_user(alice)
    in_dm = await _post(client, dm["id"], f"<@{bob.id}> **締切**は\n金曜です")
    as_user(bob)
    personal = await _create(client, {"title": "締切", "source_message_id": in_dm["id"]})
    assert personal["channel_id"] is None
    assert personal["source"] == {
        "message_id": in_dm["id"],
        "channel_id": dm["id"],
        "excerpt": "@Bob 締切は 金曜です",
    }

    # A board's task comes from a message of its own channel only.
    as_user(alice)
    in_general = await _post(client, general["id"], "ポスターを印刷")
    in_other = await _post(client, other["id"], "elsewhere")
    in_secret = await _post(client, secret["id"], "hidden")
    as_user(bob)
    shared = await _create(
        client,
        {"channel_id": general["id"], "title": "印刷", "source_message_id": in_general["id"]},
    )
    assert shared["source"]["channel_id"] == general["id"]
    mismatch = await client.post(
        TASKS,
        json={"channel_id": general["id"], "title": "x", "source_message_id": in_other["id"]},
    )
    assert mismatch.status_code == 400
    assert mismatch.json()["error"]["code"] == "task_invalid_source"
    # A public channel's message I can read: a personal task is fine.
    readable = await _create(client, {"title": "x", "source_message_id": in_other["id"]})
    assert readable["source"]["excerpt"] == "elsewhere"
    # A private channel's message I cannot see: 404, as for the message itself.
    hidden = await client.post(TASKS, json={"title": "x", "source_message_id": in_secret["id"]})
    assert hidden.status_code == 404 and hidden.json()["error"]["code"] == "message_not_found"
    as_user(carol)
    no_dm = await client.post(TASKS, json={"title": "x", "source_message_id": in_dm["id"]})
    assert no_dm.status_code == 404

    # The message is edited: the excerpt follows (and the board hears of it).
    await _drain(_relay(app, test_settings))
    before = len(await _outbox(db, "task.updated"))
    as_user(alice)
    edited = await client.patch(f"{API}/messages/{in_general['id']}", json={"body": "A3 で印刷"})
    assert edited.status_code == 200, edited.text
    await _drain(_relay(app, test_settings))
    as_user(bob)
    assert (await client.get(f"{TASKS}/{shared['id']}")).json()["source"]["excerpt"] == "A3 で印刷"
    assert len(await _outbox(db, "task.updated")) == before + 1
    # Deleted: the task stays; the link and the text go (no copy of a deleted body is kept).
    as_user(alice)
    assert (await client.delete(f"{API}/messages/{in_general['id']}")).status_code == 200
    gone = await client.post(TASKS, json={"title": "x", "source_message_id": in_general["id"]})
    assert gone.status_code == 404
    await _drain(_relay(app, test_settings))
    as_user(bob)
    kept = (await client.get(f"{TASKS}/{shared['id']}")).json()
    assert kept["title"] == "印刷"
    assert kept["source"] == {"message_id": None, "channel_id": general["id"], "excerpt": None}
    # A personal task whose owner left the private channel: the link stays, no fresh text.
    as_user(alice)
    added = await client.post(
        f"{API}/channels/{secret['id']}/members", json={"user_id": str(bob.id)}
    )
    assert added.status_code in (200, 201), added.text
    as_user(bob)
    from_secret = await _create(client, {"title": "secret", "source_message_id": in_secret["id"]})
    assert from_secret["source"]["excerpt"] == "hidden"
    assert (await client.post(f"{API}/channels/{secret['id']}/leave")).status_code == 204
    as_user(alice)
    await client.patch(f"{API}/messages/{in_secret['id']}", json={"body": "new secret"})
    await _drain(_relay(app, test_settings))
    as_user(bob)
    left = (await client.get(f"{TASKS}/{from_secret['id']}")).json()
    assert left["source"]["message_id"] == in_secret["id"] and left["source"]["excerpt"] is None


async def test_assignees_must_be_members(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    general = await _channel(client, "general")
    await _join(client, as_user, general["id"], bob)
    as_user(alice)
    refused = await client.post(
        TASKS,
        json={"channel_id": general["id"], "title": "x", "assignee_ids": [str(carol.id)]},
    )
    assert refused.status_code == 400
    assert refused.json()["error"]["details"] == {"user_ids": [str(carol.id)]}
    made = await _create(
        client,
        {
            "channel_id": general["id"],
            "title": "x",
            "assignee_ids": [str(bob.id), str(alice.id), str(bob.id)],
        },
    )
    assert made["assignee_ids"] == [str(bob.id), str(alice.id)]
    # PATCH replaces the whole list.
    assert (await _patch(client, made["id"], {"assignee_ids": [str(alice.id)]}))[
        "assignee_ids"
    ] == [str(alice.id)]
    assert (await _patch(client, made["id"], {"assignee_ids": []}))["assignee_ids"] == []
    bad = await client.patch(f"{TASKS}/{made['id']}", json={"assignee_ids": [str(carol.id)]})
    assert bad.status_code == 400


async def test_move_and_order(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    general = await _channel(client, "general")
    gid = general["id"]
    a, b, c = [await _create(client, {"channel_id": gid, "title": t}) for t in "abc"]
    assert a["position"] < b["position"] < c["position"]  # new cards go to the bottom
    assert _column(await _board(client, gid), "todo") == ["a", "b", "c"]

    # Up to the top (before a), then between a and b (after a).
    await _move(client, c["id"], {"status": "todo", "before_id": a["id"]})
    assert _column(await _board(client, gid), "todo") == ["c", "a", "b"]
    await _move(client, c["id"], {"status": "todo", "after_id": a["id"], "before_id": b["id"]})
    assert _column(await _board(client, gid), "todo") == ["a", "c", "b"]
    # To another column (empty), then below a card there; neither: the bottom.
    await _move(client, b["id"], {"status": "doing"})
    await _move(client, a["id"], {"status": "doing", "after_id": b["id"]})
    rows = await _board(client, gid)
    assert _column(rows, "todo") == ["c"] and _column(rows, "doing") == ["b", "a"]
    # A neighbour no longer in that column is ignored (the default place).
    await _move(client, c["id"], {"status": "doing", "before_id": str(uuid.uuid4())})
    assert _column(await _board(client, gid), "doing") == ["b", "a", "c"]

    # Done: completed and on top (newest first), by move or by PATCH.
    await _move(client, a["id"], {"status": "done"})
    done = await _patch(client, b["id"], {"status": "done"})
    assert done["completed_at"] is not None
    rows = await _board(client, gid)
    assert _column(rows, "done") == ["b", "a"] and _column(rows, "doing") == ["c"]
    back = await _move(client, a["id"], {"status": "todo", "before_id": c["id"]})
    assert back["completed_at"] is None and back["status"] == "todo"


async def test_a_column_is_renumbered_when_the_gap_runs_out(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    first = await _create(client, {"title": "first"})
    last = await _create(client, {"title": "last"})
    lo = first["id"]
    titles = ["first", "last"]
    # Keep putting a new card just below `first`: the gap halves each time.
    for n in range(45):
        card = await _create(client, {"title": f"n{n}"})
        await _move(client, card["id"], {"status": "todo", "after_id": lo})
        titles.insert(1, f"n{n}")
    rows = (await client.get(f"{TASKS}/mine")).json()
    assert [t["title"] for t in rows] == titles
    positions = [t["position"] for t in rows]
    assert positions == sorted(positions) and len(set(positions)) == len(positions)
    # Halving 1024 runs out after about 30 cards: the column was renumbered on the way (which
    # announced `last`, never moved itself, with its new position).
    assert min(b - a for a, b in pairwise(positions)) > tasks.MIN_GAP
    updated = [
        e.payload["task"]["position"]
        for e in await _outbox(db, "task.updated")
        if e.payload["task"]["id"] == last["id"]
    ]
    assert len(updated) == 2 and updated[1] != updated[0] and updated[1] == positions[-1]


async def test_open_task_limit(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    monkeypatch.setattr(tasks, "MAX_OPEN_PER_BOARD", 2)
    one = await _create(client, {"title": "1"})
    await _create(client, {"title": "2"})
    full = await client.post(TASKS, json={"title": "3"})
    assert full.status_code == 409 and full.json()["error"]["code"] == "task_limit_reached"
    await _create(client, {"title": "done", "status": "done"})  # completed ones do not count
    await _patch(client, one["id"], {"status": "done"})
    await _create(client, {"title": "3"})
    reopen = await client.patch(f"{TASKS}/{one['id']}", json={"status": "todo"})
    assert reopen.status_code == 409


# --- events --------------------------------------------------------------------------------------


async def test_events_and_audiences(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol", role="admin")
    erin = await make_user(db, "erin")
    as_user(alice)
    general = await _channel(client, "general")
    await _join(client, as_user, general["id"], bob, carol, erin)

    as_user(bob)
    shared = await _create(
        client,
        {
            "channel_id": general["id"],
            "title": "ゼミ準備",
            "assignee_ids": [str(bob.id), str(erin.id)],
        },
    )
    personal = await _create(client, {"title": "mine"})
    await _patch(client, shared["id"], {"title": "ゼミ準備!"})
    await client.delete(f"{TASKS}/{personal['id']}")

    updated = await _outbox(db, "task.updated")
    assert [e.payload["task"]["title"] for e in updated] == ["ゼミ準備", "mine", "ゼミ準備!"]
    first = updated[0]
    assert first.audience_type == "channel" and first.channel_id == uuid.UUID(general["id"])
    assert first.seq is None and "can_delete" not in first.payload["task"]
    # The creator, the assignees, the owner (alice) and the administrator among the members.
    assert set(first.payload["deleter_ids"]) == {str(u.id) for u in (alice, bob, carol, erin)}
    audience = await channels.resolve_event_audience(db, first)
    assert set(audience.ids) == {alice.id, bob.id, carol.id, erin.id}
    mine = updated[1]
    assert mine.audience_type == "user" and mine.audience_id == bob.id
    assert mine.channel_id is None and mine.payload["deleter_ids"] == [str(bob.id)]

    deleted = await _outbox(db, "task.deleted")
    assert len(deleted) == 1 and deleted[0].payload == {"id": personal["id"], "channel_id": None}
    assert deleted[0].audience_type == "user" and deleted[0].audience_id == bob.id

    # Assigned: erin only (bob added himself).
    assigned = await _outbox(db, "task.assigned")
    assert len(assigned) == 1 and assigned[0].audience_id == erin.id
    assert assigned[0].payload == {
        "kind": "task",
        "task_id": shared["id"],
        "channel_id": general["id"],
        "channel_name": "general",
        "title": "ゼミ準備",
        "by_user_id": str(bob.id),
    }
    # Adding alice later announces her only; a title change announces nobody.
    await _patch(client, shared["id"], {"assignee_ids": [str(bob.id), str(erin.id), str(alice.id)]})
    assigned = await _outbox(db, "task.assigned")
    assert [e.audience_id for e in assigned] == [erin.id, alice.id]


async def test_leaving_a_channel_unassigns_and_cancels_alarms(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    general = await _channel(client, "general")
    await _join(client, as_user, general["id"], bob, carol)
    as_user(alice)
    task = await _create(
        client,
        {
            "channel_id": general["id"],
            "title": "x",
            "due_on": DUE.isoformat(),
            "assignee_ids": [str(bob.id), str(carol.id)],
        },
    )
    assert (await _alarm(app, task["id"], bob.id)) is not None
    await _drain(_relay(app, test_settings))

    as_user(bob)
    assert (await client.post(f"{API}/channels/{general['id']}/leave")).status_code == 204
    before = len(await _outbox(db, "task.updated"))
    await _drain(_relay(app, test_settings))
    as_user(alice)
    assert (await client.get(f"{TASKS}/{task['id']}")).json()["assignee_ids"] == [str(carol.id)]
    row = await _alarm(app, task["id"], bob.id)
    assert row is not None and row.status == "cancelled"
    last = (await _outbox(db, "task.updated"))[before:]
    assert len(last) == 1 and last[0].payload["task"]["assignee_ids"] == [str(carol.id)]
    # Processing the same event again changes nothing more.
    await _drain(_relay(app, test_settings))
    assert len(await _outbox(db, "task.updated")) == before + 1

    # Carol is removed, the handler has not run yet: the worker still does not notify her.
    removed = await client.delete(f"{API}/channels/{general['id']}/members/{carol.id}")
    assert removed.status_code == 204
    async with app.state.db.session_factory() as worker:
        assert await tasks.fire_due(worker, now=DUE_8_JST + timedelta(minutes=1)) == 0
    row = await _alarm(app, task["id"], carol.id)
    assert row is not None and row.status == "cancelled"


# --- notifications -------------------------------------------------------------------------------


async def test_assignment_push(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    await add_device(db, alice, token="alice-tok")
    as_user(alice)
    general = await _channel(client, "m2-進捗")
    await _join(client, as_user, general["id"], bob)
    as_user(alice)
    task = await _create(
        client, {"channel_id": general["id"], "title": "ポスター", "assignee_ids": [str(bob.id)]}
    )
    await _drain(_relay(app, test_settings))
    pushes = await _task_pushes(db)
    assert len(pushes) == 1
    push = pushes[0]
    assert push["title"] == "タスク" and push["kind"] == "task"
    assert push["body"] == "Alice がタスクを割り当てました: ポスター (#m2-進捗)"
    assert push["task_id"] == task["id"] and push["channel_id"] == general["id"]
    assert push["collapse_key"] == f"task:{task['id']}"
    # Re-processing plans nothing more.
    await _drain(_relay(app, test_settings))
    assert len(await _task_pushes(db)) == 1

    # Assigning myself: no push.
    as_user(bob)
    await _create(
        client, {"channel_id": general["id"], "title": "self", "assignee_ids": [str(bob.id)]}
    )
    await _drain(_relay(app, test_settings))
    assert len(await _task_pushes(db)) == 1

    # Turned off; muted channel; DND; looking at another device: no push.
    as_user(alice)
    assignee = [str(bob.id)]
    bob.notify_tasks = False
    await db.commit()
    await _create(client, {"channel_id": general["id"], "title": "off", "assignee_ids": assignee})
    await _drain(_relay(app, test_settings))
    bob.notify_tasks = True
    await db.commit()
    as_user(bob)
    await client.put(
        f"{API}/channels/{general['id']}/notification-preference",
        json={"level": None, "muted": True},
    )
    as_user(alice)
    await _create(client, {"channel_id": general["id"], "title": "muted", "assignee_ids": assignee})
    await _drain(_relay(app, test_settings))
    as_user(bob)
    await client.put(
        f"{API}/channels/{general['id']}/notification-preference",
        json={"level": None, "muted": False},
    )
    bob.dnd_until = utcnow() + timedelta(hours=1)
    await db.commit()
    as_user(alice)
    await _create(client, {"channel_id": general["id"], "title": "dnd", "assignee_ids": assignee})
    await _drain(_relay(app, test_settings))
    bob.dnd_until = None
    await db.commit()
    await _create(client, {"channel_id": general["id"], "title": "busy", "assignee_ids": assignee})
    await _drain(_relay(app, test_settings, active={bob.id}))
    # Completed before the push was planned: dropped.
    late = await _create(
        client, {"channel_id": general["id"], "title": "late", "assignee_ids": assignee}
    )
    await _patch(client, late["id"], {"status": "done"})
    await _drain(_relay(app, test_settings))
    assert len(await _task_pushes(db)) == 1


async def test_due_alarms_are_computed_and_follow_changes(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    carol.quiet_hours_start, carol.quiet_hours_end = 0, 0
    carol.quiet_hours_tz = "America/New_York"
    await db.commit()
    as_user(alice)
    general = await _channel(client, "general")
    await _join(client, as_user, general["id"], bob, carol)

    # Personal: the owner, at 8:00 in the device's zone.
    as_user(alice)
    mine = await _create(client, {"title": "mine", "due_on": "2030-01-10", "tz": "Asia/Tokyo"})
    row = await _alarm(app, mine["id"], alice.id)
    assert row is not None and row.fire_at == DUE_8_JST and row.status == "pending"
    # Shared: the assignees only; the actor's zone is the device's, others' their quiet-hours
    # zone, else Asia/Tokyo.
    shared = await _create(
        client,
        {
            "channel_id": general["id"],
            "title": "shared",
            "due_on": "2030-01-10",
            "tz": "Europe/London",
            "assignee_ids": [str(alice.id), str(bob.id), str(carol.id)],
        },
    )
    sid = shared["id"]
    found = {u.username: await _alarm(app, sid, u.id) for u in (alice, bob, carol)}
    zones = {name: (row.tz, row.fire_at) for name, row in found.items() if row is not None}
    assert zones == {
        "alice": ("Europe/London", datetime(2030, 1, 10, 8, 0, tzinfo=UTC)),
        "bob": ("Asia/Tokyo", DUE_8_JST),
        "carol": ("America/New_York", datetime(2030, 1, 10, 13, 0, tzinfo=UTC)),
    }
    no_due = await _create(client, {"channel_id": general["id"], "title": "no due"})
    assert await _alarm(app, no_due["id"], alice.id) is None

    # The due date moves: every alarm follows (each in its own zone).
    await _patch(client, sid, {"due_on": "2030-01-11"})
    bob_row = await _alarm(app, sid, bob.id)
    assert bob_row is not None and bob_row.fire_at == DUE_8_JST + timedelta(days=1)
    # Unassigned: cancelled; done: all cancelled; reopened: pending again.
    await _patch(client, sid, {"assignee_ids": [str(alice.id), str(carol.id)]})
    bob_row = await _alarm(app, sid, bob.id)
    assert bob_row is not None and bob_row.status == "cancelled"
    await _move(client, sid, {"status": "done"})
    statuses = {(await _alarm(app, sid, u.id)).status for u in (alice, carol)}  # type: ignore[union-attr]
    assert statuses == {"cancelled"}
    await _move(client, sid, {"status": "doing"})
    statuses = {(await _alarm(app, sid, u.id)).status for u in (alice, carol)}  # type: ignore[union-attr]
    assert statuses == {"pending"}
    # Cleared: cancelled. A date already past 8:00: not sent.
    await _patch(client, sid, {"due_on": None})
    alice_row = await _alarm(app, sid, alice.id)
    assert alice_row is not None and alice_row.status == "cancelled"
    yesterday = (utcnow() - timedelta(days=1)).date().isoformat()
    await _patch(client, sid, {"due_on": yesterday})
    alice_row = await _alarm(app, sid, alice.id)
    assert alice_row is not None and alice_row.status == "cancelled"
    # Deleted: cancelled.
    await client.delete(f"{TASKS}/{mine['id']}")
    row = await _alarm(app, mine["id"], alice.id)
    assert row is not None and row.status == "cancelled"


async def test_due_alarms_fire_once_and_push(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, alice, token="alice-tok")
    await add_device(db, bob)
    as_user(alice)
    general = await _channel(client, "m2-進捗")
    await _join(client, as_user, general["id"], bob)
    as_user(alice)
    shared = await _create(
        client,
        {
            "channel_id": general["id"],
            "title": "ポスター",
            "due_on": DUE.isoformat(),
            "assignee_ids": [str(bob.id)],
        },
    )
    await _create(client, {"title": "原稿", "due_on": DUE.isoformat()})
    await _drain(_relay(app, test_settings))
    assigned = len(await _task_pushes(db))  # bob's assignment push

    async with app.state.db.session_factory() as worker:
        assert await tasks.fire_due(worker, now=DUE_8_JST - timedelta(minutes=1)) == 0
        assert await tasks.fire_due(worker, now=DUE_8_JST + timedelta(minutes=1)) == 2
        assert await tasks.fire_due(worker, now=DUE_8_JST + timedelta(minutes=2)) == 0
    events = await _outbox(db, "task.due")
    assert {e.audience_id for e in events} == {alice.id, bob.id}
    await _drain(_relay(app, test_settings))
    pushes = (await _task_pushes(db))[assigned:]
    assert {p["body"] for p in pushes} == {"今日が期限: ポスター (#m2-進捗)", "今日が期限: 原稿"}
    by_body = {p["body"]: p for p in pushes}
    assert by_body["今日が期限: 原稿"]["channel_id"] is None
    assert by_body["今日が期限: ポスター (#m2-進捗)"]["task_id"] == shared["id"]
    await _drain(_relay(app, test_settings))
    assert len(await _task_pushes(db)) == assigned + 2

    # A change that leaves the time alone does not send it again.
    await _patch(client, shared["id"], {"title": "ポスター 2", "status": "doing"})
    row = await _alarm(app, shared["id"], bob.id)
    assert row is not None and row.status == "fired"
    async with app.state.db.session_factory() as worker:
        assert await tasks.fire_due(worker, now=DUE_8_JST + timedelta(hours=1)) == 0


async def test_due_alarms_respect_dnd_settings_and_archive(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, alice, token="alice-tok")
    await add_device(db, bob)
    as_user(alice)
    general = await _channel(client, "general")
    archived = await _channel(client, "old")
    await _join(client, as_user, general["id"], bob)
    as_user(alice)
    due = DUE.isoformat()
    await _create(client, {"title": "dnd", "due_on": due})
    await _create(
        client,
        {"channel_id": general["id"], "title": "off", "due_on": due, "assignee_ids": [str(bob.id)]},
    )
    old = await _create(
        client,
        {
            "channel_id": archived["id"],
            "title": "old",
            "due_on": due,
            "assignee_ids": [str(alice.id)],
        },
    )
    await client.post(f"{API}/channels/{archived['id']}/archive")
    alice.dnd_until = DUE_8_JST + timedelta(hours=1)
    bob.notify_tasks = False
    await db.commit()
    await _drain(_relay(app, test_settings))
    before = len(await deliveries(db))
    async with app.state.db.session_factory() as worker:
        # Alice's personal task and bob's shared one fire (the event reaches the open apps);
        # the archived channel's is dropped.
        assert await tasks.fire_due(worker, now=DUE_8_JST + timedelta(minutes=1)) == 2
    await _drain(_relay(app, test_settings))
    assert len(await deliveries(db)) == before  # DND and notify_tasks off: no push
    row = await _alarm(app, old["id"], alice.id)
    assert row is not None and row.status == "cancelled"


# --- lists ---------------------------------------------------------------------------------------


async def test_mine_and_due_lists(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = await _channel(client, "general")
    left = await _channel(client, "left")
    await _join(client, as_user, general["id"], bob)
    await _join(client, as_user, left["id"], bob)

    as_user(bob)
    personal = await _create(client, {"title": "p", "due_on": "2030-01-10"})
    mine_shared = await _create(
        client,
        {
            "channel_id": general["id"],
            "title": "mine",
            "due_on": "2030-01-12",
            "assignee_ids": [str(bob.id)],
        },
    )
    others = await _create(
        client,
        {
            "channel_id": general["id"],
            "title": "others",
            "due_on": "2030-01-11",
            "assignee_ids": [str(alice.id)],
        },
    )
    in_left = await _create(
        client,
        {
            "channel_id": left["id"],
            "title": "in left",
            "due_on": "2030-01-10",
            "assignee_ids": [str(bob.id)],
        },
    )
    assert (await client.post(f"{API}/channels/{left['id']}/leave")).status_code == 204

    mine = (await client.get(f"{TASKS}/mine")).json()
    assert [t["id"] for t in mine] == [personal["id"], mine_shared["id"]]
    assert mine[1]["channel_name"] == "general"

    due = await client.get(f"{TASKS}/due", params={"from": "2030-01-10", "to": "2030-01-12"})
    assert due.status_code == 200
    assert [t["id"] for t in due.json()] == [personal["id"], others["id"]]
    wider = await client.get(f"{TASKS}/due", params={"from": "2030-01-01", "to": "2030-02-01"})
    assert {t["id"] for t in wider.json()} == {personal["id"], others["id"], mine_shared["id"]}
    assert in_left["id"] not in {t["id"] for t in wider.json()}
    # Completed ones stay on the calendar.
    await _patch(client, others["id"], {"status": "done"})
    wider = await client.get(f"{TASKS}/due", params={"from": "2030-01-01", "to": "2030-02-01"})
    assert len(wider.json()) == 3
    for params in (
        {"from": "2030-01-10", "to": "2030-01-10"},
        {"from": "2030-01-01", "to": "2030-05-01"},
    ):
        bad = await client.get(f"{TASKS}/due", params=params)
        assert bad.status_code == 400 and bad.json()["error"]["code"] == "task_invalid_range"

    # Of the completed ones, /tasks/mine keeps the 50 most recent.
    for n in range(52):
        await _create(client, {"title": f"done {n}", "status": "done"})
    mine = (await client.get(f"{TASKS}/mine")).json()
    done = [t for t in mine if t["status"] == "done"]
    assert len(done) == 50 and "done 0" not in {t["title"] for t in done}
    assert len([t for t in mine if t["status"] != "done"]) == 2


async def test_board_keeps_the_recent_done(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    general = await _channel(client, "general")
    monkeypatch.setattr(tasks, "BOARD_DONE_LIMIT", 2)
    for n in range(3):
        await _create(client, {"channel_id": general["id"], "title": f"d{n}", "status": "done"})
    await _create(client, {"channel_id": general["id"], "title": "open"})
    rows = await _board(client, general["id"])
    assert _column(rows, "done") == ["d2", "d1"] and _column(rows, "todo") == ["open"]
    everything = await _board(client, general["id"], include_done="all")
    assert _column(everything, "done") == ["d2", "d1", "d0"]


async def test_notify_tasks_setting(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    assert (await client.get(f"{API}/users/me")).json()["notify_tasks"] is True
    changed = await client.patch(f"{API}/users/me", json={"notify_tasks": False})
    assert changed.status_code == 200 and changed.json()["notify_tasks"] is False
    await db.refresh(alice)
    assert alice.notify_tasks is False
