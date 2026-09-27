"""Invite links (M12h): admin-issued, hashed, expiring, single- or multi-use; no open signup."""

import uuid
from collections.abc import Callable
from datetime import timedelta

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import utcnow
from app.modules.auth.deps import get_current_user
from app.modules.invites.models import Invite
from app.modules.users.models import User
from tests.helpers import make_user

ACCEPT = {
    "username": "tanaka",
    "display_name": "田中",
    "password": "correct horse battery",
    "device": {"platform": "ios", "device_name": "iPhone"},
}


async def test_invite_creates_a_member_of_the_chosen_channels(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    member = await make_user(db, "member")
    as_user(root)
    general = (await client.post("/api/v1/channels", json={"name": "general"})).json()
    secret = (
        await client.post("/api/v1/channels", json={"name": "secret", "type": "private"})
    ).json()

    as_user(member)
    denied = await client.post("/api/v1/admin/invites", json={})
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "admin_required"

    as_user(root)
    created = await client.post(
        "/api/v1/admin/invites",
        json={"channel_ids": [general["id"], secret["id"]], "note": "田中さん用"},
    )
    assert created.status_code == 201, created.text
    token = created.json()["token"]
    invite = created.json()["invite"]
    assert invite["status"] == "active" and invite["max_uses"] == 1 and invite["use_count"] == 0
    assert invite["note"] == "田中さん用" and invite["role"] == "member"

    # The public preview needs no login and names the issuer and the channels.
    app.dependency_overrides.pop(get_current_user, None)
    preview = await client.get(f"/api/v1/invites/{token}")
    assert preview.status_code == 200, preview.text
    assert preview.json()["invited_by"] == "Root"
    assert preview.json()["channels"] == ["general", "secret"]
    assert preview.json()["password_min_length"] == 8

    accepted = await client.post(f"/api/v1/invites/{token}/accept", json=ACCEPT)
    assert accepted.status_code == 201, accepted.text
    body = accepted.json()
    assert body["user"]["username"] == "tanaka" and body["user"]["display_name"] == "田中"
    assert body["user"]["must_change_password"] is False and body["user"]["role"] == "member"
    assert accepted.headers["cache-control"] == "no-store"

    # The returned session works and sees both channels.
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    mine = await client.get("/api/v1/channels", headers=headers)
    assert mine.status_code == 200
    assert {c["name"] for c in mine.json()} == {"general", "secret"}
    assert all(c["membership"]["role"] == "member" for c in mine.json())

    # One use only.
    again = await client.post(
        f"/api/v1/invites/{token}/accept", json={**ACCEPT, "username": "suzuki"}
    )
    assert again.status_code == 410 and again.json()["error"]["code"] == "invite_exhausted"
    assert (await client.get(f"/api/v1/invites/{token}")).status_code == 410

    as_user(root)
    listed = await client.get("/api/v1/admin/invites")
    assert listed.status_code == 200
    (row,) = listed.json()
    assert row["status"] == "exhausted" and row["use_count"] == 1
    assert row["used_by"] == [body["user"]["id"]]


async def test_invite_lifecycle_and_validation(
    app: FastAPI, client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    await make_user(db, "taken")
    as_user(root)
    issued = (await client.post("/api/v1/admin/invites", json={"expires_in_hours": 1})).json()

    row = await db.get(Invite, uuid.UUID(issued["invite"]["id"]))
    assert row is not None
    row.expires_at = utcnow() - timedelta(minutes=1)
    await db.commit()
    expired = await client.get(f"/api/v1/invites/{issued['token']}")
    assert expired.status_code == 410 and expired.json()["error"]["code"] == "invite_expired"

    revoked = await client.delete(f"/api/v1/admin/invites/{issued['invite']['id']}")
    assert revoked.status_code == 204
    gone = await client.get(f"/api/v1/invites/{issued['token']}")
    assert gone.status_code == 410 and gone.json()["error"]["code"] == "invite_revoked"
    assert (await client.delete(f"/api/v1/admin/invites/{uuid.uuid4()}")).status_code == 404

    unknown = await client.get("/api/v1/invites/" + "x" * 43)
    assert unknown.status_code == 404 and unknown.json()["error"]["code"] == "invite_not_found"
    assert (await client.get("/api/v1/invites/short")).status_code == 404

    fresh = (await client.post("/api/v1/admin/invites", json={"max_uses": None})).json()
    token = fresh["token"]
    app.dependency_overrides.pop(get_current_user, None)
    taken = await client.post(
        f"/api/v1/invites/{token}/accept", json={**ACCEPT, "username": "taken"}
    )
    assert taken.status_code == 409 and taken.json()["error"]["code"] == "username_taken"
    short = await client.post(
        f"/api/v1/invites/{token}/accept", json={**ACCEPT, "password": "short"}
    )
    assert short.status_code == 422 and short.json()["error"]["code"] == "password_too_short"
    bad = await client.post(
        f"/api/v1/invites/{token}/accept", json={**ACCEPT, "username": "Has Space"}
    )
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "validation_error"

    # Unlimited invites keep working; every acceptance is recorded.
    for name in ("first", "second"):
        ok = await client.post(f"/api/v1/invites/{token}/accept", json={**ACCEPT, "username": name})
        assert ok.status_code == 201, ok.text
    as_user(root)
    rows = {r["id"]: r for r in (await client.get("/api/v1/admin/invites")).json()}
    assert rows[fresh["invite"]["id"]]["status"] == "active"
    assert rows[fresh["invite"]["id"]]["use_count"] == 2
    assert len(rows[fresh["invite"]["id"]]["used_by"]) == 2


async def test_invite_channels_are_checked_against_the_issuer(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    owner = await make_user(db, "owner")
    as_user(owner)
    private = (
        await client.post("/api/v1/channels", json={"name": "owners-only", "type": "private"})
    ).json()
    dm = (await client.post("/api/v1/dms", json={"user_ids": [str(root.id)]})).json()

    as_user(root)
    not_member = await client.post("/api/v1/admin/invites", json={"channel_ids": [private["id"]]})
    assert not_member.status_code == 403 and not_member.json()["error"]["code"] == "not_a_member"
    is_dm = await client.post("/api/v1/admin/invites", json={"channel_ids": [dm["id"]]})
    assert is_dm.status_code == 400 and is_dm.json()["error"]["code"] == "invalid_channel"
    missing = await client.post("/api/v1/admin/invites", json={"channel_ids": [str(uuid.uuid4())]})
    assert missing.status_code == 404
    too_long = await client.post("/api/v1/admin/invites", json={"expires_in_hours": 10_000})
    assert too_long.status_code == 422

    # An admin-role invite makes an admin.
    admin_invite = (await client.post("/api/v1/admin/invites", json={"role": "admin"})).json()
    accepted = await client.post(
        f"/api/v1/invites/{admin_invite['token']}/accept", json={**ACCEPT, "username": "boss"}
    )
    assert accepted.status_code == 201 and accepted.json()["user"]["role"] == "admin"


async def test_invite_page_is_public_and_static(client: AsyncClient) -> None:
    client.headers.pop("Authorization", None)
    response = await client.get("/invite/" + "a" * 43)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["x-robots-tag"] == "noindex"
    assert "招待" in response.text and "/api/v1/invites/" in response.text
    assert (await client.get("/invite/nope")).status_code == 404
