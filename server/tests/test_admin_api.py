import uuid
from collections.abc import Callable

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.users.models import User
from tests.helpers import make_user


async def test_admin_user_management(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    member = await make_user(db, "member")

    as_user(member)
    denied = await client.post("/api/v1/admin/users", json={"username": "x", "display_name": "x"})
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "admin_required"

    as_user(root)
    created = await client.post(
        "/api/v1/admin/users",
        json={"username": "alice", "display_name": "Alice", "email": "alice@example.com"},
    )
    assert created.status_code == 201
    body = created.json()
    assert body["user"]["username"] == "alice"
    assert body["user"]["must_change_password"] is True
    assert len(body["temporary_password"]) >= 12

    duplicate = await client.post(
        "/api/v1/admin/users", json={"username": "alice", "display_name": "Dup"}
    )
    assert duplicate.status_code == 409 and duplicate.json()["error"]["code"] == "username_taken"

    uppercase = await client.post(
        "/api/v1/admin/users", json={"username": "Alice", "display_name": "Dup"}
    )
    assert uppercase.status_code == 422  # usernames are lowercase by definition

    invalid = await client.post(
        "/api/v1/admin/users", json={"username": "no spaces", "display_name": "x"}
    )
    assert invalid.status_code == 422

    listed = await client.get("/api/v1/admin/users")
    assert [u["username"] for u in listed.json()] == ["alice", "member", "root"]

    promoted = await client.patch(f"/api/v1/admin/users/{member.id}", json={"role": "admin"})
    assert promoted.status_code == 200 and promoted.json()["role"] == "admin"

    selfie = await client.patch(f"/api/v1/admin/users/{root.id}", json={"role": "member"})
    assert selfie.status_code == 409 and selfie.json()["error"]["code"] == "cannot_modify_self"

    missing = await client.patch(f"/api/v1/admin/users/{uuid.uuid4()}", json={"role": "member"})
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "user_not_found"


async def test_deactivation_and_reset_need_session_revocation(
    client: AsyncClient, db: AsyncSession, as_user: Callable[[User], None]
) -> None:
    root = await make_user(db, "root", role="admin")
    alice = await make_user(db, "alice")
    as_user(root)

    deactivated = await client.patch(f"/api/v1/admin/users/{alice.id}", json={"deactivated": True})
    assert deactivated.status_code == 200 and deactivated.json()["deactivated_at"] is not None

    reactivated = await client.patch(f"/api/v1/admin/users/{alice.id}", json={"deactivated": False})
    assert reactivated.json()["deactivated_at"] is None

    reset = await client.post(f"/api/v1/admin/users/{alice.id}/reset-password")
    assert reset.status_code == 200 and len(reset.json()["temporary_password"]) >= 12

    revoked = await client.delete(f"/api/v1/admin/users/{alice.id}/sessions")
    assert revoked.status_code == 204
