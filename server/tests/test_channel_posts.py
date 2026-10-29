"""CF5 (docs/CHANNEL_FILES.md §26): POST /drive/channel-posts — where a file too big to attach goes
in a channel: its 「投稿のファイル」 and this month's folder, made when missing (the same folders a
send files into), null with the switch off; who may ask; and the bootstrap's zone."""

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.events.models import OutboxEvent
from app.modules.drive import channel_files
from app.modules.drive.models import DriveItem
from app.modules.users.models import User
from tests.drive_helpers import act_as
from tests.helpers import make_user
from tests.test_channel_files import (
    PDF,
    channel_location,
    expected_month,
    make_channel,
    post,
    row,
    set_workspace_switch,
)

API = "/api/v1"


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


async def ask(client: AsyncClient, channel_id: str) -> Response:
    return await client.post(f"{API}/drive/channel-posts", json={"channel_id": channel_id})


def code(response: Response) -> Any:
    return response.json()["error"]["code"]


async def posts_folders(db: AsyncSession) -> int:
    stmt = select(func.count()).where(DriveItem.system_role == "channel_posts")
    return int((await db.execute(stmt)).scalar_one())


async def test_makes_the_posts_folder_and_the_month_once(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)
    lab = await make_channel(client, "lab", [bob])
    as_user(bob)
    got = await ask(client, lab["id"])
    assert got.status_code == 200, got.text
    body = got.json()
    month = expected_month(utcnow())
    assert body["files_to_drive"] is True
    assert body["month"] == month and body["timezone"] == "Asia/Tokyo"
    assert body["location"]["kind"] == "channel" and body["location"]["channel_id"] == lab["id"]
    assert body["location"]["can_write"] is True
    posts, folder = body["posts_folder"], body["month_folder"]
    assert posts["system_role"] == "channel_posts"
    assert posts["name"] == channel_files.POSTS_FOLDER_NAME
    assert posts["parent_id"] == body["location"]["root_id"]
    assert folder["name"] == month and folder["parent_id"] == posts["id"]
    assert folder["system_role"] is None
    assert (await channel_location(db, lab["id"])).item_count == 2
    changed = (
        await db.execute(select(OutboxEvent).where(OutboxEvent.event_type == "drive.changed"))
    ).scalars()
    assert any(
        e.payload["folder_ids"] == sorted([body["location"]["root_id"], posts["id"]])
        for e in changed
    )

    # Again: the same folders, nothing more made.
    again = (await ask(client, lab["id"])).json()
    assert again["posts_folder"]["id"] == posts["id"]
    assert again["month_folder"]["id"] == folder["id"]
    assert (await channel_location(db, lab["id"])).item_count == 2
    assert await posts_folders(db) == 1

    # A send files into the very same month folder.
    sent = await post(client, lab["id"], [("a.pdf", PDF)])
    item = await db.get(DriveItem, (await row(db, sent["attachments"][0]["id"])).drive_item_id)
    assert item is not None and str(item.parent_id) == folder["id"]
    assert await posts_folders(db) == 1


async def test_reuses_the_folders_a_send_made_and_remakes_a_trashed_month(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    sent = await post(client, lab["id"], [("a.pdf", PDF)])
    item = await db.get(DriveItem, (await row(db, sent["attachments"][0]["id"])).drive_item_id)
    assert item is not None
    month_id = str(item.parent_id)
    body = (await ask(client, lab["id"])).json()
    assert body["month_folder"]["id"] == month_id
    # The month folder in the trash: a new one of the same name.
    trashed = await client.post(f"{API}/drive/items/trash", json={"item_ids": [month_id]})
    assert trashed.status_code == 200, trashed.text
    fresh = (await ask(client, lab["id"])).json()
    assert fresh["posts_folder"]["id"] == body["posts_folder"]["id"]
    assert fresh["month_folder"]["id"] != month_id
    assert fresh["month_folder"]["name"] == body["month"]


async def test_the_switch_off_makes_nothing(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    quiet = await make_channel(client, "quiet", [])
    await client.patch(f"{API}/channels/{quiet['id']}", json={"files_to_drive": False})
    body = (await ask(client, quiet["id"])).json()
    assert body["files_to_drive"] is False
    assert body["posts_folder"] is None and body["month_folder"] is None
    assert body["location"]["channel_id"] == quiet["id"] and body["location"]["can_write"]
    await set_workspace_switch(db, False)
    assert (await ask(client, lab["id"])).json()["files_to_drive"] is False
    assert await posts_folders(db) == 0
    assert (await channel_location(db, lab["id"])).item_count == 0


async def test_who_may_ask(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    owner = await make_user(db, "owner")
    member = await make_user(db, "member")
    stranger = await make_user(db, "stranger")
    as_user(owner)
    news = await make_channel(client, "news", [member])
    await client.patch(f"{API}/channels/{news['id']}", json={"posting_policy": "owners"})
    hidden = await make_channel(client, "hidden", [member], kind="private")
    old = await make_channel(client, "old", [member])
    dm = (await client.post(f"{API}/dms", json={"user_ids": [str(member.id)]})).json()
    group = (
        await client.post(f"{API}/dms", json={"user_ids": [str(member.id), str(stranger.id)]})
    ).json()
    assert (await client.post(f"{API}/channels/{old['id']}/archive")).status_code == 200
    assert (await ask(client, news["id"])).status_code == 200

    as_user(member)
    for conversation in (dm, group):
        refused = await ask(client, conversation["id"])
        assert refused.status_code == 422 and code(refused) == "drive_not_available"
    for channel in (news, old):
        refused = await ask(client, channel["id"])
        assert refused.status_code == 403 and code(refused) == "drive_read_only"
    assert (await ask(client, hidden["id"])).status_code == 200

    as_user(stranger)
    for channel_id in (hidden["id"], str(uuid.uuid4())):
        missing = await ask(client, channel_id)
        assert missing.status_code == 404 and code(missing) == "drive_item_not_found"
    assert (await ask(client, "not-an-id")).status_code == 422


async def test_the_month_follows_the_zone_and_the_bootstrap_tells_it(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    as_user(alice)
    lab = await make_channel(client, "lab", [])
    boot = (await client.get(f"{API}/sync/bootstrap")).json()
    assert boot["channel_files_timezone"] == "Asia/Tokyo"
    assert boot["limits"]["max_attachment_bytes"] > 0
    channel_files.set_timezone("Pacific/Kiritimati")
    try:
        body = (await ask(client, lab["id"])).json()
        assert body["timezone"] == "Pacific/Kiritimati"
        assert body["month"] == channel_files.month_name(utcnow())
        assert body["month_folder"]["name"] == body["month"]
    finally:
        channel_files.set_timezone("Asia/Tokyo")
