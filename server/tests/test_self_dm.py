"""A DM with only myself: notes to self, as in Slack (2026-09-28)."""

from collections.abc import Callable

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user


async def test_a_dm_with_only_myself_is_my_notes(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")
    as_user(alice)

    created = await client.post("/api/v1/dms", json={"user_ids": [str(alice.id)]})
    assert created.status_code == 201
    notes = created.json()
    assert notes["type"] == "dm" and notes["dm_user_ids"] == [str(alice.id)]
    again = await client.post("/api/v1/dms", json={"user_ids": [str(alice.id)]})
    assert again.status_code == 200 and again.json()["id"] == notes["id"]  # one notes DM per person

    posted = await client.post(
        f"/api/v1/channels/{notes['id']}/messages",
        json={"client_msg_id": "01929f3a-0000-7000-8000-000000000001", "body": "買い物: 牛乳"},
    )
    assert posted.status_code == 201

    as_user(bob)  # nobody else can read it
    assert (await client.get(f"/api/v1/channels/{notes['id']}/messages")).status_code in (403, 404)
