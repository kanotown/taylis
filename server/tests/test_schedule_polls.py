"""Scheduling polls (M53, SCHEDULING.md): slots and their labels, yes / maybe / no answers,
comments, the vote of an app before M53, anonymity, deciding (the calendar event, the reply)."""

import uuid
from collections.abc import Callable
from typing import Any, cast

from httpx import AsyncClient, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.models import OutboxEvent
from app.modules.users.models import User
from tests.helpers import make_user

TOKYO = "Asia/Tokyo"
# 2026-10-03 is a Saturday: 14:00-15:00 in Tokyo is 05:00-06:00 UTC.
SAT_14 = {"starts_at": "2026-10-03T05:00:00Z", "ends_at": "2026-10-03T06:00:00Z"}
MON_ALL_DAY = {"date": "2026-10-05"}
TUE_LATE = {"starts_at": "2026-10-06T13:00:00Z", "ends_at": "2026-10-06T15:00:00Z"}  # 22:00-24:00
WED_LATE = {"starts_at": "2026-10-07T14:00:00Z", "ends_at": "2026-10-07T16:30:00Z"}  # 23:00-1:30
SLOTS = [SAT_14, MON_ALL_DAY, TUE_LATE]
LABELS = ["10/3 (土) 14:00〜15:00", "10/5 (月) 終日", "10/6 (火) 22:00〜24:00"]


async def _post_poll(
    client: AsyncClient, channel_id: str, parent_id: str | None = None, **poll: Any
) -> Response:
    body: dict[str, Any] = {
        "client_msg_id": str(uuid.uuid4()),
        "poll": {"question": "M2 中間発表の練習", "kind": "schedule", "slots": SLOTS, "tz": TOKYO}
        | poll,
    }
    if parent_id:
        body["parent_id"] = parent_id
    return await client.post(f"/api/v1/channels/{channel_id}/messages", json=body)


async def _schedule(client: AsyncClient, channel_id: str, **poll: Any) -> dict[str, Any]:
    response = await _post_poll(client, channel_id, **poll)
    assert response.status_code == 201, response.text
    return cast(dict[str, Any], response.json())


async def _channel(client: AsyncClient, name: str, members: list[User]) -> dict[str, Any]:
    channel = (await client.post("/api/v1/channels", json={"name": name})).json()
    for user in members:
        added = await client.post(
            f"/api/v1/channels/{channel['id']}/members", json={"user_id": str(user.id)}
        )
        assert added.status_code in (200, 201), added.text
    return cast(dict[str, Any], channel)


async def _answer(
    client: AsyncClient, message_id: str, answers: dict[int, str], **extra: Any
) -> Response:
    body = {"answers": [{"index": i, "answer": a} for i, a in answers.items()], **extra}
    return await client.put(f"/api/v1/messages/{message_id}/poll/answers", json=body)


async def _updates(db: AsyncSession) -> list[dict[str, Any]]:
    stmt = (
        select(OutboxEvent)
        .where(OutboxEvent.event_type == "message.updated")
        .order_by(OutboxEvent.id)
    )
    return [row.payload for row in (await db.execute(stmt)).scalars().all()]


async def test_a_scheduling_poll_has_slots_labelled_in_its_zone(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    channel = await _channel(client, "lab", [])
    message = await _schedule(
        client, channel["id"], slots=[*SLOTS, WED_LATE], options=["ignored", "too"]
    )
    poll = message["poll"]
    assert message["body"] == "📊 M2 中間発表の練習"
    assert poll["kind"] == "schedule" and poll["tz"] == TOKYO and poll["multiple"] is True
    assert poll["options"] == [*LABELS, "10/7 (水) 23:00〜翌1:30"]
    assert poll["slots"][0] == {
        "starts_at": "2026-10-03T05:00:00Z",
        "ends_at": "2026-10-03T06:00:00Z",
        "date": None,
    }
    assert poll["slots"][1] == {"starts_at": None, "ends_at": None, "date": "2026-10-05"}
    assert poll["decided"] is None and poll["closed_at"] is None
    assert (
        poll["answers"]
        == [{"yes": [], "maybe": [], "no": [], "yes_count": 0, "maybe_count": 0, "no_count": 0}] * 4
    )
    assert poll["my_answers"] == [None] * 4 and poll["my_comment"] == ""
    assert poll["comments"] == [] and poll["respondents"] == []

    # The labels follow the zone sent (the creator's device).
    ny = (await _schedule(client, channel["id"], tz="America/New_York"))["poll"]
    assert ny["options"][0] == "10/3 (土) 1:00〜2:00"

    # A time with an offset is the same instant.
    offset = await _schedule(
        client,
        channel["id"],
        slots=[
            {"starts_at": "2026-10-03T14:00:00+09:00", "ends_at": "2026-10-03T15:30:00+09:00"},
            MON_ALL_DAY,
        ],
    )
    assert offset["poll"]["options"][0] == "10/3 (土) 14:00〜15:30"
    assert offset["poll"]["slots"][0]["starts_at"] == "2026-10-03T05:00:00Z"

    def at(minutes: int) -> dict[str, str]:
        hours, rest = divmod(minutes, 60)
        return {
            "starts_at": "2026-10-03T00:00:00Z",
            "ends_at": f"2026-10-03T{hours:02d}:{rest:02d}:00Z",
        }

    for bad in (
        {"slots": [SAT_14]},  # one slot
        {"slots": [{"date": f"2026-11-{d:02d}"} for d in range(1, 22)]},  # 21 slots
        {"slots": [SAT_14, dict(SAT_14)]},  # the same slot twice
        {"slots": [at(10), MON_ALL_DAY]},  # shorter than 15 minutes
        {"slots": [{**at(0), "ends_at": "2026-10-03T12:01:00Z"}, MON_ALL_DAY]},  # over 12 hours
        {"slots": [{**SAT_14, "date": "2026-10-03"}, MON_ALL_DAY]},  # both shapes
        {"slots": [{"starts_at": "2026-10-03T05:00:00"}, MON_ALL_DAY]},  # no end, no offset
        {"tz": None},
        {"tz": "Mars/Base"},
        {"slots": None},
        {"kind": "choice", "options": ["A", "B"]},  # slots on a choice poll
    ):
        response = await _post_poll(client, channel["id"], **bad)
        assert response.status_code == 422, (bad, response.text)
    # Exactly 15 minutes and exactly 12 hours are fine.
    assert (await _post_poll(client, channel["id"], slots=[at(15), at(720)])).status_code == 201


async def test_answers_replace_mine_and_carry_a_comment(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    channel = await _channel(client, "lab", [bob])
    message = await _schedule(client, channel["id"])
    as_user(bob)
    first = await _answer(
        client, message["id"], {0: "yes", 1: "maybe"}, comment=" 午後なら\n大丈夫 "
    )
    assert first.status_code == 201, first.text
    poll = first.json()["poll"]
    assert poll["my_answers"] == ["yes", "maybe", None]
    assert poll["my_comment"] == "午後なら 大丈夫"
    assert poll["answers"][0]["yes"] == [str(bob.id)] and poll["answers"][0]["yes_count"] == 1
    assert poll["answers"][1]["maybe"] == [str(bob.id)]
    assert poll["comments"] == [{"user_id": str(bob.id), "text": "午後なら 大丈夫"}]
    assert poll["respondents"] == [str(bob.id)]
    # The ○ answers are what an app before M53 sees.
    assert poll["votes"] == [[str(bob.id)], [], []] and poll["counts"] == [1, 0, 0]
    assert poll["mine"] == [0]

    # Slots left out become unanswered; a comment left out stays.
    second = (await _answer(client, message["id"], {1: "no"})).json()["poll"]
    assert second["my_answers"] == [None, "no", None]
    assert second["answers"][0]["yes_count"] == 0 and second["answers"][1]["no"] == [str(bob.id)]
    assert second["my_comment"] == "午後なら 大丈夫"
    # The same again changes nothing and takes no seq.
    before = len(await _updates(db))
    same = await _answer(client, message["id"], {1: "no"}, comment="午後なら 大丈夫")
    assert same.status_code == 200 and len(await _updates(db)) == before
    # A blank or null comment removes it.
    cleared = (await _answer(client, message["id"], {1: "no"}, comment="  ")).json()["poll"]
    assert cleared["comments"] == [] and cleared["my_comment"] == ""
    # Everything unanswered: off the table.
    empty = (await _answer(client, message["id"], {})).json()["poll"]
    assert empty["respondents"] == [] and empty["my_answers"] == [None, None, None]

    # Alice sees bob's answers, and her own (none) in the responses to her.
    await _answer(client, message["id"], {2: "maybe"}, comment="遅めなら")
    as_user(alice)
    seen = (await client.get(f"/api/v1/messages/{message['id']}")).json()["poll"]
    assert seen["answers"][2]["maybe"] == [str(bob.id)] and seen["my_answers"] == [None] * 3
    assert seen["my_comment"] == "" and seen["comments"][0]["text"] == "遅めなら"
    history = (await client.get(f"/api/v1/channels/{channel['id']}/messages")).json()
    row = next(m for m in history["messages"] if m["id"] == message["id"])
    assert row["poll"]["respondents"] == [str(bob.id)]

    # Every change went out as message.updated (change poll) without anyone's own answers.
    updates = await _updates(db)
    assert len(updates) == 5 and {u["change"] for u in updates} == {"poll"}
    last = updates[-1]["message"]["poll"]
    assert last["my_answers"] is None and last["my_comment"] is None and last["mine"] is None
    assert last["answers"][2]["maybe"] == [str(bob.id)]

    # Refused answers.
    as_user(bob)
    bad_slot = await _answer(client, message["id"], {3: "yes"})
    assert bad_slot.status_code == 400 and bad_slot.json()["error"]["code"] == "poll_option_invalid"
    twice = await client.put(
        f"/api/v1/messages/{message['id']}/poll/answers",
        json={"answers": [{"index": 0, "answer": "yes"}, {"index": 0, "answer": "no"}]},
    )
    assert twice.status_code == 422
    assert (await _answer(client, message["id"], {0: "perhaps"})).status_code == 422
    assert (await _answer(client, message["id"], {}, comment="あ" * 101)).status_code == 422
    assert (await _answer(client, message["id"], {}, comment="あ" * 100)).status_code == 201
    as_user(alice)
    choice = (
        await client.post(
            f"/api/v1/channels/{channel['id']}/messages",
            json={
                "client_msg_id": str(uuid.uuid4()),
                "poll": {"question": "Q", "options": ["A", "B"]},
            },
        )
    ).json()
    wrong = await _answer(client, choice["id"], {0: "yes"})
    assert wrong.status_code == 400 and wrong.json()["error"]["code"] == "poll_not_schedule"
    assert choice["poll"]["kind"] == "choice" and choice["poll"]["answers"] == []
    plain = (
        await client.post(
            f"/api/v1/channels/{channel['id']}/messages",
            json={"client_msg_id": str(uuid.uuid4()), "body": "no poll"},
        )
    ).json()
    none = await _answer(client, plain["id"], {0: "yes"})
    assert none.status_code == 404 and none.json()["error"]["code"] == "poll_not_found"
    # Someone outside the channel cannot answer.
    eve = await make_user(db, "eve")
    as_user(eve)
    assert (await _answer(client, message["id"], {0: "yes"})).status_code in (403, 404)


async def test_the_old_vote_endpoint_is_a_yes(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """An app before M53 sees a multiple-choice poll of the labels; its vote is ○."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    channel = await _channel(client, "lab", [bob])
    message = await _schedule(client, channel["id"])
    as_user(bob)
    await _answer(client, message["id"], {0: "maybe", 2: "no"})
    voted = await client.put(f"/api/v1/messages/{message['id']}/poll/votes/0")
    assert voted.status_code == 201
    poll = voted.json()["poll"]
    assert poll["my_answers"] == ["yes", None, "no"] and poll["votes"][0] == [str(bob.id)]
    assert poll["answers"][0]["maybe"] == [] and poll["answers"][0]["yes"] == [str(bob.id)]
    again = await client.put(f"/api/v1/messages/{message['id']}/poll/votes/0")
    assert again.status_code == 200
    # Taking the vote back unanswers that slot, whatever the answer was.
    withdrawn = await client.delete(f"/api/v1/messages/{message['id']}/poll/votes/2")
    assert withdrawn.json()["poll"]["my_answers"] == ["yes", None, None]
    out_of_range = await client.put(f"/api/v1/messages/{message['id']}/poll/votes/3")
    assert out_of_range.status_code == 400


async def test_an_anonymous_scheduling_poll_names_nobody(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    channel = await _channel(client, "lab", [bob])
    message = await _schedule(client, channel["id"], anonymous=True)
    as_user(bob)
    mine = (await _answer(client, message["id"], {0: "yes", 1: "no"}, comment="どちらでも")).json()
    poll = mine["poll"]
    assert poll["anonymous"] is True
    assert poll["answers"][0] == {
        "yes": [],
        "maybe": [],
        "no": [],
        "yes_count": 1,
        "maybe_count": 0,
        "no_count": 0,
    }
    assert poll["answers"][1]["no_count"] == 1 and poll["votes"] == [[], [], []]
    assert poll["comments"] == [{"user_id": None, "text": "どちらでも"}]
    assert poll["respondents"] == []
    assert poll["my_answers"] == ["yes", "no", None] and poll["my_comment"] == "どちらでも"
    for update in await _updates(db):
        assert str(bob.id) not in str(update["message"]["poll"])

    # Deciding names nobody either: the reply has the counts and no mentions.
    as_user(alice)
    decided = await client.post(f"/api/v1/messages/{message['id']}/poll/decide", json={"index": 0})
    assert decided.status_code == 201, decided.text
    replies = (await client.get(f"/api/v1/messages/{message['id']}/replies")).json()
    assert [r["body"] for r in replies] == [
        "📅 日程が決まりました: 10/3 (土) 14:00〜15:00 (○ 1 · △ 0)"
    ]
    assert replies[0]["mentioned_user_ids"] == []


async def test_deciding_makes_the_event_and_the_thread_reply(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    olivia = await make_user(db, "olivia")  # the channel's owner
    bob = await make_user(db, "bob")  # the poll's author
    carol = await make_user(db, "carol")
    dave = await make_user(db, "dave")
    root = await make_user(db, "root", role="admin")
    as_user(olivia)
    channel = await _channel(client, "lab", [bob, carol, dave, root])
    as_user(bob)
    message = await _schedule(client, channel["id"])
    mid = message["id"]
    await _answer(client, mid, {0: "yes", 1: "no"})
    as_user(carol)
    await _answer(client, mid, {0: "yes"}, comment="OK")
    as_user(dave)
    await _answer(client, mid, {0: "maybe"})

    # A member who is neither the author, an owner nor an administrator cannot decide.
    denied = await client.post(f"/api/v1/messages/{mid}/poll/decide", json={"index": 0})
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "poll_decide_restricted"
    assert (await client.delete(f"/api/v1/messages/{mid}/poll/decide")).status_code == 403
    bad = await client.post(f"/api/v1/messages/{mid}/poll/decide", json={"index": 3})
    assert bad.status_code in (400, 403)

    # The author decides slot 0.
    as_user(bob)
    bad = await client.post(f"/api/v1/messages/{mid}/poll/decide", json={"index": 3})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "poll_option_invalid"
    updates_before = len(await _updates(db))
    decided = await client.post(f"/api/v1/messages/{mid}/poll/decide", json={"index": 0})
    assert decided.status_code == 201, decided.text
    poll = decided.json()["poll"]
    assert poll["decided"]["index"] == 0 and poll["decided"]["by"] == str(bob.id)
    assert poll["closed_at"] is not None
    event_id = poll["decided"]["event_id"]
    assert event_id is not None

    # The event is in the channel's calendar, for every member to see.
    as_user(carol)
    event = (await client.get(f"/api/v1/calendar/events/{event_id}")).json()
    assert event["channel_id"] == channel["id"] and event["owner_id"] == str(bob.id)
    assert event["title"] == "M2 中間発表の練習" and event["all_day"] is False
    assert event["starts_at"] == "2026-10-03T05:00:00Z"
    assert event["ends_at"] == "2026-10-03T06:00:00Z"
    assert event["description"] == f"日程調整で決定\nhttp://testserver/m/{mid}"
    calendar_updates = (
        (
            await db.execute(
                select(OutboxEvent).where(OutboxEvent.event_type == "calendar.event.updated")
            )
        )
        .scalars()
        .all()
    )
    assert [row.payload["event"]["id"] for row in calendar_updates] == [event_id]

    # The thread reply, by the decider, mentions those who answered (not the decider).
    replies = (await client.get(f"/api/v1/messages/{mid}/replies")).json()
    assert len(replies) == 1
    reply = replies[0]
    assert reply["sender_id"] == str(bob.id) and reply["parent_id"] == mid
    assert reply["body"] == (
        f"📅 日程が決まりました: 10/3 (土) 14:00〜15:00 (○ 2 · △ 1)\n<@{carol.id}> <@{dave.id}>"
    )
    assert set(reply["mentioned_user_ids"]) == {str(carol.id), str(dave.id)}

    # The decision went out as message.updated (change poll), then the reply as message.created.
    updates = (await _updates(db))[updates_before:]
    assert len(updates) == 1 and updates[0]["change"] == "poll"
    assert updates[0]["message"]["poll"]["decided"]["event_id"] == event_id
    created = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "message.created")
                .order_by(OutboxEvent.id.desc())
                .limit(1)
            )
        )
        .scalars()
        .one()
    )
    assert created.payload["message"]["id"] == reply["id"]
    assert created.payload["parent_thread"]["id"] == mid
    assert created.payload["parent_thread"]["reply_count"] == 1

    # Closed to answers (and to an app before M53's votes).
    late = await _answer(client, mid, {1: "yes"})
    assert late.status_code == 409 and late.json()["error"]["code"] == "poll_decided"
    old = await client.put(f"/api/v1/messages/{mid}/poll/votes/1")
    assert old.status_code == 409

    # Deciding the same slot again is a retry: nothing new. Another slot: 409.
    as_user(bob)
    retry = await client.post(f"/api/v1/messages/{mid}/poll/decide", json={"index": 0})
    assert retry.status_code == 200
    assert len((await client.get(f"/api/v1/messages/{mid}/replies")).json()) == 1
    other = await client.post(f"/api/v1/messages/{mid}/poll/decide", json={"index": 1})
    assert other.status_code == 409 and other.json()["error"]["code"] == "poll_decided"

    # The channel's owner takes it back: answers reopen, the event stays.
    as_user(olivia)
    undone = await client.delete(f"/api/v1/messages/{mid}/poll/decide")
    assert undone.status_code == 200
    assert undone.json()["poll"]["decided"] is None and undone.json()["poll"]["closed_at"] is None
    assert (await client.get(f"/api/v1/calendar/events/{event_id}")).status_code == 200
    assert (await client.delete(f"/api/v1/messages/{mid}/poll/decide")).status_code == 200
    as_user(carol)
    assert (await _answer(client, mid, {1: "yes"})).status_code == 201

    # An administrator decides the all-day slot without an event.
    as_user(root)
    by_admin = await client.post(
        f"/api/v1/messages/{mid}/poll/decide", json={"index": 1, "create_event": False}
    )
    assert by_admin.status_code == 201, by_admin.text
    assert by_admin.json()["poll"]["decided"]["event_id"] is None
    replies = (await client.get(f"/api/v1/messages/{mid}/replies")).json()
    assert replies[-1]["body"].startswith("📅 日程が決まりました: 10/5 (月) 終日 (○ 1 · △ 0)")
    # The admin is not a respondent; the others are mentioned (the decider never).
    assert str(root.id) not in replies[-1]["body"]

    # Deciding a choice poll is refused.
    choice = (
        await client.post(
            f"/api/v1/channels/{channel['id']}/messages",
            json={
                "client_msg_id": str(uuid.uuid4()),
                "poll": {"question": "Q", "options": ["A", "B"]},
            },
        )
    ).json()
    refused = await client.post(f"/api/v1/messages/{choice['id']}/poll/decide", json={"index": 0})
    assert refused.status_code == 400 and refused.json()["error"]["code"] == "poll_not_schedule"


async def test_an_all_day_decision_and_a_closed_poll(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    channel = await _channel(client, "lab", [bob])
    message = await _schedule(client, channel["id"])
    as_user(bob)
    await _answer(client, message["id"], {1: "yes"})
    as_user(alice)
    # Closing first still lets the author decide; answers stay closed.
    await client.post(f"/api/v1/messages/{message['id']}/poll/close")
    as_user(bob)
    closed = await _answer(client, message["id"], {0: "yes"})
    assert closed.status_code == 409 and closed.json()["error"]["code"] == "poll_closed"
    as_user(alice)
    decided = await client.post(f"/api/v1/messages/{message['id']}/poll/decide", json={"index": 1})
    assert decided.status_code == 201, decided.text
    event_id = decided.json()["poll"]["decided"]["event_id"]
    event = (await client.get(f"/api/v1/calendar/events/{event_id}")).json()
    assert event["all_day"] is True
    assert event["start_date"] == event["end_date"] == "2026-10-05"


async def test_a_dm_has_no_calendar_but_gets_the_reply(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})).json()
    message = await _schedule(client, dm["id"])
    as_user(bob)
    await _answer(client, message["id"], {0: "yes"})
    decided = await client.post(f"/api/v1/messages/{message['id']}/poll/decide", json={"index": 0})
    assert decided.status_code == 403  # bob is neither the author nor an owner of the DM
    as_user(alice)
    decided = await client.post(f"/api/v1/messages/{message['id']}/poll/decide", json={"index": 0})
    assert decided.status_code == 201, decided.text
    assert decided.json()["poll"]["decided"]["event_id"] is None
    rows = (await db.execute(select(OutboxEvent.event_type))).scalars().all()
    assert "calendar.event.updated" not in rows
    replies = (await client.get(f"/api/v1/messages/{message['id']}/replies")).json()
    assert replies[0]["body"].endswith(f"<@{bob.id}>")


async def test_a_poll_in_a_thread_is_decided_in_that_thread(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    channel = await _channel(client, "lab", [])
    root = (
        await client.post(
            f"/api/v1/channels/{channel['id']}/messages",
            json={"client_msg_id": str(uuid.uuid4()), "body": "発表練習の相談"},
        )
    ).json()
    response = await _post_poll(client, channel["id"], parent_id=root["id"])
    poll = response.json()
    assert poll["parent_id"] == root["id"]
    decided = await client.post(f"/api/v1/messages/{poll['id']}/poll/decide", json={"index": 0})
    assert decided.status_code == 201, decided.text
    replies = (await client.get(f"/api/v1/messages/{root['id']}/replies")).json()
    assert replies[0]["id"] == poll["id"]
    assert replies[-1]["body"].startswith("📅 日程が決まりました")
    assert replies[-1]["parent_id"] == root["id"]


async def test_an_archived_channel_takes_no_decision(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    channel = await _channel(client, "lab", [])
    message = await _schedule(client, channel["id"])
    assert (await client.post(f"/api/v1/channels/{channel['id']}/archive")).status_code == 200
    refused = await client.post(f"/api/v1/messages/{message['id']}/poll/decide", json={"index": 0})
    assert refused.status_code == 409
    answered = await _answer(client, message["id"], {0: "yes"})
    assert answered.status_code == 409
