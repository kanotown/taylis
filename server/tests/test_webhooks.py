"""Incoming webhooks (M13a): a URL token posts as a bot user into one channel."""

import uuid
from collections.abc import Callable

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user

PASSWORD = "correct-horse-battery"


async def test_webhook_posts_as_its_bot(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    member = await make_user(db, "member")
    as_user(root)
    channel = (await client.post("/api/v1/channels", json={"name": "alerts"})).json()
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(member.id)]})).json()

    as_user(member)
    denied = await client.post(
        "/api/v1/admin/webhooks", json={"name": "CI", "channel_id": channel["id"]}
    )
    assert denied.status_code == 403

    as_user(root)
    bad = await client.post("/api/v1/admin/webhooks", json={"name": "CI", "channel_id": dm["id"]})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid_channel"
    created = await client.post(
        "/api/v1/admin/webhooks", json={"name": "GitHub Actions", "channel_id": channel["id"]}
    )
    assert created.status_code == 201, created.text
    token = created.json()["token"]
    hook = created.json()["webhook"]
    assert hook["name"] == "GitHub Actions" and hook["enabled"] is True and hook["post_count"] == 0

    # The bot is a member of the channel and shows up in the user list with its role.
    members = await client.get(f"/api/v1/channels/{channel['id']}/members")
    assert hook["bot_user_id"] in {m["user_id"] for m in members.json()}
    listed = await client.get("/api/v1/users")
    bot = next(u for u in listed.json() if u["id"] == hook["bot_user_id"])
    assert bot["role"] == "bot" and bot["display_name"] == "GitHub Actions"
    assert bot["username"].startswith("hook-github-actions-")

    # Anyone with the URL can post; JSON and Slack's form encoding both work; ids make retries safe.
    client.headers.pop("Authorization", None)
    posted = await client.post(f"/api/v1/hooks/{token}", json={"text": "build **passed** :tada:"})
    assert posted.status_code == 201, posted.text
    message_id = posted.json()["message_id"]
    again = await client.post(f"/api/v1/hooks/{token}", json={"text": "second post"})
    assert again.status_code == 201 and again.json()["message_id"] != message_id
    form = await client.post(
        f"/api/v1/hooks/{token}",
        data={"payload": '{"text": "from a form"}'},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert form.status_code == 201, form.text
    empty = await client.post(f"/api/v1/hooks/{token}", json={"text": ""})
    assert empty.status_code == 422
    unknown = await client.post("/api/v1/hooks/" + "x" * 43, json={"text": "hi"})
    assert unknown.status_code == 404
    fixed = str(uuid.uuid4())
    first = await client.post(f"/api/v1/hooks/{token}", json={"text": "once", "id": fixed})
    second = await client.post(f"/api/v1/hooks/{token}", json={"text": "once", "id": fixed})
    assert first.json()["message_id"] == second.json()["message_id"]

    as_user(root)
    history = await client.get(f"/api/v1/channels/{channel['id']}/messages")
    bodies = [m["body"] for m in history.json()["messages"]]
    assert "build **passed** :tada:" in bodies and "from a form" in bodies
    assert all(m["sender_id"] == hook["bot_user_id"] for m in history.json()["messages"])
    rows = (await client.get("/api/v1/admin/webhooks")).json()
    assert rows[0]["post_count"] == 4 and rows[0]["last_post_at"] is not None

    # Disable, rename / move, delete.
    off = await client.patch(f"/api/v1/admin/webhooks/{hook['id']}", json={"enabled": False})
    assert off.status_code == 200 and off.json()["enabled"] is False
    client.headers.pop("Authorization", None)
    assert (await client.post(f"/api/v1/hooks/{token}", json={"text": "nope"})).status_code == 404
    as_user(root)
    other = (await client.post("/api/v1/channels", json={"name": "ops"})).json()
    moved = await client.patch(
        f"/api/v1/admin/webhooks/{hook['id']}",
        json={"enabled": True, "name": "CI bot", "channel_id": other["id"]},
    )
    assert moved.status_code == 200 and moved.json()["channel_id"] == other["id"]
    listed = await client.get("/api/v1/users")
    assert (
        next(u for u in listed.json() if u["id"] == hook["bot_user_id"])["display_name"] == "CI bot"
    )
    old_members = (await client.get(f"/api/v1/channels/{channel['id']}/members")).json()
    assert hook["bot_user_id"] not in {m["user_id"] for m in old_members}
    client.headers.pop("Authorization", None)
    relocated = await client.post(f"/api/v1/hooks/{token}", json={"text": "moved"})
    assert relocated.status_code == 201
    as_user(root)
    assert "moved" in [
        m["body"]
        for m in (await client.get(f"/api/v1/channels/{other['id']}/messages")).json()["messages"]
    ]

    gone = await client.delete(f"/api/v1/admin/webhooks/{hook['id']}")
    assert gone.status_code == 204
    assert (await client.get("/api/v1/admin/webhooks")).json() == []
    listed = await client.get("/api/v1/users")
    bot = next(u for u in listed.json() if u["id"] == hook["bot_user_id"])
    assert bot["deactivated_at"] is not None  # messages stay attributed to the bot
    client.headers.pop("Authorization", None)
    assert (await client.post(f"/api/v1/hooks/{token}", json={"text": "late"})).status_code == 404


async def test_bots_cannot_log_in(client: AsyncClient, db: AsyncSession) -> None:
    await make_user(db, "hook-bot", role="bot", password=PASSWORD)
    attempt = await client.post(
        "/api/v1/auth/login",
        json={"username": "hook-bot", "password": PASSWORD, "device": {"platform": "desktop"}},
    )
    assert attempt.status_code == 401 and attempt.json()["error"]["code"] == "invalid_credentials"
