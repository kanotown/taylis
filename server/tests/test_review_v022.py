"""Review v0.1.22 (server): regression tests for the fixed items. #1 #3 #7 #8 are here, with the
helpers of #2 (the tests are in the two importer test files); #4 is in test_slack_import.py and
#5 in test_video_probe.py."""

import asyncio
import uuid
from collections.abc import Callable
from datetime import date, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.channels.models import Channel, ChannelMember
from app.modules.importer import core
from app.modules.messages import service as messages
from app.modules.messages.models import Message
from app.modules.messages.schemas import MessageCreate
from app.modules.tasks import deadlines
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_canvas_phase2 import _add as canvas_add
from tests.test_canvas_phase2 import _canvas as canvas_create
from tests.test_canvas_phase2 import _channel as canvas_channel
from tests.test_canvas_phase2 import _save as canvas_save
from tests.test_deadlines import DUE, _bot_posts, _deadline, _fire, _jst, _notices
from tests.test_tasks import TASKS, _channel, _drain, _post, _relay

API = "/api/v1"


async def _preview(db: AsyncSession, on: bool) -> None:
    await db.execute(text("UPDATE workspace_settings SET preview_before_join = :on"), {"on": on})
    await db.commit()


# --- #1: a task's source message follows the read rule of messages ------------------------------


async def test_task_source_follows_the_message_read_rule(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    member = await make_user(db, "member")
    outsider = await make_user(db, "outsider")
    guest = await make_user(db, "guest", role="guest")
    admin = await make_user(db, "boss", role="admin")
    as_user(alice)
    general = await _channel(client, "general")
    as_user(member)
    assert (await client.post(f"{API}/channels/{general['id']}/join")).status_code == 200
    as_user(alice)
    message = await _post(client, general["id"], "SECRET: member-only text")

    expected = {
        True: {"alice": True, "member": True, "outsider": True, "guest": False, "boss": True},
        False: {"alice": True, "member": True, "outsider": False, "guest": False, "boss": False},
    }
    for on in (True, False):
        await _preview(db, on)
        for user in (alice, member, outsider, guest, admin):
            as_user(user)
            read = await client.get(f"{API}/messages/{message['id']}")
            made = await client.post(TASKS, json={"title": "t", "source_message_id": message["id"]})
            can_read = read.status_code == 200
            assert can_read == expected[on][user.username], (on, user.username, read.text)
            if can_read:
                assert made.status_code == 201, made.text
                assert made.json()["source"]["excerpt"] == "SECRET: member-only text"
            else:
                assert made.status_code == 404, (on, user.username, made.text)
                assert made.json()["error"]["code"] == "message_not_found"
                assert "SECRET" not in made.text


async def test_edit_after_preview_off_does_not_refresh_an_outsiders_excerpt(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = await _channel(client, "general")
    message = await _post(client, general["id"], "before")
    as_user(bob)  # not a member: the preview lets him read it for now
    made = await client.post(TASKS, json={"title": "t", "source_message_id": message["id"]})
    assert made.status_code == 201 and made.json()["source"]["excerpt"] == "before"
    await _drain(_relay(app, test_settings))

    await _preview(db, False)
    as_user(alice)
    edited = await client.patch(
        f"{API}/messages/{message['id']}", json={"body": "SECRET after the switch"}
    )
    assert edited.status_code == 200, edited.text
    await _drain(_relay(app, test_settings))
    as_user(bob)
    got: dict[str, Any] = (await client.get(f"{TASKS}/{made.json()['id']}")).json()
    assert got["source"]["message_id"] == message["id"]
    assert got["source"]["excerpt"] is None
    assert "SECRET" not in str(got)


# --- #2: an import's later batch does not move a channel's seq back -----------------------------


def interleave_normal_posts(monkeypatch: pytest.MonkeyPatch, app: FastAPI) -> list[uuid.UUID]:
    """One post per import batch, and after each batch a normal post (messages.create_message,
    in its own session) in the channel that batch imported into: the next batch, for another
    channel, used to write that channel's older last_seq back. Returns the channels posted to."""
    monkeypatch.setattr(core, "BATCH", 1)
    original = core.ImportJob._flush_posts
    posted: list[uuid.UUID] = []

    async def flush(self: core.ImportJob) -> None:
        batch = [state.id for state in self.channels.values() if state.in_batch]
        await original(self)
        if self.dry_run or not batch:
            return
        async with app.state.db.session_factory() as session:
            channel = await session.get(Channel, batch[0])
            if channel is None or channel.is_archived:
                return
            member = (
                (
                    await session.execute(
                        select(User)
                        .join(ChannelMember, ChannelMember.user_id == User.id)
                        .where(ChannelMember.channel_id == batch[0], User.deactivated_at.is_(None))
                        .order_by(User.username)
                    )
                )
                .scalars()
                .first()
            )
            if member is None:
                return
            await messages.create_message(
                session,
                member,
                batch[0],
                MessageCreate(client_msg_id=uuid.uuid4(), body="a normal post between batches"),
            )
            posted.append(batch[0])

    monkeypatch.setattr(core.ImportJob, "_flush_posts", flush)
    return posted


async def check_seqs_after_import(app: FastAPI, posted: list[uuid.UUID]) -> None:
    """Every channel's last_seq is its highest message seq, the delta sync ends there, and one
    more normal post takes the next seq."""
    assert posted
    async with app.state.db.session_factory() as session:
        rows = await session.execute(
            select(Channel.id, Channel.last_seq, func.max(Message.seq))
            .join(Message, Message.channel_id == Channel.id)
            .group_by(Channel.id, Channel.last_seq)
        )
        for channel_id, last_seq, top in rows.all():
            assert last_seq == top, (channel_id, last_seq, top)
        for channel_id in set(posted):
            member = (
                (
                    await session.execute(
                        select(User)
                        .join(ChannelMember, ChannelMember.user_id == User.id)
                        .where(
                            ChannelMember.channel_id == channel_id, User.deactivated_at.is_(None)
                        )
                        .order_by(User.username)
                    )
                )
                .scalars()
                .first()
            )
            assert member is not None
            top = await session.scalar(
                select(func.max(Message.seq)).where(Message.channel_id == channel_id)
            )
            delta = await messages.list_delta(session, member, channel_id, since_seq=0, limit=200)
            assert delta.next_since_seq == top and not delta.has_more
            assert any(m.body == "a normal post between batches" for m in delta.messages)
            message, created = await messages.create_message(
                session,
                member,
                channel_id,
                MessageCreate(client_msg_id=uuid.uuid4(), body="after the import"),
            )
            assert created and message.seq == top + 1


# --- #3: erasing a canvas version's body erases the activity excerpts taken from it --------------


async def _events(db: AsyncSession, event_type: str) -> list[OutboxEvent]:
    stmt = (
        select(OutboxEvent)
        .where(OutboxEvent.event_type == event_type)
        .order_by(OutboxEvent.id)
        .execution_options(populate_existing=True)
    )
    return list((await db.execute(stmt)).scalars().all())


async def test_erasing_a_version_blanks_its_activity_excerpts(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    dave = await make_user(db, "dave")
    await db.execute(update(User).values(activity_read_at=utcnow() - timedelta(hours=1)))
    await db.commit()
    with_canvas = {"include": "canvas_mention"}
    as_user(alice)
    cid = await canvas_channel(client, "lab")
    await canvas_add(client, cid, bob, carol, dave)
    canvas = await canvas_create(
        client, cid, f"- [ ] <@{bob.id}> <@{carol.id}> <@{dave.id}> SECRET-TO-ERASE\n"
    )
    secret_rev = canvas["head_rev_id"]
    as_user(bob)  # bob has read his item; dave and carol have not
    read = await client.put(
        f"{API}/activity/read", params=with_canvas, json={"read_at": utcnow().isoformat()}
    )
    assert read.status_code == 200, read.text
    as_user(alice)
    await canvas_save(client, canvas, "clean\n")
    await canvas_save(client, canvas, f"<@{carol.id}> a later line\n")  # carol's item moves on
    later_rev = canvas["head_rev_id"]
    before = len(await _events(db, "activity.updated"))

    erased = await client.delete(f"{API}/canvases/{canvas['id']}/revisions/{secret_rev}")
    assert erased.status_code == 200, erased.text

    items: dict[str, dict[str, Any]] = {}
    for user in (bob, carol, dave):
        as_user(user)
        response = await client.get(f"{API}/activity", params=with_canvas)
        assert "SECRET" not in response.text
        (item,) = response.json()["items"]
        items[user.username] = item["canvas"]
    assert items["bob"]["excerpt"] == "" and items["bob"]["rev_id"] == secret_rev
    assert items["dave"]["excerpt"] == "" and items["dave"]["rev_id"] == secret_rev
    assert items["carol"]["excerpt"] == "@Carol a later line"
    assert items["carol"]["rev_id"] == later_rev
    as_user(dave)  # the item and the badge stay
    summary = (await client.get(f"{API}/activity/summary", params=with_canvas)).json()
    assert summary["unread_count"] == 1 and summary["mention_unread"] is True

    events = (await _events(db, "activity.updated"))[before:]
    assert {e.audience_id: e.payload for e in events} == {
        bob.id: {"item_ids": [items["bob"]["item_id"]]},
        dave.id: {"item_ids": [items["dave"]["item_id"]]},
    }
    assert all(e.audience_type == "user" for e in events)
    # Erasing it again changes nothing and says nothing.
    as_user(alice)
    again = await client.delete(f"{API}/canvases/{canvas['id']}/revisions/{secret_rev}")
    assert again.status_code == 200
    assert len(await _events(db, "activity.updated")) == before + 2


# --- #7: the worker's limit counts deadlines; one post per deadline ------------------------------


async def _backlog(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None], count: int
) -> tuple[str, list[str]]:
    """`count` deadlines on DUE, each with a day-before and a same-day notice: at 10:00 on DUE
    all 2 x count notices have come (the server was down)."""
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await _channel(client, "lab")
    ids = [
        (await _deadline(client, lab["id"], title=f"原稿 {i:02d}", notice_days=[1, 0]))["id"]
        for i in range(count)
    ]
    return lab["id"], ids


async def _check_one_post_each(app: FastAPI, channel_id: str, ids: list[str]) -> None:
    posts = await _bot_posts(app, channel_id)
    titles = sorted(p.body.split("**")[1] for p in posts)
    assert titles == [f"原稿 {i:02d}" for i in range(len(ids))]  # each deadline exactly once
    assert all(p.body.startswith("⏰ 今日が締切です") for p in posts)
    for task_id in ids:
        statuses = {r.days_before: r.status for r in await _notices(app, task_id)}
        assert statuses == {1: "cancelled", 0: "fired"}


async def test_a_backlog_over_the_limit_posts_each_deadline_once(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    channel_id, ids = await _backlog(client, db, as_user, 26)  # 52 notice rows > 50
    at = _jst(DUE, 10)
    assert await _fire(app, at) == 26
    assert await _fire(app, at) == 0
    await _check_one_post_each(app, channel_id, ids)


async def test_small_batches_and_two_workers_never_split_a_deadline(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    channel_id, ids = await _backlog(client, db, as_user, 26)
    at = _jst(DUE, 10)

    async def worker() -> int:
        total = 0
        while True:
            async with app.state.db.session_factory() as session:
                posted = await deadlines.fire_notices(session, now=at, limit=4)
            if posted == 0:
                return total
            total += posted

    totals = await asyncio.gather(worker(), worker())
    assert sum(totals) == 26
    await _check_one_post_each(app, channel_id, ids)


async def test_a_late_day_before_notice_says_today(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """Down from before 9:00 the day before until 8:00 on the day: only the day-before notice
    has come, and the post says what is true now."""
    channel_id, _ = await _backlog(client, db, as_user, 1)
    assert await _fire(app, _jst(DUE, 8)) == 1
    (post,) = await _bot_posts(app, channel_id)
    assert post.body.startswith("⏰ 今日が締切です")


# --- #8: nothing in a deadline's names makes the bot's post a mention ----------------------------


async def test_assignee_names_never_become_mentions(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "boss", role="admin")
    victim = await make_user(db, "victim")
    as_user(admin)
    group = await client.post(
        f"{API}/admin/groups", json={"name": "lab-all", "member_ids": [str(victim.id)]}
    )
    assert group.status_code == 201, group.text
    gid = group.json()["id"]
    names = {
        "u1": f"<@{victim.id}>",
        "u2": f"<@group:{gid}>",
        "u3": "<!channel>",
        "u4": "<!here>",
        "u5": "**山田** 太郎",
        "u6": "山田 花子",
    }
    people = [await make_user(db, username) for username in names]
    for person in people:
        person.display_name = names[person.username]
    await db.commit()
    lab = await _channel(client, "lab")
    for person in [victim, *people]:
        added = await client.post(
            f"{API}/channels/{lab['id']}/members", json={"user_id": str(person.id)}
        )
        assert added.status_code in (200, 201), added.text
    await _deadline(
        client,
        lab["id"],
        title=f"原稿 <@{victim.id}> <!here>",
        notice_days=[1],
        assignee_ids=[str(p.id) for p in people],
    )
    assert await _fire(app, _jst(date(2030, 1, 9))) == 1
    (post,) = await _bot_posts(app, lab["id"])
    assert post.mentioned_user_ids == [] and post.mention_all is False
    assert "<" not in post.body
    assert post.body.startswith("⏰ 明日が締切です: **原稿 @Victim @here** (1/10 (木))")
    line = post.body.split("\n")[1]  # 担当: …
    star, lt = "\uff0a", "\uff1c"  # how plain_name writes * and <
    assert "山田 花子" in line and f"{star}{star}山田{star}{star} 太郎" in line
    assert f"{lt}!channel>" in line and f"{lt}!here>" in line and f"{lt}@{victim.id}>" in line
    # The event clients get says the same.
    async with app.state.db.session_factory() as session:
        event = (
            await session.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "message.created")
                .order_by(OutboxEvent.id.desc())
                .limit(1)
            )
        ).scalar_one()
    sent = event.payload["message"]
    assert sent["id"] == str(post.id)
    assert sent["mentioned_user_ids"] == [] and sent["mention_all"] is False
