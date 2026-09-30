"""Canvases, the server core (M41, CANVAS.md §4): create, read, save with merge and idempotency,
permissions (§4.7), history, trash, templates, and the canvas.* events."""

import asyncio
import uuid
from collections.abc import Callable
from datetime import date
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.cli import export_channel_lines
from app.core.ratelimit import RateLimiter
from app.events.models import OutboxEvent
from app.modules.audit.models import AuditLog
from app.modules.canvases import service as canvases
from app.modules.canvases import templates as tpl
from app.modules.canvases.models import CanvasRevision
from app.modules.channels.service import resolve_event_audience
from app.modules.users.models import User
from tests.helpers import make_user

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


async def _create(client: AsyncClient, channel_id: str, **body: Any) -> Response:
    return await client.post(
        f"{API}/channels/{channel_id}/canvases", json={"client_save_id": key(), **body}
    )


async def _canvas(client: AsyncClient, channel_id: str, **body: Any) -> dict[str, Any]:
    created = await _create(client, channel_id, **body)
    assert created.status_code == 201, created.text
    result: dict[str, Any] = created.json()
    return result


async def _save(
    client: AsyncClient, canvas_id: str, base: str, body: str, **extra: Any
) -> Response:
    return await client.put(
        f"{API}/canvases/{canvas_id}/content",
        json={"base_rev_id": base, "body": body, "client_save_id": key(), **extra},
    )


async def _events(db: AsyncSession, prefix: str = "canvas.") -> list[OutboxEvent]:
    rows = await db.execute(
        select(OutboxEvent)
        .where(OutboxEvent.event_type.startswith(prefix))
        .order_by(OutboxEvent.id)
    )
    return list(rows.scalars().all())


# --- create -------------------------------------------------------------------------------------


async def test_create_read_and_list(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "lab")
    await _add(client, cid, bob)

    blank = await _canvas(client, cid)
    assert blank["title"] == "無題のキャンバス" and blank["body"] == ""
    assert blank["version"] == 1 and blank["created_by"] == str(alice.id)
    assert blank["task_total"] == 0 and blank["is_channel_tab"] is False

    rules = await _canvas(
        client,
        cid,
        title="  研究室の\nルール ",
        body=(
            "# ルール\r\n- [x] 鍵を閉める\r\n- [ ] 掃除\n* [ ] ゴミ出し\n```\n- [ ] not a task\n```"
        ),
        as_tab=True,
    )
    assert rules["title"] == "研究室の ルール"
    assert "\r" not in rules["body"]
    assert (rules["task_total"], rules["task_done"]) == (3, 1)
    assert rules["is_channel_tab"] is True

    # Members read it; the list has no bodies and the most recently updated first.
    as_user(bob)
    got = await client.get(f"{API}/canvases/{rules['id']}")
    assert got.status_code == 200 and got.json()["body"] == rules["body"]
    etag = got.headers["etag"]
    assert etag == '"v1"'
    cached = await client.get(f"{API}/canvases/{rules['id']}", headers={"If-None-Match": etag})
    assert cached.status_code == 304 and cached.content == b""
    listed = (await client.get(f"{API}/channels/{cid}/canvases")).json()
    assert [c["id"] for c in listed] == [rules["id"], blank["id"]]
    assert "body" not in listed[0]

    # Across all my conversations, with a cursor.
    page = (await client.get(f"{API}/canvases", params={"limit": 1})).json()
    assert [c["id"] for c in page["items"]] == [rules["id"]] and page["next_cursor"]
    rest = (
        await client.get(f"{API}/canvases", params={"limit": 1, "cursor": page["next_cursor"]})
    ).json()
    assert [c["id"] for c in rest["items"]] == [blank["id"]] and rest["next_cursor"] is None
    assert (await client.get(f"{API}/canvases", params={"cursor": "junk"})).status_code == 400

    # The tab: one per conversation; bootstrap names it.
    taken = await _create(client, cid, as_tab=True)
    assert taken.status_code == 409 and taken.json()["error"]["code"] == "canvas_tab_taken"
    boot = (await client.get(f"{API}/sync/bootstrap")).json()
    assert {c["id"]: c["canvas_tab_id"] for c in boot["channels"]}[cid] == rules["id"]

    assert (await client.get(f"{API}/canvases/{uuid.uuid4()}")).status_code == 404


async def test_create_is_idempotent(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "lab")
    other = await _channel(client, "other")
    save_id = key()
    first = await client.post(
        f"{API}/channels/{cid}/canvases", json={"client_save_id": save_id, "title": "議事録"}
    )
    again = await client.post(
        f"{API}/channels/{cid}/canvases", json={"client_save_id": save_id, "title": "議事録"}
    )
    assert first.status_code == 201 and again.status_code == 200
    assert again.json()["id"] == first.json()["id"]
    assert len((await client.get(f"{API}/channels/{cid}/canvases")).json()) == 1
    reused = await client.post(f"{API}/channels/{other}/canvases", json={"client_save_id": save_id})
    assert reused.status_code == 409 and reused.json()["error"]["code"] == "idempotency_conflict"
    assert len(await _events(db, "canvas.created")) == 1


async def test_create_limits(
    client: AsyncClient, db: AsyncSession, as_user: Actor, monkeypatch: pytest.MonkeyPatch
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "lab")
    too_long = await _create(client, cid, body="あ" * 100_001)
    assert too_long.status_code == 422 and too_long.json()["error"]["code"] == "canvas_too_large"
    assert (await _create(client, cid, body="あ" * 100_000)).status_code == 201
    assert (await _create(client, cid, title="x" * 201)).status_code == 422
    assert (await _create(client, cid, title="   ")).status_code == 422
    assert (await _create(client, cid, tz="Mars/Olympus")).status_code == 422
    monkeypatch.setattr(canvases, "MAX_CANVASES_PER_CONVERSATION", 1)
    full = await _create(client, cid)
    assert full.status_code == 409 and full.json()["error"]["code"] == "too_many_canvases"


# --- templates ----------------------------------------------------------------------------------


def test_template_placeholders() -> None:
    me = uuid.UUID("01929f3a-0000-7000-8000-000000000001")
    ctx = tpl.Context(today=date(2026, 10, 1), me_id=me, me_name="Kano", channel="lab")
    text = "{{date}} {{week}} {{me}} {{me_name}} {{channel}} {{other}} {{ date }}"
    assert tpl.expand(text, ctx, title=False) == (
        f"2026-10-01 (木) 2026-W40 <@{me}> Kano lab {{{{other}}}} {{{{ date }}}}"
    )
    assert tpl.expand("{{me}}", ctx, title=True) == "Kano"
    # ISO weeks at the turn of the year, as the post templates (apps/shared/templates.json).
    assert tpl.format_week(date(2027, 1, 1)) == "2026-W53"
    assert tpl.format_week(date(2025, 12, 29)) == "2026-W01"
    assert tpl.format_date(date(2026, 1, 4)) == "2026-01-04 (日)"
    # Placeholders are put in once.
    tricky = tpl.Context(today=date(2026, 10, 1), me_id=me, me_name="{{date}}", channel="x")
    assert tpl.expand("{{me_name}}", tricky, title=True) == "{{date}}"


async def test_templates(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    admin = await make_user(db, "root", role="admin")
    carol = await make_user(db, "carol")
    await canvases.ensure_builtin_templates(db)
    assert await canvases.ensure_builtin_templates(db) == 0  # already there
    as_user(alice)
    listed = (await client.get(f"{API}/canvas-templates")).json()
    assert [t["key"] for t in listed] == [b.key for b in tpl.BUILTINS]
    assert all(t["builtin"] for t in listed)

    # Made from a template: the server puts the placeholders in, in the client's zone.
    cid = await _channel(client, "seminar")
    minutes = await _canvas(client, cid, template_key="minutes", tz="Asia/Tokyo")
    assert minutes["title"].startswith("議事録 20") and "(" in minutes["title"]
    assert minutes["body"].startswith(f"# {minutes['title']}\n## 出席")
    assert minutes["template_key"] == "minutes" and minutes["task_total"] == 1
    weekly = await _canvas(client, cid, template_key="weekly_report")
    assert weekly["title"].endswith(" Alice") and "週報 20" in weekly["title"]
    assert f"報告: <@{alice.id}>" in weekly["body"]
    own = await _canvas(client, cid, template_key="minutes", title="第3回", body="自由に")
    assert (own["title"], own["body"]) == ("第3回", "自由に")
    missing = await _create(client, cid, template_key="nope")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "template_not_found"

    # {{channel}} in a DM is the other person.
    dm = (await client.post(f"{API}/dms", json={"user_ids": [str(carol.id)]})).json()["id"]
    as_user(admin)
    created = await client.post(
        f"{API}/admin/canvas-templates",
        json={"name": "面談", "title": "面談 {{channel}}", "body": "- [ ] {{channel}} と {{date}}"},
    )
    assert created.status_code == 201
    custom = created.json()
    assert custom["key"].startswith("custom_") and custom["builtin"] is False
    as_user(alice)
    note = await _canvas(client, dm, template_key=custom["key"])
    assert note["title"] == "面談 Carol" and note["body"].startswith("- [ ] Carol と ")

    # Administrators manage them; the built-in ones can be hidden but not deleted.
    assert (
        await client.post(
            f"{API}/admin/canvas-templates", json={"name": "x", "title": "x", "body": ""}
        )
    ).status_code == 403
    assert (await client.get(f"{API}/admin/canvas-templates")).status_code == 403
    as_user(admin)
    builtin = next(t for t in listed if t["key"] == "research_plan")
    refused = await client.delete(f"{API}/admin/canvas-templates/{builtin['id']}")
    assert refused.status_code == 409 and refused.json()["error"]["code"] == "template_builtin"
    hidden = await client.patch(
        f"{API}/admin/canvas-templates/{builtin['id']}", json={"hidden": True, "name": "計画"}
    )
    assert hidden.json()["hidden"] is True and hidden.json()["name"] == "計画"
    duplicate = await client.post(
        f"{API}/admin/canvas-templates",
        json={"key": "minutes", "name": "x", "title": "x", "body": ""},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "template_key_taken"
    assert (await client.delete(f"{API}/admin/canvas-templates/{custom['id']}")).status_code == 204
    everything = (await client.get(f"{API}/admin/canvas-templates")).json()
    assert "research_plan" in [t["key"] for t in everything]
    as_user(alice)
    keys = [t["key"] for t in (await client.get(f"{API}/canvas-templates")).json()]
    assert "research_plan" not in keys and custom["key"] not in keys
    gone = await _create(client, cid, template_key="research_plan")
    assert gone.status_code == 404


# --- saving -------------------------------------------------------------------------------------


async def test_direct_save_merge_and_conflict(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "lab")
    await _add(client, cid, bob)
    body = "# 議事録\n## 出席\n加納\n\n## TODO\n- [ ] 予稿\n- [ ] 旅費\n"
    canvas = await _canvas(client, cid, body=body)
    base = canvas["head_rev_id"]

    # A direct save (base = head): a new head, which is the submitted version.
    first = await _save(client, canvas["id"], base, body.replace("加納", "加納、海老"))
    assert first.status_code == 200
    out = first.json()
    assert out["merged"] is False and out["canvas"]["version"] == 2
    assert out["submitted_rev_id"] == out["canvas"]["head_rev_id"] != base

    # Bob wrote on the first version: merged with Alice's save, both edits kept.
    as_user(bob)
    second = await _save(client, canvas["id"], base, body.replace("- [ ] 旅費", "- [x] 旅費"))
    assert second.status_code == 200
    merged = second.json()
    assert merged["merged"] is True
    assert merged["canvas"]["body"] == body.replace("加納", "加納、海老").replace(
        "- [ ] 旅費", "- [x] 旅費"
    )
    assert merged["canvas"]["task_done"] == 1 and merged["canvas"]["version"] == 3
    assert merged["canvas"]["updated_by"] == str(bob.id)
    side = merged["submitted_rev_id"]
    assert side != merged["canvas"]["head_rev_id"]

    # Bob's editor still holds what he sent: his next save is based on the side version.
    as_user(bob)
    bob_text = body.replace("- [ ] 旅費", "- [x] 旅費") + "- [ ] 発表練習\n"
    third = await _save(client, canvas["id"], side, bob_text)
    assert third.status_code == 200 and third.json()["merged"] is True
    assert third.json()["canvas"]["body"].endswith("- [x] 旅費\n- [ ] 発表練習\n")
    assert "加納、海老" in third.json()["canvas"]["body"]

    # The same words changed on both sides: 409 with the head and the conflicting lines.
    head = third.json()["canvas"]
    as_user(alice)
    await _save(client, canvas["id"], head["head_rev_id"], head["body"].replace("予稿", "予稿A"))
    as_user(bob)
    refused = await _save(
        client, canvas["id"], head["head_rev_id"], head["body"].replace("予稿", "予稿B")
    )
    assert refused.status_code == 409
    error = refused.json()["error"]
    assert error["code"] == "canvas_conflict"
    assert error["details"]["head"]["body"] == head["body"].replace("予稿", "予稿A")
    assert error["details"]["conflicts"] == [
        {
            "base": "- [ ] 予稿",
            "ours": "- [ ] 予稿B",
            "theirs": "- [ ] 予稿A",
            "ours_line": 5,
            "theirs_line": 5,
        }
    ]
    assert error["details"]["timed_out"] is False

    # Resolved by the chosen policy, with the same base and a new key.
    both = await _save(
        client,
        canvas["id"],
        head["head_rev_id"],
        head["body"].replace("予稿", "予稿B"),
        on_conflict="both",
    )
    assert both.status_code == 200
    assert "- [ ] 予稿A\n> - [ ] 予稿B\n" in both.json()["canvas"]["body"]
    latest = both.json()["canvas"]
    ours = await _save(
        client,
        canvas["id"],
        head["head_rev_id"],
        head["body"].replace("予稿", "予稿C"),
        on_conflict="ours",
    )
    assert ours.status_code == 200
    assert "- [ ] 予稿C\n" in ours.json()["canvas"]["body"]
    assert ours.json()["canvas"]["version"] == latest["version"] + 1

    # Nothing to change: no new version and no event.
    before = len(await _events(db, "canvas.updated"))
    now = ours.json()["canvas"]
    same = await _save(client, canvas["id"], now["head_rev_id"], now["body"])
    assert same.status_code == 200 and same.json()["canvas"]["version"] == now["version"]
    assert same.json()["submitted_rev_id"] == now["head_rev_id"]
    assert len(await _events(db, "canvas.updated")) == before

    # A base that does not exist (pruned, or another canvas's): 409 with the current version.
    expired = await _save(client, canvas["id"], str(uuid.uuid4()), "x")
    assert expired.status_code == 409
    assert expired.json()["error"]["code"] == "canvas_base_expired"
    assert expired.json()["error"]["details"]["head"]["version"] == now["version"]
    too_long = await _save(client, canvas["id"], now["head_rev_id"], "a" * 100_001)
    assert too_long.status_code == 422


async def test_save_retry_with_the_same_key(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "lab")
    canvas = await _canvas(client, cid, body="one\ntwo\n")
    save_id = key()
    request = {
        "base_rev_id": canvas["head_rev_id"],
        "body": "one\nTWO\n",
        "client_save_id": save_id,
    }
    first = await client.put(f"{API}/canvases/{canvas['id']}/content", json=request)
    retry = await client.put(f"{API}/canvases/{canvas['id']}/content", json=request)
    assert first.status_code == retry.status_code == 200
    assert retry.json() == first.json()
    assert first.json()["canvas"]["version"] == 2

    # A merged save's retry, after someone saved again, returns the version it made.
    head = first.json()["canvas"]["head_rev_id"]
    merged_id = key()
    merged_request = {
        "base_rev_id": canvas["head_rev_id"],
        "body": "zero\none\ntwo\n",
        "client_save_id": merged_id,
    }
    merged = await client.put(f"{API}/canvases/{canvas['id']}/content", json=merged_request)
    assert merged.json()["merged"] is True and merged.json()["canvas"]["body"] == "zero\none\nTWO\n"
    await _save(client, canvas["id"], merged.json()["canvas"]["head_rev_id"], "zero\none\nTWO\n3\n")
    again = await client.put(f"{API}/canvases/{canvas['id']}/content", json=merged_request)
    assert again.status_code == 200
    assert again.json()["submitted_rev_id"] == merged.json()["submitted_rev_id"]
    assert again.json()["merged"] is True
    assert again.json()["canvas"]["body"] == "zero\none\nTWO\n3\n"  # the state now
    assert head != again.json()["canvas"]["head_rev_id"]

    count = await db.execute(
        select(func.count())
        .select_from(CanvasRevision)
        .where(CanvasRevision.canvas_id == uuid.UUID(canvas["id"]))
    )
    # create, save, side + merge, save: the retries added nothing.
    assert count.scalar_one() == 5
    assert len(await _events(db, "canvas.updated")) == 3

    other = await _canvas(client, cid)
    reused = await client.put(
        f"{API}/canvases/{other['id']}/content",
        json={"base_rev_id": other["head_rev_id"], "body": "x", "client_save_id": save_id},
    )
    assert reused.status_code == 409 and reused.json()["error"]["code"] == "idempotency_conflict"


async def test_concurrent_saves_are_serialised_and_merged(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "lab")
    lines = [f"- [ ] 項目 {n}" for n in range(20)]
    canvas = await _canvas(client, cid, body="\n".join(lines))
    base = canvas["head_rev_id"]
    edits = []
    for n in (2, 9, 16):
        changed = list(lines)
        changed[n] = changed[n].replace("[ ]", "[x]")
        edits.append("\n".join(changed))
    results = await asyncio.gather(*(_save(client, canvas["id"], base, e) for e in edits))
    assert [r.status_code for r in results] == [200, 200, 200]
    assert sorted(r.json()["merged"] for r in results) == [False, True, True]
    final = (await client.get(f"{API}/canvases/{canvas['id']}")).json()
    assert final["task_done"] == 3 and final["version"] == 4


async def test_save_rate_limit(
    client: AsyncClient, db: AsyncSession, as_user: Actor, app: FastAPI
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "lab")
    canvas = await _canvas(client, cid)
    app.state.limiters["canvas_save"] = RateLimiter(1)
    assert (await _save(client, canvas["id"], canvas["head_rev_id"], "a")).status_code == 200
    limited = await _save(client, canvas["id"], canvas["head_rev_id"], "b")
    assert limited.status_code == 429 and limited.headers["retry-after"]


# --- permissions (CANVAS.md §4.7) ---------------------------------------------------------------


async def test_members_guests_and_outsiders(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    guest = await make_user(db, "guest", role="guest")
    outsider = await make_user(db, "outsider")
    as_user(alice)
    cid = await _channel(client, "secret", type="private")
    await _add(client, cid, bob, guest)
    canvas = await _canvas(client, cid, body="- [ ] a\n- [ ] b\n")
    url = f"{API}/canvases/{canvas['id']}"

    # Outsiders see nothing, not even through the list of all canvases.
    as_user(outsider)
    for response in (
        await client.get(url),
        await client.get(f"{API}/channels/{cid}/canvases"),
        await _save(client, canvas["id"], canvas["head_rev_id"], "x"),
        await client.get(f"{url}/revisions"),
        await _create(client, cid),
    ):
        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "not_a_member"
    assert (await client.get(f"{API}/canvases")).json()["items"] == []

    # Guests read (and the history) but neither create nor change, not even a tick.
    as_user(guest)
    assert (await client.get(url)).status_code == 200
    assert (await client.get(f"{url}/revisions")).status_code == 200
    for response in (
        await _create(client, cid),
        await _save(client, canvas["id"], canvas["head_rev_id"], "- [x] a\n- [ ] b\n"),
        await client.patch(url, json={"title": "x"}),
        await client.delete(url),
    ):
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "guest_restricted"

    # Removed from the conversation: no longer.
    as_user(alice)
    await client.delete(f"{API}/channels/{cid}/members/{bob.id}")
    as_user(bob)
    assert (await client.get(url)).status_code == 403
    assert (await _save(client, canvas["id"], canvas["head_rev_id"], "x")).status_code == 403


async def test_edit_policy_owners_and_ticking(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    teacher = await make_user(db, "teacher")
    student = await make_user(db, "student")
    other = await make_user(db, "other")
    admin = await make_user(db, "root", role="admin")
    as_user(teacher)
    cid = await _channel(client, "lab")
    await _add(client, cid, student, other, admin)
    as_user(other)  # a member makes it; the channel's owner is the teacher
    canvas = await _canvas(client, cid, body="# ルール\n- [ ] 鍵\n- [ ] 掃除\n")
    url = f"{API}/canvases/{canvas['id']}"

    # Title and policy: the creator, owners and administrators.
    as_user(student)
    refused = await client.patch(url, json={"edit_policy": "owners"})
    assert refused.status_code == 403
    assert refused.json()["error"]["code"] == "canvas_edit_restricted"
    as_user(teacher)
    locked = await client.patch(url, json={"edit_policy": "owners", "title": "ルール"})
    assert locked.status_code == 200 and locked.json()["edit_policy"] == "owners"
    assert locked.json()["version"] == 2
    audit = await db.execute(select(AuditLog).where(AuditLog.action == "canvas.edit_policy"))
    assert audit.scalar_one().details == {"from": "members", "to": "owners"}
    head = locked.json()["head_rev_id"]
    body = locked.json()["body"]

    # Now a member only ticks tasks.
    as_user(student)
    edit = await _save(client, canvas["id"], head, body + "追記\n")
    assert edit.status_code == 403 and edit.json()["error"]["code"] == "canvas_edit_restricted"
    tick = await _save(client, canvas["id"], head, body.replace("- [ ] 鍵", "- [x] 鍵"))
    assert tick.status_code == 200 and tick.json()["canvas"]["task_done"] == 1

    # A tick on an old version merges with what the owners changed meanwhile.
    as_user(teacher)
    reworded = await _save(
        client,
        canvas["id"],
        tick.json()["canvas"]["head_rev_id"],
        tick.json()["canvas"]["body"].replace("掃除", "掃除 (金曜)"),
    )
    assert reworded.status_code == 200
    as_user(other)  # the creator may edit whatever the policy
    creator_edit = await _save(
        client,
        canvas["id"],
        reworded.json()["canvas"]["head_rev_id"],
        reworded.json()["canvas"]["body"] + "- [ ] 戸締まり\n",
    )
    assert creator_edit.status_code == 200
    as_user(student)
    late_tick = await _save(client, canvas["id"], head, body.replace("- [ ] 掃除", "- [x] 掃除"))
    assert late_tick.status_code == 200, late_tick.text
    assert late_tick.json()["canvas"]["body"] == (
        "# ルール\n- [x] 鍵\n- [x] 掃除 (金曜)\n- [ ] 戸締まり\n"
    )
    # Ticking alone cannot take "ours" (that would undo the owners' words).
    ours = await _save(
        client, canvas["id"], head, body.replace("- [ ] 掃除", "- [x] 掃除"), on_conflict="ours"
    )
    assert ours.status_code == 403

    as_user(admin)
    now = (await client.get(url)).json()
    assert (await _save(client, canvas["id"], now["head_rev_id"], "admin")).status_code == 200


async def test_announcement_channel_and_archive(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    owner = await make_user(db, "owner")
    member = await make_user(db, "member")
    as_user(owner)
    cid = await _channel(client, "news")
    await _add(client, cid, member)
    canvas = await _canvas(client, cid, body="- [ ] 読んだ\n")
    await client.patch(f"{API}/channels/{cid}", json={"posting_policy": "owners"})

    as_user(member)
    refused = await _create(client, cid)
    assert refused.status_code == 403 and refused.json()["error"]["code"] == "posting_restricted"
    edit = await _save(client, canvas["id"], canvas["head_rev_id"], "書き換え")
    assert edit.status_code == 403 and edit.json()["error"]["code"] == "posting_restricted"
    tick = await _save(client, canvas["id"], canvas["head_rev_id"], "- [x] 読んだ\n")
    assert tick.status_code == 200

    as_user(owner)
    await client.post(f"{API}/channels/{cid}/archive")
    now = (await client.get(f"{API}/canvases/{canvas['id']}")).json()  # still readable
    for response in (
        await _save(client, canvas["id"], now["head_rev_id"], "x"),
        await _create(client, cid),
        await client.patch(f"{API}/canvases/{canvas['id']}", json={"title": "x"}),
        await client.delete(f"{API}/canvases/{canvas['id']}"),
    ):
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "channel_archived"


async def test_dms(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    guest = await make_user(db, "guest", role="guest")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "shared")
    await _add(client, cid, guest)
    dm = (await client.post(f"{API}/dms", json={"user_ids": [str(guest.id)]})).json()["id"]
    notes = (await client.post(f"{API}/dms", json={"user_ids": [str(alice.id)]})).json()["id"]

    # In a DM every member (a guest too) makes and edits canvases; only the creator deletes.
    as_user(guest)
    plan = await _canvas(client, dm, title="研究計画", body="目的:\n")
    as_user(alice)
    edited = await _save(client, plan["id"], plan["head_rev_id"], "目的: 検証\n")
    assert edited.status_code == 200
    policy = await client.patch(f"{API}/canvases/{plan['id']}", json={"edit_policy": "owners"})
    assert policy.status_code == 200  # stored, but a DM ignores it
    assert (await _save(client, plan["id"], edited.json()["canvas"]["head_rev_id"], "b")).is_success
    refused = await client.delete(f"{API}/canvases/{plan['id']}")
    assert refused.status_code == 403
    as_user(guest)
    assert (await client.delete(f"{API}/canvases/{plan['id']}")).status_code == 204

    # My own notes: nobody else sees them.
    as_user(alice)
    mine = await _canvas(client, notes, template_key=None, title="TODO")
    as_user(bob)
    assert (await client.get(f"{API}/canvases/{mine['id']}")).status_code == 403


# --- trash and history --------------------------------------------------------------------------


async def test_trash_and_restore(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "lab")
    await _add(client, cid, bob)
    tab = await _canvas(client, cid, as_tab=True, title="タブ")
    url = f"{API}/canvases/{tab['id']}"

    as_user(bob)  # neither creator nor owner
    assert (await client.delete(url)).status_code == 403
    as_user(alice)
    assert (await client.delete(url)).status_code == 204
    assert (await client.get(url)).status_code == 404
    assert (await client.delete(url)).status_code == 404
    assert (await _save(client, tab["id"], tab["head_rev_id"], "x")).status_code == 404
    assert (await client.get(f"{API}/channels/{cid}/canvases")).json() == []
    trash = (await client.get(f"{API}/channels/{cid}/canvases", params={"trashed": "true"})).json()
    assert [c["id"] for c in trash] == [tab["id"]] and trash[0]["deleted_at"]

    # Meanwhile another canvas became the tab: the restored one comes back without it.
    replacement = await _canvas(client, cid, as_tab=True)
    restored = await client.post(f"{url}/restore")
    assert restored.status_code == 200
    assert restored.json()["is_channel_tab"] is False and restored.json()["version"] == 3
    assert (await client.post(f"{url}/restore")).status_code == 404
    assert replacement["is_channel_tab"] is True

    actions = (await db.execute(select(AuditLog.action).order_by(AuditLog.id))).scalars().all()
    assert [a for a in actions if a.startswith("canvas.")] == ["canvas.delete", "canvas.restore"]


async def test_history(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "lab")
    await _add(client, cid, bob)
    canvas = await _canvas(client, cid, body="v1\n")
    url = f"{API}/canvases/{canvas['id']}"
    v2 = (await _save(client, canvas["id"], canvas["head_rev_id"], "v1\nv2\n")).json()["canvas"]
    as_user(bob)
    side_save = await _save(client, canvas["id"], canvas["head_rev_id"], "v0\nv1\n")
    v3 = side_save.json()["canvas"]
    assert v3["body"] == "v0\nv1\nv2\n"

    history = (await client.get(f"{url}/revisions")).json()
    assert [r["kind"] for r in history["items"]] == ["merge", "save", "create"]  # no side
    assert [r["version"] for r in history["items"]] == [3, 2, 1]
    assert (history["items"][1]["lines_added"], history["items"][1]["lines_removed"]) == (1, 0)
    assert "body" not in history["items"][0]
    page = (await client.get(f"{url}/revisions", params={"limit": 2})).json()
    assert len(page["items"]) == 2 and page["next_cursor"]
    tail = (
        await client.get(f"{url}/revisions", params={"limit": 2, "cursor": page["next_cursor"]})
    ).json()
    assert [r["kind"] for r in tail["items"]] == ["create"] and tail["next_cursor"] is None
    first = history["items"][2]
    assert (await client.get(f"{url}/revisions/{first['id']}")).json()["body"] == "v1\n"

    # A name for a version; back to an old one as a new version.
    labelled = await client.patch(f"{url}/revisions/{first['id']}", json={"label": " 提出版 "})
    assert labelled.status_code == 200 and labelled.json()["label"] == "提出版"
    restore_id = key()
    restored = await client.post(
        f"{url}/revisions/{first['id']}/restore", json={"client_save_id": restore_id}
    )
    assert restored.status_code == 200
    assert restored.json()["body"] == "v1\n" and restored.json()["version"] == 4
    again = await client.post(
        f"{url}/revisions/{first['id']}/restore", json={"client_save_id": restore_id}
    )
    assert again.json()["version"] == 4  # a retry

    # Erasing a version's body: owners and admins (the creator in a DM); not the current one.
    assert (await client.delete(f"{url}/revisions/{v2['head_rev_id']}")).status_code == 403
    as_user(alice)
    head = await client.delete(f"{url}/revisions/{restored.json()['head_rev_id']}")
    assert head.status_code == 409 and head.json()["error"]["code"] == "canvas_revision_is_head"
    erased = await client.delete(f"{url}/revisions/{v2['head_rev_id']}")
    assert erased.status_code == 200 and erased.json()["kind"] == "erased"
    body = (await client.get(f"{url}/revisions/{v2['head_rev_id']}")).json()["body"]
    assert body == ""
    audit = await db.execute(select(AuditLog).where(AuditLog.action == "canvas.revision_erased"))
    assert audit.scalar_one().details["kind"] == "save"
    # An erased version is neither a base nor something to restore.
    stale = await _save(client, canvas["id"], v2["head_rev_id"], "x")
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "canvas_base_expired"
    gone = await client.post(
        f"{url}/revisions/{v2['head_rev_id']}/restore", json={"client_save_id": key()}
    )
    assert gone.status_code == 409 and gone.json()["error"]["code"] == "canvas_revision_erased"
    elsewhere = await _canvas(client, cid)
    assert (
        await client.get(f"{API}/canvases/{elsewhere['id']}/revisions/{first['id']}")
    ).status_code == 404


# --- events -------------------------------------------------------------------------------------


async def test_events(client: AsyncClient, db: AsyncSession, as_user: Actor) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await make_user(db, "outsider")
    as_user(alice)
    cid = await _channel(client, "lab")
    await _add(client, cid, bob)
    canvas = await _canvas(client, cid, body="secret body")
    url = f"{API}/canvases/{canvas['id']}"
    saved = await _save(client, canvas["id"], canvas["head_rev_id"], "secret body 2")
    await client.patch(url, json={"title": "新しい題名"})
    await client.patch(url, json={"is_channel_tab": True})
    await client.post(
        f"{url}/revisions/{canvas['head_rev_id']}/restore", json={"client_save_id": key()}
    )
    await client.delete(url)
    await client.post(f"{url}/restore")

    rows = await _events(db)
    assert [(r.event_type, r.payload.get("change")) for r in rows] == [
        ("canvas.created", None),
        ("canvas.updated", "content"),
        ("canvas.updated", "title"),
        ("canvas.updated", "settings"),
        ("canvas.updated", "restore"),
        ("canvas.deleted", None),
        ("canvas.created", None),
    ]
    for row in rows:
        assert row.audience_type == "channel" and str(row.channel_id) == cid
        assert row.seq is None  # canvases do not use the channel's seq
        assert "secret" not in str(row.payload)  # metadata only, never the body
    assert [r.payload["canvas"]["version"] for r in rows if "canvas" in r.payload] == [
        1,
        2,
        3,
        4,
        5,
        7,
    ]
    assert rows[1].payload["canvas"]["head_rev_id"] == saved.json()["canvas"]["head_rev_id"]
    assert rows[5].payload == {"canvas_id": canvas["id"], "channel_id": cid}
    audience = await resolve_event_audience(db, rows[1])
    assert set(audience.ids) == {alice.id, bob.id}
    # The channel's seq did not move.
    channel = (await client.get(f"{API}/channels/{cid}")).json()
    assert channel["last_seq"] == 0


async def test_export_includes_canvases(
    client: AsyncClient, db: AsyncSession, as_user: Actor
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "lab")
    await _canvas(client, cid, title="議事録", body="本文")
    lines = await export_channel_lines(db, uuid.UUID(cid))
    assert len(lines) == 1
    assert '"type": "canvas"' in lines[0] and '"body": "本文"' in lines[0]
    assert '"created_by_username": "alice"' in lines[0]
