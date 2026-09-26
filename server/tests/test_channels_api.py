import uuid
from collections.abc import Callable

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user


async def test_protected_routes_require_authentication(client: AsyncClient) -> None:
    response = await client.get("/api/v1/channels")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "missing_token"


async def test_channel_lifecycle_over_http(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")

    as_user(alice)
    created = await client.post("/api/v1/channels", json={"name": "general", "topic": "hi"})
    assert created.status_code == 201
    channel = created.json()
    assert channel["type"] == "public" and channel["membership"]["role"] == "owner"

    duplicate = await client.post("/api/v1/channels", json={"name": "General"})
    assert duplicate.status_code == 409 and duplicate.json()["error"]["code"] == "name_taken"

    invalid = await client.post("/api/v1/channels", json={"name": "has space"})
    assert invalid.status_code == 422 and invalid.json()["error"]["code"] == "validation_error"

    as_user(bob)
    listed = await client.get("/api/v1/channels", params={"include": "public"})
    assert listed.status_code == 200
    assert [c["id"] for c in listed.json()] == [channel["id"]]
    assert listed.json()[0]["membership"] is None

    joined = await client.post(f"/api/v1/channels/{channel['id']}/join")
    assert joined.status_code == 200 and joined.json()["membership"]["role"] == "member"

    as_user(alice)
    members = await client.get(f"/api/v1/channels/{channel['id']}/members")
    assert {m["user_id"] for m in members.json()} == {str(alice.id), str(bob.id)}

    renamed = await client.patch(f"/api/v1/channels/{channel['id']}", json={"topic": "new topic"})
    assert renamed.status_code == 200 and renamed.json()["topic"] == "new topic"

    as_user(bob)
    forbidden = await client.post(f"/api/v1/channels/{channel['id']}/archive")
    assert forbidden.status_code == 403 and forbidden.json()["error"]["code"] == "forbidden"

    left = await client.post(f"/api/v1/channels/{channel['id']}/leave")
    assert left.status_code == 204

    missing = await client.get(f"/api/v1/channels/{uuid.uuid4()}")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "channel_not_found"


async def test_private_membership_and_dm_over_http(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    alice = await make_user(db, "alice")
    bob = await make_user(db, "bob")

    as_user(alice)
    private = (
        await client.post("/api/v1/channels", json={"type": "private", "name": "secret"})
    ).json()

    as_user(bob)
    denied = await client.get(f"/api/v1/channels/{private['id']}")
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "not_a_member"

    as_user(alice)
    added = await client.post(
        f"/api/v1/channels/{private['id']}/members", json={"user_id": str(bob.id)}
    )
    assert added.status_code == 200 and added.json()["user_id"] == str(bob.id)

    unknown = await client.post(
        f"/api/v1/channels/{private['id']}/members", json={"user_id": str(uuid.uuid4())}
    )
    assert unknown.status_code == 404 and unknown.json()["error"]["code"] == "user_not_found"

    removed = await client.delete(f"/api/v1/channels/{private['id']}/members/{bob.id}")
    assert removed.status_code == 204

    first = await client.post("/api/v1/dms", json={"user_ids": [str(bob.id)]})
    assert first.status_code == 201 and first.json()["type"] == "dm"
    assert first.json()["dm_user_ids"] == sorted([str(alice.id), str(bob.id)])

    as_user(bob)
    again = await client.post("/api/v1/dms", json={"user_ids": [str(alice.id)]})
    assert again.status_code == 200 and again.json()["id"] == first.json()["id"]

    mine = await client.get("/api/v1/channels")
    assert [c["id"] for c in mine.json()] == [first.json()["id"]]
