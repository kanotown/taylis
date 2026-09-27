"""Message edit history (M14c): author only, purged with the message."""

import uuid
from collections.abc import Callable

from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.messages.models import MessageRevision
from app.modules.users.models import User
from tests.helpers import make_user


async def test_edit_history_is_kept_for_the_author_only(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    carol = await make_user(db, "carol")
    as_user(alice)
    channel = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    await client.post(f"/api/v1/channels/{channel['id']}/members", json={"user_id": str(bob.id)})
    posted = (
        await client.post(
            f"/api/v1/channels/{channel['id']}/messages",
            json={"client_msg_id": str(uuid.uuid4()), "body": "パスワードは hunter2 です"},
        )
    ).json()
    url = f"/api/v1/messages/{posted['id']}"

    none = await client.get(url + "/revisions")
    assert none.status_code == 200 and none.json() == []

    first = await client.patch(url, json={"body": "パスワードは別途 DM します"})
    assert first.status_code == 200
    same = await client.patch(url, json={"body": "パスワードは別途 DM します"})
    assert same.status_code == 200  # an unchanged body records nothing
    second = await client.patch(url, json={"body": "パスワードは別途 DM します (済)"})
    assert second.status_code == 200

    history = await client.get(url + "/revisions")
    assert history.status_code == 200
    rows = history.json()
    assert [r["body"] for r in rows] == ["パスワードは hunter2 です", "パスワードは別途 DM します"]
    assert rows[0]["written_at"] == posted["created_at"]
    assert (
        rows[1]["written_at"] == rows[0]["replaced_at"]
        or rows[1]["written_at"] >= rows[0]["replaced_at"]
    )
    assert all(r["written_at"] <= r["replaced_at"] for r in rows)

    # Other members, and people outside the channel, see only the current text.
    as_user(bob)
    denied = await client.get(url + "/revisions")
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_message_owner"
    as_user(carol)
    outside = await client.get(url + "/revisions")
    assert outside.status_code == 403 and outside.json()["error"]["code"] == "not_a_member"

    # Deleting the message deletes its history.
    as_user(alice)
    assert (await client.delete(url)).status_code == 200
    assert (await client.get(url + "/revisions")).status_code == 404
    left = await db.scalar(
        select(func.count())
        .select_from(MessageRevision)
        .where(MessageRevision.message_id == uuid.UUID(posted["id"]))
    )
    assert left == 0
