"""Who a new message notifies (PUSH_NOTIFICATIONS.md §4), against the vectors the three clients'
in-app / OS notifications read too (apps/shared/notify-rules.json)."""

import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.modules.channels import service as channels
from app.modules.channels.schemas import ChannelCreate
from app.modules.messages import repository as messages_repo
from app.modules.messages import service as messages
from app.modules.messages.schemas import MessageCreate
from app.modules.threads import service as threads
from tests.helpers import make_user
from tests.test_push_planner import add_device, deliveries, relay_with_planner

VECTORS = Path(__file__).resolve().parents[2] / "apps" / "shared" / "notify-rules.json"


@pytest.mark.parametrize(
    "case", json.loads(VECTORS.read_text())["cases"], ids=lambda case: case["name"]
)
async def test_push_targets_follow_the_shared_vectors(
    case: dict[str, Any], app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")  # the thread's author
    bob = await make_user(db, "bob")  # the replier
    me = await make_user(db, "me", notification_default=case["level"])
    if case["keyword"]:
        me.notify_keywords = ["chikuwa"]
        await db.commit()
    channel = await channels.create_channel(db, alice, ChannelCreate(name="general"))
    for user in (bob, me):
        await channels.join_channel(db, user, channel.id)
    await add_device(db, me)

    parent, _ = await messages.create_message(
        db, alice, channel.id, MessageCreate(client_msg_id=uuid.uuid4(), body="topic")
    )
    record = await messages_repo.get_message(db, parent.id)
    assert record is not None
    if case["follower"] or case["unfollowed"]:
        await threads.set_following(db, record, me.id, True)
    if case["unfollowed"]:
        await threads.set_following(db, record, me.id, False)
    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    before = len(await deliveries(db))

    words = ["news"]
    if case["mentioned"]:
        words.append(f"<@{me.id}>")
    if case["mention_all"]:
        words.append("<!channel>")
    if case["keyword"]:
        words.append("chikuwa")
    await messages.create_message(
        db,
        bob,
        channel.id,
        MessageCreate(
            client_msg_id=uuid.uuid4(),
            body=" ".join(words),
            parent_id=None if case["reply"] == "none" else parent.id,
            also_in_channel=case["reply"] == "also_in_channel",
        ),
    )
    while await relay.process_batch():
        pass
    planned = [r.user_id for r in (await deliveries(db))[before:]]
    assert planned == ([me.id] if case["expect"]["notify"] else [])
