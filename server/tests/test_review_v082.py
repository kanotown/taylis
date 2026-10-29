"""REVIEW-v0.1.82: what a posted file tells someone who cannot read its message (#5, #6), album
creation sent again (#3, #7) and the GIFs of a share link that hands out no originals (#4). The
downgrades of 0126 and 0127 (#1, #2) are in test_review_v082_migrations.py."""

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.drive_helpers import act_as, drive_settings, upload, workspace_root
from tests.helpers import make_user
from tests.test_channel_files import make_channel, post

API = "/api/v1"


@pytest.fixture
def as_user(app: FastAPI) -> Callable[[User], None]:
    return act_as(app)


async def _ok(response: Any, status: int = 200) -> Any:
    assert response.status_code == status, response.text
    return response.json()


# --- #5, #6: a posted file moved out of a private channel ----------------------------------------


async def test_unreadable_posts_are_neither_named_nor_counted(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    drive_settings(app)
    alice = await make_user(db, "alice", role="admin")  # manages 研究室ドライブ too
    carol = await make_user(db, "carol")
    boss = await make_user(db, "boss", role="admin")
    dave = await make_user(db, "dave")
    as_user(alice)
    secret = await make_channel(client, "secret", [carol], kind="private")
    lab = await make_channel(client, "lab", [])
    hidden = await post(client, secret["id"], [("plan.txt", b"version one")])
    shown = await post(client, lab["id"], [("open.txt", b"open")])
    hidden_id = hidden["attachments"][0]["drive"]["item_id"]
    hidden_version = hidden["attachments"][0]["drive"]["version_id"]
    open_id = shown["attachments"][0]["drive"]["item_id"]
    root = await workspace_root(client)
    moved = await _ok(
        await client.post(
            f"{API}/drive/items/move",
            json={"item_ids": [hidden_id, open_id], "target_folder_id": root},
        )
    )
    assert all(r["ok"] for r in moved["results"]), moved
    await upload(client, root, "plan.txt", b"version two", on_conflict="version")
    # carol was a member and left: she reads 研究室ドライブ but not the conversation any more.
    as_user(carol)
    assert (await client.post(f"{API}/channels/{secret['id']}/leave")).status_code == 204

    async def seen(user: User) -> dict[str, Any]:
        as_user(user)
        detail = await _ok(await client.get(f"{API}/drive/items/{hidden_id}"))
        listed = await _ok(await client.get(f"{API}/drive/folders/{root}/children"))
        marks = {i["id"]: i["posted"] for i in listed["items"]}
        trash = await _ok(
            await client.post(f"{API}/drive/items/impact", json={"item_ids": [hidden_id]})
        )
        both = await _ok(
            await client.post(f"{API}/drive/items/impact", json={"item_ids": [hidden_id, open_id]})
        )
        return {
            "posted": detail["item"]["posted"],
            "posts": len(detail["item"]["posts"] or []),
            "listed": marks[hidden_id],
            "open_listed": marks[open_id],
            "trash": trash,
            "both": both["posted_messages"],
        }

    nothing = {"posted_messages": 0, "channels": []}
    for outsider in (boss, carol):
        assert await seen(outsider) == {
            "posted": False,
            "posts": 0,
            "listed": False,
            "open_listed": True,  # a public channel's message: anyone but a guest reads it
            "trash": nothing,
            "both": 1,
        }, outsider.username
    reader = await seen(alice)
    assert (reader["posted"], reader["posts"], reader["listed"], reader["both"]) == (
        True,
        1,
        True,
        2,
    )
    assert reader["trash"]["posted_messages"] == 1
    assert [c["channel_id"] for c in reader["trash"]["channels"]] == [secret["id"]]
    assert (await seen(dave))["listed"] is False

    # #5: the posted version cannot be deleted, and the refusal names nothing to the manager
    # outside the conversation; its reader gets the message and the channel.
    as_user(boss)
    refused = await client.delete(f"{API}/drive/items/{hidden_id}/versions/{hidden_version}")
    assert refused.status_code == 409
    error = refused.json()["error"]
    assert error["code"] == "drive_version_posted"
    assert not error.get("details")
    assert hidden["id"] not in refused.text and secret["id"] not in refused.text
    as_user(alice)
    named = await client.delete(f"{API}/drive/items/{hidden_id}/versions/{hidden_version}")
    assert named.status_code == 409
    assert named.json()["error"]["details"] == {
        "message_id": hidden["id"],
        "channel_id": secret["id"],
    }


def _uuid() -> str:
    return str(uuid.uuid4())
