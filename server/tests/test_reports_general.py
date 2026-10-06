"""POST /reports (M119, docs/MODERATION.md §3.1): reports of a person, general reports and
feedback, kept with the message reports in one admin list; child_safety for message reports."""

import uuid
from collections.abc import Callable
from typing import Any, cast

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.audit import service as audit
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_moderation import _bot_dm_bodies, _post


async def _report(client: AsyncClient, **body: Any) -> Any:
    return await client.post("/api/v1/reports", json=body)


async def test_validation_self_and_unknown_user(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    for bad in (
        {"category": "feedback"},  # the note is required
        {"category": "feedback", "note": "   \n "},
        {"category": "feedback", "note": "x" * 4001},
        {"category": "meh", "note": "hello"},
        {"category": "feedback", "note": "hello", "extra": 1},
        {"category": "feedback", "note": "hello", "client_report_id": "not-a-uuid"},
    ):
        response = await client.post("/api/v1/reports", json=bad)
        assert response.status_code == 422, (bad, response.text)
    ok = await _report(client, category="feedback", note="  " + "x" * 4000 + "  ")
    assert ok.status_code == 201, ok.text

    me = await _report(client, category="harassment", note="me", user_id=str(alice.id))
    assert me.status_code == 400 and me.json()["error"]["code"] == "cannot_report_self"
    nobody = await _report(client, category="harassment", note="who", user_id=str(uuid.uuid4()))
    assert nobody.status_code == 404 and nobody.json()["error"]["code"] == "user_not_found"


async def test_user_report_and_feedback_reach_the_admins(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "admin", role="admin")
    other_admin = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    bob.display_name = "<@everyone> *Bob*"
    await db.commit()

    as_user(alice)
    response = await _report(
        client, category="child_safety", note="  <!channel> 怪しい誘い  ", user_id=str(bob.id)
    )
    assert response.status_code == 201, response.text
    ack = response.json()
    assert set(ack) == {"id", "category", "user_id", "created_at"}
    assert ack["category"] == "child_safety" and ack["user_id"] == str(bob.id)

    notices = await _bot_dm_bodies(db, admin)
    assert len(notices) == 1
    lines = notices[0].split("\n")
    assert lines[0] == "⚠️ 子どもの安全" and lines[1] == "🚩 報告が届きました"
    assert "種類: 子どもの安全" in lines
    assert "報告者: Alice (@alice)" in lines
    assert "対象のユーザー: \uff1c@everyone> \uff0aBob\uff0a (@bob)" in lines
    assert "内容: \uff1c!channel> 怪しい誘い" in lines
    assert "<@" not in notices[0] and "<!" not in notices[0]
    assert "「管理」→「報告」" in lines[-1]

    # Feedback from an admin: the other admins hear of it, not the sender.
    as_user(admin)
    feedback = await _report(client, category="feedback", note="通知の設定が分かりにくい")
    assert feedback.status_code == 201 and feedback.json()["user_id"] is None
    assert len(await _bot_dm_bodies(db, admin)) == 1
    notice = (await _bot_dm_bodies(db, other_admin))[-1]
    assert notice.startswith("💬 ご意見が届きました\n種類: ご意見\n報告者: Admin (@admin)\n")
    assert "対象のユーザー" not in notice and "⚠️" not in notice

    actions = [row.action for row in await audit.list_recent(db)]
    assert actions.count("moderation.report_submitted") == 2


async def test_client_report_id_and_rate_limit(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "admin", role="admin")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    client_id = str(uuid.uuid4())
    first = await _report(client, category="spam", note="spam DMs", client_report_id=client_id)
    assert first.status_code == 201
    again = await _report(client, category="other", note="retry", client_report_id=client_id)
    assert again.status_code == 200 and again.json() == first.json()
    assert len(await _bot_dm_bodies(db, admin)) == 1  # the retry told no one again
    # Another person's report with the same client id is their own.
    as_user(bob)
    theirs = await _report(client, category="spam", note="x", client_report_id=client_id)
    assert theirs.status_code == 201 and theirs.json()["id"] != first.json()["id"]

    as_user(alice)
    codes = [
        (await _report(client, category="feedback", note=f"n{i}")).status_code for i in range(10)
    ]
    # One used by the first report: 9 more, then 429 with the usual shape.
    assert codes[:9] == [201] * 9 and codes[9] == 429
    limited = await _report(client, category="feedback", note="more")
    assert limited.status_code == 429 and limited.json()["error"]["code"] == "rate_limited"
    assert "retry-after" in {key.lower() for key in limited.headers}
    # A retry of an earlier report still answers while limited.
    retry = await _report(client, category="spam", note="spam DMs", client_report_id=client_id)
    assert retry.status_code == 200 and retry.json()["id"] == first.json()["id"]


async def test_guests_can_report_people_they_see(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    await make_user(db, "admin", role="admin")
    alice = await make_user(db, "alice")
    stranger = await make_user(db, "stranger")
    guest = await make_user(db, "guest", role="guest")
    as_user(alice)
    channel = (
        await client.post("/api/v1/channels", json={"name": "visit", "type": "private"})
    ).json()
    await client.post(f"/api/v1/channels/{channel['id']}/members", json={"user_id": str(guest.id)})

    as_user(guest)
    general = await _report(client, category="other", note="ログインの画面がおかしい")
    assert general.status_code == 201, general.text
    seen = await _report(client, category="harassment", note="しつこい", user_id=str(alice.id))
    assert seen.status_code == 201, seen.text
    unseen = await _report(client, category="spam", note="?", user_id=str(stranger.id))
    assert unseen.status_code == 404 and unseen.json()["error"]["code"] == "user_not_found"


async def test_admin_list_mixes_kinds_and_resolves(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    admin = await make_user(db, "admin", role="admin")
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    message = await _post(client, channel["id"], "怪しいメッセージ")
    as_user(bob)
    await client.post(f"/api/v1/channels/{channel['id']}/join")
    by_message = await client.post(
        f"/api/v1/messages/{message['id']}/report", json={"reason": "child_safety"}
    )
    assert by_message.status_code == 201 and by_message.json()["reason"] == "child_safety"
    by_user = await _report(client, category="harassment", note="DM で", user_id=str(alice.id))
    general = await _report(client, category="feedback", note="ご意見です")
    assert by_user.status_code == general.status_code == 201
    # A message report cannot be feedback.
    feedback_message = await client.post(
        f"/api/v1/messages/{message['id']}/report", json={"reason": "feedback"}
    )
    assert feedback_message.status_code == 422

    as_user(admin)
    rows = cast(list[dict[str, Any]], (await client.get("/api/v1/admin/reports")).json())
    assert [row["kind"] for row in rows] == ["general", "user", "message"]  # newest first
    general_row, user_row, message_row = rows
    assert general_row["reason"] == "feedback" and general_row["note"] == "ご意見です"
    for row in (general_row, user_row):
        # What older admin screens read: present, null where there is no message.
        assert row["message_id"] is None and row["channel_id"] is None
        assert row["channel_type"] == "none" and row["channel_name"] is None
        assert row["body_snapshot"] == "" and row["message_deleted"] is False
        assert row["reporter_id"] == str(bob.id)
    assert general_row["reported_user_id"] is None
    assert user_row["reported_user_id"] == str(alice.id) and user_row["reason"] == "harassment"
    assert message_row["message_id"] == message["id"] and message_row["channel_name"] == "general"
    assert message_row["reason"] == "child_safety" and message_row["reported_user_id"] == str(
        alice.id
    )
    # The notice of the message report leads with the child-safety banner.
    notices = await _bot_dm_bodies(db, admin)
    assert notices[0].startswith(
        "⚠️ 子どもの安全\n🚩 メッセージが報告されました\n理由: 子どもの安全"
    )

    resolved = await client.post(f"/api/v1/admin/reports/{general_row['id']}/resolve")
    assert resolved.status_code == 200
    assert resolved.json()["status"] == "resolved" and resolved.json()["kind"] == "general"
    open_ids = [row["id"] for row in (await client.get("/api/v1/admin/reports")).json()]
    assert general_row["id"] not in open_ids and len(open_ids) == 2
    reopened = await client.post(f"/api/v1/admin/reports/{general_row['id']}/reopen")
    assert reopened.json()["status"] == "open" and reopened.json()["resolved_by"] is None
    assert len((await client.get("/api/v1/admin/reports?status=all")).json()) == 3
