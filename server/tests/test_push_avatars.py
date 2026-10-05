"""Sender pictures in message pushes (PUSH_NOTIFICATIONS.md §16): signed avatar URLs, payloads."""

import io
import json
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI
from httpx import AsyncClient
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.modules.auth.models import Device
from app.modules.avatars import signing
from app.modules.channels import service as channels
from app.modules.channels.models import Channel
from app.modules.channels.schemas import ChannelCreate
from app.modules.notifications.models import NotificationPreference
from app.modules.notifications.planner import PushPlanner
from app.modules.notifications.providers import APNsPushProvider, FCMPushProvider
from app.modules.users.models import User
from tests.helpers import make_user
from tests.test_auth_api import PASSWORD, bearer, login
from tests.test_push_planner import add_device, deliveries, post, relay_with_planner

SECRET = "s" * 48
USER = uuid.UUID("01890000-0000-7000-8000-000000000001")
WHEN = datetime(2026, 10, 6, 12, 0, 0, 123456, tzinfo=UTC)


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (64, 64), (200, 80, 40)).save(out, format="PNG")
    return out.getvalue()


def _query(path: str) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlsplit(path).query).items()}


# --- signing ---


def test_signed_path_verifies_only_for_its_user_version_and_lifetime() -> None:
    now = 1_800_000_000.0
    path = signing.signed_path(SECRET, USER, WHEN, now=now)
    assert path.startswith(f"/api/v1/users/{USER}/avatar/signed?")
    q = _query(path)
    v, exp, sig = q["v"], int(q["exp"]), q["sig"]
    assert v == signing.version_of(WHEN) and exp == int(now) + 24 * 3600
    assert signing.verify(SECRET, USER, v, exp, sig, now=now)
    assert signing.verify(SECRET, USER, v, exp, sig, now=exp)  # the last second still works
    assert not signing.verify(SECRET, USER, v, exp, sig, now=exp + 1)  # expired
    assert not signing.verify(SECRET, uuid.uuid4(), v, exp, sig, now=now)  # another user
    assert not signing.verify(SECRET, USER, v + "1", exp, sig, now=now)  # another picture
    assert not signing.verify(SECRET, USER, v, exp + 3600, sig, now=now)  # a longer life
    assert not signing.verify("t" * 48, USER, v, exp, sig, now=now)  # another server
    assert not signing.verify(SECRET, USER, v, exp, sig[:-1] + "A", now=now)
    assert not signing.verify("", USER, v, exp, sig, now=now)


# --- the unauthenticated endpoint ---


async def test_signed_avatar_is_served_without_a_session_only_with_a_valid_signature(
    app: FastAPI,
    client: AsyncClient,
    db: AsyncSession,
    as_user: Callable[[User], None],
    test_settings: Settings,
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    uploaded = await client.post(
        "/api/v1/users/me/avatar", files={"file": ("me.png", _png(), "image/png")}
    )
    assert uploaded.status_code == 200, uploaded.text
    app.dependency_overrides.clear()  # no session from here on
    await db.refresh(alice)
    assert alice.avatar_updated_at is not None
    path = signing.signed_path(test_settings.secret_key, alice.id, alice.avatar_updated_at)

    # The ordinary endpoint still wants a session.
    assert (await client.get(f"/api/v1/users/{alice.id}/avatar")).status_code == 401
    picture = await client.get(path)
    assert picture.status_code == 200, picture.text
    assert picture.headers["content-type"] == "image/png"
    assert picture.headers["x-content-type-options"] == "nosniff"
    with Image.open(io.BytesIO(picture.content)) as image:
        assert image.size == (256, 256)

    q = _query(path)
    tampered = path.replace(q["sig"], q["sig"][:-2] + ("AA" if q["sig"][-2:] != "AA" else "BB"))
    assert (await client.get(tampered)).status_code == 404
    bob = await make_user(db, "bob")  # the same signature on another user's path
    assert (await client.get(path.replace(str(alice.id), str(bob.id)))).status_code == 404
    expired = signing.signed_path(
        test_settings.secret_key, alice.id, alice.avatar_updated_at, now=time.time() - 25 * 3600
    )
    assert (await client.get(expired)).status_code == 404
    assert (await client.get(f"/api/v1/users/{alice.id}/avatar/signed")).status_code == 422

    # A new picture: the old URL is for the old one and stops working.
    as_user(alice)
    again = await client.post(
        "/api/v1/users/me/avatar", files={"file": ("me.png", _png(), "image/png")}
    )
    assert again.status_code == 200
    app.dependency_overrides.clear()
    assert (await client.get(path)).status_code == 404
    await db.refresh(alice)
    assert alice.avatar_updated_at is not None
    fresh = signing.signed_path(test_settings.secret_key, alice.id, alice.avatar_updated_at)
    assert (await client.get(fresh)).status_code == 200
    # Removed: nothing to serve.
    as_user(alice)
    assert (await client.delete("/api/v1/users/me/avatar")).status_code == 200
    app.dependency_overrides.clear()
    assert (await client.get(fresh)).status_code == 404


# --- devices.base_url ---


async def test_device_update_records_the_address_the_app_uses(
    client: AsyncClient, db: AsyncSession
) -> None:
    await make_user(db, "alice", password=PASSWORD)
    alice = await login(client, "alice")
    updated = await client.put(
        "/api/v1/devices/current",
        headers=bearer(alice),
        json={"push_provider": "apns", "push_token": "abc", "push_environment": "sandbox"},
    )
    assert updated.status_code == 200
    device = await db.get(Device, uuid.UUID(alice["device"]["id"]))
    assert device is not None
    await db.refresh(device)
    assert device.base_url == "http://testserver"


# --- planner payloads ---


async def _with_avatar(db: AsyncSession, user: User) -> None:
    user.avatar_key = f"avatars/{user.id}/x"
    user.avatar_updated_at = WHEN
    await db.commit()


async def test_message_payload_carries_sender_and_conversation(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await _with_avatar(db, alice)
    await add_device(db, bob)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    await post(db, alice, dm.id, "psst")
    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    payload = (await deliveries(db))[0].payload
    assert payload["sender_id"] == str(alice.id)
    assert payload["sender_name"] == alice.display_name
    assert payload["channel_type"] == "dm"
    assert payload["sender_avatar"] == WHEN.isoformat()
    q = _query(payload["sender_avatar_path"])
    assert payload["sender_avatar_path"].startswith(f"/api/v1/users/{alice.id}/avatar/signed?")
    assert signing.verify(test_settings.secret_key, alice.id, q["v"], int(q["exp"]), q["sig"])
    assert int(q["exp"]) > time.time() + 23 * 3600


async def test_channel_payload_and_a_sender_without_a_picture(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    channel = await channels.create_channel(db, alice, ChannelCreate(name="general"))
    await channels.join_channel(db, bob, channel.id)
    db.add(NotificationPreference(user_id=bob.id, channel_id=channel.id, level="all"))
    await db.commit()
    await post(db, alice, channel.id, "hello")
    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    payload = (await deliveries(db))[0].payload
    assert payload["title"] == "#general" and payload["subtitle"] == alice.display_name
    assert payload["channel_type"] == "public" and payload["sender_id"] == str(alice.id)
    assert payload["sender_avatar"] is None and payload["sender_avatar_path"] is None


async def test_hidden_content_sends_no_signed_url(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    """PUSH_INCLUDE_CONTENT=false: nothing that opens the picture passes through Apple / Google."""
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await _with_avatar(db, alice)
    await add_device(db, bob)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    await post(db, alice, dm.id, "secret")
    relay = relay_with_planner(
        app, test_settings.model_copy(update={"push_include_content": False})
    )
    while await relay.process_batch():
        pass
    payload = (await deliveries(db))[0].payload
    assert payload["body"] == "新しいメッセージ"
    assert payload["sender_avatar_path"] is None
    # The name is the DM's title already; the version only lets the app's own session fetch it.
    assert payload["sender_name"] == alice.display_name and payload["sender_avatar"]


# --- provider requests ---


def _device(base_url: str | None, platform: str = "ios") -> Device:
    return Device(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        platform=platform,
        push_provider="apns" if platform == "ios" else "fcm",
        push_token="abcd",
        push_environment="sandbox",
        base_url=base_url,
    )


def _message_payload(**extra: object) -> dict[str, object]:
    return {
        "kind": "message",
        "channel_id": str(uuid.uuid4()),
        "message_id": str(uuid.uuid4()),
        "title": "#general",
        "subtitle": "Alice",
        "body": "hi",
        "badge": 2,
        "collapse_key": "c",
        "sender_id": str(USER),
        "sender_name": "Alice",
        "sender_avatar": WHEN.isoformat(),
        "sender_avatar_path": f"/api/v1/users/{USER}/avatar/signed?v=1&exp=2&sig=x",
        "channel_type": "public",
    } | extra


def _apns() -> APNsPushProvider:
    key = (
        ec.generate_private_key(ec.SECP256R1())
        .private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        .decode()
    )
    return APNsPushProvider(key=key, key_id="K", team_id="T", bundle_id="jp.example.app")


def test_apns_message_is_mutable_with_an_absolute_signed_avatar_url() -> None:
    _, _, body = _apns().build_request(_device("https://chat.example.jp/"), _message_payload())
    assert body["aps"]["mutable-content"] == 1
    assert body["sender_id"] == str(USER) and body["sender_name"] == "Alice"
    assert body["channel_type"] == "public"
    assert body["sender_avatar_url"] == (
        f"https://chat.example.jp/api/v1/users/{USER}/avatar/signed?v=1&exp=2&sig=x"
    )
    assert "sender_avatar_path" not in body


def test_apns_without_a_known_address_or_path_sends_no_url() -> None:
    apns = _apns()
    _, _, body = apns.build_request(_device(None), _message_payload())
    assert body["aps"]["mutable-content"] == 1 and "sender_avatar_url" not in body
    _, _, body = apns.build_request(
        _device("https://chat.example.jp"), _message_payload(sender_avatar_path=None)
    )
    assert "sender_avatar_url" not in body


def test_apns_other_kinds_are_not_mutable() -> None:
    payload = {"kind": "reminder", "title": "x", "body": "y", "channel_id": str(uuid.uuid4())}
    _, _, body = _apns().build_request(_device("https://chat.example.jp"), payload)
    assert "mutable-content" not in body["aps"] and "sender_id" not in body


def test_apns_worst_case_message_fits_in_4kb() -> None:
    """Longest title / subtitle / body / name in Japanese (3 bytes a character) and every id."""
    long = "あ" * 120
    payload = _message_payload(
        title=long,
        subtitle=long,
        body="い" * 240,
        sender_name=long,
        workspace_id=str(uuid.uuid4()),
        parent_id=str(uuid.uuid4()),
        seq=123456789,
        sender_avatar_path=signing.signed_path(SECRET, USER, WHEN),
    )
    _, _, body = _apns().build_request(_device("https://" + "h" * 200 + ".example.jp"), payload)
    encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    assert len(encoded) < 4096, len(encoded)


def test_fcm_data_has_the_sender_but_no_signed_path() -> None:
    fcm = FCMPushProvider(project_id="p", client_email="e", private_key="k")
    message = fcm.build_message(_device("https://chat.example.jp", "android"), _message_payload())
    data = message["message"]["data"]
    assert data["sender_id"] == str(USER) and data["sender_name"] == "Alice"
    assert data["sender_avatar"] == WHEN.isoformat() and data["channel_type"] == "public"
    assert "sender_avatar_path" not in data and "sender_avatar_url" not in data
    assert all(isinstance(v, str) for v in data.values())


def test_build_payload_directly_for_group_dm() -> None:
    """The planner's payload for a group DM: the conversation is a group (iOS group style)."""
    settings = Settings(secret_key=SECRET)
    planner = PushPlanner(settings, is_active=lambda _: False)
    sender = User(id=USER, username="alice", display_name="Alice", avatar_key=None)
    channel = Channel(id=uuid.uuid4(), type="group_dm", name="g")
    payload = planner.build_payload(
        channel, sender, {"id": str(uuid.uuid4()), "body": "hi"}, 3, locale="en"
    )
    assert payload.channel_type == "group_dm" and payload.sender_id == USER
    assert payload.subtitle == "Alice" and payload.sender_avatar_path is None
