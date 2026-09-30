"""A message without text says what was sent (tester, 2026-09-30): 「画像を送信しました」
rather than 「新しいメッセージ」; the clients' one-line previews use the same words."""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import build_settings
from app.modules.channels import service as channels
from app.modules.channels.schemas import ChannelCreate
from app.modules.messages.mentions import attachment_text
from app.modules.notifications.planner import PushPlanner
from tests.helpers import make_user


def files(*types: str) -> list[dict[str, object]]:
    return [{"content_type": t, "filename": f"f{i}"} for i, t in enumerate(types)]


def test_attachment_text_rule() -> None:
    assert attachment_text([]) == ""
    assert attachment_text(files("image/png")) == "画像を送信しました"
    assert (
        attachment_text(files("image/png", "image/jpeg", "image/heic")) == "画像を 3 枚送信しました"
    )
    assert attachment_text(files("video/mp4")) == "動画を送信しました"
    assert attachment_text(files("video/mp4", "video/quicktime")) == "動画を 2 本送信しました"
    assert attachment_text(files("application/pdf")) == "ファイルを送信しました"
    assert attachment_text(files("image/png", "video/mp4")) == "ファイルを 2 件送信しました"


async def test_push_says_what_was_sent_when_there_is_no_text(db: AsyncSession) -> None:
    alice = await make_user(db, "alice")
    channel = await channels.create_channel(db, alice, ChannelCreate(name="photos"))
    row = await channels.require_channel(db, channel.id)
    message: dict[str, object] = {
        "id": str(uuid.uuid4()),
        "body": "",
        "attachments": files("image/png", "image/png"),
    }
    planner = PushPlanner(build_settings(), lambda _: False)
    assert planner.build_payload(row, alice, message, 1).body == "画像を 2 枚送信しました"
    # Text wins; with content hidden the push stays generic.
    assert (
        planner.build_payload(row, alice, {**message, "body": "旅行の写真"}, 1).body == "旅行の写真"
    )
    hidden = PushPlanner(build_settings(push_include_content=False), lambda _: False)
    assert hidden.build_payload(row, alice, message, 1).body == "新しいメッセージ"
