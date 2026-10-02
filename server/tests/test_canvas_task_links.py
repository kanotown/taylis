"""Checklist items and their tasks, both ways (M80, CANVAS.md §22): the marker the server writes
when a task is made from an item, the box following the task, the task following the box, the
merge with a device editing meanwhile, permissions, no loops, search."""

import json
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.canvases import markers
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_canvas_phase2 import _add, _canvas, _channel, _save, _task, key

API = "/api/v1"
Actor = Callable[[User], None]


async def _get(client: AsyncClient, canvas_id: str) -> dict[str, Any]:
    response = await client.get(f"{API}/canvases/{canvas_id}")
    assert response.status_code == 200, response.text
    return cast(dict[str, Any], response.json())


async def _revisions(client: AsyncClient, canvas_id: str) -> list[dict[str, Any]]:
    response = await client.get(f"{API}/canvases/{canvas_id}/revisions")
    assert response.status_code == 200, response.text
    return cast(list[dict[str, Any]], response.json()["items"])


async def _status(client: AsyncClient, task_id: str) -> str:
    return cast(str, (await client.get(f"{API}/tasks/{task_id}")).json()["status"])


async def _set_status(client: AsyncClient, task_id: str, status: str) -> dict[str, Any]:
    response = await client.patch(f"{API}/tasks/{task_id}", json={"status": status})
    assert response.status_code == 200, response.text
    return cast(dict[str, Any], response.json())


def test_shared_strip_cases() -> None:
    """apps/shared/canvas_task_markers.json: the apps hide just what the server calls a marker."""
    path = Path(__file__).resolve().parents[2] / "apps" / "shared" / "canvas_task_markers.json"
    for case in json.loads(path.read_text(encoding="utf-8"))["strip"]:
        assert markers.strip(case["text"]) == case["expected"], case


def test_markers_pure() -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    body = f"# TODO\n- [ ] 資料 {markers.marker(a)}\n```\n- [ ] code {markers.marker(b)}\n```"
    assert markers.box_states(body) == {a: False}  # not inside a code block
    assert markers.strip(body).split("\n")[1] == "- [ ] 資料"
    ticked = markers.set_box(body, a, True)
    assert ticked.split("\n")[1] == f"- [x] 資料 {markers.marker(a)}"
    assert markers.set_box(ticked, a, True) == ticked
    assert markers.ticks_changed(body, ticked) == {a: True}
    assert markers.ticks_changed(markers.strip(body), ticked) == {}  # a marker appearing
    assert markers.find_item(body, "- [ ] 資料") == 1
    assert markers.find_item(body, f"- [ ] 資料 {markers.marker(a)}  ") == 1
    assert markers.find_item(body, "- [ ] code") is None
    twice = markers.with_marker(body, 1, b)
    assert markers.task_ids(twice.split("\n")[1]) == [a, b]
    assert markers.with_marker(twice, 1, b) == twice


async def test_marker_and_both_ways(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "lab")
    await _add(client, cid, bob)
    line = f"- [ ] 予稿を出す <@{bob.id}>"
    canvas = await _canvas(client, cid, f"# TODO\n{line}\n- [ ] ほか")
    created_rev = canvas["head_rev_id"]
    task = await _task(
        client,
        {
            "channel_id": cid,
            "title": "予稿を出す",
            "source_canvas_id": canvas["id"],
            "source_canvas_line": line,
        },
    )
    tid = uuid.UUID(task["id"])

    # The marker went to the end of the line, as a version of kind task by the task's maker.
    now = await _get(client, canvas["id"])
    assert now["body"].split("\n")[1] == f"{line} {markers.marker(tid)}"
    assert now["version"] == canvas["version"] + 1
    head = (await _revisions(client, canvas["id"]))[0]
    assert head["kind"] == "task" and head["author_id"] == str(alice.id)
    assert head["parent_rev_id"] == created_rev
    assert task["canvas_source"]["excerpt"] == "予稿を出す @Bob"

    # The task completed → the box ticked (as the one who completed it); again → nothing more.
    as_user(bob)
    await _set_status(client, task["id"], "done")
    ticked = await _get(client, canvas["id"])
    assert ticked["body"].split("\n")[1] == f"- [x] 予稿を出す <@{bob.id}> {markers.marker(tid)}"
    assert ticked["task_done"] == 1 and ticked["updated_by"] == str(bob.id)
    head = (await _revisions(client, canvas["id"]))[0]
    assert head["kind"] == "task" and head["author_id"] == str(bob.id)
    await _set_status(client, task["id"], "done")
    assert (await _get(client, canvas["id"]))["version"] == ticked["version"]

    # Reopened (doing) → unticked; todo ↔ doing leaves the box alone.
    await _set_status(client, task["id"], "doing")
    assert (await _get(client, canvas["id"]))["body"].split("\n")[1].startswith("- [ ] ")
    version = (await _get(client, canvas["id"]))["version"]
    await _set_status(client, task["id"], "todo")
    assert (await _get(client, canvas["id"]))["version"] == version

    # Moved into done on the board → ticked too.
    moved = await client.post(f"{API}/tasks/{task['id']}/move", json={"status": "done"})
    assert moved.status_code == 200, moved.text
    assert (await _get(client, canvas["id"]))["body"].split("\n")[1].startswith("- [x] ")

    # The box unticked in the canvas → the task reopens (todo), as the saver; no version comes
    # back from the task (one save, one version).
    as_user(alice)
    current = await _get(client, canvas["id"])
    before = current["version"]
    await _save(client, current, current["body"].replace("- [x] 予稿", "- [ ] 予稿"))
    assert await _status(client, task["id"]) == "todo"
    after = await _get(client, canvas["id"])
    assert after["version"] == before + 1
    assert (await _revisions(client, canvas["id"]))[0]["kind"] == "save"

    # Ticked in the canvas → done, completed by the saver.
    await _save(client, after, after["body"].replace("- [ ] 予稿", "- [x] 予稿"))
    got = (await client.get(f"{API}/tasks/{task['id']}")).json()
    assert got["status"] == "done" and got["completed_by"] == str(alice.id)
    assert (await _get(client, canvas["id"]))["version"] == before + 2

    # The task's events went out (task.updated), and canvas.updated for the task's versions.
    rows = (
        (
            await db.execute(
                select(OutboxEvent.event_type).where(
                    OutboxEvent.event_type.in_(["task.updated", "canvas.updated"])
                )
            )
        )
        .scalars()
        .all()
    )
    assert "task.updated" in rows and rows.count("canvas.updated") >= 6


async def test_merge_with_a_device_editing_meanwhile(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "lab")
    line = "- [ ] 図を直す"
    canvas = await _canvas(client, cid, f"{line}\n- [ ] 表")
    old_head = canvas["head_rev_id"]
    task = await _task(
        client,
        {
            "channel_id": cid,
            "title": "図",
            "source_canvas_id": canvas["id"],
            "source_canvas_line": line,
        },
    )
    tid = uuid.UUID(task["id"])
    # A device still on the version before the marker changes the same line: both stay.
    out = await _save(client, canvas, "- [ ] 図 1 を直す\n- [ ] 表", base=old_head)
    assert out["merged"] is True
    body = (await _get(client, canvas["id"]))["body"]
    assert body.split("\n")[0] == f"- [ ] 図 1 を直す {markers.marker(tid)}"
    # …and the task still follows the line.
    await _set_status(client, task["id"], "done")
    assert (await _get(client, canvas["id"]))["body"].startswith("- [x] 図 1 を直す")
    # The line deleted: completing or reopening the task changes nothing and fails nothing.
    current = await _get(client, canvas["id"])
    await _save(client, current, "- [ ] 表")
    await _set_status(client, task["id"], "todo")
    assert (await _get(client, canvas["id"]))["body"] == "- [ ] 表"


async def test_permissions(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "lab")
    await _add(client, cid, bob)
    shared_line, mine_line = "- [ ] 共有", "- [ ] 自分の"
    canvas = await _canvas(client, cid, f"{shared_line}\n{mine_line}")
    shared = await _task(
        client,
        {
            "channel_id": cid,
            "title": "共有",
            "source_canvas_id": canvas["id"],
            "source_canvas_line": shared_line,
        },
    )
    mine = await _task(
        client,
        {"title": "自分の", "source_canvas_id": canvas["id"], "source_canvas_line": mine_line},
    )
    assert mine["channel_id"] is None

    # Bob ticks alice's personal item: the box is ticked, her task he cannot see stays open.
    as_user(bob)
    current = await _get(client, canvas["id"])
    await _save(client, current, current["body"].replace("- [ ] 自分の", "- [x] 自分の"))
    as_user(alice)
    assert await _status(client, mine["id"]) == "todo"

    # Only owners post here: bob may still tick (§4.7) but not change the board's task — the
    # save goes through, the task stays.
    await client.patch(f"{API}/channels/{cid}", json={"posting_policy": "owners"})
    as_user(bob)
    current = await _get(client, canvas["id"])
    await _save(client, current, current["body"].replace("- [ ] 共有", "- [x] 共有"))
    assert (await _get(client, canvas["id"]))["body"].startswith("- [x] 共有")
    as_user(alice)
    assert await _status(client, shared["id"]) == "todo"
    await client.patch(f"{API}/channels/{cid}", json={"posting_policy": "everyone"})
    as_user(bob)

    # Bob's own task from an item, then he is taken out of the conversation: completing it no
    # longer touches the canvas (he may not tick there any more).
    current = await _get(client, canvas["id"])
    await _save(client, current, current["body"] + "\n- [ ] ボブの")
    his = await _task(
        client,
        {"title": "ボブの", "source_canvas_id": canvas["id"], "source_canvas_line": "- [ ] ボブの"},
    )
    as_user(alice)
    removed = await client.delete(f"{API}/channels/{cid}/members/{bob.id}")
    assert removed.status_code == 204, removed.text
    version = (await _get(client, canvas["id"]))["version"]
    as_user(bob)
    await _set_status(client, his["id"], "done")
    as_user(alice)
    after = await _get(client, canvas["id"])
    assert after["version"] == version
    assert after["body"].endswith("- [ ] ボブの " + markers.marker(uuid.UUID(his["id"])))


async def test_search_and_excerpts_skip_the_marker(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "lab")
    line = "- [ ] 発表練習"
    canvas = await _canvas(client, cid, line)
    task = await _task(
        client, {"title": "練習", "source_canvas_id": canvas["id"], "source_canvas_line": line}
    )
    assert markers.marker(uuid.UUID(task["id"])) in (await _get(client, canvas["id"]))["body"]
    found = await client.get(f"{API}/search/canvases", params={"q": "発表"})
    assert found.status_code == 200, found.text
    hits = found.json()["hits"]
    assert len(hits) == 1 and "task" not in hits[0]["snippet"]
    for needle in ("task", task["id"][:8]):
        none = await client.get(f"{API}/search/canvases", params={"q": needle})
        assert none.json()["hits"] == [], needle
    # A second task from the same item (the line as the app holds it, marker and all).
    raw = (await _get(client, canvas["id"]))["body"]
    second = await _task(
        client, {"title": "練習 2", "source_canvas_id": canvas["id"], "source_canvas_line": raw}
    )
    assert second["canvas_source"]["excerpt"] == "発表練習"
    body = (await _get(client, canvas["id"]))["body"]
    assert markers.task_ids(body) == [uuid.UUID(task["id"]), uuid.UUID(second["id"])]
    # Ticking the item completes both.
    current = await _get(client, canvas["id"])
    await _save(client, current, body.replace("[ ]", "[x]"), client_save_id=key())
    assert await _status(client, task["id"]) == "done"
    assert await _status(client, second["id"]) == "done"


async def test_ticking_a_repeating_task_in_the_canvas_makes_the_next_one(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    """M80 + M81: the box ticked in the canvas completes the task the same way as the task
    screen does, so a repeating task gets its next occurrence (once), back in a built-in column."""
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "lab")
    line = "- [ ] 週報を出す"
    canvas = await _canvas(client, cid, f"# TODO\n{line}")
    task = await _task(
        client,
        {
            "channel_id": cid,
            "title": "週報を出す",
            "due_on": "2030-01-07",
            "rrule": "FREQ=WEEKLY;BYDAY=MO",
            "source_canvas_id": canvas["id"],
            "source_canvas_line": line,
        },
    )
    current = await _get(client, canvas["id"])
    await _save(client, current, current["body"].replace("- [ ] 週報", "- [x] 週報"))
    assert await _status(client, task["id"]) == "done"
    board = (await client.get(f"{API}/tasks", params={"channel_id": cid})).json()
    nxt = [t for t in board if t["id"] != task["id"]]
    assert len(nxt) == 1
    assert nxt[0]["due_on"] == "2030-01-14" and nxt[0]["status"] == "todo"
    assert nxt[0]["column_id"] is None

    # Unticked and ticked again: still only one next occurrence.
    current = await _get(client, canvas["id"])
    await _save(client, current, current["body"].replace("- [x] 週報", "- [ ] 週報"))
    current = await _get(client, canvas["id"])
    await _save(client, current, current["body"].replace("- [ ] 週報", "- [x] 週報"))
    board = (await client.get(f"{API}/tasks", params={"channel_id": cid})).json()
    assert len([t for t in board if t["id"] != task["id"]]) == 1
