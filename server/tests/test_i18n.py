"""M115 (docs/I18N.md): the UI language. users.locale through PATCH /users/me, devices.locale from
Accept-Language, and the server's texts for one reader (errors, pushes, notices) in it."""

import json
import re
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import i18n
from app.core.settings import build_settings
from app.modules.auth.models import Device
from app.modules.calendar.service import AlarmNotice
from app.modules.channels import service as channels
from app.modules.channels.schemas import ChannelCreate
from app.modules.messages.mentions import attachment_text
from app.modules.notifications.planner import PushPlanner
from app.modules.recurring.schedule import due_label
from app.modules.users.models import User
from tests.helpers import make_user

ROOT = Path(__file__).resolve().parents[2]
PARAM = re.compile(r"\{(\w+)\}")


def test_every_message_has_every_language_and_the_same_parameters() -> None:
    for key, texts in i18n.messages().items():
        assert set(texts) == set(i18n.LOCALES), key
        params = {loc: set(PARAM.findall(text)) for loc, text in texts.items()}
        assert params["en"] == params["ja"] == params["zh-Hans"], key


def test_the_server_copy_of_the_error_texts_is_current() -> None:
    shared = json.loads((ROOT / "apps" / "shared" / "errors.json").read_text())
    copy = json.loads((ROOT / "server" / "app" / "i18n" / "errors.json").read_text())
    assert copy["codes"] == shared["codes"], "run python3 apps/shared/gen_errors.py"
    assert copy["status"] == shared["status"]
    for texts in shared["codes"].values():
        assert set(texts) >= set(i18n.LOCALES)


def test_accept_language() -> None:
    parse = i18n.from_accept_language
    assert parse(None) is None and parse("") is None
    assert parse("en-US,en;q=0.9,ja;q=0.8") == "en"
    assert parse("ja-JP") == "ja"
    assert parse("zh-CN,zh;q=0.9") == "zh-Hans"
    assert parse("zh-Hant-TW") == "zh-Hans"  # the only Chinese there is
    assert parse("fr-FR,de;q=0.9") is None  # none of ours: the caller falls back to ja
    assert parse("fr;q=1.0, en;q=0.5, ja;q=0.7") == "ja"  # by q
    assert parse("en;q=0, ja") == "ja"  # q=0 = not acceptable
    assert parse("garbage;;;,en") == "en"
    assert i18n.effective(None, "en") == "en"
    assert i18n.effective("zh-Hans", "en") == "zh-Hans"  # the person's choice wins
    assert i18n.effective(None, None) == "ja"


async def test_set_and_clear_my_locale(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    assert (await client.get("/api/v1/users/me")).json()["locale"] is None
    for value in ("en", "zh-Hans", "ja"):
        done = await client.patch("/api/v1/users/me", json={"locale": value})
        assert done.status_code == 200, done.text
        assert done.json()["locale"] == value
    await client.patch("/api/v1/users/me", json={"title": "M2"})  # other fields leave it alone
    await db.refresh(alice)
    assert (await client.get("/api/v1/users/me")).json()["locale"] == "ja"
    cleared = await client.patch("/api/v1/users/me", json={"locale": None})
    assert cleared.json()["locale"] is None
    assert await db.scalar(select(User.locale).where(User.id == alice.id)) is None
    bad = await client.patch("/api/v1/users/me", json={"locale": "fr"})
    assert bad.status_code == 422


async def test_error_messages_follow_accept_language_then_my_choice(
    client: AsyncClient, db: AsyncSession
) -> None:
    await make_user(db, "alice", password="alicepass123")
    wrong = {"username": "alice", "password": "nope-nope", "device": {"platform": "desktop"}}
    url = "/api/v1/auth/login"
    ja = await client.post(url, json=wrong)  # no header: ja
    assert ja.status_code == 401
    assert ja.json()["error"]["message"] == "ユーザー名またはパスワードが違います"
    en = await client.post(url, json=wrong, headers={"Accept-Language": "en-US,en;q=0.9"})
    assert en.json()["error"] == {
        "code": "invalid_credentials",
        "message": "Wrong username or password.",
        "details": {},
    }
    zh = await client.post(url, json=wrong, headers={"Accept-Language": "zh-CN"})
    assert zh.json()["error"]["message"] == "用户名或密码错误。"
    invalid = await client.post(url, json={}, headers={"Accept-Language": "en"})
    assert invalid.status_code == 422
    assert invalid.json()["error"]["message"] == "Check what you entered."

    # The app's language is remembered on the device (pushes); my choice beats the header.
    good = {**wrong, "password": "alicepass123"}
    tokens = (await client.post(url, json=good, headers={"Accept-Language": "zh-Hans"})).json()
    device = await db.scalar(select(Device).where(Device.id == uuid.UUID(tokens["device"]["id"])))
    assert device is not None and device.locale == "zh-Hans"
    auth = {"Authorization": f"Bearer {tokens['access_token']}", "Accept-Language": "zh-CN"}
    await client.patch("/api/v1/users/me", json={"locale": "en"}, headers=auth)
    missing = await client.get(f"/api/v1/channels/{uuid.uuid4()}", headers=auth)
    assert missing.status_code == 404
    assert missing.json()["error"]["message"] == "Channel not found."
    # A device update keeps the device's language current.
    await client.put("/api/v1/devices/current", json={}, headers={**auth, "Accept-Language": "ja"})
    await db.refresh(device)
    assert device.locale == "ja"


async def test_message_push_in_the_device_language(db: AsyncSession) -> None:
    alice = await make_user(db, "alice")
    channel = await channels.create_channel(db, alice, ChannelCreate(name="general"))
    row = await channels.require_channel(db, channel.id)
    message: dict[str, object] = {"id": str(uuid.uuid4()), "body": "", "priority": "urgent"}
    files = [{"content_type": "image/png"}, {"content_type": "image/jpeg"}]
    planner = PushPlanner(build_settings(), lambda _: False)
    en = planner.build_payload(row, alice, {**message, "attachments": files}, 1, locale="en")
    assert en.body == "[Urgent] Sent 2 images"
    zh = planner.build_payload(
        row, None, {**message, "body": "<@" + str(uuid.uuid4()) + "> hi"}, 1, locale="zh-Hans"
    )
    assert zh.body == "[紧急] @成员 hi" and zh.subtitle == "有人"
    hidden = PushPlanner(build_settings(push_include_content=False), lambda _: False)
    assert hidden.build_payload(row, alice, message, 1, locale="en").body == "[Urgent] New message"
    assert hidden.build_payload(row, alice, message, 1).body == "[緊急] 新しいメッセージ"
    assert attachment_text([{"content_type": "video/mp4"}], "en") == "Sent a video"


async def test_device_and_text_locale(db: AsyncSession) -> None:
    alice = await make_user(db, "alice")
    assert await i18n.text_locale(db, alice) == "ja"  # nothing known
    phone = Device(user_id=alice.id, platform="ios", locale="en", last_seen_at=datetime.now(UTC))
    db.add(phone)
    await db.commit()
    assert await i18n.text_locale(db, alice) == "en"  # the device used last
    assert i18n.device_locale(alice, phone) == "en"
    alice.locale = "zh-Hans"
    await db.commit()
    assert await i18n.text_locale(db, alice) == "zh-Hans"  # the person's choice
    assert i18n.device_locale(alice, phone) == "zh-Hans"


def test_dates_and_notices_per_language() -> None:
    moment = datetime(2026, 10, 9, 9, 0, tzinfo=UTC)  # Friday 18:00 in Tokyo
    assert due_label(moment, "Asia/Tokyo") == "10/9 (金) 18:00"
    assert due_label(moment, "Asia/Tokyo", "en") == "Fri 10/9 18:00"
    assert due_label(moment, "Asia/Tokyo", "zh-Hans") == "10/9（周五）18:00"
    notice = AlarmNotice(
        event_id=uuid.uuid4(),
        channel_id=None,
        body="明日 9:00 ゼミ",
        bodies={"en": "Tomorrow 9:00 ゼミ"},
    )
    assert notice.text("en") == "Tomorrow 9:00 ゼミ" and notice.text("zh-Hans") == "明日 9:00 ゼミ"
    assert i18n.t("reminder.ack_note", "en", name="Bob") == "Bob asks you to acknowledge"
    assert i18n.t("push.test.body", "fr") == i18n.t("push.test.body", "ja")  # unknown: ja
