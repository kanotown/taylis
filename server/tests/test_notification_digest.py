"""M192 (PUSH_NOTIFICATIONS.md §18): one summary push of the mentions and DMs a pause held back."""

import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.channels import service as channels
from app.modules.channels.schemas import ChannelCreate
from app.modules.groups import service as groups
from app.modules.groups.schemas import GroupCreate
from app.modules.messages import service as messages
from app.modules.messages.models import Message
from app.modules.messages.schemas import MessageCreate
from app.modules.moderation.models import UserBlock
from app.modules.notifications import digest
from app.modules.notifications.models import NotificationDigestItem, NotificationPreference
from app.modules.notifications.planner import PushPlanner
from app.modules.reads import service as reads
from app.modules.threads import service as threads
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_push_planner import add_device, deliveries, relay_with_planner


async def say(
    db: AsyncSession,
    sender: User,
    channel_id: uuid.UUID,
    body: str = "hi",
    *,
    parent_id: uuid.UUID | None = None,
) -> Message:
    message, _ = await messages.create_message(
        db,
        sender,
        channel_id,
        MessageCreate(client_msg_id=uuid.uuid4(), body=body, parent_id=parent_id),
    )
    return message


async def relay(app: FastAPI, settings: Settings, active: set[uuid.UUID] | None = None) -> None:
    outbox = relay_with_planner(app, settings, active)
    while await outbox.process_batch():
        pass


async def noted(db: AsyncSession) -> list[tuple[uuid.UUID, uuid.UUID]]:
    rows = await db.execute(
        select(NotificationDigestItem.user_id, NotificationDigestItem.message_id).order_by(
            NotificationDigestItem.id
        )
    )
    return [(row[0], row[1]) for row in rows.all()]


def planner_of(settings: Settings, active: set[uuid.UUID] | None = None) -> PushPlanner:
    return PushPlanner(settings, is_active=lambda uid: uid in (active or set()))


async def paused(db: AsyncSession, user: User, until: datetime | None = None) -> datetime:
    """取り込み中 / 通知を一時停止 until `until` (default: in 30 minutes)."""
    user.dnd_until = until or utcnow() + timedelta(minutes=30)
    await db.commit()
    return user.dnd_until


def quiet_hours_around_now(user: User) -> datetime:
    """Quiet hours from an hour ago to an hour from now (UTC); returns when they end."""
    now = utcnow()
    minutes = now.hour * 60 + now.minute
    user.quiet_hours_start = (minutes - 60) % (24 * 60)
    user.quiet_hours_end = (minutes + 60) % (24 * 60)
    user.quiet_hours_days = None
    user.quiet_hours_tz = "UTC"
    return now.replace(second=0, microsecond=0) + timedelta(minutes=60)


async def test_a_dm_in_a_pause_is_noted_and_summed_up_once_when_the_pause_ends(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    await add_device(db, bob, token="tok-android", platform="android")
    await add_device(db, bob, token=None)  # desktop: no push, no summary
    until = await paused(db, bob)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    first = await say(db, alice, dm.id, "起きたら見て")
    await say(db, alice, dm.id, "もう一つ")
    await relay(app, test_settings)
    assert await deliveries(db) == []  # the pause holds the pushes back (§4)
    notes = await noted(db)
    assert len(notes) == 2 and notes[0] == (bob.id, first.id)

    planner = planner_of(test_settings)
    assert await digest.send_due(db, planner, now=utcnow()) == 0  # still paused
    assert len(await noted(db)) == 2
    assert await digest.send_due(db, planner, now=until + timedelta(seconds=1)) == 1
    rows = await deliveries(db)
    assert len(rows) == 2 and {r.user_id for r in rows} == {bob.id}
    assert rows[0].event_id == rows[1].event_id < 0  # the summary's own key, never an outbox id
    payload = rows[0].payload
    assert payload["kind"] == "digest" and payload["collapse_key"] == "digest"
    assert rows[0].collapse_key == "digest" and rows[0].channel_id is None
    assert payload["title"] == "通知を止めていた間に"
    assert payload["body"] == "DM 2 件：Alice"
    assert payload["channel_id"] is None and payload["badge"] >= 1
    assert await noted(db) == []
    # Taken once: another round sends nothing more.
    assert await digest.send_due(db, planner, now=until + timedelta(minutes=1)) == 0
    assert len(await deliveries(db)) == 2


async def test_only_what_the_pause_alone_held_back_and_addresses_me_is_noted(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")  # level mentions by default (make_user)
    carol = await make_user(db, "carol")  # looking at the app
    dave = await make_user(db, "dave")  # the summary turned off
    erin = await make_user(db, "erin")  # no phone
    frank = await make_user(db, "frank")  # level all in #lab
    lab = await channels.create_channel(db, alice, ChannelCreate(name="lab"))
    quiet = await channels.create_channel(db, alice, ChannelCreate(name="quiet"))
    muted = await channels.create_channel(db, alice, ChannelCreate(name="muted"))
    for person in (bob, carol, dave, erin, frank):
        await channels.join_channel(db, person, lab.id)
        await paused(db, person)
        if person is not erin:
            await add_device(db, person, token=f"tok-{person.username}")
    for channel in (quiet, muted):
        await channels.join_channel(db, bob, channel.id)
    db.add(NotificationPreference(user_id=frank.id, channel_id=lab.id, level="all"))
    db.add(NotificationPreference(user_id=bob.id, channel_id=quiet.id, level="none"))
    db.add(NotificationPreference(user_id=bob.id, channel_id=muted.id, level="all", muted=True))
    dave.notify_digest = False
    await db.commit()
    group = await groups.create(
        db, alice, GroupCreate(name="students", member_ids=[bob.id, frank.id])
    )

    plain = await say(db, alice, lab.id, "おはよう")  # would push frank (all) but addresses no one
    named = await say(db, alice, lab.id, f"<@{bob.id}> <@{carol.id}> <@{dave.id}> <@{erin.id}>")
    here = await say(db, alice, lab.id, "<!here> 集合")
    grouped = await say(db, alice, lab.id, f"<@group:{group.id}> 提出")
    await say(db, alice, quiet.id, f"<@{bob.id}> level none")
    await say(db, alice, muted.id, f"<@{bob.id}> muted")
    await relay(app, test_settings, active={carol.id})

    assert await deliveries(db) == []
    rows = await noted(db)
    assert set(rows) == {
        (bob.id, named.id),
        (bob.id, here.id),
        (frank.id, here.id),
        (bob.id, grouped.id),
        (frank.id, grouped.id),
    }
    assert all(message != plain.id for _, message in rows)


async def test_re_processing_the_event_notes_once(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    await paused(db, bob)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    await say(db, alice, dm.id)
    await relay(app, test_settings)
    await db.execute(update(OutboxEvent).values(processed_at=None))  # a crash after the handler
    await db.commit()
    await relay(app, test_settings)
    assert len(await noted(db)) == 1


async def test_quiet_hours_end_but_a_later_pause_waits_for_its_end(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    lab = await channels.create_channel(db, alice, ChannelCreate(name="lab"))
    await channels.join_channel(db, bob, lab.id)
    quiet_end = quiet_hours_around_now(bob)
    await db.commit()
    await say(db, alice, lab.id, f"<@{bob.id}> 夜のうちに")
    await relay(app, test_settings)
    assert await deliveries(db) == [] and len(await noted(db)) == 1

    planner = planner_of(test_settings)
    assert await digest.send_due(db, planner, now=quiet_end - timedelta(minutes=1)) == 0
    # Quiet hours are over, but 取り込み中 was set until later: wait for that too.
    dnd_end = await paused(db, bob, quiet_end + timedelta(hours=2))
    assert await digest.send_due(db, planner, now=quiet_end + timedelta(minutes=1)) == 0
    assert len(await noted(db)) == 1
    assert await digest.send_due(db, planner, now=dnd_end + timedelta(minutes=1)) == 1
    rows = await deliveries(db)
    assert len(rows) == 1 and rows[0].payload["body"] == "メンション 1 件：Alice（#lab）"


async def test_ending_dnd_by_hand_sends_the_summary(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    await paused(db, bob, utcnow() + timedelta(hours=8))
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    await say(db, alice, dm.id)
    await relay(app, test_settings)
    planner = planner_of(test_settings)
    assert await digest.send_due(db, planner) == 0
    as_user(bob)
    ended = await client.patch("/api/v1/users/me", json={"dnd_until": None})
    assert ended.status_code == 200 and ended.json()["dnd_until"] is None
    await db.refresh(bob)
    assert await digest.send_due(db, planner) == 1
    assert [r.payload["kind"] for r in await deliveries(db)] == ["digest"]


async def test_deleted_read_left_and_blocked_are_dropped_before_sending(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    await add_device(db, bob)
    until = await paused(db, bob)
    lab = await channels.create_channel(db, alice, ChannelCreate(name="lab"))
    other = await channels.create_channel(db, alice, ChannelCreate(name="other"))
    for channel in (lab, other):
        await channels.join_channel(db, bob, channel.id)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    carol_dm, _ = await channels.get_or_create_dm(db, carol, [bob])

    read = await say(db, alice, lab.id, f"<@{bob.id}> 読んだ")
    parent = await say(db, alice, lab.id, "スレッド")
    reply = await say(db, alice, lab.id, f"<@{bob.id}> 返信", parent_id=parent.id)
    await say(db, alice, other.id, f"<@{bob.id}> 抜けた")
    gone = await say(db, alice, dm.id, "消す")
    await say(db, carol, carol_dm.id, "ブロックされる")
    kept = await say(db, alice, dm.id, "残る")
    await relay(app, test_settings)
    assert len(await noted(db)) == 6

    await messages.delete_message(db, alice, gone.id)
    lab_row = await channels.require_channel(db, lab.id)
    await reads.advance_in_tx(db, bob.id, lab.id, read.seq, last_seq=lab_row.last_seq)
    await threads.mark_read(db, parent, bob.id, reply.seq)  # the reply is read by its thread
    await channels.leave_channel(db, bob, other.id)
    db.add(UserBlock(blocker_id=bob.id, blocked_id=carol.id))
    await db.commit()

    planner = planner_of(test_settings)
    assert await digest.send_due(db, planner, now=until + timedelta(seconds=1)) == 1
    rows = await deliveries(db)
    assert len(rows) == 1 and rows[0].payload["body"] == "DM 1 件：Alice"
    assert await noted(db) == []
    assert kept.id is not None

    # Nothing left to tell: no push, and the notes go all the same.
    await paused(db, bob, until + timedelta(hours=1))
    late = await say(db, alice, dm.id, "あとで読む")
    await relay(app, test_settings)
    assert len(await noted(db)) == 1
    dm_row = await channels.require_channel(db, dm.id)
    await reads.advance_in_tx(db, bob.id, dm.id, late.seq, last_seq=dm_row.last_seq)
    await db.commit()
    assert await digest.send_due(db, planner, now=until + timedelta(hours=2)) == 0
    assert len(await deliveries(db)) == 1 and await noted(db) == []


async def test_looking_at_the_app_when_the_pause_ends_clears_without_a_push(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    until = await paused(db, bob)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    await say(db, alice, dm.id)
    await relay(app, test_settings)
    assert len(await noted(db)) == 1
    planner = planner_of(test_settings, active={bob.id})
    assert await digest.send_due(db, planner, now=until + timedelta(seconds=1)) == 0
    assert await deliveries(db) == [] and await noted(db) == []


async def test_the_setting(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    until = await paused(db, bob)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    await say(db, alice, dm.id, "noted")
    await relay(app, test_settings)
    assert len(await noted(db)) == 1

    as_user(bob)
    assert (await client.get("/api/v1/users/me")).json()["notify_digest"] is True
    off = await client.patch("/api/v1/users/me", json={"notify_digest": False})
    assert off.status_code == 200 and off.json()["notify_digest"] is False
    await db.refresh(bob)
    # Off: nothing more is noted, and what was noted goes without a push.
    await say(db, alice, dm.id, "not noted")
    await relay(app, test_settings)
    assert len(await noted(db)) == 1
    later = until + timedelta(seconds=1)
    assert await digest.send_due(db, planner_of(test_settings), now=later) == 0
    assert await deliveries(db) == [] and await noted(db) == []
    on = await client.patch("/api/v1/users/me", json={"notify_digest": True})
    assert on.json()["notify_digest"] is True


async def test_the_text_lists_people_and_conversations_shortly_in_each_language(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    dave = await make_user(db, "dave")
    phone = await add_device(db, bob)
    until = await paused(db, bob)
    meeting = await channels.create_channel(db, alice, ChannelCreate(name="研究ミーティング"))
    for person in (bob, carol, dave):
        await channels.join_channel(db, person, meeting.id)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    await say(db, alice, meeting.id, f"<@{bob.id}> 資料")
    await say(db, carol, meeting.id, f"<@{bob.id}> 確認")
    await say(db, alice, dm.id, "あとで")
    await say(db, dave, meeting.id, f"<@{bob.id}> 日程")
    await relay(app, test_settings)

    planner = planner_of(test_settings)
    assert await digest.send_due(db, planner, now=until + timedelta(seconds=1)) == 1
    body = (await deliveries(db))[0].payload["body"]
    assert body == "メンション 4 件：Alice、Carol ほか（#研究ミーティング、DM）"

    # The same in English (the device's language), and without content.
    phone.locale = "en"
    await paused(db, bob, until + timedelta(hours=1))
    await say(db, carol, meeting.id, f"<@{bob.id}> again")
    await relay(app, test_settings)
    assert await digest.send_due(db, planner, now=until + timedelta(hours=2)) == 1
    english = (await deliveries(db))[-1].payload
    assert english["title"] == "While notifications were paused"
    assert english["body"] == "Mentions (1): Carol (#研究ミーティング)"
    phone.locale = None
    await paused(db, bob, until + timedelta(hours=3))
    for text in ("1", "2", "3"):
        await say(db, alice, meeting.id, f"<@{bob.id}> {text}")
    await relay(app, test_settings)
    hidden = planner_of(test_settings.model_copy(update={"push_include_content": False}))
    assert await digest.send_due(db, hidden, now=until + timedelta(hours=4)) == 1
    payload = (await deliveries(db))[-1].payload
    assert payload["body"] == "通知を止めていた間にメンションが 3 件あります"
    assert payload["title"] == "通知を止めていた間に"
    # Each summary has its own key.
    assert len({r.event_id for r in await deliveries(db)}) == 3


def test_summary_text_rules() -> None:
    two = [("mention", "田中 一郎", "#研究ミーティング"), ("dm", "高橋 健太", "DM")]
    assert (
        digest.summary(two, "ja", include_content=True)
        == "メンション 2 件：田中 一郎、高橋 健太（#研究ミーティング、DM）"
    )
    same = [("dm", "田中 一郎", "DM")] * 3
    assert digest.summary(same, "ja", include_content=True) == "DM 3 件：田中 一郎"
    assert digest.summary(same, "ja", include_content=False) == (
        "通知を止めていた間に DM が 3 件あります"
    )
    many = [("mention", f"P{i}", f"#c{i}") for i in range(4)]
    chinese = digest.summary(many, "zh-Hans", include_content=True)
    assert chinese == "4 条提及：P0、P1 等（#c0、#c1 等）"
    long = [("mention", "名" * 80, "#" + "c" * 80), ("mention", "前" * 80, "#" + "d" * 80)]
    assert len(digest.summary(long, "ja", include_content=True)) == 240


async def test_a_deactivated_person_is_cleared_without_a_push(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    await paused(db, bob)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    await say(db, alice, dm.id)
    await relay(app, test_settings)
    bob.deactivated_at = datetime(2026, 11, 18, tzinfo=UTC)
    await db.commit()
    assert await digest.send_due(db, planner_of(test_settings)) == 0
    assert await deliveries(db) == [] and await noted(db) == []


async def test_one_persons_failure_keeps_their_notes_and_does_not_hold_up_the_rest(
    app: FastAPI, db: AsyncSession, test_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    until = utcnow() + timedelta(minutes=30)
    for person in (bob, carol):
        await add_device(db, person, token=f"tok-{person.username}")
        await paused(db, person, until)
        dm, _ = await channels.get_or_create_dm(db, alice, [person])
        await say(db, alice, dm.id)
    await relay(app, test_settings)
    plan = digest._plan

    async def failing_for_bob(
        db: AsyncSession, planner: PushPlanner, user: User, *rest: Any
    ) -> bool:
        if user.username == "bob":
            raise RuntimeError("boom")
        return await plan(db, planner, user, *rest)

    monkeypatch.setattr(digest, "_plan", failing_for_bob)
    later = until + timedelta(seconds=1)
    bob_id, carol_id = bob.id, carol.id  # the rollback expires the session's rows
    assert await digest.send_due(db, planner_of(test_settings), now=later) == 1
    assert [r.user_id for r in await deliveries(db)] == [carol_id]
    assert [user for user, _ in await noted(db)] == [bob_id]  # kept for the next round
    monkeypatch.setattr(digest, "_plan", plan)
    assert await digest.send_due(db, planner_of(test_settings), now=later) == 1
    assert {r.user_id for r in await deliveries(db)} == {bob_id, carol_id}
    assert await noted(db) == []
