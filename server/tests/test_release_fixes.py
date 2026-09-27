"""Regression tests for the pre-release review (latent bugs found by reading the code)."""

import io
import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import redact_path
from app.core.ratelimit import RateLimiter
from app.core.settings import build_settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.attachments.models import Attachment
from app.modules.channels.service import resolve_event_audience
from app.modules.notifications.planner import PushPlanner
from app.modules.reminders import service as reminders
from app.modules.reminders.models import Reminder
from app.modules.scheduled import service as scheduled
from app.modules.users.models import User
from app.realtime.hub import RealtimeHub
from tests.helpers import make_user


async def _post(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> Any:
    payload = {"client_msg_id": str(uuid.uuid4()), "body": body, **extra}
    return await client.post(f"/api/v1/channels/{channel_id}/messages", json=payload)


async def _channel(client: AsyncClient, name: str, **extra: Any) -> str:
    response = await client.post("/api/v1/channels", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


async def _unread(client: AsyncClient, channel_id: str) -> int:
    boot = (await client.get("/api/v1/sync/bootstrap")).json()
    state = next(c for c in boot["channels"] if c["id"] == channel_id)["read_state"]
    return int(state["unread_count"])


# --- invites -------------------------------------------------------------------------------


async def test_guest_invites_create_guests_and_skip_channels_made_private(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    vendor = await _channel(client, "vendor")
    invite = (
        await client.post("/api/v1/admin/invites", json={"role": "guest", "channel_ids": [vendor]})
    ).json()
    # The channel becomes private and the issuer leaves it before the invite is used.
    await client.patch(f"/api/v1/channels/{vendor}", json={"type": "private"})
    other = await make_user(db, "other")
    await client.post(f"/api/v1/channels/{vendor}/members", json={"user_id": str(other.id)})
    await client.post(f"/api/v1/channels/{vendor}/leave")

    client.headers.pop("Authorization", None)
    blank = await client.post(
        f"/api/v1/invites/{invite['token']}/accept",
        json={
            "username": "guest1",
            "display_name": "   ",
            "password": "correct horse battery",
            "device": {"platform": "ios", "device_name": "x"},
        },
    )
    assert blank.status_code == 422  # validated in the schema, not a 500
    accepted = await client.post(
        f"/api/v1/invites/{invite['token']}/accept",
        json={
            "username": "guest1",
            "display_name": "ゲスト",
            "password": "correct horse battery",
            "device": {"platform": "ios", "device_name": "x"},
        },
    )
    assert accepted.status_code == 201, accepted.text
    guest = (await db.execute(select(User).where(User.username == "guest1"))).scalar_one()
    assert guest.role == "guest"
    as_user(guest)
    assert (await client.get("/api/v1/channels")).json() == []  # not handed the private channel


# --- threads -------------------------------------------------------------------------------


async def test_thread_follows_stay_inside_the_channel(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    secret = await _channel(client, "secret", type="private")
    await client.post(f"/api/v1/channels/{secret}/members", json={"user_id": str(carol.id)})
    parent = (await _post(client, secret, f"cc <@{bob.id}>")).json()  # bob is not a member
    as_user(carol)
    await _post(client, secret, "返信", parent_id=parent["id"])

    as_user(bob)
    assert (await client.get("/api/v1/threads")).json()["items"] == []
    assert (await client.get("/api/v1/sync/bootstrap")).json()["threads"]["unread_count"] == 0
    rows = (
        (await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "thread.updated")))
        .scalars()
        .all()
    )
    assert all(r.audience_id != bob.id for r in rows)

    # Carol leaves: the thread disappears from her list and she is no longer a push target.
    as_user(alice)
    await _post(client, secret, "もう一つ", parent_id=parent["id"])
    as_user(carol)
    assert len((await client.get("/api/v1/threads")).json()["items"]) == 1
    await client.post(f"/api/v1/channels/{secret}/leave")
    assert (await client.get("/api/v1/threads")).json()["items"] == []
    as_user(alice)
    last = (await _post(client, secret, "三つ目", parent_id=parent["id"])).json()
    row = (
        await db.execute(
            select(OutboxEvent).where(
                OutboxEvent.event_type == "message.created", OutboxEvent.seq == last["seq"]
            )
        )
    ).scalar_one()
    assert str(carol.id) not in row.payload["parent_thread"]["participant_ids"]


async def test_reading_is_not_following_and_unfollowing_silences_pushes(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    general = await _channel(client, "general")
    for user in (bob, carol):
        await client.post(f"/api/v1/channels/{general}/members", json={"user_id": str(user.id)})
    parent = (await _post(client, general, "議題")).json()
    reply = (await _post(client, general, "返信 1", parent_id=parent["id"])).json()

    # Bob only reads the thread: not following, not in his list.
    as_user(bob)
    read = await client.put(
        f"/api/v1/messages/{parent['id']}/thread/read", json={"last_read_seq": reply["seq"]}
    )
    assert read.json()["following"] is False
    assert (await client.get("/api/v1/threads")).json()["items"] == []
    # A mention later still makes him follow (the read-only row does not block auto-follow).
    as_user(alice)
    await _post(client, general, f"<@{bob.id}> どう?", parent_id=parent["id"])
    as_user(bob)
    state = (await client.get(f"/api/v1/messages/{parent['id']}/thread")).json()
    assert state["following"] is True

    # Carol follows by replying, then unfollows by hand: even at level "all" no push for replies.
    as_user(carol)
    await _post(client, general, "私も", parent_id=parent["id"])
    await client.put(f"/api/v1/channels/{general}/notification-preference", json={"level": "all"})
    await client.put(f"/api/v1/messages/{parent['id']}/thread/follow", json={"following": False})
    as_user(alice)
    later = (await _post(client, general, "続き", parent_id=parent["id"])).json()
    event = (
        await db.execute(
            select(OutboxEvent).where(
                OutboxEvent.event_type == "message.created", OutboxEvent.seq == later["seq"]
            )
        )
    ).scalar_one()
    planner = PushPlanner(build_settings(), is_active=lambda _uid: False)
    audience = await resolve_event_audience(db, event)
    captured: list[list[uuid.UUID]] = []

    async def capture(*args: Any, **kwargs: Any) -> list[uuid.UUID]:
        captured.append(list(args[2]))
        return []

    planner.select_recipients = capture  # type: ignore[method-assign]
    await planner.handle(db, event, audience)
    assert captured and carol.id not in captured[0] and bob.id in captured[0]
    # Mentioning her again does not re-follow: the unfollow was explicit.
    await _post(client, general, f"<@{carol.id}> ねえ", parent_id=parent["id"])
    as_user(carol)
    state = (await client.get(f"/api/v1/messages/{parent['id']}/thread")).json()
    assert state["following"] is False


# --- messages --------------------------------------------------------------------------------


async def test_a_retried_send_gets_the_stored_message_whatever_changed_since(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "general")
    payload = {"client_msg_id": str(uuid.uuid4()), "body": "届いたはず"}
    first = await client.post(f"/api/v1/channels/{cid}/messages", json=payload)
    assert first.status_code == 201
    await client.post(f"/api/v1/channels/{cid}/archive")
    retry = await client.post(f"/api/v1/channels/{cid}/messages", json=payload)
    assert retry.status_code == 200 and retry.json()["id"] == first.json()["id"]
    fresh = await _post(client, cid, "新しい投稿")
    assert fresh.status_code == 409  # a new message still needs a writable channel


async def test_a_thread_reply_does_not_read_the_channel(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = await _channel(client, "general")
    await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(bob.id)})
    parent = (await _post(client, cid, "スレッド")).json()
    as_user(bob)
    await client.put(f"/api/v1/channels/{cid}/read", json={"last_read_seq": parent["seq"]})
    as_user(alice)
    for i in range(3):
        await _post(client, cid, f"未読 {i}")
    as_user(bob)
    assert await _unread(client, cid) == 3
    await _post(client, cid, "返信だけ", parent_id=parent["id"])
    await _post(client, cid, "チャンネルにも", parent_id=parent["id"], also_in_channel=True)
    assert await _unread(client, cid) == 3  # neither the replies nor my own posts count


async def test_delta_pages_never_split_a_reply_from_its_parent(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "general")
    parent = (await _post(client, cid, "p")).json()
    a = (await _post(client, cid, "a")).json()
    b = (await _post(client, cid, "b")).json()
    reply = (await _post(client, cid, "r", parent_id=parent["id"])).json()
    seen: set[str] = set()
    since = parent["seq"]  # the parent (seq 1) is behind the cursor; it changes again at the reply
    while True:
        page = (
            await client.get(
                f"/api/v1/channels/{cid}/sync", params={"since_seq": since, "limit": 3}
            )
        ).json()
        seen |= {m["id"] for m in page["messages"]}
        since = page["next_since_seq"]
        if not page["has_more"]:
            break
    assert {a["id"], b["id"], parent["id"], reply["id"]} <= seen


# --- reminders, drafts, scheduled -------------------------------------------------------------


async def test_reminders_follow_the_live_message_and_drafts_their_parent(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "general")
    message = (await _post(client, cid, "パスワードは hunter2")).json()
    later = utcnow() + timedelta(hours=1)
    reminder = await client.post(
        f"/api/v1/messages/{message['id']}/reminders", json={"remind_at": later.isoformat()}
    )
    assert reminder.status_code == 201
    await client.patch(f"/api/v1/messages/{message['id']}", json={"body": "(削除しました)"})
    listed = (await client.get("/api/v1/reminders")).json()
    assert [r["preview"] for r in listed] == ["(削除しました)"]
    stored = await db.get(Reminder, uuid.UUID(reminder.json()["id"]))
    assert stored is not None and "hunter2" not in (stored.preview or "")

    # A thread draft whose parent is deleted is neither listed nor counted.
    await client.put(
        "/api/v1/drafts",
        json={"channel_id": cid, "parent_id": message["id"], "body": "返信の下書き"},
    )
    await client.delete(f"/api/v1/messages/{message['id']}")
    assert (await client.get("/api/v1/reminders")).json() == []
    assert (await client.get("/api/v1/drafts")).json() == []
    async with app.state.db.session_factory() as worker_db:
        assert await reminders.fire_due(worker_db, now=later + timedelta(minutes=1)) == 0
    rows = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type == "reminder.updated")
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    assert rows[-1].payload["reminder"]["status"] == "cancelled"
    assert all("hunter2" not in str(r.payload) for r in rows[1:])


async def test_scheduled_create_is_idempotent_and_failures_release_files(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "general")
    upload = await client.post(
        "/api/v1/attachments", files={"file": ("memo.txt", b"memo", "text/plain")}
    )
    body = {
        "client_msg_id": str(uuid.uuid4()),
        "body": "あとで",
        "attachment_ids": [upload.json()["id"]],
        "send_at": (utcnow() + timedelta(hours=1)).isoformat(),
    }
    first = await client.post(f"/api/v1/channels/{cid}/scheduled", json=body)
    assert first.status_code == 201, first.text
    retry = await client.post(f"/api/v1/channels/{cid}/scheduled", json=body)
    assert retry.status_code in (200, 201) and retry.json()["id"] == first.json()["id"]

    alice.deactivated_at = utcnow()
    db.add(alice)
    await db.commit()
    async with app.state.db.session_factory() as worker_db:
        await scheduled.send_due(worker_db, now=utcnow() + timedelta(hours=2))
    attachment = await db.get(Attachment, uuid.UUID(upload.json()["id"]))
    await db.refresh(attachment)
    assert attachment is not None and attachment.status == "deleted"


# --- guests ----------------------------------------------------------------------------------


async def test_guests_only_see_people_they_share_a_channel_with(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    stranger = await make_user(db, "stranger")
    guest = await make_user(db, "guest", role="guest")
    as_user(root)
    vendor = await _channel(client, "vendor")
    for user in (alice, guest):
        await client.post(f"/api/v1/channels/{vendor}/members", json={"user_id": str(user.id)})
    group = await client.post(
        "/api/v1/admin/groups",
        json={"name": "team", "member_ids": [str(alice.id), str(stranger.id)]},
    )
    assert group.status_code == 201, group.text

    as_user(guest)
    assert (await client.get(f"/api/v1/users/{stranger.id}")).status_code == 404
    assert (await client.get(f"/api/v1/users/{stranger.id}/avatar")).status_code == 404
    assert (await client.get(f"/api/v1/users/{alice.id}")).status_code == 200
    groups = (await client.get("/api/v1/groups")).json()
    assert groups[0]["member_ids"] == [str(alice.id)]

    # Profile changes: the guest hears about alice, not about the stranger; groups not at all.
    for user in (alice, stranger):
        as_user(user)
        await client.patch("/api/v1/users/me", json={"title": "更新"})
    events = (
        (
            await db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.event_type.in_(("user.updated", "group.updated")))
                .order_by(OutboxEvent.id)
            )
        )
        .scalars()
        .all()
    )
    audiences = {}
    for row in events:
        ids = (await resolve_event_audience(db, row)).ids
        key = row.payload.get("user", {}).get("username") or row.event_type
        audiences[key] = ids
    assert guest.id in audiences["alice"] and guest.id not in audiences["stranger"]
    assert guest.id not in audiences["group.updated"]


async def test_guest_presence_is_filtered_by_the_hub() -> None:
    hub = RealtimeHub()
    alice, stranger, guest = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    watcher = hub.new_connection(guest, uuid.uuid4(), visible=frozenset({alice, guest}))
    hub.new_connection(alice, uuid.uuid4())
    hub.new_connection(stranger, uuid.uuid4())
    frames = []
    while not watcher.queue.empty():
        frames.append(watcher.queue.get_nowait())
    announced = {f["user_id"] for f in frames if f.get("type") == "presence"}
    assert str(alice) in announced and str(stranger) not in announced


# --- input validation, limits, logging, privacy --------------------------------------------


async def test_bad_inputs_are_client_errors_not_500(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "general")
    message = (await _post(client, cid, "x")).json()
    assert (
        await client.patch("/api/v1/users/me", json={"dnd_until": "2030-01-01T00:00:00"})
    ).status_code == 422
    assert (
        await client.patch("/api/v1/users/me", json={"status_expires_at": "2030-01-01T00:00:00"})
    ).status_code == 422
    naive_reminder = await client.post(
        f"/api/v1/messages/{message['id']}/reminders", json={"remind_at": "2030-01-01T00:00:00"}
    )
    assert naive_reminder.status_code == 422
    search = await client.get(
        "/api/v1/search/messages", params={"q": "x", "after": "2030-01-01T00:00:00"}
    )
    assert search.status_code == 422
    far = await client.get("/api/v1/search/messages", params={"q": "x after:9999-12-31"})
    assert far.status_code == 200 and far.json()["filters"]["unresolved"] == ["after:9999-12-31"]
    for url in ("http://h:99999/", "http://[::1/"):
        assert (await client.get("/api/v1/link-previews", params={"url": url})).status_code == 400
    nul = await client.patch(f"/api/v1/channels/{cid}", json={"topic": "a\u0000b"})
    assert nul.status_code == 422


async def test_posting_is_rate_limited(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    app.state.limiters["message"] = RateLimiter(2)
    alice = await make_user(db, "alice")
    as_user(alice)
    cid = await _channel(client, "general")
    assert (await _post(client, cid, "1")).status_code == 201
    assert (await _post(client, cid, "2")).status_code == 201
    limited = await _post(client, cid, "3")
    assert limited.status_code == 429 and limited.json()["error"]["code"] == "rate_limited"


def test_access_log_hides_url_tokens() -> None:
    assert redact_path("/api/v1/hooks/abcDEF123-_x") == "/api/v1/hooks/***"
    assert redact_path("/invite/tok_en") == "/invite/***"
    assert redact_path("/api/v1/invites/tok/accept") == "/api/v1/invites/***/accept"
    assert redact_path("/api/v1/channels/1/messages") == "/api/v1/channels/1/messages"


def _png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", (32, 32), (0, 128, 255, 255)).save(buffer, "PNG")
    return buffer.getvalue()


async def test_each_custom_emoji_keeps_its_own_image(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    red = io.BytesIO()
    Image.new("RGBA", (16, 16), (255, 0, 0, 255)).save(red, "PNG")
    first = (
        await client.post(
            "/api/v1/emoji",
            data={"name": "red"},
            files={"file": ("r.png", red.getvalue(), "image/png")},
        )
    ).json()
    second = (
        await client.post(
            "/api/v1/emoji", data={"name": "blue"}, files={"file": ("b.png", _png(), "image/png")}
        )
    ).json()
    a = await client.get(f"/api/v1/emoji/{first['id']}/image")
    b = await client.get(f"/api/v1/emoji/{second['id']}/image")
    assert a.status_code == 200 and b.status_code == 200 and a.content != b.content
    await client.delete(f"/api/v1/emoji/{second['id']}")
    assert (await client.get(f"/api/v1/emoji/{first['id']}/image")).status_code == 200


async def test_bookmarks_follow_membership_and_can_always_be_removed(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    hr = await _channel(client, "hr", type="private")
    await client.post(f"/api/v1/channels/{hr}/members", json={"user_id": str(bob.id)})
    message = (await _post(client, hr, "給与の件")).json()
    as_user(bob)
    await client.put(f"/api/v1/messages/{message['id']}/bookmark")
    assert len((await client.get("/api/v1/bookmarks")).json()["items"]) == 1
    await client.post(f"/api/v1/channels/{hr}/leave")
    assert (await client.get("/api/v1/bookmarks")).json()["items"] == []
    assert (await client.get("/api/v1/sync/bootstrap")).json()["bookmarks"] == []
    removed = await client.delete(f"/api/v1/messages/{message['id']}/bookmark")
    assert removed.status_code in (200, 204)


async def test_anonymizing_erases_the_whole_profile(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(alice)
    await client.patch(
        "/api/v1/users/me",
        json={"title": "経理", "status_text": "休暇中", "notify_keywords": ["給与"]},
    )
    as_user(root)
    done = await client.post(f"/api/v1/admin/users/{alice.id}/anonymize")
    assert done.status_code == 200, done.text
    await db.refresh(alice)
    assert (alice.title, alice.status_text, alice.notify_keywords, alice.avatar_key) == (
        None,
        None,
        None,
        None,
    )


@pytest.mark.parametrize("path", ["/api/v1/hooks/secret-token"])
def test_redact_is_idempotent(path: str) -> None:
    assert redact_path(redact_path(path)) == "/api/v1/hooks/***"
