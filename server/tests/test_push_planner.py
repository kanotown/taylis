"""PushPlanner rules (PUSH_NOTIFICATIONS.md §4) as an outbox handler."""

import uuid
from datetime import timedelta

from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import Settings
from app.core.time import utcnow
from app.events.outbox import OutboxRelay
from app.modules.auth.models import Device
from app.modules.channels import service as channels
from app.modules.channels.schemas import ChannelCreate
from app.modules.messages import service as messages
from app.modules.messages.schemas import MessageCreate
from app.modules.notifications.models import NotificationPreference, PushDelivery
from app.modules.notifications.planner import PushPlanner
from app.modules.users.models import User
from app.modules.workspace import service as workspace
from tests.helpers import make_user
from tests.test_outbox import RecordingBus


async def add_device(
    db: AsyncSession, user: User, token: str | None = "tok", platform: str = "ios"
) -> Device:
    device = Device(
        user_id=user.id,
        platform=platform,
        push_provider="apns" if token else "none",
        push_token=token,
        push_environment="sandbox",
    )
    db.add(device)
    await db.commit()
    return device


async def post(db: AsyncSession, sender: User, channel_id: uuid.UUID, body: str = "hi") -> None:
    await messages.create_message(
        db, sender, channel_id, MessageCreate(client_msg_id=uuid.uuid4(), body=body)
    )


async def deliveries(db: AsyncSession) -> list[PushDelivery]:
    return list((await db.execute(select(PushDelivery).order_by(PushDelivery.id))).scalars().all())


def relay_with_planner(
    app: FastAPI, settings: Settings, active: set[uuid.UUID] | None = None
) -> OutboxRelay:
    planner = PushPlanner(settings, is_active=lambda uid: uid in (active or set()))
    return OutboxRelay(
        app.state.db, RecordingBus(), channels.resolve_event_audience, handlers=[planner]
    )


async def test_dm_notifies_recipient_devices_not_sender(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    bob_phone = await add_device(db, bob)
    await add_device(db, bob, token="tok2", platform="android")
    await add_device(db, alice, token="alice-tok")
    await add_device(db, bob, token=None)  # desktop: no push
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    await post(db, alice, dm.id, "psst")

    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    rows = await deliveries(db)
    assert {r.device_id for r in rows} == {bob_phone.id, rows[1].device_id}
    assert all(r.user_id == bob.id and r.status == "pending" and r.kind == "alert" for r in rows)
    payload = rows[0].payload
    assert (
        payload["title"] == "Alice"
        and payload["body"] == "psst"
        and payload["collapse_key"] == str(dm.id)
    )
    assert payload["seq"] == 1 and rows[0].message_seq == 1
    assert rows[0].expires_at > utcnow() + timedelta(minutes=9)
    # WORKSPACES.md §5: the app routes a tap to the workspace that sent it.
    assert payload["workspace_id"] == str(await workspace.workspace_id(db))


async def test_push_text_shows_display_names_and_no_markdown(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    await post(db, alice, dm.id, f"# 明日\n- <@{bob.id}> **確認** お願い `x`\n<!here>")

    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    rows = await deliveries(db)
    assert rows[0].payload["body"] == f"明日 @{bob.display_name} 確認 お願い x @here"


async def test_channel_default_is_mentions_so_only_level_all_members_get_pushes(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    dave = await make_user(db, "dave")
    channel = await channels.create_channel(db, alice, ChannelCreate(name="general"))
    for user in (bob, carol, dave):
        await channels.join_channel(db, user, channel.id)
        await add_device(db, user, token=f"tok-{user.username}")
    db.add(NotificationPreference(user_id=bob.id, channel_id=channel.id, level="all"))
    db.add(
        NotificationPreference(
            user_id=carol.id,
            channel_id=channel.id,
            level="all",
            muted_until=utcnow() + timedelta(hours=1),
        )
    )
    await db.commit()
    await post(db, alice, channel.id)

    relay = relay_with_planner(app, test_settings, active={dave.id})
    while await relay.process_batch():
        pass
    rows = await deliveries(db)
    assert [r.user_id for r in rows] == [bob.id]  # carol muted, dave default (mentions) and active
    assert rows[0].payload["title"] == "#general" and rows[0].payload["subtitle"] == "Alice"


async def test_reprocessing_the_event_plans_no_duplicate(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    await post(db, alice, dm.id)
    relay = relay_with_planner(app, test_settings)
    await relay.process_batch()
    # Simulate a crash after the handler ran: reset processed_at and run again.
    from sqlalchemy import update

    from app.events.models import OutboxEvent

    await db.execute(update(OutboxEvent).values(processed_at=None))
    await db.commit()
    await relay.process_batch()
    assert len(await deliveries(db)) == 1


async def test_active_user_and_none_level_are_skipped(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    db.add(NotificationPreference(user_id=bob.id, channel_id=dm.id, level="none"))
    await db.commit()
    await post(db, alice, dm.id)
    relay = relay_with_planner(app, test_settings)
    while await relay.process_batch():
        pass
    assert await deliveries(db) == []


async def test_content_can_be_hidden(
    app: FastAPI, db: AsyncSession, test_settings: Settings
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    await add_device(db, bob)
    dm, _ = await channels.get_or_create_dm(db, alice, [bob])
    await post(db, alice, dm.id, "secret")
    relay = relay_with_planner(
        app, test_settings.model_copy(update={"push_include_content": False})
    )
    while await relay.process_batch():
        pass
    assert (await deliveries(db))[0].payload["body"] == "新しいメッセージ"
