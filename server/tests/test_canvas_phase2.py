"""Canvas Phase 2 (M72, CANVAS.md §18): mention notifications, the volatile 「編集中」 relay and
tasks made from a checklist item."""

import asyncio
import json
import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any, cast

import httpx
import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.canvases import service as canvases
from app.modules.users.models import User
from tests.conftest import LiveServer
from tests.helpers import http_login, make_user
from tests.test_push_planner import add_device, deliveries, relay_with_planner
from tests.test_realtime import PASSWORD, _connect, _recv_type, _wait_outbox_drained

API = "/api/v1"
Actor = Callable[[User], None]


def key() -> str:
    return str(uuid.uuid4())


async def _channel(client: AsyncClient, name: str, **extra: Any) -> str:
    created = await client.post(f"{API}/channels", json={"name": name, **extra})
    assert created.status_code == 201, created.text
    return str(created.json()["id"])


async def _add(client: AsyncClient, channel_id: str, *users: User) -> None:
    for user in users:
        added = await client.post(
            f"{API}/channels/{channel_id}/members", json={"user_id": str(user.id)}
        )
        assert added.status_code in (200, 201), added.text


async def _canvas(client: AsyncClient, channel_id: str, body: str = "") -> dict[str, Any]:
    created = await client.post(
        f"{API}/channels/{channel_id}/canvases",
        json={"client_save_id": key(), "title": "議事録", "body": body},
    )
    assert created.status_code == 201, created.text
    return cast(dict[str, Any], created.json())


async def _save(
    client: AsyncClient, canvas: dict[str, Any], body: str, *, base: str | None = None, **extra: Any
) -> dict[str, Any]:
    saved = await client.put(
        f"{API}/canvases/{canvas['id']}/content",
        json={
            "base_rev_id": base or canvas["head_rev_id"],
            "body": body,
            "client_save_id": extra.pop("client_save_id", key()),
            **extra,
        },
    )
    assert saved.status_code == 200, saved.text
    out = cast(dict[str, Any], saved.json())
    canvas.update(out["canvas"])
    return out


async def _mentioned(db: AsyncSession) -> list[OutboxEvent]:
    rows = await db.execute(
        select(OutboxEvent)
        .where(OutboxEvent.event_type == "canvas.mentioned")
        .order_by(OutboxEvent.id)
    )
    return list(rows.scalars().all())


async def _who(db: AsyncSession) -> list[uuid.UUID | None]:
    return [e.audience_id for e in await _mentioned(db)]


# --- mentions (§18.1) ----------------------------------------------------------------------------


async def test_mentions_added_by_a_save_notify_once(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    outsider = await make_user(db, "dave")
    as_user(alice)
    cid = await _channel(client, "lab")
    await _add(client, cid, bob, carol)

    # Created with a mention of bob, of myself and of someone outside the conversation: bob only.
    canvas = await _canvas(
        client, cid, f"# TODO\n- [ ] 予稿 <@{bob.id}>\n<@{alice.id}> <@{outsider.id}> <!channel>"
    )
    events = await _mentioned(db)
    assert [e.audience_id for e in events] == [bob.id]
    assert events[0].audience_type == "user" and events[0].channel_id == uuid.UUID(cid)
    assert events[0].payload == {
        "canvas_id": canvas["id"],
        "channel_id": cid,
        "rev_id": canvas["head_rev_id"],
        "title": "議事録",
        "by_user_id": str(alice.id),
    }

    # Edits that keep the mention (or add a second one of bob) notify nobody new.
    body = canvas["body"] + f"\n- [ ] ポスター <@{bob.id}>"
    await _save(client, canvas, body)
    assert await _who(db) == [bob.id]

    # A new person: carol, once; a retry of the same save adds nothing.
    retry_key = key()
    base = canvas["head_rev_id"]
    body += f"\n- [ ] 旅費 <@{carol.id}>"
    first = await _save(client, canvas, body, base=base, client_save_id=retry_key)
    again = await _save(client, canvas, body, base=base, client_save_id=retry_key)
    assert again["submitted_rev_id"] == first["submitted_rev_id"]
    events = await _mentioned(db)
    assert [e.audience_id for e in events] == [bob.id, carol.id]
    assert events[1].payload["rev_id"] == first["submitted_rev_id"]

    # Removed, then added back: notified again by the save that adds it.
    removed = body.replace(f" <@{carol.id}>", "")
    await _save(client, canvas, removed)
    assert await _who(db) == [bob.id, carol.id]
    await _save(client, canvas, removed + f"\n<@{carol.id}> 確認お願いします")
    assert await _who(db) == [bob.id, carol.id, carol.id]


async def test_merges_groups_ticks_and_restores(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    erin = await make_user(db, "erin")
    frank = await make_user(db, "frank")
    as_user(root)
    group = await client.post(
        f"{API}/admin/groups",
        json={"name": "design", "member_ids": [str(alice.id), str(bob.id), str(carol.id)]},
    )
    assert group.status_code == 201, group.text
    gid = group.json()["id"]

    as_user(alice)
    cid = await _channel(client, "lab")
    await _add(client, cid, bob, carol, erin, frank)
    canvas = await _canvas(client, cid, f"担当 <@{bob.id}>\n\n- [ ] 掃除\n\nメモ")
    assert await _who(db) == [bob.id]
    start = canvas["head_rev_id"]

    # A group: its members not mentioned before, less the author (bob was already).
    await _save(client, canvas, canvas["body"] + f"\n<@group:{gid}>")
    assert await _who(db) == [bob.id, carol.id]

    # A merge: erin edits an old version adding mentions; the merged head notifies frank (alice
    # was already mentioned through the group).
    as_user(erin)
    merged = await _save(
        client,
        canvas,
        f"担当 <@{bob.id}> <@{alice.id}> <@{frank.id}>\n\n- [ ] 掃除\n\nメモ",
        base=start,
    )
    assert merged["merged"] is True
    assert await _who(db) == [bob.id, carol.id, frank.id]
    events = await _mentioned(db)
    assert events[-1].payload["by_user_id"] == str(erin.id)
    assert events[-1].payload["rev_id"] == canvas["head_rev_id"]

    # A tick changes no mention; a restore of an old version never notifies.
    as_user(bob)
    ticked = canvas["body"].replace("- [ ] 掃除", "- [x] 掃除")
    await _save(client, canvas, ticked)
    as_user(alice)
    await _save(client, canvas, "なにもなし")
    restored = await client.post(
        f"{API}/canvases/{canvas['id']}/revisions/{start}/restore",
        json={"client_save_id": key()},
    )
    assert restored.status_code == 200, restored.text
    assert f"<@{bob.id}>" in restored.json()["body"]
    assert await _who(db) == [bob.id, carol.id, frank.id]


async def test_mention_push_respects_settings(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Actor,
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    as_user(alice)
    cid = await _channel(client, "m2-進捗")
    await _add(client, cid, bob)

    async def drain(active: set[uuid.UUID] | None = None) -> list[dict[str, Any]]:
        relay = relay_with_planner(app, test_settings, active)
        while await relay.process_batch():
            pass
        return [d.payload for d in await deliveries(db) if d.payload.get("kind") == "canvas"]

    await drain()
    canvas = await _canvas(client, cid, f"<@{bob.id}> 発表順を見てください")
    pushes = await drain()
    assert len(pushes) == 1
    push = pushes[0]
    assert push["title"] == "キャンバス" and push["subtitle"] == "#m2-進捗"
    assert push["body"] == "Alice が「議事録」であなたをメンションしました"
    assert push["canvas_id"] == canvas["id"] and push["channel_id"] == cid
    assert push["collapse_key"] == f"canvas:{canvas['id']}"
    assert len(await drain()) == 1  # processed once

    async def mention_again() -> None:
        await _save(client, canvas, "空")
        await _save(client, canvas, f"<@{bob.id}> もう一度")

    # Muted, set to nothing, DND, on another device, or trashed before planning: no push.
    as_user(bob)
    pref = f"{API}/channels/{cid}/notification-preference"
    await client.put(pref, json={"level": None, "muted": True})
    as_user(alice)
    await mention_again()
    assert len(await drain()) == 1
    as_user(bob)
    await client.put(pref, json={"level": "none", "muted": False})
    as_user(alice)
    await mention_again()
    assert len(await drain()) == 1
    as_user(bob)
    await client.put(pref, json={"level": "mentions", "muted": False})
    bob.dnd_until = utcnow() + timedelta(hours=1)
    await db.commit()
    as_user(alice)
    await mention_again()
    assert len(await drain()) == 1
    bob.dnd_until = None
    await db.commit()
    await mention_again()
    assert len(await drain(active={bob.id})) == 1
    await mention_again()
    assert (await client.delete(f"{API}/canvases/{canvas['id']}")).status_code == 204
    assert len(await drain()) == 1

    # Level "mentions" (the default) still gets it: a mention.
    restored = await client.post(f"{API}/canvases/{canvas['id']}/restore")
    assert restored.status_code == 200, restored.text
    canvas.update(restored.json())
    await mention_again()
    assert len(await drain()) == 2

    # Without content in pushes: a neutral text.
    hidden = test_settings.model_copy(update={"push_include_content": False})
    await mention_again()
    relay = relay_with_planner(app, hidden)
    while await relay.process_batch():
        pass
    last = [d.payload for d in await deliveries(db) if d.payload.get("kind") == "canvas"][-1]
    assert last["body"] == "キャンバスでメンションされました"


# --- 「編集中」 (§18.2) --------------------------------------------------------------------------


async def test_canvas_presence_is_relayed_to_members_and_ends_on_close(live: LiveServer) -> None:
    async with live.app.state.db.session_factory() as db:
        for name in ("alice", "bob", "carol"):
            await make_user(db, name, password=PASSWORD)
    alice = await http_login(live.base_url, "alice", PASSWORD)
    bob = await http_login(live.base_url, "bob", PASSWORD)
    carol = await http_login(live.base_url, "carol", PASSWORD)
    async with httpx.AsyncClient(base_url=live.base_url) as client:
        auth = {"Authorization": f"Bearer {alice['access_token']}"}
        channel = (await client.post(f"{API}/channels", json={"name": "lab"}, headers=auth)).json()
        bob_auth = {"Authorization": f"Bearer {bob['access_token']}"}
        await client.post(f"{API}/channels/{channel['id']}/join", headers=bob_auth)
        created = await client.post(
            f"{API}/channels/{channel['id']}/canvases",
            json={"client_save_id": key(), "title": "議事録"},
            headers=auth,
        )
        canvas_id = created.json()["id"]
        trashed = await client.post(
            f"{API}/channels/{channel['id']}/canvases",
            json={"client_save_id": key(), "title": "古い"},
            headers=auth,
        )
        trashed_id = trashed.json()["id"]
        await client.delete(f"{API}/canvases/{trashed_id}", headers=auth)
    await _wait_outbox_drained(live)
    alice_ws = await _connect(live, alice["access_token"])
    bob_ws = await _connect(live, bob["access_token"])
    carol_ws = await _connect(live, carol["access_token"])

    def frame(canvas: str, editing: bool, section: str | None = None) -> str:
        out: dict[str, Any] = {"type": "canvas_presence", "canvas_id": canvas, "editing": editing}
        if section is not None:
            out["section"] = section
        return json.dumps(out)

    await alice_ws.send(frame(canvas_id, True, "  TODO "))
    got = await _recv_type(bob_ws, "canvas_presence")
    assert got == {
        "type": "canvas_presence",
        "canvas_id": canvas_id,
        "channel_id": channel["id"],
        "user_id": alice["user"]["id"],
        "editing": True,
        "section": "TODO",
    }
    # The same again inside the interval is dropped; a new section goes at once.
    await alice_ws.send(frame(canvas_id, True, "TODO"))
    with pytest.raises(TimeoutError):
        await _recv_type(bob_ws, "canvas_presence", wait=0.5)
    await alice_ws.send(frame(canvas_id, True, "決定事項"))
    assert (await _recv_type(bob_ws, "canvas_presence"))["section"] == "決定事項"
    # Not to a non-member nor back to the sender; a non-member's and a trashed canvas's are dropped.
    with pytest.raises(TimeoutError):
        await _recv_type(carol_ws, "canvas_presence", wait=0.3)
    with pytest.raises(TimeoutError):
        await _recv_type(alice_ws, "canvas_presence", wait=0.3)
    await carol_ws.send(frame(canvas_id, True))
    await alice_ws.send(frame(trashed_id, True))
    await alice_ws.send(frame(str(uuid.uuid4()), True))
    with pytest.raises(TimeoutError):
        await _recv_type(bob_ws, "canvas_presence", wait=0.5)
    # Stopping goes at once.
    await alice_ws.send(frame(canvas_id, False))
    stopped = await _recv_type(bob_ws, "canvas_presence")
    assert stopped["editing"] is False and stopped["section"] is None
    # Editing again, then the window goes away: bob hears it stop.
    await alice_ws.send(frame(canvas_id, True))
    assert (await _recv_type(bob_ws, "canvas_presence"))["editing"] is True
    await alice_ws.close()
    ended = await _recv_type(bob_ws, "canvas_presence")
    assert ended["editing"] is False and ended["user_id"] == alice["user"]["id"]
    for ws in (bob_ws, carol_ws):
        await ws.close()
    await asyncio.sleep(0)


# --- checklist item → task (§18.3) ---------------------------------------------------------------


async def _task(client: AsyncClient, body: dict[str, Any], status: int = 201) -> dict[str, Any]:
    response = await client.post(f"{API}/tasks", json={"client_task_id": key(), **body})
    assert response.status_code == status, response.text
    return cast(dict[str, Any], response.json())


async def test_task_from_a_checklist_item(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    cid = await _channel(client, "lab")
    other = await _channel(client, "other")
    await _add(client, cid, bob)
    line = f"- [ ] **予稿**を出す <@{bob.id}> 📅 2030-01-10"
    canvas = await _canvas(client, cid, f"# TODO\n{line}\n  - [x] 済み\n- 普通の行")
    elsewhere = await _canvas(client, other, line)

    task = await _task(
        client,
        {
            "channel_id": cid,
            "title": "予稿を出す",
            "due_on": "2030-01-10",
            "assignee_ids": [str(bob.id)],
            "source_canvas_id": canvas["id"],
            "source_canvas_line": line + "  ",
        },
    )
    assert task["source"] is None
    assert task["canvas_source"] == {
        "canvas_id": canvas["id"],
        "excerpt": "予稿を出す @Bob 📅 2030-01-10",
    }
    assert task["assignee_ids"] == [str(bob.id)]
    got = await client.get(f"{API}/tasks/{task['id']}")
    assert got.json()["canvas_source"]["canvas_id"] == canvas["id"]
    # A task from a message has no canvas source.
    plain = await _task(client, {"title": "ふつう"})
    assert plain["canvas_source"] is None

    # A checked item may be made a task too (nested); a plain line, an unknown one, a canvas of
    # another channel for this board, half a source or both kinds are refused.
    nested = await _task(
        client,
        {"title": "済み", "source_canvas_id": canvas["id"], "source_canvas_line": "  - [x] 済み"},
    )
    assert nested["canvas_source"]["excerpt"] == "済み" and nested["channel_id"] is None
    for bad in (
        {"source_canvas_id": canvas["id"], "source_canvas_line": "- 普通の行"},
        {"source_canvas_id": canvas["id"], "source_canvas_line": "- [ ] 無い項目"},
        {"source_canvas_id": elsewhere["id"], "source_canvas_line": line, "channel_id": cid},
        {"source_canvas_id": canvas["id"]},
        {"source_canvas_line": line},
    ):
        refused = await client.post(
            f"{API}/tasks", json={"title": "x", "client_task_id": key(), **bad}
        )
        assert refused.status_code == 400, refused.text
        assert refused.json()["error"]["code"] == "task_invalid_source"
    message = await client.post(
        f"{API}/channels/{cid}/messages", json={"client_msg_id": key(), "body": "hi"}
    )
    both = await client.post(
        f"{API}/tasks",
        json={
            "title": "x",
            "source_message_id": message.json()["id"],
            "source_canvas_id": canvas["id"],
            "source_canvas_line": line,
        },
    )
    assert both.status_code == 400

    # Someone outside the conversation: 404, as for a canvas they cannot see.
    as_user(carol)
    hidden = await client.post(
        f"{API}/tasks",
        json={"title": "x", "source_canvas_id": canvas["id"], "source_canvas_line": line},
    )
    assert hidden.status_code == 404 and hidden.json()["error"]["code"] == "canvas_not_found"

    # M80 (§22): both ways now — ticking the box completes the task (test_canvas_task_links.py).
    as_user(bob)
    current = (await client.get(f"{API}/canvases/{canvas['id']}")).json()
    await _save(client, current, current["body"].replace("- [ ] **予稿**", "- [x] **予稿**"))
    assert (await client.get(f"{API}/tasks/{task['id']}")).json()["status"] == "done"

    # Trashed: still linked; purged: the link goes, the excerpt stays.
    as_user(alice)
    assert (await client.delete(f"{API}/canvases/{canvas['id']}")).status_code == 204
    assert (await client.get(f"{API}/tasks/{task['id']}")).json()["canvas_source"][
        "canvas_id"
    ] == canvas["id"]
    later = utcnow() + timedelta(days=31)
    assert (await canvases.housekeeping(db, now=later, trash_days=30))[1] == 1
    after = (await client.get(f"{API}/tasks/{task['id']}")).json()
    assert after["canvas_source"] == {"canvas_id": None, "excerpt": "予稿を出す @Bob 📅 2030-01-10"}


async def test_task_from_a_dm_canvas(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    dm = await client.post(f"{API}/dms", json={"user_ids": [str(bob.id)]})
    assert dm.status_code in (200, 201), dm.text
    dm_id = dm.json()["id"]
    line = "- [ ] 研究計画を直す"
    canvas = await _canvas(client, dm_id, line)
    mine = await _task(
        client, {"title": "研究計画", "source_canvas_id": canvas["id"], "source_canvas_line": line}
    )
    assert mine["channel_id"] is None
    # Shared in the DM with an assignee (the L9 rule for a DM's messages).
    shared = await _task(
        client,
        {
            "channel_id": dm_id,
            "title": "研究計画",
            "assignee_ids": [str(bob.id)],
            "source_canvas_id": canvas["id"],
            "source_canvas_line": line,
        },
    )
    assert shared["channel_id"] == dm_id and shared["canvas_source"]["canvas_id"] == canvas["id"]
    # Without a source a DM has no board.
    board = await client.post(
        f"{API}/tasks", json={"title": "x", "channel_id": dm_id, "client_task_id": key()}
    )
    assert board.status_code == 400
