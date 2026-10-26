"""備品 L3 (M169, docs/LENDING.md §6.6, §6.7, §8, §14): the notices. The borrower's reminders (the
day before, on the due date, every morning after; a new due date starts again; a return stops
them; after a downtime only today's), the keepers' morning summary (one a keeper a day, from
keeper_overdue_days, the deactivated borrowers' loans too; the administrators when nobody keeps
the equipment), the worker started twice, the push (`kind = lending`, collapse_key, nothing
during quiet hours while the activity item stays), `include=lending`, the notices of a return
(an issue, a keeper recording it, the watchers) and of a keeper's new due date, and the watches."""

import asyncio
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
from app.events.outbox import OutboxRelay
from app.modules.activity import service as activity_service
from app.modules.channels import service as channels
from app.modules.lending import notices, service
from app.modules.lending.models import LendingNotice, LendingWatch
from app.modules.notifications import planner as planner_module
from app.modules.users.models import User
from tests.lending_helpers import API, Clock, LoanLab, _code, _ok, freeze, make_lab
from tests.test_outbox import RecordingBus
from tests.test_push_planner import add_device, deliveries, relay_with_planner

INCLUDE = {"include": "lending"}


def jst(month: int, day: int, hour: int, minute: int = 0) -> datetime:
    """A moment in Tokyo (UTC+9) in 2026, as UTC."""
    return datetime(2026, month, day, hour, minute, tzinfo=UTC) - timedelta(hours=9)


async def _tick(app: FastAPI, now: datetime) -> int:
    async with app.state.db.session_factory() as session:
        return await notices.tick(session, now=now)


async def _notices(db: AsyncSession, user: User) -> list[LendingNotice]:
    rows = await db.execute(
        select(LendingNotice)
        .where(LendingNotice.user_id == user.id)
        .order_by(LendingNotice.at, LendingNotice.id)
        .execution_options(populate_existing=True)
    )
    return list(rows.scalars().all())


async def _keys(db: AsyncSession, user: User) -> list[str]:
    return [n.key for n in await _notices(db, user)]


async def _relay(app: FastAPI, settings: Settings) -> None:
    relay = relay_with_planner(app, settings)
    while await relay.process_batch():
        pass


async def _lab(
    db: AsyncSession,
    client: AsyncClient,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[LoanLab, Clock]:
    clock = freeze(monkeypatch)
    monkeypatch.setattr(planner_module, "utcnow", clock)
    return await make_lab(db, client, as_user), clock


# --- the borrower's reminders -------------------------------------------------------------------


async def test_reminders_before_on_and_after_the_due_date(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab, clock = await _lab(db, client, as_user, monkeypatch)
    item = await lab.item(code="CAM-02")
    loan = await lab.borrow(lab.member, item["id"], due=2)  # 10/28, borrowed 10/26 at noon
    lid = loan["id"]

    # Borrowed after this morning's time: nothing today; tomorrow not before 9:00.
    assert await _tick(app, jst(10, 26, 23)) == 0
    assert await _tick(app, jst(10, 27, 8, 59)) == 0
    assert await _tick(app, jst(10, 27, 9)) == 1
    assert await _tick(app, jst(10, 27, 9, 1)) == 0  # once per key
    (before,) = await _notices(db, lab.member)
    assert before.key == f"due:{lid}:2026-10-28:-1" and before.role == "borrower"
    assert before.text == "📦 「カメラ A（CAM-02）」は明日（10/28）が返す日です。延長もできます。"
    assert str(before.loan_id) == lid and str(before.item_id) == item["id"]

    assert await _tick(app, jst(10, 28, 10)) == 1
    assert await _tick(app, jst(10, 29, 9)) == 1
    assert await _tick(app, jst(10, 30, 9)) == 1
    texts = [n.text for n in await _notices(db, lab.member)]
    assert texts[1] == "📦 「カメラ A（CAM-02）」は今日が返す日です。"
    assert texts[3].startswith("⏰ 「カメラ A（CAM-02）」の返す日（10/28）を 2 日過ぎています。")
    assert await _keys(db, lab.member) == [
        f"due:{lid}:2026-10-28:-1",
        f"due:{lid}:2026-10-28:0",
        f"due:{lid}:2026-10-28:1",
        f"due:{lid}:2026-10-28:2",
    ]

    # Extended at 10:00 to 10/31: nothing more today; the new date starts from the day before.
    clock.now = jst(10, 30, 10)
    await _ok(await lab.extend(lab.member, lid, 5))  # 10/26 + 5 = 10/31
    assert await _tick(app, jst(10, 30, 11)) == 0
    assert await _tick(app, jst(10, 31, 9)) == 1
    assert (await _keys(db, lab.member))[-1] == f"due:{lid}:2026-10-31:0"

    # Returned: no more reminders.
    clock.now = jst(10, 31, 12)
    await _ok(await lab.give_back(lab.member, lid))
    assert await _tick(app, jst(11, 1, 9)) == 0
    assert await _tick(app, jst(11, 9, 9)) == 0


async def test_after_a_downtime_only_todays_reminder(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab, _ = await _lab(db, client, as_user, monkeypatch)
    item = await lab.item()
    loan = await lab.borrow(lab.member, item["id"], due=1)  # 10/27
    # The server was down from 10/26 until 10/31 at 15:00: one reminder, 4 days past (and the
    # keeper's summary of today).
    assert await _tick(app, jst(10, 31, 15)) == 2
    assert await _keys(db, lab.keeper) == ["overdue:2026-10-31"]
    (only,) = await _notices(db, lab.member)
    assert only.key == f"due:{loan['id']}:2026-10-27:4"
    assert "4 日過ぎています" in only.text


async def test_the_worker_started_twice_writes_once(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab, _ = await _lab(db, client, as_user, monkeypatch)
    for n in range(3):
        item = await lab.item(name=f"本 {n}")
        await lab.borrow(lab.member if n % 2 == 0 else lab.bob, item["id"], due=0)
    moment = jst(10, 30, 9)  # 4 days past: the keeper's summary too
    counts = await asyncio.gather(_tick(app, moment), _tick(app, moment), _tick(app, moment))
    assert sum(counts) == 4  # 3 reminders + 1 summary
    assert len(await _notices(db, lab.member)) == 2
    assert len(await _notices(db, lab.bob)) == 1
    assert await _keys(db, lab.keeper) == ["overdue:2026-10-30"]
    events = await db.scalars(select(OutboxEvent).where(OutboxEvent.event_type == "lending.notice"))
    assert len(list(events)) == 4


async def test_nothing_while_the_feature_is_off(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab, _ = await _lab(db, client, as_user, monkeypatch)
    item = await lab.item()
    await lab.borrow(lab.member, item["id"], due=0)
    await lab.enable(enabled=False)
    assert await _tick(app, jst(10, 30, 9)) == 0
    assert await _notices(db, lab.member) == []


# --- the keepers' morning summary -------------------------------------------------------------


async def test_keepers_summary_once_a_morning_and_fallback_to_admins(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab, clock = await _lab(db, client, as_user, monkeypatch)
    camera = await lab.item(code="CAM-02")
    pc = await lab.item(name="PC-03")
    await lab.borrow(lab.member, camera["id"], due=1)  # 10/27
    await lab.borrow(lab.bob, pc["id"], due=2)  # 10/28

    await _tick(app, jst(10, 29, 9))  # 2 and 1 days past: below keeper_overdue_days (3)
    assert await _keys(db, lab.keeper) == []
    await _tick(app, jst(10, 30, 9))
    (summary,) = await _notices(db, lab.keeper)
    assert summary.key == "overdue:2026-10-30" and summary.role == "keeper"
    assert summary.item_id is None and summary.loan_id is None
    assert summary.text == (
        "⏰ 返す日を 3 日以上過ぎた貸し出しが 1 件あります："
        "Alice さん「カメラ A（CAM-02）」（3 日）。"
    )
    # The administrators are not told while someone keeps the equipment.
    assert await _keys(db, lab.admin) == []
    await _tick(app, jst(10, 30, 18))
    assert len(await _notices(db, lab.keeper)) == 1
    # The same set as the bootstrap's keeper_attention_count.
    clock.now = jst(10, 31, 9)
    keeper_view = await service.bootstrap(db, lab.keeper)
    assert keeper_view is not None and keeper_view.keeper_attention_count == 2
    await _tick(app, jst(10, 31, 9))
    latest = (await _notices(db, lab.keeper))[-1]
    assert latest.key == "overdue:2026-10-31"
    assert (
        "2 件" in latest.text
        and "（4 日）" in latest.text
        and "Bob さん「PC-03」（3 日）" in latest.text
    )

    # A deactivated borrower's loan is listed whatever its days (the mixed heading).
    third = await lab.item(name="三脚")
    carol = await _person(db, "carol")
    await lab.borrow(carol, third["id"], due=10)
    await db.execute(update(User).where(User.id == carol.id).values(deactivated_at=utcnow()))
    await db.commit()
    await _tick(app, jst(11, 1, 9))
    latest = (await _notices(db, lab.keeper))[-1]
    assert latest.text.startswith("⏰ 備品係の確認が要る貸し出しが 3 件あります：")
    assert "Carol さん「三脚」（無効化されたアカウント）" in latest.text

    # Nobody keeps the equipment (the keeper deactivated): the administrators get it.
    await db.execute(update(User).where(User.id == lab.keeper.id).values(deactivated_at=utcnow()))
    await db.commit()
    await _tick(app, jst(11, 2, 9))
    assert await _keys(db, lab.admin) == ["overdue:2026-11-02"]
    assert (await _keys(db, lab.keeper))[-1] == "overdue:2026-11-01"


async def _person(db: AsyncSession, name: str) -> User:
    from tests.helpers import make_user

    return await make_user(db, name)


async def test_keepers_summary_push_and_a_former_keeper(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
    test_settings: Settings,
) -> None:
    lab, clock = await _lab(db, client, as_user, monkeypatch)
    second = await _person(db, "kee2")
    await lab.enable(keeper_ids=[str(lab.keeper.id), str(second.id)])
    await add_device(db, lab.keeper, "kee-tok")
    await add_device(db, second, "kee2-tok")
    item = await lab.item()
    await lab.borrow(lab.member, item["id"], due=0)
    clock.now = jst(10, 29, 9)
    await _tick(app, clock.now)
    # The second keeper is taken off the list before the relay runs: no push, no event for them.
    await lab.enable(keeper_ids=[str(lab.keeper.id)])
    bus = RecordingBus()
    planner = planner_module.PushPlanner(test_settings, is_active=lambda uid: False)
    relay = OutboxRelay(app.state.db, bus, channels.resolve_event_audience, handlers=[planner])
    while await relay.process_batch():
        pass
    pushes = [d for d in await deliveries(db) if d.payload.get("kind") == "lending"]
    assert [d.user_id for d in pushes] == [lab.keeper.id]
    assert pushes[0].payload["collapse_key"] == "lending:overdue"
    assert pushes[0].payload["loan_id"] is None and pushes[0].payload["title"] == "備品"
    told = {uid for e in bus.published if e.event == "lending.notice" for uid in e.audience.ids}
    assert told == {lab.keeper.id, lab.member.id}  # the keeper's summary, the borrower's reminder


# --- the push and the activity ----------------------------------------------------------------


async def test_push_collapse_key_quiet_hours_and_include(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
    test_settings: Settings,
) -> None:
    lab, clock = await _lab(db, client, as_user, monkeypatch)
    await add_device(db, lab.member, "alice-tok")
    item = await lab.item()
    loan = await lab.borrow(lab.member, item["id"], due=1)
    clock.now = jst(10, 27, 9)
    await _tick(app, clock.now)
    await _relay(app, test_settings)
    (push,) = [d for d in await deliveries(db) if d.payload.get("kind") == "lending"]
    assert push.user_id == lab.member.id
    assert push.payload["collapse_key"] == f"lending:loan:{loan['id']}"
    assert push.payload["loan_id"] == loan["id"]
    assert push.payload["lending_item_id"] == item["id"]
    assert push.payload["channel_id"] is None
    assert push.payload["title"] == "備品" and push.payload["body"].startswith(
        "📦 「カメラ A」は今日"
    )

    # Quiet hours until 10:00: the item is written, no push (and none later).
    await db.execute(
        update(User)
        .where(User.id == lab.member.id)
        .values(quiet_hours_start=22 * 60, quiet_hours_end=10 * 60, quiet_hours_tz="Asia/Tokyo")
    )
    await db.commit()
    clock.now = jst(10, 28, 9)
    assert await _tick(app, clock.now) == 1, await _keys(db, lab.member)
    await _relay(app, test_settings)
    clock.now = jst(10, 28, 11)
    await _relay(app, test_settings)
    assert len([d for d in await deliveries(db) if d.payload.get("kind") == "lending"]) == 1

    as_user(lab.member)
    feed = (await _ok(await client.get(f"{API}/activity", params=INCLUDE)))["items"]
    assert [i["kind"] for i in feed] == ["lending", "lending"]
    newest = feed[0]["lending"]
    assert newest["loan_id"] == loan["id"] and newest["lending_item_id"] == item["id"]
    assert newest["item_name"] == "カメラ A" and newest["role"] == "borrower"
    assert newest["done"] is False and newest["text"].startswith("⏰")
    assert feed[0]["read"] is False
    summary = await _ok(await client.get(f"{API}/activity/summary", params=INCLUDE))
    assert summary["unread_count"] == 2 and summary["mention_unread"] is True
    # Clients that do not name the kind get none of it.
    assert (await _ok(await client.get(f"{API}/activity")))["items"] == []
    assert (await _ok(await client.get(f"{API}/activity/summary")))["unread_count"] == 0
    # Opened one by one, it is read.
    monkeypatch.setattr(activity_service, "utcnow", clock)
    await _ok(await client.put(f"{API}/activity/items/read", json={"item_ids": [feed[0]["id"]]}))
    summary = await _ok(await client.get(f"{API}/activity/summary", params=INCLUDE))
    assert summary["unread_count"] == 1


async def test_a_reminder_made_moot_before_the_relay_is_not_pushed(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
    test_settings: Settings,
) -> None:
    lab, clock = await _lab(db, client, as_user, monkeypatch)
    await add_device(db, lab.member, "alice-tok")
    item = await lab.item()
    loan = await lab.borrow(lab.member, item["id"], due=1)
    clock.now = jst(10, 27, 9)
    await _tick(app, clock.now)
    await _ok(await lab.give_back(lab.member, loan["id"]))
    await _relay(app, test_settings)
    assert [d for d in await deliveries(db) if d.payload.get("kind") == "lending"] == []


# --- a return, a keeper's due date, the watches -----------------------------------------------


async def test_return_notices_issue_keeper_and_watchers(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab, _ = await _lab(db, client, as_user, monkeypatch)
    item = await lab.item(code="CAM-02")
    loan = await lab.borrow(lab.member, item["id"], due=3)
    lid = loan["id"]

    # Bob watches it; the borrower sees it is awaited.
    as_user(lab.bob)
    assert (await client.put(f"{API}/lending/items/{item['id']}/watch")).status_code == 204
    assert (await client.put(f"{API}/lending/items/{item['id']}/watch")).status_code == 204
    detail = await _ok(await client.get(f"{API}/lending/items/{item['id']}"))
    assert detail["watching"] is True and detail["watcher_count"] == 1
    listed = await _ok(await client.get(f"{API}/lending/items"))
    assert listed[0]["watching"] is True
    as_user(lab.member)
    detail = await _ok(await client.get(f"{API}/lending/items/{item['id']}"))
    assert detail["watching"] is False and detail["watcher_count"] == 1

    # The borrower's own extension tells nobody; a keeper moving the date tells the borrower.
    await _ok(await lab.extend(lab.member, lid, 5))
    assert await _notices(db, lab.member) == []
    await _ok(await lab.extend(lab.keeper, lid, 40))
    (moved,) = await _notices(db, lab.member)
    assert moved.key == f"due_changed:{lid}:2026-12-05"
    assert moved.text == "🗓 備品係の Kee さんが「カメラ A（CAM-02）」の返す日を 12/5 に変えました。"

    # The keeper records the return with an issue: the borrower, the watcher; not the keeper
    # who pressed the button (the administrators are not keepers' fallback here).
    await _ok(await lab.give_back(lab.keeper, lid, "issue", "レンズキャップがありません"))
    assert await _keys(db, lab.member) == [
        f"due_changed:{lid}:2026-12-05",
        f"returned_by_keeper:{lid}",
    ]
    assert (await _notices(db, lab.member))[-1].text == (
        "✅ 備品係の Kee さんが「カメラ A（CAM-02）」の返却を記録しました。"
    )
    assert await _keys(db, lab.keeper) == []
    assert await _keys(db, lab.admin) == []
    (back,) = await _notices(db, lab.bob)
    assert back.key == f"watch:{item['id']}:{lid}" and back.role == "watcher"
    assert back.text == "📦 「カメラ A（CAM-02）」が返却されました。今は借りられます。"
    assert await db.scalar(select(LendingWatch.user_id)) is None

    # The borrower returns with an issue themself: the keeper is told.
    loan = await lab.borrow(lab.member, item["id"], due=3)
    await _ok(await lab.give_back(lab.member, loan["id"], "issue", "ケースが割れています"))
    (issue,) = await _notices(db, lab.keeper)
    assert issue.key == f"issue:{loan['id']}" and issue.role == "keeper"
    assert (
        issue.text
        == "🔧 Alice さんが「カメラ A（CAM-02）」を返却しました。状態：ケースが割れています"
    )


async def test_watches_borrow_repair_and_retired(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab, _ = await _lab(db, client, as_user, monkeypatch)
    item = await lab.item()
    # My watch goes when I borrow the item.
    as_user(lab.bob)
    assert (await client.put(f"{API}/lending/items/{item['id']}/watch")).status_code == 204
    loan = await lab.borrow(lab.bob, item["id"])
    assert await db.scalar(select(LendingWatch.user_id)) is None
    await _ok(await lab.give_back(lab.bob, loan["id"]))

    # In repair → available tells the watchers.
    as_user(lab.keeper)
    await _ok(
        await client.post(f"{API}/lending/items/{item['id']}/status", json={"status": "in_repair"})
    )
    as_user(lab.member)
    assert (await client.put(f"{API}/lending/items/{item['id']}/watch")).status_code == 204
    as_user(lab.bob)
    assert (await client.put(f"{API}/lending/items/{item['id']}/watch")).status_code == 204
    assert (await client.delete(f"{API}/lending/items/{item['id']}/watch")).status_code == 204
    assert (await client.delete(f"{API}/lending/items/{item['id']}/watch")).status_code == 204
    as_user(lab.keeper)
    await _ok(
        await client.post(f"{API}/lending/items/{item['id']}/status", json={"status": "available"})
    )
    (back,) = await _notices(db, lab.member)
    assert back.key.startswith(f"watch:{item['id']}:repair:") and back.loan_id is None
    assert back.text == "📦 「カメラ A」の修理が終わりました。今は借りられます。"
    assert await _notices(db, lab.bob) == []

    # Retired: not watched. Unknown items, guests.
    await _ok(
        await client.post(f"{API}/lending/items/{item['id']}/status", json={"status": "retired"})
    )
    as_user(lab.member)
    refused = await client.put(f"{API}/lending/items/{item['id']}/watch")
    assert refused.status_code == 409 and _code(refused) == "lending_item_unavailable"
    missing = await client.put(f"{API}/lending/items/{uuid.uuid4()}/watch")
    assert missing.status_code == 404 and _code(missing) == "lending_item_not_found"
    as_user(lab.guest)
    guest = await client.put(f"{API}/lending/items/{item['id']}/watch")
    assert guest.status_code == 403 and _code(guest) == "guest_restricted"


async def test_activity_hides_keepers_notices_from_former_keepers(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lab, _ = await _lab(db, client, as_user, monkeypatch)
    item = await lab.item()
    loan = await lab.borrow(lab.member, item["id"])
    await _ok(await lab.give_back(lab.member, loan["id"], "issue", "傷"))
    as_user(lab.keeper)
    feed: list[dict[str, Any]] = (await _ok(await client.get(f"{API}/activity", params=INCLUDE)))[
        "items"
    ]
    assert [i["lending"]["role"] for i in feed] == ["keeper"]
    await lab.enable(keeper_ids=[])
    as_user(lab.keeper)
    assert (await _ok(await client.get(f"{API}/activity", params=INCLUDE)))["items"] == []
    summary = await _ok(await client.get(f"{API}/activity/summary", params=INCLUDE))
    assert summary["unread_count"] == 0
