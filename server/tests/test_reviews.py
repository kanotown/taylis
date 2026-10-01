"""L9 review requests on top of tasks (REVIEWS.md): DM tasks, MessageOut.tasks and its seq,
GET /tasks/requested and the review pushes."""

from collections.abc import Callable
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_push_planner import add_device
from tests.test_tasks import (
    API,
    TASKS,
    _channel,
    _create,
    _drain,
    _join,
    _move,
    _outbox,
    _patch,
    _post,
    _relay,
    _task_pushes,
)


async def _message(client: AsyncClient, channel_id: str, message_id: str) -> dict[str, Any]:
    page = (await client.get(f"{API}/channels/{channel_id}/messages")).json()
    rows = page["messages"] if isinstance(page, dict) else page
    return next(m for m in rows if m["id"] == message_id)


async def test_a_review_request_in_a_dm_is_shared_and_shown_under_its_message(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    student = await make_user(db, "student")
    prof = await make_user(db, "prof")
    other = await make_user(db, "other")
    as_user(student)
    dm = (await client.post(f"{API}/dms", json={"user_ids": [str(prof.id)]})).json()
    draft = await _post(client, dm["id"], "修論の第 3 章です https://overleaf.example/x")

    # A DM still has no board, and a DM task must come from one of its messages.
    no_board = await client.post(TASKS, json={"channel_id": dm["id"], "title": "x"})
    assert no_board.json()["error"]["code"] == "task_channel_unsupported"
    review_without_message = await client.post(TASKS, json={"title": "x", "kind": "review"})
    assert review_without_message.json()["error"]["code"] == "task_invalid_source"
    outsider = await client.post(
        TASKS,
        json={
            "channel_id": dm["id"],
            "title": "x",
            "source_message_id": draft["id"],
            "assignee_ids": [str(other.id)],
        },
    )
    assert outsider.json()["error"]["code"] == "task_invalid_assignee"

    before = (await _message(client, dm["id"], draft["id"]))["updated_seq"]
    review = await _create(
        client,
        {
            "channel_id": dm["id"],
            "kind": "review",
            "title": "レビュー: 修論の第 3 章",
            "source_message_id": draft["id"],
            "assignee_ids": [str(prof.id)],
            "due_on": "2030-01-10",
        },
    )
    assert review["kind"] == "review" and review["channel_id"] == dm["id"]
    shown = await _message(client, dm["id"], draft["id"])
    assert shown["updated_seq"] > before
    assert shown["tasks"] == [
        {
            "id": review["id"],
            "kind": "review",
            "status": "todo",
            "assignee_ids": [str(prof.id)],
            "due_on": "2030-01-10",
            "owner_id": str(student.id),
        }
    ]
    updated = await _outbox(db, "message.updated")
    assert updated[-1].payload["change"] == "tasks"
    assert updated[-1].payload["message"]["tasks"][0]["id"] == review["id"]

    requested = (await client.get(f"{TASKS}/requested")).json()
    assert [t["id"] for t in requested] == [review["id"]]
    assert (await client.get(TASKS, params={"channel_id": dm["id"]})).status_code == 400

    # The reviewer sees it as theirs and moves it on; only shown fields move the message's seq.
    as_user(prof)
    assert review["id"] in [t["id"] for t in (await client.get(f"{TASKS}/mine")).json()]
    assert (await client.get(f"{TASKS}/requested")).json() == []
    seq = (await _message(client, dm["id"], draft["id"]))["updated_seq"]
    await _patch(client, review["id"], {"notes": "コメントは PDF に"})
    assert (await _message(client, dm["id"], draft["id"]))["updated_seq"] == seq
    await _move(client, review["id"], {"status": "doing"})
    doing = await _message(client, dm["id"], draft["id"])
    assert doing["updated_seq"] > seq and doing["tasks"][0]["status"] == "doing"
    await _patch(client, review["id"], {"status": "done"})
    as_user(student)
    assert (await client.get(f"{TASKS}/requested")).json()[0]["status"] == "done"

    # Deleted: the chip goes, through the same kind of update.
    assert (await client.delete(f"{TASKS}/{review['id']}")).status_code == 204
    assert (await _message(client, dm["id"], draft["id"]))["tasks"] == []
    assert (await _outbox(db, "message.updated"))[-1].payload["message"]["tasks"] == []


async def test_a_personal_task_shows_no_chip_and_a_board_task_does(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = await _channel(client, "general")
    await _join(client, as_user, general["id"], bob)
    as_user(alice)
    post = await _post(client, general["id"], "ポスターの案")
    as_user(bob)
    mine = await _create(client, {"title": "あとで見る", "source_message_id": post["id"]})
    assert mine["channel_id"] is None
    assert (await _message(client, general["id"], post["id"]))["tasks"] == []
    shared = await _create(
        client,
        {"channel_id": general["id"], "title": "印刷", "source_message_id": post["id"]},
    )
    chips = (await _message(client, general["id"], post["id"]))["tasks"]
    assert [(c["id"], c["kind"]) for c in chips] == [(shared["id"], "task")]


async def test_review_pushes(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    student = await make_user(db, "student")
    prof = await make_user(db, "prof")
    await add_device(db, prof)
    await add_device(db, student, token="student-tok")
    as_user(student)
    lab = await _channel(client, "m2-進捗")
    await _join(client, as_user, lab["id"], prof)
    as_user(student)
    post = await _post(client, lab["id"], "学会の予稿です")
    review = await _create(
        client,
        {
            "channel_id": lab["id"],
            "kind": "review",
            "title": "レビュー: 予稿",
            "source_message_id": post["id"],
            "assignee_ids": [str(prof.id)],
        },
    )
    await _drain(_relay(app, test_settings))
    pushes = await _task_pushes(db)
    assert [p["body"] for p in pushes] == [
        "Student がレビューを依頼しました: レビュー: 予稿 (#m2-進捗)"
    ]

    # The requester completing it themselves tells no one; the reviewer completing it does.
    await _move(client, review["id"], {"status": "done"})
    await _move(client, review["id"], {"status": "todo"})
    await _drain(_relay(app, test_settings))
    assert len(await _task_pushes(db)) == 1
    as_user(prof)
    await _move(client, review["id"], {"status": "done"})
    await _drain(_relay(app, test_settings))
    bodies = [p["body"] for p in await _task_pushes(db)]
    assert bodies[1:] == ["Prof がレビューを完了しました: レビュー: 予稿 (#m2-進捗)"]


async def test_review_fixes_due_leave_and_non_member_chips(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    """Review v0.1.15: #5 a due-date-only change, #6 an assignee leaving, #7 a non-member."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    lab = await _channel(client, "lab")
    await _join(client, as_user, lab["id"], bob)
    as_user(alice)
    post = await _post(client, lab["id"], "予稿")
    review = await _create(
        client,
        {
            "channel_id": lab["id"],
            "kind": "review",
            "title": "レビュー: 予稿",
            "source_message_id": post["id"],
            "assignee_ids": [str(bob.id)],
            "due_on": "2030-01-10",
        },
    )
    seq = (await _message(client, lab["id"], post["id"]))["updated_seq"]
    await _patch(client, review["id"], {"due_on": "2030-01-11"})
    moved = await _message(client, lab["id"], post["id"])
    assert moved["updated_seq"] > seq and moved["tasks"][0]["due_on"] == "2030-01-11"
    await _patch(client, review["id"], {"due_on": None})
    cleared = await _message(client, lab["id"], post["id"])
    assert cleared["updated_seq"] > moved["updated_seq"] and cleared["tasks"][0]["due_on"] is None

    # A non-member reading the public post sees no chip (the task itself is 404 for them).
    as_user(carol)
    assert (await client.get(f"{TASKS}/{review['id']}")).status_code == 404
    single = await client.get(f"{API}/messages/{post['id']}")
    assert single.status_code == 200 and single.json()["tasks"] == []

    # The reviewer leaves: the chip drops them, with a new seq.
    as_user(bob)
    assert (await client.post(f"{API}/channels/{lab['id']}/leave")).status_code == 204
    await _drain(_relay(app, test_settings))
    as_user(alice)
    left = await _message(client, lab["id"], post["id"])
    assert left["updated_seq"] > cleared["updated_seq"] and left["tasks"][0]["assignee_ids"] == []


async def test_a_chip_update_carries_the_body_as_it_is_now(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """Review v0.1.15 #1: an edit committed while the task change waits is not undone."""
    from sqlalchemy import update

    from app.modules.messages import service as messages
    from app.modules.messages.models import Message

    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await _channel(client, "lab")
    post = await _post(client, lab["id"], "old sensitive text")
    import uuid as _uuid

    message_id = _uuid.UUID(post["id"])
    async with app.state.db.session_factory() as mine:
        stale = await mine.get(Message, message_id)
        assert stale is not None and stale.body == "old sensitive text"
        async with app.state.db.session_factory() as other:
            await other.execute(
                update(Message).where(Message.id == message_id).values(body="redacted")
            )
            await other.commit()
        out = await messages.announce_change_by_id_in_tx(mine, message_id, "tasks")
        await mine.commit()
    assert out is not None and out.body == "redacted"
    updated = await _outbox(db, "message.updated")
    assert updated[-1].payload["message"]["body"] == "redacted"
