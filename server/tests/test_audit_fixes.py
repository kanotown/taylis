"""Server audit fixes (M28a, 2026-09-29): one regression test per latent bug the audit found."""

import asyncio
import hashlib
import io
import secrets
import struct
import uuid
import zlib
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings, build_settings
from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.events.outbox import purge_processed, write_outbox
from app.modules.attachments import service as attachments
from app.modules.attachments.models import Attachment
from app.modules.auth import service as auth
from app.modules.auth.models import Device, UserSession
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.channels.schemas import ChannelCreate
from app.modules.groups import repository as groups_repo
from app.modules.importer.mattermost_import import MattermostImport, read_dump
from app.modules.link_previews.models import LinkPreview
from app.modules.messages import repository as messages_repo
from app.modules.messages import service as messages
from app.modules.messages.schemas import MessageCreate, PollCreate
from app.modules.notifications.planner import PushPlanner
from app.modules.notifications.providers import FakePushProvider
from app.modules.notifications.sender import PushSender
from app.modules.reads import repository as reads_repo
from app.modules.reads import service as reads
from app.modules.reads.models import ReadState
from app.modules.reminders import service as reminders
from app.modules.scheduled import repository as scheduled_repo
from app.modules.scheduled import service as scheduled
from app.modules.scheduled.models import ScheduledMessage
from app.modules.threads import repository as threads_repo
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_attachments import png_bytes, upload
from tests.test_auth_api import PASSWORD, login
from tests.test_link_previews import PAGE
from tests.test_mattermost_import import T0, _messages, _people, _post, _records, _run, _write
from tests.test_push_planner import add_device, deliveries, relay_with_planner


async def _send(client: AsyncClient, channel_id: str, body: str, **extra: Any) -> dict[str, Any]:
    response = await client.post(
        f"/api/v1/channels/{channel_id}/messages",
        json={"client_msg_id": str(uuid.uuid4()), "body": body, **extra},
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


async def _read_state(client: AsyncClient, channel_id: str) -> dict[str, Any]:
    bootstrap = (await client.get("/api/v1/sync/bootstrap")).json()
    state: dict[str, Any] = next(
        c["read_state"] for c in bootstrap["channels"] if c["id"] == channel_id
    )
    return state


# --- 1. scheduled messages ---------------------------------------------------------------------


async def test_a_scheduled_body_is_checked_at_creation_and_a_bad_row_fails_alone(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A body of control characters used to pass the schedule and blow up at the send; as the
    worker takes rows by time, that one row then held back every later message of everyone."""
    alice = await make_user(db, "alice")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    refused = await client.post(
        f"/api/v1/channels/{general['id']}/scheduled",
        json={
            "client_msg_id": str(uuid.uuid4()),
            "body": "\u0001",
            "send_at": (utcnow() + timedelta(hours=1)).isoformat(),
        },
    )
    assert refused.status_code == 422

    # A row from before the check, one whose send raises something unexpected, and a good one
    # behind them: each fails (or lands) on its own.
    for minutes, body in ((3, "\u0001"), (2, "boom"), (1, "lands")):
        db.add(
            ScheduledMessage(
                user_id=alice.id,
                channel_id=uuid.UUID(general["id"]),
                client_msg_id=uuid.uuid4(),
                body=body,
                attachment_ids=[],
                send_at=utcnow() - timedelta(minutes=minutes),
            )
        )
    await db.commit()
    real_create = messages.create_message

    async def flaky(db_: AsyncSession, *args: Any, **kwargs: Any) -> Any:
        if args[2].body == "boom":
            raise RuntimeError("boom")
        return await real_create(db_, *args, **kwargs)

    monkeypatch.setattr(messages, "create_message", flaky)  # the module scheduled calls
    async with app.state.db.session_factory() as worker_db:
        assert await scheduled.send_due(worker_db) == 1
        assert await scheduled.send_due(worker_db) == 0
    listed = (await client.get("/api/v1/scheduled")).json()
    assert sorted((r["body"], r["status"], r["error"]) for r in listed) == [
        ("\u0001", "failed", "invalid_body"),
        ("boom", "failed", "send_failed"),
    ]
    history = (await client.get(f"/api/v1/channels/{general['id']}/messages")).json()
    assert [m["body"] for m in history["messages"]] == ["lands"]


async def test_a_scheduled_retry_that_overtakes_its_first_request_gets_the_same_row(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    payload = {
        "client_msg_id": str(uuid.uuid4()),
        "body": "twice",
        "send_at": (utcnow() + timedelta(hours=1)).isoformat(),
    }
    first = await client.post(f"/api/v1/channels/{general['id']}/scheduled", json=payload)
    assert first.status_code == 201, first.text
    # The retry's lookup misses (the first insert was not visible to it yet) and its own insert
    # hits the unique key: the answer is the first row, not a 500.
    real_get = scheduled_repo.get_by_client_msg_id
    calls = 0

    async def miss_once(db_: AsyncSession, key: uuid.UUID) -> ScheduledMessage | None:
        nonlocal calls
        calls += 1
        return None if calls == 1 else await real_get(db_, key)

    monkeypatch.setattr(scheduled_repo, "get_by_client_msg_id", miss_once)
    again = await client.post(f"/api/v1/channels/{general['id']}/scheduled", json=payload)
    assert again.status_code == 201, again.text
    assert again.json()["id"] == first.json()["id"] and calls == 2
    assert len((await client.get("/api/v1/scheduled")).json()) == 1


async def test_open_reminders_and_scheduled_messages_are_capped(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(reminders, "MAX_OPEN_PER_USER", 1)
    monkeypatch.setattr(scheduled, "MAX_OPEN_PER_USER", 1)
    alice = await make_user(db, "alice")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    message = await _send(client, general["id"], "remind me")
    later = (utcnow() + timedelta(hours=1)).isoformat()

    def reminder() -> Any:
        return client.post(f"/api/v1/messages/{message['id']}/reminders", json={"remind_at": later})

    def schedule() -> Any:
        return client.post(
            f"/api/v1/channels/{general['id']}/scheduled",
            json={"client_msg_id": str(uuid.uuid4()), "body": "later", "send_at": later},
        )

    first = await reminder()
    assert first.status_code == 201
    full = await reminder()
    assert full.status_code == 409 and full.json()["error"]["code"] == "too_many_reminders"
    assert (await client.delete(f"/api/v1/reminders/{first.json()['id']}")).status_code == 204
    assert (await reminder()).status_code == 201  # closed ones do not count
    first = await schedule()
    assert first.status_code == 201
    full = await schedule()
    assert full.status_code == 409 and full.json()["error"]["code"] == "too_many_scheduled"
    assert (await client.delete(f"/api/v1/scheduled/{first.json()['id']}")).status_code == 204
    assert (await schedule()).status_code == 201


# --- 2. rejoining -----------------------------------------------------------------------------


async def test_rejoining_a_channel_starts_read_at_its_end(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """The read position outlives the membership (DATA_MODEL.md); joining again must move it to
    the end, as a first join does, not leave a year of "unread" behind."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    cid = (await client.post("/api/v1/channels", json={"name": "general"})).json()["id"]
    as_user(bob)
    assert (await client.post(f"/api/v1/channels/{cid}/join")).status_code == 200
    as_user(alice)
    await _send(client, cid, "while bob is here")
    as_user(bob)
    assert (await _read_state(client, cid))["unread_count"] == 1
    assert (await client.post(f"/api/v1/channels/{cid}/leave")).status_code == 204
    as_user(alice)
    for body in ("away 1", "away 2", f"<@{bob.id}> away 3"):
        await _send(client, cid, body)
    as_user(bob)
    assert (await client.post(f"/api/v1/channels/{cid}/join")).status_code == 200
    assert await _read_state(client, cid) == {
        "last_read_seq": 4,
        "unread_count": 0,
        "mention_count": 0,
        "first_unread_at": None,
    }
    # Added back by someone else: the same.
    assert (await client.post(f"/api/v1/channels/{cid}/leave")).status_code == 204
    as_user(alice)
    await _send(client, cid, "away again")
    added = await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(bob.id)})
    assert added.status_code == 200
    as_user(bob)
    assert (await _read_state(client, cid))["unread_count"] == 0


# --- 3. devices whose sessions ran out ---------------------------------------------------------


async def test_devices_without_a_live_session_are_disabled_by_the_sweep(
    client: AsyncClient, db: AsyncSession
) -> None:
    await make_user(db, "alice", password=PASSWORD)
    phone = await login(client, "alice")
    desktop = await login(client, "alice")
    session = await db.get(UserSession, uuid.UUID(phone["session_id"]))
    assert session is not None
    session.expires_at = utcnow() - timedelta(days=1)
    await db.commit()

    assert await auth.disable_expired_devices(db, utcnow()) == 1
    await db.commit()
    phone_device = await db.get(Device, uuid.UUID(phone["device"]["id"]))
    desktop_device = await db.get(Device, uuid.UUID(desktop["device"]["id"]))
    assert phone_device is not None and desktop_device is not None
    assert not phone_device.enabled and phone_device.disabled_reason == "session_expired"
    assert desktop_device.enabled
    assert await auth.disable_expired_devices(db, utcnow()) == 0
    # The next login makes a fresh, enabled device; the old one can neither refresh nor push.
    again = await login(client, "alice")
    fresh = await db.get(Device, uuid.UUID(again["device"]["id"]))
    assert fresh is not None and fresh.enabled
    stale = await client.post(
        "/api/v1/auth/refresh", json={"refresh_token": phone["refresh_token"]}
    )
    assert stale.status_code == 401


# --- 4. unread counts in one query --------------------------------------------------------------


async def test_states_for_every_channel_match_the_per_channel_counts(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    """The grouped query behind bootstrap, the summary and each push's badge gives the numbers
    the one-channel query gives, over channels with mentions, replies, deletions, a DM and one
    without a read row at all."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()["id"]
    random = (await client.post("/api/v1/channels", json={"name": "random"})).json()["id"]
    quiet = (await client.post("/api/v1/channels", json={"name": "quiet"})).json()["id"]
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})).json()["id"]
    as_user(bob)
    for cid in (general, random, quiet):
        await client.post(f"/api/v1/channels/{cid}/join")
    as_user(alice)
    parent = await _send(client, general, "m1")
    await _send(client, general, f"<@{bob.id}> m2")
    await _send(client, general, "thread only", parent_id=parent["id"])
    await _send(client, general, "also here", parent_id=parent["id"], also_in_channel=True)
    gone = await _send(client, general, "deleted")
    await client.delete(f"/api/v1/messages/{gone['id']}")
    await _send(client, random, "r1")
    await _send(client, random, "<!channel> r2")
    await _send(client, dm, "hi")
    await _send(client, dm, "there")
    as_user(bob)
    # Bob's own reply in the timeline (a reply does not move his channel position): not unread.
    await _send(client, general, "bob's own", parent_id=parent["id"], also_in_channel=True)
    await client.put(f"/api/v1/channels/{random}/read", json={"last_read_seq": 1})
    # No row at all (as before M8b's initialisation): counted from 0.
    await db.execute(
        delete(ReadState).where(ReadState.user_id == bob.id, ReadState.channel_id == uuid.UUID(dm))
    )
    await db.commit()

    listed = [c.id for c in await channels.list_channels(db, bob, include_public=False)]
    assert len(listed) == 4
    batched = await reads.states_for_user(db, bob.id, listed)
    for cid in listed:
        assert batched[cid] == await reads.state_for(db, bob.id, cid), cid
    by_id = {str(cid): state for cid, state in batched.items()}
    assert (by_id[general].unread_count, by_id[general].mention_count) == (3, 1)
    assert (by_id[random].unread_count, by_id[random].mention_count) == (1, 1)
    assert (by_id[quiet].unread_count, by_id[quiet].first_unread_at) == (0, None)
    assert (by_id[dm].last_read_seq, by_id[dm].unread_count) == (0, 2)
    assert by_id[general].first_unread_at == datetime.fromisoformat(parent["created_at"])
    planner = PushPlanner(build_settings(), is_active=lambda _uid: False)
    assert await planner.badge_for(db, bob.id) == 2 + 1 + 1  # DM unread + the two mentions


# --- 5. uploads: memory ------------------------------------------------------------------------


def _png_claiming(width: int, height: int) -> bytes:
    """A 1x1 PNG whose header claims another size: what a decompression bomb looks like before
    any pixel is decoded (the body is never read for the size)."""
    data = png_bytes(1, 1)
    ihdr = b"IHDR" + struct.pack(">II", width, height) + data[24:29]
    return data[:12] + ihdr + struct.pack(">I", zlib.crc32(ihdr) & 0xFFFFFFFF) + data[33:]


async def test_huge_images_are_refused_from_the_header(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    for width, height in ((7500, 7000), (20000, 20000)):  # over the cap; over PIL's ceiling
        refused = await upload(client, "big.png", _png_claiming(width, height), "image/png")
        assert refused.status_code == 422, refused.text
        assert refused.json()["error"]["code"] == "image_too_large"
        avatar = await client.post(
            "/api/v1/users/me/avatar",
            files={"file": ("me.png", _png_claiming(width, height), "image/png")},
        )
        assert avatar.status_code == 422 and avatar.json()["error"]["code"] == "image_too_large"
    assert list((await db.execute(select(Attachment))).scalars()) == []
    small = await upload(client, "ok.png", _png_claiming(1, 1), "image/png")
    assert small.status_code == 201


async def test_uploads_are_spooled_to_disk_not_held_twice_in_memory(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(attachments, "SPOOL_MAX_BYTES", 1024)  # everything below goes to disk
    alice = await make_user(db, "alice")
    as_user(alice)
    blob = secrets.token_bytes(100_000)
    stored = await upload(client, "big.bin", blob, "application/octet-stream")
    assert stored.status_code == 201, stored.text
    meta = stored.json()
    assert meta["size_bytes"] == len(blob) and meta["content_type"] == "application/octet-stream"
    row = await db.get(Attachment, uuid.UUID(meta["id"]))
    assert row is not None and row.sha256 == hashlib.sha256(blob).digest()
    content = await client.get(f"/api/v1/attachments/{meta['id']}/content")
    assert content.status_code == 200 and content.content == blob
    # A spooled image still gets its thumbnail from the same file.
    noisy = io.BytesIO()
    Image.effect_noise((200, 150), 100).convert("RGB").save(noisy, format="PNG")
    assert len(noisy.getvalue()) > 1024
    image = await upload(client, "noise.png", noisy.getvalue(), "image/png")
    assert image.status_code == 201, image.text
    assert (image.json()["width"], image.json()["height"]) == (200, 150)
    assert image.json()["has_thumbnail"] is True
    thumb = await client.get(f"/api/v1/attachments/{image.json()['id']}/thumbnail")
    assert thumb.status_code == 200 and Image.open(io.BytesIO(thumb.content)).size == (200, 150)
    assert app.state.blobs.objects[f"attachments/{meta['id']}"][0] == blob


# --- 6. the importer and a live post -----------------------------------------------------------


async def test_import_continues_after_a_post_made_while_it_ran(
    app: FastAPI, db: AsyncSession, tmp_path: Any
) -> None:
    """A rerun read `last_seq` once at the start; a message posted before the batch would then
    have been given the same seq (a unique-key failure), or `last_seq` written back below it."""
    people = await _people(db)
    await _run(app, db, _write(tmp_path / "ebi.jsonl", _records()), None)  # no files needed
    later = [_post("p6", "c-gen", "u-kano", "after a live post", T0 + 9000)]
    dump = read_dump(_write(tmp_path / "ebi2.jsonl", _records(later)))
    settings: Settings = app.state.settings
    job = MattermostImport(
        db,
        dump,
        files_root=None,
        user_map={"alicemm": "kano", "bobmm": "ebi"},
        actor=people["admin"],
        blobs=app.state.blobs,
        settings=settings,
        dry_run=False,
    )
    # The steps of MattermostImport.run, with a post landing between the channels and the posts.
    await job._people()
    await job._emoji()
    await job._commit()
    await job._channels()
    await job._commit()
    general = (await db.execute(select(Channel).where(Channel.name == "general"))).scalar_one()
    async with app.state.db.session_factory() as other:
        kano = await other.get(User, people["kano"].id)
        assert kano is not None
        await messages.create_message(
            other, kano, general.id, MessageCreate(client_msg_id=uuid.uuid4(), body="live")
        )
    await job._posts()
    await job._threads_and_reads()
    await job._announce()
    await job._commit()

    rows = await _messages(db, general.id)
    assert [m.seq for m in rows] == [1, 2, 3, 4, 5, 6, 7]
    assert [m.body for m in rows[-2:]] == ["live", "after a live post"]
    stmt = select(Channel.last_seq, Channel.last_message_at).where(Channel.id == general.id)
    last_seq, last_message_at = (await db.execute(stmt)).one()
    assert last_seq == 7 and last_message_at is not None
    assert job.report.counts["posts"] == 1


# --- 7. webhooks into private channels ---------------------------------------------------------


async def test_a_webhook_needs_its_maker_in_a_private_channel(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    owner = await make_user(db, "owner")
    as_user(owner)
    secret = (
        await client.post("/api/v1/channels", json={"name": "secret", "type": "private"})
    ).json()
    as_user(root)
    public = (await client.post("/api/v1/channels", json={"name": "alerts"})).json()
    denied = await client.post(
        "/api/v1/admin/webhooks", json={"name": "CI", "channel_id": secret["id"]}
    )
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_a_member"
    created = await client.post(
        "/api/v1/admin/webhooks", json={"name": "CI", "channel_id": public["id"]}
    )
    assert created.status_code == 201, created.text
    hook = created.json()["webhook"]
    moved = await client.patch(
        f"/api/v1/admin/webhooks/{hook['id']}", json={"channel_id": secret["id"]}
    )
    assert moved.status_code == 403
    members = (await client.get(f"/api/v1/channels/{secret['id']}/members")).status_code
    assert members == 403  # the administrator is not in it either
    as_user(owner)
    added = await client.post(
        f"/api/v1/channels/{secret['id']}/members", json={"user_id": str(root.id)}
    )
    assert added.status_code == 200
    as_user(root)
    moved = await client.patch(
        f"/api/v1/admin/webhooks/{hook['id']}", json={"channel_id": secret["id"]}
    )
    assert moved.status_code == 200 and moved.json()["channel_id"] == secret["id"]


# --- 8. unique-key races ------------------------------------------------------------------------


async def test_first_read_positions_from_two_devices_do_not_collide(
    app: FastAPI, db: AsyncSession
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    channel = await channels.create_channel(db, alice, ChannelCreate(name="general"))
    await channels.join_channel(db, bob, channel.id)
    parent, _ = await messages.create_message(
        db, alice, channel.id, MessageCreate(client_msg_id=uuid.uuid4(), body="topic")
    )
    for n in range(3):
        await messages.create_message(
            db,
            alice,
            channel.id,
            MessageCreate(client_msg_id=uuid.uuid4(), body=f"r{n}", parent_id=parent.id),
        )
    await db.execute(delete(ReadState).where(ReadState.user_id == alice.id))  # as before M8b
    await db.commit()

    async with (
        app.state.db.session_factory() as first,
        app.state.db.session_factory() as second,
    ):
        # The channel position: the first device inserts, the second waits on the key, then
        # only moves the position forward.
        assert await reads_repo.advance(first, alice.id, channel.id, 3) == (3, True)
        later = asyncio.create_task(reads_repo.advance(second, alice.id, channel.id, 4))
        await asyncio.sleep(0.2)
        assert not later.done()
        await first.commit()
        assert await asyncio.wait_for(later, 5) == (4, True)
        await second.commit()
        assert (await reads_repo.advance(first, alice.id, channel.id, 2)) == (4, False)
        await first.commit()
        # The thread position, the same way (bob never touched the thread).
        assert await threads_repo.advance_read(first, parent.id, bob.id, 3) == (3, True)
        later = asyncio.create_task(threads_repo.advance_read(second, parent.id, bob.id, 2))
        await asyncio.sleep(0.2)
        assert not later.done()
        await first.commit()
        assert await asyncio.wait_for(later, 5) == (3, False)
        await second.commit()
    row = await db.get(ReadState, (alice.id, channel.id))
    assert row is not None and row.last_read_seq == 4
    follow = await threads_repo.get(db, parent.id, bob.id)
    assert follow is not None and follow.last_read_seq == 3 and follow.following is False


async def test_two_previews_of_the_same_page_at_once_share_one_row(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    both_in = asyncio.Event()
    arrivals = 0

    async def slow_fetch(url: str) -> tuple[str, str]:
        nonlocal arrivals
        arrivals += 1
        if arrivals == 2:
            both_in.set()
        await asyncio.wait_for(both_in.wait(), 5)  # neither finds the other's row in the cache
        return url, PAGE

    app.state.link_fetcher = slow_fetch
    params = {"url": "https://wiki.example.com/pages/9"}
    first, second = await asyncio.gather(
        client.get("/api/v1/link-previews", params=params),
        client.get("/api/v1/link-previews", params=params),
    )
    assert first.status_code == 200 and second.status_code == 200, (first.text, second.text)
    assert first.json()["title"] == second.json()["title"] == "リリース手順 & チェックリスト"
    assert (await db.execute(select(func.count()).select_from(LinkPreview))).scalar_one() == 1


async def test_a_group_rename_that_loses_a_race_is_a_conflict(
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = await make_user(db, "root", role="admin")
    as_user(root)
    await client.post("/api/v1/admin/groups", json={"name": "design"})
    ops = (await client.post("/api/v1/admin/groups", json={"name": "ops"})).json()

    async def free(*_args: Any, **_kwargs: Any) -> bool:
        return False  # the name was taken after the check, before the write

    monkeypatch.setattr(groups_repo, "name_taken", free)
    renamed = await client.patch(f"/api/v1/admin/groups/{ops['id']}", json={"name": "design"})
    assert renamed.status_code == 409 and renamed.json()["error"]["code"] == "name_taken"
    assert sorted(g["name"] for g in (await client.get("/api/v1/groups")).json()) == [
        "design",
        "ops",
    ]


# --- 9. single-choice polls ---------------------------------------------------------------------


async def test_single_choice_votes_from_two_devices_keep_one(
    app: FastAPI, db: AsyncSession
) -> None:
    alice = await make_user(db, "alice")
    channel = await channels.create_channel(db, alice, ChannelCreate(name="lunch"))
    poll, _ = await messages.create_message(
        db,
        alice,
        channel.id,
        MessageCreate(
            client_msg_id=uuid.uuid4(),
            poll=PollCreate(question="どこ?", options=["そば", "カレー"]),
        ),
    )
    async with (
        app.state.db.session_factory() as first,
        app.state.db.session_factory() as second,
    ):
        on_first = await first.get(User, alice.id)
        on_second = await second.get(User, alice.id)
        assert on_first is not None and on_second is not None
        # The first device is mid-vote (it holds the channel row, as every write does).
        await first.execute(select(Channel.id).where(Channel.id == channel.id).with_for_update())
        later = asyncio.create_task(messages.set_vote(second, on_second, poll.id, 1, present=True))
        await asyncio.sleep(0.2)
        assert not later.done()
        await messages.set_vote(first, on_first, poll.id, 0, present=True)  # commits
        _, changed = await asyncio.wait_for(later, 5)
        assert changed
    assert await messages_repo.user_votes(db, poll.id, alice.id) == {1}  # the later vote only


# --- 10. replies read in their thread ---------------------------------------------------------


async def test_a_reply_read_in_its_thread_is_not_pushed(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    phone = await add_device(db, alice)
    db.add(
        UserSession(
            user_id=alice.id,
            device_id=phone.id,
            refresh_token_hash=secrets.token_bytes(32),
            expires_at=utcnow() + timedelta(days=1),
        )
    )
    await db.commit()
    as_user(alice)
    cid = (await client.post("/api/v1/channels", json={"name": "general"})).json()["id"]
    as_user(bob)
    await client.post(f"/api/v1/channels/{cid}/join")
    as_user(alice)
    parent = await _send(client, cid, "topic")  # seq 1: alice's channel position
    as_user(bob)
    first = await _send(client, cid, "r1", parent_id=parent["id"])  # seq 2
    as_user(alice)
    read = await client.put(
        f"/api/v1/messages/{parent['id']}/thread/read", json={"last_read_seq": 2}
    )
    assert read.status_code == 200

    # Planning: the thread's position says the reply is read (the channel's would not).
    planner = PushPlanner(build_settings(), is_active=lambda _uid: False)
    record = await channels.require_channel(db, uuid.UUID(cid))
    assert (
        await planner.select_recipients(
            db, record, [alice.id], first, {alice.id, bob.id}, parent_id=uuid.UUID(parent["id"])
        )
        == []
    )
    assert await planner.select_recipients(db, record, [alice.id], first, {alice.id, bob.id}) == [
        alice.id
    ]
    # Sending: a reply planned while unread, then read in the thread before the sender got to it.
    as_user(bob)
    await _send(client, cid, "r2", parent_id=parent["id"])  # seq 3
    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    rows = await deliveries(db)
    assert [r.message_seq for r in rows] == [3] and rows[0].payload["parent_id"] == parent["id"]
    as_user(alice)
    await client.put(f"/api/v1/messages/{parent['id']}/thread/read", json={"last_read_seq": 3})
    provider = FakePushProvider()
    assert await PushSender(app.state.db, {"apns": provider}).process_batch() == 1
    assert provider.sent == []
    db.expire_all()
    assert (await deliveries(db))[0].last_error == "already_read"


# --- 11. outbox rows given up on --------------------------------------------------------------


async def test_given_up_outbox_rows_are_purged_and_not_counted_as_pending(
    app: FastAPI, client: AsyncClient, db: AsyncSession
) -> None:
    old = await write_outbox(db, event_type="broken", audience_type="channel", payload={})
    recent = await write_outbox(db, event_type="broken", audience_type="channel", payload={})
    pending = await write_outbox(db, event_type="fine", audience_type="all", payload={})
    await db.commit()
    await db.execute(
        update(OutboxEvent)
        .where(OutboxEvent.id.in_([old.id, recent.id]))
        .values(attempts=app.state.settings.outbox_max_attempts)
    )
    await db.execute(
        update(OutboxEvent)
        .where(OutboxEvent.id == old.id)
        .values(created_at=utcnow() - timedelta(days=8))
    )
    await db.commit()

    checks = (await client.get("/readyz")).json()["checks"]
    assert (checks["outbox_pending"], checks["outbox_failed"]) == (1, 2)
    assert await purge_processed(app.state.db, timedelta(days=7), max_attempts=10) == 1
    remaining = (await db.execute(select(OutboxEvent.id).order_by(OutboxEvent.id))).scalars().all()
    assert remaining == [recent.id, pending.id]


# --- 12. guests and a public channel's card ---------------------------------------------------


async def test_a_guest_gets_nothing_of_a_public_channel_they_are_not_in(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    member = await make_user(db, "member")
    guest = await make_user(db, "guest", role="guest")
    as_user(alice)
    cid = (await client.post("/api/v1/channels", json={"name": "general", "topic": "秘"})).json()[
        "id"
    ]
    as_user(member)
    assert (await client.get(f"/api/v1/channels/{cid}")).status_code == 200  # the preview
    as_user(guest)
    denied = await client.get(f"/api/v1/channels/{cid}")
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_a_member"
    as_user(alice)
    await client.post(f"/api/v1/channels/{cid}/members", json={"user_id": str(guest.id)})
    as_user(guest)
    assert (await client.get(f"/api/v1/channels/{cid}")).json()["topic"] == "秘"


# --- 13. search flags --------------------------------------------------------------------------


async def test_too_many_search_flags_are_a_validation_error(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    flags = ["file", "link", "pin", "reaction", "poll"]
    ok = await client.get("/api/v1/search/messages", params={"q": "x", "has": flags})
    assert ok.status_code == 200, ok.text
    over = await client.get("/api/v1/search/messages", params={"q": "x", "has": [*flags, "file"]})
    assert over.status_code == 422 and over.json()["error"]["code"] == "validation_error"
